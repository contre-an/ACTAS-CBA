// pruebas/plantilla_formato.test.js — "Nueva ficha" + "migrar aprendices"
// no deben perder el formato de la plantilla maestra (listas desplegables,
// formato condicional, anchos de columna, paneles inmovilizados).
//
// Contexto: establecerParametrosInstructor (ipc.js) reescribía el libro
// completo con XLSX.readFile/writeFile (edición community de la librería
// xlsx), que no conserva nada de eso — regresión del commit cecd7e5, ver
// ARQUITECTURA.md pendiente 11. El arreglo (escribirParametros/celda/
// resolverHojaEnZip, en procesar.js) edita solo las celdas puntuales por
// cirugía de XML (PizZip), igual que ya hacía registrarEnHistorico para el
// HISTORICO y poblarAprendices (sofia.js) para APRENDICES. Esta prueba
// compara CONTRA LA PLANTILLA REAL del proyecto, con números, no a ojo.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const PizZip = require("pizzip");
const { escribirParametros, resolverHojaEnZip, leerControl } = require("../procesar");
const { poblarAprendices } = require("../sofia");

const CARPETA = path.join(__dirname, "tmp", "plantilla_formato");
const RUTA_PLANTILLA = path.join(__dirname, "..", "PLANTILLA_MAESTRA_CONTROL_ASISTENCIA V3.xlsx");
const RUTA_CONTROL = path.join(CARPETA, "CONTROL_ASISTENCIA_FORMATO.xlsx");

// Cuenta, por cada hoja del .xlsx (xl/worksheets/sheetN.xml), cuántas veces
// aparece cada marcador de formato/validación que nos importa conservar.
const MARCADORES = /<dataValidations[ >]|<conditionalFormatting[ >]|<pane |<col[^>]*customWidth/g;
function contarPorHoja(rutaXlsx) {
  const zip = new PizZip(fs.readFileSync(rutaXlsx));
  const resultado = {};
  for (const nombre of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(nombre)) continue;
    resultado[nombre] = (zip.file(nombre).asText().match(MARCADORES) || []).sort();
  }
  return resultado;
}

test("Nueva ficha + migrar aprendices no pierden el formato de la plantilla", async t => {
  fs.rmSync(CARPETA, { recursive: true, force: true });
  fs.mkdirSync(CARPETA, { recursive: true });
  fs.copyFileSync(RUTA_PLANTILLA, RUTA_CONTROL);

  const marcadoresOriginal = contarPorHoja(RUTA_PLANTILLA);
  // La plantilla real de este proyecto SÍ trae estos 4 tipos de marcador;
  // si esto fallara, sería la propia plantilla la que cambió de forma
  // inesperada, no el código de esta prueba.
  const totalOriginal = Object.values(marcadoresOriginal).flat().length;
  assert.ok(totalOriginal > 0, "la plantilla debería traer dataValidations/conditionalFormatting/pane/col customWidth — si no, revisar la plantilla, no este arreglo");

  await t.test("1. escribirParametros (precarga de 'Nueva ficha') no toca ninguna hoja de formato", () => {
    // INSTRUCTOR/DOCUMENTO/CORREO son los 3 que de verdad precarga "Nueva
    // ficha" (ipc.js); FICHA/PROGRAMA/COMPETENCIA los llena el instructor a
    // mano después de abrir el Excel — se ponen en la misma llamada solo
    // para poder ejercitar leerControl() de punta a punta más abajo (ver
    // pendiente de validación de PARAMETROS: sin esto, FICHA/PROGRAMA/
    // COMPETENCIA seguirían siendo el texto de ejemplo de la plantilla).
    const ok = escribirParametros(RUTA_CONTROL, {
      "INSTRUCTOR": "INSTRUCTOR DE PRUEBA", "DOCUMENTO INSTRUCTOR": "123456", "CORREO INSTRUCTOR": "prueba@ejemplo.test",
      "FICHA": "9000002", "PROGRAMA DE FORMACIÓN": "PROGRAMA DE PRUEBA", "COMPETENCIA": "COMPETENCIA DE PRUEBA",
    });
    assert.equal(ok, true);
    assert.deepEqual(contarPorHoja(RUTA_CONTROL), marcadoresOriginal, "ninguna hoja debe perder listas desplegables, formato condicional, paneles o anchos de columna");

    const stylesOriginal = new PizZip(fs.readFileSync(RUTA_PLANTILLA)).file("xl/styles.xml").asText();
    const stylesAhora = new PizZip(fs.readFileSync(RUTA_CONTROL)).file("xl/styles.xml").asText();
    assert.equal(stylesAhora, stylesOriginal, "xl/styles.xml no debe cambiar ni un byte");
  });

  await t.test("2. leerControl relee los 3 valores precargados", () => {
    const { params } = leerControl(RUTA_CONTROL);
    assert.equal(params.instructor.nombre, "INSTRUCTOR DE PRUEBA");
    assert.equal(String(params.instructor.documento), "123456");
    assert.equal(params.instructor.correo, "prueba@ejemplo.test");
  });

  await t.test("3. poblarAprendices (migrar aprendices) tampoco los pierde, encadenado sobre el mismo archivo", () => {
    const reporte = poblarAprendices(RUTA_CONTROL, [
      { documento: "900000001", nombreCompleto: "UNO DE PRUEBA", correo: "uno@ejemplo.test", estado: "EN FORMACION" },
      { documento: "900000002", nombreCompleto: "DOS DE PRUEBA", correo: "dos@ejemplo.test", estado: "EN FORMACION" },
    ], { simular: false });
    assert.equal(reporte.filasNuevas, 2);
    assert.deepEqual(contarPorHoja(RUTA_CONTROL), marcadoresOriginal, "migrar aprendices, después de precargar el instructor, tampoco debe perder nada");
  });

  await t.test("4. las 2 listas desplegables de APRENDICES (columnas E/F) siguen exactamente ahí", () => {
    const zip = new PizZip(fs.readFileSync(RUTA_CONTROL));
    const hoja = resolverHojaEnZip(zip, "APRENDICES");
    assert.match(hoja.xml, /<dataValidations count="2">/);
  });

  await t.test("5. leerControl funciona de punta a punta sobre el archivo final: instructor + aprendices migrados", () => {
    const { params, aprendices } = leerControl(RUTA_CONTROL);
    assert.equal(params.instructor.nombre, "INSTRUCTOR DE PRUEBA");
    assert.equal(aprendices.length, 2);
    assert.equal(aprendices[0].nombre, "UNO DE PRUEBA");
    assert.equal(aprendices[0].estado, "EN FORMACION");
  });
});
