# Arquitectura — cómo se conectan las piezas

Este documento no es código: es el mapa de cómo encajan los módulos que ya
existen, para cuando se construya la interfaz Electron. Se actualiza cada vez
que cambie una pieza o se resuelva uno de los pendientes de abajo.

## Regla del proyecto: fechas siempre en día LOCAL, nunca UTC

Nunca `.toISOString()`, nunca `Date.UTC`, ni en código de producción ni en
pruebas, para nada que represente "qué día es esto". Siempre construir/leer
el día con los getters locales (`getFullYear()`, `getMonth()`, `getDate()`),
como ya hacen `iso()`/`fmt()` en `procesar.js` y `fechaCorta()` en
`generar.js`.

Por qué importa tanto: fue la causa de un fallo grave en el sistema
anterior (el corte de fecha comparaba por marca de tiempo completa en vez de
por día, y un aprendiz volvía a salir reportado en la siguiente corrida —
ver el comentario en `procesar.js` junto a `iso()`). Y volvió a aparecer,
esta vez en la propia prueba automatizada: `recorrido_completo.test.js`
calculaba "hoy" con `.toISOString()` para pasárselo a `revertirFecha`, y
pasadas las 19:00 hora de Colombia (UTC-5) UTC ya está en el día siguiente,
así que no encontraba nada que revertir. Se reprodujo de verdad corriendo la
suite a las 10pm y se corrigió con `hoyISOLocal()` (ver ese archivo). Dos
apariciones del mismo error en el mismo proyecto — de ahí que quede como
regla explícita aquí, no solo como corrección puntual.

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
| `config:obtener-carpeta-trimestre` | `carpetaTrimestreEfectiva()` (real o, en modo prueba, la carpeta demo) |
| `config:obtener-codigo-instructor` / `config:guardar-codigo-instructor` | leen/escriben `configuracion.json`, alimentan `ACTAS_CODIGO_INSTRUCTOR` |
| `modoPrueba:obtener` / `modoPrueba:alternar` / `modoPrueba:restablecer` | ver "Modo prueba" abajo |

"Inicializar trimestre" queda como asistente de 2 pasos explícitos (crear
control → el instructor llena PARAMETROS a mano en Excel → migrar
aprendices), no un formulario único: PARAMETROS lo sigue llenando el
instructor a mano, la app no lo automatiza (ver pendiente 3, ya resuelto en
ese sentido).

### Modo prueba

Interruptor visible en el encabezado (`src/main/modoPrueba.js`), pensado
para hacer pruebas repetidas o demostrar la app en el computador de un
compañero sin arriesgar un solo archivo real. Con el modo prendido:

- `aplicarVariablesDeEntorno()` (en `ipc.js`) pone
  `ACTAS_REGISTRO_RUTA=userData/modo_prueba/registro.pruebas.json` — el
  mismo mecanismo de aislamiento que ya usaba la prueba automatizada
  (`generar.js` lo lee en cada llamada, nunca lo cachea).
- `carpetaTrimestreEfectiva()` devuelve `userData/modo_prueba/trimestre_demo/`
  en vez de la carpeta real configurada; ahí vive una única ficha ficticia
  ("0000000 - FICHA DE DEMOSTRACIÓN (MODO PRUEBA)") que `asegurarFichaDemo()`
  arma automáticamente si no existe.
- "Inicializar trimestre" queda deshabilitado (`bloquearSiModoPrueba()`):
  implica diálogos nativos de carpeta/archivo del sistema operativo, que no
  tiene sentido ni es seguro simular.
- "Restablecer modo prueba" borra y reconstruye SOLO
  `userData/modo_prueba/` (registro de pruebas + ficha demo). Nunca toca
  `registro.json` ni ninguna carpeta de ficha real.
- Al apagar el modo, producción sigue exactamente donde estaba: su
  `registro.json` nunca se tocó mientras el modo estuvo prendido, porque
  `ACTAS_REGISTRO_RUTA` apuntaba a otro archivo todo ese tiempo.

Verificado con Playwright: activar → generar acta dentro del sandbox →
confirmar que la carpeta y el registro reales no cambiaron en absoluto →
restablecer → apagar → confirmar que se vuelve a producción intacta.

### Numeración compuesta de actas

