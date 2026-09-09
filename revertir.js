// revertir.js — Deshace las actas generadas en una fecha, cuando una corrida
// sale mal: borra los .docx, limpia las filas del HISTORICO del control,
// devuelve a cada aprendiz su "corte" de fecha anterior (para que el próximo
// procesamiento no salte incidentes) y recalcula el consecutivo global.
//
// Por defecto NO TOCA NADA (simular = true): solo dice qué haría. Hay que
// pasar { simular: false } explícitamente para ejecutar, y aun así se guarda
// un respaldo del registro y del control antes de escribir nada.
const fs = require("fs");
const path = require("path");
const PizZip = require("pizzip");
const { cargarRegistro, guardarRegistro } = require("./generar");
const { leerControl } = require("./procesar");
const { resolverRutaRegistro } = require("./rutaRegistro");
const { rutaRelativaSiCorresponde, resolverRutaEquipoEjecutor } = require("./equipo_ejecutor");

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Acepta "AAAA-MM-DD" o "DD/MM/AAAA" (o un Date) y devuelve la fecha en los
// dos formatos que usa el sistema: registro.json guarda DD/MM/AAAA
// (fechaCorta, en generar.js) y el HISTORICO del Excel guarda AAAA/MM/DD
// (fechaHoy, en procesar.js). Si no coinciden, una corrida real jamás
// encontraría nada que revertir.
function normalizarFecha(entrada) {
  let d;
  if (entrada instanceof Date) d = entrada;
  else {
    const s = String(entrada).trim();
    let m;
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) d = new Date(+m[1], +m[2] - 1, +m[3]);
    else if ((m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/))) d = new Date(+m[3], +m[2] - 1, +m[1]);
    else throw new Error(`Fecha no reconocida: "${entrada}". Usa AAAA-MM-DD o DD/MM/AAAA.`);
  }
  const dd = String(d.getDate()).padStart(2, "0"), mm = String(d.getMonth() + 1).padStart(2, "0"), aaaa = d.getFullYear();
  return { ddmmaaaa: `${dd}/${mm}/${aaaa}`, aaaammdd_historico: `${aaaa}/${mm}/${dd}` };
}

function buscarControlEnCarpeta(carpeta) {
  const candidatos = fs.readdirSync(carpeta)
    .filter(f => /^CONTROL_ASISTENCIA.*\.xlsx$/i.test(f) && !f.startsWith("~$"));
  if (!candidatos.length) throw new Error(`No hay ningún CONTROL_ASISTENCIA*.xlsx en ${carpeta}`);
  if (candidatos.length > 1)
    throw new Error(`Hay más de un CONTROL_ASISTENCIA en ${carpeta} (${candidatos.join(", ")}); indica cuál es.`);
  return path.join(carpeta, candidatos[0]);
}

