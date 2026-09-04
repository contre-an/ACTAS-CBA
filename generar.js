// generar.js — GOR-F-084 V02 con escalamiento del Art. 46, Acuerdo 009 de 2024
const fs = require("fs");
const path = require("path");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");

const PLANTILLA = path.join(__dirname, "plantilla", "GOR-F-084_PLANTILLA.docx");
const PLANTILLA_COMITE = path.join(__dirname, "plantilla", "INFORME_COMITE_PLANTILLA.docx");
const PLANTILLA_ENTREGA = path.join(__dirname, "plantilla", "ACTA_ENTREGA_PLANTILLA.docx");
const REGISTRO = path.join(__dirname, "registro.json");
const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];

function fechaLarga(d = new Date()) { return `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`; }
function fechaCorta(d = new Date()) {
  return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
}

function cargarRegistro() {
  try { return JSON.parse(fs.readFileSync(REGISTRO, "utf8")); }
  catch { return { consecutivo: 0, aprendices: {} }; }
}
function guardarRegistro(reg) { fs.writeFileSync(REGISTRO, JSON.stringify(reg, null, 2)); }

// ---- texto de cada incidente con su norma (Acuerdo 009 de 2024) ----
function textoIncidente(inc, n) {
  const base = `${n}. El día ${inc.fecha}`;
  if (inc.tipo === "INASISTENCIA") {
    return `${base} el aprendiz presentó INASISTENCIA INJUSTIFICADA a la sesión de formación, sin reportar ni justificar la causa en los términos del Artículo 28 del Reglamento del Aprendiz SENA (Acuerdo 009 de 2024), incumpliendo el deber de "asistir con puntualidad a todas las actividades propias del proceso de formación" (Artículo 8, numeral 5) y configurando incumplimiento injustificado conforme al Artículo 29 del mismo reglamento.`;
  }
  if (inc.tipo === "NO_PRESENTO") {
    return `${base} el aprendiz asistió a la sesión de formación pero NO PRESENTÓ la evidencia de aprendizaje "${inc.actividad}" en el Google Classroom de la competencia, incumpliendo el deber de "cumplir con todas las actividades de su proceso formativo, presentando las evidencias según la planeación pedagógica, guías de aprendizaje y cronograma, en los plazos o en la oportunidad que estas deban presentarse o reportarse" (Artículo 8, numeral 6, en concordancia con los Artículos 27 y 33 del Acuerdo 009 de 2024).`;
  }
  if (inc.tipo === "NOTA_BAJA") {
    return `${base} el aprendiz presentó la evidencia de aprendizaje "${inc.actividad}" con una valoración de ${inc.nota}, inferior a 7, es decir, NO SUPERÓ la actividad ni alcanzó el resultado de aprendizaje esperado, situación que corresponde al juicio de evaluación NO APROBADO y activa la aplicación de medidas formativas académicas (Artículos 36, 37 y 45 del Acuerdo 009 de 2024).`;
  }
  if (inc.tipo === "RETARDOS") {
    const lista = (inc.fechas || []).join(" y ");
    return `${n}. El aprendiz acumuló ${inc.fechas.length === 2 ? "dos (2)" : inc.fechas.length} RETARDOS a las sesiones de formación, los días ${lista}, incumpliendo el deber de "asistir con puntualidad a todas las actividades propias del proceso de formación" (Artículo 8, numeral 5 del Reglamento del Aprendiz SENA, Acuerdo 009 de 2024).`;
  }
  return `${base}: ${inc.motivo || "incidente registrado en el control de asistencia de la ficha"}.`;
}

const TIPOS = {
  LLAMADO_1: {
    titulo: "PRIMER LLAMADO DE ATENCIÓN ACADÉMICO",
    norma: "Artículo 46, numeral 1, literal a) del Acuerdo 009 de 2024",
  },
  LLAMADO_2: {
    titulo: "SEGUNDO LLAMADO DE ATENCIÓN ACADÉMICO",
    norma: "Artículo 46, numeral 1, literal a) del Acuerdo 009 de 2024",
  },
  PLAN_MEJORAMIENTO: {
    titulo: "CONCERTACIÓN DE PLAN DE MEJORAMIENTO ACADÉMICO",
    norma: "Artículo 46, numeral 1, literal b) del Acuerdo 009 de 2024",
  },
};

