<div align="center">

<img src="web/public/favicon.svg" width="72" alt="Logotipo de Trina AX">

# Trina AX

**La IA que comparte todo tu equipo.**

Claude Code y Codex trabajando para todo tu equipo. Conocen los archivos de tu empresa, siguen la forma de trabajar de tu equipo y solo ven lo que cada persona puede abrir. Escribe una vez cómo hacéis un presupuesto, y la IA de cualquiera lo hará igual, con vuestra propia lista de precios.

[Sitio web](https://ax.trina.app) · [Pruébalo en 10 minutos](#pruébalo-en-10-minutos) · [Autoalojamiento](docs/for-admins.md) · [Documentación](docs/README.md) · [Discord](https://discord.gg/zUVfSR8MVk) · [X](https://x.com/trina_ax)

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · Español · [简体中文](README.zh-CN.md)

</div>

## Qué gana tu equipo

| | Qué cambia para tu equipo |
|---|---|
| **Una forma de trabajar, para todos** | Escribe una vez cómo hace tu equipo un presupuesto. Desde entonces, la IA de cualquiera lo hace así, con vuestra lista de precios, incluso el primer día de alguien. |
| **Archivos de la empresa, acceso de cada persona** | Los archivos de la empresa están en un solo sitio, y la IA de cada persona solo ve lo que esa persona puede abrir. Ventas nunca ve las cifras de Finanzas. |
| **Salas del equipo** | Habla en equipo en salas, una sala con todos y mensajes directos, con archivos y fotos. Los hilos y los chats de grupo son nuevos en la 0.5. |
| **Una IA privada junto a cada sala** <sub>nuevo en la 0.5</sub> | Pregunta a Trina al lado de la sala: «ponme al día», «resume esto» o sobre un mensaje concreto. Solo lo ves tú. Una buena respuesta va a la sala o a su hilo con un clic, y antes te avisa si alguien allí no puede abrir lo que usó. |
| **Continuar el chat de IA de un compañero** <sub>nuevo en la 0.5</sub> | Mina empieza un presupuesto; Sam sigue en el mismo chat. Cada mensaje se ejecuta con los accesos y la cuenta de IA de quien lo envía. |
| **Las herramientas que ya usas** | Google Drive, Slack, Notion, Linear, Higgsfield, cualquier servidor MCP o la API de tu empresa. Di «conecta Higgsfield» en un chat y termina en una sola tarjeta. Antes de escribir o enviar algo allí, la IA te pregunta, salvo que lo permitas. |
| **Trabajo que se hace solo** | «Cada lunes a las 9:00, resume las notas de ventas de la semana pasada». Se ejecuta a su hora, con los accesos de quien la creó. |
| **Nada se pierde** | Recupera una versión anterior de un archivo; los archivos borrados esperan en la papelera del equipo. |
| **Documentos de trabajo reales** | Lee archivos PDF, Word, Excel, PowerPoint y Hangul (HWP, coreano), y crea archivos de Word, Excel, PowerPoint y PDF. Con un plugin opcional también redacta y rellena documentos Hangul. |
| **En cualquier dispositivo** | El navegador en el ordenador y el teléfono, las apps de [iPhone](https://apps.apple.com/app/id6829192435) y [Mac](https://apps.apple.com/app/trina-ax/id6829192435) en el App Store, una app para Windows y una [app de Android](https://github.com/trina-app/trina-ax/releases/tag/android-v1.0.2) (en revisión en Google Play). |
| **Tu propia cuenta de IA** | Funciona con la suscripción de Claude o ChatGPT, o la clave de API, que conectes: una para todo el equipo o la de cada persona, con uso y límites por persona. Trina no proporciona la IA. |
| **Tu servidor o el nuestro** | Instálalo en tu propio servidor o en un Mac de la oficina, o deja que Trina lo aloje en AWS (Seúl). El software es libre y gratuito. |

<sub><b>Nuevo en la 0.5</b>: en las versiones beta 0.5 o en la próxima. En la versión estable actual (0.4) se llama a @Trina dentro de la propia sala.</sub>

## Un día en Dawnroute, una empresa ficticia

- **Lunes, 9:00.** Alex encuentra el resumen de ventas de la semana pasada en su Bandeja de entrada. Lo configuró una vez como tarea programada; se ejecutó sola, con sus accesos.
- **10:30.** Sam escribe en la sala de Ventas que Northwind Foods quiere un presupuesto hoy. Mina le pide a Trina, junto a la sala, que lo prepare con la lista de precios, revisa las cifras y pulsa **Enviar al hilo**. El presupuesto queda bajo el mensaje de Sam. <sub>nuevo en la 0.5</sub>
- **14:00.** Mina está con un cliente. Sam abre el chat del presupuesto de Northwind en el proyecto de Ventas y pide una versión con envío gratis. Trina sigue donde lo dejó Mina, trabajando con los accesos de Sam. <sub>nuevo en la 0.5</sub>
- **16:00.** Mina pregunta por los ingresos del último trimestre. Ese archivo está en Finanzas, que ella no puede abrir, así que su IA tampoco.

<img src="docs/images/readme/permission-answer.png" width="100%" alt="Una integrante del equipo de ventas pregunta “What was our revenue last quarter?” y la IA responde que no encontró cifras de ingresos en ningún archivo del equipo al que ella tenga acceso.">

<sub><b>La misma pregunta, distintas personas.</b> Mina es de Ventas. El archivo de ingresos está en <code>shared/Finance</code>, una carpeta que ella no puede abrir, así que su IA tampoco.</sub>

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

## Preguntas frecuentes

<details>
<summary><b>¿La IA está incluida?</b></summary>

<br>No. Trina es el espacio de trabajo. Tu equipo conecta su propia suscripción de Claude o ChatGPT, o una clave de API, y el uso de IA lo factura esa cuenta. Usa solo cuentas y planes cuyo uso tengas autorizado.

</details>

<details>
<summary><b>¿En qué se diferencia de dar a cada persona una licencia de Claude?</b></summary>

<br>Con una licencia, cada persona tiene su propio espacio de trabajo vacío. Trina da a todos las mismas carpetas de la empresa y las mismas skills del equipo en un solo servidor, que comprueba los permisos de carpeta de cada persona. Aun así, puedes conectar una cuenta para cada persona.

</details>

<details>
<summary><b>¿Necesitamos una cuenta de IA para probarlo?</b></summary>

<br>No. La [demo local](docs/QUICKSTART.md) funciona con la IA desactivada y datos ficticios, así que puedes ver primero los archivos, las skills y los permisos. Para ver responder a Trina, necesitas un servidor con tu propia conexión de IA ([Pruébalo](#pruébalo-en-10-minutos)).

</details>

<details>
<summary><b>¿Pueden los administradores leer nuestros chats y salas?</b></summary>

<br>No. Tus chats y chats laterales con Trina solo los ves tú, y los chats compartidos de un proyecto, solo las personas de ese proyecto. Una sala solo la ven sus miembros; los administradores no pueden abrir las salas en las que no están. Los registros de actividad muestran qué archivos leyó la IA, no la conversación. Quienes operan el servidor o su almacenamiento sí pueden leer los datos guardados.

</details>

<details>
<summary><b>¿Funciona con archivos HWP coreanos?</b></summary>

<br>Sí. La IA lee el texto de archivos HWP/HWPX en cualquier servidor. Con el plugin opcional HWP Preview activado, también crea documentos .hwpx nuevos (títulos, párrafos, listas y tablas sencillas), rellena un formulario .hwp o .hwpx existente (marcadores, celdas vacías, filas de tabla) y lo guarda en el mismo formato sin tocar el resto del archivo, y muestra vistas previas visuales. El plugin no funciona en Debian 12. Más información en las [preguntas frecuentes](docs/FAQ.md).

</details>

## La historia en 97 segundos

https://github.com/user-attachments/assets/61f3469b-358d-4b3a-9233-c6b23b5db835

<sub><b>Con sonido (en inglés).</b> Un líder de equipo configura Claude una vez y, en su primer día, la propuesta de una nueva integrante sale como la suya.<br>Historia animada con la app real en el 1:15. Empresa ficticia.</sub>

## Para quien lo instala

### Pruébalo en 10 minutos

```sh
git clone https://github.com/trina-app/trina-ax.git && cd trina-ax
bun install --frozen-lockfile
bun run demo        # → http://127.0.0.1:19760 · inicia sesión como alice / teamax-demo-1
```

Un equipo ficticio con seis skills iniciales. La IA está desactivada, así que no hace falta ninguna cuenta de IA. Inicia sesión como `bob` en una ventana privada: cada usuario ve una carpeta de grupo distinta. Requiere Git, Bun 1.3.12 y Go 1.27+. Esto **no es una instalación de producción**. [Guía paso a paso](docs/QUICKSTART.md)

Para probar las salas con la IA, usa la [instalación con Docker](docs/INSTALL-DOCKER.md) con una versión publicada (`TRINA_AX_VERSION=0.4.0`, o `0.5.0-beta.1` para una primera versión del chat lateral y los chats de proyecto compartidos) y conecta tu propia cuenta de IA.

### La primera semana de tu equipo

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

### Cómo ejecutarlo

| | Hosting de Trina | Autoalojado en Linux | Mac de oficina | Demo local |
|---|---|---|---|---|
| Ideal para | Equipos sin personal de TI | Equipos con un responsable de TI | Una oficina pequeña con un Mac dedicado | Echar un vistazo |
| Quién lo gestiona | Trina, en AWS (Seúl) | Tu equipo de TI | Quien se encarga de la oficina | Tú |
| IA | Tu conexión autorizada de Claude u OpenAI | Igual | Claude (sin Codex) | Desactivada |
| Precio | Prueba gratis de 14 días, luego un plan mensual + uso de IA | Software gratuito + tu servidor | Software gratuito | Gratis |
| Cómo empezar | [Ver los planes](https://ax.trina.app/#pricing) | [Guía de Linux](docs/INSTALL-LINUX.en.md) · [Docker](docs/INSTALL-DOCKER.md) | [Guía de Mac de oficina](docs/OFFICE.en.md) | [Inicio rápido](docs/QUICKSTART.md) |

Trina ofrece el espacio de trabajo, no la IA: usa solo cuentas y planes de Claude y OpenAI cuyo uso tengas autorizado. El uso de IA lo factura aparte la cuenta que conectes. Si lo alojas tú, Claude Code también puede usar otros modelos, como DeepSeek, Kimi o GLM, a través de una [pasarela compatible con Anthropic](docs/CONFIGURATION.md#anthropic-compatible-gateway). [Precios actuales](https://ax.trina.app/#pricing)

El autoalojamiento en Linux requiere Debian 12/13 o Ubuntu 24.04, systemd con cgroup v2, amd64 o arm64, 4 GB de RAM (recomendado) y al menos 20 GB de disco. Tu equipo de TI se encarga de la instalación, las actualizaciones y la restauración de copias de seguridad.

### Por dentro

Nuestro primer commit, del 21 de octubre de 2026, ya tenía la función de permisos (`server/src/policy/authorize.ts`). Todas las llamadas a archivos siguen pasando por ella.

```mermaid
flowchart LR
  P["Tu equipo<br/>navegador · Mac · Windows · iPhone · Android"] --> S["Servidor Trina"]
  E["Claude Code / Codex<br/>shell y herramientas de archivos propios, desactivados"] -->|"único camino: herramientas de archivos de Trina"| C{"Comprobación de permisos<br/>según quien pregunta"}
  S --> C
  C --> D[("Carpetas de la empresa<br/>shared · groups · projects · users")]
  E -. "el SO deniega el acceso directo al disco" .-x D
```

- **El agente es real.** Hasta 150 rondas de herramientas por respuesta (por defecto), hasta 4 subagentes a la vez (Claude) y búsqueda web. Los subagentes actúan en nombre de la misma persona, pasan las mismas comprobaciones y dejan los mismos registros de actividad.
- **Un acceso muy acotado.** El propio shell del motor y sus herramientas de archivos están desactivados, y hay pruebas de regresión que lo cubren en cada motor. Llega a tus carpetas a través de las herramientas de archivos de Trina, que se comprueban en cada llamada.
- **Las claves quedan fuera de alcance.** Los tokens se sellan en el navegador antes de enviarse. El motor recibe un token sustituto para cada turno, y un proxy de modelos añade el real.
- **Tus chats con Trina son tuyos.** Tus chats y chats laterales solo los ves tú, y los chats compartidos de un proyecto, solo las personas de ese proyecto. Una sala solo la ven sus miembros; los administradores no pueden abrir las salas en las que no están. Los administradores ven qué archivos leyó la IA, no la conversación. Quienes operan el servidor sí pueden leer los datos almacenados, y lo indicamos [más abajo](#datos-y-límites).

<sub>El aislamiento a nivel de SO (una cuenta dedicada para el motor) se aplica en las instalaciones de Linux y en las de Mac con cuentas de rol. El modo Mac de oficina se ejecuta con el usuario que tiene la sesión iniciada, y la demo local no tiene aislamiento de SO. → <a href="docs/security-and-permissions.md">Seguridad y permisos</a> · <a href="docs/PERMISSIONS.md">Modelo de permisos (en coreano)</a></sub>

### Datos y límites

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

## Comunidad y cómo contribuir

Haz preguntas y conoce a otros equipos en [Discord](https://discord.gg/zUVfSR8MVk) (el servidor «Trina AX»). Las novedades se publican en [X](https://x.com/trina_ax).

[Última versión y sumas de verificación](https://github.com/trina-app/trina-ax/releases/latest) · [Registro de cambios](CHANGELOG.md) · [Soporte](SUPPORT.md) · [Contribuir](CONTRIBUTING.md) · [Informes de seguridad](SECURITY.md) · [Desarrollo](docs/DEVELOPMENT.md) · [Configuración](docs/CONFIGURATION.md) · [Índice legible por máquinas](llms.txt)

La app está disponible en inglés, coreano, indonesio, japonés y español. Los instaladores publicados pueden ir por detrás de los cambios en el código fuente; consulta sus notas de versión.

## Licencia

Puedes usarlo libremente, también con fines comerciales, bajo la licencia [AGPL-3.0-only](LICENSE). Si ofreces una versión modificada a través de una red, pon su código fuente a disposición de esos usuarios. El protocolo de nube se distribuye por separado bajo la licencia MIT ([licencia](shared/src/cloud-protocol/LICENSE)). [Avisos](NOTICE) · [Avisos de terceros](docs/THIRD-PARTY-NOTICES.md)

Claude Code y Codex tienen sus propios términos; este proyecto no cuenta con el respaldo de Anthropic ni de OpenAI. Claude es una marca comercial de Anthropic.
