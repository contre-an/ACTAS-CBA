// sofia.js — Migración a JavaScript del poblado de aprendices desde el
// reporte de SOFIA Plus (antes era Python con pandas/openpyxl/xlrd). Usa la
// librería xlsx, que ya lee tanto .xls como .xlsx. Código puro, sin IA.
//
// Lee el reporte, normaliza los estados que SOFIA entrega distinto de como
// los usa esta app (ver MAPA_ESTADOS) y escribe el resultado en la hoja
// APRENDICES del control, con la MISMA técnica de cirugía de XML que ya usa
// procesar.js para el HISTORICO: se editan solo las filas de datos de esa
// hoja, el resto del archivo (PARAMETROS, ASISTENCIA, NOTAS, formatos,
// anchos de columna) queda intacto.
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const PizZip = require("pizzip");

const norm = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toUpperCase();

// Estados que SOFIA reporta con un nombre distinto al que usa esta app.
// Las fichas nuevas traen a los aprendices en "EN INDUCCIÓN"; hasta ahora
// había que cambiarlos a mano a "EN FORMACION" antes de migrar (si no,
// procesarControl() los ignora: no calificaría con "recibeLlamado" ni con
// ninguna categoría de categoriaDe(), porque ese estado no existe en el
// vocabulario del resto del sistema). Se resuelve aquí, una sola vez, en la
// migración.
const MAPA_ESTADOS = {
  "EN INDUCCION": "EN FORMACION",
};

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Lee el reporte de aprendices de SOFIA (.xls o .xlsx) y devuelve la ficha,
// su estado, y la lista de aprendices ya lista para escribir en el control:
// documento, nombre completo ("APELLIDOS Y NOMBRES", igual que el control) y
// estado normalizado al vocabulario de esta app.
function leerReporteSofia(ruta) {
  const wb = XLSX.readFile(ruta);
  const hoja = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, defval: null });

  const encabezado = filas.findIndex(f => norm(f?.[0]) === "TIPO DE DOCUMENTO");
  if (encabezado === -1) throw new Error(`No se reconoce el formato del reporte de SOFIA en ${path.basename(ruta)}: no aparece la fila de encabezado ("Tipo de Documento...").`);

  const fichaCelda = String(filas[1]?.[2] ?? ""); // "3479381 - CULTIVOS AGRICOLAS"
  const ficha = fichaCelda.split("-")[0].trim();
  const estadoFicha = filas[2]?.[2] ?? null; // "EN EJECUCION" / "EN INDUCCION" / ...

  const aprendices = [];
  const advertencias = [];
  for (let r = encabezado + 1; r < filas.length; r++) {
    const fila = filas[r];
    if (!fila || fila.every(c => c == null || c === "")) continue;
    const documento = fila[1] != null ? String(fila[1]).trim() : "";
    const nombre = fila[2] != null ? String(fila[2]).trim() : "";
    const apellidos = fila[3] != null ? String(fila[3]).trim() : "";
    const correo = fila[5] != null ? String(fila[5]).trim() : "";
    const estadoCrudo = fila[6] != null ? String(fila[6]).trim() : "";
    if (!documento || !nombre) { advertencias.push(`Fila ${r + 1} del reporte: sin documento o sin nombre, se omite.`); continue; }

    const estado = MAPA_ESTADOS[norm(estadoCrudo)] || estadoCrudo.toUpperCase();
    if (MAPA_ESTADOS[norm(estadoCrudo)]) advertencias.push(`${documento} ${apellidos} ${nombre}: estado "${estadoCrudo}" migrado como "${estado}".`);

    // "APELLIDOS Y NOMBRES", en ese orden: igual que la columna del control.
    aprendices.push({ documento, nombreCompleto: `${apellidos} ${nombre}`.trim(), correo, estado });
  }
  return { ficha, estadoFicha, aprendices, advertencias };
}

