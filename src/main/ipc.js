// src/main/ipc.js — único lugar donde la interfaz toca los módulos de
// lógica. El renderer JAMÁS llama a estas funciones directamente (no tiene
// Node ni fs): pasa siempre por preload.js -> ipcRenderer.invoke -> aquí.
//
// Convención pareja en todas las acciones que generan o borran algo:
// reciben { simular } y devuelven exactamente lo que ya devuelve el módulo
// correspondiente (resumen con casos/avisos/errores) — no se inventa un
// formato de "vista previa" distinto del real: es la misma función, con
// simular:true o simular:false. Así la interfaz siempre muestra la verdad
// de lo que pasaría.
const { ipcMain, dialog, shell } = require("electron");
const fs = require("fs");
const path = require("path");

const RAIZ = path.join(__dirname, "..", "..");
const requerir = nombre => require(path.join(RAIZ, nombre));

const { procesarControl, generarEntregaControl, leerControl } = requerir("procesar");
const { leerReporteSofia, poblarAprendices } = requerir("sofia");
const { leerHorario } = requerir("horario");
const { prepararActaEquipoEjecutor } = requerir("equipo_ejecutor");
const { revertirFecha, buscarControlEnCarpeta } = requerir("revertir");
const { convertirPdf, wordInstalado } = requerir("convertir_pdf");
const { estadoNuevo, guardarEstado, cargarEstado } = requerir("estado");
const { cargarConfiguracion, guardarConfiguracion } = require("./configuracion");
const modoPrueba = require("./modoPrueba");
const { resolverRutaRegistro, obtenerAvisoRegistro } = requerir("rutaRegistro");
const activacion = requerir("activacion");

const RUTA_PLANTILLA_MAESTRA = path.join(RAIZ, "PLANTILLA_MAESTRA_CONTROL_ASISTENCIA V3.xlsx");

// Fija, antes de CUALQUIER acción que toque el registro o genere actas
// numeradas, las variables de entorno que generar.js/revertir.js leen:
// - ACTAS_CODIGO_INSTRUCTOR para el número compuesto (numeroActa() en
//   generar.js) — SOLO se fija si hay una activación válida ahora mismo
//   (se recalcula el HMAC en cada llamado, ver activacion.estadoActivacion:
//   punto 2 del encargo, no alcanza con haber activado alguna vez). Si no,
//   se corta con un error ANTES de tocar nada: esta es la guarda dura del
//   lado del proceso principal — la pantalla de activación del renderer es
//   la primera línea, pero un renderer con devtools no debería poder
//   saltearla, así que también se exige acá.
// - ACTAS_REGISTRO_RUTA: con el modo prueba prendido, apunta a
//   registro.pruebas.json (userData/modo_prueba/), NUNCA al registro.json
//   real — es lo único que de verdad separa las dos cosas. Con el modo
//   prueba apagado, se borra la variable y todo vuelve al registro.json de
//   siempre.
// Se relee la configuración en cada llamado, no solo al arrancar la app,
// porque la activación o el modo prueba pueden cambiar sin reiniciar la
// ventana.
function aplicarVariablesDeEntorno() {
  const config = cargarConfiguracion();

  const secreto = activacion.resolverSecreto();
  const estado = activacion.estadoActivacion(config, secreto);
  if (!estado.activado) {
    delete process.env.ACTAS_CODIGO_INSTRUCTOR;
    throw new Error("La aplicación no está activada (o la activación guardada ya no es válida). Recargá la ventana y activá con tu clave antes de continuar.");
  }
  process.env.ACTAS_CODIGO_INSTRUCTOR = estado.activacion.codigoInstructor;

  if (config.modoPrueba) process.env.ACTAS_REGISTRO_RUTA = modoPrueba.rutaRegistroPruebas();
  else delete process.env.ACTAS_REGISTRO_RUTA;

  avisarSobreRegistroSiHaceFalta();
}

// Envuelve aplicarVariablesDeEntorno() para los handlers que devuelven un
// arreglo (uno por carpeta): si no hay activación válida, en vez de dejar
// que el error tumbe la promesa de ipcMain.handle (el renderer no lo
// esperaría en ese formato), se devuelve el mismo shape {carpeta, error}
// que ya usa cada acción para un fallo individual, una entrada por carpeta.
function prepararOFallarPorCarpeta(carpetas) {
  try { aplicarVariablesDeEntorno(); return null; }
  catch (e) { return carpetas.map(carpeta => ({ carpeta, error: e.message })); }
}
// Misma idea para los handlers de una sola carpeta.
function prepararOFallar(carpeta) {
  try { aplicarVariablesDeEntorno(); return null; }
  catch (e) { return { carpeta, error: e.message }; }
}

