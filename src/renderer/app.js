// src/renderer/app.js — toda la lógica de la pantalla. Nunca toca fs ni
// child_process directamente: todo pasa por window.actas.* (ver preload.js).
"use strict";

const ETIQUETAS_MEDIDA = {
  LLAMADO_1: "primer llamado de atención",
  LLAMADO_2: "segundo llamado de atención",
  PLAN_MEJORAMIENTO: "plan de mejoramiento",
  INFORME_COMITE: "informe a comité",
};
const etiquetaMedida = m => ETIQUETAS_MEDIDA[m] || m;

const escapeHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ===== Estado en memoria de la pantalla =====
let carpetaTrimestre = null;
let fichas = [];
const seleccionadas = new Set();

// ===== Elementos =====
const el = id => document.getElementById(id);
const rutaTrimestreSpan = el("ruta-trimestre");
const cuerpoFichas = el("cuerpo-fichas");
const contadorSeleccion = el("contador-seleccion");
const mensajeSinFichas = el("mensaje-sin-fichas");
const resultadosDiv = el("resultados");
const panelDetalle = el("panel-detalle");
const contenidoDetalle = el("contenido-detalle");

// ===== Carpeta del trimestre =====

async function cargarFichas() {
  fichas = carpetaTrimestre ? await window.actas.listarFichas(carpetaTrimestre) : [];
  seleccionadas.clear();
  renderizarFichas();
}

function renderizarFichas() {
  cuerpoFichas.innerHTML = "";
  mensajeSinFichas.hidden = fichas.length > 0;
  for (const f of fichas) {
    const tr = document.createElement("tr");
    if (!f.tieneControl) tr.classList.add("fila-error");
    tr.innerHTML = `
      <td><input type="checkbox" data-carpeta="${escapeHtml(f.carpeta)}"></td>
      <td>${escapeHtml(f.nombreCarpeta)}</td>
      <td>${escapeHtml(f.ficha ?? "—")}</td>
      <td>${escapeHtml(f.programa ?? "—")}</td>
      <td>${escapeHtml(f.competencia ?? "—")}</td>
      <td>${escapeHtml(f.instructor ?? (f.tieneControl ? "—" : f.error))}</td>
      <td>
        <button data-accion="abrir">Abrir carpeta</button>
        <button data-accion="estado">Ver estado</button>
      </td>`;
    tr.querySelector('input[type=checkbox]').addEventListener("change", e => {
      if (e.target.checked) seleccionadas.add(f.carpeta); else seleccionadas.delete(f.carpeta);
      actualizarContador();
    });
    tr.querySelector('[data-accion=abrir]').addEventListener("click", () => window.actas.abrirCarpetaFicha(f.carpeta));
    tr.querySelector('[data-accion=estado]').addEventListener("click", () => mostrarEstadoFicha(f));
    cuerpoFichas.appendChild(tr);
  }
  actualizarContador();
}

function actualizarContador() {
  contadorSeleccion.textContent = `${seleccionadas.size} ficha(s) seleccionada(s)`;
  const hay = seleccionadas.size > 0;
  el("btn-generar-actas").disabled = !hay;
  el("btn-generar-entrega").disabled = !hay;
  el("btn-convertir-pdf").disabled = !hay;
}

// una ficha, exigida por las acciones que no tienen sentido para varias a la vez
function unicaSeleccionada() {
  if (seleccionadas.size !== 1) {
    alert("Marca exactamente una ficha en la tabla para esta acción.");
    return null;
  }
  return [...seleccionadas][0];
}

async function mostrarEstadoFicha(f) {
  const estado = await window.actas.estadoFicha(f.carpeta);
  contenidoDetalle.innerHTML = `
    <p><strong>${escapeHtml(f.nombreCarpeta)}</strong></p>
    ${estado.errorControl ? `<p class="error-texto">${escapeHtml(estado.errorControl)}</p>` : `
      <p>Ficha ${escapeHtml(estado.params.ficha)} — ${escapeHtml(estado.params.programa)}<br>
      Competencia: ${escapeHtml(estado.params.competencia)}<br>
      Instructor: ${escapeHtml(estado.params.instructor.nombre)}<br>
      Aprendices: ${estado.totalAprendices}</p>`}
    <p><strong>Actas generadas:</strong> ${estado.actas.length}</p>
    <ul>${estado.actas.map(a => `<li>${escapeHtml(a)}${estado.actasSinPdf.includes(a) ? ' <span class="aviso">sin PDF</span>' : ""}</li>`).join("") || "<li><em>ninguna</em></li>"}</ul>
    ${estado.estadoFicha ? `<p><strong>Estado de la ficha:</strong> aprendices migrados: ${estado.estadoFicha.aprendices_migrados ? "sí" : "no"}</p>` : ""}
    ${estado.errorEstado ? `<p class="error-texto">${escapeHtml(estado.errorEstado)}</p>` : ""}
  `;
  panelDetalle.hidden = false;
}
el("btn-cerrar-detalle").addEventListener("click", () => { panelDetalle.hidden = true; });

