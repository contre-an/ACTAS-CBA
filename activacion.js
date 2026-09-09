// activacion.js — sistema de activación por clave.
//
// Nadie genera actas sin una clave que yo (Carlos) haya emitido. La clave
// es un HMAC-SHA256(secreto, nombre normalizado + código) truncado y
// formateado en hex, para poder dictarla por teléfono sin ambigüedad.
//
// Dos secretos, ninguno versionado (ver .gitignore -> secretos/):
//   - secretos/produccion.key: el que uso para emitir claves reales (ver
//     herramientas/generar_clave.js) y el que se empaqueta en los
//     instaladores reales (electron-builder -> extraResources).
//   - secretos/desarrollo.key: para "npm start". Si no existe, este mismo
//     módulo lo genera solo (aleatorio) la primera vez, para que el
//     entorno de desarrollo funcione sin prepararlo a mano.
//
// Separación (mismo criterio que rutaRegistro.js): funciones puras arriba
// (nada de fs/Electron adentro, para poder probarlas con node --test sin
// depender de un secreto real en disco), resolución de E/S abajo.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const RUTA_SECRETO_PRODUCCION = path.join(__dirname, "secretos", "produccion.key");
const RUTA_SECRETO_DESARROLLO = path.join(__dirname, "secretos", "desarrollo.key");

// ===== Normalización -- la misma para firmar (generador) y para verificar
// (activacion:activar / estadoActivacion), en un solo sitio para que no se
// desincronicen. Tildes y mayusculas/minusculas no importan; el CONTENIDO
// del nombre (que partes tiene, como estan escritas sin tildes) si. =====
function normalizarNombre(nombre) {
  return String(nombre ?? "")
    .normalize("NFD")
    .replace(REGEX_DIACRITICOS, "") // quita tildes/diacriticos
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}
// Rango Unicode U+0300 a U+036F: marcas diacriticas combinantes (acentos,
// virgulillas, etc. que normalize("NFD") separa de la letra base).
// Construido con String.fromCharCode en vez de escribir esos caracteres
// combinantes sueltos en el código fuente: así el archivo no lleva
// caracteres invisibles que un editor o un copy/paste puedan corromper en
// silencio (justo lo que pasó al escribir este archivo la primera vez).
const REGEX_DIACRITICOS = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, "g");

function normalizarCodigo(codigo) {
  return String(codigo ?? "").replace(/\D/g, "").padStart(2, "0").slice(-2);
}

// 16 caracteres hex = 64 bits, en 4 grupos de 4 separados por guion:
// A3F9-2B7E-C401-88DA. Hex de verdad (0-9A-F), sin ambigüedad al dictar.
const GRUPOS_CLAVE = 4, LARGO_GRUPO = 4;

function calcularClaveHex(secreto, nombre, codigo) {
  const mensaje = `${normalizarNombre(nombre)}|${normalizarCodigo(codigo)}`;
  return crypto.createHmac("sha256", secreto).update(mensaje, "utf8").digest("hex")
    .slice(0, GRUPOS_CLAVE * LARGO_GRUPO).toUpperCase();
}

function formatoClave(hex) {
  const grupos = [];
  for (let i = 0; i < GRUPOS_CLAVE; i++) grupos.push(hex.slice(i * LARGO_GRUPO, (i + 1) * LARGO_GRUPO));
  return grupos.join("-");
}

// Acepta la clave como la haya escrito el instructor: con o sin guiones,
// mayúscula o minúscula, con espacios de más.
function normalizarClaveIngresada(clave) {
  return String(clave ?? "").toUpperCase().replace(/[^0-9A-F]/g, "");
}

function validarClave({ nombre, codigo, clave }, secreto) {
  const esperada = calcularClaveHex(secreto, nombre, codigo);
  const ingresada = normalizarClaveIngresada(clave);
  if (ingresada.length !== esperada.length) return false;
  // Comparación en tiempo constante: buena práctica al comparar secretos,
  // aunque el modelo de amenaza real acá es "no repartir el secreto", no
  // un atacante remoto cronometrando respuestas.
  return crypto.timingSafeEqual(Buffer.from(ingresada, "utf8"), Buffer.from(esperada, "utf8"));
}

