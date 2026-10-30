# Trina AX — el espacio de trabajo de IA de tu empresa

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [Español](README.es.md)

Reúne los archivos de la empresa, los procedimientos del equipo y los permisos de las carpetas. Tu equipo puede hacer preguntas, preparar borradores y reutilizar su forma de trabajar desde el navegador. Una *habilidad* (skill) es un conjunto de instrucciones reutilizables; no entrena un modelo ni concede permisos adicionales.

**[Consultar alojamiento y precios](https://ax.trina.app/#pricing)** · **[Instalación propia: guía para TI (inglés)](docs/for-admins.md)**

![Demostración local real con archivos ficticios; interfaz en inglés](docs/images/files-en.png)

## Ejemplos para cada función

| Función | Una tarea para empezar | Ejemplo para copiar |
|---|---|---|
| Dirección / responsable de equipo | Resumir decisiones, riesgos y próximos pasos de la semana | [Informe semanal](examples/skills/weekly-team-report/SKILL.md) |
| Ventas | Redactar un seguimiento sin inventar compromisos | [Seguimiento comercial](examples/skills/sales-follow-up/SKILL.md) |
| Marketing | Preparar una propuesta a partir de pautas de marca aprobadas | [Brief de marca](examples/skills/brand-brief/SKILL.md) |
| Finanzas | Señalar comprobantes faltantes e importes por revisar | [Revisión de gastos](examples/skills/expense-review/SKILL.md) |
| Recursos humanos | Responder preguntas de incorporación con políticas autorizadas | [Guía de incorporación](examples/skills/new-hire-guide/SKILL.md) |
| Todo el equipo | Extraer decisiones y tareas de una reunión | [Resumen de reunión](examples/skills/meeting-summary/SKILL.md) |

Son instrucciones iniciales con datos ficticios. Una persona debe revisar los resultados antes de usarlos o compartirlos.

## La misma pregunta, respuestas distintas

«Resume nuestra política de incorporación». Una persona de RR. HH. con acceso a esa carpeta puede utilizarla como fuente; una persona de ventas sin acceso no puede leerla mediante las herramientas de archivos. El servidor comprueba los permisos de quien pregunta en cada solicitud de archivos. Las habilidades también respetan los permisos de las carpetas.

![Cuenta ficticia de marketing](docs/images/permissions-alice-en.png)
![Cuenta ficticia de finanzas](docs/images/permissions-bob-en.png)

Las capturas muestran las carpetas disponibles para las cuentas de marketing y finanzas de la demo. Demuestran acceso a archivos, no respuestas de IA en vivo. [Seguridad, confirmación al compartir y límites (inglés)](docs/security-and-permissions.md).

## Elige cómo empezar

| Opción | Requisitos | Operación y primer resultado |
|---|---|---|
| Alojamiento de Trina | Navegador, internet y conexión de IA autorizada | Trina opera en AWS Seúl; [consulta la puesta en marcha](https://ax.trina.app/#contact) |
| Servidor Linux propio | Debian 12/13 o Ubuntu 24.04; systemd y cgroup v2; amd64/arm64; 4 GB de RAM recomendados, 20 GB de disco como mínimo | TI instala, actualiza y recupera las copias; [guía Linux en inglés](docs/INSTALL-LINUX.en.md) |
| Mac de oficina | Mac dedicado con macOS 13 o posterior, sesión del sistema abierta, internet y conexión de Claude permitida | Responsable de la oficina; [guía Mac en inglés](docs/OFFICE.en.md). Sin garantía de capacidad medida |
| Evaluación local | Git, Bun 1.3.12 (versión de CI), Go 1.27 o posterior y herramientas de compilación; Mac o Linux preparado | Archivos ficticios y comparación de permisos sin cuenta de IA; [inicio rápido en inglés](docs/QUICKSTART.md) |

Precios verificados el 30 de octubre de 2026: **Starter $39/mes (hasta 5 personas), Team $69 (15), Business $129 (40)**, en USD antes de impuestos. El uso de IA se cobra por separado. El software para instalación propia es gratuito; el equipo, la operación y los proveedores corren por tu cuenta. Consulta los [precios vigentes](https://ax.trina.app/#pricing). El alojamiento se contrata mediante consulta; no es una prueba gratuita de alta inmediata.

Después de clonar el repositorio e instalar las dependencias, ejecuta `bun run demo`. Compila y abre una demostración local con datos ficticios y la IA desactivada. **No es una instalación de producción.** [Requisitos, cierre y limpieza (inglés)](docs/QUICKSTART.md).

## La primera semana

Crea la cuenta del propietario del equipo y sigue este orden: **permisos → conexión de IA → invitar al equipo → primera habilidad → primera copia de seguridad**. Empieza con pocos archivos autorizados y una tarea repetible. [Lista para responsables (inglés)](docs/for-teams.md) · [Copiar los ejemplos (inglés)](examples/README.md).

En instalaciones con conexiones administradas se prioriza la conexión personal disponible, seguida de la asignada a la persona, al grupo y a todo el equipo. Los equipos nuevos permiten compartir suscripciones de forma predeterminada; las elecciones guardadas se conservan. También se requiere el consentimiento de cada conexión. **Esta opción del software no concede autorización según los términos de Anthropic u OpenAI.** Usa únicamente cuentas y planes autorizados para el uso previsto. La demo desactiva la IA; los modos de desarrollo y oficina con inicio de sesión local se comportan de otra manera. [Preguntas sobre conexiones (inglés)](docs/FAQ.md).

## Lo que no prometemos

- Alojar el sistema no hace que toda la IA funcione sin conexión: el contexto seleccionado se envía al proveedor de IA y las integraciones reciben sus solicitudes.
- Quien opera el servidor puede leer archivos y chats almacenados; en el alojamiento, esto incluye a los operadores de Trina. La administración de la aplicación no ofrece una pantalla para leer todas las conversaciones privadas.
- Retirar permisos no borra respuestas anteriores. La confirmación al ampliar el acceso no evita todas las posibles filtraciones.
- No prometemos certificaciones de seguridad, respuestas perfectas, ahorros garantizados ni decisiones legales, financieras o de RR. HH. automáticas. Revisa los resultados y los límites de cada instalación.
- La IA ve las fotos y las páginas PDF escaneadas como imágenes (un administrador puede desactivarlo), pero los servidores Linux no usan OCR: allí los documentos escaneados y las fotos no se pueden buscar como texto.
- Se admite la extracción de texto de HWP/HWPX. Las [vistas previas visuales](resources/hwp/README.md) experimentales están en el código, pero **desactivadas de forma predeterminada**; las herramientas necesarias no se incluyen en los paquetes estándar. Debian 12 **no admite** estas vistas previas. La extracción de texto y las descargas originales siguen disponibles. Los formatos complejos y las conversiones tienen límites.

## Clientes, versiones y ayuda

Usa el navegador en computadora o teléfono. Hay un instalador de Windows publicado; el ZIP de oficina para Mac ejecuta el servidor y **no es un DMG de escritorio**. El código de aplicaciones móviles no implica disponibilidad en las tiendas. El código actual incluye inglés, coreano, indonesio, japonés y español en toda la aplicación. Los instaladores publicados pueden no incluir todavía los últimos cambios; consulta sus notas de versión.

[Última versión y sumas de comprobación](https://github.com/trina-app/trina-ax/releases/latest) · [Cambios](CHANGELOG.md) · [Documentación](docs/README.md) · [Preguntas frecuentes (inglés)](docs/FAQ.md) · [Soporte y comunidad](SUPPORT.md). Los informes públicos se reciben en inglés y coreano.

## Para desarrollo y operaciones

Las herramientas de IA se ejecutan en el servidor del equipo y se comprueba el acceso de la persona conectada. Linux y Mac con cuentas separadas por función añaden cuentas de motor dedicadas y aislamiento del sistema. El modo oficina utiliza la sesión del usuario de Mac; la demo de desarrollo no prueba el aislamiento de producción. MCP (Model Context Protocol) permite conectar herramientas externas y es opcional para la primera prueba.

[Desarrollo y pruebas](docs/DEVELOPMENT.md) · [Contribuir aquí](CONTRIBUTING.md) · [Configuración](docs/CONFIGURATION.md) · [Reportar vulnerabilidades](SECURITY.md) · [Índice para herramientas](llms.txt)

## Licencia

[AGPL-3.0-only](LICENSE), con el [protocolo de nube](shared/src/cloud-protocol/LICENSE) bajo licencia MIT por separado. Si ofreces una versión modificada como servicio de red, debes ofrecer su código fuente correspondiente a los usuarios según la licencia. [Avisos](NOTICE) · [Avisos de terceros](docs/THIRD-PARTY-NOTICES.md). Claude Code y Codex tienen términos propios; Anthropic y OpenAI no avalan este proyecto.
