// pruebas/rutaRegistro.test.js — resolución y migración de registro.json,
// probadas sobre el núcleo puro (_resolver) con dependencias inyectadas: no
// hace falta un userData real ni un proceso Electron para cubrir la lógica
// de migración/duplicado/fallo (ver rutaRegistro.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { _resolver } = require("../rutaRegistro");

const USERDATA = path.join("C:", "userdata-ficticio");
const LEGADO = path.join("C:", "app-ficticia", "registro.json");
const NUEVA = path.join(USERDATA, "registro.json");

// Doble en memoria de fs.existsSync/copyFileSync/mkdirSync/readFileSync,
// para cada escenario: un Set de rutas "existentes" y un Map ruta->contenido.
function fsFalso({ archivos = {} } = {}) {
  const contenido = new Map(Object.entries(archivos));
  const carpetasCreadas = [];
  const copias = [];
  return {
    existeSync: p => contenido.has(p),
    leerSync: p => {
      if (!contenido.has(p)) throw new Error(`ENOENT: no existe ${p}`);
      return contenido.get(p);
    },
    copiar: (origen, destino) => {
      copias.push({ origen, destino });
      if (!contenido.has(origen)) throw new Error(`ENOENT: no existe ${origen}`);
      contenido.set(destino, contenido.get(origen));
    },
    crearCarpeta: p => carpetasCreadas.push(p),
    _contenido: contenido, _carpetasCreadas: carpetasCreadas, _copias: copias,
  };
}

test("resolución de registro.json", async t => {
  await t.test("ACTAS_REGISTRO_RUTA siempre gana, incluso si userData ya tiene su propio registro", () => {
    const F = fsFalso({ archivos: { [NUEVA]: '{"consecutivo":9,"aprendices":{}}' } });
    const r = _resolver({ envRuta: "otra/ruta/registro.json", userData: USERDATA, legado: LEGADO, ...F });
    assert.equal(r.ruta, path.resolve("otra/ruta/registro.json"));
    assert.equal(r.aviso, null);
  });

  await t.test("sin userData (fuera de Electron): usa el legado tal cual, sin tocar nada", () => {
    const F = fsFalso({ archivos: { [LEGADO]: '{"consecutivo":3,"aprendices":{}}' } });
    const r = _resolver({ envRuta: null, userData: null, legado: LEGADO, ...F });
    assert.equal(r.ruta, LEGADO);
    assert.equal(r.aviso, null);
    assert.equal(F._copias.length, 0);
  });

  await t.test("instalación nueva (ni legado ni userData existen): apunta a userData, no migra nada", () => {
    const F = fsFalso();
    const r = _resolver({ envRuta: null, userData: USERDATA, legado: LEGADO, ...F });
    assert.equal(r.ruta, NUEVA);
    assert.equal(r.aviso, null);
    assert.equal(F._copias.length, 0);
  });

  await t.test("solo existe el legado: migra a userData y verifica la copia antes de usarla", () => {
    const contenidoOriginal = '{"consecutivo":7,"aprendices":{"9000001-1":{}}}';
    const F = fsFalso({ archivos: { [LEGADO]: contenidoOriginal } });
    const r = _resolver({ envRuta: null, userData: USERDATA, legado: LEGADO, ...F });
    assert.equal(r.ruta, NUEVA);
    assert.equal(r.aviso, null);
    assert.equal(F._copias.length, 1);
    assert.deepEqual(F._copias[0], { origen: LEGADO, destino: NUEVA });
    assert.equal(F._contenido.get(NUEVA), contenidoOriginal, "el legado NO se toca ni se borra");
    assert.equal(F._contenido.get(LEGADO), contenidoOriginal);
  });

  await t.test("ya existen los dos: usa el de userData, no copia nada, y avisa duplicado sin adivinar cuál es el bueno", () => {
    const F = fsFalso({ archivos: {
      [LEGADO]: '{"consecutivo":5,"aprendices":{}}',
      [NUEVA]: '{"consecutivo":2,"aprendices":{}}',
    } });
    const r = _resolver({ envRuta: null, userData: USERDATA, legado: LEGADO, ...F });
    assert.equal(r.ruta, NUEVA, "se usa el de userData");
    assert.deepEqual(r.aviso, { tipo: "duplicado", rutaUsada: NUEVA, rutaSinUsar: LEGADO });
    assert.equal(F._copias.length, 0);
  });

  await t.test("la copia falla (excepción de fs.copyFileSync): NO usa userData, sigue con el legado y señala el fallo", () => {
    const contenidoOriginal = '{"consecutivo":4,"aprendices":{}}';
    const F = fsFalso({ archivos: { [LEGADO]: contenidoOriginal } });
    F.copiar = () => { throw new Error("EACCES: permiso denegado"); };

    const r = _resolver({ envRuta: null, userData: USERDATA, legado: LEGADO, ...F });
    assert.equal(r.ruta, LEGADO, "debe devolver el legado, no la ruta nueva");
    assert.equal(r.aviso.tipo, "fallo_migracion");
    assert.equal(r.aviso.rutaVieja, LEGADO);
    assert.equal(r.aviso.rutaNuevaFallida, NUEVA);
    assert.match(r.aviso.motivo, /permiso denegado/);
    assert.equal(F._contenido.has(NUEVA), false, "no debe quedar un archivo a medias en userData");
  });

  await t.test("la copia \"se completa\" pero el contenido no coincide con el original: no se confirma, sigue con el legado", () => {
    const contenidoOriginal = '{"consecutivo":4,"aprendices":{}}';
    const F = fsFalso({ archivos: { [LEGADO]: contenidoOriginal } });
    // Simula una copia truncada/corrupta: escribe algo distinto del original.
    F.copiar = (origen, destino) => F._contenido.set(destino, '{"consecutivo":0');

    const r = _resolver({ envRuta: null, userData: USERDATA, legado: LEGADO, ...F });
    assert.equal(r.ruta, LEGADO, "debe devolver el legado, no la ruta nueva");
    assert.equal(r.aviso.tipo, "fallo_migracion");
    assert.match(r.aviso.motivo, /JSON|coincide/i);
  });
});
