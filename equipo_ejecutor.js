// equipo_ejecutor.js — Acta de equipo ejecutor de una ficha: reúne a todos
// los instructores (del horario en PDF, horario.js) con el panorama de
// aprendices (de UN control de la ficha, el que se indique) y, SOLO en la
// fila del instructor que genera el acta, las novedades de su propio
// control (inasistencias, evidencias no presentadas, notas bajas y llegadas
// tarde de sus aprendices EN FORMACION). Las demás filas quedan vacías para
// diligenciar en la reunión: cada instructor lleva su control en su propio
// OneDrive, sin acceso cruzado — no hay forma de armarlas automáticamente,
// ni la habrá.
const fs = require("fs");
const path = require("path");
const { leerHorario, resumenInstructores } = require("./horario");
const { leerControl, norm, evaluarAprendiz, recibeLlamado, categoriaDe, CATEGORIAS } = require("./procesar");
const { generarActaEquipoEjecutor, cargarRegistro, guardarRegistro } = require("./generar");

// ===== reg.equipoEjecutor[ficha][].ruta: relativa a la carpeta del
// trimestre, no absoluta =====
// Antes se guardaba la ruta absoluta del .docx. Se rompía si el instructor
// movía la carpeta del trimestre, cambiaba de letra de unidad o
// reinstalaba Windows — y era justo lo que revertirFecha (revertir.js)
// necesita para borrar el .docx/.pdf. Ahora se guarda relativa a la
// carpeta del trimestre, y se resuelve contra la carpeta de ficha que
// revertirFecha ya recibe como parámetro (su padre es la carpeta del
// trimestre, siempre — fichas:listar en ipc.js arma cada carpeta de ficha
// como hija directa de carpetaTrimestre), nunca releyendo
// configuracion.json: así, si el instructor cambia de trimestre en la
// configuración entre generar y revertir, no afecta la resolución de una
// ficha que ya tenía seleccionada.
//
// Migración de entradas viejas con ruta absoluta: ver revertir.js, se
// hace de forma perezosa (solo cuando revertirFecha toca esa ficha), no
// acá.
function rutaRelativaSiCorresponde(rutaAbsoluta, carpetaTrimestre) {
  const relativa = path.relative(carpetaTrimestre, rutaAbsoluta);
  // path.relative() cruzando unidades en Windows devuelve la ruta absoluta
  // del destino tal cual: !path.isAbsolute(relativa) descarta ese caso
  // igual que descarta el prefijo "..": ambos significan "no está adentro".
  const dentro = relativa && !relativa.startsWith("..") && !path.isAbsolute(relativa);
  return dentro ? relativa : rutaAbsoluta; // fuera de la carpeta del trimestre: se deja como está
}

function resolverRutaEquipoEjecutor(ruta, carpetaTrimestre) {
  if (!ruta) return null;
  return path.isAbsolute(ruta) ? ruta : path.join(carpetaTrimestre, ruta);
}

// El horario suele traer el nombre del instructor recortado ("CARLOS JOSE
// GREGORIO" en vez de "CARLOS JOSÉ GREGORIO CONTRERAS VIVAS"). Se considera
// la misma persona si TODAS las palabras del nombre corto aparecen en el
// nombre completo (sin acentos/mayúsculas, sin importar el orden).
function esMismoInstructor(nombreCorto, nombreCompleto) {
  const palabrasCorto = norm(nombreCorto).split(" ").filter(Boolean);
  const palabrasCompleto = new Set(norm(nombreCompleto).split(" ").filter(Boolean));
  return palabrasCorto.length > 0 && palabrasCorto.every(p => palabrasCompleto.has(p));
}

// Frase de novedades de UN aprendiz, para todo el periodo (sin el "corte"
// del escalamiento de llamados: esto es un resumen para la reunión, no el
// motor de medidas disciplinarias).
function novedadDeAprendiz(a, sesiones, notaMin) {
  const { incidentes, retardos } = evaluarAprendiz(a, sesiones, notaMin);
  const fechasInasistencia = incidentes.filter(i => i.tipo === "INASISTENCIA").map(i => i.fecha);
  const noPresento = [...new Set(incidentes.filter(i => i.tipo === "NO_PRESENTO").map(i => i.actividad))];
  const notaBaja = [...new Set(incidentes.filter(i => i.tipo === "NOTA_BAJA").map(i => i.actividad))];

  const partes = [];
  if (fechasInasistencia.length) partes.push(`no asistió el ${fechasInasistencia.join(", ")}`);
  if (noPresento.length) partes.push(`no ha presentado ${noPresento.join(", ")}`);
  if (notaBaja.length) partes.push(`nota baja en ${notaBaja.join(", ")}`);
  if (retardos.length) partes.push(`registra ${retardos.length} llegada${retardos.length === 1 ? "" : "s"} tarde`);
  if (!partes.length) return null;
  return `${a.nombre}: ${partes.join("; ")}.`;
}

// Solo aprendices EN FORMACION, solo los que tienen algo que reportar.
function novedadesDeMiControl(params, sesiones, aprendices) {
  return aprendices
    .filter(a => recibeLlamado(a.estado))
    .map(a => novedadDeAprendiz(a, sesiones, params.notaMin))
    .filter(Boolean)
    .join(" ");
}

