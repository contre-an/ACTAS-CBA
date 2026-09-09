// rutaRegistro.js — único sitio que decide dónde vive registro.json.
//
// Antes de este archivo, generar.js y revertir.js tenían cada uno su propia
// copia de esta resolución (mismo código, dos sitios). Se unifica acá.
//
// Prioridad:
//   1. ACTAS_REGISTRO_RUTA (variable de entorno) — SIEMPRE gana. La usan el
//      modo prueba (ver src/main/modoPrueba.js, vía ipc.js) y las pruebas
//      automatizadas para no tocar el registro.json real.
//   2. userData/registro.json — el default, dentro de Electron. Antes el
//      default caía en path.join(__dirname, "registro.json"), junto al
//      código: empaquetado, eso queda dentro de app.asar (solo lectura, y
//      se reemplaza en cada actualización). userData es el perfil del
//      usuario de Windows: sobrevive actualizaciones y reinstalaciones.
//   3. El registro.json legado (junto al código), si no hay noción de
//      userData — es decir, fuera de un proceso Electron real (pruebas con
//      node --test, herramientas/*.js). Preserva el comportamiento previo
//      para esos casos; en la práctica siempre está tapado por el punto 1
//      porque quien corre esos scripts fija ACTAS_REGISTRO_RUTA.
//
// Migración (2, la primera vez que corre sin override): si existe el
// registro.json legado y AÚN NO existe uno en userData, se copia — nunca se
// mueve ni se borra el legado. La copia se verifica antes de darse por
// buena (existe, es JSON válido, y su contenido es idéntico al original):
// si algo falla, se seguirá usando el legado y se señala el fallo. Un
// registro truncado tomado como bueno es justo la pérdida de consecutivo
// que esta migración existe para evitar.
//
// Si YA existen los dos (legado y userData) al resolver, no se adivina cuál
// es el correcto: se usa el de userData y se deja constancia para que
// quien opera la app decida a mano (ver obtenerAvisoRegistro()) — SALVO que
// ese legado ya sea el que esta misma migración copió alguna vez: eso se
// sabe por la marca (migracion_registro.json, en userData, nunca en el
// legado — empaquetado, el legado queda dentro de app.asar, de solo
// lectura). La marca guarda la ruta exacta del legado migrado; si en un
// arranque futuro aparece un legado en OTRA ruta, sí se avisa: eso es algo
// nuevo que esta instalación no había visto, no el resto ya conocido de la
// migración de siempre.
const fs = require("fs");
const path = require("path");

function rutaLegado() {
  return path.join(__dirname, "registro.json");
}

// Solo existe dentro de un proceso Electron real (dev con "electron ." o
// empaquetado: en ambos process.versions.electron está poblado). NUNCA por
// app.isPackaged: la migración tiene que funcionar igual corriendo desde el
// repo. Bajo node puro (pruebas, herramientas/*.js) no hay noción de
// userData y esta función devuelve null.
function carpetaUserData() {
  if (!process.versions.electron) return null;
  return require("electron").app.getPath("userData");
}

function rutaMarcaMigracion(userData) {
  return path.join(userData, "migracion_registro.json");
}