El número de acta es `951210-XX-NNN`: `951210` es el código fijo del Centro
de Biotecnología Agropecuaria (constante `CODIGO_CENTRO` en `generar.js`),
`XX` el código corto del instructor (dos dígitos, configurado en la app
junto a la carpeta del trimestre — `config:guardar-codigo-instructor`,
alimenta `ACTAS_CODIGO_INSTRUCTOR`), y `NNN` el consecutivo propio de ese
instructor desde 001. Deliberadamente NO vive en PARAMETROS todavía —
queda fácil de mover ahí más adelante si hace falta, pero por ahora el
centro va fijo en código y el instructor en la configuración de la app.

`revertir.js` extrae el consecutivo propio con una expresión regular sobre
el grupo de dígitos final (`consecutivoPropio`, `/(\d+)$/`) en vez de
`parseInt` directo sobre el número completo — `parseInt("951210-07-001")`
daría `951210`, no `1`.

### Identidad visual

Verde institucional del SENA (`#39A900`, variable `--acento` en
`estilos.css`) como color principal, sobre grises y blancos ya existentes;
franja verde superior en el encabezado. Crédito discreto en el pie de
página: "Desarrollado por Carlos José Gregorio Contreras Vivas"
(`footer.credito` en `index.html`/`estilos.css`).

### Visión a futuro (dirección, no construido)

Si esta versión es aceptada, la siguiente etapa sería comunicar las
instalaciones entre sí: que el acta de equipo ejecutor recoja
automáticamente las novedades de TODOS los instructores de la ficha
(hoy solo trae las del instructor que la genera; las demás filas quedan
vacías "para diligenciar en la reunión" — ver `equipo_ejecutor.js`), en
vez de depender de que cada quien la diligencie a mano en la reunión.
Ninguna decisión de esta versión debería estorbar ese camino: en
particular, `equipo_ejecutor.js` ya separa "novedades propias" (calculadas)
de "filas vacías de los demás" como una lista, no como un hueco fijo en la
plantilla — llenar esas filas desde otras instalaciones sería agregar un
insumo más a esa misma lista, no rediseñar el flujo.

### Verificación (no solo "abre la ventana")

Los 6 paneles probados con Playwright (`_electron`) contra datos reales o
fieles a lo real, botón por botón: lanzar la app, marcar fichas, leer el
texto exacto de cada modal de vista previa, aprobar, y confirmar en disco
(y por checksum, cuando aplica) que pasó lo que la vista previa dijo que
iba a pasar. No "debería funcionar": se leyó la salida real cada vez.

- **Generar actas**: vista previa con la medida por aprendiz
  ("PEREZ GOMEZ JUAN CARLOS → primer llamado de atención"), `.docx`
  confirmado en disco tras aprobar.
- **Acta de entrega**: la vista previa mostraba solo la medida, sin
  evaluados/no evaluados/panorama que sí trae el resumen real — corregido
  con un renderizador propio (`renderizarResumenEntrega` en `app.js`).
- **Acta de equipo ejecutor**: confirmado con el horario real de la ficha
  3479381 — la fila del instructor que genera trae sus propias novedades
  ("MERCADO PATIÑO RONY EDUARDO: no asistió el 04/08/2026."), las demás
  filas quedan vacías ("para diligenciar en la reunión").
- **Convertir a PDF**: los `.docx` quedaron byte a byte idénticos por
  checksum antes/después de convertir; sin errores de consola del
  renderer (la ausencia de ventana de `cmd`/PowerShell ya la garantiza
  `windowsHide: true` en `convertir_pdf.js`, verificado ahí en su momento).
- **Revertir** (la acción destructiva, con más rigor a propósito):
  - La vista previa lista EXACTAMENTE lo que se va a borrar (aprendiz +
    medida + número de acta, más si hay entrega) antes de tocar nada; se
    confirmó que NO existe ningún respaldo de `registro.json` mientras el
    modal de vista previa está abierto — el respaldo solo aparece después
    de aprobar.
  - `revertirFecha` ahora respalda `registro.json` y el control ANTES de
    borrar el primer archivo (antes se respaldaba justo antes de
    sobrescribir el registro, es decir, después de haber borrado ya los
    `.docx` — reordenado).
  - Cada borrado se COMPRUEBA después de intentarlo (`fs.existsSync` tras
    `unlinkSync`), no se da por hecho porque `unlinkSync` no haya lanzado
    error. Si algún archivo no queda realmente borrado, `revertirFecha`
    lanza un error explícito y **no** sobrescribe el registro — así nunca
    queda un registro que dice "revertido" mientras el archivo real sigue
    en la carpeta (el fallo exacto que describía el encargo del sistema
    anterior). Probado con un bloqueo real: se generó un acta, se abrió su
    `.docx` en una instancia real de Word (sin cerrarla, para que el
    archivo quedara con un bloqueo real de escritura), y se intentó
    revertir — tanto desde Node directo como desde la interfaz: el error
    salió claro en el panel de resultados de la app (no en una consola,
    no una ventana nativa), el archivo siguió existiendo, y el registro
    no se tocó. Ver captura de la verificación.