function localizarHojaHistorico(zip) {
  const wbXml = zip.file("xl/workbook.xml").asText();
  const m = wbXml.match(/<sheet[^>]*name="HISTORICO"[^>]*r:id="(rId\d+)"/i) ||
            wbXml.match(/<sheet[^>]*r:id="(rId\d+)"[^>]*name="HISTORICO"/i);
  if (!m) return null;
  const rels = zip.file("xl/_rels/workbook.xml.rels").asText();
  const rm = rels.match(new RegExp('Id="' + m[1] + '"[^>]*Target="([^"]+)"')) ||
             rels.match(new RegExp('Target="([^"]+)"[^>]*Id="' + m[1] + '"'));
  if (!rm) return null;
  let target = rm[1].replace(/^\//, "");
  if (!target.startsWith("xl/")) target = "xl/" + target.replace(/^\.\//, "");
  return target;
}

// Quita del HISTORICO las filas cuya columna F (numero de acta) esté en
// `numeros`. Devuelve cuántas filas quitó. No escribe nada si numeros está
// vacío o si no encuentra la hoja/las filas.
function quitarFilasHistorico(rutaControl, numeros) {
  if (!numeros.length) return 0;
  const zip = new PizZip(fs.readFileSync(rutaControl));
  const target = localizarHojaHistorico(zip);
  if (!target) return 0;
  const archivoHoja = zip.file(target);
  if (!archivoHoja) return 0;
  let xml = archivoHoja.asText();
  let eliminadas = 0;
  for (const numero of numeros) {
    const acta = xmlEscape(String(numero));
    const patronCelda = new RegExp(`<c r="F\\d+"[^>]*><is><t>${acta}</t></is></c>`);
    xml = xml.replace(/<row[^>]*\br="\d+"[^>]*>[\s\S]*?<\/row>/g, fila => {
      if (patronCelda.test(fila)) { eliminadas++; return ""; }
      return fila;
    });
  }
  if (eliminadas) {
    zip.file(target, xml);
    fs.writeFileSync(rutaControl, zip.generate({ type: "nodebuffer", compression: "DEFLATE" }));
  }
  return eliminadas;
}

// El numero de acta es compuesto (951210-XX-NNN, ver numeroActa() en
// generar.js): NNN es el consecutivo propio de esta instalación, siempre el
// último grupo de dígitos. parseInt directo sobre el numero completo daría
// 951210 (se detiene en el primer guion), así que se extrae ese último
// grupo en vez de asumir que el numero completo ya es un entero.
function consecutivoPropio(numero) {
  const m = String(numero).match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

// Recalcula reg.consecutivo como el número de acta más alto que sobreviva en
// TODO el registro (todas las fichas), tras quitar lo revertido. Si lo que se
// revirtió eran los números más altos, el consecutivo baja y no quedan huecos;
// si no lo eran, se deja igual (nunca se retrocede pisando actas que siguen
// existiendo).
function recalcularConsecutivo(reg) {
  let max = 0;
  for (const clave of Object.keys(reg.aprendices || {}))
    for (const h of reg.aprendices[clave].historial || [])
      max = Math.max(max, consecutivoPropio(h.numero));
  for (const ficha of Object.keys(reg.entregas || {}))
    max = Math.max(max, consecutivoPropio(reg.entregas[ficha].numero));
  // Sin esto, un acta de equipo ejecutor con el numero mas alto emitido
  // para una ficha quedaria fuera del calculo: al revertir cualquier otra
  // cosa, reg.consecutivo bajaria por debajo de un numero que sigue en
  // uso, y la siguiente acta generada lo reutilizaria sobre un documento
  // real distinto.
  for (const ficha of Object.keys(reg.equipoEjecutor || {}))
    for (const e of reg.equipoEjecutor[ficha] || [])
      max = Math.max(max, consecutivoPropio(e.numero));
  reg.consecutivo = max;
}

/**
 * Deshace lo generado en `fecha` para la ficha de `carpetaFicha`.
 * @param {string} carpetaFicha carpeta de la ficha (donde está el CONTROL_ASISTENCIA)
 * @param {string|Date} fecha fecha a revertir, "AAAA-MM-DD" o "DD/MM/AAAA"
 * @param {{simular?: boolean}} opciones simular=true (por defecto): solo informa, no cambia nada.
 * @returns {object} reporte de lo encontrado/hecho
 */
function revertirFecha(carpetaFicha, fecha, { simular = true } = {}) {
  const rutaControl = buscarControlEnCarpeta(carpetaFicha);
  const { params } = leerControl(rutaControl);
  const ficha = String(params.ficha);
  const { ddmmaaaa, aaaammdd_historico } = normalizarFecha(fecha);

  const regOriginal = cargarRegistro();
  const reg = JSON.parse(JSON.stringify(regOriginal)); // se muta una copia; solo se persiste si simular=false

  // Padre de la carpeta de ficha: SIEMPRE la carpeta del trimestre
  // (fichas:listar en ipc.js arma cada carpeta de ficha como hija directa
  // de carpetaTrimestre). Se deriva de carpetaFicha, nunca releyendo
  // configuracion.json: así, si el instructor cambió de trimestre en la
  // configuración entre generar y revertir, no afecta esta ficha concreta,
  // que ya llegó resuelta como parámetro (ver equipo_ejecutor.js).
  const carpetaTrimestre = path.dirname(carpetaFicha);
  const carpetaActas = path.join(carpetaFicha, "LLAMADOS DE ATENCION");
  // Ruta del .pdf ya convertido de un .docx, si existe. Se calcula desde ya
  // (también durante simular=true) para que la vista previa pueda decir
  // explícitamente que también se va a borrar. No hay ningún dato guardado
  // sobre conversión a PDF en ningún lado (pendiente 8): el único rastro
  // es el archivo mismo.
  const pdfSiExiste = rutaDocx => {
    const rutaPdf = rutaDocx.replace(/\.docx$/i, ".pdf");
    return fs.existsSync(rutaPdf) ? rutaPdf : null;
  };

  const actasRevertidas = [];   // { aprendiz, documento, numero, tipo, archivo }
  let entregaRevertida = null;  // { numero, archivo }
  const equipoEjecutorRevertido = []; // { numero, fecha, ruta }
  const avisos = [];

  for (const clave of Object.keys(reg.aprendices)) {
    if (!clave.startsWith(`${ficha}-`)) continue;
    const ap = reg.aprendices[clave];
    while (ap.historial.length && ap.historial[ap.historial.length - 1].fecha === ddmmaaaa) {
      const ultimo = ap.historial.pop();
      actasRevertidas.push({
        aprendiz: ultimo.nombre, documento: clave.slice(ficha.length + 1),
        numero: ultimo.numero, tipo: ultimo.tipo, archivo: ultimo.archivo || null,
        pdf: ultimo.archivo ? pdfSiExiste(path.join(carpetaActas, ultimo.archivo)) : null,
      });
      // el aprendiz vuelve a quedar como estaba justo antes de esta acta
      ap.ultimaFechaIncidente = ultimo.fechaCorteAntes ?? null;
      ap.retardosPendientes = ultimo.retardosPendientesAntes ?? [];
    }
    // recalcular contadores de escalamiento desde el historial que queda
    // (recalcular, no restar, para no arrastrar un error si algo quedó inconsistente)
    ap.llamados = ap.historial.filter(h => h.tipo === "LLAMADO_1" || h.tipo === "LLAMADO_2").length;
    ap.planes = ap.historial.filter(h => h.tipo === "PLAN_MEJORAMIENTO").length;
    ap.comite = ap.historial.some(h => h.tipo === "INFORME_COMITE");
    if (!ap.historial.length) delete reg.aprendices[clave]; // ficha limpia para este aprendiz
  }

  if (reg.entregas?.[ficha]?.fecha === ddmmaaaa) {
    const e = reg.entregas[ficha];
    const archivoEntrega = `ACTA_ENTREGA_${e.numero}_FICHA_${ficha}.docx`;
    entregaRevertida = { numero: e.numero, archivo: archivoEntrega, pdf: pdfSiExiste(path.join(carpetaFicha, archivoEntrega)) };
    delete reg.entregas[ficha];
  }

  // Actas de equipo ejecutor de esa fecha (pendiente 5, paso 3). Si
  // reg.equipoEjecutor no existe (registro.json de antes de esa
  // estructura), Array.isArray da false y no pasa nada.
  if (Array.isArray(reg.equipoEjecutor?.[ficha])) {
    const quedan = [];
    for (const e of reg.equipoEjecutor[ficha]) {
      if (e.fecha !== ddmmaaaa) {
        // Migración perezosa (no se toca nada más): si esta entrada de otra
        // fecha quedó con ruta absoluta y cae dentro de la carpeta del
        // trimestre actual, se convierte a relativa acá mismo. Se persiste
        // solo si simular=false, con el guardarRegistro(reg) de más abajo.
        if (e.ruta && path.isAbsolute(e.ruta)) e.ruta = rutaRelativaSiCorresponde(e.ruta, carpetaTrimestre);
        quedan.push(e);
        continue;
      }
      const rutaResuelta = resolverRutaEquipoEjecutor(e.ruta, carpetaTrimestre);
      const rutaValida = rutaResuelta && fs.existsSync(rutaResuelta);
      equipoEjecutorRevertido.push({ numero: e.numero, fecha: e.fecha, ruta: rutaValida ? rutaResuelta : null, pdf: rutaValida ? pdfSiExiste(rutaResuelta) : null });
      // Dos casos distintos, cada uno con su propio aviso — ninguno en
      // silencio, y los dos dicen qué hacer, no solo qué pasó:
      if (!e.ruta) {
        // Actas de antes del paso 2 (que empezó a guardar la ruta): no hay
        // dónde buscar el archivo. Se quita igual la entrada del registro.
        avisos.push(`El acta de equipo ejecutor ${e.numero} (ficha ${ficha}, ${e.fecha}) no tiene guardada la ruta de su .docx: se quita del registro, pero hay que localizarlo y borrarlo a mano si sigue en algún lado.`);
      } else if (!rutaValida) {
        // Sí había ruta (absoluta o relativa), pero ya no resuelve a nada:
        // se movió, se renombró o se borró a mano por fuera de la app.
        avisos.push(`El acta de equipo ejecutor ${e.numero} (ficha ${ficha}, ${e.fecha}) tenía guardada la ruta "${rutaResuelta}", que ya no existe (el .docx pudo haberse movido o borrado a mano): se quita del registro, pero hay que localizarlo y borrarlo a mano si sigue en algún lado.`);
      }
    }
    if (quedan.length) reg.equipoEjecutor[ficha] = quedan;
    else delete reg.equipoEjecutor[ficha];
  }

  const consecutivoAntes = reg.consecutivo;
  recalcularConsecutivo(reg);

  const reporte = {
    ficha, fecha: ddmmaaaa, simulado: simular,
    actasRevertidas, entregaRevertida, equipoEjecutorRevertido, avisos,
    consecutivoAntes, consecutivoDespues: reg.consecutivo,
    archivosBorrados: [], pdfsBorrados: [], historicoFilasEliminadas: 0, respaldos: [],
  };

  if (!actasRevertidas.length && !entregaRevertida && !equipoEjecutorRevertido.length) {
    reporte.mensaje = `No hay nada registrado con fecha ${ddmmaaaa} para la ficha ${ficha}.`;
    return reporte;
  }

  if (simular) return reporte;

  // ---- a partir de aquí sí se ejecuta y se cambian archivos reales ----
  // Orden a propósito: TODO lo que se va a tocar se respalda ANTES de tocar
  // nada (ni un archivo borrado, ni una fila de HISTORICO editada, ni el
  // registro sobrescrito) — no solo justo antes de escribir cada uno.
  const REGISTRO = resolverRutaRegistro();
  if (fs.existsSync(REGISTRO)) {
    const respaldoRegistro = `${REGISTRO}.respaldo_${timestamp()}`;
    fs.copyFileSync(REGISTRO, respaldoRegistro);
    reporte.respaldos.push(respaldoRegistro);
  }
  const respaldoControl = `${rutaControl}.respaldo_${timestamp()}`;
  fs.copyFileSync(rutaControl, respaldoControl);
  reporte.respaldos.push(respaldoControl);

  reporte.archivosNoBorrados = [];

  // Borra y COMPRUEBA que de verdad quedó borrado: en el sistema anterior el
  // script daba por borrado un archivo que seguía ahí (por ejemplo, abierto
  // en Word/Excel y bloqueado por el sistema operativo). No basta con que
  // unlinkSync no haya lanzado error.
  const borrarSiExiste = ruta => {
    if (!fs.existsSync(ruta)) return;
    try { fs.unlinkSync(ruta); } catch (e) { reporte.archivosNoBorrados.push(`${ruta} (${e.message})`); return; }
    if (fs.existsSync(ruta)) reporte.archivosNoBorrados.push(`${ruta} (el sistema no reportó error, pero el archivo sigue ahí)`);
    else reporte.archivosBorrados.push(ruta);
  };

  // El .pdf de una acta revertida, a diferencia del .docx, NO aborta la
  // reversión si no se puede borrar (Adobe/Edge u otro visor abierto): el
  // .docx sí quedó revertido y el registro sí debe actualizarse — dejar de
  // revertir una medida disciplinaria por un PDF bloqueado sería peor que
  // el PDF huérfano en sí. Se avisa con la ruta completa en vez de fallar.
  const borrarPdfSiExiste = rutaPdf => {
    if (!rutaPdf || !fs.existsSync(rutaPdf)) return;
    const avisar = () => avisos.push(`El PDF de una acta revertida no se pudo borrar (${rutaPdf}): puede estar abierto en Adobe, Edge u otro visor. Ciérralo y bórralo a mano — mientras exista, "Convertir a PDF" no va a generar el PDF de la nueva versión de esta acta con el mismo número.`);
    try { fs.unlinkSync(rutaPdf); } catch { avisar(); return; }
    if (fs.existsSync(rutaPdf)) avisar();
    else reporte.pdfsBorrados.push(rutaPdf);
  };

  for (const a of actasRevertidas) {
    if (a.archivo) { borrarSiExiste(path.join(carpetaActas, a.archivo)); borrarPdfSiExiste(a.pdf); }
    // actas viejas (de antes de que se guardara el nombre del archivo): se
    // buscan por el numero de acta en el nombre, como respaldo.
    else if (fs.existsSync(carpetaActas)) {
      for (const f of fs.readdirSync(carpetaActas))
        if (f.includes(`_${a.numero}_`)) { borrarSiExiste(path.join(carpetaActas, f)); borrarPdfSiExiste(pdfSiExiste(path.join(carpetaActas, f))); }
    }
  }
  if (entregaRevertida) { borrarSiExiste(path.join(carpetaFicha, entregaRevertida.archivo)); borrarPdfSiExiste(entregaRevertida.pdf); }

  // Solo las que sí tienen ruta: las que no, ya quedaron avisadas arriba
  // y no hay nada que intentar borrar aquí.
  for (const e of equipoEjecutorRevertido) { if (e.ruta) borrarSiExiste(e.ruta); borrarPdfSiExiste(e.pdf); }

  const numerosARevertir = [
    ...actasRevertidas.map(a => a.numero),
    ...(entregaRevertida ? [entregaRevertida.numero] : []),
    ...equipoEjecutorRevertido.map(e => e.numero),
  ];
  reporte.historicoFilasEliminadas = quitarFilasHistorico(rutaControl, numerosARevertir);

  // Si algún archivo no se pudo borrar de verdad, no se sobrescribe el
  // registro como si la reversión hubiera quedado completa: mejor un error
  // explícito (con los respaldos ya hechos y a salvo) que un registro que
  // dice "revertido" mientras el archivo real sigue en la carpeta.
  if (reporte.archivosNoBorrados.length)
    throw new Error(`No se pudo confirmar el borrado de: ${reporte.archivosNoBorrados.join("; ")}. ¿Alguno está abierto en Word/Excel? El registro NO se modificó; los respaldos ya están hechos: ${reporte.respaldos.join(", ")}`);

  guardarRegistro(reg);

  return reporte;
}

module.exports = { revertirFecha, normalizarFecha, buscarControlEnCarpeta };
