# Arquitectura — cómo se conectan las piezas

Este documento no es código: es el mapa de cómo encajan los módulos que ya
existen, para cuando se construya la interfaz Electron. Se actualiza cada vez
que cambie una pieza o se resuelva uno de los pendientes de abajo.

## Prueba de recorrido completo

`pruebas/recorrido_completo.test.js` (`npm test`) encadena, contra una ficha
ficticia (9000001, sin ningún dato real), todo el ciclo: migrar desde SOFIA,
llamados 1 y 2, la comprobación de que repetir una corrida da cero, escalar
hasta comité, el acta de equipo ejecutor, revertir, volver a dar cero, y
convertir a PDF. Corre aislada del `registro.json` real del proyecto
(`ACTAS_REGISTRO_RUTA`). **Cualquier cambio a `procesar.js`, `generar.js`,
`revertir.js`, `sofia.js` o `equipo_ejecutor.js` debería correrla antes de
darse por bueno.**

## Interfaz (Electron)

`src/main/` (proceso principal, con Node/fs) y `src/renderer/` (HTML/CSS/JS
plano, sin framework, sin paso de build — decisión del instructor: menos
piezas para algo que van a instalar instructores, no desarrolladores). Los
módulos de lógica de la tabla de abajo no se tocan ni se mueven: `src/main/ipc.js`
los requiere tal cual desde la raíz del proyecto.

Seguridad: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
El renderer nunca toca `fs` ni `child_process`: todo pasa por
`src/main/preload.js` (`contextBridge`, API angosta `window.actas.*`) hacia
`ipcMain.handle()` en `src/main/ipc.js` — el ÚNICO lugar donde la interfaz
llama a los módulos de lógica.

Los 4 principios no negociables del encargo:
- **Casillas**: ninguna acción opera sobre "todas", siempre sobre el arreglo
  de carpetas marcadas (`seleccionadas`, un `Set`, en `app.js`).
- **Vista previa obligatoria**: cada botón llama primero con `simular:true`
  y muestra el resultado en un modal; solo "Aprobar y ejecutar" repite la
  llamada con `simular:false`. Es la MISMA función en los dos casos — no un
  formato de vista previa inventado aparte, así la vista previa nunca puede
  mentir sobre lo que va a pasar.
