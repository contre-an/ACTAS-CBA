// pruebas/respaldo_registro.test.js — respaldo de registro.json en la
// carpeta del trimestre (rutaRegistro.js: respaldarRegistroEnTrimestre),
// enganchado en los 4 puntos de orquestación (procesarControl,
// generarEntregaControl, prepararActaEquipoEjecutor, revertirFecha). Cubre
// solo procesarControl y revertirFecha acá (alcanza para probar la
// función compartida; los otros dos puntos llaman exactamente a la misma
// función, con el mismo contrato).
//
// Estructura de carpetas ANIDADA de verdad (TRIMESTRE_PRUEBA/FICHA_PRUEBA/
// CONTROL_ASISTENCIA_*.xlsx), para que la carpeta del trimestre sea un
// directorio propio y aislado — no pruebas/tmp/ compartido con otros
// archivos de prueba.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const CARPETA_BASE = path.join(__dirname, "tmp", "respaldo_registro");
const CARPETA_TRIMESTRE = path.join(CARPETA_BASE, "TRIMESTRE_PRUEBA");
const CARPETA_FICHA = path.join(CARPETA_TRIMESTRE, "FICHA_PRUEBA");
process.env.ACTAS_REGISTRO_RUTA = path.join(CARPETA_BASE, "registro.json");
process.env.ACTAS_CODIGO_INSTRUCTOR = "00";

const { procesarControl } = require("../procesar");
const { revertirFecha } = require("../revertir");
const { NOMBRE_RESPALDO, NOMBRE_RESPALDO_ANTERIOR, NOMBRE_LEEME } = require("../rutaRegistro");

const RUTA_PLANTILLA = path.join(__dirname, "..", "PLANTILLA_MAESTRA_CONTROL_ASISTENCIA V3.xlsx");
const FICHA = 9000004;
const RUTA_CONTROL = path.join(CARPETA_FICHA, `CONTROL_ASISTENCIA_${FICHA}.xlsx`);
const RUTA_RESPALDO = path.join(CARPETA_TRIMESTRE, NOMBRE_RESPALDO);
const RUTA_RESPALDO_ANTERIOR = path.join(CARPETA_TRIMESTRE, NOMBRE_RESPALDO_ANTERIOR);
const RUTA_LEEME = path.join(CARPETA_TRIMESTRE, NOMBRE_LEEME);