- **Inicializar trimestre**: probados los 2 pasos por separado — crear el
  control desde la plantilla (y abrirlo en Excel), y migrar aprendices
  desde un reporte de SOFIA ficticio (con un caso EN INDUCCIÓN, para
  confirmar la corrección) sobre la ficha recién creada.

Varios bugs reales aparecieron en el proceso y se corrigieron, ninguno
hipotético:
- **CSS**: `.modal-overlay { display: flex }` (una clase) le ganaba en
  especificidad al `[hidden] { display: none }` del navegador (un
  atributo), así que el modal de vista previa se veía SIEMPRE, vacío, desde
  el primer instante. Arreglado con `.modal-overlay[hidden] { display: none }`.
- **El mismo patrón se repitió con el banner de modo prueba**
  (`.banner-modo-prueba { display: flex }`): se veía siempre, con o sin
  modo prueba activo. Pasó inadvertido en la primera verificación porque
  el script de Playwright solo leía la propiedad DOM `.hidden` (que sí
  reflejaba el atributo correctamente) y nunca el estilo calculado real —
  lo delató una captura de pantalla al ajustar los colores institucionales.
  Arreglado igual: `.banner-modo-prueba[hidden] { display: none }`.
  Lección: verificar con Playwright el atributo `hidden` no basta; hay que
  mirar el render (captura de pantalla o `getComputedStyle`) para cualquier
  elemento que se oculte con `[hidden]` y tenga también una clase con
  `display`.
- **Día UTC vs. local, en la propia prueba automatizada** — ver la regla
  del proyecto al inicio de este documento.