el("btn-cambiar-carpeta").addEventListener("click", async () => {
  const nueva = await window.actas.elegirCarpetaTrimestre();
  if (nueva) { carpetaTrimestre = nueva; rutaTrimestreSpan.textContent = nueva; await cargarFichas(); }
});

// ===== Modo prueba =====
// Con el modo prueba prendido: la carpeta del trimestre pasa a ser la ficha
// de demostración (fichas:listar la recibe igual que cualquier otra, así
// que TODAS las acciones —generar actas, entrega, equipo ejecutor,
// revertir, convertir a PDF— quedan automáticamente dentro del sandbox, sin
// tener que tocarlas una por una). "Inicializar trimestre" es la única
// excepción: se deshabilita (ver bloquearSiModoPrueba en ipc.js) porque
// implica elegir carpetas o archivos reales por diálogo nativo del sistema,
// algo que el modo prueba no puede aislar.

function aplicarEstadoModoPrueba(activo) {
  el("banner-modo-prueba").hidden = !activo;
  el("chk-modo-prueba").checked = activo;
  el("btn-init-crear").disabled = activo;
  el("btn-init-migrar").disabled = activo;
}

el("chk-modo-prueba").addEventListener("change", async e => {
  const activo = await window.actas.alternarModoPrueba(e.target.checked);
  aplicarEstadoModoPrueba(activo);
  carpetaTrimestre = await window.actas.obtenerCarpetaTrimestre();
  rutaTrimestreSpan.textContent = carpetaTrimestre || "Sin carpeta del trimestre seleccionada";
  await cargarFichas();
});

el("btn-restablecer-prueba").addEventListener("click", async () => {
  if (!confirm("¿Restablecer el modo prueba? Borra todo lo generado en la demostración y la arma de nuevo desde cero. Esto NUNCA toca datos reales."))
    return;
  await window.actas.restablecerModoPrueba();
  await cargarFichas();
  agregarResultado("Modo prueba", `<p class="exito-texto">Restablecido: la ficha de demostración vuelve a empezar de cero.</p>`);
});

// ===== Modal genérico de vista previa / aprobación =====

const modalOverlay = el("modal-overlay");
function mostrarModal(titulo, contenidoHtml) {
  el("modal-titulo").textContent = titulo;
  el("modal-contenido").innerHTML = contenidoHtml;
  modalOverlay.hidden = false;
}
function cerrarModal() { modalOverlay.hidden = true; }
el("modal-cancelar").addEventListener("click", cerrarModal);

// Flujo uniforme: vista previa (simular:true) -> el instructor aprueba ->
// recién ahí se ejecuta de verdad (simular:false). Ninguna acción salta este
// paso. `renderizar` recibe el resultado (de la previa o de lo real) y
// devuelve el HTML a mostrar; se usa para el modal Y para el panel de
// resultados, así la vista previa y lo que realmente pasó se leen igual.
function ejecutarConVistaPrevia({ titulo, obtenerResultado, renderizar }) {
  return new Promise(resolve => {
    (async () => {
      const previa = await obtenerResultado(true);
      mostrarModal(titulo, renderizar(previa));
      el("modal-aprobar").onclick = async () => {
        cerrarModal();
        const real = await obtenerResultado(false);
        agregarResultado(titulo, renderizar(real));
        resolve(real);
      };
    })();
  });
}

function agregarResultado(titulo, html) {
  const bloque = document.createElement("div");
  bloque.className = "resultado-bloque";
  bloque.innerHTML = `<h3>${escapeHtml(titulo)} — ${new Date().toLocaleTimeString("es-CO")}</h3>${html}`;
  resultadosDiv.prepend(bloque);
}

// ===== Renderizado de cada tipo de resultado =====

