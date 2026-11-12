<div align="center">

<img src="web/public/favicon.svg" width="64" alt="Logotipo de Trina AX">

<h1>La IA que comparte todo tu equipo.</h1>

Trina AX reúne los archivos, las skills y las herramientas de tu equipo en un solo servidor. La IA de cada persona empieza desde ahí,<br>y cada archivo que abre se comprueba con los permisos de quien preguntó.

<a href="https://apps.apple.com/app/trina-ax/id6829192435"><img src="docs/images/readme/v3/badge-app-store.svg" height="40" alt="Descargar en el App Store"></a>&nbsp;&nbsp;<a href="https://play.google.com/store/apps/details?id=app.trina.ax"><img src="docs/images/readme/v3/badge-google-play.png" height="40" alt="Disponible en Google Play"></a>

[Sitio web](https://ax.trina.app) · [Descargar para Mac y Windows](https://ax.trina.app/download) · [Documentación](docs/README.md) · [Discord](https://discord.gg/zUVfSR8MVk)

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · Español · [简体中文](README.zh-CN.md)

<br>

<a href="https://ax.trina.app/#watch"><img src="docs/images/readme/v3/film.png" width="100%" alt="Mira la historia de 97 segundos. El mismo Claude y la misma petición, con resultados distintos: Alex, responsable de equipo, recibe una propuesta de 7 páginas; Mina, en su primer día y con la carpeta vacía, recibe 'Trina Logistics? Who are they?'. Con Trina, la IA de Mina empieza desde los archivos y las skills del equipo."></a>

</div>

## Lo que recibe tu equipo

**Pregunta junto a cualquier conversación y envía con un clic.** Un chat lateral que solo ves tú; con un clic, la respuesta de Trina llega a la conversación.

<img src="docs/images/readme/v3/room.gif" width="100%" alt="En la conversación Expo booth crew, Mina le pregunta a Trina en un chat lateral que solo ve ella por el montaje del 17 de noviembre, y con un botón envía la respuesta a la conversación.">

**Cada persona ve solo lo que puede abrir.** Si Mina no puede abrir Finance, su IA tampoco. [Cómo funcionan los permisos](docs/PERMISSIONS.md)

<img src="docs/images/readme/v3/access-band.png" width="100%" alt="Carpetas con las caras de quienes pueden abrirlas; Mina no puede abrir shared/Finance.">

- 🤝 **Retoma el chat de IA de un compañero.** Sigue su chat de proyecto; lo que tú pidas se hace con tus permisos.
- 📋 **Skills del equipo.** Escribe una vez cómo trabaja tu equipo y la IA de todos lo sigue.
- 🔌 **Tus herramientas.** Cualquier servidor MCP, Google Drive, Slack y la API de tu empresa, con permisos para cada persona.
- 🕘 **Se guarda cada cambio.** Lo haga una persona o su IA, puedes recuperar cualquier versión.
- 📱 **En cualquier dispositivo.** Mac, iPhone, Android, Windows y cualquier navegador.

## Cómo empezar

- **Hosting de Trina:** sin servidor que gestionar. Prueba gratis de 14 días y luego un plan mensual. [Planes](https://ax.trina.app/pricing)
- **Apps:** [Mac, iPhone, Android y Windows](https://ax.trina.app/download), o cualquier navegador.
- **Autoalojamiento:** en tu propio servidor Linux, con Docker o en un Mac de la oficina. Gratis. [Linux](docs/INSTALL-LINUX.en.md) · [Docker](docs/INSTALL-DOCKER.md) · [Mac de oficina](docs/OFFICE.en.md)

<details>
<summary><b>Pruébalo en tu ordenador en 10 minutos</b> (equipo ficticio, IA desactivada)</summary>

<br>

```sh
git clone https://github.com/trina-app/trina-ax.git && cd trina-ax
bun install --frozen-lockfile && bun run demo   # → http://127.0.0.1:19760 · alice / teamax-demo-1
```

Requiere Bun 1.3.12 y Go 1.27+. No es una instalación para producción. [Guía paso a paso](docs/QUICKSTART.md)

</details>

Trina ofrece el espacio de trabajo, no la IA: conecta cuentas y planes de Claude u OpenAI cuyo uso tengas autorizado. El uso de IA lo factura la cuenta que conectes.

<details>
<summary><b>Datos, límites y lo que no prometemos</b></summary>

### Lo que no prometemos

- Autoalojar no significa funcionar sin conexión: el contexto que necesita cada petición se envía al proveedor de IA que conectes, y las integraciones configuradas reciben sus propias peticiones. Cada búsqueda web de Codex envía la conversación hasta ese momento al servicio de búsqueda de OpenAI. Si un administrador permite OpenRouter para la voz, el sonido de los archivos de video y audio se envía a OpenRouter. Cada 30 minutos, el servidor consulta a `updates.trina.app` cuál es su propia dirección pública (se desactiva con `MYCEL_EXIT_ADDRESS_CHECK=off`). [Detalles](docs/security-and-permissions.md)
- Quienes operan el servidor pueden leer los archivos y chats almacenados; en el hosting, eso incluye a los operadores de Trina. Los administradores de la app no tienen un visor para consultar las conversaciones privadas de todos.
- Quitar el acceso a una carpeta no borra las respuestas anteriores. La confirmación al compartir con más personas no es una solución universal de prevención de pérdida de datos.
- No ofrecemos certificaciones de seguridad, respuestas perfectas, ahorros garantizados ni decisiones automáticas en materia legal, financiera o de RR. HH. Revisa los resultados y los límites de tu despliegue.
- Los servidores Linux no hacen OCR: la IA ve las fotos y las páginas escaneadas como imágenes, pero no se pueden buscar como texto. Los Mac de oficina todavía no leen video.
- El texto de HWP/HWPX funciona para cualquier equipo; las [vistas previas y la creación de documentos Hangul](resources/hwp/README.md) necesitan el plugin opcional HWP Preview (macOS, o Linux con glibc 2.39 o posterior; no Debian 12).
- Conexiones: primero va la conexión propia elegible de cada persona; después, una asignada a esa persona, a un grupo y, por último, a todo el equipo. En los equipos de Trina recién creados, una conexión de la empresa puede servir a todo el equipo por defecto; las opciones ya guardadas se conservan. **Este ajuste del software no concede ningún permiso conforme a los términos de Anthropic u OpenAI.** [Detalles de conexión](docs/FAQ.md)
- El autoalojamiento en Linux requiere Debian 12/13 o Ubuntu 24.04, systemd con cgroup v2, amd64 o arm64, 4 GB de RAM y 20 GB de disco. Tu equipo de TI se encarga de la instalación, las actualizaciones y la restauración de copias de seguridad.

</details>

## Comunidad

[Discord](https://discord.gg/zUVfSR8MVk) · [X](https://x.com/trina_ax) · [Versiones](https://github.com/trina-app/trina-ax/releases/latest) · [Cambios](CHANGELOG.md) · [Soporte](SUPPORT.md) · [Cómo contribuir](CONTRIBUTING.md) · [Seguridad](SECURITY.md) · [Desarrollo](docs/DEVELOPMENT.md) · [Configuración](docs/CONFIGURATION.md) · [llms.txt](llms.txt)

La app está en inglés, coreano, indonesio, japonés y español. La empresa y las personas de todas las imágenes son ficticias.

## Licencia

Puedes usarlo libremente, también con fines comerciales, bajo la licencia [AGPL-3.0-only](LICENSE). Si ofreces una versión modificada a través de una red, pon su código fuente a disposición de esos usuarios. El protocolo de nube se distribuye por separado bajo la licencia MIT ([licencia](shared/src/cloud-protocol/LICENSE)). [Avisos](NOTICE) · [Avisos de terceros](docs/THIRD-PARTY-NOTICES.md)

Claude Code y Codex tienen sus propios términos; este proyecto no cuenta con el respaldo de Anthropic ni de OpenAI. Claude es una marca comercial de Anthropic.
