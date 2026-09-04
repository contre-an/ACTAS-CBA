# Arquitectura — cómo se conectan las piezas

Este documento no es código: es el mapa de cómo encajan los módulos que ya
existen, para cuando se construya la interfaz Electron. Se actualiza cada vez
que cambie una pieza o se resuelva uno de los pendientes de abajo.

## Módulos y su responsabilidad

| Módulo | Responsabilidad | Toca archivos |
|---|---|---|
| `estado.js` | Memoria por ficha (`estado_ficha.json`): clasifica los archivos de la carpeta de una ficha, resuelve cuál es el control real. | Lee/escribe `estado_ficha.json` en la carpeta de cada ficha. |
| `horario.js` | Extrae del horario en PDF: ficha, trimestre, fechas, programa, y por sesión competencia/RAP/instructor/jefe de grupo/día/hora/sede/ambiente — de TODOS los instructores de la ficha. Es insumo de `equipo_ejecutor.js`, **no** de PARAMETROS: cada control es de un solo instructor y una sola competencia, eso lo escribe el instructor a mano. | Solo lee el PDF. No escribe nada. |
| `sofia.js` | Migra el reporte de SOFIA a la hoja APRENDICES del control (con la corrección EN INDUCCIÓN → EN FORMACION). | Lee el `.xls`/`.xlsx` de SOFIA; escribe (opcional, con vista previa) la hoja APRENDICES del control. |
| `procesar.js` | Motor de reglas del Acuerdo 009: lee el control, evalúa incidentes por aprendiz, decide la medida (escalamiento), arma el acta de entrega, escribe HISTORICO. Avisa si falta documento/correo del instructor en PARAMETROS. Expone `evaluarAprendiz`, `recibeLlamado`, `categoriaDe`/`CATEGORIAS` y `norm` para que otros módulos (`equipo_ejecutor.js`) no dupliquen reglas. | Lee el control completo; escribe archivos `.docx` en `LLAMADOS DE ATENCION/`; escribe HISTORICO del control. |
| `generar.js` | Renderiza las plantillas `.docx` (docxtemplater) y lleva la numeración consecutiva y el escalamiento por aprendiz. Las actas de llamados/plan y la de equipo ejecutor comparten la MISMA plantilla (GOR-F-084): lo que cambia es el contenido, no el archivo. | Lee `plantilla/*.docx`; lee/escribe `registro.json`. |
| `equipo_ejecutor.js` | Arma el acta de equipo ejecutor: junta `horario.js` (instructores/competencias de la ficha) con UN control (panorama de aprendices) y compone, SOLO en la fila del instructor que la genera, sus propias novedades (inasistencias, evidencias no presentadas, notas bajas, llegadas tarde) de sus aprendices EN FORMACION. Las demás filas quedan vacías: no hay acceso cruzado a los controles de los otros instructores, ni lo habrá. | Solo lee (horario PDF + un control); escribe el `.docx` en la carpeta que se le indique. |
| `revertir.js` | Deshace lo generado en una fecha: borra `.docx`, limpia HISTORICO, recalcula consecutivo, respalda antes de tocar nada. | Lee/escribe `registro.json` y el control; borra archivos en `LLAMADOS DE ATENCION/`. |

`registro.json` es el único estado que cruza fichas (consecutivo global,
escalamiento por `ficha-documento`). `estado_ficha.json` es memoria local de
una carpeta y no debería duplicar nada que ya viva en `registro.json` (ver
pendiente 7).

## Flujos ya construidos y probados

- **Llamado 1 / Llamado 2 / Plan de mejoramiento / Informe a comité**:
  `procesar.js → procesarControl(ruta, forzar, simular)`. El tipo de medida
  se decide solo, mirando `registro.json` (no lo elige quien aprieta el
  botón). Tiene vista previa (`simular=true`) que no toca nada.
- **Acta de entrega de ficha**: `procesar.js → generarEntregaControl(ruta, simular)`
  (también accesible en lote con `generarEntregas(carpeta, simular)`, que
  procesa una carpeta entera). Tiene vista previa igual que `procesarControl`.
- **Acta de equipo ejecutor**: `equipo_ejecutor.js → prepararActaEquipoEjecutor(opciones, {simular})`.
  Necesita el horario en PDF, un control de la ficha (para el panorama) y los
  datos de la reunión (fecha/hora/lugar — no se pueden inventar).
- **Reversión**: `revertir.js → revertirFecha(carpetaFicha, fecha, {simular})`.
  Ya sabe deshacer actas de aprendiz individuales y el acta de entrega
  (`reg.entregas`). **No sabe nada de `reg.equipoEjecutor`** (estructura
  nueva de este commit) — ver pendiente 5.

## Flujo nuevo: "Inicializar trimestre" (conecta horario.js + sofia.js)

Es el único botón del alcance v1.0 que todavía no tiene una función que lo
implemente de punta a punta — hoy son piezas sueltas. Así se conectarían:

1. El instructor elige la carpeta de la ficha (o la app la detecta con
   `estado.js → clasificarArchivos`).
2. Se copia `PLANTILLA_MAESTRA_CONTROL_ASISTENCIA V3.xlsx` (ya en el
   proyecto, ver pendiente 1) a `CONTROL_ASISTENCIA_<ficha>.xlsx` en esa
   carpeta.
