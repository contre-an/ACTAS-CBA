// src/main/configuracion.js — preferencias del instructor entre sesiones
// (hoy: la carpeta del trimestre elegida, para no volver a elegirla cada
// vez). Vive en userData (perfil del usuario de Windows), no en el repo:
// es local de esta instalación, no del proyecto.
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

function rutaConfiguracion() {
  return path.join(app.getPath("userData"), "configuracion.json");
}

function cargarConfiguracion() {
  try { return JSON.parse(fs.readFileSync(rutaConfiguracion(), "utf8")); }
  catch { return {}; }
}

function guardarConfiguracion(config) {
  fs.writeFileSync(rutaConfiguracion(), JSON.stringify(config, null, 2));
}

module.exports = { cargarConfiguracion, guardarConfiguracion };
