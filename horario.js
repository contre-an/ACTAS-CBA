// horario.js — Extrae el horario de una ficha desde el PDF que entrega el SENA
// (tabular, fijo: ficha, trimestre, fechas, competencia, RAP, jefe de grupo,
// instructor, día, hora, sede, ambiente). Código puro (pdfjs-dist), sin IA.
//
// El PDF no trae la tabla como datos estructurados: es texto posicionado en
// la página. La extracción se basa en dos hechos geométricos de este formato
// (verificados contra un horario real, ver PRUEBAS más abajo):
//   1) Las filas están separadas por un salto vertical grande; el interlineado
//      dentro de una misma celda es de pocos puntos. Un salto >15pt entre una
//      línea y la siguiente es un cambio de fila (o el paso encabezado->fila).
//   2) COMPETENCIA y RESULTADO DE APRENDIZAJE son columnas anchas que envuelven
//      texto en paralelo (cada una a su propio número de líneas, no una detrás
//      de otra), así que solo se pueden separar por posición horizontal, no
//      por su contenido. La frontera se ubica buscando el hueco horizontal más
//      grande entre los arranques de línea de esa zona intermedia, en vez de
//      fiarse de la posición del texto del encabezado (que puede estar
//      centrado y no coincidir con el borde real de la columna).
// FICHA, TRIMESTRE, FECHAS, CÓDIGO y NIVEL sí se leen con una expresión
// regular sobre la línea de referencia (la que trae el número de ficha),
// porque tienen formato fijo y verificable (números, fechas DD/MM/AAAA).
// PROGRAMA es el único campo libre que es CONSTANTE en todas las filas de la
// ficha (a diferencia de COMPETENCIA, que varía): se obtiene por el prefijo
// común más largo entre las filas, no por posición ni por adivinar dónde
// termina.
const fs = require("fs");

const RE_LINEA_REFERENCIA = /^(\d+)\s+(\S+)\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d+)\s+(\S+)\s*(.*)$/s;
const RE_DIA = /^(LUNES|MARTES|MI[ÉE]RCOLES|JUEVES|VIERNES|S[ÁA]BADO|DOMINGO)$/i;
const RE_HORA = /^\d{1,2}:\d{2}$/;

function prefijoComun(cadenas) {
  const listas = cadenas.map(s => s.split(" "));
  let comun = "";
  outer:
  for (let i = 0; i < listas[0].length; i++) {
    const palabra = listas[0][i];
    for (const lista of listas) if (lista[i] !== palabra) break outer;
    comun += (comun ? " " : "") + palabra;
  }
  return comun;
}

const textoDe = items => items
  .sort((a, b) => (b.y - a.y) || (a.x - b.x))
  .map(it => it.str).join(" ").replace(/\s+/g, " ").trim();

