// pruebas/recorrido_completo.test.js — Recorrido completo, encadenado, contra
// una ficha ficticia (documentos, nombres y horario inventados; ningún dato
// real). Corre con: npm test  (o: node --test pruebas/)
//
// Aislamiento: ACTAS_REGISTRO_RUTA (ver generar.js) se fija ANTES de tocar
// cualquier función, así que esta prueba nunca lee ni escribe el
// registro.json real del proyecto. Todo lo demás (control, reporte de SOFIA,
// documentos generados) vive en pruebas/tmp/, que se borra y se vuelve a
// crear al empezar, para que la prueba sea repetible.
//
// Qué cubre cada paso, y por qué: ver los comentarios en el cuerpo del test.
// Los pasos 3, 5 y 9 son los críticos según el encargo: el corte por fecha
// debe compararse por DÍA, no por marca de tiempo completa (las fechas que
// trae un .xlsx real arrastran segundos de desfase). Por eso las fechas de
// sesión de esta prueba llevan segundos distintos de cero a propósito: si
// alguien vuelve a comparar por marca de tiempo completa en vez de por día,
// esta prueba lo detecta.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const PizZip = require("pizzip");

const CARPETA = path.join(__dirname, "tmp", "recorrido");
process.env.ACTAS_REGISTRO_RUTA = path.join(CARPETA, "registro.json");

const { leerReporteSofia, poblarAprendices } = require("../sofia");
const { procesarControl, leerControl } = require("../procesar");
const { prepararActaEquipoEjecutor } = require("../equipo_ejecutor");
const { revertirFecha } = require("../revertir");
const { convertirPdf, wordInstalado } = require("../convertir_pdf");

const RUTA_PLANTILLA = path.join(__dirname, "..", "PLANTILLA_MAESTRA_CONTROL_ASISTENCIA V3.xlsx");
const RUTA_CONTROL = path.join(CARPETA, "CONTROL_ASISTENCIA_9000001.xlsx");
const RUTA_SOFIA = path.join(CARPETA, "REPORTE_SOFIA_9000001.xlsx");
const CARPETA_ACTAS = path.join(CARPETA, "LLAMADOS DE ATENCION");
const FICHA = 9000001;

// ===== Helpers de armado del control de prueba =====

// Día calendario LOCAL, no UTC (igual que iso()/fechaCorta() en el resto del
// proyecto). new Date().toISOString() da el día en UTC: pasadas las 19:00
// hora de Colombia (UTC-5), UTC ya está en el día siguiente, y revertirFecha
// -que sí compara por día local- no encontraría nada que revertir. Es la
// misma familia de bug que este proyecto entero se cuida de no reintroducir,
// esta vez en la prueba misma.
function hoyISOLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function leerRegistro() {
  try { return JSON.parse(fs.readFileSync(process.env.ACTAS_REGISTRO_RUTA, "utf8")); }
  catch { return { consecutivo: 0, aprendices: {} }; }
}

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

// fecha de sesión con segundos de desfase (ver cabecera del archivo): así se
// prueba el mismo terreno donde falló el sistema anterior.
function fechaSesion(mes, dia, segundos) { return new Date(2026, mes - 1, dia, 0, 0, segundos); }

const SESIONES = [
  { col: 3, fecha: fechaSesion(7, 1, 11) },  // D — llamado 1
  { col: 4, fecha: fechaSesion(7, 8, 23) },  // E — llamado 2
  { col: 5, fecha: fechaSesion(7, 15, 37) }, // F — plan de mejoramiento
  { col: 6, fecha: fechaSesion(7, 22, 49) }, // G — informe a comité
  { col: 7, fecha: fechaSesion(7, 29, 5) },  // H — ya en comité (sin documentos nuevos)
];

function marcarAsistencia(fila0based, col, valor) {
  actualizarHoja(RUTA_CONTROL, "ASISTENCIA", filas => { filas[fila0based][col] = valor; });
}

