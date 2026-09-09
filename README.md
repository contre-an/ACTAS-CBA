# ACTAS-CBA

## Activación por clave — `secretos/produccion.key`

Los instaladores reales se empaquetan con `secretos/produccion.key` (electron-builder → `extraResources`, ver `package.json`). Ese archivo **no está en el repositorio** (`.gitignore` → `secretos/`) y es **irrecuperable si se pierde**: sin él no se puede generar una clave nueva, y ninguna clave ya emitida a un instructor vuelve a poder regenerarse ni verificarse fuera de un build ya hecho con ese secreto.

**Respaldalo fuera de este equipo** (gestor de contraseñas, USB, otro lugar seguro) apenas lo generes. Si se pierde, la única salida es rotar el secreto (generar uno nuevo) y reactivar a todos los instructores con claves nuevas.

Ver `activacion.js` y `herramientas/generar_clave.js` para el resto del esquema.