function construirContenido(d, tipo, numero) {
  const T = TIPOS[tipo];
  const fcorta = d.fecha_corta || fechaCorta();
  const titulo = `${T.titulo} — APRENDIZ ${d.aprendiz.nombre} — FICHA ${d.ficha} — ${d.programa}`;
  const hechos = d.incidentes.map((inc, k) => ({ texto: textoIncidente(inc, k + 1) }));
  const actividadesPendientes = d.incidentes
    .filter(i => i.tipo === "NO_PRESENTO" || i.tipo === "NOTA_BAJA")
    .map(i => `"${i.actividad}"`).join(", ");

  const agenda = [
    "Verificación de la situación académica del aprendiz (registro de asistencia y control de evidencias de aprendizaje).",
    "Comunicación al aprendiz de los hechos identificados y de las normas del Reglamento del Aprendiz SENA presuntamente incumplidas.",
    "Escucha de la versión del aprendiz (Artículo 5, numerales 10, 11 y 12 del Acuerdo 009 de 2024).",
    tipo === "PLAN_MEJORAMIENTO"
      ? "Concertación del plan de mejoramiento académico y aceptación de compromisos."
      : `Aplicación del ${T.titulo.toLowerCase()} y aceptación de compromisos.`,
  ].map((t, i) => ({ numero: i + 1, texto: t }));

  const objetivos = [{
    numero: 1,
    texto: tipo === "PLAN_MEJORAMIENTO"
      ? `Concertar con el aprendiz ${d.aprendiz.nombre}, identificado con documento ${d.aprendiz.documento}, un PLAN DE MEJORAMIENTO ACADÉMICO, agotados previamente los dos (2) llamados de atención académicos, conforme al ${T.norma}, como medida formativa para garantizar el logro de los resultados de aprendizaje, con plena garantía del debido proceso.`
      : `Efectuar ${T.titulo} al aprendiz ${d.aprendiz.nombre}, identificado con documento ${d.aprendiz.documento}, conforme al ${T.norma}, como medida formativa de carácter pedagógico orientada a prevenir el abandono del proceso formativo y favorecer su permanencia, con plena garantía del debido proceso.`,
  }];

  const desarrollo = [
    { texto: `1. VERIFICACIÓN: El instructor ${d.instructor.nombre} verificó el registro de asistencia y el control de evidencias de aprendizaje de la competencia ${d.competencia} del programa ${d.programa}, ficha ${d.ficha}, identificando respecto del aprendiz ${d.aprendiz.nombre} (documento ${d.aprendiz.documento}) las siguientes situaciones:` },
    ...hechos,
    // Descripción detallada de las evidencias pendientes (opcional). Hoy la
    // escribe el instructor en la hoja DESCRIPCIONES del control; antes la
    // generaba la IA a partir del PDF de la actividad.
    ...(d.descripcion_actividades && d.descripcion_actividades.length
      ? [{ texto: `1.1. DESCRIPCIÓN DE LAS EVIDENCIAS DE APRENDIZAJE PENDIENTES: Para plena claridad del aprendiz y en garantía del debido proceso, se describe el contenido y alcance de cada evidencia pendiente: ${d.descripcion_actividades.join(" ")}` }]
      : []),
    { texto: `2. COMUNICACIÓN: Se informó al aprendiz, de manera clara y respetuosa, sobre los hechos identificados, las normas del Reglamento del Aprendiz SENA (Acuerdo 009 de 2024) relacionadas, y se le recordó que las evidencias de aprendizaje deben presentarse en el Google Classroom de la competencia dentro de los plazos establecidos.` },
    { texto: `3. VERSIÓN DEL APRENDIZ: En garantía del derecho a ser oído (Artículo 5, numerales 10, 11 y 12 del Acuerdo 009 de 2024), se concedió la palabra al aprendiz, quien manifestó: ${d.version_aprendiz || "_________________________________________________________________________________________________"}` },
  ];

  if (tipo === "LLAMADO_1") {
    desarrollo.push({ texto: `4. MEDIDA FORMATIVA: En consecuencia, se efectúa el PRIMER LLAMADO DE ATENCIÓN ACADÉMICO por escrito (${T.norma}), medida de carácter pedagógico y no sancionatorio. Se advierte al aprendiz que el reglamento contempla hasta dos (2) llamados de atención por fase del proyecto formativo y que, de persistir la situación, el segundo llamado irá acompañado de orientaciones académicas escritas y, agotados ambos, procederá el plan de mejoramiento académico.` });
  }
  if (tipo === "LLAMADO_2") {
    const orientaciones = `a) Presentar en el Google Classroom de la competencia las evidencias pendientes ${actividadesPendientes ? `(${actividadesPendientes}) ` : ""}en la fecha concertada en los compromisos de la presente acta; b) Asistir puntualmente a todas las sesiones de formación y, ante cualquier imposibilidad, reportar y soportar la justificación dentro de los términos del Artículo 28; c) Solicitar al instructor las asesorías o explicaciones adicionales que requiera para superar los resultados de aprendizaje; d) Revisar la guía de aprendizaje y los criterios de evaluación de cada evidencia antes de su entrega.`;
    desarrollo.push({ texto: `4. MEDIDA FORMATIVA: En consecuencia, se efectúa el SEGUNDO LLAMADO DE ATENCIÓN ACADÉMICO por escrito (${T.norma}), el cual, conforme al reglamento, se acompaña de las siguientes ORIENTACIONES ACADÉMICAS ESCRITAS basadas en estrategias pedagógicas, de acatamiento inmediato: ${orientaciones} Se advierte al aprendiz que, agotados los dos (2) llamados de atención, de persistir la situación se establecerá un plan de mejoramiento académico.` });
  }
  if (tipo === "PLAN_MEJORAMIENTO") {
    // Cita del acta de equipo ejecutor cuando existe (dato de la ficha; ver
    // equipo_ejecutor/acta_equipo_ejecutor en estado.js)
    const citaEquipo = d.acta_equipo
      ? `, según decisión del equipo ejecutor de la ficha consignada en el Acta No. ${d.acta_equipo.numero} del ${d.acta_equipo.fecha},`
      : "";
    desarrollo.push({ texto: `4. PLAN DE MEJORAMIENTO ACADÉMICO: Agotados los dos (2) llamados de atención académicos realizados previamente al aprendiz, se establece${citaEquipo} un PLAN DE MEJORAMIENTO ACADÉMICO (${T.norma}) para garantizar el logro de los resultados de aprendizaje no superados de la competencia ${d.competencia}. El plan comprende las actividades de aprendizaje y las evidencias pendientes ${actividadesPendientes ? `(${actividadesPendientes}) ` : ""}que el aprendiz debe presentar en el Google Classroom de la competencia, en las fechas concertadas en los compromisos de la presente acta, las cuales no superan el término de veinte (20) días calendario contados a partir de la suscripción del plan ni la fecha final de la fase del proyecto. La verificación del plan será responsabilidad del instructor. Se advierte al aprendiz que, conforme al Parágrafo 4 del Artículo 46, el incumplimiento de lo establecido en el plan de mejoramiento dará lugar a remisión al Comité de Evaluación y Seguimiento, instancia que definirá las medidas sancionatorias a aplicar.` });
  }

  const conclusiones = [
    tipo === "PLAN_MEJORAMIENTO"
      ? "Se concerta el plan de mejoramiento académico y quedan establecidas las actividades, evidencias, plazos y responsables, conforme al Artículo 46, numeral 1, literal b) del Acuerdo 009 de 2024."
      : `Se efectúa el ${TIPOS[tipo].titulo.toLowerCase()} como medida formativa académica, de carácter pedagógico y no sancionatorio, y quedan establecidos los compromisos del aprendiz.`,
    "El aprendiz fue informado de los hechos y de las normas relacionadas, y ejerció su derecho a ser oído y a presentar su versión, en garantía del debido proceso (Artículo 5, numerales 10, 11 y 12 del Acuerdo 009 de 2024).",
    "El aprendiz autoriza de manera expresa y voluntaria la notificación electrónica al correo registrado en el sistema de gestión académica, en los términos del Artículo 51 del Acuerdo 009 de 2024, y recibe copia de la presente acta por ese medio.",
    "El instructor realizará seguimiento al cumplimiento de los compromisos y dejará registro de las novedades en el control de la ficha.",
  ].map((t, i) => ({ numero: i + 1, texto: t }));

  const compromisos = (d.compromisos && d.compromisos.length ? d.compromisos : [
    { actividad: `Presentar en el Google Classroom de la competencia ${d.competencia} las evidencias de aprendizaje pendientes ${actividadesPendientes ? `(${actividadesPendientes}) ` : ""}en la fecha de entrega que concerta el instructor en este espacio: ______________________`, fecha: fcorta, responsable: d.aprendiz.nombre },
    { actividad: "Asistir puntualmente a las sesiones de formación y justificar oportunamente cualquier inasistencia con los soportes correspondientes (Artículo 28, Acuerdo 009 de 2024).", fecha: fcorta, responsable: d.aprendiz.nombre },
    { actividad: "Realizar seguimiento al cumplimiento de los compromisos y registrar las novedades en el control de la ficha.", fecha: fcorta, responsable: d.instructor.nombre },
  ]).map(c => ({ ...c, firma: "" }));

  const asistentes = [
    { nombre: `${d.instructor.nombre} (Instructor)`, dependencia: d.centro || "CBA — SENA", aprueba: "SI", observacion: "", firma: "" },
    { nombre: `${d.aprendiz.nombre} (Aprendiz — Doc. ${d.aprendiz.documento})`, dependencia: `Ficha ${d.ficha} — ${d.programa}`, aprueba: "", observacion: "", firma: "" },
  ];
  if (tipo === "PLAN_MEJORAMIENTO") {
    asistentes.push({ nombre: "____________________________ (Coordinador Académico)", dependencia: d.centro || "CBA — SENA", aprueba: "", observacion: "Firma el plan de mejoramiento (Art. 46.1.b)", firma: "" });
  }

  return {
    numero_acta: numero,
    nombre_reunion: titulo,
    ciudad_fecha: `${d.ciudad || "Mosquera, Cundinamarca"}, ${d.fecha || fechaLarga()}`,
    hora_inicio: d.hora_inicio || "", hora_fin: d.hora_fin || "",
    lugar: d.lugar || "Centro de Biotecnología Agropecuaria — CBA",
    regional_centro: `${d.regional || "REGIONAL CUNDINAMARCA"} / ${d.centro || "CENTRO DE BIOTECNOLOGÍA AGROPECUARIA"}`,
    agenda, objetivos, desarrollo, conclusiones, compromisos, asistentes,
    anexos: d.anexos || "Registro de asistencia y control de evidencias de aprendizaje de la ficha.",
  };
}