function localizarHoja(zip, nombreHoja) {
  const wbXml = zip.file("xl/workbook.xml").asText();
  const m = wbXml.match(new RegExp(`<sheet[^>]*name="${nombreHoja}"[^>]*r:id="(rId\\d+)"`, "i")) ||
            wbXml.match(new RegExp(`<sheet[^>]*r:id="(rId\\d+)"[^>]*name="${nombreHoja}"`, "i"));
  if (!m) return null;
  const rels = zip.file("xl/_rels/workbook.xml.rels").asText();
  const rm = rels.match(new RegExp('Id="' + m[1] + '"[^>]*Target="([^"]+)"')) ||
             rels.match(new RegExp('Target="([^"]+)"[^>]*Id="' + m[1] + '"'));
  if (!rm) return null;
  let target = rm[1].replace(/^\//, "");
  if (!target.startsWith("xl/")) target = "xl/" + target.replace(/^\.\//, "");
  return target;
}

function estiloDeColumna(filaXml, col) {
  if (!filaXml) return null;
  const m = filaXml.match(new RegExp(`<c r="${col}\\d+"(?:\\s+s="(\\d+)")?`));
  return m ? m[1] || null : null;
}

function celda(col, r, estilo, valor, tipo) {
  const sAttr = estilo != null ? ` s="${estilo}"` : "";
  if (valor == null || valor === "") return `<c r="${col}${r}"${sAttr}/>`;
  if (tipo === "n") return `<c r="${col}${r}"${sAttr}><v>${valor}</v></c>`;
  return `<c r="${col}${r}"${sAttr} t="inlineStr"><is><t>${xmlEscape(valor)}</t></is></c>`;
}

/**
 * Reemplaza las filas de datos de la hoja APRENDICES del control por
 * `aprendices` (la fila 1, el encabezado, no se toca). Es para "inicializar
 * trimestre": pensada para correr UNA vez sobre un control recién armado a
 * partir de la plantilla, no para sincronizar un control que ya lleva
 * semanas de uso (eso borraría EVALUADO/NOVEDAD que el instructor ya haya
 * llenado a mano). Por eso, si la hoja ya tiene más de `avisoSiHay` filas de
 * datos, se avisa en el reporte en vez de sobrescribir en silencio.
 *
 * simular=true (por defecto): solo dice qué haría, no toca el archivo.
 */
function poblarAprendices(rutaControl, aprendices, { simular = true, avisoSiHay = 0 } = {}) {
  const zip = new PizZip(fs.readFileSync(rutaControl));
  const target = localizarHoja(zip, "APRENDICES");
  if (!target) throw new Error(`El archivo no tiene la hoja APRENDICES: ${path.basename(rutaControl)}`);
  const archivoHoja = zip.file(target);
  const xml = archivoHoja.asText();

  const filas = [...xml.matchAll(/<row[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>/g)];
  const filaEncabezado = filas.find(f => f[1] === "1");
  if (!filaEncabezado) throw new Error(`No se encontró la fila de encabezado (fila 1) en APRENDICES de ${path.basename(rutaControl)}.`);
  const filasDatosActuales = filas.filter(f => f[1] !== "1");
  const filaEjemplo = filasDatosActuales[0]?.[0] || null;

  const estilos = {
    A: estiloDeColumna(filaEjemplo, "A"), B: estiloDeColumna(filaEjemplo, "B"),
    C: estiloDeColumna(filaEjemplo, "C"), D: estiloDeColumna(filaEjemplo, "D"),
    E: estiloDeColumna(filaEjemplo, "E"), F: estiloDeColumna(filaEjemplo, "F"),
    G: estiloDeColumna(filaEjemplo, "G"),
  };

  const reporte = {
    archivo: path.basename(rutaControl), simulado: simular,
    filasActuales: filasDatosActuales.length, filasNuevas: aprendices.length,
    avisoSobrescritura: filasDatosActuales.length > avisoSiHay
      ? `La hoja APRENDICES ya tiene ${filasDatosActuales.length} fila(s) de datos; se reemplazarían todas por las ${aprendices.length} del reporte. Si el control ya se usó en el trimestre (EVALUADO/NOVEDAD llenados a mano), esos datos se perderían.`
      : null,
  };
  if (simular) return reporte;

  const nuevasFilas = aprendices.map((a, i) => {
    const r = i + 2;
    const documentoEsNumerico = /^\d+$/.test(a.documento);
    return `<row r="${r}" spans="1:7">` +
      celda("A", r, estilos.A, i + 1, "n") +
      celda("B", r, estilos.B, a.documento, documentoEsNumerico ? "n" : "texto") +
      celda("C", r, estilos.C, a.nombreCompleto) +
      celda("D", r, estilos.D, a.correo) +
      celda("E", r, estilos.E, a.estado) +
      celda("F", r, estilos.F, "") +
      celda("G", r, estilos.G, "") +
      `</row>`;
  }).join("");

  const xmlNuevo = xml.replace(/<sheetData>[\s\S]*<\/sheetData>/, `<sheetData>${filaEncabezado[0]}${nuevasFilas}</sheetData>`)
    .replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:G${1 + aprendices.length}"/>`);

  const respaldo = `${rutaControl}.respaldo_${Date.now()}`;
  fs.copyFileSync(rutaControl, respaldo);
  reporte.respaldo = respaldo;

  zip.file(target, xmlNuevo);
  fs.writeFileSync(rutaControl, zip.generate({ type: "nodebuffer", compression: "DEFLATE" }));
  return reporte;
}

module.exports = { leerReporteSofia, poblarAprendices, MAPA_ESTADOS };
