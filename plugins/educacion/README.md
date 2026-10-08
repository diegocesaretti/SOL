# Plugin Educación para SOL

Moodle Campus ISCO (Luca) con arquitectura de proveedores. Google Classroom (Cruz) queda previsto como segundo adaptador, **no conectado aún**.

## Configuración
Instalar `educacion.solplugin` desde SOL > Servicios; establecer `EDUCACION_MOODLE_TOKEN` como ajuste **secret** (nunca en GitHub) y `EDUCACION_STUDENT_NAME=Luca`. Servidor Moodle predeterminado: https://campusisco.com.ar.

Se sincroniza al iniciar y cada 6 horas (configurable). Descarga los archivos visibles para el alumno, extrae texto cuando hay soporte local de Python (PyMuPDF para PDF), y los guarda exclusivamente en `SOL_PLUGIN_DATA_DIR/educacion/`, fuera del árbol del código. En PDFs escaneados sin texto se conserva el original y se marca como pendiente de OCR. **No publica automáticamente archivos ni crea eventos del calendario**. Usa identidad y permisos del alumno.

## Herramientas SOL MCP (lectura salvo donde se indica)
- `educacion_estado`: conexión, sincronización y estado del almacenamiento
- `educacion_materias`: todas las materias detectadas de los alumnos conectados
- `educacion_materiales_buscar`: búsqueda por materia, tema, título y texto extraído
- `educacion_material_leer`: texto extraído, procedencia y archivo local
- `educacion_tareas`: actividades con fecha de entrega
- `educacion_calendario`: calendario Moodle
- `educacion_sincronizar`: sincronización solicitada explícitamente (submit)

Los datos se guardan localmente en archivos no versionados. No se envían documentos escolares a servicios externos por defecto.

## A futuro
`providers/classroom` podrá usar OAuth Google y Classroom API para Cruz sin cambiar el contrato `materias/materiales/tareas/calendario`; no se incluye OAuth de Classroom en esta versión.

## Comprobación
`GET http://127.0.0.1:8783/health` devuelve resumen sanitizado. Para producción, usar SOL MCP y permisos del miembro, no exponer el puerto a la red.

## OCR de imágenes y PDF escaneados

El extractor Python usa Tesseract local si está disponible. Acepta PNG, JPEG, TIFF, WebP y PDF escaneados, además de los PDF con texto y Office. Para español, colocar `spa.traineddata` y `eng.traineddata` en `SOL_PLUGIN_DATA_DIR/educacion/tessdata` (o configurar `EDUCACION_TESSDATA_DIR`). Sin Tesseract, se preservan originales y se muestra una nota de extracción pendiente. Los archivos que ya están en caché pero no tenían texto se reindexan en la siguiente sincronización. No incluir modelos OCR, tokens ni documentos escolares en Git.

## Agente diario de Educación

Se ejecuta a las 18:00 hora argentina todos los días mientras SOL esté encendido. También se puede iniciar desde educacion_agente_ejecutar. Consulta sin filtros de cuenta ni grupo todos los chats INPUT accesibles desde Nexo. La API de Nexo limita a 100 mensajes recientes y 80 coincidencias por búsqueda; se usan diversas búsquedas y el registro muestra los límites de cobertura, por lo que no se garantiza lectura exhaustiva de enormes historiales.

Codex interpreta solamente fragmentos preseleccionados con indicios escolares, comprueba relación con Luca, materia, fecha y temas, y utiliza los apuntes Moodle sincronizados para crear una guía Markdown y PDF. Las guías se almacenan en SOL_PLUGIN_DATA_DIR/educacion/guias, fuera de Git. No envía WhatsApp automáticamente: los PDF quedan pendientes de revisión por un adulto.

Herramientas MCP: educacion_agente_estado (read), educacion_evaluaciones (read), educacion_agente_ejecutar (submit con confirmación). Los mensajes citados se identifican por el ID original de Nexo. Deduplicación por materia, fecha y tema. Los errores quedan registrados en agente.json.

Google Classroom para Cruz permanece pendiente de una integración independiente.
