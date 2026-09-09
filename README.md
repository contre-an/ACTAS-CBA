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
