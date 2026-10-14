# Panorama · Constelación neuronal (SOL)

La página **/panorama** muestra la constelación dentro de las crónicas diarias.
La ruta **/panorama/neural** abre la misma visualización con controles de cámara y color.

## Modo pantalla completa / protector de pantalla

Abrí **/panorama/neural?screensaver=1** desde un navegador con sesión SOL iniciada.
Tocá «Pantalla completa», o usá F11. En una PC Windows también podés abrir el navegador
en modo kiosco:

```powershell
# Reemplazá 127.0.0.1:3000 por la dirección y puerto reales de SOL.
start msedge --kiosk "http://127.0.0.1:3000/panorama/neural?screensaver=1" --edge-kiosk-type=fullscreen
```

La pantalla utiliza la sesión y permisos existentes. No hay URL pública ni token de acceso
añadido. En otro dispositivo necesitás que SOL sea accesible en la red y que la sesión esté iniciada.

## Fuente de datos

`GET /v1/panorama/network` responde sólo con centros, enlaces conceptuales,
conteos de eventos recientes, identificadores opacos, marcas de tiempo e intensidad.
Consulta `listTimeline(principal,{limit:240})` y las ediciones diarias del miembro.
No devuelve títulos, resúmenes ni cuerpos de mensajes privados.

* Período: últimas 24 horas, muestra de hasta 240 registros accesibles.
* Refresco: 30 segundos mientras la página está visible (el modo pantalla completa permanece activo).
* **No se interpreta una conexión como una llamada real entre sistemas:** los enlaces son
  relaciones de proyección hacia Panorama. Los pulsos representan observaciones concretas.
* Los filamentos periféricos son decoración para preservar la estética de la ilustración.
* Si faltan datos, no se simula actividad real ni se inventan alertas.
* Para Pantalla completa la cámara rota lentamente, hace zoom y sigue centros activos.

El visor conserva la versión Three.js con bokeh, paletas y cámara de AI Constellation;
Three.js r152 se distribuye localmente para no depender de un CDN en el uso diario.

## Validación sugerida

```bash
pnpm --filter @sol/server typecheck
pnpm --filter @sol/server test
pnpm --filter @sol/server build
```

Entrar a /panorama, cargar el iframe y confirmar en navegador de escritorio y móvil:
los controles de color y rotación son accesibles en el modo de estudio; al activar
?screensaver=1 desaparecen, la cámara se mueve y los eventos nuevos resaltan enlaces.
Revisar 401 al acceder al endpoint o pantalla sin sesión y comprobar aislamiento entre miembros.

**Nota**: la app SOL debe estar iniciada para recibir actualizaciones. El navegador no puede
deshabilitar el protector de pantalla del sistema operativo por sí solo.

## Red neuronal jerárquica (v0.15.29)

* **Centros:** SOL, Panorama, Pulse y fuentes conectadas.
* **Subcentros:** grupos como Mensajes, Ventas registradas, Actividad comercial,
  Actividad de impresión, Impresoras y Dispositivos.
* **Nodos persistentes:** cada impresora configurada en el roster y cada dispositivo
  identificado en el metadato accesible de Life (ej. `printerName` y `entityId`).
  No se consulta ni se inventa un estado activo por el mero hecho de estar en el roster.
* **Relés reales:** hasta 64 registros recientes con identificadores estables de Life,
  conectados a su grupo, impresora o dispositivo y con etiqueta categórica.
* **Microfilamentos decorativos:** nunca se muestran como ventas, mensajes ni acciones de SOL.
* **Foco:** el nodo principal y sus vecinos muestran etiquetas espaciales, sin enviar al
  navegador textos privados ni datos de comprador.

Para mantener las impresoras visibles incluso si no hubo actividad reciente en Life,
configurá opcionalmente el inventario en el archivo **.env persistente** del SOL local:

```dotenv
SOL_NEURAL_PRINTERS=A1 - A,A1 - B AMS,A1 MINI A,A1 MINI B,A1 MINI C,A1 MINI D
```

Esta opción sólo identifica nombres de impresoras. El inventario puede estar en blanco
en otras instalaciones, y sólo lo reciben sesiones owner/adult. Si más adelante Bambuddy
proyecta observaciones estructuradas en Life, el visualizador asociará eventos a cada
máquina según `printerName` o `printerId`. Para estados de impresión en vivo se
necesitará un lector Bambuddy autorizado adicional: este cambio no los presume.

La constelación se centra alrededor del núcleo, con subgrupos superpuestos suavemente
y un número de filamentos reducido automáticamente en móviles. El foco automático
evita seleccionar relés históricos por defecto, pero se puede hacer clic para
inspeccionar un relé y ver su etiqueta genérica y hora.

## Preferencias compartidas (SOL 0.15.30)

En **/panorama/neural** el panel «VISUAL STUDIO» guarda automáticamente en
\`localStorage["sol.neural.preferences.v1"]\` la paleta, colores, brillo,
autoenfoque, autorrotación, zoom, deriva, velocidad de giro y **densidad de
hubs** (0–100 %, valores mayores = centros más juntos). El iframe de **/panorama**
y el protector de pantalla usan las **mismas preferencias**, sin imponer otro
conjunto de controles; los cambios de otra pestaña se reciben con el evento
\`storage\`.

Las etiquetas flotantes del foco y sus vecinos permanecen ocultas durante el
movimiento de cámara, y aparecen tras 1,2 segundos de enfoque estable. El
recorrido automático sólo muestra etiquetas al centrarse en hubs o subcentros;
la selección manual permite inspeccionar entidades individuales.

La proyección ortográfica Three.js ajusta el frustum a la relación ancho/alto
real y utiliza unidades de escena uniformes (sin estirar nodos o filamentos).
El iframe Panorama usa relación **16:9** en escritorio y **4:3** en móvil;
el fallback Canvas respeta el mismo escalado isotrópico.

En **Sistema → Colores de SOL** hay cuatro temas y cinco selectores
(principal, fondo, paneles, texto y luz ambiental), guardados en
\`localStorage["sol.appearance.v1"]\` y aplicados a todas las páginas del
marco SOL. Estas preferencias de navegador son visuales, no se transmiten al
servidor ni requieren migraciones; cada navegador conserva su propia selección.