function renderizarPorFicha(lista, comoCaso) {
  return lista.map(item => {
    const fichaInfo = fichas.find(f => f.carpeta === item.carpeta);
    const nombre = fichaInfo ? fichaInfo.nombreCarpeta : item.carpeta;
    if (item.error) return `<p><strong>${escapeHtml(nombre)}</strong>: <span class="error-texto">${escapeHtml(item.error)}</span></p>`;
    return `<div><p><strong>${escapeHtml(nombre)}</strong></p>${comoCaso(item)}</div>`;
  }).join("<hr>");
}

function renderizarResumenActas(resumen) {
  if (resumen.omitida) return `<p>${escapeHtml(resumen.mensaje)}</p>`;
  const partes = [];
  if (resumen.avisos?.length) partes.push(`<p>${resumen.avisos.map(a => `<span class="aviso">${escapeHtml(a)}</span>`).join(" ")}</p>`);
  if (resumen.casos.length) {
    partes.push("<ul>" + resumen.casos.map(c => `<li><strong>${escapeHtml(c.aprendiz)}</strong> → <span class="caso-medida">${escapeHtml(etiquetaMedida(c.medida))}</span>${c.avisos?.length ? "<br>" + c.avisos.map(a => `<span class="aviso">${escapeHtml(a)}</span>`).join("<br>") : ""}</li>`).join("") + "</ul>");
  } else {
    partes.push("<p><em>Sin novedades: no se generó ninguna acta.</em></p>");
  }
  if (resumen.omitidos?.length) partes.push(`<p>${resumen.omitidos.length} aprendiz(ces) omitido(s) por su estado.</p>`);
  if (resumen.errores?.length) partes.push(`<p class="error-texto">${resumen.errores.map(escapeHtml).join("<br>")}</p>`);
  return partes.join("");
}

el("btn-generar-actas").addEventListener("click", () => ejecutarConVistaPrevia({
  titulo: "Generar actas",
  obtenerResultado: simular => window.actas.generarActas([...seleccionadas], { simular }),
  renderizar: lista => renderizarPorFicha(lista, item => renderizarResumenActas(item.resumen)),
}));

function renderizarResumenEntrega(resumen) {
  if (resumen.omitida) return `<p>${escapeHtml(resumen.mensaje)}</p>`;
  const c = resumen.casos?.[0];
  if (!c) return "<p><em>Sin datos.</em></p>";
  const partes = [`<p><span class="caso-medida">${escapeHtml(etiquetaMedida(c.medida))}</span></p>`];
  if (c.avisos?.length) partes.push(c.avisos.map(a => `<p class="aviso">${escapeHtml(a)}</p>`).join(""));
  partes.push(`<p><strong>${c.evaluados}</strong> aprendiz(ces) evaluado(s) en SOFIA, <strong>${c.no_evaluados}</strong> sin evaluar.</p>`);
  if (c.panorama) partes.push("<table><thead><tr><th>Estado</th><th>Cantidad</th></tr></thead><tbody>" +
    c.panorama.map(p => `<tr><td>${escapeHtml(p.estado)}</td><td>${escapeHtml(p.cantidad)}</td></tr>`).join("") + "</tbody></table>");
  if (c.medidas_texto) partes.push(`<p>${escapeHtml(c.medidas_texto)}</p>`);
  if (c.inasistencias_texto) partes.push(`<p>${escapeHtml(c.inasistencias_texto)}</p>`);
  if (c.archivo) partes.push(`<p class="exito-texto">Generada: ${escapeHtml(c.archivo)} (acta ${escapeHtml(c.acta)})</p>`);
  return partes.join("");
}

el("btn-generar-entrega").addEventListener("click", () => ejecutarConVistaPrevia({
  titulo: "Acta de entrega de ficha",
  obtenerResultado: simular => window.actas.generarEntrega([...seleccionadas], { simular }),
  renderizar: lista => renderizarPorFicha(lista, item => renderizarResumenEntrega(item.resumen)),
}));

el("btn-convertir-pdf").addEventListener("click", () => ejecutarConVistaPrevia({
  titulo: "Convertir a PDF",
  obtenerResultado: simular => window.actas.convertirPdf([...seleccionadas], { simular }),
  renderizar: lista => renderizarPorFicha(lista, item => {
    const r = item.resultado;
    if (r.pendientes) return r.pendientes.length ? `<ul>${r.pendientes.map(p => `<li>${escapeHtml(p)}</li>`).join("")}</ul>` : "<p><em>No hay .docx pendientes de convertir.</em></p>";
    return `<p class="exito-texto">${r.convertidos.length} convertido(s).</p>${r.errores.length ? `<p class="error-texto">${r.errores.map(escapeHtml).join("<br>")}</p>` : ""}${r.avisos?.length ? r.avisos.map(a => `<p class="aviso">${escapeHtml(a)}</p>`).join("") : ""}`;
  }),
}));

