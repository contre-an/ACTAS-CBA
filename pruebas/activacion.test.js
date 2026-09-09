// pruebas/activacion.test.js — sistema de activación por clave, sobre las
// funciones puras de activacion.js (nada de fs/Electron: el secreto se
// inyecta directo, igual que hacen las demás pruebas del proyecto).
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizarNombre, normalizarCodigo, calcularClaveHex, formatoClave,
  validarClave, estadoActivacion, intentarActivar,
} = require("../activacion");

const SECRETO = "secreto-de-pruebas-no-real";

test("normalizarNombre", async t => {
  await t.test("quita tildes, sube a mayúsculas, colapsa espacios", () => {
    assert.equal(normalizarNombre("Ángela María Núñez Gómez"), "ANGELA MARIA NUNEZ GOMEZ");
  });
  await t.test("colapsa espacios de más y recorta bordes", () => {
    assert.equal(normalizarNombre("  juan   carlos  perez  "), "JUAN CARLOS PEREZ");
  });
  await t.test("undefined/null no truena, da string vacío", () => {
    assert.equal(normalizarNombre(undefined), "");
    assert.equal(normalizarNombre(null), "");
  });
});

test("normalizarCodigo", () => {
  assert.equal(normalizarCodigo("5"), "05");
  assert.equal(normalizarCodigo("05"), "05");
  assert.equal(normalizarCodigo("abc12"), "12");
});

