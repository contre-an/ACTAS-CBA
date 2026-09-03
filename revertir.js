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

// Recalcula reg.consecutivo como el número de acta más alto que sobreviva en
// TODO el registro (todas las fichas), tras quitar lo revertido. Si lo que se
// revirtió eran los números más altos, el consecutivo baja y no quedan huecos;
// si no lo eran, se deja igual (nunca se retrocede pisando actas que siguen
// existiendo).
function recalcularConsecutivo(reg) {
  let max = 0;
  for (const clave of Object.keys(reg.aprendices || {}))
    for (const h of reg.aprendices[clave].historial || [])
      max = Math.max(max, parseInt(h.numero, 10) || 0);
  for (const ficha of Object.keys(reg.entregas || {}))
    max = Math.max(max, parseInt(reg.entregas[ficha].numero, 10) || 0);
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

  const actasRevertidas = [];   // { aprendiz, documento, numero, tipo, archivo }
  let entregaRevertida = null;  // { numero, archivo }

  for (const clave of Object.keys(reg.aprendices)) {
    if (!clave.startsWith(`${ficha}-`)) continue;
    const ap = reg.aprendices[clave];
    while (ap.historial.length && ap.historial[ap.historial.length - 1].fecha === ddmmaaaa) {
      const ultimo = ap.historial.pop();
      actasRevertidas.push({
        aprendiz: ultimo.nombre, documento: clave.slice(ficha.length + 1),
        numero: ultimo.numero, tipo: ultimo.tipo, archivo: ultimo.archivo || null,
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
    entregaRevertida = { numero: e.numero, archivo: `ACTA_ENTREGA_${e.numero}_FICHA_${ficha}.docx` };
    delete reg.entregas[ficha];
  }

  const consecutivoAntes = reg.consecutivo;
  recalcularConsecutivo(reg);

  const reporte = {
    ficha, fecha: ddmmaaaa, simulado: simular,
    actasRevertidas, entregaRevertida,
    consecutivoAntes, consecutivoDespues: reg.consecutivo,
    archivosBorrados: [], historicoFilasEliminadas: 0, respaldos: [],
  };

  if (!actasRevertidas.length && !entregaRevertida) {
    reporte.mensaje = `No hay nada registrado con fecha ${ddmmaaaa} para la ficha ${ficha}.`;
    return reporte;
  }

  if (simular) return reporte;

  // ---- a partir de aquí sí se ejecuta y se cambian archivos reales ----
  const carpetaActas = path.join(carpetaFicha, "LLAMADOS DE ATENCION");

  const borrarSiExiste = ruta => {
    if (fs.existsSync(ruta)) { fs.unlinkSync(ruta); reporte.archivosBorrados.push(ruta); }
  };
  for (const a of actasRevertidas) {
    if (a.archivo) borrarSiExiste(path.join(carpetaActas, a.archivo));
    // actas viejas (de antes de que se guardara el nombre del archivo): se
    // buscan por el numero de acta en el nombre, como respaldo.
    else if (fs.existsSync(carpetaActas)) {
      for (const f of fs.readdirSync(carpetaActas))
        if (f.includes(`_${a.numero}_`)) borrarSiExiste(path.join(carpetaActas, f));
    }
  }
  if (entregaRevertida) borrarSiExiste(path.join(carpetaFicha, entregaRevertida.archivo));

  // Respaldo del control ANTES de tocar el HISTORICO
  const respaldoControl = `${rutaControl}.respaldo_${timestamp()}`;
  fs.copyFileSync(rutaControl, respaldoControl);
  reporte.respaldos.push(respaldoControl);

  const numerosARevertir = [...actasRevertidas.map(a => a.numero), ...(entregaRevertida ? [entregaRevertida.numero] : [])];
  reporte.historicoFilasEliminadas = quitarFilasHistorico(rutaControl, numerosARevertir);

  // Respaldo del registro ANTES de sobrescribirlo
  const REGISTRO = path.join(__dirname, "registro.json");
  if (fs.existsSync(REGISTRO)) {
    const respaldoRegistro = `${REGISTRO}.respaldo_${timestamp()}`;
    fs.copyFileSync(REGISTRO, respaldoRegistro);
    reporte.respaldos.push(respaldoRegistro);
  }
  guardarRegistro(reg);

  return reporte;
}

module.exports = { revertirFecha, normalizarFecha };
