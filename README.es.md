<div align="center">

<img src="web/public/favicon.svg" width="72" alt="Logotipo de Trina AX">

# Trina AX

**La IA que comparte todo tu equipo.**

Los archivos, las skills y las herramientas de tu equipo en un solo servidor. La IA de cada persona empieza desde ahí.

[Sitio web](https://ax.trina.app) · [Descargar](https://ax.trina.app/download) · [Documentación](docs/README.md) · [Discord](https://discord.gg/zUVfSR8MVk) · [X](https://x.com/trina_ax)

<a href="https://apps.apple.com/app/trina-ax/id6829192435"><img src="docs/images/readme/v3/badge-app-store.svg" height="40" alt="Descargar en el App Store"></a>&nbsp;<a href="https://play.google.com/store/apps/details?id=app.trina.ax"><img src="docs/images/readme/v3/badge-google-play.png" height="58" alt="Disponible en Google Play" align="top"></a>

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · Español · [简体中文](README.zh-CN.md)

</div>

<br>

<a href="https://ax.trina.app/#watch"><img src="docs/images/readme/v3/film.png" width="100%" alt="Mira la historia de 97 segundos: Alex, responsable de equipo, consigue una propuesta de 7 páginas con una sola línea; Mina, en su primer día, pide lo mismo y su IA responde 'Trina Logistics? Who are they?'"></a>

<p align="center"><sub>La IA de una persona nueva empieza en una carpeta vacía. Trina le da la del equipo.</sub></p>

## Cómo funciona

<img src="docs/images/readme/v3/how.png" width="100%" alt="1 Añade tus archivos y skills: una ventana de Archivos que muestra quién puede abrir cada carpeta y los cuatro pasos de la skill Customer quote. 2 Conecta tus herramientas: Higgsfield, Notion, Linear, GitHub y la API de tu empresa pasan por tu servidor de Trina, que comprueba a cada persona; una presentación hecha con fotos de Higgsfield. 3 Invita a tu equipo: Mina, Alex y Sam preguntan desde sus propios dispositivos, todos al mismo servidor de Trina y cada uno con sus propios accesos.">

## Lo que recibe tu equipo

<img src="docs/images/readme/v3/room.png" width="100%" alt="Pregunta junto a cualquier conversación y envía con un clic: en la conversación Expo booth crew, Mina le pregunta a Trina en un chat lateral que solo ve ella y luego envía la respuesta a la conversación.">

<p>
<img src="docs/images/readme/v3/access.png" width="49%" alt="Cada persona ve solo lo que puede abrir: carpetas con las caras de quienes pueden abrirlas; Mina no puede abrir shared/Finance.">
<img src="docs/images/readme/v3/handoff.png" width="49%" alt="Retoma el chat de IA de un compañero: Sam continúa el chat de proyecto de Mina, con sus propios accesos.">
</p>

<p>
<img src="docs/images/readme/v3/skills.png" width="32%" alt="Escribe cómo trabaja tu equipo: la skill Customer quote de quien lidera el equipo, que usan Mina, Sam y Jordan.">
<img src="docs/images/readme/v3/tools.png" width="32%" alt="Conecta las herramientas que ya usas: cualquier servidor MCP, Google Drive, Slack o la API de tu empresa.">
<img src="docs/images/readme/v3/versions.png" width="32%" alt="Se guarda cada cambio: versiones de Price sheet.xlsx de Alex, Mina y Sam, incluida una guardada durante una respuesta de la IA, con la opción Restaurar.">
</p>

<img src="docs/images/readme/v3/access-answers.png" width="100%" alt="Alex y Mina preguntan 'What was our revenue last quarter?'. Alex puede abrir Finance y obtiene $498,000; Mina no puede, así que su IA responde que no encontró cifras de ingresos en los archivos que ella puede abrir.">

Cada archivo que abre la IA se comprueba con los permisos de quien preguntó. [Cómo funcionan los permisos](docs/PERMISSIONS.md)

## Cómo empezar

- **Hosting de Trina:** sin servidor que gestionar. Prueba gratis de 14 días y luego un plan mensual. [Planes](https://ax.trina.app/#pricing)
- **Apps:** Mac, iPhone, Android y Windows, o cualquier navegador. [Descargar](https://ax.trina.app/download)
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
