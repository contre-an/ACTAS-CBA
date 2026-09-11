// procesar.js — Lee controles de asistencia, aplica reglas (Acuerdo 009) y genera actas por periodo
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const PizZip = require("pizzip");
const { generarActa, generarActaEntrega, cargarRegistro, guardarRegistro, resumenMotivos } = require("./generar");

const fechaHoy = () => { const d = new Date(); return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`; };
const norm = s => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toUpperCase();
// La plantilla deja el campo as\u00ed (p.ej. "(N\u00daMERO DE FICHA)") cuando el
// instructor todav\u00eda no lo llen\u00f3: es un valor truthy, as\u00ed que un chequeo de
// "no vac\u00edo" no lo detecta. Ver PLANTILLA_MAESTRA_CONTROL_ASISTENCIA V3.xlsx.
const esPlaceholder = v => /^\(.*\)$/.test(String(v ?? "").trim());

// Campos que el instructor puede dejar sin llenar y el acta sale igual
// (incompleta en esos datos, pero generable): a diferencia de FICHA,
// PROGRAMA, COMPETENCIA e INSTRUCTOR (ver camposObligatorios en
// leerControl), estos no bloquean la generaci\u00f3n, solo se avisan. Vac\u00edo O
// con el texto de ejemplo de la plantilla (ver esPlaceholder) cuentan igual
// como "sin llenar". Se avisa en la vista previa (y tambi\u00e9n en la
// generaci\u00f3n real, por si se salt\u00f3 la vista previa).
function avisosConfiguracion(params) {
  const avisos = [];
  const faltante = v => !v || esPlaceholder(v);
  if (faltante(params.regional)) avisos.push("Falta REGIONAL en PARAMETROS: el acta saldr\u00e1 incompleta.");
  if (faltante(params.centro)) avisos.push("Falta CENTRO en PARAMETROS: el acta saldr\u00e1 incompleta.");
  if (faltante(params.instructor.documento)) avisos.push("Falta el documento del instructor en PARAMETROS: el acta saldr\u00e1 incompleta.");
  if (faltante(params.instructor.correo)) avisos.push("Falta el correo del instructor en PARAMETROS: el acta saldr\u00e1 incompleta.");
  return avisos;
}

// ===== ESTADOS DEL APRENDIZ (Acuerdo 009 de 2024) =====
// SOLO "EN FORMACION" recibe llamados de atencion. Los demas estados quedan
// excluidos: el aprendiz ya no esta en formacion activa (CANCELADO, RETIRO
// VOLUNTARIO, TRASLADADO, APLAZADO) o su caso esta en otra instancia
// (CONDICIONADO, REPORTADO A COMITE, EN PROCESO DE DESERCION).
// "ACTIVO" se acepta solo por compatibilidad con controles antiguos.
const ESTADO_ACTIVO = "EN FORMACION";
const ESTADOS_CON_LLAMADO = [ESTADO_ACTIVO, "ACTIVO"];
const recibeLlamado = e => ESTADOS_CON_LLAMADO.includes(norm(e));

function aFecha(v) { // header de sesion -> Date
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(Math.round((v - 25569) * 86400 * 1000)); // serial Excel
  if (typeof v === "string" && /^\d{2}\/\d{2}\/\d{4}$/.test(v.trim())) {
    const [d, m, a] = v.trim().split("/").map(Number); return new Date(a, m - 1, d);
  }
  return null;
}
const fmt = d => `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
// iso y fmt deben usar la MISMA referencia horaria (local); si una usa UTC y la
// otra local, el día puede diferir y el corte queda desfasado.
const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

function leerControl(ruta) {
  let wb;
  try { wb = XLSX.readFile(ruta, { cellDates: true }); }
  catch (e) { throw new Error(`No se pudo abrir "${path.basename(ruta)}": ${e.message}. Si tienes el archivo abierto en Excel, ciérralo y vuelve a generar.`); }
  const hoja = n => {
    const real = wb.SheetNames.find(s => norm(s) === n);
    if (!real) throw new Error(`El archivo no tiene la hoja ${n}: ${path.basename(ruta)}`);
    return XLSX.utils.sheet_to_json(wb.Sheets[real], { header: 1, defval: null });
  };
  // Como hoja(), pero sin lanzar error si la hoja no existe (para hojas opcionales).
  const hojaOpcional = n => {
    const real = wb.SheetNames.find(s => norm(s) === n);
    return real ? XLSX.utils.sheet_to_json(wb.Sheets[real], { header: 1, defval: null }) : null;
  };
  // PARAMETROS (clave/valor)
  const P = {};
  for (const fila of hoja("PARAMETROS")) if (fila[0] != null && fila[1] != null) P[norm(fila[0])] = fila[1];
  const params = {
    ficha: P["FICHA"], programa: P["PROGRAMA DE FORMACION"], competencia: P["COMPETENCIA"],
    regional: P["REGIONAL"], centro: P["CENTRO"], jornada: P["JORNADA"], lugar: P["LUGAR"],
    instructor: { nombre: P["INSTRUCTOR"], documento: P["DOCUMENTO INSTRUCTOR"], correo: P["CORREO INSTRUCTOR"] },
    notaMin: Number(P["NOTA MINIMA APROBACION"]) || 7,
    retardosPara: Number(P["RETARDOS PARA LLAMADO DE ATENCION"]) || 2,
    procesar: norm(P["PROCESAR EN AUTOMATIZACION"] || "NO") === "SI",
    generarEntrega: norm(P["GENERAR ACTA DE ENTREGA"] || "NO") === "SI",
    coordinador: P["COORDINADOR ACADEMICO"] || "",
    codigoCompetencia: P["CODIGO COMPETENCIA"] || "",
  };
  // Estos cuatro van impresos en el acta o determinan su identidad (número
  // de ficha, título, competencia, quién firma como instructor): si alguno
  // quedó vacío o con el texto de ejemplo de la plantilla (ver
  // esPlaceholder), NO se genera nada — a diferencia de REGIONAL, CENTRO,
  // documento y correo del instructor (avisosConfiguracion), que solo
  // avisan. El mensaje aclara a propósito que es un control sin terminar
  // de configurar, no un archivo dañado: este error también aparece en el
  // panel de estado de la ficha (ficha:estado en ipc.js), donde una ficha
  // todavía en montaje no debe leerse como si tuviera un problema real.
  const camposObligatorios = [
    ["FICHA", params.ficha], ["PROGRAMA DE FORMACIÓN", params.programa],
    ["COMPETENCIA", params.competencia], ["INSTRUCTOR", params.instructor.nombre],
  ];
  const sinLlenar = camposObligatorios.filter(([, v]) => !v || esPlaceholder(v)).map(([campo]) => campo);
  if (sinLlenar.length) throw new Error(
    `Control sin terminar de configurar (${path.basename(ruta)}) — no es un archivo dañado: falta completar en PARAMETROS ${sinLlenar.join(", ")}.`
  );
  if (!/^\d+$/.test(String(params.ficha).trim())) throw new Error(
    `Control sin terminar de configurar (${path.basename(ruta)}) — no es un archivo dañado: FICHA debe ser solo números en PARAMETROS (se encontró "${params.ficha}").`
  );

  const apr = hoja("APRENDICES"), asi = hoja("ASISTENCIA"), not_ = hoja("NOTAS");
  const sesiones = [];
  for (let c = 3; c < 23; c++) { // columnas D..W
    const f = aFecha(asi[0]?.[c]);
    sesiones.push({ col: c, fecha: f, trabajo: not_[0]?.[c] != null ? String(not_[0][c]).trim() : null });
  }
  const aprendices = [];
  for (let r = 1; r < apr.length; r++) {
    const nombre = apr[r]?.[2] != null ? String(apr[r][2]).trim() : "";
    if (!nombre) continue;
    aprendices.push({
      fila: r, documento: apr[r][1] ?? "POR REGISTRAR", nombre,
      correo: apr[r][3] ?? "POR REGISTRAR", estado: norm(apr[r][4] ?? ESTADO_ACTIVO),
      evaluado: norm(apr[r][5] ?? "") === "SI", novedadManual: apr[r][6] != null ? String(apr[r][6]).trim() : "",
      att: sesiones.map(s => asi[r]?.[s.col] ?? null),
      notas: sesiones.map(s => not_[r]?.[s.col] ?? null),
    });
  }

  // ===== DESCRIPCIONES: texto que el instructor escribe para cada actividad =====
  // Hoja opcional de dos columnas (actividad, descripción). La columna
  // "actividad" debe coincidir con el nombre que ya aparece en el encabezado
  // de la hoja NOTAS; el instructor solo redacta el texto. Reemplaza el
  // resumen que antes generaba la IA a partir del PDF de la actividad, para
  // el numeral 1.1 del acta. Si la hoja no existe, el acta sale sin ese
  // numeral, igual que siempre.
  const descripciones = {};
  const desc = hojaOpcional("DESCRIPCIONES");
  if (desc) {
    for (let r = 1; r < desc.length; r++) {
      const actividad = desc[r]?.[0], texto = desc[r]?.[1];
      if (actividad != null && texto != null && String(texto).trim())
        descripciones[norm(actividad)] = String(texto).trim();
    }
  }

  return { params, sesiones, aprendices, descripciones };
}

// Reglas por sesion -> incidentes y retardos (con fecha Date)
// La asistencia y la evidencia se evaluan por SEPARADO en la misma sesion:
// faltar a clase NO exime de presentar la actividad, de modo que una sesion
// puede generar dos incidentes (inasistencia + evidencia pendiente).
function evaluarAprendiz(a, sesiones, notaMin) {
  const incidentes = [], retardos = [];
  sesiones.forEach((s, j) => {
    if (!s.fecha) return;
    const att = a.att[j], nota = a.notas[j];
    const m = typeof att === "string" ? norm(att) : att;

    // 1) ASISTENCIA
    if (m === "R") retardos.push(s.fecha);
    if (m === 0 || m === "0")
      incidentes.push({ fechaD: s.fecha, fecha: fmt(s.fecha), tipo: "INASISTENCIA" });

    // 2) EVIDENCIA: solo si el encabezado de NOTAS declara actividad para esa sesion
    if (!s.trabajo) return;
    if (nota === null || nota === "" || nota === undefined) {
      incidentes.push({ fechaD: s.fecha, fecha: fmt(s.fecha), tipo: "NO_PRESENTO", actividad: s.trabajo });
      return;
    }
    const n = Number(nota);
    if (!isNaN(n) && n < notaMin)
      incidentes.push({ fechaD: s.fecha, fecha: fmt(s.fecha), tipo: n >= 1 ? "NOTA_BAJA" : "NO_PRESENTO", actividad: s.trabajo, nota: n });
  });
  return { incidentes, retardos };
}


const ETIQUETA = { LLAMADO_1: "PRIMER LLAMADO DE ATENCIÓN", LLAMADO_2: "SEGUNDO LLAMADO DE ATENCIÓN",
  PLAN_MEJORAMIENTO: "PLAN DE MEJORAMIENTO", INFORME_COMITE: "INFORME A COMITÉ DE EVALUACIÓN Y SEGUIMIENTO" };

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Ubica una hoja por NOMBRE dentro del .xlsx (zip) sin pasar por ninguna
// librería de alto nivel: busca su r:id en workbook.xml, lo resuelve en
// _rels/workbook.xml.rels, y devuelve el XML crudo de esa hoja. Extraída de
// registrarEnHistorico (antes solo buscaba "HISTORICO") para reusarla desde
// cualquier sitio que necesite editar una hoja puntual por cirugía de XML
// sin arriesgar el resto del libro (ver establecerParametrosInstructor en
// ipc.js, y localizarHoja en sofia.js, que hacía esto mismo por su cuenta).
// null si la hoja no existe o el libro no tiene la forma esperada.
function resolverHojaEnZip(zip, nombreHoja) {
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
  const archivoHoja = zip.file(target);
  if (!archivoHoja) return null;
  return { target, xml: archivoHoja.asText() };
}

// Lee xl/sharedStrings.xml (si existe) a un array de textos: cada <si> en
// el orden en que aparece ES su índice (así referencian las celdas t="s").
// Un <si> puede ser texto simple (<si><t>texto</t></si>) o texto enriquecido
// repartido en varios "runs" (<si><r><t>a</t></r><r><t>b</t></r></si>); en
// ambos casos se concatenan todos los <t> de ese <si>. Se usa para LEER una
// etiqueta de columna A por su texto (igual que ya hace leerControl al
// armar PARAMETROS por clave/valor, no por posición) sin tener que abrir el
// libro con una librería de alto nivel. Nunca se ESCRIBE en esta tabla —
// ver la nota de cadenas compartidas en establecerParametrosInstructor
// (ipc.js): editar una entrada existente arriesga cambiar otra celda que
// comparta el mismo índice.
function leerCadenasCompartidas(zip) {
  const archivo = zip.file("xl/sharedStrings.xml");
  if (!archivo) return [];
  const xml = archivo.asText();
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join("")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&")
  );
}