// OJO: a diferencia del panorama de generarEntregaControl() (que arma su
// propia fila "Total" dentro del arreglo), la tabla de panorama de esta
// plantilla YA trae su fila "Total" fija, fuera del loop {#panorama}, con el
// campo {total_aprendices} aparte. Si el arreglo también trae un "Total", el
// acta sale con la fila repetida.
function panoramaDe(aprendices) {
  const conteo = {};
  for (const a of aprendices) { const cat = categoriaDe(a.estado); conteo[cat] = (conteo[cat] || 0) + 1; }
  const panorama = CATEGORIAS.map(([, et]) => ({ estado: et, cantidad: conteo[et] || "-" }));
  if (conteo["Otros"]) panorama.push({ estado: "Otros", cantidad: conteo["Otros"] });
  return { panorama, total: aprendices.length };
}

/**
 * @param {object} opciones
 * @param {string} opciones.rutaHorarioPdf horario de la ficha en PDF
 * @param {string} opciones.rutaControlPropio el control del instructor que genera el acta
 * @param {object} [opciones.horario] resultado ya listo de leerHorario() (mismo formato
 *   que devuelve horario.js): úsalo en vez de rutaHorarioPdf cuando ya se leyó el
 *   horario antes, o en pruebas automatizadas que no dependen de un PDF real.
 * @param {string} opciones.carpetaSalida dónde queda el .docx (no es la carpeta de ningún
 *   control: el acta es de toda la ficha, no de un instructor)
 * @param {string} opciones.horaInicio "HH:MM" de la reunión (no se puede inventar)
 * @param {string} opciones.horaFin "HH:MM" de la reunión
 * @param {string} [opciones.fecha] fecha larga ("29 de julio de 2026"); por defecto hoy
 * @param {string} [opciones.lugar] [opciones.regional] [opciones.centro]
 * @param {string} [opciones.sintesis] síntesis de cierre (numeral 4); si no se da, un texto genérico
 * @param {{simular?: boolean}} [flags] simular=true por defecto: solo informa, no genera nada
 *   (ninguna acción que genere documentos se ejecuta sin aprobación).
 */
async function prepararActaEquipoEjecutor(opciones, { simular = true } = {}) {
  if (!opciones.horaInicio || !opciones.horaFin)
    throw new Error("Falta horaInicio/horaFin de la reunión: no se pueden inventar, hay que darlos.");

  const horario = opciones.horario || await leerHorario(opciones.rutaHorarioPdf);
  if (horario.errores.length)
    throw new Error(`El horario tiene filas que no se pudieron leer; revísalo antes de generar el acta:\n${horario.errores.join("\n")}`);

  const { params, sesiones, aprendices } = leerControl(opciones.rutaControlPropio);
  if (String(horario.ficha) !== String(params.ficha))
    throw new Error(`El horario es de la ficha ${horario.ficha} y el control es de la ficha ${params.ficha}: revisa que sean de la misma ficha.`);

  const { panorama, total } = panoramaDe(aprendices);
  const jefeGrupo = horario.sesiones[0]?.jefeGrupo || "";

  let miNombreCompleto = null;
  const filas = resumenInstructores(horario.sesiones).map(({ instructor, competencias }) => {
    const esUno = esMismoInstructor(instructor, params.instructor.nombre);
    if (esUno) miNombreCompleto = params.instructor.nombre;
    return {
      instructor: esUno ? params.instructor.nombre : instructor, // nombre completo SOLO en mi fila
      competencia: esUno ? params.competencia : competencias.join(" / "),
      esJefeGrupo: esMismoInstructor(instructor, jefeGrupo),
      novedades: esUno ? novedadesDeMiControl(params, sesiones, aprendices) : "",
    };
  });

  const avisos = [];
  if (!miNombreCompleto)
    avisos.push(`No se encontró "${params.instructor.nombre}" entre los instructores del horario: revisa que sea la misma persona (el horario puede traer el nombre recortado).`);

  const datos = {
    ficha: horario.ficha, programa: horario.programa, jefeGrupo,
    fecha: opciones.fecha, horaInicio: opciones.horaInicio, horaFin: opciones.horaFin,
    lugar: opciones.lugar, regional: opciones.regional, centro: opciones.centro,
    panorama, totalAprendices: total, filas, sintesis: opciones.sintesis,
  };

  if (simular) return { simulado: true, ficha: horario.ficha, programa: horario.programa, filas, panorama, totalAprendices: total, avisos };

  const { buffer, numero } = generarActaEquipoEjecutor(datos);
  fs.mkdirSync(opciones.carpetaSalida, { recursive: true });
  const nombreArchivo = `ACTA_${numero}_EQUIPO_EJECUTOR_FICHA_${horario.ficha}.docx`;
  const rutaArchivo = path.join(opciones.carpetaSalida, nombreArchivo);
  fs.writeFileSync(rutaArchivo, buffer);

  // Igual que procesar.js tras generarActa(): generarActaEquipoEjecutor ya
  // escribió la entrada en reg.equipoEjecutor[ficha], pero no conoce la
  // carpeta de salida ni el nombre del archivo (los decide quien la llama).
  // Se vuelve a abrir el registro para completar esa entrada con la ruta
  // (relativa a la carpeta del trimestre, ver arriba), que revertirFecha va
  // a necesitar para borrar el archivo sin adivinar dónde quedó. Solo
  // aplica a las actas nuevas: las que ya estaban en el registro se quedan
  // sin este campo.
  const reg = cargarRegistro();
  const entrada = (reg.equipoEjecutor?.[String(horario.ficha)] || []).find(e => e.numero === numero);
  if (entrada) entrada.ruta = rutaRelativaSiCorresponde(rutaArchivo, path.dirname(opciones.carpetaSalida));
  guardarRegistro(reg);

  return { simulado: false, ficha: horario.ficha, programa: horario.programa, numero, archivo: nombreArchivo, avisos };
}

module.exports = { prepararActaEquipoEjecutor, rutaRelativaSiCorresponde, resolverRutaEquipoEjecutor };