// ===== Estado de activación: SIEMPRE recalcula el HMAC contra lo guardado
// en configuracion.json, nunca confía en un flag "activado: true" — si
// alguien edita el archivo a mano (o queda un código "00" de una
// instalación de antes de este sistema), no es una activación válida. =====
function estadoActivacion(configuracion, secreto) {
  const act = configuracion?.activacion;
  if (!act) return { activado: false, motivo: "sin_activar" };
  const codigo = normalizarCodigo(act.codigoInstructor);
  if (codigo === "00") return { activado: false, motivo: "codigo_00" };
  if (!/^\d{2}$/.test(String(act.codigoInstructor ?? ""))) return { activado: false, motivo: "codigo_invalido" };
  if (!validarClave({ nombre: act.nombre, codigo: act.codigoInstructor, clave: act.clave }, secreto))
    return { activado: false, motivo: "clave_invalida" };
  return { activado: true, activacion: act };
}

// Valida el formulario de activación y, si todo calza, devuelve el objeto
// listo para guardar en configuracion.json.activacion. No escribe nada acá
// (eso lo hace ipc.js, que es quien conoce cargarConfiguracion/guardarConfiguracion).
function intentarActivar(datos, secreto) {
  const nombre = String(datos?.nombre ?? "").trim();
  const documento = String(datos?.documento ?? "").trim();
  const correo = String(datos?.correo ?? "").trim();
  const codigoCrudo = String(datos?.codigoInstructor ?? "").trim();
  const claveCruda = String(datos?.clave ?? "").trim();

  if (!nombre) return { ok: false, error: "Falta el nombre completo." };
  if (!documento) return { ok: false, error: "Falta el número de documento." };
  if (!correo.includes("@")) return { ok: false, error: "Falta un correo institucional válido." };
  if (!/^\d{2}$/.test(codigoCrudo)) return { ok: false, error: "El código de instructor debe ser exactamente dos dígitos (ejemplo: 05)." };
  if (codigoCrudo === "00") return { ok: false, error: 'El código "00" no es válido. Pedime que te asigne un código real.' };
  if (!claveCruda) return { ok: false, error: "Falta la clave." };

  const nombreNormalizado = normalizarNombre(nombre);
  if (!validarClave({ nombre, codigo: codigoCrudo, clave: claveCruda }, secreto)) {
    return {
      ok: false,
      error: `La clave no coincide con el nombre y el código ingresados. La causa más probable: el nombre no quedó escrito EXACTAMENTE como te lo dictaron (falta o sobra una parte, o alguna letra es distinta) — mayúsculas, minúsculas y tildes no importan, pero el resto del contenido sí. ` +
        `La app está comparando con este nombre, ya normalizado: "${nombreNormalizado}". Revisalo contra lo que te dictaron y volvé a intentar; si sigue sin validar, decime para confirmar la clave.`,
    };
  }

  return {
    ok: true,
    activacion: {
      nombre, documento, correo, codigoInstructor: codigoCrudo,
      clave: formatoClave(calcularClaveHex(secreto, nombre, codigoCrudo)), // forma canónica, no lo que haya tecleado
      fecha: new Date().toISOString(),
    },
  };
}

// ===== Resolución del secreto: la única parte con E/S / Electron. =====
function generarSecretoDesarrolloSiHaceFalta() {
  if (fs.existsSync(RUTA_SECRETO_DESARROLLO)) return fs.readFileSync(RUTA_SECRETO_DESARROLLO, "utf8").trim();
  const nuevo = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(RUTA_SECRETO_DESARROLLO), { recursive: true });
  fs.writeFileSync(RUTA_SECRETO_DESARROLLO, nuevo);
  return nuevo;
}

// Solo debe llamarse dentro de un proceso Electron real (ipc.js). En
// pruebas (node --test) el secreto se inyecta directamente a las funciones
// puras de arriba — nunca se lee de disco ahí.
function resolverSecreto() {
  if (!process.versions.electron)
    throw new Error("resolverSecreto() no debe llamarse fuera de Electron: inyectá el secreto directamente en pruebas/scripts.");
  const { app } = require("electron");
  if (app.isPackaged) {
    const ruta = path.join(process.resourcesPath, "secreto_activacion.key");
    if (!fs.existsSync(ruta))
      throw new Error(`Falta ${ruta}: este build no se empaquetó con el secreto de producción (ver build.extraResources en package.json).`);
    return fs.readFileSync(ruta, "utf8").trim();
  }
  return generarSecretoDesarrolloSiHaceFalta();
}

module.exports = {
  normalizarNombre, normalizarCodigo, normalizarClaveIngresada,
  calcularClaveHex, formatoClave, validarClave,
  estadoActivacion, intentarActivar,
  resolverSecreto,
  RUTA_SECRETO_PRODUCCION, RUTA_SECRETO_DESARROLLO,
};
