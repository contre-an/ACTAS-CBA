// pruebas/regresion_reapertura.test.js — dos escenarios reales del mismo
// incidente, contados juntos porque juntos son la historia real de lo que
// pasó:
//
// 1. "El caso que lo causó": si PARAMETROS trae FICHA con el texto de
//    ejemplo de la plantilla, no debe generarse nada (ver
//    pruebas/recorrido_completo.test.js, "validación de PARAMETROS" — se
//    repite acá, junto a lo que provocó, para no separar la causa del
//    efecto).
// 2. Generar el primer y el segundo llamado de un aprendiz y luego
//    "cerrar y volver a abrir la app": un proceso Node COMPLETAMENTE
//    aparte (ver reabrirAppYProcesar), que solo comparte con este proceso
//    de prueba lo que hay en DISCO (registro.json y el control) — igual
//    que un arranque real comparte con el anterior. Reprocesar sin
//    incidentes nuevos no debe generar ninguna acta, y el historial del
//    aprendiz debe seguir con exactamente 2 entradas, no 4.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { execFileSync } = require("child_process");

const CARPETA = path.join(__dirname, "tmp", "regresion_reapertura");
process.env.ACTAS_REGISTRO_RUTA = path.join(CARPETA, "registro.json");
process.env.ACTAS_CODIGO_INSTRUCTOR = "00";

const { leerControl, procesarControl } = require("../procesar");

const RUTA_PLANTILLA = path.join(__dirname, "..", "PLANTILLA_MAESTRA_CONTROL_ASISTENCIA V3.xlsx");
const RUTA_PROCESAR_JS = path.join(__dirname, "..", "procesar.js");
const FICHA = 9000003;
const DOCUMENTO = "100000009";
const RUTA_CONTROL = path.join(CARPETA, `CONTROL_ASISTENCIA_${FICHA}.xlsx`);

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
function leerRegistro() {
  try { return JSON.parse(fs.readFileSync(process.env.ACTAS_REGISTRO_RUTA, "utf8")); }
  catch { return { consecutivo: 0, aprendices: {} }; }
}

// "Cerrar y volver a abrir la app": un proceso Node nuevo (require cache
// vacío, nada en memoria) que solo hereda el env (ACTAS_REGISTRO_RUTA) y
// lee el registro.json y el control DESDE DISCO — lo mismo que comparte
// un arranque real de la aplicación con la corrida anterior. Llamar
// procesarControl() una tercera vez en ESTE MISMO proceso de prueba no
// probaría nada distinto de lo que ya cubre el paso 3 de
// recorrido_completo.test.js ("volver a ejecutar sin cambiar nada"): si el
// bug fuera algo retenido en memoria entre corridas y NO un problema real
// de lo que queda guardado en disco, solo un proceso nuevo lo distingue.
function reabrirAppYProcesar(rutaControl) {
  const script = `
    const { procesarControl } = require(${JSON.stringify(RUTA_PROCESAR_JS)});
    const resultado = procesarControl(${JSON.stringify(rutaControl)}, false, false);
    process.stdout.write(JSON.stringify(resultado));
  `;
  const salida = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" });
  return JSON.parse(salida);
}

test("regresión: reabrir la app no duplica llamados ya generados; FICHA de ejemplo no genera nada", async t => {
  fs.rmSync(CARPETA, { recursive: true, force: true });
  fs.mkdirSync(CARPETA, { recursive: true });

  await t.test("1. el caso que lo causó: FICHA con el texto de ejemplo de la plantilla no genera nada", () => {
    const ruta = path.join(CARPETA, "CONTROL_SIN_FICHA.xlsx");
    fs.copyFileSync(RUTA_PLANTILLA, ruta); // FICHA sigue como "(NÚMERO DE FICHA)"
    assert.throws(() => leerControl(ruta), /Control sin terminar de configurar/);
    // Ni forzando (forzar=true) se salta esta validación: leerControl es lo
    // primero que corre procesarControl, antes de mirar PROCESAR EN
    // AUTOMATIZACIÓN, que es lo único que forzar realmente puentea.
    assert.throws(() => procesarControl(ruta, true, false), /Control sin terminar de configurar/);
  });

  fs.copyFileSync(RUTA_PLANTILLA, RUTA_CONTROL);
  establecerParametros(RUTA_CONTROL, {
    "FICHA": FICHA, "PROGRAMA DE FORMACIÓN": "TECNICO DE PRUEBA REAPERTURA", "COMPETENCIA": "COMPETENCIA DE PRUEBA",
    "PROCESAR EN AUTOMATIZACIÓN": "SI",
  });
  actualizarHoja(RUTA_CONTROL, "ASISTENCIA", filas => {
    filas[0][3] = new Date(2026, 6, 1); // D1: sesión del primer llamado
    filas[0][4] = new Date(2026, 6, 8); // E1: sesión del segundo llamado
    filas[1] = [1, DOCUMENTO, "APRENDIZ DE PRUEBA REAPERTURA", "prueba@ejemplo.test", "EN FORMACION", null, null];
  });
  actualizarHoja(RUTA_CONTROL, "APRENDICES", filas => {
    filas[1] = [1, DOCUMENTO, "APRENDIZ DE PRUEBA REAPERTURA", "prueba@ejemplo.test", "EN FORMACION", null, null];
  });
  const clave = `${FICHA}-${DOCUMENTO}`;

  await t.test("2. primer llamado", () => {
    actualizarHoja(RUTA_CONTROL, "ASISTENCIA", filas => { filas[1][3] = 0; }); // inasistencia, sesión 1
    const resumen = procesarControl(RUTA_CONTROL, false, false);
    assert.equal(resumen.casos.length, 1);
    assert.equal(resumen.casos[0].medida, "LLAMADO_1");
    assert.equal(leerRegistro().aprendices[clave].historial.length, 1);
  });

  await t.test("3. segundo llamado", () => {
    actualizarHoja(RUTA_CONTROL, "ASISTENCIA", filas => { filas[1][4] = 0; }); // inasistencia, sesión 2 (nueva)
    const resumen = procesarControl(RUTA_CONTROL, false, false);
    assert.equal(resumen.casos.length, 1);
    assert.equal(resumen.casos[0].medida, "LLAMADO_2");
    assert.equal(leerRegistro().aprendices[clave].historial.length, 2);
  });

  await t.test("4. reabrir la app (proceso nuevo) y reprocesar sin incidentes nuevos -> CERO actas, historial sigue en 2", () => {
    const resumen = reabrirAppYProcesar(RUTA_CONTROL);

    assert.equal(resumen.casos.length, 0, "no debe generarse ninguna acta nueva");
    assert.equal(resumen.sinNovedad, 1, "el aprendiz debe contar como sin novedad, no como omitido ni como error");
    assert.equal(resumen.omitidos.length, 0);
    assert.equal(resumen.errores.length, 0);

    const reg = leerRegistro();
    assert.equal(reg.aprendices[clave].historial.length, 2, "el historial NO debe duplicarse: sigue en 2, no 4");
    assert.equal(reg.aprendices[clave].llamados, 2);
  });
});