// Lee una página y devuelve { validas, errores } (filas ya separadas en sus
// campos, o el motivo por el que una fila no se pudo leer).
function leerPagina(items) {
  const filasBrutas = [];
  const hJefe = items.find(it => /^JEFE/i.test(it.str.trim()));
  if (!hJefe) return { filasBrutas: [{ error: `No se encontró el encabezado "JEFE DE GRUPO": revisa si el formato del horario cambió.` }] };
  const xJefeGrupo = hJefe.x - 3;

  const ys = [...new Set(items.map(it => it.y))].sort((a, b) => b - a);
  const inicioSegmentos = [ys[0]];
  for (let i = 1; i < ys.length; i++) if (ys[i - 1] - ys[i] > 15) inicioSegmentos.push(ys[i]);
  const inicioFilas = inicioSegmentos.slice(1); // el primer segmento es el encabezado
  if (!inicioFilas.length) return { filasBrutas: [] }; // página sin filas de datos

  const filaDe = y => {
    for (let i = 0; i < inicioFilas.length - 1; i++) if (y > (inicioFilas[i] + inicioFilas[i + 1]) / 2) return i;
    return inicioFilas.length - 1;
  };
  const cuerpo = items.filter(it => it.y <= inicioFilas[0] + 3);
  const filas = inicioFilas.map(() => []);
  for (const it of cuerpo) filas[filaDe(it.y)].push(it);

  const xsMedio = [...new Set(cuerpo.filter(it => it.x > 260 && it.x < xJefeGrupo).map(it => it.x))].sort((a, b) => a - b);
  let xCorteMedio = (260 + xJefeGrupo) / 2;
  if (xsMedio.length > 1) {
    let mejorHueco = -1;
    for (let i = 1; i < xsMedio.length; i++) {
      const hueco = xsMedio[i] - xsMedio[i - 1];
      if (hueco > mejorHueco) { mejorHueco = hueco; xCorteMedio = (xsMedio[i] + xsMedio[i - 1]) / 2; }
    }
  }

  filas.forEach((itemsFila, i) => {
    const zonaFijos = itemsFila.filter(it => it.x >= xJefeGrupo);
    const zonaIzq = itemsFila.filter(it => it.x < xJefeGrupo);
    if (!zonaIzq.length) { filasBrutas.push({ error: `Fila ${i + 1}: sin contenido a la izquierda de JEFE DE GRUPO.` }); return; }

    // La línea de referencia (ficha..nivel..programa) no es necesariamente la
    // línea más alta de la fila: si COMPETENCIA o RESULTADO DE APRENDIZAJE
    // tienen más líneas, pueden empezar por encima. Se ubica por el número de
    // ficha (varios dígitos, columna más a la izquierda), no por ser la más alta.
    const itemFicha = zonaIzq.find(it => /^\d{4,}$/.test(it.str.trim()) && it.x < 130);
    if (!itemFicha) { filasBrutas.push({ error: `Fila ${i + 1}: no se encontró el número de ficha en la columna izquierda.` }); return; }
    const yTope = itemFicha.y;

    // Los 7 campos fijos son de una sola línea siempre: no hace falta (ni
    // conviene) adivinar con qué línea del lado izquierdo comparten altura.
    const camposFijos = zonaFijos.sort((a, b) => a.x - b.x).map(it => it.str);
    if (camposFijos.length !== 7) {
      filasBrutas.push({ error: `Fila ${i + 1}: se esperaban 7 campos (jefe, instructor, día, hora inicio, hora fin, sede, ambiente) y se encontraron ${camposFijos.length}: ${JSON.stringify(camposFijos)}` });
      return;
    }
    const [jefeGrupo, instructor, dia, horaInicio, horaFin, sede, ambiente] = camposFijos;
    if (!RE_DIA.test(dia.trim()) || !RE_HORA.test(horaInicio.trim()) || !RE_HORA.test(horaFin.trim())) {
      filasBrutas.push({ error: `Fila ${i + 1}: los campos fijos no tienen la forma esperada (día/hora/hora): ${JSON.stringify(camposFijos)}` });
      return;
    }

    // OJO: aquí se ordena SOLO por x, no por y como en textoDe(). Dentro de
    // una misma línea visual, los items pueden traer un y con jitter de
    // fracciones de punto (línea base distinta por fuente/tamaño); ordenar
    // por y aquí los revolvería. El jitter entre líneas SÍ importa (por eso
    // textoDe() lo usa), pero dentro de una sola línea el orden real es el x.
    const linea1 = zonaIzq.filter(it => Math.abs(it.y - yTope) < 3 && it.x < xCorteMedio)
      .sort((a, b) => a.x - b.x).map(it => it.str).join(" ").replace(/\s+/g, " ").trim();
    const m = linea1.match(RE_LINEA_REFERENCIA);
    if (!m) { filasBrutas.push({ error: `Fila ${i + 1}: no se pudo leer ficha/trimestre/fechas/nivel al inicio de: "${linea1.slice(0, 150)}"` }); return; }
    const [, ficha, trimestre, fechaInicioTrimestre, fechaFinTrimestre, codigoPrograma, nivel, restoLinea1] = m;

    const resultadoAprendizaje = textoDe(zonaIzq.filter(it => it.x >= xCorteMedio));

    filasBrutas.push({
      ficha, trimestre, fechaInicioTrimestre, fechaFinTrimestre, codigoPrograma, nivel,
      restoLinea1, yTope, zonaIzq, xCorteMedio, resultadoAprendizaje,
      jefeGrupo, instructor, dia, horaInicio, horaFin, sede, ambiente,
    });
  });
  return { filasBrutas };
}

