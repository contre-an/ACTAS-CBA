# Proyecto: Generador de Actas CBA (versión distribuible)

Trabajaremos en `C:\ACTAS CBA`. Es un proyecto NUEVO. En la carpeta ya están
copiados `procesar.js`, `generar.js` y `estado.js`, traídos de un sistema
anterior: **están sucios y hay que limpiarlos** (ver más abajo).

## Qué es esto

Una aplicación de escritorio (Electron) para instructores del SENA que genera
actas disciplinarias en Word a partir del control de asistencia en Excel,
según el Acuerdo 009 de 2024.

Se va a **distribuir e instalar en los computadores de otros instructores**, por
eso: sin IA, sin API keys, sin n8n, sin servicios en segundo plano, sin Python.
Solo Node.js y código propio.

## Principio rector

**Estos documentos tienen consecuencias disciplinarias sobre aprendices reales.**
La lógica debe ser determinista, auditable y repetible. Nada de "interpretar":
reglas explícitas y verificables. Ante la duda, se le pregunta al instructor.

## Estado del código heredado

`procesar.js`, `generar.js` y `estado.js` funcionan y llevan meses de
correcciones. **No reescribirlos desde cero**: limpiarlos y conservar su lógica.

Hay que quitarles:
- Toda referencia al agente de IA: `descripcionesDeActividades`, la invocación
  de `resumir-cli.js`, `require("dotenv")`, cualquier uso de `.env`
- En `estado.js`, lo que solo servía al flujo con IA

Hay que conservar íntegro:
- El escalamiento (llamado 1 → llamado 2 → plan de mejoramiento → comité)
- El corte por fecha (`ultimaFechaIncidente`), **comparado por DÍA, no por marca
  de tiempo**: las fechas de Excel traen segundos de desfase y comparar
  timestamps completos hacía que el último día ya reportado se repitiera en el
  acta siguiente. Fue un fallo real y grave; no reintroducirlo
- El filtro por estado: solo los aprendices EN FORMACIÓN reciben actas
- La numeración consecutiva y el registro (`registro.json`)

## Alcance de la versión 1.0

Botones: llamados de atención (1 y 2), plan de mejoramiento, citación a comité,
acta de entrega de ficha, inicializar trimestre, convertir actas firmadas a PDF.

Toda acción destructiva o que genere documentos debe mostrar **vista previa y
pedir aprobación** antes de ejecutar.

## Lo que hay que construir

1. **Extractor de horarios en PDF con código puro** (`pdf-parse` u otra
   librería). El horario del SENA tiene formato tabular fijo: ficha, trimestre,
   fechas, competencia, RAP, jefe de grupo, instructor, día, hora, sede,
   ambiente. De ahí salen los instructores y sus competencias.
2. **Hoja DESCRIPCIONES en la plantilla del control**: dos columnas (actividad,
   descripción). Los nombres de actividad se traen del encabezado de la hoja
   NOTAS; el instructor solo escribe el texto. Reemplaza al resumen que antes
   hacía la IA.
3. **Migrar a JavaScript** el poblado de aprendices desde el reporte de SOFIA
   (hoy es Python con pandas/openpyxl/xlrd). Usar la librería `xlsx`, que ya
   está en el proyecto. Objetivo: que el instructor no tenga que instalar Python.
4. **Interfaz Electron** con selección de fichas por casillas y vista previa.
5. **Herramienta de reversión**: deshacer las actas de una fecha cuando una
   corrida sale mal (borrar archivos, revertir el registro, limpiar el
   histórico, recalcular el consecutivo). Es indispensable.

## Primera tarea

1. Inicializa el repositorio Git con un `.gitignore` adecuado para Node
   (`node_modules`, `registro.json`, `*.respaldo_*`, `.env`)
2. Revisa los tres archivos heredados y **repórtame** qué referencias a IA
   encuentras, antes de tocarlos
3. Propón la estructura de carpetas del proyecto
4. Primer commit con lo que hay

No avances a la interfaz ni al empaquetado hasta que la lógica esté limpia y
probada contra un control de asistencia real.