// ===== Acta de equipo ejecutor =====

el("ee-btn-horario").addEventListener("click", async () => {
  const ruta = await window.actas.elegirHorarioPdf();
  if (ruta) el("ee-horario").value = ruta;
});

el("btn-generar-equipo-ejecutor").addEventListener("click", () => {
  const carpeta = unicaSeleccionada();
  if (!carpeta) return;
  const rutaHorarioPdf = el("ee-horario").value.trim();
  const horaInicio = el("ee-hora-inicio").value.trim(), horaFin = el("ee-hora-fin").value.trim();
  if (!rutaHorarioPdf || !horaInicio || !horaFin) { alert("Faltan el horario en PDF, la hora de inicio o la hora de fin."); return; }
  const opciones = {
    carpeta, rutaHorarioPdf, horaInicio, horaFin,
    fecha: el("ee-fecha").value.trim() || undefined,
    lugar: el("ee-lugar").value.trim() || undefined,
    sintesis: el("ee-sintesis").value.trim() || undefined,
  };
  ejecutarConVistaPrevia({
    titulo: "Acta de equipo ejecutor",
    obtenerResultado: simular => window.actas.generarEquipoEjecutor({ ...opciones, simular }),
    renderizar: ({ error, resultado }) => {
      if (error) return `<p class="error-texto">${escapeHtml(error)}</p>`;
      const partes = [];
      if (resultado.avisos?.length) partes.push(resultado.avisos.map(a => `<p class="aviso">${escapeHtml(a)}</p>`).join(""));
      if (resultado.filas) {
        partes.push("<table><thead><tr><th>Instructor</th><th>Competencia</th><th>Novedades</th></tr></thead><tbody>" +
          resultado.filas.map(f => `<tr><td>${escapeHtml(f.instructor)}</td><td>${escapeHtml(f.competencia)}</td><td>${escapeHtml(f.novedades) || "<em>vacío, para diligenciar en la reunión</em>"}</td></tr>`).join("") +
          "</tbody></table>");
      }
      if (resultado.archivo) partes.push(`<p class="exito-texto">Generada: ${escapeHtml(resultado.archivo)}</p>`);
      return partes.join("");
    },
  });
});

// ===== Revertir =====

el("btn-revertir").addEventListener("click", () => {
  const carpeta = unicaSeleccionada();
  if (!carpeta) return;
  const fecha = el("rev-fecha").value;
  if (!fecha) { alert("Elige una fecha."); return; }
  ejecutarConVistaPrevia({
    titulo: "Revertir",
    obtenerResultado: simular => window.actas.revertir(carpeta, fecha, { simular }),
    renderizar: ({ error, resultado }) => {
      if (error) return `<p class="error-texto">${escapeHtml(error)}</p>`;
      if (resultado.mensaje) return `<p><em>${escapeHtml(resultado.mensaje)}</em></p>`;
      const notaPdf = item => item.pdf ? " — también se borrará su PDF" : "";
      const partes = [`<p>${resultado.actasRevertidas.length} acta(s) a revertir`
        + (resultado.entregaRevertida ? ` + acta de entrega${notaPdf(resultado.entregaRevertida)}` : "")
        + (resultado.equipoEjecutorRevertido.length ? ` + ${resultado.equipoEjecutorRevertido.length} acta(s) de equipo ejecutor` : "")
        + ".</p>"];
      partes.push("<ul>" + resultado.actasRevertidas.map(a => `<li>${escapeHtml(a.aprendiz)} — ${escapeHtml(etiquetaMedida(a.tipo))} (acta ${escapeHtml(a.numero)})${notaPdf(a)}</li>`).join("") + "</ul>");
      if (resultado.equipoEjecutorRevertido.length)
        partes.push("<ul>" + resultado.equipoEjecutorRevertido.map(e => `<li>Acta de equipo ejecutor ${escapeHtml(e.numero)} (${escapeHtml(e.fecha)})${e.ruta ? "" : " — sin ruta guardada, borrar el .docx a mano"}${notaPdf(e)}</li>`).join("") + "</ul>");
      partes.push(`<p>Consecutivo: ${resultado.consecutivoAntes} → ${resultado.consecutivoDespues}${resultado.simulado ? " (si apruebas)" : ""}.</p>`);
      if (resultado.avisos?.length) partes.push(resultado.avisos.map(a => `<p class="aviso">${escapeHtml(a)}</p>`).join(""));
      if (!resultado.simulado) partes.push(`<p class="exito-texto">${resultado.archivosBorrados.length} archivo(s) borrado(s) de verdad${resultado.pdfsBorrados.length ? ` (+ ${resultado.pdfsBorrados.length} PDF)` : ""}. Respaldos: ${resultado.respaldos.map(escapeHtml).join(", ")}</p>`);
      return partes.join("");
    },
  });
});