function construirInformeComite(d, numero) {
  const hoy = new Date();
  const hechos = d.incidentes.map((inc, k) => textoIncidente(inc, k + 1)).join(" ");
  const intro = `El instructor ${d.instructor.nombre}, de la competencia ${d.competencia} del programa ${d.programa} (ficha ${d.ficha}), remite al Comité de Evaluación y Seguimiento el caso del aprendiz ${d.aprendiz.nombre}, identificado con documento ${d.aprendiz.documento}, por cuanto, agotados los dos (2) llamados de atención académicos y el plan de mejoramiento previstos en el Artículo 46 del Acuerdo 009 de 2024 sin que el aprendiz superara las situaciones, y conforme al Parágrafo 4 del mismo artículo, se activa la remisión a este Comité. Los hechos son los siguientes: ${hechos} Se deja constancia de que el aprendiz fue informado de cada medida y ejerció su derecho a ser oído, en garantía del debido proceso (Artículos 39 y 5 del Acuerdo 009 de 2024).`;
  return {
    numero_informe: numero,
    anio: hoy.getFullYear(), mes: String(hoy.getMonth() + 1).padStart(2, "0"), dia: String(hoy.getDate()).padStart(2, "0"),
    aprendiz_nombre_correo: `${d.aprendiz.nombre} — ${d.aprendiz.correo || ""}`,
    aprendiz_documento: String(d.aprendiz.documento),
    ficha: String(d.ficha), programa: d.programa,
    descripcion_hechos: intro,
    testigos: d.testigos || "______________________________________________",
    instructor_nombre: d.instructor.nombre,
    instructor_documento: String(d.instructor.documento || ""),
    instructor_correo: d.instructor.correo || "",
    evidencias: d.evidencias || "Actas de primer y segundo llamado de atención, acta de concertación de plan de mejoramiento, y registro de asistencia y evidencias de la ficha.",
    testigo_nombre: "", testigo_documento: "", testigo_ficha: "", testigo_correo: "", testigo_cargo: "",
  };
}