// Diálogo nativo, una sola vez por sesión de la app: rutaRegistro.js resuelve
// (y, la primera vez, migra) registro.json de forma perezosa — recién en el
// primer llamado sin ACTAS_REGISTRO_RUTA (es decir, con el modo prueba
// apagado). Acá se fuerza esa resolución y, si hay algo que avisar
// (duplicado sin resolver, o migración que no se pudo confirmar), se
// muestra un diálogo modal en vez de dejarlo enterrado en un log.
let avisoRegistroMostrado = false;
function avisarSobreRegistroSiHaceFalta() {
  if (process.env.ACTAS_REGISTRO_RUTA || avisoRegistroMostrado) return;
  resolverRutaRegistro();
  const aviso = obtenerAvisoRegistro();
  if (!aviso) return;
  avisoRegistroMostrado = true;

  if (aviso.tipo === "duplicado") {
    dialog.showMessageBox({
      type: "warning",
      title: "Dos registros de actas encontrados",
      message: "Hay dos registros de actas en este computador.",
      detail: `En uso ahora: ${aviso.rutaUsada}\n` +
        `Sin usar, no se tocó: ${aviso.rutaSinUsar}\n\n` +
        `Antes de decidir cuál es el correcto, compará cuál tiene más actas ` +
        `(el número de "consecutivo" o cuántas fichas hay en "aprendices" de cada archivo). ` +
        `Si el que está en uso no es el correcto, reemplazalo a mano por el otro.`,
    });
  } else if (aviso.tipo === "fallo_migracion") {
    dialog.showMessageBox({
      type: "error",
      title: "No se pudo migrar el registro de actas",
      message: "No se pudo copiar registro.json a la nueva ubicación.",
      detail: `Se sigue usando el de la carpeta de la app para no arriesgar el consecutivo.\n\n` +
        `Origen: ${aviso.rutaVieja}\n` +
        `Destino que falló: ${aviso.rutaNuevaFallida}\n` +
        `Motivo: ${aviso.motivo}\n\n` +
        `Revisá permisos de escritura en esa carpeta, o copialo a mano.`,
    });
  }
}

// La carpeta del trimestre "de verdad" según el modo actual: la ficticia de
// demostración con el modo prueba prendido (se crea sola la primera vez),
// la real configurada por el instructor si no.
function carpetaTrimestreEfectiva() {
  const config = cargarConfiguracion();
  if (config.modoPrueba) { modoPrueba.asegurarFichaDemo(); return modoPrueba.rutaTrimestreDemo(); }
  return config.carpetaTrimestre || null;
}

// ===== Modo prueba =====

ipcMain.handle("modoPrueba:obtener", () => !!cargarConfiguracion().modoPrueba);

ipcMain.handle("modoPrueba:alternar", (_e, activo) => {
  guardarConfiguracion({ ...cargarConfiguracion(), modoPrueba: !!activo });
  if (activo) modoPrueba.asegurarFichaDemo();
  return !!activo;
});

ipcMain.handle("modoPrueba:restablecer", () => {
  modoPrueba.restablecer();
  return true;
});

// ===== Config: carpeta del trimestre y código de instructor, recordados entre sesiones =====

ipcMain.handle("config:obtener-carpeta-trimestre", () => carpetaTrimestreEfectiva());

ipcMain.handle("config:elegir-carpeta-trimestre", async () => {
  const r = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Carpeta del trimestre" });
  if (r.canceled || !r.filePaths.length) return null;
  const carpeta = r.filePaths[0];
  guardarConfiguracion({ ...cargarConfiguracion(), carpetaTrimestre: carpeta });
  return carpeta;
});

// ===== Activación por clave (ver activacion.js) =====
// El código de instructor YA NO es un campo libre editable en cualquier
// momento: queda fijado, junto con el nombre validado contra la clave, en
// configuracion.json.activacion — se escribe una sola vez al activar
// (activacion:activar) y de ahí en más solo se lee.

ipcMain.handle("activacion:estado", () => {
  const secreto = activacion.resolverSecreto();
  return activacion.estadoActivacion(cargarConfiguracion(), secreto);
});