// Extrae el <c>...</c> (o <c .../>) cuya referencia (r=) matchee
// `refPattern` dentro de `xml` — una referencia exacta ("D1", para buscar
// en una hoja completa) o un patrón de columna ("A\\d+", para buscar dentro
// del XML de UNA fila ya recortada, sin importar el número de esa fila).
// Cuantificador NO codicioso (`[^>]*?`) antes de decidir entre autocierre y
// apertura+cierre: con uno codicioso, `s="3"/` se traga la barra del
// autocierre antes de llegar a evaluar la alternativa, y el regex sigue de
// largo hasta el próximo `</c>` de la celda equivocada.
function extraerCelda(xml, refPattern) {
  return xml.match(new RegExp(`<c r="${refPattern}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`))?.[0] ?? null;
}

// Estilo (s="N") de la celda de esa columna en una fila de datos ya
// existente — para que una fila NUEVA (poblarAprendices, sofia.js) herede
// el mismo formato que ya traía la plantilla, en vez de salir sin estilo.
function estiloDeColumna(filaXml, col) {
  return extraerCelda(filaXml, `${col}\\d+`)?.match(/\ss="(\d+)"/)?.[1] ?? null;
}

// Texto visible de una celda cruda: resuelve cadenas compartidas (t="s")
// contra `cadenas` (ver leerCadenasCompartidas), lee el texto inline
// (t="inlineStr") directamente, o el valor crudo (sin tipo -> numérico en
// OOXML) si no es ninguno de los dos. Para LEER una etiqueta de columna A
// por su texto, igual que leerControl arma PARAMETROS por clave/valor.
function textoDeCelda(celdaXml, cadenas) {
  if (!celdaXml) return null;
  const tipo = celdaXml.match(/\st="([^"]+)"/)?.[1];
  if (tipo === "s") { const idx = celdaXml.match(/<v>(\d+)<\/v>/)?.[1]; return idx != null ? cadenas[Number(idx)] ?? null : null; }
  if (tipo === "inlineStr") return celdaXml.match(/<is><t[^>]*>([\s\S]*?)<\/t><\/is>/)?.[1] ?? null;
  return celdaXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? null;
}

