# BWA 3D → SOL Pulse

Integración opt-in con `plugins/pulse-engine`. Se reutiliza el cliente de la API autenticada de Mercado Libre de BWA; no se copian credenciales ni tokens OAuth.

Configurar con el gestor de plugins:
- `BWA3D_PULSE_ENABLED=true`
- `BWA3D_PULSE_ENDPOINT=http://127.0.0.1:8794/v1/ingest`
- `BWA3D_PULSE_TOKEN` = mismo token que `PULSE_ENGINE_INGEST_TOKEN`, de 32+ caracteres
- `BWA3D_PULSE_OWNER_ID` = mismo propietario que `PULSE_ENGINE_INGEST_OWNER_ID`
- `BWA3D_PULSE_POLL_MS=180000`

El publicador está apagado de forma predeterminada. La primera pasada solo establece la línea base (cero notificaciones retrospectivas). Cada pasada posterior detecta pedidos nuevos y cambios de estado/cancelaciones, los transmite de manera autenticada a Pulse y actualiza el checkpoint únicamente cuando todas las transmisiones fueron aceptadas. BWA expone su estado en `bwa_3d_status.pulsePublisher`.

Aún no envía mensajes ni desencadena acciones, y no pretende cubrir todos los pedidos antiguos: este es un primer conector seguro mientras se agregan notificaciones webhooks y reconciliación.
