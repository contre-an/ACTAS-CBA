# Arquitectura — cómo se conectan las piezas

Este documento no es código: es el mapa de cómo encajan los módulos que ya
existen, para cuando se construya la interfaz Electron. Se actualiza cada vez
que cambie una pieza o se resuelva uno de los pendientes de abajo.

## Módulos y su responsabilidad

| Módulo | Responsabilidad | Toca archivos |
|---|---|---|
| `estado.js` | Memoria por ficha (`estado_ficha.json`): clasifica los archivos de la carpeta de una ficha, resuelve cuál es el control real. | Lee/escribe `estado_ficha.json` en la carpeta de cada ficha. |
| `horario.js` | Extrae del horario en PDF: ficha, trimestre, fechas, programa, y por sesión competencia/RAP/instructor/jefe de grupo/día/hora/sede/ambiente. | Solo lee el PDF. No escribe nada. |
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
2. Se copia la plantilla maestra del control (**no existe todavía en el
   proyecto** — ver pendiente 1) a `CONTROL_ASISTENCIA_<ficha>.xlsx` en esa
   carpeta.
3. `horario.js → leerHorario(rutaPdf)` da ficha, programa, competencia(s) e
   instructor(es) de la ficha.
4. Con eso se llena la hoja PARAMETROS del control nuevo: `FICHA`,
   `PROGRAMA DE FORMACION`, `COMPETENCIA`, `INSTRUCTOR`. **Falta** el
   documento y correo del instructor, que el horario no trae (ver
   pendiente 2).
5. `sofia.js → leerReporteSofia(rutaXls)` da la lista de aprendices, ya con
   `EN INDUCCIÓN` corregido a `EN FORMACION`.
6. Vista previa al instructor (cuántos aprendices, el aviso de
   `poblarAprendices` si la hoja ya tenía datos) → aprobación → recién ahí
   `sofia.js → poblarAprendices(rutaControl, aprendices, {simular:false})`.
7. `estado.js → estadoNuevo(ficha)` + `guardarEstado(carpetaFicha, estado)`
   para dejar registrado `aprendices_migrados: true`, `total_aprendices`, y
   `equipo_ejecutor` con lo que dio `leerHorario` (jefe de grupo,
   instructor(es) por competencia).

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

1. **Plantilla maestra del control**: no hay un `CONTROL_ASISTENCIA` en
   blanco en el proyecto. "Inicializar trimestre" no puede arrancar sin
   ella. Falta que el instructor la aporte (y que incluya ya la hoja
   DESCRIPCIONES, punto 2 del encargo).
2. **Documento y correo del instructor**: `horario.js` solo entrega el
   nombre (tal como viene en el PDF). PARAMETROS del control necesita
   también documento y correo. Hay que decidir de dónde salen (¿un
   directorio de instructores del centro? ¿el instructor los escribe a
   mano la primera vez?).
3. **`generarEntregaControl` sin vista previa**: hay que agregarle un
   parámetro `simular`, igual que tiene `procesarControl`, antes de
   conectarla a un botón.
4. **Ficha con varios instructores/competencias**: el horario real de
   prueba (ficha 3479381) tiene 6 instructores distintos dictando
   competencias diferentes en la misma ficha. Falta decidir: ¿un control
   por ficha con un solo PARAMETROS.instructor (y los demás quedan solo
   como dato informativo), o el control ya está pensado por
   competencia/instructor? Esto hay que resolverlo con el instructor antes
   de conectar `horario.js` a la inicialización.
5. **"Convertir actas firmadas a PDF"**: sin diseño.
6. **Posible duplicación `estado_ficha.json` / `registro.json`**: ambos
   pueden terminar guardando quién es el instructor y qué se generó. Antes
   de que la interfaz dependa de los dos, aclarar cuál manda en caso de
   choque (probablemente `registro.json` para actas/consecutivo, y
   `estado_ficha.json` solo para lo que no depende de escalamiento —
   `equipo_ejecutor`, `archivos_detectados`).
