// src/main/modoPrueba.js — modo prueba: demostraciones y pruebas repetibles
// sin tocar NUNCA el registro.json real ni ninguna carpeta de ficha real.
//
// Todo lo que toca este modo vive aparte, en userData/modo_prueba/:
// - registro.pruebas.json (nunca registro.json — ver ACTAS_REGISTRO_RUTA
//   en generar.js, que es lo que hace la separación real)
// - trimestre_demo/ con UNA ficha ficticia, siempre la misma, que
//   "Restablecer" puede volver a armar desde cero cuantas veces haga falta
//
// Al apagar el modo prueba, producción arranca en cero por sí sola: su
// registro.json nunca se tocó mientras el modo estuvo prendido, porque
// ACTAS_REGISTRO_RUTA apuntaba a otro archivo todo ese tiempo.
const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const XLSX = require("xlsx");

const RAIZ = path.join(__dirname, "..", "..");
const RUTA_PLANTILLA_MAESTRA = path.join(RAIZ, "PLANTILLA_MAESTRA_CONTROL_ASISTENCIA V3.xlsx");
const NOMBRE_FICHA_DEMO = "0000000 - FICHA DE DEMOSTRACIÓN (MODO PRUEBA)";

const rutaBase = () => path.join(app.getPath("userData"), "modo_prueba");
const rutaRegistroPruebas = () => path.join(rutaBase(), "registro.pruebas.json");
const rutaTrimestreDemo = () => path.join(rutaBase(), "trimestre_demo");
const rutaFichaDemo = () => path.join(rutaTrimestreDemo(), NOMBRE_FICHA_DEMO);
const rutaControlDemo = () => path.join(rutaFichaDemo(), "CONTROL_ASISTENCIA_DEMO.xlsx");

// Arma la ficha ficticia de demostración desde cero: plantilla en blanco +
// PARAMETROS de mentira + dos aprendices de mentira, uno con una
// inasistencia ya lista para que "Generar actas" tenga algo que mostrar sin
// pasos previos (útil para demostrar la app en el computador de un
// compañero sin tener que preparar nada a mano primero).
function crearFichaDemo() {
  fs.mkdirSync(rutaFichaDemo(), { recursive: true });
  fs.copyFileSync(RUTA_PLANTILLA_MAESTRA, rutaControlDemo());

  const wb = XLSX.readFile(rutaControlDemo(), { cellDates: true });

  const pf = XLSX.utils.sheet_to_json(wb.Sheets["PARAMETROS"], { header: 1, defval: null });
  for (const fila of pf) {
    const clave = String(fila[0] ?? "").trim().toUpperCase();
    if (clave === "FICHA") fila[1] = "0000000"; // string, no numero: 0 es falsy y dispara "PARAMETROS incompletos" en leerControl
    if (clave === "PROGRAMA DE FORMACIÓN") fila[1] = "PROGRAMA DE DEMOSTRACIÓN";
    if (clave === "COMPETENCIA") fila[1] = "COMPETENCIA DE DEMOSTRACIÓN";
    if (clave === "INSTRUCTOR") fila[1] = "INSTRUCTOR DE DEMOSTRACIÓN";
    if (clave === "DOCUMENTO INSTRUCTOR") fila[1] = 0;
    if (clave === "CORREO INSTRUCTOR") fila[1] = "demo@ejemplo.test";
    if (clave === "PROCESAR EN AUTOMATIZACIÓN") fila[1] = "SI";
    if (clave === "GENERAR ACTA DE ENTREGA") fila[1] = "SI";
  }
  wb.Sheets["PARAMETROS"] = XLSX.utils.aoa_to_sheet(pf);

  const af = XLSX.utils.sheet_to_json(wb.Sheets["ASISTENCIA"], { header: 1, defval: null });
  af[0][3] = new Date(); // una sesión, hoy
  af[1][3] = 0;          // aprendiz uno: inasistencia, lista para demostrar
  af[2][3] = "X";        // aprendiz dos: presente
  wb.Sheets["ASISTENCIA"] = XLSX.utils.aoa_to_sheet(af);

  const apf = XLSX.utils.sheet_to_json(wb.Sheets["APRENDICES"], { header: 1, defval: null });
  apf[1] = [1, 1000000001, "APRENDIZ DE DEMOSTRACIÓN UNO", "demo1@ejemplo.test", "EN FORMACION", null, null];
  apf[2] = [2, 1000000002, "APRENDIZ DE DEMOSTRACIÓN DOS", "demo2@ejemplo.test", "EN FORMACION", "SI", null];
  wb.Sheets["APRENDICES"] = XLSX.utils.aoa_to_sheet(apf);

  XLSX.writeFile(wb, rutaControlDemo());
}

function asegurarFichaDemo() {
  if (!fs.existsSync(rutaControlDemo())) crearFichaDemo();
}

// Borra SOLO lo del modo prueba (registro.pruebas.json y trimestre_demo/,
// ambos dentro de userData/modo_prueba/) y vuelve a armar la ficha de
// demostración desde cero. Nunca toca nada fuera de esa carpeta: ni el
// registro.json real, ni ninguna carpeta de ficha real.
function restablecer() {
  fs.rmSync(rutaBase(), { recursive: true, force: true });
  crearFichaDemo();
}

module.exports = { rutaRegistroPruebas, rutaTrimestreDemo, asegurarFichaDemo, restablecer };
