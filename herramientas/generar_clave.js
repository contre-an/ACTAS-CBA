#!/usr/bin/env node
// herramientas/generar_clave.js — SOLO para mi máquina (Carlos). No se
// distribuye: no está en package.json -> build.files, así que no viaja
// dentro de ningún instalador. Genera la clave que le dicto por teléfono a
// un instructor para que pueda activar Actas CBA (ver activacion.js).
//
// Uso:
//   node herramientas/generar_clave.js "NOMBRE COMPLETO" 05
//   node herramientas/generar_clave.js "NOMBRE COMPLETO" 05 --desarrollo
//
// --desarrollo firma con secretos/desarrollo.key (clave de PRUEBA: sirve
// para probar la pantalla de activación en "npm start", NUNCA valida en
// una instalación real, que se empaqueta con secretos/produccion.key).
const fs = require("fs");
const { calcularClaveHex, formatoClave, normalizarNombre, normalizarCodigo,
        RUTA_SECRETO_PRODUCCION, RUTA_SECRETO_DESARROLLO } = require("../activacion");

const [, , nombre, codigo, flag] = process.argv;
if (!nombre || !codigo) {
  console.error('Uso: node herramientas/generar_clave.js "NOMBRE COMPLETO" 05 [--desarrollo]');
  process.exit(1);
}
if (flag && flag !== "--desarrollo") {
  console.error(`Opción no reconocida: ${flag} (solo se acepta --desarrollo).`);
  process.exit(1);
}

const esDesarrollo = flag === "--desarrollo";
const rutaSecreto = esDesarrollo ? RUTA_SECRETO_DESARROLLO : RUTA_SECRETO_PRODUCCION;

if (!fs.existsSync(rutaSecreto)) {
  console.error(`No existe ${rutaSecreto}.`);
  if (esDesarrollo) {
    console.error('Se genera solo al correr "npm start" al menos una vez; corré eso primero.');
  } else {
    console.error("Generalo una sola vez, por ejemplo:");
    console.error(`  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > "${rutaSecreto}"`);
    console.error("Después RESPALDALO fuera de este equipo (ver README): si se pierde, ninguna clave ya emitida vuelve a validar.");
  }
  process.exit(1);
}

const secreto = fs.readFileSync(rutaSecreto, "utf8").trim();
if (!secreto) {
  console.error(`${rutaSecreto} existe pero está vacío.`);
  process.exit(1);
}

const codigoNormalizado = normalizarCodigo(codigo);
if (!/^\d{2}$/.test(codigo.trim()) || codigoNormalizado === "00") {
  console.error(`Código inválido: "${codigo}". Tiene que ser exactamente dos dígitos y distinto de "00".`);
  process.exit(1);
}

const hex = calcularClaveHex(secreto, nombre, codigoNormalizado);

console.log(`Nombre (tal cual queda firmado, para dictarlo igual): ${normalizarNombre(nombre)}`);
console.log(`Código de instructor: ${codigoNormalizado}`);
console.log(`Clave: ${formatoClave(hex)}`);
if (esDesarrollo) console.log("\n(clave de DESARROLLO — solo sirve contra secretos/desarrollo.key, no en instalaciones reales)");