// Núcleo puro: nada de Electron ni de fs reales adentro, todo inyectado.
// Así se puede probar la lógica de migración/duplicado/fallo con
// node --test, sin depender de un userData real. Devuelve { ruta, aviso }.
// aviso es null, o uno de:
//   { tipo: "duplicado", rutaUsada, rutaSinUsar }
//   { tipo: "fallo_migracion", rutaVieja, rutaNuevaFallida, motivo }
function _resolver({ envRuta, userData, legado, existeSync, copiar, crearCarpeta, leerSync, escribirSync }) {
  if (envRuta) return { ruta: path.resolve(envRuta), aviso: null };
  if (!userData) return { ruta: legado, aviso: null };

  const rutaNueva = path.join(userData, "registro.json");
  const rutaMarca = rutaMarcaMigracion(userData);
  const existeNueva = existeSync(rutaNueva);
  const existeVieja = existeSync(legado);

  // ¿La marca dice que ESTE legado exacto ya se migró en algún arranque
  // anterior? Si la marca no existe, está dañada, o apunta a una ruta
  // distinta, no cuenta como "ya visto" — se prefiere avisar de más a
  // silenciar un duplicado real.
  function legadoYaMigrado() {
    if (!existeSync(rutaMarca)) return false;
    try {
      const marca = JSON.parse(leerSync(rutaMarca));
      return marca?.legadoMigrado === legado;
    } catch { return false; }
  }

  if (existeNueva) {
    // Ya hay uno en userData (de una migración anterior, o porque siempre
    // vivió ahí). Si el legado también sigue estando, coexisten dos
    // registros — salvo que la marca confirme que ESTE legado es el mismo
    // que ya se migró antes: ahí no es un duplicado nuevo, es el resto
    // esperado de dejar el legado sin borrar.
    const aviso = (existeVieja && !legadoYaMigrado())
      ? { tipo: "duplicado", rutaUsada: rutaNueva, rutaSinUsar: legado }
      : null;
    return { ruta: rutaNueva, aviso };
  }

  if (!existeVieja) return { ruta: rutaNueva, aviso: null }; // instalación nueva: nada que migrar

  // Migración: no existe en userData, sí existe el legado.
  try {
    const original = leerSync(legado);
    crearCarpeta(userData);
    copiar(legado, rutaNueva);
    const copiado = leerSync(rutaNueva);
    JSON.parse(copiado); // debe ser JSON válido
    if (copiado !== original) throw new Error("el contenido copiado no coincide con el del archivo original");
    // Deja constancia de que ESTE legado ya quedó migrado, para no avisar
    // "duplicado" en cada arranque futuro mientras siga sin borrarse. Si
    // esto falla (permisos, disco), no invalida una migración que ya se
    // verificó bien: en el peor caso, se repite el aviso más adelante.
    try { escribirSync(rutaMarca, JSON.stringify({ legadoMigrado: legado, fecha: new Date().toISOString() }, null, 2)); }
    catch { /* no crítico, ver comentario arriba */ }
    return { ruta: rutaNueva, aviso: null };
  } catch (e) {
    // No se pudo confirmar la copia: se sigue usando el legado. Nunca se
    // usa un userData/registro.json a medio escribir o corrupto. Este
    // aviso NUNCA se silencia con la marca: es distinto del "duplicado ya
    // conocido" de arriba, y tiene que verse siempre hasta que se resuelva.
    return {
      ruta: legado,
      aviso: { tipo: "fallo_migracion", rutaVieja: legado, rutaNuevaFallida: rutaNueva, motivo: e.message },
    };
  }
}

// Se resuelve una sola vez por proceso (mientras no haya override): la
// migración y la detección de duplicado/fallo no tienen sentido repetirlas
// en cada cargarRegistro()/guardarRegistro(). Con ACTAS_REGISTRO_RUTA puesto
// (modo prueba, pruebas automatizadas) no se cachea nada: se respeta la
// variable tal cual esté en cada llamado, igual que antes.
let cache = null;

function resolverRutaRegistro() {
  if (process.env.ACTAS_REGISTRO_RUTA) return path.resolve(process.env.ACTAS_REGISTRO_RUTA);
  if (!cache) {
    cache = _resolver({
      envRuta: null,
      userData: carpetaUserData(),
      legado: rutaLegado(),
      existeSync: fs.existsSync,
      copiar: fs.copyFileSync,
      crearCarpeta: p => fs.mkdirSync(p, { recursive: true }),
      leerSync: p => fs.readFileSync(p, "utf8"),
      escribirSync: (p, contenido) => fs.writeFileSync(p, contenido),
    });
  }
  return cache.ruta;
}

// Para que ipc.js decida si avisa (diálogo) tras el primer resolverRutaRegistro()
// de la sesión sin override. null si no hay nada que avisar.
function obtenerAvisoRegistro() {
  return cache ? cache.aviso : null;
}

module.exports = { resolverRutaRegistro, obtenerAvisoRegistro, _resolver };