function construirActaEntrega(d, numero) {
  const titulo = `ENTREGA DE FICHA ${d.ficha} — ${d.programa} — COMPETENCIA: ${d.competencia}`;
  return {
    numero_acta: numero,
    nombre_reunion: titulo,
    ciudad_fecha: `${d.ciudad || "Mosquera, Cundinamarca"}, ${fechaLarga()}`,
    hora_inicio: d.hora_inicio || "", hora_fin: d.hora_fin || "",
    lugar: d.lugar || "Centro de Biotecnología Agropecuaria — CBA",
    regional_centro: `${d.regional || "REGIONAL CUNDINAMARCA"} / ${d.centro || "CENTRO DE BIOTECNOLOGÍA AGROPECUARIA"}`,
    agenda: [
      "Presentación del panorama general de la ficha y del estado de los aprendices.",
      "Relación de aprendices evaluados en SOFIA Plus y de aprendices con novedades pendientes.",
      "Resumen de las medidas formativas aplicadas en el periodo (Acuerdo 009 de 2024) y de las inasistencias registradas.",
      "Entrega formal de la ficha a la Coordinación Académica.",
    ].map((t, i) => ({ numero: i + 1, texto: t })),
    objetivos: [{ numero: 1, texto: `Realizar la entrega formal de la ficha ${d.ficha} del programa ${d.programa}, correspondiente a la competencia ${d.competencia}, por parte del instructor ${d.instructor.nombre} a la Coordinación Académica, consolidando en un único documento los juicios evaluativos registrados en SOFIA Plus, el estado final de la totalidad de aprendices y las novedades del periodo, conforme a los lineamientos de ejecución de la formación (GFPI-P-006) y a la Circular 122 de 2024.` }],
    intro: `El instructor ${d.instructor.nombre}, identificado con documento ${d.instructor.documento}, hace entrega de la ficha ${d.ficha} del programa ${d.programa}, en la cual orientó la competencia ${d.competencia}. Los juicios evaluativos de los aprendices relacionados en el numeral 3 fueron registrados en el aplicativo SOFIA Plus dentro de los términos institucionales. A continuación se presenta el consolidado:`,
    panorama: d.panorama,
    competencia_texto: `${d.competencia}${d.codigo_competencia ? " (código " + d.codigo_competencia + ")" : ""}, orientada en la jornada ${d.jornada || "MIXTA"} durante el periodo académico, con las evidencias de aprendizaje registradas en el Google Classroom de la competencia y el control de asistencia de la ficha.`,
    n_evaluados: d.evaluados.length,
    evaluados: d.evaluados.length ? d.evaluados : [{ no: "-", documento: "-", nombre: "Sin registros", observacion: "-" }],
    n_no_evaluados: d.no_evaluados.length,
    no_evaluados: d.no_evaluados.length ? d.no_evaluados : [{ no: "-", documento: "-", nombre: "Sin novedades", novedad: "-", inasistencias: "-" }],
    medidas_texto: d.medidas_texto,
    inasistencias_texto: d.inasistencias_texto,
    conclusiones: [
      `El instructor entrega la ficha ${d.ficha} con el consolidado de juicios evaluativos, estados y novedades de la totalidad de los aprendices, en un único documento.`,
      "Los aprendices relacionados en el numeral 4 quedan con sus novedades documentadas para el seguimiento correspondiente por parte de la Coordinación Académica y las instancias competentes (Comité de Evaluación y Seguimiento, cuando aplique).",
      "Las medidas formativas aplicadas en el periodo cuentan con sus actas y soportes, conforme al debido proceso del Acuerdo 009 de 2024.",
    ].map((t, i) => ({ numero: i + 1, texto: t })),
    compromisos: [
      { actividad: "Verificar el registro completo de los juicios evaluativos y novedades en SOFIA Plus.", fecha: fechaCorta(), responsable: d.coordinador || "Coordinación Académica", firma: "" },
      { actividad: "Dar continuidad al seguimiento de los aprendices con novedades pendientes (planes de mejoramiento, comité).", fecha: fechaCorta(), responsable: d.coordinador || "Coordinación Académica", firma: "" },
    ],
    asistentes: [
      { nombre: `${d.instructor.nombre} (Instructor que entrega)`, dependencia: d.centro || "CBA — SENA", aprueba: "SI", observacion: "", firma: "" },
      { nombre: `${d.coordinador || "____________________"} (Coordinadora Académica que recibe)`, dependencia: d.centro || "CBA — SENA", aprueba: "", observacion: "", firma: "" },
    ],
    anexos: "Control de asistencia y evidencias de la ficha, actas de medidas formativas del periodo e informe(s) a comité cuando aplique.",
  };
}

