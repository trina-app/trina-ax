---
title: Configurar su equipo
description: Los primeros pasos del propietario después de crear un equipo: conectar la IA, el perfil de la empresa, las habilidades, los archivos del equipo, las herramientas y la invitación.
---

Después de crear un equipo, la app le guía a usted, el propietario, por unos pasos cortos. Solo el propietario los ve. Cada paso se puede dejar para más tarde, y los pasos continúan donde los dejó, en cualquier dispositivo.

Si creó el equipo en un navegador de un ordenador Mac o Windows, la página siguiente ofrece **Continuar en la app de Mac** (o **Continuar en la app de Windows**): la app inicia la sesión por sí sola, sin una segunda contraseña, y solo la app puede encontrar archivos de trabajo en su ordenador. **Continuar en el navegador** sigue con los pasos de esta página. Los pasos le acompañan: en la app se abren donde los dejó, con el sitio web de la empresa del enlace de registro ya escrito.

## Crear un equipo desde la app de escritorio

¿Aún no tiene equipo? La app de Mac y Windows le crea uno en el servicio alojado, con el plan gratuito y sin tarjeta:

:::steps
#### Crear un equipo gratis
Abra la app y elija **Crear un equipo gratis**. (**Solo quiero echar un vistazo** abre un equipo de demostración en su navegador, sin registro.)

#### Iniciar sesión
Con **Continuar con Google**, su navegador abre el inicio de sesión de Google; después puede cerrar la pestaña. Con una dirección de correo no sale de la app: escríbala, pulse **Enviar código** y escriba el código de 6 dígitos del correo. Al continuar, acepta los Términos y la Política de privacidad.

#### Poner nombre al equipo
Escriba el nombre del equipo. La app propone su dirección (`acme.trina.app`); **Cambiar** elige otra. Lea los límites del plan gratuito, marque la casilla y créelo.

#### Esperar unos minutos
Crear el equipo tarda unos 3 a 5 minutos. Puede cerrar la app; al abrirla de nuevo vuelve a esta pantalla.

#### Bienvenido a su equipo
El equipo se abre en la app, con su sesión iniciada. Si inició sesión con Google, pulse **Continuar**. Si inició sesión con un código por correo, primero **elija una contraseña**: la usará en su teléfono y en otros ordenadores.
:::

Cada cuenta tiene un equipo gratuito. Si la suya ya tiene un equipo, la app ofrece **Abrirlo** en su lugar. Un equipo gratuito se duerme cuando nadie lo usa y despierta cuando alguien lo abre. El propietario cambia de plan en **Administración › Sistema › Plan › Elegir un plan**. La versión de la Mac App Store solo inicia sesión en un equipo que creó antes (**¿Ya creó un equipo?** **Iniciar sesión**).

## Los pasos

:::steps
#### Conexión de IA (solo si todavía no responde ninguna IA)
Conecte una suscripción de Claude o ChatGPT, o una clave de API. Sin IA no se puede leer el perfil de la empresa, por eso este paso va primero. **Hacerlo más tarde** sale de los pasos; la fila de configuración muestra entonces **Conectar IA**.

#### Perfil de la empresa
Escriba el sitio web de la empresa. La IA lo lee y escribe una línea sobre la empresa ("Esto es lo que entendimos: … · Editar"). Con **Añadir un archivo de presentación si lo tiene** puede añadir un archivo de presentación o una presentación de la empresa. Mientras la IA lee, no hay nada que pulsar. Si tarda más de 90 segundos, **No esperar, continuar** pasa al paso siguiente y la lectura sigue; vuelva a este paso en la misma ventana para verlo.

**Guardar y seguir** guarda el perfil. También pone las fotos del sitio web y un archivo de presentación de la empresa en la carpeta de marca del equipo; la línea bajo el botón lo indica. No empieza nada más por sí solo.

#### Elija las habilidades que usará su equipo
Las habilidades que preparó Trina AX, cada una con **Ejemplo**: Company slide deck, Promo cards, Promo video y Natural writing. Las tres primeras aparecen marcadas si guardó el perfil de la empresa. El botón dice lo que se añade, por ejemplo **Añadir 3 habilidades**. No se añade nada hasta que lo pulse. Para traer las habilidades que usa con Claude Code o Codex, use más tarde **Habilidades del equipo › Traer mis habilidades** ([Habilidades del equipo](../use/team-skills.md)).

#### Archivos del equipo
**Elegir carpeta** con documentos de la empresa. La IA sugiere los que el equipo puede usar solo a partir de los nombres de archivo, las carpetas y las fechas, y usted marca lo que se sube. No se sube nada hasta que pulse el botón. Después, la IA puede leerlos y proponer carpetas en las que ordenarlos (**¿Los ordenamos así?**). Una línea indica quién verá los archivos.

