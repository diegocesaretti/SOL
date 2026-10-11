# Panorama 0.15.27: criterio editorial y equidad familiar

## Qué mejora

- La redacción ahora usa un **editor de relevancia** previo al modelo: pondera vencimientos, pruebas, tareas, reclamos, devoluciones, salud, incidentes de hogar y urgencias, en lugar de considerar todos los mensajes igual de importantes.
- La selección está equilibrada por **personas identificadas**, temas y fuentes, pero no aplica cuotas de palabras iguales cuando hay una urgencia real.
- La atribución de un WhatsApp utiliza únicamente `senderName` o un chat directo inequívoco. Nunca considera que `source_items.owner_member_id` identifica al autor del mensaje: ese ID suele ser el propietario de la cuenta Nexo.
- La fuente Educación local (Moodle / agente escolar) se incorpora como **agenda de referencia** para el relato actual, con fechas de pruebas, materias y entregas cuando existen. Los posibles exámenes sin fecha confirmada se señalan como pendientes; no se inventan.
- Las fuentes originales de Life mantienen las reglas de acceso. No se importa automáticamente información escolar privada a otro hogar ni se da acceso a otros usuarios.

## Activación del contexto familiar

Crear `SOL_DATA_DIR/panorama-family.json` con estructura:

```json
{
  "householdId": "UUID del hogar autorizado en SOL",
  "members": [
    {"name": "Persona A", "aliases": ["Alias A"]},
    {"name": "Persona B"}
  ]
}
```

La lectura del índice privado de Educación **solo** se habilita si:
1. existe el archivo de configuración;
2. `householdId` coincide exactamente con la sesión que genera la crónica;
3. la sesión pertenece a un propietario o adulto autorizado;
4. la fecha solicitada es hoy;
5. el nombre del alumno aparece explícitamente en el roster configurado.

El sistema educativo actual cubre Moodle de Luca, mientras Classroom de Cruz aún no está conectado. No se supone actividad escolar para quien todavía no tenga fuente.

## Ediciones

Sigue generando a las 8:00, 12:00 y 18:00. Se incorpora una edición extraordinaria `review` para **revisar el día con los nuevos criterios** sin sobrescribir crónicas históricas. Sólo está disponible para la fecha actual y una vez por día.

Los hechos procedentes de Mercado Libre se priorizarán cuando esa fuente esté conectada a Life; esta versión **no** instala ni habilita por sí sola el conector de Mercado Libre.
