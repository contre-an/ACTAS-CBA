// procesar.js — Lee controles de asistencia, aplica reglas (Acuerdo 009) y genera actas por periodo
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const PizZip = require("pizzip");
const { generarActa, generarActaEntrega, cargarRegistro, guardarRegistro } = require("./generar");

const fechaHoy = () => { const d = new Date(); return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`; };
const norm = s => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toUpperCase();

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
  const wb = XLSX.readFile(ruta, { cellDates: true });
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
  if (!params.ficha || !params.programa) throw new Error(`PARAMETROS incompletos (FICHA/PROGRAMA) en ${path.basename(ruta)}`);

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

function resumenMotivos(incidentes) {
  const c = { INASISTENCIA: 0, NO_PRESENTO: 0, NOTA_BAJA: 0, RETARDOS: 0 };
  for (const i of incidentes) c[i.tipo] = (c[i.tipo] || 0) + 1;
  const partes = [];
  if (c.INASISTENCIA) partes.push(`${c.INASISTENCIA} inasistencia(s) injustificada(s)`);
  if (c.NO_PRESENTO) partes.push(`${c.NO_PRESENTO} evidencia(s) no presentada(s)`);
  if (c.NOTA_BAJA) partes.push(`${c.NOTA_BAJA} evidencia(s) no superada(s)`);
  if (c.RETARDOS) partes.push(`${c.RETARDOS} grupo(s) de retardos`);
  return partes.join(", ") || "Incidentes registrados en el control";
}

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Escribe la fila en HISTORICO editando SOLO el XML de esa hoja dentro del .xlsx:
// el resto del archivo (colores, anchos, formulas, celdas) queda byte a byte identico.
function registrarEnHistorico(ruta, fila) {
  const zip = new PizZip(fs.readFileSync(ruta));
  const wbXml = zip.file("xl/workbook.xml").asText();
  const m = wbXml.match(/<sheet[^>]*name="HISTORICO"[^>]*r:id="(rId\d+)"/i) ||
            wbXml.match(/<sheet[^>]*r:id="(rId\d+)"[^>]*name="HISTORICO"/i);
  if (!m) return false;
  const rels = zip.file("xl/_rels/workbook.xml.rels").asText();
  const rm = rels.match(new RegExp('Id="' + m[1] + '"[^>]*Target="([^"]+)"')) ||
             rels.match(new RegExp('Target="([^"]+)"[^>]*Id="' + m[1] + '"'));
  if (!rm) return false;
  let target = rm[1].replace(/^\//, "");
  if (!target.startsWith("xl/")) target = "xl/" + target.replace(/^\.\//, "");
  const archivoHoja = zip.file(target);
  if (!archivoHoja) return false;
  let xml = archivoHoja.asText();

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
                    casos: [], sinNovedad: 0, omitidos: [], errores: [] };

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

      // VISTA PREVIA: se informa lo que se haria, sin generar ni registrar nada
      if (simular) {
        const ap = estado.llamados || 0, pl = estado.planes || 0;
        const tipoPrevisto = ap === 0 ? "LLAMADO_1" : ap === 1 ? "LLAMADO_2"
          : pl === 0 ? "PLAN_MEJORAMIENTO" : !estado.comite ? "INFORME_COMITE" : "EN_COMITE";
        resumen.casos.push({ aprendiz: a.nombre, documento: a.documento,
          medida: tipoPrevisto, motivos: incidentes.length,
          detalle: incidentes.map(i => i.tipo === "RETARDOS"
            ? `${i.fecha}: 2 retardos` : `${i.fecha}: ${i.tipo}${i.actividad ? " (" + i.actividad + ")" : ""}`) });
        continue;
      }

      // Descripción de las evidencias pendientes (numeral 1.1 del acta), tomada
      // de la hoja DESCRIPCIONES que redacta el instructor (ver leerControl).
      // Si una actividad no tiene descripción escrita, simplemente no aparece:
      // el acta sale igual, sin ese renglón.
      const actividadesPendientes = [...new Set(incidentes.filter(i => i.actividad).map(i => i.actividad))];
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
      ap2.ultimaFechaIncidente = iso(incidentes[incidentes.length - 1].fechaD);
      ap2.retardosPendientes = sobrantes.map(iso);
      reg2.aprendices[clave] = ap2; guardarRegistro(reg2);

      resumen.casos.push({ aprendiz: a.nombre, documento: a.documento, medida: tipo, acta: numero, archivo: nombreArchivo, motivos: incidentes.length, historico: histOk ? "registrado" : "PENDIENTE (cierra el Excel y reprocesa)" });
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

function generarEntregaControl(ruta) {
  const { params, sesiones, aprendices } = leerControl(ruta);
  if (!params.generarEntrega) {
    return { archivo: path.basename(ruta), ficha: params.ficha, programa: params.programa,
             omitida: true, mensaje: "OMITIDA (GENERAR ACTA DE ENTREGA = NO o ausente)" };
  }
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
                     historico: histOk ? "registrado" : "PENDIENTE (cierra el Excel y reprocesa)" }],
           sinNovedad: 0, errores: [] };
}

function generarEntregas(carpeta) {
  if (!fs.existsSync(carpeta)) throw new Error(`No existe la carpeta: ${carpeta}`);
  const resultados = [];
  for (const archivo of buscarControles(carpeta)) {
    try { resultados.push(generarEntregaControl(archivo)); }
    catch (e) { resultados.push({ archivo: path.basename(archivo), error: e.message }); }
  }
  return resultados;
}

module.exports = { procesarControl, procesarTrimestre, generarEntregas };
