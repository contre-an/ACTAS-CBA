# ACTAS-CBA

## Activación por clave — `secretos/produccion.key`

Los instaladores reales se empaquetan con `secretos/produccion.key` (electron-builder → `extraResources`, ver `package.json`). Ese archivo **no está en el repositorio** (`.gitignore` → `secretos/`) y es **irrecuperable si se pierde**: sin él no se puede generar una clave nueva, y ninguna clave ya emitida a un instructor vuelve a poder regenerarse ni verificarse fuera de un build ya hecho con ese secreto.

**Respaldalo fuera de este equipo** (gestor de contraseñas, USB, otro lugar seguro) apenas lo generes. Si se pierde, la única salida es rotar el secreto (generar uno nuevo) y reactivar a todos los instructores con claves nuevas.

Ver `activacion.js` y `herramientas/generar_clave.js` para el resto del esquema.

## Verificar el empaquetado

```
npm run verificar-empaquetado
```

Empaqueta la app de verdad (`electron-builder --dir`, sin instalador — más rápido) y revisa el `.asar` resultante:

- que todos los `.js` de la raíz del proyecto hayan quedado adentro (que `build.files`, en `package.json`, no se haya desincronizado de lo que hoy existe);
- que `herramientas/` (el generador de claves, `verificar_empaquetado.js` mismo) **no** esté en ningún lado del `.asar`;
- que `secretos/` tampoco esté en el `.asar`, y que en `resources/` (fuera del `.asar`) solo aparezca el secreto de producción ya renombrado por `extraResources` — nada de `produccion.key`/`desarrollo.key` sueltos con su nombre original.

Falla con un mensaje claro y explícito por cada cosa que no cuadre (no se detiene en la primera: reporta todas). No necesita `secretos/produccion.key` real: si no existe, genera uno ficticio solo para esa corrida y lo borra al terminar (nunca pisa uno real que ya esté ahí). Borra `dist/` al terminar, haya salido bien o mal — no deja rastro.

## Publicar una nueva versión

**PUBLICAR UN RELEASE EN GITHUB INSTALA ESA VERSIÓN SOLA, AUTOMÁTICAMENTE, EN LA COMPUTADORA DE TODOS LOS INSTRUCTORES QUE TENGAN LA APP ABIERTA.** El repositorio (`contre-an/ACTAS-CBA`) es público y la app trae autoactualización activa (`electron-updater`, ver `src/main/main.js`): no es un borrador, no es algo que se pueda "probar primero" en un solo equipo, y una vez que alguien la descargó no hay forma de revertirlo desde acá — solo publicando otro release encima.

1. Subir `"version"` en `package.json` (semver).
2. Compilar: `npm run dist`.
3. Verificar el empaquetado: `npm run verificar-empaquetado`.
4. Crear el tag y subirlo: `git tag vX.Y.Z && git push origin vX.Y.Z` (mismo número que el de `package.json`).
5. Publicar el release en GitHub (`contre-an/ACTAS-CBA`) con ese tag, adjuntando los tres archivos que quedaron en `dist/`: `Actas CBA Setup X.Y.Z.exe`, su `.blockmap`, y `latest.yml`. Los tres son necesarios — `latest.yml` es el que consulta `electron-updater` en cada equipo para saber si hay algo más nuevo, y el `.blockmap` es lo que permite la descarga diferencial en vez de bajar el instalador completo de nuevo.

`%APPDATA%\actas-cba\actualizaciones.log`, en el equipo de cada instructor, registra cada chequeo de actualización (encontrada, no encontrada, descargada —con los bytes—, o el error que haya dado) — sin mostrarle nada a él. Es lo primero que hay que revisar ante un "no se me actualizó".