test("calcularClaveHex / formatoClave", async t => {
  await t.test("produce hex genuino de 16 caracteres, en 4 grupos de 4", () => {
    const hex = calcularClaveHex(SECRETO, "JUAN PEREZ", "05");
    assert.match(hex, /^[0-9A-F]{16}$/, "debe ser hex real (0-9A-F), no algo como K7M2");
    const formateada = formatoClave(hex);
    assert.match(formateada, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  });
  await t.test("es determinística: mismo secreto+nombre+código -> misma clave", () => {
    const a = calcularClaveHex(SECRETO, "JUAN PEREZ", "05");
    const b = calcularClaveHex(SECRETO, "JUAN PEREZ", "05");
    assert.equal(a, b);
  });
  await t.test("nombre con tildes/espacios de más da la MISMA clave que su forma normalizada", () => {
    const a = calcularClaveHex(SECRETO, "Ángela María Núñez", "07");
    const b = calcularClaveHex(SECRETO, "  ANGELA   MARIA NUNEZ  ", "07");
    assert.equal(a, b);
  });
  await t.test("distinto nombre, código o secreto -> distinta clave", () => {
    const base = calcularClaveHex(SECRETO, "JUAN PEREZ", "05");
    assert.notEqual(calcularClaveHex(SECRETO, "JUAN PEREZ GOMEZ", "05"), base);
    assert.notEqual(calcularClaveHex(SECRETO, "JUAN PEREZ", "06"), base);
    assert.notEqual(calcularClaveHex("otro-secreto", "JUAN PEREZ", "05"), base);
  });
});

test("validarClave", async t => {
  const hex = calcularClaveHex(SECRETO, "JUAN CARLOS PEREZ", "05");
  const clave = formatoClave(hex);

  await t.test("acepta la clave formateada tal cual", () => {
    assert.equal(validarClave({ nombre: "JUAN CARLOS PEREZ", codigo: "05", clave }, SECRETO), true);
  });
  await t.test("acepta minúscula, sin guiones, con espacios de más", () => {
    assert.equal(validarClave({ nombre: "Juan Carlos Perez", codigo: "05", clave: `  ${clave.toLowerCase().replace(/-/g, " ")}  ` }, SECRETO), true);
  });
  await t.test("rechaza si el nombre no fue exactamente el firmado (falta una parte)", () => {
    assert.equal(validarClave({ nombre: "JUAN PEREZ", codigo: "05", clave }, SECRETO), false);
  });
  await t.test("rechaza código distinto", () => {
    assert.equal(validarClave({ nombre: "JUAN CARLOS PEREZ", codigo: "06", clave }, SECRETO), false);
  });
  await t.test("rechaza clave truncada o alterada", () => {
    assert.equal(validarClave({ nombre: "JUAN CARLOS PEREZ", codigo: "05", clave: clave.slice(0, -1) }, SECRETO), false);
    assert.equal(validarClave({ nombre: "JUAN CARLOS PEREZ", codigo: "05", clave: "0000-0000-0000-0000" }, SECRETO), false);
  });
});

test("estadoActivacion — se revalida en cada llamado, nunca confía en un flag guardado", async t => {
  const activacionValida = {
    nombre: "JUAN CARLOS PEREZ", documento: "123", correo: "juan@sena.edu.co",
    codigoInstructor: "05", clave: formatoClave(calcularClaveHex(SECRETO, "JUAN CARLOS PEREZ", "05")),
  };

  await t.test("sin bloque activacion en configuracion.json: no activado", () => {
    assert.deepEqual(estadoActivacion({}, SECRETO), { activado: false, motivo: "sin_activar" });
  });

  await t.test("activación válida: activado", () => {
    const r = estadoActivacion({ activacion: activacionValida }, SECRETO);
    assert.equal(r.activado, true);
    assert.deepEqual(r.activacion, activacionValida);
  });

  await t.test('código "00" (instalación de antes de este sistema, o heredado): no activado', () => {
    const r = estadoActivacion({ activacion: { ...activacionValida, codigoInstructor: "00" } }, SECRETO);
    assert.deepEqual(r, { activado: false, motivo: "codigo_00" });
  });

  await t.test("configuracion.json editado a mano (nombre cambiado sin tocar la clave guardada): no activado", () => {
    const r = estadoActivacion({ activacion: { ...activacionValida, nombre: "OTRO NOMBRE" } }, SECRETO);
    assert.deepEqual(r, { activado: false, motivo: "clave_invalida" });
  });

  await t.test("configuracion.json editado a mano (código cambiado sin tocar la clave guardada): no activado", () => {
    const r = estadoActivacion({ activacion: { ...activacionValida, codigoInstructor: "09" } }, SECRETO);
    assert.deepEqual(r, { activado: false, motivo: "clave_invalida" });
  });

  await t.test("configuracion.json editado a mano (clave cambiada): no activado", () => {
    const r = estadoActivacion({ activacion: { ...activacionValida, clave: "AAAA-AAAA-AAAA-AAAA" } }, SECRETO);
    assert.deepEqual(r, { activado: false, motivo: "clave_invalida" });
  });
});

test("intentarActivar", async t => {
  const NOMBRE = "JUAN CARLOS PEREZ";
  const CODIGO = "05";
  const CLAVE = formatoClave(calcularClaveHex(SECRETO, NOMBRE, CODIGO));
  const datosOk = { nombre: NOMBRE, documento: "123456789", correo: "juan.perez@sena.edu.co", codigoInstructor: CODIGO, clave: CLAVE };

  await t.test("con todo correcto: ok, y devuelve el objeto listo para guardar", () => {
    const r = intentarActivar(datosOk, SECRETO);
    assert.equal(r.ok, true);
    assert.equal(r.activacion.nombre, NOMBRE);
    assert.equal(r.activacion.codigoInstructor, CODIGO);
    assert.equal(r.activacion.clave, CLAVE);
    assert.ok(r.activacion.fecha);
  });

  await t.test("campos obligatorios faltantes: mensaje específico, no genérico", () => {
    assert.match(intentarActivar({ ...datosOk, nombre: "" }, SECRETO).error, /nombre/i);
    assert.match(intentarActivar({ ...datosOk, documento: "" }, SECRETO).error, /documento/i);
    assert.match(intentarActivar({ ...datosOk, correo: "no-es-correo" }, SECRETO).error, /correo/i);
    assert.match(intentarActivar({ ...datosOk, clave: "" }, SECRETO).error, /clave/i);
  });

  await t.test("código con formato inválido (no exactamente 2 dígitos)", () => {
    assert.match(intentarActivar({ ...datosOk, codigoInstructor: "5" }, SECRETO).error, /dos dígitos/i);
    assert.match(intentarActivar({ ...datosOk, codigoInstructor: "123" }, SECRETO).error, /dos dígitos/i);
    assert.match(intentarActivar({ ...datosOk, codigoInstructor: "ab" }, SECRETO).error, /dos dígitos/i);
  });

  await t.test('código "00" rechazado explícitamente, aunque el formato sea válido', () => {
    const r = intentarActivar({ ...datosOk, codigoInstructor: "00" }, SECRETO);
    assert.equal(r.ok, false);
    assert.match(r.error, /"00"/);
  });

  await t.test("clave que no valida: el mensaje dice que el nombre debe ir exacto y muestra el nombre normalizado", () => {
    const r = intentarActivar({ ...datosOk, nombre: "Juan Perez" }, SECRETO); // le falta "CARLOS"
    assert.equal(r.ok, false);
    assert.match(r.error, /exactamente/i, "debe decir explícitamente que el nombre debe ir tal cual se dictó");
    assert.match(r.error, /"JUAN PEREZ"/, "debe mostrar el nombre normalizado que está comparando");
  });
});