ipcMain.handle("activacion:activar", (_e, datos) => {
  const secreto = activacion.resolverSecreto();
  const resultado = activacion.intentarActivar(datos, secreto);
  if (resultado.ok) guardarConfiguracion({ ...cargarConfiguracion(), activacion: resultado.activacion });
  return resultado;
});

// ===== Fichas: listar subcarpetas del trimestre, leer su estado básico =====

ipcMain.handle("fichas:listar", (_e, carpetaTrimestre) => {
  if (!fs.existsSync(carpetaTrimestre)) return [];
  return fs.readdirSync(carpetaTrimestre, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const carpeta = path.join(carpetaTrimestre, d.name);
      try {
        const rutaControl = buscarControlEnCarpeta(carpeta);
        const { params } = leerControl(rutaControl);
        return { carpeta, nombreCarpeta: d.name, ficha: params.ficha, programa: params.programa, competencia: params.competencia, instructor: params.instructor.nombre, tieneControl: true };
      } catch (e) {
        return { carpeta, nombreCarpeta: d.name, tieneControl: false, error: e.message };
      }
    });
});

ipcMain.handle("ficha:abrir-carpeta", (_e, carpeta) => shell.openPath(carpeta));

// ===== Estado por ficha (lectura, no dispara nada) =====

ipcMain.handle("ficha:estado", (_e, carpeta) => {
  const resultado = { carpeta };
  try {
    const rutaControl = buscarControlEnCarpeta(carpeta);
    const { params, aprendices } = leerControl(rutaControl);
    resultado.params = params;
    resultado.totalAprendices = aprendices.length;
  } catch (e) { resultado.errorControl = e.message; }

  const carpetaActas = path.join(carpeta, "LLAMADOS DE ATENCION");
  resultado.actas = fs.existsSync(carpetaActas)
    ? fs.readdirSync(carpetaActas).filter(f => !f.startsWith("~$"))
    : [];
  resultado.actasSinPdf = resultado.actas.filter(f => /\.docx$/i.test(f) && !fs.existsSync(path.join(carpetaActas, f.replace(/\.docx$/i, ".pdf"))));

  try {
    const estadoFicha = cargarEstado(carpeta);
    if (estadoFicha) resultado.estadoFicha = estadoFicha;
  } catch (e) { resultado.errorEstado = e.message; }
  return resultado;
});

// ===== Generar actas (llamados / plan / comité — la medida la decide el
// sistema mirando el historial, no la elige quien aprieta el botón) =====

ipcMain.handle("actas:generar", (_e, carpetas, opciones) => {
  const fallo = prepararOFallarPorCarpeta(carpetas);
  if (fallo) return fallo;
  const { simular } = opciones;
  return carpetas.map(carpeta => {
    try {
      const rutaControl = buscarControlEnCarpeta(carpeta);
      return { carpeta, resumen: procesarControl(rutaControl, false, simular) };
    } catch (e) { return { carpeta, error: e.message }; }
  });
});

// ===== Acta de entrega de ficha =====

ipcMain.handle("entrega:generar", (_e, carpetas, opciones) => {
  const fallo = prepararOFallarPorCarpeta(carpetas);
  if (fallo) return fallo;
  const { simular } = opciones;
  return carpetas.map(carpeta => {
    try {
      const rutaControl = buscarControlEnCarpeta(carpeta);
      return { carpeta, resumen: generarEntregaControl(rutaControl, simular) };
    } catch (e) { return { carpeta, error: e.message }; }
  });
});

// ===== Acta de equipo ejecutor =====

ipcMain.handle("equipoEjecutor:elegirHorario", async () => {
  const r = await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "PDF", extensions: ["pdf"] }], title: "Horario de la ficha (PDF)" });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

ipcMain.handle("equipoEjecutor:generar", async (_e, opciones) => {
  const { carpeta, rutaHorarioPdf, horaInicio, horaFin, fecha, lugar, sintesis, simular } = opciones;
  const fallo = prepararOFallar(carpeta);
  if (fallo) return fallo;
  try {
    const rutaControl = buscarControlEnCarpeta(carpeta);
    const resultado = await prepararActaEquipoEjecutor(
      { rutaHorarioPdf, rutaControlPropio: rutaControl, carpetaSalida: carpeta, horaInicio, horaFin, fecha, lugar, sintesis },
      { simular }
    );
    return { carpeta, resultado };
  } catch (e) { return { carpeta, error: e.message }; }
});