3. El instructor llena a mano `FICHA`, `PROGRAMA DE FORMACION`,
   `COMPETENCIA`, `INSTRUCTOR` (nombre, documento, correo) en PARAMETROS:
   el control es suyo, de una competencia, y esos datos no salen del
   horario (ver pendiente 2 y 3 — aclarado por el instructor:
   `horario.js` NO alimenta PARAMETROS).
4. `sofia.js → leerReporteSofia(rutaXls)` da la lista de aprendices, ya con
   `EN INDUCCIÓN` corregido a `EN FORMACION`.
5. Vista previa al instructor (cuántos aprendices, el aviso de
   `poblarAprendices` si la hoja ya tenía datos) → aprobación → recién ahí
   `sofia.js → poblarAprendices(rutaControl, aprendices, {simular:false})`.
6. `estado.js → estadoNuevo(ficha)` + `guardarEstado(carpetaFicha, estado)`
   para dejar registrado `aprendices_migrados: true` y `total_aprendices`.

`horario.js` no interviene en este flujo: su único consumidor es
`equipo_ejecutor.js` (los varios instructores de la ficha), ya construido.

`registro.json` no se toca en este flujo (es memoria de actas generadas, no
de inicialización).

## Flujo pendiente: "Convertir actas firmadas a PDF"

Está en el alcance v1.0. El instructor ya tiene una solución propia probada
(Word por automatización de PowerShell) — falta integrarla, no diseñarla.

## Vista previa antes de ejecutar (regla del encargo)

Todo lo que genera o borra documentos debe mostrar vista previa y pedir
aprobación. Estado actual por función:

| Función | ¿Tiene `simular`? |
|---|---|
| `procesarControl` | Sí (default `false` — igual que `generarEntregaControl`, hay que pasarlo explícito) |
| `generarEntregaControl` / `generarEntregas` | Sí (default `false`) |
| `prepararActaEquipoEjecutor` | Sí (default `true`) |
| `revertirFecha` | Sí (default `true`) |
| `poblarAprendices` | Sí (default `true`) |

## Pendientes / huecos identificados (para resolver antes o durante la interfaz)

1. ~~**Plantilla maestra del control**~~ — **resuelto**:
   `PLANTILLA_MAESTRA_CONTROL_ASISTENCIA V3.xlsx` ya está en el proyecto y
   sí se versiona (es la que se distribuye a los instructores, a diferencia
   de los `CONTROL_ASISTENCIA*.xlsx` reales, que quedan fuera de git). Ya
   trae la hoja DESCRIPCIONES (punto 2 del encargo): columna A =
   `=NOTAS!D1`…`=NOTAS!W1` (se llena sola, el instructor nunca la edita a
   mano), columna B = texto libre que sí escribe el instructor. Agregada
   con `herramientas/agregar_hoja_descripciones.js` (cirugía de XML, no
   reescribe el libro completo) y verificada abriéndola con Excel real vía
   COM — sin aviso de reparación, la fórmula calcula bien.
2. **Cada control es de UN instructor y UNA competencia** (aclarado por el
   instructor): PARAMETROS se queda con un solo instructor, esto NO se
   rediseña. Los varios instructores que aparecen en el horario de una
   ficha (ej. ficha 3479381, 6 instructores) son para el acta de equipo
   ejecutor, un documento aparte con su propia fuente — no para
   PARAMETROS. `horario.js` sigue siendo insumo de esa acta, no de
   PARAMETROS.
3. ~~**Documento y correo del instructor**~~ — **resuelto**: los escribe el
   instructor a mano en PARAMETROS al armar el control. `avisosInstructor()`
   (en `procesar.js`) avisa en la vista previa y en la generación real si
   falta alguno, en `procesarControl` y en `generarEntregaControl`.
4. ~~**`generarEntregaControl` sin vista previa**~~ — **resuelto**: ahora
   tiene `simular` igual que `procesarControl`.
5. **`revertirFecha` no conoce `reg.equipoEjecutor`**: sabe deshacer actas
   de aprendiz y actas de entrega (`reg.entregas`), pero no la estructura
   nueva que dejó `generarActaEquipoEjecutor` (`reg.equipoEjecutor[ficha]`,
   un arreglo). Falta antes de ofrecer reversión del acta de equipo
   ejecutor desde la interfaz.
6. **"Convertir actas firmadas a PDF"**: pendiente, siguiente en la fila.
   El instructor ya tiene una solución propia probada (Word por
   automatización de PowerShell: convierte solo los `.docx` sin `.pdf`
   correspondiente, no toca los originales, exige que Word esté cerrado) —
   no hay que diseñarla de nuevo, solo integrarla cuando la pase.
7. **Posible duplicación `estado_ficha.json` / `registro.json`**: ambos
   pueden terminar guardando quién es el instructor y qué se generó. Antes
   de que la interfaz dependa de los dos, aclarar cuál manda en caso de
   choque (probablemente `registro.json` para actas/consecutivo, y
   `estado_ficha.json` solo para lo que no depende de escalamiento —
   `equipo_ejecutor`, `archivos_detectados`).
