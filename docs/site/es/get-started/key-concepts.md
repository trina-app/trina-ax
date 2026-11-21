---
title: Conceptos clave
description: Equipos, personas, carpetas, chats, proyectos, habilidades, motores y MCP en una sola página.
---

Trina AX se basa en unas pocas piezas. Todas las demás páginas usan estos términos. Si su equipo usa Google Drive y
Slack, la mayoría le resultarán familiares: las comparaciones de abajo dicen cuáles.

## Personas y roles

| Rol | Puede |
|---|---|
| **Propietario** | Todo lo que puede un administrador, más las decisiones del equipo como las actualizaciones, las restauraciones, quitar miembros y el nombre del equipo. |
| **Administrador** | Gestionar miembros, grupos, permisos de carpetas, las conexiones de IA y los motores del equipo, y la configuración del equipo. Los administradores no pueden leer los chats de otras personas. |
| **Miembro** | Chatear con la IA, usar los archivos y las habilidades que puede abrir, y tener carpetas y habilidades personales. |
| **Invitado** | Una persona de fuera del equipo, como máximo en un canal privado o chat de grupo, y en un proyecto. Sin IA, salvo que se elija una IA para ella. No ocupa una plaza. [Más información sobre los invitados](../use/guests.md). |

Un **grupo** es un conjunto de personas, como Ventas o Finanzas, igual que un grupo de Google o un grupo de usuarios
de Slack. Una carpeta se puede compartir con grupos o personas.

## La carpeta del equipo

Todo el conocimiento de la empresa vive en una sola carpeta del equipo en el servidor. Funciona como una unidad
compartida de Google Drive: un solo lugar para toda la empresa, con carpetas que solo algunas personas pueden abrir.

| Carpeta | Quién la ve |
|---|---|
| `shared/` | Lo que diga su uso compartido; normalmente todo el equipo. |
| `groups/<group>/` | Las personas de ese grupo, más quien tenga la carpeta compartida. |
| `projects/<project>/` | Solo los miembros del proyecto. |
| `skills/` | Todos la leen. Los responsables de habilidades la modifican. |
| `users/<id>/` | Solo esa persona. Ni siquiera el propietario ni los administradores. |

Una carpeta o un archivo que usted no puede abrir es invisible: en Archivos, en las respuestas de la IA, en la búsqueda, en las vistas previas, en el historial y en la papelera. [Más información sobre archivos y permisos](../use/files-and-permissions.md).

## Chats y proyectos

Un **chat** es una conversación con la IA. Solo lo ve la persona que lo empezó, hasta que lo comparte con personas o
grupos, igual que se comparte un documento de Google. Los chats de un proyecto del equipo los ven los miembros del proyecto, salvo que la persona que empieza uno lo bloquee.

Un **proyecto** es una carpeta con instrucciones, para el trabajo que vuelve una y otra vez a los mismos archivos: piense en una carpeta
de Drive con una nota encima que la IA lee cada vez. Un chat dentro de un proyecto le da a la IA esa carpeta y esas instrucciones. [Más información sobre chats y proyectos](../use/chats-and-projects.md).

![La barra de la izquierda: Trina, Chats, Proyectos, Archivos y Actividad, con la lista de Trina al lado: Preguntar a Trina, Buscar, Programadas, Habilidades del equipo, Fijado y el historial de Trina](../../images/concepts/rail.webp "La barra de la izquierda")

## Habilidades

Una **habilidad** es un archivo `SKILL.md` con un nombre, una descripción y un procedimiento, como una ficha de receta o una lista de
comprobación. Le dice a la IA cómo hace su equipo una tarea. Nunca da acceso adicional. [Más información sobre las habilidades del equipo](../use/team-skills.md).

## Motores y conexiones de IA

Un **motor** es el programa de IA que responde (se elige una vez; la mayoría de los equipos deja el predeterminado):

| Motor | Notas |
|---|---|
| Claude Code | El motor predeterminado. |
| Codex | El agente de OpenAI. No está disponible en un Mac de la oficina. |
| API | Experimental. Usa una dirección de API, un modelo y una clave configurados. |

Una **conexión de IA** es la cuenta que usa un motor: una suscripción de Claude, una clave de API o un inicio de sesión de ChatGPT. Como la
tarjeta SIM de un teléfono, el motor necesita una para funcionar, y la empresa que está detrás (Anthropic u OpenAI) factura esa cuenta. Las conexiones pueden ser personales o compartidas por un grupo o por todo el equipo.

## MCP y otras conexiones

Una **conexión MCP** permite que la IA use un servicio externo, como Notion o Linear, con el inicio de sesión de una persona o del
equipo. Es como permitir que una app de su iPhone use su calendario: lo permite una vez, en el servicio, y la IA
solo puede hacer lo que usted permitió. Nunca necesita la palabra MCP para conectar una app: [Conectar apps](../use/connect-apps.md). Trina AX también funciona al revés: su propio Claude puede conectarse a Trina AX como servidor MCP. [Más información sobre MCP](../use/mcp.md).

## Tareas programadas y uso

Una **tarea programada** repite una petición según un horario, en la zona horaria del equipo. El **uso** cuenta las respuestas, los tokens y el coste estimado por persona, con límites opcionales. [Más información sobre las tareas programadas](../use/scheduled-tasks.md).