- **Cero falsy en JavaScript**: `crearFichaDemo()` (modo prueba) ponía
  `FICHA = 0` en PARAMETROS; `leerControl` usa
  `if (!params.ficha || !params.programa) throw`, y `0` es falsy en JS, así
  que la ficha de demostración siempre salía como "PARAMETROS incompletos".
  Arreglado usando un valor de ficha no numérico truthy (`"0000000"` como
  cadena) en la ficha ficticia.

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
  Deshace actas de aprendiz individuales, el acta de entrega (`reg.entregas`)
  y las actas de equipo ejecutor (`reg.equipoEjecutor`) de la fecha
  revertida — borra el `.docx` cuando conoce su ruta, avisa sin fallar
  cuando no la conoce (actas de antes de que se empezara a guardar), y deja
  otras fechas de `reg.equipoEjecutor` intactas. Pendiente 5 cerrado (los 3
  pasos hechos). También borra el `.pdf` hermano de cada `.docx` que
  revierte, si existe; a diferencia del `.docx`, un `.pdf` bloqueado avisa
  en vez de abortar la reversión (pendiente 8, cerrado).

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
5. ~~**`revertirFecha` no sabe deshacer el acta de equipo ejecutor**~~ —
   **resuelto**, en tres pasos acordados con el instructor, con contexto
   completo sobre deserciones ya dado (corrige una nota anterior de este
   documento, ver más abajo):
   - **Contexto de deserción** (aclarado por el instructor): el acta de
     equipo ejecutor es lo que AUTORIZA el reporte de deserción de un
     aprendiz intermitente (caso B). Orden real: (1) el acta lista a los
     aprendices con inasistencias y autoriza — esto ya existe; (2) se
     genera el formato Excel de deserción (causa 01, FECHA DE INICIO DE
     DESERCIÓN = la primera inasistencia injustificada, umbral 5
     inasistencias injustificadas dentro del trimestre actual, sin
     arrastrar del anterior) — **no construido todavía**; (3) el Forms lo
     diligencia el instructor a mano, fuera de la app. La app solo cubre
     (1) y (2). El caso más frecuente (A: aprendiz que deja de asistir sin
     pasar por el acta, marcado a mano por el instructor en APRENDICES en
     cuanto se entera) es 100% manual y ya funciona sin cambios
     (`recibeLlamado()` ya excluye a quien no esté en `EN FORMACION`): no
     hay hueco de reversión ahí porque la app nunca genera ni escribe nada
     para ese caso. El ajuste por reintegro también es manual, no se
     automatiza.
   - **Paso 1 (hecho)**: `recalcularConsecutivo` (`revertir.js`) ahora
     incluye `reg.equipoEjecutor[ficha]` en el cálculo del máximo — sin
     esto, revertir cualquier otra acta de la ficha podía bajar
     `reg.consecutivo` por debajo de un número de equipo ejecutor que
     seguía en uso, y la siguiente acta generada lo reutilizaría sobre un
     documento real distinto.
   - **Paso 2 (hecho)**: `prepararActaEquipoEjecutor` (`equipo_ejecutor.js`)
     ahora completa la entrada de `reg.equipoEjecutor[ficha]` con la ruta
     de su `.docx` (campo `ruta`), justo después de escribirlo — igual
     patrón que ya usa `procesar.js` tras `generarActa()` para completar
     `archivo` en el historial del aprendiz. `generarActaEquipoEjecutor`
     (en `generar.js`) no lo hace directamente porque no conoce la carpeta
     de salida ni el nombre del archivo; eso lo decide quien la llama.
     Solo aplica a las actas nuevas; las viejas quedan sin `ruta`. Desde el
     paso 4 (ver abajo), esa ruta se guarda relativa a la carpeta del
     trimestre, no absoluta.
   - **Paso 3 (hecho)**: `revertirFecha` ahora detecta las entradas de
     `reg.equipoEjecutor[ficha]` cuya fecha coincida con la revertida, las
     incluye en `numerosARevertir` (para el HISTORICO y el consecutivo, ya
     cubiertos por el paso 1), y borra su `.docx` con la misma comprobación
     de borrado sostenido que ya usan los llamados y la entrega. Si una
     entrada no tiene `ruta` (actas de antes del paso 2), no falla en
     silencio: se quita igual del registro y se agrega un mensaje a
     `reporte.avisos` (ficha, fecha y número de acta) para que el
     instructor la borre a mano — mostrado en el panel de revertir con la
     misma clase `aviso` que usan los demás paneles. Las entradas de OTRAS
     fechas para la misma ficha no se tocan (probado explícitamente: dos
     entradas con fechas distintas, revertir una deja la otra intacta, con
     su `.docx` sin borrar y sin que se elimine la clave de la ficha en
     `reg.equipoEjecutor`).
   - **Paso 4 (hecho)**: `ruta` era el único sitio de todo el proyecto que
     persistía una ruta absoluta — se rompía si el instructor movía la
     carpeta del trimestre, cambiaba de letra de unidad o reinstalaba
     Windows, justo lo que `revertirFecha` necesita para borrar el `.docx`
     y su `.pdf`. Ahora se guarda **relativa a la carpeta del trimestre**
     (`rutaRelativaSiCorresponde`/`resolverRutaEquipoEjecutor`, en
     `equipo_ejecutor.js`). La carpeta del trimestre nunca se relee de
     `configuracion.json` en este flujo: se deriva como el padre de la
     carpeta de ficha que ya llega como parámetro (`fichas:listar`, en
     `ipc.js`, arma cada carpeta de ficha como hija directa de
     `carpetaTrimestre`, siempre) — así, si el instructor configura otro
     trimestre entre generar y revertir, no afecta la ficha ya
     seleccionada, que se resuelve contra su propia carpeta, no contra el
     valor de configuración vigente en ese momento.
     - Compatibilidad: `path.isAbsolute()` distingue el formato viejo del
       nuevo en cada lectura — las rutas absolutas ya guardadas siguen
       resolviendo exactamente igual que antes.
     - Migración perezosa (no un script aparte): cuando `revertirFecha`
       toca una ficha, de paso convierte a relativa cualquier `ruta`
       absoluta de esa ficha que caiga DENTRO de la carpeta del trimestre
       actual; si cae fuera, se deja intacta (no hay forma segura de
       saber a qué correspondía). Solo se persiste si `simular=false`
       (mismo `guardarRegistro` que ya hace la reversión real). Una ficha
       en la que nunca se revierte nada no se migra sola — sigue
       funcionando por la vía de compatibilidad, solo no se "limpia".
     - Si una ruta guardada (de cualquiera de los dos formatos) ya no
       resuelve a un archivo existente, se avisa con la ruta resuelta que
       se intentó y qué hacer (el `.docx` pudo haberse movido o borrado a
       mano; localizarlo y borrarlo a mano) — nunca en silencio, y con un
       mensaje distinto del caso "no tiene `ruta` guardada" (actas de
       antes del paso 2).
   - La generación del `.xlsx` de deserción (paso 2 del flujo real, no
     construido) y su reversión quedan fuera de este alcance — es
     funcionalidad nueva, no un hueco de `revertirFecha`.