// ===== Acta de equipo ejecutor =====
// Reúne a todos los instructores de una ficha (documento aparte del control
// de asistencia; ver equipo_ejecutor.js, que arma `datos` a partir del
// horario en PDF y del control del instructor que la genera). Usa la MISMA
// plantilla GOR-F-084 que las demás actas: esta plantilla ya trae, además de
// los campos comunes, las secciones opcionales `hay_panorama`/`panorama` y
// `hay_novedades`/`novedades` (tablas), y el desarrollo partido en tres
// tramos (`desarrollo`, `desarrollo2`, `desarrollo3`) para poder intercalar
// esas dos tablas entre los numerales de texto.
function construirActaEquipoEjecutor(d, numero) {
  const fecha = d.fecha || fechaLarga();
  const titulo = `REUNIÓN ORDINARIA DEL EQUIPO EJECUTOR — FICHA ${d.ficha}: SEGUIMIENTO Y NOVEDADES DE LA FORMACIÓN`;

  const agenda = [
    "Verificación de asistencia del equipo ejecutor.",
    "Panorama general de la ficha: estado de los aprendices a la fecha.",
    "Novedades académicas y disciplinarias de la ficha.",
    "Compromisos y cierre.",
  ].map((texto, i) => ({ numero: i + 1, texto }));

  const objetivos = [{
    numero: 1,
    texto: `Realizar el seguimiento periódico de la ficha ${d.ficha} — ${d.programa}, conforme al Acuerdo 009 de 2024, por convocatoria de la Coordinación Académica.`,
  }];

  const desarrollo = [
    { texto: `1. Se verifica la asistencia del equipo ejecutor de la ficha ${d.ficha}, conformado por los instructores relacionados en el listado de asistentes, bajo la jefatura de grupo de ${d.jefeGrupo}.` },
    { texto: "2. PANORAMA GENERAL DE LA FICHA A LA FECHA:" },
  ];
  const desarrollo2 = [{ texto: "3. NOVEDADES DE LA FICHA:" }];
  const desarrollo3 = [
    { texto: `4. SÍNTESIS DE LAS NOVEDADES: ${d.sintesis || "El equipo ejecutor no reporta novedades adicionales relacionadas con situaciones académicas, convivenciales o administrativas que requieran atención por parte del comité en esta sesión."}` },
    { texto: "5. Los asistentes se dan por enterados de las novedades presentadas y acuerdan continuar el seguimiento en los términos del Acuerdo 009 de 2024." },
  ];

  const conclusiones = [
    { texto: "El equipo ejecutor conoce y avala el estado actual de la ficha y las novedades presentadas." },
    ...(d.conclusionesExtra || []),
  ].map((c, i) => ({ numero: i + 1, texto: c.texto || c }));

  const compromisos = (d.compromisos && d.compromisos.length ? d.compromisos : [
    { actividad: "Continuar el seguimiento académico y disciplinario de los aprendices relacionados en las novedades.", fecha: d.fechaCorta || fechaCorta(), responsable: "Equipo ejecutor" },
  ]).map(c => ({ ...c, firma: "" }));

  const asistentes = (d.filas || []).map(f => ({
    nombre: `${f.esJefeGrupo ? `${f.instructor} (Instructor — Jefe de Grupo)` : `${f.instructor} (Instructor)`}`,
    dependencia: `Competencia: ${f.competencia}`,
    aprueba: "SI", observacion: "", firma: "",
  }));

  return {
    numero_acta: numero,
    nombre_reunion: titulo,
    ciudad_fecha: `${d.ciudad || "Mosquera, Cundinamarca"}, ${fecha}`,
    hora_inicio: d.horaInicio || "", hora_fin: d.horaFin || "",
    lugar: d.lugar || "Centro de Biotecnología Agropecuaria — CBA",
    regional_centro: `${d.regional || "REGIONAL CUNDINAMARCA"} / ${d.centro || "CENTRO DE BIOTECNOLOGÍA AGROPECUARIA"}`,
    agenda, objetivos, desarrollo,
    hay_panorama: !!(d.panorama && d.panorama.length),
    panorama: d.panorama || [],
    total_aprendices: d.totalAprendices ?? "",
    desarrollo2,
    hay_novedades: !!(d.filas && d.filas.length),
    novedades: (d.filas || []).map(f => ({ competencia: f.competencia, instructor: f.instructor, observaciones: f.novedades || "" })),
    desarrollo3,
    conclusiones, compromisos, asistentes,
    anexos: d.anexos || "Control de asistencia de la ficha y actas disciplinarias del periodo.",
  };
}