function crearReporteSofiaFicticio(ruta) {
  const filas = [
    ["Reporte de Aprendices"],
    ["Ficha de Caracterización:", null, `${FICHA} - TECNICO DE PRUEBA (FICTICIO)`],
    ["Estado:", null, "EN EJECUCION"],
    ["Fecha del Reporte:", null, new Date()],
    ["Tipo de Documento", "Número de Documento", "Nombre", "Apellidos", "Celular", "Correo Electrónico", "Estado"],
    // Estado "EN INDUCCIÓN" a propósito: ejercita la corrección a EN FORMACION.
    ["CC", "100000001", "JUAN CARLOS", "PEREZ GOMEZ", "3000000001", "juan.perez@ejemplo.test", "EN INDUCCIÓN"],
    ["CC", "100000002", "ANA MARIA", "RODRIGUEZ SIN NOVEDAD", "3000000002", "ana.rodriguez@ejemplo.test", "EN FORMACION"],
    ["CC", "100000003", "LUIS ALBERTO", "TORRES RETIRO", "3000000003", "luis.torres@ejemplo.test", "RETIRO VOLUNTARIO"],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filas), "Hoja");
  XLSX.writeFile(wb, ruta);
}

function textoDocx(ruta) {
  const xml = new PizZip(fs.readFileSync(ruta)).file("word/document.xml").asText();
  return xml.replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/\n{2,}/g, "\n").trim();
}

function archivoDeCaso(caso) { return path.join(CARPETA_ACTAS, caso.archivo); }

// ===== La prueba =====