6. ~~**"Convertir actas firmadas a PDF"**~~ — **resuelto**:
   `convertir_pdf.js`, envolviendo (sin rediseñar) la solución del
   instructor ya probada en producción (Word por automatización de
   PowerShell). Detecta Word instalado y si ya está abierto.
7. ~~**Posible duplicación `estado_ficha.json` / `registro.json`**~~ —
   **resuelto**: era una nota equivocada de este documento, no un hueco
   real. El acta de equipo ejecutor nunca vivió en `estado_ficha.json`:
   `estado.js` traía un campo `acta_equipo_ejecutor` en `estadoNuevo()`
   que nada llenaba nunca (`equipo_ejecutor.js` ni siquiera importa
   `estado.js`); se quitó ese campo muerto. El único registro real,
   siempre, fue `reg.equipoEjecutor[ficha]` en `registro.json` — no hay
   duplicación ni conflicto que resolver.
8. ~~**`revertirFecha` borra el `.docx` pero no el `.pdf` convertido**~~ —
   **resuelto**. `revertirFecha` calcula la ruta del `.pdf` hermano de
   cada `.docx` que revierte (mismo nombre, `.docx`→`.pdf`, ya que no hay
   ningún dato guardado sobre conversión — el único rastro es el archivo)
   y lo borra junto con él. A diferencia del `.docx`, si el `.pdf` no se
   puede borrar (abierto en Adobe/Edge u otro visor) NO aborta la
   reversión: el `.docx` sí quedó revertido y el registro sí debe quedar
   actualizado. Se avisa en `reporte.avisos` con la ruta completa,
   explicando que corresponde a una acta revertida y que hay que cerrarlo
   y borrarlo a mano antes de poder convertir la nueva versión con el
   mismo número. Aplica a los tres tipos de acta (llamados, entrega,
   equipo ejecutor) por el mismo mecanismo — aunque, ver pendiente 9, hoy
   en la práctica solo entrega y equipo ejecutor llegan a tener un `.pdf`
   real generado por la app. Probado con un bloqueo simulado (una carpeta
   con el nombre exacto del archivo, para que `unlinkSync` falle de forma
   determinista y repetible, sin depender de Word/Adobe reales): un
   `.docx` bloqueado sigue abortando la reversión igual que antes; un
   `.pdf` bloqueado avisa y dejar completarse el resto.

   Dos observaciones anotadas al implementar esto, sin resolver:
   a) En la rama de actas sin campo `archivo` (legacy, buscadas por número
      en el nombre), el `.pdf` se detecta al ejecutar, no en la
      simulación — la vista previa no lo anuncia en ese caso aunque
      después sí lo borre.
   b) Si un `.docx` bloqueado lanza, los archivos y PDFs que ya se
      alcanzaron a borrar antes del bloqueo quedan borrados, pero el
      registro no se guarda (para no afirmar una reversión incompleta):
      el registro sigue listando documentos que ya no están en disco. Es
      un problema del diseño original (ya existía antes de este cambio),
      pero borrar también PDFs aumenta lo que se puede perder en ese
      escenario. Evaluar si conviene borrar todo primero y decidir el
      `throw` al final, en vez de ir borrando y lanzando a mitad de camino.
9. **"Convertir a PDF" no llega a los llamados de atención** — anotado,
   sin implementar. `convertirPdf` (`convertir_pdf.js`) lee la carpeta que
   se le pasa con `fs.readdirSync` **no recursivo**; el botón la llama con
   la carpeta raíz de la ficha (`[...seleccionadas]`), donde SÍ están el
   `.docx` de entrega y el de equipo ejecutor, pero los llamados/plan/
   comité viven en la subcarpeta `LLAMADOS DE ATENCION/`, que nunca se
   pasa. El panel de "Estado de la ficha" sí calcula y muestra "sin PDF"
   para esos llamados (`resultado.actasSinPdf` en `ipc.js`, mirando esa
   subcarpeta), pero no existe ninguna acción en la app que realmente los
   convierta — el indicador y el botón están desconectados. No tocar
   hasta decidir el diseño (¿el botón recorre también esa subcarpeta?
   ¿se ofrece por separado?).
