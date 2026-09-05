// src/main/main.js — punto de entrada de la aplicación de escritorio.
const { app, BrowserWindow } = require("electron");
const path = require("path");

require("./ipc"); // registra todos los ipcMain.handle(...); ver ese archivo

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
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require("electron-updater");
      autoUpdater.checkForUpdatesAndNotify().catch(() => { /* sin conexión, o sin release nuevo: no es un error del usuario */ });
    } catch { /* electron-updater no configurado todavía */ }
  }
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
