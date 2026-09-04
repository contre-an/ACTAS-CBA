// herramientas/agregar_hoja_descripciones.js — agrega la hoja DESCRIPCIONES
// a la plantilla maestra del control (punto 2 del encargo). Es una
// herramienta de preparación de la plantilla, se corre UNA vez por versión
// de plantilla, no es parte del flujo de la app.
//
// Uso: node herramientas/agregar_hoja_descripciones.js "RUTA_DE_LA_PLANTILLA.xlsx"
//
// Qué hace, y por qué así:
// - Agrega una hoja nueva "DESCRIPCIONES" con dos columnas: A = ACTIVIDAD,
//   B = DESCRIPCIÓN.
// - La columna A se llena SOLA, con una fórmula por fila que apunta a cada
//   celda del encabezado de NOTAS (=NOTAS!D1 .. =NOTAS!W1, las 20 columnas
//   de sesión que usa procesar.js). El instructor nunca escribe ahí a mano:
//   si tuviera que copiar los nombres, la hoja se desactualiza.
// - Todo se hace con cirugía de XML directa sobre el .xlsx (como ya hace
//   procesar.js con el HISTORICO): se agrega SOLO la hoja nueva, sin volver
//   a escribir el resto del libro con una librería de alto nivel, que podría
//   perder formatos, colores condicionales o listas desplegables que ya
//   tiene la plantilla.
const fs = require("fs");
const path = require("path");
const PizZip = require("pizzip");

const COLUMNAS_NOTAS = ["D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W"];

function agregarHojaDescripciones(rutaPlantilla) {
  const zip = new PizZip(fs.readFileSync(rutaPlantilla));

  // 1) hoja nueva: sheetN.xml, el primer número libre
  const numeros = Object.keys(zip.files)
    .map(f => f.match(/^xl\/worksheets\/sheet(\d+)\.xml$/)).filter(Boolean).map(m => Number(m[1]));
  const nuevoNumero = Math.max(...numeros) + 1;
  const nuevoArchivo = `xl/worksheets/sheet${nuevoNumero}.xml`;

  const filaEncabezado = `<row r="1"><c r="A1" s="6" t="inlineStr"><is><t>ACTIVIDAD</t></is></c><c r="B1" s="6" t="inlineStr"><is><t>DESCRIPCIÓN</t></is></c></row>`;
  const filasFormula = COLUMNAS_NOTAS.map((col, i) => {
    const r = i + 2;
    return `<row r="${r}"><c r="A${r}" t="str"><f>NOTAS!${col}1</f></c><c r="B${r}" t="inlineStr"><is><t></t></is></c></row>`;
  }).join("");

  const hojaXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<dimension ref="A1:B${1 + COLUMNAS_NOTAS.length}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews>` +
    `<sheetFormatPr baseColWidth="10" defaultColWidth="8.6328125" defaultRowHeight="14.5"/>` +
    `<cols><col min="1" max="1" width="34" customWidth="1"/><col min="2" max="2" width="80" customWidth="1"/></cols>` +
    `<sheetData>${filaEncabezado}${filasFormula}</sheetData>` +
    `</worksheet>`;
  zip.file(nuevoArchivo, hojaXml);

  // 2) workbook.xml: registrar la hoja (siguiente sheetId y r:id libres).
  // El r:id tiene que ser único en TODO workbook.xml.rels (ahí también están
  // el tema, los estilos, las cadenas compartidas y calcChain, no solo las
  // hojas) -- por eso el máximo se saca de ahí, no de workbook.xml.
  let wbXml = zip.file("xl/workbook.xml").asText();
  const relsXmlActual = zip.file("xl/_rels/workbook.xml.rels").asText();
  const sheetIds = [...wbXml.matchAll(/sheetId="(\d+)"/g)].map(m => Number(m[1]));
  const rIds = [...relsXmlActual.matchAll(/[Ii]d="rId(\d+)"/g)].map(m => Number(m[1]));
  const nuevoSheetId = Math.max(...sheetIds) + 1;
  const nuevoRId = `rId${Math.max(...rIds) + 1}`;
  wbXml = wbXml.replace(/<\/sheets>/, `<sheet name="DESCRIPCIONES" sheetId="${nuevoSheetId}" r:id="${nuevoRId}"/></sheets>`);
  // Fuerza el recálculo completo al abrir: las fórmulas nuevas no traen
  // valor en caché (NOTAS!D1..W1 están vacías en la plantilla en blanco), y
  // sin esto Excel podría no recalcularlas hasta que algo las marque "sucias".
  if (/fullCalcOnLoad=/.test(wbXml)) wbXml = wbXml.replace(/fullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"');
  else wbXml = wbXml.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
  zip.file("xl/workbook.xml", wbXml);

  // 3) workbook.xml.rels: relacionar el nuevo r:id con el archivo de la hoja
  let relsXml = zip.file("xl/_rels/workbook.xml.rels").asText();
  relsXml = relsXml.replace(/<\/Relationships>/,
    `<Relationship Id="${nuevoRId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${nuevoNumero}.xml"/></Relationships>`);
  zip.file("xl/_rels/workbook.xml.rels", relsXml);

  // 4) [Content_Types].xml: declarar el tipo de contenido de la hoja nueva
  let typesXml = zip.file("[Content_Types].xml").asText();
  typesXml = typesXml.replace(/<\/Types>/,
    `<Override PartName="/${nuevoArchivo}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  zip.file("[Content_Types].xml", typesXml);

  // 5) calcChain.xml: se borra en vez de dejarlo desactualizado (no incluye
  // las fórmulas nuevas). Excel lo reconstruye solo al abrir el archivo; es
  // más seguro que dejar una referencia a celdas que no están.
  if (zip.file("xl/calcChain.xml")) {
    zip.remove("xl/calcChain.xml");
    relsXml = zip.file("xl/_rels/workbook.xml.rels").asText().replace(/<Relationship[^>]*Target="calcChain\.xml"\s*\/>/, "");
    zip.file("xl/_rels/workbook.xml.rels", relsXml);
    typesXml = zip.file("[Content_Types].xml").asText().replace(/<Override[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/, "");
    zip.file("[Content_Types].xml", typesXml);
  }

  fs.writeFileSync(rutaPlantilla, zip.generate({ type: "nodebuffer", compression: "DEFLATE" }));
}

if (require.main === module) {
  const ruta = process.argv[2];
  if (!ruta) { console.error("Uso: node herramientas/agregar_hoja_descripciones.js RUTA_PLANTILLA.xlsx"); process.exit(1); }
  agregarHojaDescripciones(path.resolve(ruta));
  console.log(`Hoja DESCRIPCIONES agregada a: ${ruta}`);
}

module.exports = { agregarHojaDescripciones };