function actualizarHoja(ruta, nombreHoja, mutador) {
  const wb = XLSX.readFile(ruta, { cellDates: true });
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[nombreHoja], { header: 1, defval: null });
  mutador(filas);
  wb.Sheets[nombreHoja] = XLSX.utils.aoa_to_sheet(filas);
  XLSX.writeFile(wb, ruta);
}
function establecerParametros(ruta, valores) {
  actualizarHoja(ruta, "PARAMETROS", filas => {
    for (const fila of filas) {
      const clave = String(fila[0] ?? "").trim().toUpperCase();
      if (clave in valores) fila[1] = valores[clave];
    }
  });
}
function leerRegistroReal() {
  return fs.readFileSync(process.env.ACTAS_REGISTRO_RUTA, "utf8");
}
function hoyISOLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("respaldo del registro en la carpeta del trimestre: rotación, mejor esfuerzo, LEEME", async t => {
  fs.rmSync(CARPETA_BASE, { recursive: true, force: true });
  fs.mkdirSync(CARPETA_FICHA, { recursive: true });
  fs.copyFileSync(RUTA_PLANTILLA, RUTA_CONTROL);
  establecerParametros(RUTA_CONTROL, {
    "FICHA": FICHA, "PROGRAMA DE FORMACIÓN": "TECNICO DE PRUEBA RESPALDO", "COMPETENCIA": "COMPETENCIA DE PRUEBA",
    "PROCESAR EN AUTOMATIZACIÓN": "SI",
  });
  actualizarHoja(RUTA_CONTROL, "ASISTENCIA", filas => {
    filas[0][3] = new Date(2026, 6, 1); filas[0][4] = new Date(2026, 6, 8); // D1, E1
    filas[1] = [1, "100000010", "APRENDIZ UNO RESPALDO", "uno@ejemplo.test", "EN FORMACION", null, null];
  });
  actualizarHoja(RUTA_CONTROL, "APRENDICES", filas => {
    filas[1] = [1, "100000010", "APRENDIZ UNO RESPALDO", "uno@ejemplo.test", "EN FORMACION", null, null];
  });

  await t.test("1. primer llamado -> se crea el respaldo y el LEEME; todavía no hay .anterior", () => {
    actualizarHoja(RUTA_CONTROL, "ASISTENCIA", filas => { filas[1][3] = 0; });
    const resumen = procesarControl(RUTA_CONTROL, false, false);
    assert.equal(resumen.casos.length, 1);

    assert.ok(fs.existsSync(RUTA_RESPALDO), "debe existir _registro_actas_respaldo.json");
    assert.equal(fs.readFileSync(RUTA_RESPALDO, "utf8"), leerRegistroReal(), "el respaldo debe coincidir con el registro real");
    assert.ok(!fs.existsSync(RUTA_RESPALDO_ANTERIOR), "todavía no hay nada que rotar la primera vez");
    assert.ok(fs.existsSync(RUTA_LEEME), "debe existir LEEME_RESPALDO.txt");
    assert.match(fs.readFileSync(RUTA_LEEME, "utf8"), /NO LOS BORRES/);
  });

  await t.test("2. segundo llamado -> rota: .anterior queda con el estado de ANTES de este llamado", () => {
    const estadoAntes = leerRegistroReal();
    actualizarHoja(RUTA_CONTROL, "ASISTENCIA", filas => { filas[1][4] = 0; });
    const resumen = procesarControl(RUTA_CONTROL, false, false);
    assert.equal(resumen.casos.length, 1);

    assert.equal(fs.readFileSync(RUTA_RESPALDO_ANTERIOR, "utf8"), estadoAntes, "el .anterior debe ser el estado previo a este llamado");
    assert.equal(fs.readFileSync(RUTA_RESPALDO, "utf8"), leerRegistroReal(), "el respaldo más reciente debe ser el estado actual (después del segundo llamado)");
    assert.notEqual(fs.readFileSync(RUTA_RESPALDO, "utf8"), fs.readFileSync(RUTA_RESPALDO_ANTERIOR, "utf8"), "los dos archivos no deben ser iguales entre sí en este punto");
  });

  await t.test("3. revertirFecha también dispara el respaldo (rotación tras revertir)", () => {
    const estadoAntesDeRevertir = leerRegistroReal();
    const resultado = revertirFecha(CARPETA_FICHA, hoyISOLocal(), { simular: false });
    assert.ok(resultado.actasRevertidas.length > 0, "debe haber revertido algo de verdad");

    assert.equal(fs.readFileSync(RUTA_RESPALDO_ANTERIOR, "utf8"), estadoAntesDeRevertir, "el .anterior debe ser el estado justo antes de revertir");
    assert.equal(fs.readFileSync(RUTA_RESPALDO, "utf8"), leerRegistroReal(), "el respaldo más reciente debe reflejar el estado YA revertido");
  });

  await t.test("4. si la carpeta del trimestre no admite escribir el respaldo, la generación real NO se bloquea: sale un aviso", () => {
    // Mismo truco que ya usan las pruebas de reversión de este proyecto:
    // una carpeta con el nombre exacto del archivo esperado, para que
    // fs.copyFileSync falle de forma determinista y repetible, sin
    // depender de permisos reales del sistema operativo.
    fs.rmSync(RUTA_RESPALDO, { recursive: true, force: true });
    fs.mkdirSync(RUTA_RESPALDO);

    actualizarHoja(RUTA_CONTROL, "APRENDICES", filas => {
      filas[2] = [2, "100000011", "APRENDIZ DOS RESPALDO BLOQUEADO", "dos@ejemplo.test", "EN FORMACION", null, null];
    });
    actualizarHoja(RUTA_CONTROL, "ASISTENCIA", filas => {
      filas[2] = [2, "100000011", "APRENDIZ DOS RESPALDO BLOQUEADO", 0];
    });

    const resumen = procesarControl(RUTA_CONTROL, false, false);
    // (el aprendiz uno también vuelve a generar acá porque el paso 3 lo
    // revirtió y sus marcas de asistencia siguen puestas; no es parte de
    // lo que prueba este paso — lo que importa es que el aprendiz dos SÍ
    // se generó igual, con el respaldo bloqueado)
    assert.ok(resumen.casos.some(c => c.documento === "100000011"), "el acta del aprendiz nuevo debe generarse igual, aunque el respaldo no se haya podido escribir");
    assert.equal(resumen.errores.length, 0);
    assert.ok(resumen.avisos.some(a => /No se pudo respaldar el registro/.test(a)), "debe avisar del fallo, no callarlo");
    assert.ok(resumen.avisos.some(a => a.includes(CARPETA_TRIMESTRE)), "el aviso debe nombrar la carpeta del trimestre");

    fs.rmSync(RUTA_RESPALDO, { recursive: true, force: true }); // deja de bloquear, para no interferir con otra corrida
  });
});
