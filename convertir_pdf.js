// convertir_pdf.js — Convierte a PDF los .docx firmados que aún no tienen su
// PDF. Solución del instructor, YA PROBADA EN PRODUCCIÓN: no se rediseña,
// solo se envuelve en una función de la app.
//
// Usa Word por automatización COM (vía un script .ps1 temporal, que se borra
// al terminar), porque da fidelidad exacta con el formato GOR-F-084 — a
// diferencia de un conversor genérico. Esto significa que Word instalado es
// la ÚNICA dependencia externa de toda la aplicación (todo lo demás es
// Node puro); conviene detectarla y avisar si falta, no fallar en silencio.
//
// Reglas, tal como las entrega el instructor:
// - Solo se convierten los .docx que aún NO tienen su .pdf al lado.
// - Busca en la raíz de la ficha Y en LLAMADOS DE ATENCION/ (ver
//   buscarPendientes) — antes solo miraba la raíz, y los llamados/plan/
//   comité (que viven en esa subcarpeta) nunca se convertían aunque el
//   panel "Ver estado" los mostrara como "sin PDF" (pendiente 9, cerrado).
// - Se ignoran los temporales de Word que empiezan con "~$".
// - Documents.Open(ruta, false, true): el tercer parámetro abre en SOLO
//   LECTURA — el .docx original nunca se modifica.
// - [ref]17 es el formato PDF de Word (wdExportFormatPDF / wdFormatPDF).
// - El try/catch es POR ARCHIVO: uno que falle no detiene la tanda; sale
//   como línea "ERR" y se reporta, en vez de perderse.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, execSync } = require("child_process");

function wordInstalado() {
  try { execSync('reg query "HKCR\\Word.Application"', { stdio: "ignore", windowsHide: true }); return true; }
  catch { return false; }
}

// Aviso, no bloqueo: con Word abierto la automatización puede fallar o
// comportarse de forma inesperada. Hay que pedirle al instructor que lo
// cierre antes de convertir.
function wordEstaAbierto() {
  try { return /WINWORD\.EXE/i.test(execSync('tasklist /FI "IMAGENAME eq WINWORD.EXE" /NH', { encoding: "utf8", windowsHide: true })); }
  catch { return false; }
}

// Un solo nivel, no recursiva de verdad: mira exactamente las dos
// carpetas conocidas de la estructura de una ficha (su raíz, donde viven
// el acta de entrega y la de equipo ejecutor, y LLAMADOS DE ATENCION/,
// donde viven los llamados/plan/comité — ver ARQUITECTURA.md, pendiente
// 9, cerrado). Si la subcarpeta no existe todavía (ficha sin ningún
// llamado generado), simplemente no aporta nada, no es un error.
function buscarPendientesEn(carpeta) {
  if (!fs.existsSync(carpeta)) return [];
  return fs.readdirSync(carpeta)
    .filter(f => /\.docx$/i.test(f) && !f.startsWith("~$"))
    .filter(f => !fs.existsSync(path.join(carpeta, f.replace(/\.docx$/i, ".pdf"))))
    .map(f => path.join(carpeta, f));
}

function buscarPendientes(carpetaFicha) {
  return [...buscarPendientesEn(carpetaFicha), ...buscarPendientesEn(path.join(carpetaFicha, "LLAMADOS DE ATENCION"))];
}

function generarScript(rutas) {
  const lista = rutas.map(r => `'${r.replace(/'/g, "''")}'`).join(", ");
  return `$ErrorActionPreference='Stop'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
foreach ($f in @(${lista})) {
  try {
    $doc = $word.Documents.Open($f, $false, $true)
    $doc.SaveAs([ref]($f -replace '\\.docx$','.pdf'), [ref]17)
    $doc.Close($false)
    Write-Output ("OK  " + [System.IO.Path]::GetFileName($f))
  } catch { Write-Output ("ERR " + [System.IO.Path]::GetFileName($f) + " :: " + $_.Exception.Message) }
}
$word.Quit()
`;
}

/**
 * @param {string} carpeta carpeta de la ficha (busca en su raíz y en su
 *   subcarpeta LLAMADOS DE ATENCION/, ver buscarPendientes)
 * @param {{simular?: boolean}} [flags] simular=true por defecto: solo dice
 *   cuáles se convertirían, no ejecuta nada (ninguna acción que genere
 *   documentos se ejecuta sin aprobación).
 */
function convertirPdf(carpeta, { simular = true } = {}) {
  if (!wordInstalado())
    throw new Error("No se encontró Microsoft Word instalado en este computador. La conversión a PDF lo necesita: es la única dependencia externa de la aplicación.");

  const avisos = [];
  if (wordEstaAbierto())
    avisos.push("Word está abierto: ciérralo antes de convertir. Con Word abierto la conversión puede fallar o comportarse de forma inesperada.");

  const pendientes = buscarPendientes(carpeta);

  if (simular)
    return {
      carpeta,
      // origen, no solo el nombre: la vista previa tiene que distinguir
      // de qué carpeta viene cada archivo (raíz de la ficha, o LLAMADOS
      // DE ATENCION/) para que el instructor sepa qué va a convertir.
      pendientes: pendientes.map(p => ({
        archivo: path.basename(p),
        origen: path.dirname(p) === carpeta ? "raíz de la ficha" : "LLAMADOS DE ATENCION",
      })),
      total: pendientes.length, avisos,
    };

  if (!pendientes.length) return { carpeta, convertidos: [], errores: [], total: 0, avisos };

  const rutaScript = path.join(os.tmpdir(), `convertir_pdf_${Date.now()}.ps1`);
  fs.writeFileSync(rutaScript, generarScript(pendientes), "utf8");

  let salida;
  try {
    salida = execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", rutaScript], { encoding: "utf8", windowsHide: true });
  } catch (e) {
    throw new Error(`Falló la conversión a PDF: ${e.stdout || e.message}`);
  } finally {
    fs.unlinkSync(rutaScript);
  }

  const lineas = salida.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const convertidos = lineas.filter(l => l.startsWith("OK")).map(l => l.slice(3).trim());
  const errores = lineas.filter(l => l.startsWith("ERR")).map(l => l.slice(4).trim());
  return { carpeta, convertidos, errores, total: pendientes.length, avisos };
}

module.exports = { convertirPdf, wordInstalado, wordEstaAbierto, buscarPendientes };