// ===== Inicializar trimestre =====

el("btn-init-crear").addEventListener("click", async () => {
  const nombre = el("init-nombre").value.trim();
  if (!nombre) { alert("Escribe el nombre de la carpeta de la ficha."); return; }
  const carpetaDestino = await window.actas.elegirCarpetaDestinoFicha();
  if (!carpetaDestino) return;
  const r = await window.actas.crearControlDesdeplantilla({ carpetaDestino, nombreCarpeta: nombre });
  agregarResultado("Crear control desde la plantilla", r.error
    ? `<p class="error-texto">${escapeHtml(r.error)}</p>`
    : `<p class="exito-texto">Creado en ${escapeHtml(r.rutaControl)}. Se abrió en Excel: llena PARAMETROS y guarda antes del paso 2.</p>`);
  if (!r.error) await cargarFichas();
});

el("init-btn-sofia").addEventListener("click", async () => {
  const ruta = await window.actas.elegirReporteSofia();
  if (ruta) el("init-sofia").value = ruta;
});

el("btn-init-migrar").addEventListener("click", () => {
  const carpeta = unicaSeleccionada();
  if (!carpeta) return;
  const rutaReporteSofia = el("init-sofia").value.trim();
  if (!rutaReporteSofia) { alert("Elige el reporte de SOFIA."); return; }
  ejecutarConVistaPrevia({
    titulo: "Migrar aprendices desde SOFIA",
    obtenerResultado: simular => window.actas.migrarAprendices({ carpeta, rutaReporteSofia, simular }),
    renderizar: ({ error, aprendices, advertencias, resultado }) => {
      if (error) return `<p class="error-texto">${escapeHtml(error)}</p>`;
      const partes = [`<p>${aprendices.length} aprendiz(ces) en el reporte.</p>`];
      if (advertencias?.length) partes.push(`<ul>${advertencias.map(a => `<li class="aviso">${escapeHtml(a)}</li>`).join("")}</ul>`);
      if (resultado.avisoSobrescritura) partes.push(`<p class="aviso">${escapeHtml(resultado.avisoSobrescritura)}</p>`);
      if (resultado.respaldo) partes.push(`<p class="exito-texto">Migrado. Respaldo: ${escapeHtml(resultado.respaldo)}</p>`);
      return partes.join("");
    },
  });
});

// ===== Activación por clave =====
// El código de instructor (numeración compuesta de actas: 951210-XX-NNN)
// ya no es un campo libre: sale de la activación, se muestra de solo
// lectura en el header (#info-instructor) una vez activada la instalación.

const overlayActivacion = el("overlay-activacion");
const infoInstructor = el("info-instructor");
const actError = el("act-error");

function mostrarInfoInstructor(activacion) {
  infoInstructor.textContent = `${activacion.nombre} (${activacion.codigoInstructor})`;
}

el("act-btn-activar").addEventListener("click", async () => {
  actError.hidden = true;
  const datos = {
    nombre: el("act-nombre").value,
    documento: el("act-documento").value,
    correo: el("act-correo").value,
    codigoInstructor: el("act-codigo").value,
    clave: el("act-clave").value,
  };
  const r = await window.actas.activar(datos);
  if (!r.ok) { actError.textContent = r.error; actError.hidden = false; return; }
  // Más simple y más seguro que replicar acá todo lo que hace el arranque:
  // recargar la ventana y dejar que arranque().
  location.reload();
});

// ===== Arranque =====

async function arrancar() {
  const estado = await window.actas.obtenerEstadoActivacion();
  if (!estado.activado) { overlayActivacion.hidden = false; return; } // tapa TODO: nada más se carga hasta activar
  mostrarInfoInstructor(estado.activacion);

  aplicarEstadoModoPrueba(await window.actas.obtenerModoPrueba());
  carpetaTrimestre = await window.actas.obtenerCarpetaTrimestre();
  if (carpetaTrimestre) { rutaTrimestreSpan.textContent = carpetaTrimestre; await cargarFichas(); }
}
arrancar();
