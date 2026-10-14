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
