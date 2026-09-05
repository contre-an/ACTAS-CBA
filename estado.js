// estado.js — Módulo 1: memoria por ficha
// Cada carpeta de ficha tiene su estado_ficha.json. Si no existe → ficha nueva.
// El registro.json global sigue siendo la autoridad del escalamiento y consecutivo de actas.
const fs = require("fs");
const path = require("path");

const NOMBRE_ESTADO = "estado_ficha.json";

function rutaEstado(carpetaFicha) {
  return path.join(carpetaFicha, NOMBRE_ESTADO);
}

function cargarEstado(carpetaFicha) {
  const ruta = rutaEstado(carpetaFicha);
  let contenido;
  try {
    contenido = fs.readFileSync(ruta, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null; // no existe → ficha sin inicializar
    // Cualquier otro error de lectura (permisos, etc.) tampoco es "ficha
    // nueva": es un problema real que hay que mostrarle al instructor.
    throw new Error(`No se pudo leer el estado de la ficha "${carpetaFicha}" (${ruta}): ${e.message}`);
  }
  try {
    return JSON.parse(contenido);
  } catch (e) {
    // El archivo SÍ existe pero está dañado: NUNCA tratarlo como ficha sin
    // inicializar, o el instructor re-inicializaría encima y perdería el
    // historial de llamados ya hecho.
    throw new Error(`El estado de la ficha "${carpetaFicha}" (${ruta}) existe pero está dañado o mal formado: ${e.message}. No se trata como ficha nueva para no perder el historial: hay que revisar o restaurar ese archivo a mano.`);
  }
}

function estadoNuevo(ficha) {
  return {
    ficha: ficha || null,
    programa: null,
    trimestre: null,
    creado: new Date().toISOString(),
    ultima_ejecucion: null,
    aprendices_migrados: false,
    total_aprendices: 0,
    equipo_ejecutor: null,        // se llena con la extracción del horario
    acta_equipo_ejecutor: null,   // { numero, fecha, archivo } cuando se genere
    sesiones_procesadas: [],      // fechas (encabezados de columna de ASISTENCIA) ya evaluadas
    actas_generadas: [],          // { fecha, documento, aprendiz, tipo, numero_acta, archivo }
    archivos_detectados: {},      // clasificación de la carpeta
  };
}

function guardarEstado(carpetaFicha, estado) {
  estado.ultima_ejecucion = new Date().toISOString();
  fs.writeFileSync(rutaEstado(carpetaFicha), JSON.stringify(estado, null, 2), "utf8");
  return estado;
}

// Determina qué sesiones (columnas de ASISTENCIA) son nuevas respecto al estado
function sesionesNuevas(estado, sesionesEnExcel) {
  const hechas = new Set((estado.sesiones_procesadas || []).map(String));
  return sesionesEnExcel.filter((s) => !hechas.has(String(s)));
}

function marcarSesiones(estado, sesiones) {
  const set = new Set((estado.sesiones_procesadas || []).map(String));
  sesiones.forEach((s) => set.add(String(s)));
  estado.sesiones_procesadas = [...set];
  return estado;
}

function registrarActa(estado, acta) {
  estado.actas_generadas.push({ ...acta, registrada: new Date().toISOString() });
  return estado;
}

// Clasificación heurística de los archivos de la carpeta
function clasificarArchivos(carpetaFicha) {
  const items = fs.readdirSync(carpetaFicha, { withFileTypes: true });
  const clas = { control: null, reporte_aprendices: null, horario: null,
                 desarrollo_curricular: null, carpeta_actividades: null,
                 carpeta_llamados: null, carpeta_guias: null, sin_clasificar: [] };
  // Si hay varios candidatos (ej. "Reporte (1).xls"), gana el modificado más reciente
  const masReciente = (actual, candidato) => {
    if (!actual) return candidato;
    const a = fs.statSync(path.join(carpetaFicha, actual)).mtimeMs;
    const b = fs.statSync(path.join(carpetaFicha, candidato)).mtimeMs;
    return b > a ? candidato : actual;
  };
  for (const it of items) {
    const n = it.name;
    const low = n.toLowerCase();
    if (it.isDirectory()) {
      if (low.includes("actividad")) clas.carpeta_actividades = n;
      else if (low.includes("llamado")) clas.carpeta_llamados = n;
      else if (low.includes("guia") || low.includes("guía")) clas.carpeta_guias = n;
      continue;
    }
    if (low === NOMBRE_ESTADO || low.startsWith("~$")) continue;
    // La plantilla maestra se descarta PRIMERO: su nombre contiene
    // "control_asistencia" y si no, se confundiría con el control de la ficha.
    if (low.includes("plantilla_maestra")) continue;
    if (low.includes("control_asistencia") || low.includes("control de asistencia"))
      clas.control = masReciente(clas.control, n);
    else if (low.includes("reporte") && low.includes("aprendices"))
      clas.reporte_aprendices = masReciente(clas.reporte_aprendices, n);
    else if (low.includes("horario"))
      clas.horario = masReciente(clas.horario, n);
    else if (low.includes("desarrollo curricular") || low.includes("desarrollo_curricular"))
      clas.desarrollo_curricular = masReciente(clas.desarrollo_curricular, n);
    else clas.sin_clasificar.push(n);
  }
  return clas;
}

// Devuelve el control de asistencia REAL de la ficha.
// Si el que quedó registrado en estado_ficha.json ya no existe (se renombró, se
// borró, o quedó apuntando a la plantilla maestra), lo vuelve a detectar en la
// carpeta y corrige el estado en memoria para que se guarde bien la próxima vez.
function resolverControl(carpetaFicha, est) {
  est.archivos_detectados = est.archivos_detectados || {};
  const registrado = est.archivos_detectados.control;
  const esPlantilla = (n) => String(n).toLowerCase().includes("plantilla_maestra");
  if (registrado && !esPlantilla(registrado) &&
      fs.existsSync(path.join(carpetaFicha, registrado))) return registrado;

  const candidatos = fs.readdirSync(carpetaFicha)
    .filter(f => /\.xlsx$/i.test(f) && !f.startsWith("~$") && !esPlantilla(f))
    .filter(f => /control[ _]?(de[ _])?asistencia/i.test(f));
  if (!candidatos.length) return null;
  candidatos.sort((a, b) =>
    fs.statSync(path.join(carpetaFicha, b)).mtimeMs - fs.statSync(path.join(carpetaFicha, a)).mtimeMs);
  est.archivos_detectados.control = candidatos[0];   // queda corregido
  return candidatos[0];
}

module.exports = { cargarEstado, estadoNuevo, guardarEstado, sesionesNuevas,
                   marcarSesiones, registrarActa, clasificarArchivos, resolverControl, NOMBRE_ESTADO };