function generarActaEquipoEjecutor(datos) {
  const reg = cargarRegistro();
  reg.consecutivo += 1;
  const numero = String(reg.consecutivo).padStart(3, "0");
  const zip = new PizZip(fs.readFileSync(PLANTILLA)); // misma plantilla GOR-F-084 de siempre
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  doc.render(construirActaEquipoEjecutor(datos, numero));
  const buffer = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
  reg.equipoEjecutor = reg.equipoEjecutor || {};
  reg.equipoEjecutor[String(datos.ficha)] = reg.equipoEjecutor[String(datos.ficha)] || [];
  reg.equipoEjecutor[String(datos.ficha)].push({ numero, fecha: datos.fechaCorta || fechaCorta() });
  guardarRegistro(reg);
  return { buffer, numero };
}

function generarActaEntrega(datos) {
  const reg = cargarRegistro();
  reg.consecutivo += 1;
  const numero = String(reg.consecutivo).padStart(3, "0");
  const zip = new PizZip(fs.readFileSync(PLANTILLA_ENTREGA));
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  doc.render(construirActaEntrega(datos, numero));
  const buffer = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
  reg.entregas = reg.entregas || {};
  reg.entregas[String(datos.ficha)] = { numero, fecha: fechaCorta(), competencia: datos.competencia };
  guardarRegistro(reg);
  return { buffer, numero };
}

