#!/usr/bin/env node
// herramientas/verificar_empaquetado.js — verifica que electron-builder
// empaquete lo que debe y nada de lo que no debe. No se distribuye (no
// está en package.json -> build.files): es una herramienta de desarrollo,
// como generar_clave.js.
//
// Empaqueta de verdad en modo --dir (rápido: sin instalador NSIS), lista
// el contenido del .asar resultante con @electron/asar, y comprueba:
//   1. que todos los .js de la raíz del proyecto estén adentro
//      (build.files no se desincronizó de lo que de verdad hay hoy);
//   2. que herramientas/ (este script, generar_clave.js) NO esté en
//      ningún lado del .asar;
//   3. que secretos/ tampoco esté en el .asar, y que en resources/ (fuera
//      del .asar) solo aparezca el secreto de producción ya renombrado
//      por extraResources, sin ningún produccion.key/desarrollo.key
//      suelto sin renombrar.
//
// No necesita el secreto de producción real: si secretos/produccion.key
// no existe, genera uno ficticio SOLO para esta corrida y lo borra al
// terminar (nunca pisa uno real que ya esté ahí). Borra dist/ al
// terminar, haya salido bien o mal.
//
//   npm run verificar-empaquetado
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const asar = require("@electron/asar");

const RAIZ = path.join(__dirname, "..");
const CARPETA_SECRETOS = path.join(RAIZ, "secretos");
const RUTA_SECRETO = path.join(CARPETA_SECRETOS, "produccion.key");
const CARPETA_DIST = path.join(RAIZ, "dist");

let huboError = false;
function fallar(mensaje) {
  console.error(`✗ ${mensaje}`);
  huboError = true;
}
function ok(mensaje) { console.log(`✓ ${mensaje}`); }

function prepararSecretoFicticioSiHaceFalta() {
  if (fs.existsSync(RUTA_SECRETO)) {
    console.log("secretos/produccion.key ya existe: se usa tal cual, no se toca.\n");
    return { creado: false, carpetaCreada: false };
  }
  const carpetaCreada = !fs.existsSync(CARPETA_SECRETOS);
  fs.mkdirSync(CARPETA_SECRETOS, { recursive: true });
  fs.writeFileSync(RUTA_SECRETO, `ficticio-solo-para-verificar-empaquetado-${crypto.randomBytes(16).toString("hex")}`);
  console.log("secretos/produccion.key no existía: se generó uno ficticio SOLO para esta verificación.\n");
  return { creado: true, carpetaCreada };
}

function limpiar({ creado, carpetaCreada }) {
  if (creado && fs.existsSync(RUTA_SECRETO)) fs.rmSync(RUTA_SECRETO);
  if (carpetaCreada) {
    try {
      // Solo se borra la carpeta si quedó vacía: si ya había un
      // desarrollo.key ahí (uso normal de "npm start"), no se toca.
      if (fs.existsSync(CARPETA_SECRETOS) && fs.readdirSync(CARPETA_SECRETOS).length === 0)
        fs.rmdirSync(CARPETA_SECRETOS);
    } catch { /* no crítico: en el peor caso queda una carpeta vacía */ }
  }
  if (fs.existsSync(CARPETA_DIST)) fs.rmSync(CARPETA_DIST, { recursive: true, force: true });
}

function encontrarAsarEmpaquetado() {
  if (!fs.existsSync(CARPETA_DIST)) throw new Error(`electron-builder no generó ${CARPETA_DIST}.`);
  const candidatos = fs.readdirSync(CARPETA_DIST, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(CARPETA_DIST, d.name, "resources", "app.asar"))
    .filter(p => fs.existsSync(p));
  if (candidatos.length !== 1)
    throw new Error(`Se esperaba exactamente un app.asar bajo dist/*/resources/; se encontraron ${candidatos.length}${candidatos.length ? ": " + candidatos.join(", ") : ""}.`);
  return candidatos[0];
}