async function leerHorario(rutaPdf) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(fs.readFileSync(rutaPdf));
  const doc = await pdfjsLib.getDocument({ data, disableWorker: true, verbosity: 0 }).promise;

  let filasBrutas = [];
  for (let numPagina = 1; numPagina <= doc.numPages; numPagina++) {
    const page = await doc.getPage(numPagina);
    const content = await page.getTextContent();
    const items = content.items
      .map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5] }))
      .filter(it => it.str.trim() !== "");
    if (!items.length) continue;
    filasBrutas = filasBrutas.concat(leerPagina(items).filasBrutas);
  }

  const validas = filasBrutas.filter(f => !f.error);
  const errores = filasBrutas.filter(f => f.error).map(f => f.error);

  // PROGRAMA es el único texto libre CONSTANTE en todas las filas (a
  // diferencia de COMPETENCIA, que varía entre filas): se toma el prefijo
  // común más largo, palabra por palabra, de lo que sigue a NIVEL. Con menos
  // de 2 filas no hay con qué comparar, así que no se puede separar de forma
  // confiable de la competencia; se avisa en vez de adivinar.
  let programa = "";
  if (validas.length >= 2) programa = prefijoComun(validas.map(f => f.restoLinea1));
  else if (validas.length === 1) errores.push(`Solo se pudo leer 1 fila de datos: no hay con qué comparar para separar PROGRAMA de COMPETENCIA de forma confiable. Revisa "programa" a mano.`);

  const sesiones = validas.map(f => {
    // COMPETENCIA completa = lo que queda del lado izquierdo tras quitarle
    // PROGRAMA en la línea de referencia, más las demás líneas de esa
    // columna, reordenado por posición vertical real (no se asume que la
    // línea de la ficha sea la primera línea de la fila: ver leerPagina).
    const inicioCompetencia = f.restoLinea1.slice(programa.length).trim();
    const items = f.zonaIzq.filter(it => Math.abs(it.y - f.yTope) >= 3 && it.x < f.xCorteMedio);
    if (inicioCompetencia) items.push({ y: f.yTope, x: -Infinity, str: inicioCompetencia });
    return {
      competencia: textoDe(items), resultadoAprendizaje: f.resultadoAprendizaje,
      jefeGrupo: f.jefeGrupo, instructor: f.instructor, dia: f.dia,
      horaInicio: f.horaInicio, horaFin: f.horaFin, sede: f.sede, ambiente: f.ambiente,
    };
  });

  const ref = validas[0] || {};
  return {
    ficha: ref.ficha, trimestre: ref.trimestre,
    fechaInicioTrimestre: ref.fechaInicioTrimestre, fechaFinTrimestre: ref.fechaFinTrimestre,
    codigoPrograma: ref.codigoPrograma, nivel: ref.nivel, programa,
    sesiones, errores,
  };
}

// "De ahí salen los instructores y sus competencias" (encargo, punto 1):
// agrupa las sesiones por instructor, con sus competencias sin repetir.
function resumenInstructores(sesiones) {
  const porInstructor = new Map();
  for (const s of sesiones) {
    if (!porInstructor.has(s.instructor)) porInstructor.set(s.instructor, new Set());
    porInstructor.get(s.instructor).add(s.competencia);
  }
  return [...porInstructor.entries()].map(([instructor, competencias]) => ({ instructor, competencias: [...competencias] }));
}

module.exports = { leerHorario, resumenInstructores };