#### Herramientas del equipo
**Herramientas para su equipo** es una sola lista: Notion, Higgsfield (imágenes y vídeos con IA) y, donde su servidor
puede conectarlos, Google Drive y Gmail. Cada fila ofrece una de dos formas, o las dos:

- **Conectar para el equipo** (el botón de la derecha). Usted inicia sesión una vez con una cuenta y todo el equipo usa
  esa única conexión, como un buzón compartido que todos los de un equipo pueden abrir. Notion y Higgsfield abren la
  página de inicio de sesión del propio servicio en una ventana nueva; una conexión de equipo de Higgsfield usa el plan y
  los créditos de esa única cuenta. Gmail abre el diálogo que usa Administración › Apps conectadas:
  **Continuar con Google**, inicie sesión con la cuenta de Google compartida (como `sales@acme.com`) y luego elija
  quién puede usarla. Google Drive abre otro distinto, **Compartir un Google Drive con el equipo**: el mismo inicio de
  sesión, y además elige qué carpetas de esa cuenta puede usar el equipo.
- **Pedir que cada uno conecte la suya** (el interruptor bajo la línea de cada fila). Ahora no se
  conecta nada. La herramienta aparece primero en **Configuración › Conectores** de todos, marcada **El equipo pide
  conectarla**, y cada persona inicia sesión con su propia cuenta, igual que cada uno añade su propio Gmail en su
  propio teléfono. No bloquea nada: cualquiera puede seguir conectando cualquier herramienta, o ninguna.

![El paso Herramientas para su equipo: Notion, Higgsfield y Gmail, cada una con Conectar para el equipo a la derecha y el interruptor Pedir que cada uno conecte la suya bajo su línea; Otras herramientas y Hacerlo más tarde abajo](../../images/setup/tools-step.webp "Herramientas para su equipo")

Tras una conexión del equipo, la fila dice **Conectado** (una fila de Google también nombra la cuenta compartida y quién
la usa). **Otras herramientas** abre la lista completa, donde la página de cada herramienta tiene el mismo interruptor.
Slack también está ahí y en **Administración › Apps conectadas** ([Slack](../use/slack.md)): requiere algunos pasos
más, así que no es una fila de este paso.
Todo esto se cambia más tarde: las conexiones del equipo en **Administración › Apps conectadas**, el interruptor de cada
herramienta en su página de **Configuración › Conectores**. En este paso nadie inicia sesión con su propia cuenta. En un
teléfono este paso se omite.

#### Invitación
Copie el mensaje ya preparado. Menciona una habilidad. Quienes se unen llegan a Inicio, donde una tarjeta de bienvenida dice quién les invitó y qué hacer primero; la habilidad está en **Habilidades del equipo**. Si cada persona inicia sesión en su propia IA, el mensaje lo dice. La página de invitación se ofrece en el idioma del navegador de la persona. Si otra persona ya tiene la sesión iniciada en ese ordenador, la página dice "Ya está en <nombre del equipo>" y ofrece **Cerrar sesión para unirse**, que cierra la sesión y abre el mismo enlace.
:::

Al final, **Todo listo** resume la configuración: cada paso con lo que hizo, o pendiente con **Hacerlo ahora**. Después viene su propia configuración (sus herramientas, su foto y sus apps): **Empezar mi configuración** lleva a Inicio. Se muestra una sola vez.

## Volver a la configuración

- **Seguir con la configuración · 2/5** aparece cerca de la parte superior de las listas de Trina, Chats, Archivos y Actividad, junto a la barra de la izquierda, hasta que termine los pasos. Abre los pasos donde los dejó. En un teléfono está arriba de la lista **☰** de la pestaña **Trina** y de la pestaña **Archivos**, e Inicio la muestra como una fila discreta bajo el cuadro de mensaje.
- Al abrir la app en Inicio también vuelve a los pasos, una vez por sesión del navegador.
- ✕ oculta la fila. **Ver la configuración inicial otra vez** en Administración › Inicio la vuelve a mostrar.
- La tarjeta del objetivo del equipo y **Preparado en su equipo** en Inicio tienen **Ocultar**. **Configuración › Perfil** los vuelve a mostrar (el objetivo del equipo también desde Administración › Inicio).

## Cuándo se considera terminada la configuración

El perfil de la empresa, las habilidades, los archivos del equipo, las herramientas y la invitación están hechos o aplazados. Una habilidad que se debe combinar con una habilidad del equipo existente espera hasta entonces; después, un aviso en **Actividad**, **Revisar habilidades para combinar**, abre el chat para combinarlas.
