# Arquitectura — cómo se conectan las piezas

Este documento no es código: es el mapa de cómo encajan los módulos que ya
existen, para cuando se construya la interfaz Electron. Se actualiza cada vez
que cambie una pieza o se resuelva uno de los pendientes de abajo.

## Módulos y su responsabilidad

| Módulo | Responsabilidad | Toca archivos |
|---|---|---|
| `estado.js` | Memoria por ficha (`estado_ficha.json`): clasifica los archivos de la carpeta de una ficha, resuelve cuál es el control real. | Lee/escribe `estado_ficha.json` en la carpeta de cada ficha. |
| `horario.js` | Extrae del horario en PDF: ficha, trimestre, fechas, programa, y por sesión competencia/RAP/instructor/jefe de grupo/día/hora/sede/ambiente — de TODOS los instructores de la ficha. Es insumo del acta de equipo ejecutor (otro documento, sin construir), **no** de PARAMETROS: cada control es de un solo instructor y una sola competencia, eso lo escribe el instructor a mano. | Solo lee el PDF. No escribe nada. |
| `sofia.js` | Migra el reporte de SOFIA a la hoja APRENDICES del control (con la corrección EN INDUCCIÓN → EN FORMACION). | Lee el `.xls`/`.xlsx` de SOFIA; escribe (opcional, con vista previa) la hoja APRENDICES del control. |
| `procesar.js` | Motor de reglas del Acuerdo 009: lee el control, evalúa incidentes por aprendiz, decide la medida (escalamiento), arma el acta de entrega, escribe HISTORICO. | Lee el control completo; escribe archivos `.docx` en `LLAMADOS DE ATENCION/`; escribe HISTORICO del control. |
| `generar.js` | Renderiza las plantillas `.docx` (docxtemplater) y lleva la numeración consecutiva y el escalamiento por aprendiz. | Lee `plantilla/*.docx`; lee/escribe `registro.json`. |
| `revertir.js` | Deshace lo generado en una fecha: borra `.docx`, limpia HISTORICO, recalcula consecutivo, respalda antes de tocar nada. | Lee/escribe `registro.json` y el control; borra archivos en `LLAMADOS DE ATENCION/`. |

`registro.json` es el único estado que cruza fichas (consecutivo global,
escalamiento por `ficha-documento`). `estado_ficha.json` es memoria local de
una carpeta y no debería duplicar nada que ya viva en `registro.json` (ver
pendiente 6).

## Flujos ya construidos y probados

- **Llamado 1 / Llamado 2 / Plan de mejoramiento / Informe a comité**:
  `procesar.js → procesarControl(ruta, forzar, simular)`. El tipo de medida
  se decide solo, mirando `registro.json` (no lo elige quien aprieta el
  botón). Tiene vista previa (`simular=true`) que no toca nada.
- **Acta de entrega de ficha**: `procesar.js → generarEntregaControl(ruta)`
  (hoy solo accesible por dentro de `generarEntregas(carpeta)`, que procesa
  una carpeta entera).
- **Reversión**: `revertir.js → revertirFecha(carpetaFicha, fecha, {simular})`.

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

`horario.js` no interviene en este flujo: su único consumidor es el acta de
equipo ejecutor (los varios instructores de la ficha), un documento aparte
que todavía no se construye.

`registro.json` no se toca en este flujo (es memoria de actas generadas, no
de inicialización).

## Flujo NO construido: "Convertir actas firmadas a PDF"

Está en el alcance v1.0 pero no tiene ni diseño ni código todavía. Pendiente
de una sesión aparte.

## Vista previa antes de ejecutar (regla del encargo)

Todo lo que genera o borra documentos debe mostrar vista previa y pedir
aprobación. Estado actual por función:

| Función | ¿Tiene `simular`? |
|---|---|
| `procesarControl` | Sí |
| `revertirFecha` | Sí (default `true`) |
| `poblarAprendices` | Sí (default `true`) |
| `generarEntregaControl` / `generarEntregas` | **No** — genera de una. Hay que agregarle vista previa antes de conectarla a un botón. |

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
3. **Documento y correo del instructor**: sigue pendiente para el flujo de
   "inicializar trimestre" en general (más allá del acta de equipo
   ejecutor): de dónde sale ese dato la primera vez que se arma un control
   nuevo (¿el instructor lo escribe a mano en PARAMETROS antes de
   procesar? Probablemente sí, ya que el control es suyo).
4. **`generarEntregaControl` sin vista previa**: hay que agregarle un
   parámetro `simular`, igual que tiene `procesarControl`, antes de
   conectarla a un botón.
5. **"Convertir actas firmadas a PDF"**: sin diseño.
6. **Posible duplicación `estado_ficha.json` / `registro.json`**: ambos
   pueden terminar guardando quién es el instructor y qué se generó. Antes
   de que la interfaz dependa de los dos, aclarar cuál manda en caso de
   choque (probablemente `registro.json` para actas/consecutivo, y
   `estado_ficha.json` solo para lo que no depende de escalamiento —
   `equipo_ejecutor`, `archivos_detectados`).