function main() {
  const secreto = prepararSecretoFicticioSiHaceFalta();
  try {
    console.log("Empaquetando (electron-builder --dir, sin instalador)... esto tarda un rato.\n");
    // El binario local directo, no "npx electron-builder": en Windows,
    // child_process.execFileSync("npx", ...) da ENOENT sin shell:true (npx
    // es en realidad npx.cmd, y Node no lo resuelve por PATH igual que una
    // terminal). electron-builder ya es devDependency: usar node_modules/.bin
    // evita depender de npx para nada.
    const binElectronBuilder = path.join(RAIZ, "node_modules", ".bin", process.platform === "win32" ? "electron-builder.cmd" : "electron-builder");
    // execSync (comando completo como un solo string), no execFileSync: en
    // Windows, un .cmd necesita un intérprete de por medio (execFileSync
    // directo da EINVAL), y execFileSync con shell:true + args por separado
    // saca un DeprecationWarning (DEP0190) por cómo se concatenan.
    // No hay entrada de usuario acá: "--dir" es fijo.
    execSync(`"${binElectronBuilder}" --dir`, { cwd: RAIZ, stdio: "inherit" });
    console.log();

    const rutaAsar = encontrarAsarEmpaquetado();
    const carpetaResources = path.dirname(rutaAsar);

    // listPackage() en Windows devuelve rutas separadas por "\": se
    // normaliza a "/" para no depender del SO al comparar.
    const contenido = asar.listPackage(rutaAsar).map(p => p.split(path.sep).join("/"));
    const nivelRaiz = new Set(
      contenido.filter(p => p.split("/").filter(Boolean).length === 1).map(p => p.replace(/^\//, ""))
    );

    // 1. Todos los .js de la raíz del proyecto deben estar en el .asar.
    const jsRaiz = fs.readdirSync(RAIZ).filter(f => f.endsWith(".js") && fs.statSync(path.join(RAIZ, f)).isFile());
    for (const f of jsRaiz) {
      if (nivelRaiz.has(f)) ok(`${f} está empaquetado.`);
      else fallar(`Falta en el empaquetado: ${f} (existe en la raíz del proyecto, pero no llegó al .asar — revisar build.files en package.json).`);
    }

    // 2. herramientas/ no debe aparecer en ningún lado del .asar.
    if (contenido.some(p => p === "/herramientas" || p.includes("/herramientas/")))
      fallar("herramientas/ quedó incluida en el .asar: es el generador de claves, NUNCA debe distribuirse.");
    else ok("herramientas/ no está en el .asar.");

    // 3. secretos/ no debe aparecer en ningún lado del .asar...
    if (contenido.some(p => p === "/secretos" || p.includes("/secretos/")))
      fallar("secretos/ quedó incluida en el .asar: nunca debe empaquetarse ahí (solo por extraResources, y renombrado).");
    else ok("secretos/ no está en el .asar.");

    // ...y en resources/ (fuera del .asar) solo debe estar lo que copia
    // extraResources, ya renombrado — nada de secretos/ suelto con su
    // nombre original.
    const rutaSecretoEmpaquetado = path.join(carpetaResources, "secreto_activacion.key");
    if (fs.existsSync(rutaSecretoEmpaquetado)) ok("resources/secreto_activacion.key presente (extraResources funcionó).");
    else fallar(`No se encontró ${rutaSecretoEmpaquetado}: extraResources no copió el secreto (revisar build.extraResources en package.json).`);

    const sueltos = fs.readdirSync(carpetaResources).filter(f => f === "produccion.key" || f === "desarrollo.key");
    if (sueltos.length) fallar(`Quedaron archivos de secretos/ sin renombrar en resources/: ${sueltos.join(", ")}.`);
    else ok("Nada de secretos/ quedó suelto sin renombrar en resources/.");
  } finally {
    limpiar(secreto);
  }

  console.log();
  if (huboError) {
    console.error("✗ Verificación de empaquetado FALLÓ (ver arriba).");
    process.exit(1);
  }
  console.log("✓ Empaquetado correcto.");
}

main();
