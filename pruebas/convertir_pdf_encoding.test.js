// pruebas/convertir_pdf_encoding.test.js — el .ps1 que genera convertir_pdf.js
// para convertir a PDF debe sobrevivir nombres de archivo con ñ, tildes y
// apóstrofo, sin invocar Word en ningún momento (más rápida, no depende de
// que la máquina tenga Word instalado, y aísla el problema real: la
// codificación del .ps1, no la automatización de Word en sí).
//
// Bug real reproducido antes de este arreglo: un .docx con "PATIÑO" en el
// nombre rompía la conversión con un ParserError de PowerShell (cadena sin
// terminar) — el .ps1 se escribía en UTF-8 SIN BOM, y PowerShell 5.1, sin
// BOM, relee el archivo con el code page ANSI del sistema en vez de UTF-8;
// el byte de la "Ñ" se decodificaba mal y, por coincidencia, como un
// apóstrofo, cerrando la cadena a mitad de camino. Ver ARQUITECTURA.md y el
// comentario de escribirScriptTemporal (convertir_pdf.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { generarScript, escribirScriptTemporal } = require("../convertir_pdf");

// ñ, tildes (todas las vocales) y un apóstrofo real, todo junto: el peor
// caso combinado, no solo la ñ que salió en el reporte original.
const NOMBRE = "C:\\ficha\\ACTA_MERCADO_PATIÑO_RONY_EDUARD'O_ÁÉÍÓÚ.docx";
const NOMBRE_ESCAPADO = NOMBRE.replace(/'/g, "''"); // lo que generarScript debe producir dentro de las comillas

test("el .ps1 de conversión a PDF sobrevive ñ, tildes y apóstrofo (sin invocar Word)", async t => {
  await t.test("1. generarScript: la cadena en memoria trae el literal bien escapado y fuerza salida UTF-8", () => {
    const script = generarScript([NOMBRE]);
    assert.match(script, /^\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8/, "debe forzar UTF-8 en la salida, antes que cualquier otra línea");
    assert.ok(script.includes(`'${NOMBRE_ESCAPADO}'`), "el nombre debe aparecer con la comilla del apóstrofo doblada, ñ/tildes intactas");
  });

  let rutaPs1;
  t.after(() => { if (rutaPs1 && fs.existsSync(rutaPs1)) fs.unlinkSync(rutaPs1); });

  await t.test("2. escribirScriptTemporal: el archivo en disco lleva BOM UTF-8 y el literal correcto", () => {
    rutaPs1 = escribirScriptTemporal([NOMBRE]);
    const crudo = fs.readFileSync(rutaPs1);
    assert.deepEqual([...crudo.subarray(0, 3)], [0xef, 0xbb, 0xbf], "los primeros 3 bytes deben ser el BOM UTF-8");
    const texto = crudo.toString("utf8").replace(/^\uFEFF/, "");
    assert.ok(texto.includes(`'${NOMBRE_ESCAPADO}'`), "el archivo decodificado como UTF-8 debe traer el literal esperado");
  });

  await t.test("3. PowerShell real (5.1) lo parsea sin errores, y reconstruye el nombre EXACTO — sin ejecutar el script (nunca toca Word)", () => {
    // Parser.ParseFile solo tokeniza/arma el AST: no ejecuta una sola
    // línea, así que "New-Object -ComObject Word.Application" nunca corre
    // (esta prueba pasa igual en una máquina sin Word instalado).
    const rutaSalida = path.join(os.tmpdir(), `convertir_pdf_encoding_test_${Date.now()}.txt`);
    t.after(() => { if (fs.existsSync(rutaSalida)) fs.unlinkSync(rutaSalida); });

    // El literal encontrado se vuelca a un ARCHIVO (WriteAllText, UTF-8
    // explícito) en vez de por stdout a propósito: la salida estándar de
    // PowerShell 5.1 es justo el otro lado de este mismo bug (ver punto 2
    // del diagnóstico) — usarla aquí reintroduciría la misma ambigüedad
    // que esta prueba busca descartar.
    const comandoVerificador = [
      "$ErrorActionPreference='Stop'",
      "$errores = $null",
      `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${rutaPs1.replace(/'/g, "''")}', [ref]$null, [ref]$errores)`,
      "if ($errores.Count -gt 0) { [System.IO.File]::WriteAllText('" + rutaSalida.replace(/'/g, "''") + "', 'ERRORES:' + ($errores.Count), [System.Text.Encoding]::UTF8); exit }",
      "$lit = $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.StringConstantExpressionAst] }, $true) | Where-Object { $_.Value -like '*PATI*' } | Select-Object -First 1",
      "[System.IO.File]::WriteAllText('" + rutaSalida.replace(/'/g, "''") + "', $lit.Value, [System.Text.Encoding]::UTF8)",
    ].join("; ");

    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", comandoVerificador], { encoding: "utf8", windowsHide: true });

    // [System.Text.Encoding]::UTF8 (el objeto estático de .NET) SÍ antepone
    // BOM al escribir con WriteAllText -- un detalle de cómo esta PRUEBA
    // vuelca el resultado, no del .ps1 real que genera convertir_pdf.js
    // (ese no pasa por WriteAllText). Se descarta antes de comparar.
    const resultado = fs.readFileSync(rutaSalida, "utf8").replace(/^﻿/, "");
    assert.equal(resultado, NOMBRE, "PowerShell debe parsear el .ps1 SIN errores y reconstruir el nombre original exacto, ñ/tildes/apóstrofo incluidos");
  });
});
