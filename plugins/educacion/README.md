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