// Celda nueva (t="inlineStr" para texto, numérica para "n"), con el mismo
// `r`/`s` (referencia/estilo) que ya tenía la celda que reemplaza — así la
// celda mantiene su formato aunque cambie el contenido. `estilo` puede ser
// null (celda sin estilo propio en la plantilla). Mismo patrón que ya usan
// registrarEnHistorico (arriba) y poblarAprendices (sofia.js).
function celda(col, r, estilo, valor, tipo) {
  const sAttr = estilo != null ? ` s="${estilo}"` : "";
  if (valor == null || valor === "") return `<c r="${col}${r}"${sAttr}/>`;
  if (tipo === "n") return `<c r="${col}${r}"${sAttr}><v>${valor}</v></c>`;
  return `<c r="${col}${r}"${sAttr} t="inlineStr"><is><t>${xmlEscape(valor)}</t></is></c>`;
}

// Escribe pares etiqueta->valor en la hoja PARAMETROS (clave en columna A,
// valor en columna B) editando SOLO esas celdas por cirugía de XML — NO con
// XLSX.readFile/writeFile: la edición community de la librería xlsx no
// conserva estilos, validaciones de datos (las listas desplegables de
// APRENDICES) ni formato condicional al reescribir el libro completo. Usada
// por "Nueva ficha" (establecerParametrosInstructor, ipc.js — regresión
// confirmada del commit cecd7e5, ver ARQUITECTURA.md pendiente 11) y por la
// ficha de demostración del modo prueba (crearFichaDemo, modoPrueba.js).
//
// Las etiquetas se leen por TEXTO de columna A (igual que leerControl arma
// PARAMETROS por clave/valor, no por posición): si la plantilla no trae
// alguna de las claves pedidas, esa celda puntual no se toca — nunca lanza
// ni aborta por una etiqueta que no aparece.
//
// Cuidado con las cadenas compartidas: varias celdas de PARAMETROS son
// t="s" (cadena compartida — <v> apunta a un ÍNDICE de
// xl/sharedStrings.xml, una tabla DEDUPLICADA). Escribir el valor nuevo
// directo en ese <v> apuntaría el índice viejo a un texto que ya no es el
// que esa celda muestra, y si otra celda del libro comparte el mismo
// índice (coincidencia de texto), también cambiaría SU contenido sin
// tocarla. Por eso cada celda tocada se reemplaza ENTERA por una
// t="inlineStr" (o numérica): nunca se toca sharedStrings.xml, así que no
// hay índice compartido que arriesgar.
function escribirParametros(rutaControl, valores) {
  const zip = new PizZip(fs.readFileSync(rutaControl));
  const hoja = resolverHojaEnZip(zip, "PARAMETROS");
  if (!hoja) return false; // plantilla sin la hoja esperada: no se toca nada
  const cadenas = leerCadenasCompartidas(zip);

  const xml = hoja.xml.replace(/<row[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>/g, filaXml => {
    const etiqueta = String(textoDeCelda(extraerCelda(filaXml, "A\\d+"), cadenas) ?? "").trim().toUpperCase();
    if (!(etiqueta in valores)) return filaXml;

    const r = filaXml.match(/\br="(\d+)"/)[1];
    const celdaB = extraerCelda(filaXml, "B\\d+");
    const estilo = celdaB?.match(/\ss="(\d+)"/)?.[1] ?? null;
    const valor = String(valores[etiqueta] ?? "");
    const nuevaCeldaB = celda("B", r, estilo, valor, /^\d+$/.test(valor) ? "n" : "texto");
    return celdaB ? filaXml.replace(celdaB, nuevaCeldaB) : filaXml.replace(/<\/row>$/, `${nuevaCeldaB}</row>`);
  });

  zip.file(hoja.target, xml);
  fs.writeFileSync(rutaControl, zip.generate({ type: "nodebuffer", compression: "DEFLATE" }));
  return true;
}

// Escribe la fila en HISTORICO editando SOLO el XML de esa hoja dentro del .xlsx:
// el resto del archivo (colores, anchos, formulas, celdas) queda byte a byte identico.
function registrarEnHistorico(ruta, fila) {
  const zip = new PizZip(fs.readFileSync(ruta));
  const hoja = resolverHojaEnZip(zip, "HISTORICO");
  if (!hoja) return false;
  const { target } = hoja;
  let xml = hoja.xml;

  // anti-duplicado: numero de acta ya inyectado por nosotros
  const acta = xmlEscape(String(fila[5]));
  if (xml.includes(`<is><t>${acta}</t></is>`)) return true;

  let maxRow = 1;
  for (const r of xml.matchAll(/<row[^>]*\br="(\d+)"/g)) maxRow = Math.max(maxRow, parseInt(r[1]));
  const n = maxRow + 1;
  const cols = ["A", "B", "C", "D", "E", "F"];
  const celdas = fila.map((v, i) =>
    `<c r="${cols[i]}${n}" t="inlineStr"><is><t>${xmlEscape(v)}</t></is></c>`).join("");
  const filaXml = `<row r="${n}">${celdas}</row>`;

  if (xml.includes("</sheetData>")) xml = xml.replace("</sheetData>", filaXml + "</sheetData>");
  else if (xml.includes("<sheetData/>")) xml = xml.replace("<sheetData/>", "<sheetData>" + filaXml + "</sheetData>");
  else return false;

  zip.file(target, xml);
  fs.writeFileSync(ruta, zip.generate({ type: "nodebuffer", compression: "DEFLATE" }));
  return true;
}

// simular = true -> evalua TODO igual pero NO genera archivos, NO toca el
// registro y NO escribe en el HISTORICO. Sirve para la vista previa.
function procesarControl(ruta, forzar = false, simular = false) {
  const { params, sesiones, aprendices, descripciones } = leerControl(ruta);
  if (!params.procesar && !forzar) {
    return { archivo: path.basename(ruta), ficha: params.ficha, programa: params.programa,
             omitida: true, mensaje: "OMITIDA (PROCESAR EN AUTOMATIZACIÓN = NO o ausente en PARAMETROS)" };
  }
  const carpetaActas = path.join(path.dirname(ruta), "LLAMADOS DE ATENCION");
  const resumen = { archivo: path.basename(ruta), ficha: params.ficha, programa: params.programa,
                    casos: [], sinNovedad: 0, omitidos: [], errores: [], avisos: avisosConfiguracion(params) };

  for (const a of aprendices) {
    // Filtro por estado: solo EN FORMACION recibe llamados de atencion.
    // Se reporta cada omision para que quede visible en el resumen (y en n8n).
    if (!recibeLlamado(a.estado)) {
      resumen.omitidos.push({ aprendiz: a.nombre, documento: a.documento, estado: a.estado });
      continue;
    }
    try {
      const reg = cargarRegistro();
      const clave = `${params.ficha}-${a.documento}`;
      const estado = reg.aprendices[clave] || {};
      // Corte por DÍA, no por marca de tiempo: las fechas que devuelve Excel
      // traen segundos de desfase (05:00:16Z en vez de 05:00:00Z) y comparar
      // marcas completas dejaba pasar de nuevo el último día ya reportado.
      const corte = estado.ultimaFechaIncidente || null;   // "AAAA-MM-DD"

      let { incidentes, retardos } = evaluarAprendiz(a, sesiones, params.notaMin);
      if (corte) { // solo lo NUEVO: estrictamente posterior al último día reportado
        incidentes = incidentes.filter(i => iso(i.fechaD) > corte);
        retardos = retardos.filter(f => iso(f) > corte);
      }
      // retardos pendientes de periodos anteriores (impares sin consumir)
      const pendientes = (estado.retardosPendientes || []).map(s => new Date(s + "T00:00:00"));
      const todosRet = [...pendientes, ...retardos].sort((x, y) => x - y);
      const pares = Math.floor(todosRet.length / params.retardosPara);
      for (let p = 0; p < pares; p++) {
        const grupo = todosRet.slice(p * params.retardosPara, (p + 1) * params.retardosPara);
        incidentes.push({ fechaD: grupo[grupo.length - 1], fecha: fmt(grupo[grupo.length - 1]), tipo: "RETARDOS", fechas: grupo.map(fmt) });
      }
      const sobrantes = todosRet.slice(pares * params.retardosPara);

      if (!incidentes.length) { resumen.sinNovedad++; continue; }
      incidentes.sort((x, y) => x.fechaD - y.fechaD);

      // Actividades pendientes que este acta va a mencionar, y cuáles de esas
      // NO tienen descripción escrita en la hoja DESCRIPCIONES. Se calcula
      // ANTES de la vista previa a propósito: el instructor tiene que
      // enterarse de esto antes de aprobar y firmar, no después.
      const actividadesPendientes = [...new Set(incidentes.filter(i => i.actividad).map(i => i.actividad))];
      const avisos = actividadesPendientes
        .filter(act => !descripciones[norm(act)])
        .map(act => `Actividad "${act}" no tiene descripción; el acta saldrá sin ella.`);

      // VISTA PREVIA: se informa lo que se haria, sin generar ni registrar nada
      if (simular) {
        const ap = estado.llamados || 0, pl = estado.planes || 0;
        const tipoPrevisto = ap === 0 ? "LLAMADO_1" : ap === 1 ? "LLAMADO_2"
          : pl === 0 ? "PLAN_MEJORAMIENTO" : !estado.comite ? "INFORME_COMITE" : "EN_COMITE";
        resumen.casos.push({ aprendiz: a.nombre, documento: a.documento,
          medida: tipoPrevisto, motivos: incidentes.length,
          detalle: incidentes.map(i => i.tipo === "RETARDOS"
            ? `${i.fecha}: 2 retardos` : `${i.fecha}: ${i.tipo}${i.actividad ? " (" + i.actividad + ")" : ""}`),
          ...(avisos.length ? { avisos } : {}) });
        continue;
      }

      // Descripción de las evidencias pendientes (numeral 1.1 del acta), tomada
      // de la hoja DESCRIPCIONES que redacta el instructor (ver leerControl).
      // Si una actividad no tiene descripción escrita, simplemente no aparece:
      // el acta sale igual, sin ese renglón (y ya quedó avisado arriba).
      const descripcion_actividades = actividadesPendientes
        .filter(act => descripciones[norm(act)])
        .map(act => `${act}: ${descripciones[norm(act)]}`);

      const { buffer, tipo, numero } = generarActa({
        ficha: params.ficha, programa: params.programa, competencia: params.competencia,
        regional: params.regional, centro: params.centro, lugar: params.lugar,
        ciudad: "Mosquera, Cundinamarca", instructor: params.instructor,
        aprendiz: { nombre: a.nombre, documento: a.documento, correo: a.correo },
        incidentes, descripcion_actividades,
      });
      fs.mkdirSync(carpetaActas, { recursive: true });
      const prefijo = tipo === "INFORME_COMITE" ? "INFORME_COMITE" : "ACTA";
      const nombreArchivo = `${prefijo}_${numero}_${tipo}_${String(a.documento).replace(/\W+/g, "_")}_${a.nombre.replace(/[^A-Za-z0-9ÁÉÍÓÚÑáéíóúñ]+/g, "_")}.docx`;
      fs.writeFileSync(path.join(carpetaActas, nombreArchivo), buffer);

      // Registrar en HISTORICO (no rompe si el Excel esta abierto: se reporta)
      let histOk = true;
      try {
        registrarEnHistorico(ruta, [fechaHoy(), String(a.documento), a.nombre, ETIQUETA[tipo] || tipo, resumenMotivos(incidentes), numero]);
      } catch (e) { histOk = false; }

      // actualizar periodo y retardos sobrantes
      const reg2 = cargarRegistro();
      const ap2 = reg2.aprendices[clave];
      // Se guarda también el "antes" (corte y retardos previos a esta corrida) y
      // el nombre del archivo generado, en el último renglón del historial que
      // acaba de escribir generarActa: es lo que necesita la herramienta de
      // reversión para deshacer esta acta sin adivinar nada.
      const ultimo = ap2.historial[ap2.historial.length - 1];
      ultimo.archivo = nombreArchivo;
      ultimo.fechaCorteAntes = corte;
      ultimo.retardosPendientesAntes = estado.retardosPendientes || [];
      ap2.ultimaFechaIncidente = iso(incidentes[incidentes.length - 1].fechaD);
      ap2.retardosPendientes = sobrantes.map(iso);
      reg2.aprendices[clave] = ap2; guardarRegistro(reg2);

      resumen.casos.push({ aprendiz: a.nombre, documento: a.documento, medida: tipo, acta: numero, archivo: nombreArchivo, motivos: incidentes.length, historico: histOk ? "registrado" : `PENDIENTE: no se pudo registrar en HISTORICO de "${path.basename(ruta)}" — ciérralo en Excel y reprocesa.`, ...(avisos.length ? { avisos } : {}) });
    } catch (e) {
      if (e.codigo === "EN_COMITE") resumen.casos.push({ aprendiz: a.nombre, documento: a.documento, medida: "YA EN COMITÉ (sin documentos nuevos)", detalle: e.message });
      else resumen.errores.push(`${a.nombre}: ${e.message}`);
    }
  }
  return resumen;
}

function buscarControles(carpeta, profundidad = 0, encontrados = []) {
  if (profundidad > 5) return encontrados;
  for (const sub of fs.readdirSync(carpeta, { withFileTypes: true })) {
    const ruta = path.join(carpeta, sub.name);
    if (sub.isDirectory()) buscarControles(ruta, profundidad + 1, encontrados);
    else if (/^CONTROL_ASISTENCIA.*\.xlsx$/i.test(sub.name) && !sub.name.startsWith("~$")) encontrados.push(ruta);
  }
  return encontrados;
}

function procesarTrimestre(carpeta) {
  if (!fs.existsSync(carpeta)) throw new Error(`No existe la carpeta: ${carpeta}`);
  const resultados = [];
  for (const archivo of buscarControles(carpeta)) {
    try { resultados.push(procesarControl(archivo)); }
    catch (e) { resultados.push({ archivo: path.basename(archivo), error: e.message }); }
  }
  return resultados;
}


// Panorama general de la ficha (numeral 1 del acta de entrega y del acta de novedades).
// El orden de esta lista es el orden de las filas del cuadro.
const CAT_ACTIVA = "En formación";
const CATEGORIAS = [
  ["FORMACION", CAT_ACTIVA],
  ["CONDICIONADO", "Condicionados"],
  ["COMITE", "Reportados a comité por no cumplir con las evidencias"],
  ["DESERCION", "En proceso de deserción"],
  ["CANCELADO", "Cancelados"],
  ["RETIRO", "Retiro voluntario"],
  ["TRASLADADO", "Trasladados"],
  ["APLAZADO", "Aplazados"],
];

function categoriaDe(estado) {
  const e = norm(estado);
  if (!e || e === "ACTIVO") return CAT_ACTIVA; // vacio o etiqueta antigua = aprendiz activo
  for (const [clavePat, etiqueta] of CATEGORIAS) if (e.includes(clavePat)) return etiqueta;
  return "Otros";
}

// simular = true -> calcula todo el panorama igual, pero NO genera el .docx,
// NO toca el registro y NO escribe en el HISTORICO. Vista previa obligatoria
// antes de generar (ninguna acción que genere documentos se ejecuta sin
// aprobación).
function generarEntregaControl(ruta, simular = false) {
  const { params, sesiones, aprendices } = leerControl(ruta);
  if (!params.generarEntrega) {
    return { archivo: path.basename(ruta), ficha: params.ficha, programa: params.programa,
             omitida: true, mensaje: "OMITIDA (GENERAR ACTA DE ENTREGA = NO o ausente)" };
  }
  const avisos = avisosConfiguracion(params);
  const reg = cargarRegistro();
  const conteo = {};
  const evaluados = [], noEvaluados = [];
  let totalInasistencias = 0, totLl1 = 0, totLl2 = 0, totPlanes = 0, totComite = 0;
  const actasNums = [];

  aprendices.forEach((a, idx) => {
    const cat = categoriaDe(a.estado);
    conteo[cat] = (conteo[cat] || 0) + 1;
    const inas = a.att.filter(v => v === 0 || v === "0").length;
    totalInasistencias += inas;
    const est = reg.aprendices[`${params.ficha}-${a.documento}`] || {};
    totLl1 += est.llamados >= 1 ? 1 : 0; totLl2 += est.llamados >= 2 ? 1 : 0;
    totPlanes += est.planes || 0; totComite += est.comite ? 1 : 0;
    for (const h of est.historial || []) actasNums.push(h.numero);

    if (a.evaluado) {
      let obs = "Sin novedad";
      if (est.comite) obs = "Evaluado; caso con informe a comité en el periodo";
      else if (est.planes) obs = "Superó plan de mejoramiento y fue evaluado en SOFIA Plus";
      else if (est.llamados) obs = `Evaluado; tuvo ${est.llamados} llamado(s) de atención en el periodo`;
      evaluados.push({ no: evaluados.length + 1, documento: String(a.documento), nombre: a.nombre, observacion: obs });
    } else {
      let causa;
      if (est.comite) causa = "Citado a Comité de Evaluación y Seguimiento; pendiente de decisión";
      else if (est.planes) causa = "Plan de mejoramiento en ejecución; evidencias pendientes";
      else if (categoriaDe(a.estado) !== CAT_ACTIVA) causa = categoriaDe(a.estado);
      else causa = "Evidencias de aprendizaje pendientes";
      if (a.novedadManual) causa += `. ${a.novedadManual}`;
      noEvaluados.push({ no: noEvaluados.length + 1, documento: String(a.documento), nombre: a.nombre, novedad: causa, inasistencias: inas });
    }
  });

  const panorama = CATEGORIAS.map(([, et]) => ({ estado: et, cantidad: conteo[et] || "-" }));
  if (conteo["Otros"]) panorama.push({ estado: "Otros", cantidad: conteo["Otros"] });
  panorama.push({ estado: "Total", cantidad: aprendices.length });

  const medidas = `Durante el periodo se aplicaron las medidas formativas del Artículo 46 del Acuerdo 009 de 2024 así: ${totLl1} primer(os) llamado(s) de atención, ${totLl2} segundo(s) llamado(s) con orientaciones académicas escritas, ${totPlanes} plan(es) de mejoramiento y ${totComite} informe(s) a Comité de Evaluación y Seguimiento${actasNums.length ? ` (actas Nos. ${actasNums.join(", ")})` : ""}. Todas las medidas cuentan con acta y constan en el HISTORICO del control de la ficha.`;
  const inasTexto = `En el control de asistencia de la ficha, espejo de lo registrado en SOFIA Plus, se registraron ${totalInasistencias} inasistencia(s) injustificada(s) en el periodo, discriminadas por aprendiz en el numeral 4 para quienes presentan novedades.`;

  // VISTA PREVIA: se informa el panorama completo, sin generar ni registrar nada
  if (simular) {
    return { archivo: path.basename(ruta), ficha: params.ficha, programa: params.programa,
             casos: [{ aprendiz: "ENTREGA DE FICHA", medida: "ACTA DE ENTREGA (vista previa)",
                       evaluados: evaluados.length, no_evaluados: noEvaluados.length,
                       panorama, medidas_texto: medidas, inasistencias_texto: inasTexto,
                       ...(avisos.length ? { avisos } : {}) }],
             sinNovedad: 0, errores: [] };
  }

  const { buffer, numero } = generarActaEntrega({
    ficha: params.ficha, programa: params.programa, competencia: params.competencia,
    codigo_competencia: params.codigoCompetencia, jornada: params.jornada,
    regional: params.regional, centro: params.centro, lugar: params.lugar,
    instructor: params.instructor, coordinador: params.coordinador,
    panorama, evaluados, no_evaluados: noEvaluados,
    medidas_texto: medidas, inasistencias_texto: inasTexto,
  });
  const nombreArchivo = `ACTA_ENTREGA_${numero}_FICHA_${params.ficha}.docx`;
  fs.writeFileSync(path.join(path.dirname(ruta), nombreArchivo), buffer);
  let histOk = true;
  try {
    registrarEnHistorico(ruta, [fechaHoy(), "-", "TODA LA FICHA", "ACTA DE ENTREGA DE FICHA", `Entrega de la competencia ${params.competencia}`, numero]);
  } catch (e) { histOk = false; }
  return { archivo: path.basename(ruta), ficha: params.ficha, programa: params.programa,
           casos: [{ aprendiz: "ENTREGA DE FICHA", medida: "ACTA DE ENTREGA", acta: numero, archivo: nombreArchivo,
                     evaluados: evaluados.length, no_evaluados: noEvaluados.length,
                     historico: histOk ? "registrado" : `PENDIENTE: no se pudo registrar en HISTORICO de "${path.basename(ruta)}" — ciérralo en Excel y reprocesa.`,
                     ...(avisos.length ? { avisos } : {}) }],
           sinNovedad: 0, errores: [] };
}

function generarEntregas(carpeta, simular = false) {
  if (!fs.existsSync(carpeta)) throw new Error(`No existe la carpeta: ${carpeta}`);
  const resultados = [];
  for (const archivo of buscarControles(carpeta)) {
    try { resultados.push(generarEntregaControl(archivo, simular)); }
    catch (e) { resultados.push({ archivo: path.basename(archivo), error: e.message }); }
  }
  return resultados;
}

module.exports = {
  procesarControl, procesarTrimestre, generarEntregaControl, generarEntregas, leerControl,
  // reutilizados por equipo_ejecutor.js, para no duplicar reglas ya escritas aquí
  norm, evaluarAprendiz, recibeLlamado, categoriaDe, CATEGORIAS,
  // utilidades de cirugía de XML sobre el .xlsx, reutilizadas por sofia.js
  // (poblarAprendices) e ipc.js/modoPrueba.js (establecerParametrosInstructor,
  // crearFichaDemo): editar una hoja puntual sin reescribir el libro completo
  // con una librería de alto nivel, que no conserva estilos, validaciones ni
  // formato condicional.
  resolverHojaEnZip, leerCadenasCompartidas, xmlEscape, extraerCelda, estiloDeColumna, celda, escribirParametros,
};
