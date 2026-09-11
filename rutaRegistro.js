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

// ===== Respaldo del registro en la carpeta del trimestre =====
// registro.json vive en userData y hasta ahora solo se respaldaba como
// efecto secundario de revertirFecha (revertir.js) — nunca durante la
// generación normal. Riesgo real: un reinstall de Windows borra
// %APPDATA% sin avisar, y con él el consecutivo y el historial completo.
// La carpeta del trimestre es la única que sabemos con certeza que el
// instructor ya respalda de verdad (ahí viven sus fichas reales), a
// diferencia de userData.
//
// Nombres FIJOS, no con timestamp (a diferencia de revertir.js, que
// respalda antes de una operación puntual y poco frecuente): esto corre
// en cada generación, decenas de veces por sesión — un archivo nuevo cada
// vez ensuciaría la carpeta real del instructor sin aportar nada. Dos
// archivos en rotación, no uno solo: si el registro real se daña (por lo
// que sea, ajeno a este mecanismo) y DESPUÉS se genera cualquier acta, un
// archivo único se sobrescribiría con la versión ya dañada en la primera
// corrida siguiente al daño — con dos, el ".anterior.json" todavía guarda
// la generación de antes: una corrida de margen para notar el problema.
const NOMBRE_RESPALDO = "_registro_actas_respaldo.json";
const NOMBRE_RESPALDO_ANTERIOR = "_registro_actas_respaldo.anterior.json";
const NOMBRE_LEEME = "LEEME_RESPALDO.txt";

// Se escribe UNA sola vez por carpeta (si ya existe, no se vuelve a
// tocar): sin esto, cualquiera que vea "_registro_actas_respaldo.json"
// suelto en su carpeta del trimestre puede pensar que es basura temporal
// y borrarlo. Ver ARQUITECTURA.md, pendiente 13, para la advertencia de
// "antes de generar algo nuevo después de restaurar".
const LEEME_RESPALDO = `Este archivo lo genera y actualiza automáticamente la aplicación "Actas CBA".

QUÉ ES
------
_registro_actas_respaldo.json es una copia de seguridad del registro de
actas: el consecutivo de numeración y el historial de llamados de
atención generados, de esta ficha y de todas las demás que hayas
procesado con esta instalación de Actas CBA. No es un archivo de esta
ficha en particular: es un respaldo del archivo real, que vive en
%APPDATA%\\actas-cba\\registro.json.

_registro_actas_respaldo.anterior.json es la copia de un paso atrás (el
estado de la vez anterior que se generó algo), para tener margen si el
respaldo más reciente resultara dañado.

NO LOS BORRES
-------------
Si el día de mañana reinstalan Windows en este computador (o el equipo
se daña), %APPDATA% se pierde y con él el registro real. Como esta
carpeta del trimestre normalmente sí está respaldada (OneDrive, Google
Drive, un disco externo — lo que uses), estos archivos son la forma de
recuperar el consecutivo y el historial sin empezar de cero.

CÓMO RESTAURARLO SI HACE FALTA
-------------------------------
1. Cerrá Actas CBA por completo.
2. Copiá _registro_actas_respaldo.json (el más reciente; usá el
   ".anterior.json" solo si el primero está dañado o vacío) a:
   %APPDATA%\\actas-cba\\registro.json
   (reemplazando el que haya ahí).
3. Volvé a abrir Actas CBA.

IMPORTANTE ANTES DE GENERAR ALGO NUEVO DESPUÉS DE RESTAURAR
-------------------------------------------------------------
Si este respaldo es más viejo que la última vez que generaste actas de
verdad, la aplicación puede repetir llamados de atención que ya se
habían generado, o numerar un acta nueva con el mismo número que ya
tiene un documento real. Antes de confiar en lo que diga el registro
restaurado, revisá a mano, para cada ficha, que el historial coincida
con los .docx que ya existen y con las filas de la hoja HISTORICO del
control — todavía no hay una herramienta que lo haga sola.

Este archivo se genera solo, una sola vez: no hace falta (ni conviene)
editarlo a mano.
`;

// Copia registro.json a `carpetaTrimestre` (rotando el respaldo anterior
// primero) y deja el LEEME si todavía no está. Mejor esfuerzo: NUNCA
// lanza — devuelve null si salió bien, o un aviso en español si algo
// falló, para que quien llama lo agregue a sus propios avisos (nunca en
// silencio, pero tampoco bloquea la generación real por esto).
function respaldarRegistroEnTrimestre(carpetaTrimestre) {
  try {
    const origen = resolverRutaRegistro();
    if (!fs.existsSync(origen)) return null; // nada generado todavía: no hay qué respaldar

    const destino = path.join(carpetaTrimestre, NOMBRE_RESPALDO);
    const anterior = path.join(carpetaTrimestre, NOMBRE_RESPALDO_ANTERIOR);
    if (fs.existsSync(destino)) fs.copyFileSync(destino, anterior); // rota ANTES de sobrescribir
    fs.copyFileSync(origen, destino);
  } catch (e) {
    return `No se pudo respaldar el registro en la carpeta del trimestre (${carpetaTrimestre}): ${e.message}.`;
  }
  // El LEEME es solo explicativo: que falle no debe reportarse como que
  // el respaldo real (lo que de verdad importa) falló.
  try {
    const rutaLeeme = path.join(carpetaTrimestre, NOMBRE_LEEME);
    if (!fs.existsSync(rutaLeeme)) fs.writeFileSync(rutaLeeme, LEEME_RESPALDO, "utf8");
  } catch { /* no crítico */ }
  return null;
}

module.exports = {
  resolverRutaRegistro, obtenerAvisoRegistro, _resolver,
  respaldarRegistroEnTrimestre, NOMBRE_RESPALDO, NOMBRE_RESPALDO_ANTERIOR, NOMBRE_LEEME,
};