test("recorrido completo, ficha ficticia 9000001", async t => {
  fs.rmSync(CARPETA, { recursive: true, force: true });
  fs.mkdirSync(CARPETA_ACTAS, { recursive: true });
  fs.copyFileSync(RUTA_PLANTILLA, RUTA_CONTROL);

  establecerParametros(RUTA_CONTROL, {
    "FICHA": FICHA,
    "PROGRAMA DE FORMACIÓN": "TECNICO DE PRUEBA (FICTICIO)",
    "COMPETENCIA": "COMPETENCIA DE PRUEBA",
    "CÓDIGO COMPETENCIA": "000000",
    "INSTRUCTOR": "INSTRUCTOR DE PRUEBA UNO",
    "DOCUMENTO INSTRUCTOR": 900000000,
    "CORREO INSTRUCTOR": "instructor.prueba@ejemplo.test",
    "COORDINADOR ACADÉMICO": "COORDINADOR DE PRUEBA",
    "NOTA MÍNIMA APROBACIÓN": 7,
    "RETARDOS PARA LLAMADO DE ATENCIÓN": 2,
    "PROCESAR EN AUTOMATIZACIÓN": "SI",
    "GENERAR ACTA DE ENTREGA": "NO",
  });

  // Encabezados de sesión en ASISTENCIA (con segundos de desfase) y datos:
  // fila 0 = encabezados, fila 1 = Juan Carlos, fila 2 = Ana, fila 3 = Luis
  // (mismo orden en el que quedarán en APRENDICES tras poblarAprendices).
  actualizarHoja(RUTA_CONTROL, "ASISTENCIA", filas => {
    for (const s of SESIONES) filas[0][s.col] = s.fecha;
    filas[1][SESIONES[0].col] = 0;                 // Juan Carlos: falta el 01/07
    for (const s of SESIONES) filas[2][s.col] = "X"; // Ana: siempre presente
    filas[3][SESIONES[0].col] = 0;                  // Luis: falta tambien, pero está excluido por estado
  });

  let reg;

  await t.test("1. migrar aprendices desde el reporte de SOFIA", () => {
    crearReporteSofiaFicticio(RUTA_SOFIA);
    const { ficha, aprendices, advertencias } = leerReporteSofia(RUTA_SOFIA);
    assert.equal(ficha, String(FICHA));
    assert.equal(aprendices.length, 3);
    assert.ok(advertencias.some(a => a.includes("EN FORMACION")), "debe avisar la correccion de EN INDUCCIÓN");

    const resultado = poblarAprendices(RUTA_CONTROL, aprendices, { simular: false });
    assert.equal(resultado.simulado, false);

    const { aprendices: leidos } = leerControl(RUTA_CONTROL);
    assert.equal(leidos.length, 3);
    assert.equal(leidos[0].nombre, "PEREZ GOMEZ JUAN CARLOS");
    assert.equal(leidos[0].estado, "EN FORMACION", "EN INDUCCIÓN debe haber quedado corregido a EN FORMACION");
    assert.equal(leidos[2].estado, "RETIRO VOLUNTARIO");
  });

  await t.test("2. generar primeros llamados", () => {
    const resumen = procesarControl(RUTA_CONTROL, false, false);
    assert.equal(resumen.errores.length, 0);
    assert.equal(resumen.casos.length, 1, "solo Juan Carlos tiene novedad");
    assert.equal(resumen.casos[0].aprendiz, "PEREZ GOMEZ JUAN CARLOS");
    assert.equal(resumen.casos[0].medida, "LLAMADO_1");
    assert.equal(resumen.sinNovedad, 1, "Ana no tiene novedad");
    assert.equal(resumen.omitidos.length, 1, "Luis se omite por no estar EN FORMACION");

    const texto = textoDocx(archivoDeCaso(resumen.casos[0]));
    assert.match(texto, /01\/07\/2026/);

    reg = leerRegistro();
    assert.equal(reg.consecutivo, 1);
    const clave = `${FICHA}-100000001`;
    assert.equal(reg.aprendices[clave].llamados, 1);
    assert.equal(reg.aprendices[clave].ultimaFechaIncidente, "2026-07-01");
  });

  await t.test("3. volver a ejecutar sin cambiar nada -> CERO actas (el punto donde fallaba el sistema anterior)", () => {
    // Simula que el .xlsx se volvió a guardar entre corridas y la fracción de
    // segundo de la misma fecha cambió (el escenario real del encargo: el
    // mismo día calendario, con un desfase de segundos distinto al de la
    // primera lectura). Si el corte comparara por marca de tiempo completa
    // en vez de por día, este cambio bastaría para que el 01/07 se reportara
    // de nuevo.
    actualizarHoja(RUTA_CONTROL, "ASISTENCIA", filas => { filas[0][SESIONES[0].col] = fechaSesion(7, 1, 59); });

    const resumen = procesarControl(RUTA_CONTROL, false, false);
    assert.equal(resumen.casos.length, 0, "el 01/07 ya se reportó: no debe repetirse aunque la fecha traiga segundos de desfase");
    assert.equal(resumen.sinNovedad, 2);

    const regAhora = leerRegistro();
    assert.equal(regAhora.consecutivo, 1, "no debió generarse ninguna acta nueva");
    assert.equal(regAhora.aprendices[`${FICHA}-100000001`].historial.length, 1);
  });

  await t.test("4. agregar una inasistencia nueva -> segundo llamado SOLO con ese hecho", () => {
    marcarAsistencia(1, SESIONES[1].col, 0); // Juan Carlos falta el 08/07
    const resumen = procesarControl(RUTA_CONTROL, false, false);
    assert.equal(resumen.casos.length, 1);
    assert.equal(resumen.casos[0].medida, "LLAMADO_2");
    assert.equal(resumen.casos[0].motivos, 1, "solo el hecho nuevo, no el del 01/07 otra vez");

    reg = leerRegistro();
    assert.equal(reg.consecutivo, 2);
    assert.equal(reg.aprendices[`${FICHA}-100000001`].historial.length, 2);
  });

  await t.test("5. el segundo llamado no repite ninguna fecha del primero", () => {
    const numero2 = reg.aprendices[`${FICHA}-100000001`].historial[1].archivo;
    const texto = textoDocx(path.join(CARPETA_ACTAS, numero2));
    assert.match(texto, /08\/07\/2026/);
    assert.doesNotMatch(texto, /01\/07\/2026/, "el llamado 2 no debe mencionar la fecha ya cubierta por el llamado 1");
  });

  await t.test("6. llevar al aprendiz hasta plan de mejoramiento y comité", () => {
    marcarAsistencia(1, SESIONES[2].col, 0); // 15/07
    let resumen = procesarControl(RUTA_CONTROL, false, false);
    assert.equal(resumen.casos[0].medida, "PLAN_MEJORAMIENTO");

    marcarAsistencia(1, SESIONES[3].col, 0); // 22/07
    resumen = procesarControl(RUTA_CONTROL, false, false);
    assert.equal(resumen.casos[0].medida, "INFORME_COMITE");

    marcarAsistencia(1, SESIONES[4].col, 0); // 29/07: ya no debería generar más documentos
    resumen = procesarControl(RUTA_CONTROL, false, false);
    assert.equal(resumen.casos[0].medida, "YA EN COMITÉ (sin documentos nuevos)");

    reg = leerRegistro();
    assert.equal(reg.consecutivo, 4, "el intento 'ya en comité' no generó documento ni consumió numero");
    assert.equal(reg.aprendices[`${FICHA}-100000001`].historial.length, 4);
  });

  let rutaActaEquipoEjecutor;

  await t.test("7. acta de equipo ejecutor: mi fila con mis novedades, las demás vacías", async () => {
    const horarioFicticio = {
      ficha: FICHA, programa: "TECNICO DE PRUEBA (FICTICIO)",
      trimestre: "1", fechaInicioTrimestre: "01/07/2026", fechaFinTrimestre: "30/09/2026",
      codigoPrograma: "000000", nivel: "TECNICO", errores: [],
      sesiones: [
        // nombre recortado a propósito, como lo entrega el horario real
        { competencia: "COMPETENCIA DE PRUEBA", instructor: "INSTRUCTOR DE PRUEBA", jefeGrupo: "JEFE DE PRUEBA", dia: "LUNES", horaInicio: "08:00", horaFin: "10:00", sede: "CBA PRUEBA", ambiente: "A1" },
        { competencia: "OTRA COMPETENCIA DE PRUEBA", instructor: "OTRO INSTRUCTOR DOS", jefeGrupo: "JEFE DE PRUEBA", dia: "MARTES", horaInicio: "08:00", horaFin: "10:00", sede: "CBA PRUEBA", ambiente: "A2" },
      ],
    };

    const previa = await prepararActaEquipoEjecutor({
      horario: horarioFicticio, rutaControlPropio: RUTA_CONTROL, carpetaSalida: CARPETA,
      horaInicio: "08:00", horaFin: "09:00", fecha: "1 de agosto de 2026",
    }); // simular=true por defecto
    assert.equal(previa.avisos.length, 0, "debe encontrar al instructor pese al nombre recortado");
    const miFila = previa.filas.find(f => f.instructor === "INSTRUCTOR DE PRUEBA UNO");
    assert.ok(miFila, "mi fila debe mostrar el nombre COMPLETO de PARAMETROS, no el recortado del horario");
    assert.match(miFila.novedades, /PEREZ GOMEZ JUAN CARLOS/);
    assert.doesNotMatch(miFila.novedades, /RODRIGUEZ SIN NOVEDAD/, "sin novedades, no debe aparecer");
    assert.doesNotMatch(miFila.novedades, /TORRES RETIRO/, "no está EN FORMACION, no debe aparecer");
    const otraFila = previa.filas.find(f => f.instructor === "OTRO INSTRUCTOR DOS");
    assert.equal(otraFila.novedades, "", "no hay acceso al control de otro instructor: su fila queda vacía");

    const real = await prepararActaEquipoEjecutor({
      horario: horarioFicticio, rutaControlPropio: RUTA_CONTROL, carpetaSalida: CARPETA,
      horaInicio: "08:00", horaFin: "09:00", fecha: "1 de agosto de 2026",
    }, { simular: false });
    rutaActaEquipoEjecutor = path.join(CARPETA, real.archivo);
    assert.ok(fs.existsSync(rutaActaEquipoEjecutor));
    const texto = textoDocx(rutaActaEquipoEjecutor);
    assert.doesNotMatch(texto, /\{[^}]+\}/, "no deben quedar marcadores sin reemplazar");
  });

  await t.test("8. revertir todo lo de esa fecha: registro y consecutivo como antes", () => {
    const hoyISO = hoyISOLocal();
    const antes = leerRegistro();

    const previa = revertirFecha(CARPETA, hoyISO); // simular=true por defecto
    assert.equal(previa.actasRevertidas.length, 4, "las 4 actas de Juan Carlos, generadas hoy");

    const resultado = revertirFecha(CARPETA, hoyISO, { simular: false });
    assert.equal(resultado.archivosBorrados.length, 4);

    const regDespues = leerRegistro();
    assert.equal(regDespues.aprendices[`${FICHA}-100000001`], undefined, "el aprendiz vuelve a quedar limpio");
    assert.equal(regDespues.consecutivo, 0, "solo quedaban las 4 actas de Juan Carlos (mas el equipo ejecutor, ver nota)");

    for (const h of antes.aprendices[`${FICHA}-100000001`].historial)
      assert.ok(!fs.existsSync(path.join(CARPETA_ACTAS, h.archivo)), `${h.archivo} debió borrarse`);

    // CONOCIDO (ver ARQUITECTURA.md, pendiente 5): revertirFecha no conoce
    // reg.equipoEjecutor. El acta de equipo ejecutor del paso 7 SOBREVIVE a
    // "revertir todo lo de esa fecha": el archivo sigue en disco y su número
    // no se cuenta al recalcular el consecutivo. Esta prueba deja eso
    // visible a propósito, en vez de esconderlo: el día que se resuelva,
    // esta aserción va a fallar y va a recordar actualizarla.
    assert.ok(fs.existsSync(rutaActaEquipoEjecutor), "gap conocido: el acta de equipo ejecutor no se revierte (todavía)");

    // Se corrige a mano la asistencia que causó la corrida (así es como se
    // usa REVERTIR en la vida real: se deshacen los documentos Y se corrige
    // el dato de origen que estaba mal, antes de volver a procesar).
    actualizarHoja(RUTA_CONTROL, "ASISTENCIA", filas => { for (const s of SESIONES) filas[1][s.col] = "X"; });
  });

  await t.test("9. volver a ejecutar tras la reversión (y la corrección) -> CERO", () => {
    const resumen = procesarControl(RUTA_CONTROL, false, false);
    assert.equal(resumen.casos.length, 0);
    assert.equal(resumen.errores.length, 0);
    const reg = leerRegistro();
    assert.equal(reg.consecutivo, 0, "no se generó ningún documento nuevo");
  });

  await t.test("10. convertir a PDF sin modificar los .docx", { skip: !wordInstalado() && "Word no está instalado en este equipo" }, () => {
    const antes = fs.readFileSync(rutaActaEquipoEjecutor);
    const resultado = convertirPdf(CARPETA, { simular: false });
    assert.ok(resultado.convertidos.includes(path.basename(rutaActaEquipoEjecutor)));
    assert.equal(resultado.errores.length, 0);

    const despues = fs.readFileSync(rutaActaEquipoEjecutor);
    assert.ok(antes.equals(despues), "el .docx no debe modificarse al convertir (se abre en solo lectura)");
    assert.ok(fs.existsSync(rutaActaEquipoEjecutor.replace(/\.docx$/, ".pdf")));
  });
});