// ===== Convertir a PDF =====

ipcMain.handle("pdf:wordInstalado", () => wordInstalado());

ipcMain.handle("pdf:convertir", (_e, carpetas, opciones) => {
  const { simular } = opciones;
  return carpetas.map(carpeta => {
    try { return { carpeta, resultado: convertirPdf(carpeta, { simular }) }; }
    catch (e) { return { carpeta, error: e.message }; }
  });
});

// ===== Revertir =====

ipcMain.handle("revertir:ejecutar", (_e, carpeta, fecha, opciones) => {
  const fallo = prepararOFallar(carpeta);
  if (fallo) return fallo;
  const { simular } = opciones;
  try { return { carpeta, resultado: revertirFecha(carpeta, fecha, { simular }) }; }
  catch (e) { return { carpeta, error: e.message }; }
});

// ===== Inicializar trimestre =====
// Paso A: crear la carpeta de la ficha y copiar la plantilla en blanco.
// El instructor la abre y llena PARAMETROS a mano (ficha, competencia,
// instructor: un control es de un solo instructor y una sola competencia).
//
// Deshabilitado con el modo prueba prendido: a diferencia de las demás
// acciones (que operan sobre la carpeta que ya devolvió fichas:listar, y
// esa carpeta es la de demostración cuando el modo prueba está prendido),
// "inicializar trimestre" deja que el instructor elija CUALQUIER carpeta
// real por un diálogo nativo del sistema operativo — es el único punto
// donde el modo prueba no puede garantizar que nada real se toque, así que
// se bloquea en vez de arriesgarse.
function bloquearSiModoPrueba() {
  if (cargarConfiguracion().modoPrueba)
    throw new Error("Inicializar trimestre está deshabilitado en modo prueba: implica elegir carpetas reales del computador. Apaga el modo prueba para usarlo.");
}

ipcMain.handle("inicializar:elegirCarpetaDestino", async () => {
  const r = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Carpeta donde crear la ficha" });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

ipcMain.handle("inicializar:crearControl", (_e, { carpetaDestino, nombreCarpeta }) => {
  try {
    bloquearSiModoPrueba();
    const carpetaFicha = path.join(carpetaDestino, nombreCarpeta);
    fs.mkdirSync(carpetaFicha, { recursive: true });
    const rutaControl = path.join(carpetaFicha, `CONTROL_ASISTENCIA_${nombreCarpeta}.xlsx`);
    if (fs.existsSync(rutaControl)) return { error: `Ya existe ${path.basename(rutaControl)} en esa carpeta.` };
    fs.copyFileSync(RUTA_PLANTILLA_MAESTRA, rutaControl);
    shell.openPath(rutaControl); // el instructor llena PARAMETROS a mano, en Excel
    return { carpetaFicha, rutaControl };
  } catch (e) { return { error: e.message }; }
});

// Paso B: una vez PARAMETROS está lleno, migrar los aprendices desde SOFIA.

ipcMain.handle("inicializar:elegirReporteSofia", async () => {
  const r = await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "Reporte de SOFIA", extensions: ["xls", "xlsx"] }], title: "Reporte de aprendices de SOFIA" });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

ipcMain.handle("inicializar:migrarAprendices", (_e, { carpeta, rutaReporteSofia, simular }) => {
  try {
    // Se bloquea también en vista previa: aunque el destino sea la ficha de
    // demostración (segura), el reporte de SOFIA se elige con un diálogo de
    // archivo sin restricciones — podría ser un reporte real, con nombres
    // reales, y terminaría metido en una demostración.
    bloquearSiModoPrueba();
    const rutaControl = buscarControlEnCarpeta(carpeta);
    const { ficha, aprendices, advertencias } = leerReporteSofia(rutaReporteSofia);
    const resultado = poblarAprendices(rutaControl, aprendices, { simular });
    if (!simular) {
      const estado = cargarEstado(carpeta) || estadoNuevo(ficha);
      estado.aprendices_migrados = true;
      estado.total_aprendices = aprendices.length;
      guardarEstado(carpeta, estado);
    }
    return { carpeta, ficha, aprendices, advertencias, resultado };
  } catch (e) { return { carpeta, error: e.message }; }
});

module.exports = {};
