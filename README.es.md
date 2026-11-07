<div align="center">

<img src="web/public/favicon.svg" width="72" alt="Logotipo de Trina AX">

# Trina AX

**La IA que comparte todo tu equipo.**

Claude Code y Codex en el servidor de tu empresa, con los archivos de la empresa y las skills de tu equipo. Tu equipo lo usa en el navegador, en su propio chat o, desde la versión 0.4, llamando a @Trina en una conversación del equipo.

[Sitio web](https://ax.trina.app) · [Pruébalo en 10 minutos](#pruébalo-en-10-minutos) · [Autoalojamiento](docs/for-admins.md) · [Documentación](docs/README.md)

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · Español · [简体中文](README.zh-CN.md)

<img src="docs/images/readme/room-quote.png" width="100%" alt="En la conversación Sales (con un icono #), Mina escribe “@Trina /quote Northwind Foods: 200 insulated boxes, delivery Nov 20”. Trina publica en la conversación un resumen del presupuesto con un enlace al archivo “Northwind Foods quote.xlsx”, y Alex responde “Matches our price sheet. Send it.”">

<sub>La app real, versión 0.4: la conversación Sales (interfaz en inglés). Empresa ficticia.</sub>

</div>

- **Lo configuras una vez y todos trabajan así.** Los archivos de la empresa van en `shared/`. La forma en que tu responsable redacta un presupuesto, en `skills/quote/SKILL.md`. Todo el equipo trabaja con ellos desde su primer día.
- **Llamas a @Trina en la conversación y el resultado aparece ahí.** Pregunta en una conversación del equipo: la skill del equipo trabaja con los archivos que tú puedes abrir, y la respuesta, con su archivo, se publica en la conversación.
- **Retomar lo que dejó un compañero** (próximamente). Cualquiera en un proyecto podrá continuar el chat de IA de un compañero, y cada mensaje se ejecutará como la persona que lo envía.

Mete archivos reales de la empresa. Cada persona ve solo lo que tiene permitido. [Cómo](#por-dentro)

```sh
git clone https://github.com/trina-app/trina-ax.git && cd trina-ax
bun install --frozen-lockfile && bun run demo   # http://127.0.0.1:19760 · alice / teamax-demo-1
```

<sub>Demo local: equipo ficticio, IA desactivada, no apta para producción. Requiere Bun 1.3.12 y Go 1.27+. Para probar las conversaciones del equipo y @Trina, usa la [instalación con Docker](docs/INSTALL-DOCKER.md) con `TRINA_AX_VERSION=0.4.0-beta.10` y conecta una cuenta de IA.</sub>

## Cómo funciona

1. **Lo guardas una sola vez.** Los archivos de la empresa van en `shared/`. Tu forma de escribir propuestas, en `skills/proposal/SKILL.md`.
2. **Cualquiera pregunta, en su propio chat o en una conversación del equipo.** En el navegador del escritorio o del teléfono, o en la app de iPhone. Sin terminal y sin instalar nada en el portátil. En una conversación, @Trina trabaja como la persona que lo llamó.
3. **Cada persona mantiene sus propios accesos.** El servidor comprueba cada archivo que abre la IA con los permisos de quien pregunta. Una carpeta que tú no puedes ver tampoco existe para tu IA.

<img src="docs/images/readme/permission-answer.png" width="100%" alt="Una integrante del equipo de ventas pregunta “What was our revenue last quarter?” y la IA responde que no encontró cifras de ingresos en ningún archivo del equipo al que ella tenga acceso.">

<sub><b>La misma pregunta, distintas personas.</b> Mina es de Ventas. El archivo de ingresos está en <code>shared/Finance</code>, una carpeta que ella no puede abrir, así que su IA tampoco.</sub>

## Pruébalo en 10 minutos

```sh
git clone https://github.com/trina-app/trina-ax.git && cd trina-ax
bun install --frozen-lockfile
bun run demo        # → http://127.0.0.1:19760 · inicia sesión como alice / teamax-demo-1
```

Un equipo ficticio con seis skills iniciales. La IA está desactivada, así que no hace falta ninguna cuenta de IA. Inicia sesión como `bob` en una ventana privada: cada usuario ve una carpeta de grupo distinta. Requiere Git, Bun 1.3.12 y Go 1.27+. Esto **no es una instalación de producción**. [Guía paso a paso](docs/QUICKSTART.md)

Para probar las conversaciones del equipo y @Trina, usa la [instalación con Docker](docs/INSTALL-DOCKER.md) con `TRINA_AX_VERSION=0.4.0-beta.10` (o una versión 0.4 posterior) y conecta una cuenta de IA. La demo local tiene la IA desactivada, así que allí @Trina no responde.

## La misma petición, dos respuestas

<table>
<tr>
<td width="50%" valign="top"><b>Claude Code en una carpeta vacía</b><br><sub>No tiene forma de conocer tu empresa, así que primero hace seis preguntas.</sub></td>
<td width="50%" valign="top"><b>Trina AX, con la misma línea</b><br><sub>Parte de los archivos del equipo y de la skill de propuestas del CEO.</sub></td>
</tr>
<tr>
<td><img src="docs/images/readme/before-empty-claude.png" alt="Claude Code, en una carpeta vacía, responde a “Write a proposal for Trina Logistics” con seis preguntas sobre la empresa, el cliente y el formato."></td>
<td><img src="docs/images/readme/after-trina-deck.png" alt="Trina AX responde a la misma petición con una propuesta de 7 diapositivas cuya portada dice “Lead time from 2.1 to 1.4 days, within your budget”."></td>
</tr>
</table>

<sub>Resultados reales del 31 de octubre y el 1 de noviembre de 2026 con una empresa ficticia, Dawnroute; las fotos de la presentación se hicieron con Higgsfield. Claude Code hace bien en preguntar: en una carpeta vacía no hay nada que le diga quién eres. Trina le da la carpeta.</sub>

**La misma conversación, dos pantallas.** Solo las respuestas hechas con lo que todos en la conversación pueden ver se publican directamente en ella. Si no, primero las ve quien preguntó.

<img src="docs/images/readme/share-check.png" width="100%" alt="La conversación Everyone en el mismo momento, en dos pantallas. Alex ve la respuesta de Trina marcada “Only you can see this · Post”, con el motivo “It read folders that some people in this room cannot open (Team folder, Finance).” Mina solo ve “Answered to Alex only”.">

<sub>La respuesta de Alex usó <code>shared/Finance</code>, que Mina no puede abrir. Alex aún puede decidir publicarla; hasta entonces, Mina solo ve que él recibió una respuesta (en la interfaz en español: «Respondió solo a Alex»). La app real, versión 0.4. Empresa ficticia.</sub>

## Qué incluye

| | En la práctica |
|---|---|
| **Agentes reales de Claude Code y Codex** | Se ejecutan en tu servidor: hasta 150 rondas de herramientas por respuesta (por defecto), hasta 4 subagentes a la vez, búsqueda web y tareas programadas. |
| **El conocimiento está en las carpetas de la empresa** | `shared/`, `groups/`, `projects/` y carpetas personales, con historial de versiones. Extracción de texto de archivos PDF, Office y HWP/HWPX. |
| **Skills del equipo, gestionadas como archivos** | Una skill es un archivo `SKILL.md`. Las reglas de la carpeta deciden quién puede usarla, y la IA pide confirmación a una persona antes de modificar alguna. |
| **Conversaciones del equipo (0.4)** | Conversaciones de grupo, una conversación con todos y mensajes directos, con respuestas citadas, menciones, archivos y fotos. Llama a @Trina y responde como tú, con los archivos y las skills que puedes usar. Una conversación solo la ven sus miembros; los administradores no pueden abrir las conversaciones en las que no están. |
| **Permisos en cada llamada a archivos** | Los archivos a los que no tienes acceso no aparecen en Archivos, las respuestas de la IA, la búsqueda, las vistas previas, el historial de versiones ni la papelera. |
| **Tu conexión de IA** | Conecta una vez la cuenta de Claude u OpenAI de la empresa, o deja que cada persona conecte la suya. Uso por persona, con límites. Si lo alojas tú, Claude Code también puede usar otros modelos, como DeepSeek, Kimi o GLM, a través de una [pasarela compatible con Anthropic](docs/CONFIGURATION.md#anthropic-compatible-gateway). |
| **Conector de Slack (0.4, desactivado por defecto)** | Cuando el propietario configura la app de Slack propia del equipo, cada persona vincula su cuenta de Slack y pregunta a la app en un canal o por mensaje directo. Cada pregunta se ejecuta como quien pregunta; en un canal, la respuesta primero solo la ve esa persona, con *Post to channel*. [Guía de Slack (en inglés)](docs/SLACK.md) |
| **App de iPhone** | [Trina AX en el App Store](https://apps.apple.com/app/id6829192435). Abre el servidor de tu equipo, así que tiene lo que tenga la versión de tu servidor: las conversaciones del equipo necesitan la 0.4. |
| **Autoalojado o con el hosting de Trina** | Un servidor Linux (también con [Docker](docs/INSTALL-DOCKER.md)), un Mac de la oficina o el hosting de Trina en AWS (Seúl). En el navegador de escritorio y del teléfono, la app de iPhone y un instalador para Windows. |

## Por dentro

Nuestro primer commit, del 21 de octubre de 2026, ya tenía la función de permisos (`server/src/policy/authorize.ts`). Todas las llamadas a archivos siguen pasando por ella.

```mermaid
flowchart LR
  P["Tu equipo<br/>navegador · app de iPhone · app de Windows"] --> S["Servidor Trina"]
  E["Claude Code / Codex<br/>shell y herramientas de archivos propios, desactivados"] -->|"único camino: herramientas de archivos de Trina"| C{"Comprobación de permisos<br/>según quien pregunta"}
  S --> C
  C --> D[("Carpetas de la empresa<br/>shared · groups · projects · users")]
  E -. "el SO deniega el acceso directo al disco" .-x D
```

- **El agente es real.** Los subagentes actúan en nombre de la misma persona, pasan las mismas comprobaciones y dejan los mismos registros de actividad.
- **Un acceso muy acotado.** El propio shell del motor y sus herramientas de archivos están desactivados, y hay pruebas de regresión que lo cubren en cada motor. Llega a tus carpetas a través de las herramientas de archivos de Trina, que se comprueban en cada llamada.
- **Las claves quedan fuera de alcance.** Los tokens se sellan en el navegador antes de enviarse. El motor recibe un token sustituto para cada turno, y un proxy de modelos añade el real.
- **Tus chats con Trina solo los ves tú.** Una conversación solo la ven sus miembros; los administradores no pueden abrir las conversaciones en las que no están. Los administradores ven qué archivos leyó la IA, no la conversación. Quienes operan el servidor sí pueden leer los datos almacenados, y lo indicamos [más abajo](#datos-y-límites).

<sub>El aislamiento a nivel de SO (una cuenta dedicada para el motor) se aplica en las instalaciones de Linux y en las de Mac con cuentas de rol. El modo Mac de oficina se ejecuta con el usuario que tiene la sesión iniciada, y la demo local no tiene aislamiento de SO. → <a href="docs/security-and-permissions.md">Seguridad y permisos</a> · <a href="docs/PERMISSIONS.md">Modelo de permisos (en coreano)</a></sub>

## La primera semana de tu equipo

Crea la cuenta de propietario y luego sigue este orden: **permisos → conexión de IA → invitar al equipo → primera skill → primera copia de seguridad**. Estas skills iniciales usan datos ficticios:

| Rol | Una tarea real | Skill lista para copiar |
|---|---|---|
| CEO / líder de equipo | Convertir notas semanales en decisiones, riesgos y próximos pasos | [Weekly report](examples/skills/weekly-team-report/SKILL.md) |
| Ventas | Redactar el mensaje de seguimiento de una reunión sin inventar compromisos | [Sales follow-up](examples/skills/sales-follow-up/SKILL.md) |
| Marketing | Preparar un brief de campaña a partir de notas de marca aprobadas | [Brand brief](examples/skills/brand-brief/SKILL.md) |
| Finanzas | Marcar para revisión los recibos que faltan y las cantidades dudosas | [Expense review](examples/skills/expense-review/SKILL.md) |
| RR. HH. | Responder dudas de incorporación con las políticas a las que se tiene acceso | [New-hire guide](examples/skills/new-hire-guide/SKILL.md) |
| Todos | Extraer decisiones y tareas de las notas de una reunión | [Meeting summary](examples/skills/meeting-summary/SKILL.md) |

Una skill es un conjunto reutilizable de instrucciones: no entrena el modelo ni da acceso adicional. Una persona revisa los resultados antes de usarlos. [Checklist para líderes de equipo](docs/for-teams.md) · [Todos los ejemplos](examples/README.md)

## Cómo ejecutarlo

| | Hosting de Trina | Autoalojado en Linux | Mac de oficina | Demo local |
|---|---|---|---|---|
| Ideal para | Equipos sin personal de TI | Equipos con un responsable de TI | Una oficina pequeña con un Mac dedicado | Echar un vistazo |
| Quién lo gestiona | Trina, en AWS (Seúl) | Tu equipo de TI | Quien se encarga de la oficina | Tú |
| IA | Tu conexión autorizada de Claude u OpenAI | Igual | Claude (sin Codex) | Desactivada |
| Precio | Prueba gratis de 14 días, luego un plan mensual + uso de IA | Software gratuito + tu servidor | Software gratuito | Gratis |
| Cómo empezar | [Ver los planes](https://ax.trina.app/#pricing) | [Guía de Linux](docs/INSTALL-LINUX.en.md) · [Docker](docs/INSTALL-DOCKER.md) | [Guía de Mac de oficina](docs/OFFICE.en.md) | [Inicio rápido](docs/QUICKSTART.md) |

Trina ofrece el espacio de trabajo, no la IA: usa solo cuentas y planes de Claude y OpenAI cuyo uso tengas autorizado. El hosting de Trina tiene una prueba gratis de 14 días y luego un plan mensual; el uso de IA lo factura aparte la cuenta que conectes. [Precios actuales](https://ax.trina.app/#pricing)

El autoalojamiento en Linux requiere Debian 12/13 o Ubuntu 24.04, systemd con cgroup v2, amd64 o arm64, 4 GB de RAM (recomendado) y al menos 20 GB de disco. Tu equipo de TI se encarga de la instalación, las actualizaciones y la restauración de copias de seguridad.

## Datos y límites

Autoalojar no significa funcionar sin conexión: el contexto que necesita cada petición se envía al proveedor de IA que conectes. Quienes operan el servidor (incluida Trina, si usas su hosting) pueden leer los archivos y chats almacenados; los administradores de la app no pueden explorar conversaciones privadas.

<details>
<summary><b>Qué sale del servidor, reglas de conexión y lo que no prometemos</b></summary>

<br>

- El contexto seleccionado se envía al proveedor de IA elegido, y las integraciones configuradas reciben sus propias peticiones. Cada búsqueda web de Codex envía la conversación hasta ese momento al servicio de búsqueda de OpenAI. Si el equipo eligió OpenRouter para la voz y lo permitió, el sonido de los archivos de video y audio que lee la IA se envía a OpenRouter. Cada 30 minutos, el servidor consulta a `updates.trina.app` cuál es su propia dirección pública (se desactiva con `MYCEL_EXIT_ADDRESS_CHECK=off`). [Detalles](docs/security-and-permissions.md)
- Quienes operan el servidor pueden leer los archivos y chats almacenados; en el hosting, eso incluye a los operadores de Trina. Los administradores de la app no tienen un visor para consultar las conversaciones privadas de todos.
- Quitar el acceso a una carpeta no borra las respuestas anteriores. La confirmación al compartir con más personas no es una solución universal de prevención de pérdida de datos.
- No ofrecemos certificaciones de seguridad, respuestas perfectas, ahorros garantizados ni decisiones automáticas en materia legal, financiera o de RR. HH. Revisa los resultados y los límites de tu despliegue.
- La IA ve las fotos y las páginas escaneadas de PDF como imágenes (un administrador puede desactivarlo), pero los servidores Linux no hacen OCR: en ellos, los documentos escaneados y las fotos no se pueden buscar como texto.
- En los servidores Linux, la IA también lee archivos de video y audio: los fotogramas, repartidos a intervalos regulares, se envían al proveedor de IA como imágenes, y el sonido lo convierte en texto el proveedor de voz del equipo solo si un administrador lo permite ("Convertir el sonido de los videos en texto"). Si el proveedor de voz es OpenRouter, el sonido de los archivos del equipo va a OpenRouter y a su proveedor; los chats confidenciales nunca lo envían. Los Mac de oficina todavía no leen video.
- Cualquier equipo puede extraer el texto de archivos HWP/HWPX. Las [vistas previas visuales](resources/hwp/README.md), y que la IA cree y rellene documentos Hangul, se ofrecen con el plugin opcional HWP Preview, que requiere macOS o Linux con glibc 2.39 o posterior, así que Debian 12 **no** las admite.
- En las instalaciones gestionadas, tienen prioridad las conexiones personales elegibles; después, las asignadas a una persona, a un grupo y, por último, a todo el equipo. En los equipos de Trina recién creados, una conexión de la empresa puede servir a todo el equipo por defecto; las opciones ya guardadas se conservan. El consentimiento a nivel de cada conexión se sigue aplicando. **Este ajuste del software no concede ningún permiso conforme a los términos de Anthropic u OpenAI.** La demo local desactiva la IA; los modos de desarrollo y de inicio de sesión local de Mac de oficina gestionan las conexiones de otra manera. [Detalles de conexión](docs/FAQ.md)

</details>

## Preguntas frecuentes

<details>
<summary><b>¿En qué se diferencia de dar a cada persona una licencia de Claude?</b></summary>

<br>Con una licencia, cada persona tiene su propio espacio de trabajo vacío. Trina da a todos las mismas carpetas de la empresa y las mismas skills del equipo en un solo servidor, que comprueba los permisos de carpeta de cada persona. Aun así, puedes conectar una cuenta para cada persona.

</details>

<details>
<summary><b>¿Necesitamos una cuenta de IA para probarlo?</b></summary>

<br>No. La [demo local](docs/QUICKSTART.md) funciona con la IA desactivada y datos ficticios, así que puedes ver primero los archivos, las skills y los permisos. Para ver a @Trina responder en una conversación del equipo, necesitas un servidor con una conexión de IA ([Pruébalo](#pruébalo-en-10-minutos)).

</details>

<details>
<summary><b>¿Pueden los administradores leer nuestros chats y conversaciones?</b></summary>

<br>No. Tus chats con Trina solo los ves tú. Una conversación solo la ven sus miembros; los administradores no pueden abrir las conversaciones en las que no están. Los registros de actividad muestran qué archivos leyó la IA, no la conversación. Quienes operan el servidor o su almacenamiento sí pueden leer los datos guardados.

</details>

<details>
<summary><b>¿Funciona con archivos HWP coreanos?</b></summary>

<br>Sí. La IA lee el texto de archivos HWP/HWPX en cualquier servidor. Con el plugin opcional HWP Preview activado, también crea documentos .hwpx nuevos (títulos, párrafos, listas y tablas sencillas), rellena un formulario .hwp o .hwpx existente (marcadores, celdas vacías, filas de tabla) y lo guarda en el mismo formato sin tocar el resto del archivo, y muestra vistas previas visuales. El plugin no funciona en Debian 12. Más información en las [preguntas frecuentes](docs/FAQ.md).

</details>

## La historia en 97 segundos

https://github.com/user-attachments/assets/61f3469b-358d-4b3a-9233-c6b23b5db835

<sub><b>Con sonido (en inglés).</b> Un líder de equipo configura Claude una vez y, en su primer día, la propuesta de una nueva integrante sale como la suya.<br>Historia animada con la app real en el 1:15. Empresa ficticia.</sub>

## Lo que viene

- **Retomar el chat de IA de un compañero.** Chats de proyecto compartidos: cualquiera en el proyecto continúa un chat de IA, y cada mensaje se ejecuta como la persona que lo envía. Diseñado, aún sin construir.
- **App de Android.** En revisión en Google Play.
- **La 0.4 en el hosting de Trina.** El hosting sigue el canal estable y tendrá las conversaciones del equipo cuando la 0.4 sea estable. Los servidores autoalojados pueden usar una versión 0.4 hoy.

## Comunidad y cómo contribuir

[Última versión y sumas de verificación](https://github.com/trina-app/trina-ax/releases/latest) · [Registro de cambios](CHANGELOG.md) · [Soporte](SUPPORT.md) · [Contribuir](CONTRIBUTING.md) · [Informes de seguridad](SECURITY.md) · [Desarrollo](docs/DEVELOPMENT.md) · [Configuración](docs/CONFIGURATION.md) · [Índice legible por máquinas](llms.txt)

La app está disponible en inglés, coreano, indonesio, japonés y español. Los instaladores publicados pueden ir por detrás de los cambios en el código fuente; consulta sus notas de versión.

## Licencia

Puedes usarlo libremente, también con fines comerciales, bajo la licencia [AGPL-3.0-only](LICENSE). Si ofreces una versión modificada a través de una red, pon su código fuente a disposición de esos usuarios. El protocolo de nube se distribuye por separado bajo la licencia MIT ([licencia](shared/src/cloud-protocol/LICENSE)). [Avisos](NOTICE) · [Avisos de terceros](docs/THIRD-PARTY-NOTICES.md)

Claude Code y Codex tienen sus propios términos; este proyecto no cuenta con el respaldo de Anthropic ni de OpenAI. Claude es una marca comercial de Anthropic.
