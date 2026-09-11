// src/main/main.js — punto de entrada de la aplicación de escritorio.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

require("./ipc"); // registra todos los ipcMain.handle(...); ver ese archivo

// Registra la actividad de autoUpdater en un archivo de texto plano, SIN
// mostrarle nada al instructor (eso lo sigue haciendo autoUpdater solo,
// con su notificación nativa cuando de verdad hay algo instalado y listo
// — ver más abajo). Antes, el único rastro era un .catch() vacío: si un
// compañero decía "no se me actualizó", no había forma de saber si nunca
// llegó a chequear, si chequeó y no había nada nuevo, o si encontró algo
// y falló a mitad de camino. Mejor esfuerzo, mudo: si ni este archivo se
// puede escribir, no hay nada más que hacer, y no debe cortar el chequeo
// de actualización por esto.
function registrarLogActualizacion(mensaje) {
  try {
    const linea = `${new Date().toISOString()} ${mensaje}\n`;
    fs.appendFileSync(path.join(app.getPath("userData"), "actualizaciones.log"), linea, "utf8");
  } catch { /* no hay nada más que hacer si ni esto se puede escribir */ }
}

let ventana;

function crearVentana() {
  ventana = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, // el renderer nunca comparte contexto de JS con Node
      nodeIntegration: false, // el renderer nunca tiene require/fs directo
      sandbox: true,
    },
  });
  ventana.setMenuBarVisibility(false); // sin menú de Chromium: no aporta nada aquí
  ventana.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

app.whenReady().then(() => {
  crearVentana();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) crearVentana(); });

  // Actualizaciones automáticas desde GitHub Releases (electron-builder ya
  // publica ahí). Sin efecto en desarrollo (app.isPackaged es false salvo
  // corriendo el .exe instalado); ahí es donde de verdad se puede probar.
  // Repositorio público: publicar un release instala esa versión sola en
  // todos los equipos (ver README.md, "Publicar una nueva versión").
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require("electron-updater");

      // Último progreso recibido, para poder loguear los bytes junto con
      // "descargada" al final (pedido explícito: no hace falta una línea
      // por cada avance, solo el total al terminar) — así se puede
      // comparar contra el tamaño completo del instalador y ver si la
      // descarga diferencial por blockmap está funcionando de verdad.
      let ultimoProgreso = null;
      autoUpdater.on("checking-for-update", () => registrarLogActualizacion("Buscando actualizaciones..."));
      autoUpdater.on("update-available", info => registrarLogActualizacion(`Versión nueva disponible: ${info.version}. Empieza a descargarla.`));
      autoUpdater.on("update-not-available", () => registrarLogActualizacion("Sin actualizaciones: ya está en la última versión publicada."));
      autoUpdater.on("download-progress", p => { ultimoProgreso = p; });
      autoUpdater.on("update-downloaded", info => {
        const bytes = ultimoProgreso
          ? ` (${ultimoProgreso.transferred} de ${ultimoProgreso.total} bytes descargados, ${ultimoProgreso.percent.toFixed(1)}%)`
          : "";
        registrarLogActualizacion(`Actualización descargada: versión ${info.version}${bytes}. Se instalará sola al cerrar la app.`);
      });
      autoUpdater.on("error", e => registrarLogActualizacion(`Error de autoUpdater: ${(e && e.message) || e}`));

      autoUpdater.checkForUpdatesAndNotify().catch(e => registrarLogActualizacion(`checkForUpdatesAndNotify falló: ${(e && e.message) || e}`));
    } catch (e) { registrarLogActualizacion(`electron-updater no disponible: ${(e && e.message) || e}`); }
  }
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