function generarActa(datos) {
  const reg = cargarRegistro();
  const clave = `${datos.ficha}-${datos.aprendiz.documento}`;
  const apr = reg.aprendices[clave] || { llamados: 0, planes: 0, historial: [] };

  let tipo;
  if (apr.llamados === 0) tipo = "LLAMADO_1";
  else if (apr.llamados === 1) tipo = "LLAMADO_2";
  else if (apr.planes === 0) tipo = "PLAN_MEJORAMIENTO";
  else if (!apr.comite) tipo = "INFORME_COMITE";
  else {
    const e = new Error(`El aprendiz ${datos.aprendiz.nombre} ya agotó los dos llamados, el plan de mejoramiento y el informe a comité. El caso está en manos del Comité de Evaluación y Seguimiento (Arts. 48-51, Acuerdo 009 de 2024). El sistema no genera más documentos.`);
    e.codigo = "EN_COMITE";
    throw e;
  }

  reg.consecutivo += 1;
  const numero = String(reg.consecutivo).padStart(3, "0");

  let buffer;
  if (tipo === "INFORME_COMITE") {
    const zip = new PizZip(fs.readFileSync(PLANTILLA_COMITE));
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
    doc.render(construirInformeComite(datos, numero));
    buffer = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
    apr.comite = true;
  } else {
    const zip = new PizZip(fs.readFileSync(PLANTILLA));
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
    doc.render(construirContenido(datos, tipo, numero));
    buffer = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
    if (tipo === "PLAN_MEJORAMIENTO") apr.planes += 1; else apr.llamados += 1;
  }

  apr.historial.push({ numero, tipo, fecha: fechaCorta(), nombre: datos.aprendiz.nombre });
  reg.aprendices[clave] = apr;
  guardarRegistro(reg);

  return { buffer, tipo, numero };
}

module.exports = { generarActa, generarActaEntrega, generarActaEquipoEjecutor, cargarRegistro, guardarRegistro };