- **Un solo botón "Generar actas"** (confirmado con el instructor:
  `procesarControl` ya escala sola la medida mirando el historial; cuatro
  botones que llamaran a la misma función sugerirían una decisión que no
  existe, y romperían el debido proceso si alguien creyera que puede "pedir"
  un plan de mejoramiento saltándose los llamados previos). La vista previa
  muestra la medida por aprendiz ("PEREZ GOMEZ JUAN CARLOS → primer llamado
  de atención"), nunca un conteo.
- **Sin ventanas de consola**: panel de resultados dentro de la ventana.
  `convertir_pdf.js` pasa `windowsHide: true` a sus subprocesos por esto
  mismo.

Agregado por el instructor, ya construido: botón "Abrir carpeta" por fila, y
la carpeta del trimestre se recuerda entre sesiones
(`userData/configuracion.json`, ver `src/main/configuracion.js`).

### Canales IPC → función real

| Canal | Función que llama |
|---|---|
| `fichas:listar` | `leerControl` por cada subcarpeta (vía `buscarControlEnCarpeta`) |
| `actas:generar` | `procesarControl(ruta, false, simular)` |
| `entrega:generar` | `generarEntregaControl(ruta, simular)` |
| `equipoEjecutor:generar` | `prepararActaEquipoEjecutor(opciones, {simular})` |
| `pdf:convertir` | `convertirPdf(carpeta, {simular})` |
| `revertir:ejecutar` | `revertirFecha(carpeta, fecha, {simular})` |
| `inicializar:crearControl` | copia la plantilla maestra, abre el `.xlsx` en Excel |
| `inicializar:migrarAprendices` | `leerReporteSofia` + `poblarAprendices` |

"Inicializar trimestre" queda como asistente de 2 pasos explícitos (crear
control → el instructor llena PARAMETROS a mano en Excel → migrar
aprendices), no un formulario único: PARAMETROS lo sigue llenando el
instructor a mano, la app no lo automatiza (ver pendiente 3, ya resuelto en
ese sentido).

### Verificación (no solo "abre la ventana")

Probado con Playwright (`_electron`), no solo "debería abrir": lanzar la
app, apuntar la carpeta del trimestre a la ficha ficticia de
`pruebas/recorrido_completo.test.js`, marcar la fila, generar actas con un
incidente real, leer el texto exacto del modal, aprobar, y confirmar el
`.docx` en disco. Dos bugs reales aparecieron y se corrigieron en el
proceso, ninguno hipotético:
- **CSS**: `.modal-overlay { display: flex }` (una clase) le ganaba en
  especificidad al `[hidden] { display: none }` del navegador (un
  atributo), así que el modal de vista previa se veía SIEMPRE, vacío, desde
  el primer instante. Se ve en la primera captura de la verificación.
  Arreglado con `.modal-overlay[hidden] { display: none }`.
- **Día UTC vs. local, en la propia prueba automatizada** (no en código de
  producción): el paso 8 de `recorrido_completo.test.js` calculaba "hoy"
  con `.toISOString()` (día en UTC) en vez de día local. Pasadas las 19:00
  hora de Colombia, UTC ya está en el día siguiente y `revertirFecha` no
  encontraba nada que revertir — la misma familia de bug que todo este
  proyecto existe para evitar, colada en la prueba. Reproducido de verdad
  corriendo la suite a las 10pm, corregido con `hoyISOLocal()`.

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
| `convertir_pdf.js` | Convierte a PDF los `.docx` firmados que aún no tienen su PDF (solución del instructor, ya probada en producción: Word por automatización de PowerShell). Detecta si Word está instalado (única dependencia externa de toda la app) y si ya está abierto (aviso, no bloqueo). | Lee la carpeta que se le indique; escribe los `.pdf` al lado de cada `.docx`. Nunca toca los `.docx` (abre en solo lectura). |

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
- **Convertir actas firmadas a PDF**: `convertir_pdf.js → convertirPdf(carpeta, {simular})`.
  Requiere Word instalado (única dependencia externa de la app); avisa si
  Word ya está abierto (no bloquea, pero el instructor debe cerrarlo antes).
- **Reversión**: `revertir.js → revertirFecha(carpetaFicha, fecha, {simular})`.
  Ya sabe deshacer actas de aprendiz individuales y el acta de entrega
  (`reg.entregas`). **No sabe nada de `reg.equipoEjecutor`** (estructura
  nueva de este commit) — ver pendiente 5.

## Flujo "Inicializar trimestre" (conecta la plantilla maestra + sofia.js)

Ya tiene interfaz (`inicializar:crearControl` / `inicializar:migrarAprendices`
en `src/main/ipc.js`), como asistente de 2 pasos con una pausa manual en medio
(el instructor llena PARAMETROS en Excel):

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
| `convertirPdf` | Sí (default `true`) |

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
5. **`revertirFecha` no sabe deshacer el acta de equipo ejecutor** — más
   grande de lo que parecía al anotarlo (ver aclaración del instructor,
   pendiente hasta retomarlo con contexto completo):
   - El acta de equipo ejecutor **no vive en `registro.json`** como las
     demás (a diferencia de lo que hace hoy `generarActaEquipoEjecutor`,
     que le agregó `reg.equipoEjecutor[ficha]` — eso puede estar mal
     ubicado). Vive en **`estado_ficha.json`**.
   - Esa reunión puede haber **autorizado deserciones** de aprendices, que
     también habría que revertir junto con el acta si la reunión se
     deshace — no es solo borrar un `.docx` y una fila de HISTORICO.
   - No tocar esto hasta que el instructor dé el contexto completo.
6. ~~**"Convertir actas firmadas a PDF"**~~ — **resuelto**:
   `convertir_pdf.js`, envolviendo (sin rediseñar) la solución del
   instructor ya probada en producción (Word por automatización de
   PowerShell). Detecta Word instalado y si ya está abierto.
7. **Posible duplicación `estado_ficha.json` / `registro.json`**: ligado al
   punto 5 — el acta de equipo ejecutor demuestra que esto ya no es
   hipotético: `generarActaEquipoEjecutor` guarda en `registro.json` un
   dato que en realidad pertenece a `estado_ficha.json`. Aclarar cuál
   manda en caso de choque antes de que la interfaz dependa de los dos.
