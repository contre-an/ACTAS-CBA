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
const PizZip = require("pizzip");

const RAIZ = path.join(__dirname, "..", "..");
const requerir = nombre => require(path.join(RAIZ, nombre));
const { escribirParametros, resolverHojaEnZip, extraerCelda, celda } = requerir("procesar");
const { poblarAprendices } = requerir("sofia");
const RUTA_PLANTILLA_MAESTRA = path.join(RAIZ, "PLANTILLA_MAESTRA_CONTROL_ASISTENCIA V3.xlsx");
const NOMBRE_FICHA_DEMO = "0000000 - FICHA DE DEMOSTRACIÓN (MODO PRUEBA)";

const rutaBase = () => path.join(app.getPath("userData"), "modo_prueba");
const rutaRegistroPruebas = () => path.join(rutaBase(), "registro.pruebas.json");
const rutaTrimestreDemo = () => path.join(rutaBase(), "trimestre_demo");
const rutaFichaDemo = () => path.join(rutaTrimestreDemo(), NOMBRE_FICHA_DEMO);
const rutaControlDemo = () => path.join(rutaFichaDemo(), "CONTROL_ASISTENCIA_DEMO.xlsx");

// Serial de Excel para una fecha: inversa EXACTA de aFecha() (procesar.js,
// rama numérica: `new Date(Math.round((v - 25569) * 86400 * 1000))`), para
// que la fecha de sesión de la ficha demo se lea de vuelta como el mismo
// día, sin depender de cómo una librería de alto nivel decida convertirla.
const fechaASerial = d => d.getTime() / 86400000 + 25569;

// Reemplaza, en la hoja `nombreHoja`, celdas puntuales por referencia EXACTA
// ("D1") — conservando el estilo (s=) que ya tenía cada una, sin tocar el
// resto del libro. Mismo patrón que escribirParametros (procesar.js), pero
// por referencia en vez de por etiqueta de columna A: la ficha de
// demostración no depende de texto que haya escrito nadie, así que no hace
// falta buscar por etiqueta.
function escribirCeldasEnHoja(rutaControl, nombreHoja, celdasPorRef) {
  const zip = new PizZip(fs.readFileSync(rutaControl));
  const hoja = resolverHojaEnZip(zip, nombreHoja);
  if (!hoja) return;
  let xml = hoja.xml;
  for (const [ref, { valor, tipo }] of Object.entries(celdasPorRef)) {
    const celdaVieja = extraerCelda(xml, ref);
    if (!celdaVieja) continue; // celda que no está en la plantilla: no se inventa
    const estilo = celdaVieja.match(/\ss="(\d+)"/)?.[1] ?? null;
    xml = xml.replace(celdaVieja, celda(ref.match(/^[A-Z]+/)[0], ref.match(/\d+$/)[0], estilo, valor, tipo));
  }
  zip.file(hoja.target, xml);
  fs.writeFileSync(rutaControl, zip.generate({ type: "nodebuffer", compression: "DEFLATE" }));
}

// Arma la ficha ficticia de demostración desde cero: plantilla en blanco +
// PARAMETROS de mentira + dos aprendices de mentira, uno con una
// inasistencia ya lista para que "Generar actas" tenga algo que mostrar sin
// pasos previos (útil para demostrar la app en el computador de un
// compañero sin tener que preparar nada a mano primero).
//
// Todo por cirugía de XML (escribirParametros/poblarAprendices/
// escribirCeldasEnHoja), NO con XLSX.readFile/writeFile sobre el libro
// completo: mismo motivo que "Nueva ficha" en ipc.js (ver ARQUITECTURA.md,
// pendiente 11) — aunque esta ficha sea de mentira, no hay razón para que
// pierda las listas desplegables y el formato condicional que sí demuestra
// tener la plantilla real.
function crearFichaDemo() {
  fs.mkdirSync(rutaFichaDemo(), { recursive: true });
  fs.copyFileSync(RUTA_PLANTILLA_MAESTRA, rutaControlDemo());

  escribirParametros(rutaControlDemo(), {
    "FICHA": "0000000", // string, no numero: 0 es falsy y dispara "PARAMETROS incompletos" en leerControl
    "PROGRAMA DE FORMACIÓN": "PROGRAMA DE DEMOSTRACIÓN",
    "COMPETENCIA": "COMPETENCIA DE DEMOSTRACIÓN",
    "INSTRUCTOR": "INSTRUCTOR DE DEMOSTRACIÓN",
    "DOCUMENTO INSTRUCTOR": "0",
    "CORREO INSTRUCTOR": "demo@ejemplo.test",
    "PROCESAR EN AUTOMATIZACIÓN": "SI",
    "GENERAR ACTA DE ENTREGA": "SI",
  });

  escribirCeldasEnHoja(rutaControlDemo(), "ASISTENCIA", {
    D1: { valor: fechaASerial(new Date()), tipo: "n" }, // una sesión, hoy
    D2: { valor: 0, tipo: "n" },                        // aprendiz uno: inasistencia, lista para demostrar
    D3: { valor: "X", tipo: "texto" },                  // aprendiz dos: presente
  });

  // poblarAprendices ya es seguro (cirugía de XML, ver sofia.js) — se
  // reusa en vez de reinventar la escritura de APRENDICES una tercera vez.
  // Nota: el aprendiz dos pierde el detalle "evaluado en SOFIA = SI" que
  // tenía la versión anterior de esta demo (poblarAprendices no distingue
  // esa columna) — cosmético, no afecta lo que la demo demuestra.
  poblarAprendices(rutaControlDemo(), [
    { documento: "1000000001", nombreCompleto: "APRENDIZ DE DEMOSTRACIÓN UNO", correo: "demo1@ejemplo.test", estado: "EN FORMACION" },
    { documento: "1000000002", nombreCompleto: "APRENDIZ DE DEMOSTRACIÓN DOS", correo: "demo2@ejemplo.test", estado: "EN FORMACION" },
  ], { simular: false });
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
