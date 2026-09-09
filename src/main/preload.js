// src/main/preload.js — el ÚNICO archivo que corre con acceso a Node dentro
// del contexto de la ventana, y solo para exponer, vía contextBridge, una
// API angosta y explícita. El renderer (src/renderer/app.js) no tiene fs,
// no tiene child_process, no tiene require: solo tiene window.actas.*.
const { contextBridge, ipcRenderer } = require("electron");

const invocar = canal => (...args) => ipcRenderer.invoke(canal, ...args);

contextBridge.exposeInMainWorld("actas", {
  obtenerCarpetaTrimestre: invocar("config:obtener-carpeta-trimestre"),
  elegirCarpetaTrimestre: invocar("config:elegir-carpeta-trimestre"),

  obtenerEstadoActivacion: invocar("activacion:estado"),
  activar: invocar("activacion:activar"),

  obtenerModoPrueba: invocar("modoPrueba:obtener"),
  alternarModoPrueba: invocar("modoPrueba:alternar"),
  restablecerModoPrueba: invocar("modoPrueba:restablecer"),

  listarFichas: invocar("fichas:listar"),
  abrirCarpetaFicha: invocar("ficha:abrir-carpeta"),
  estadoFicha: invocar("ficha:estado"),

  generarActas: invocar("actas:generar"),
  generarEntrega: invocar("entrega:generar"),

  elegirHorarioPdf: invocar("equipoEjecutor:elegirHorario"),
  generarEquipoEjecutor: invocar("equipoEjecutor:generar"),

  wordInstalado: invocar("pdf:wordInstalado"),
  convertirPdf: invocar("pdf:convertir"),

  revertir: invocar("revertir:ejecutar"),

  crearControlDesdeplantilla: invocar("inicializar:crearControl"),
  elegirReporteSofia: invocar("inicializar:elegirReporteSofia"),
  migrarAprendices: invocar("inicializar:migrarAprendices"),
});
