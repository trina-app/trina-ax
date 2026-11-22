---
title: Apps de Google
description: Conecte su Google Drive, Gmail, Google Calendar, Docs y Sheets para que la IA pueda usarlos, y qué configura primero un administrador en un servidor que gestiona usted mismo.
---

Google Drive, Gmail, Google Calendar, Google Docs y Google Sheets vienen integrados en Trina AX. Cada persona conecta su
propia cuenta de Google, una vez por app, y la IA la usa solo en los chats de esa persona, con los permisos de Google de
esa persona.

No hay nada que copiar ni pegar: usted inicia sesión en Google.

## Conectar una app de Google (todos)

:::tip
**Qué necesita**

- Su cuenta de Google (una cuenta de Google Workspace de la empresa o una cuenta personal de Gmail), con la sesión
  iniciada en su navegador.
:::

:::steps
#### Abra la app en Conectores
1. Elija su foto en la parte inferior de la barra de la izquierda y después **Configuración**.
2. En la lista de la izquierda, elija **Conectores**.
3. En **Descubrir**, elija la app, **Gmail** por ejemplo. (Escriba su nombre en **Buscar apps** si no la ve).

Se abre la página de la app. Explica qué puede hacer allí la IA y enumera todas las herramientas; un lápiz marca las
herramientas que cambian algo. **Conectar** está arriba a la derecha.

![La página de Gmail en Configuración › Conectores de un miembro: Solo para usted, Conectores › Gmail, el botón Conectar arriba a la derecha, lo que hace la IA con Gmail y sus herramientas](../../images/connect/google-member-connect.webp "Gmail, antes de conectar")

#### Elija Conectar
Se abre la propia página de inicio de sesión de Google en una ventana nueva (en la app de escritorio, en su navegador).
Si tiene la sesión iniciada en más de una cuenta de Google, Google le pregunta cuál: elija la que quiere usar.

#### Deje todas las casillas marcadas
Google muestra una página que nombra a Trina AX y enumera lo que puede hacer, una línea por permiso, como "Leer,
redactar y enviar correos". Algunas líneas tienen una casilla. Deje **todas** las casillas marcadas y elija
**Continue**. Un inicio de sesión con una casilla sin marcar se rechaza: "No se marcaron algunos permisos. Vuelva
a conectar y deje todas las casillas marcadas."

#### Confirme la cuenta
De vuelta en Trina AX, compruebe la cuenta que aparece ("¿Conectar esta cuenta?") y elija **Conectar esta cuenta**. La
página indica ahora **Conectado** arriba a la derecha y **Conectado como** y su dirección debajo del nombre.

![La página de Gmail después de conectar: Conectado arriba a la derecha con un menú ⋯, y Conectado como bob@acme.example.com debajo del nombre](../../images/connect/google-member-connected.webp "Gmail, conectado")
:::

La lectura no pide confirmación. Antes de que la IA envíe un correo, añada un evento o edite un documento, muestra una tarjeta con todo lo
que va a hacer y espera su sí. En la tarjeta, o en la **Configuración** de la app (su menú **⋯**), puede elegir
**Permitir siempre** en lugar de **Preguntarme primero**. Google Drive solo lee: nunca cambia, mueve ni envía nada.

### Si ve "Pedir que lo añadan"

La app todavía no está configurada en su equipo. Elija **Pedir que lo añadan**: el propietario y los administradores
reciben un aviso, y usted recibe respuesta cuando ya puede conectar.

![La página de Google Drive en Configuración › Conectores de un miembro: Pedir que lo añadan (Ask admin to add it) en lugar de Conectar, lo que hace la IA con Drive y sus tres herramientas](../../images/connect/google-member-ask.webp "Pedir que lo añadan")

## Una cuenta de Google compartida para el equipo (administradores)

Un buzón o calendario compartido, como `sales@acme.com`, se puede conectar una sola vez para las personas que lo
necesitan, como un buzón compartido de Gmail que abren varias personas. Lo usan en sus chats sin conectar el suyo.

:::steps
#### Abra la app de Google en Administración
Elija el logotipo de su equipo en la parte superior de la barra de la izquierda, después **Administración › Apps
conectadas**, y elija la app de Google (Gmail, por ejemplo). Desplácese hasta **Ajustes del equipo**. La fila **Cuenta
de Google compartida** tiene **Conectar para el equipo** a la derecha.

![Los Ajustes del equipo de Gmail en Administración › Apps conectadas: Quién puede usarlo, luego Cuenta de Google compartida con el botón Conectar para el equipo, luego las API de Google](../../images/connect/google-team-row.webp "Ajustes del equipo › Cuenta de Google compartida")

#### Inicie sesión con la cuenta compartida
Elija **Conectar para el equipo**. Se abre el cuadro **Compartir una cuenta de Gmail con el equipo**. Elija **Continuar
con Google** e inicie sesión en Google con la cuenta compartida, no con la suya. Deje todas las casillas marcadas, como
arriba, y después compruebe la cuenta y elija **Conectar esta cuenta**.

![El cuadro Compartir una cuenta de Gmail con el equipo: inicie sesión con la cuenta de Google que usará el equipo, el botón Continuar con Google y Cancelar](../../images/connect/google-team-dialog.webp "Compartir una cuenta de Gmail con el equipo")

#### Elija quién la usa y guarde
En **Quién puede usarlo**, elija a todos, grupos o personas, y elija **Guardar**. Nadie la usa hasta que guarde; si
cierra el cuadro antes, se quita de nuevo. La fila muestra entonces la cuenta, quién la usa y quién la conectó, con un
menú **⋯**: **Cambiar personas**, **Volver a conectar** y **Quitar**.
:::

Google Drive tiene **Compartido con el equipo** en el mismo lugar: **Compartir un Google Drive con el equipo** conecta
una cuenta de Google y le deja elegir sus carpetas; las personas que elija las usan en sus chats.

Desde un chat funciona igual: cuando un propietario o administrador pide a la IA que conecte Google Drive o Gmail (o
Calendar, Docs o Sheets), su tarjeta también tiene **Conectar para el equipo**, que abre este mismo diálogo. Los
miembros ven solo su propia conexión. A quien ya usa una cuenta compartida, o un Drive compartido con él, se le dice que
está conectado, sin nada que conectar.

## Configurar las apps de Google (administradores de un servidor que gestiona usted mismo)

En un equipo alojado por Trina, el inicio de sesión de Google ya está listo: no hay nada que configurar. En un servidor
que gestiona su propia empresa, un administrador crea una vez una app de inicio de sesión de Google en Google Cloud y la
añade en **Administración › Apps conectadas**.

:::tip
**Qué necesita**

- Una **dirección https pública** para el servidor de su equipo (las personas vuelven a ella desde Google). Mientras no
  la tenga, las apps de Google muestran "Primero hace falta la dirección pública de este servidor." La fija quien
  gestiona el servidor: vea [Configuration](../../operate/configuration.md) (en inglés).
- Un **proyecto de Google Cloud**, las **API** que necesita cada app activadas y un **cliente de inicio de sesión** de
  tipo **Web application**.
- De Google Cloud: el **archivo JSON** del cliente (o su **ID de cliente** y su **Secreto del cliente**).
- Para Google Cloud: las **direcciones de regreso** que muestra Trina AX, una para Google Drive y otra para las otras
  cuatro apps.
:::

![La página de Gmail en Administración › Apps conectadas en un servidor sin dirección pública: Sin configurar, Primero hace falta la dirección pública de este servidor y, en Ajustes del equipo, la API de Google que hay que activar](../../images/connect/google-admin-gmail.webp "Gmail, todavía sin configurar")

:::steps
#### Cree la app en Google Cloud
Siga [En Google Cloud](google-own-app.md#en-google-cloud) en la página de la app de la empresa: un proyecto, las API, el
nombre y el público de la app (**Internal** para una empresa con Google Workspace; si no, **External** con usuarios de
prueba), los permisos y un cliente **Web application**.

#### Añada las direcciones de regreso
En **Authorized redirect URIs** del cliente, añada las direcciones que muestra el cuadro **Configurar** de cada app, con
su botón de copiar:

```
https://<your team address>/api/integrations/google-drive/callback
https://<your team address>/api/integrations/google-apps/callback
```

#### Suba el archivo en Trina AX
En **Administración › Apps conectadas**, abra **Google Drive** y elija **Configurar**. Suba el archivo JSON que
descargó, o pegue el **ID de cliente** y el **Secreto del cliente**, y guarde. Después abra Gmail, Google Calendar, Docs
y Sheets uno por uno, elija **Configurar** y active **Usar la misma app de Google que Google Drive**: no hay que subir
nada más.
:::

La página de cada app enumera, en **API de Google**, las API que hay que activar para ella:

| App | API de Google que hay que habilitar |
|---|---|
| Google Drive | Google Drive API |
| Gmail | Gmail API |
| Google Calendar | Google Calendar API |
| Google Docs | Google Docs API, Google Drive API |
| Google Sheets | Google Sheets API, Google Drive API |

Las apps de Gmail, Calendar, Docs y Sheets funcionan en servidores Linux. En la app de Mac sus páginas dicen "Aún no
disponible en el servidor del equipo".

## Mostrar el nombre de su empresa en la pantalla de Google

Una empresa con Google Workspace puede hacer que todas las apps de Google inicien sesión con su propia app de Google, de
modo que las personas vean el nombre de la empresa y ningún aviso en la pantalla de Google:
[Usar la app de Google de su empresa](google-own-app.md).

## Problemas

| Qué ve | Qué hacer |
|---|---|
| **No se marcaron algunos permisos. Vuelva a conectar y deje todas las casillas marcadas.** | Vuelva a conectar y deje marcadas todas las casillas de la pantalla de Google. |
| **Google le pide que inicie sesión de nuevo.** | Elija **Volver a conectar** en la página de la app. Ocurre después de un cambio de contraseña, o cuando el administrador de su empresa retiró el acceso. |
| **`redirect_uri_mismatch`** en la página de Google (servidores propios) | Una dirección de regreso en Google Cloud difiere de la que muestra Trina AX. Cópiela de nuevo desde el cuadro **Configurar**. |
| **"This app is blocked"** o **`admin_policy_enforced`** | El administrador de Google de su empresa limita qué apps pueden usar las cuentas de Google. Pídale que marque la app como de confianza: vea [Marcar la app como de confianza en la Admin console](google-own-app.md#opcional-marcar-la-app-como-de-confianza-en-la-admin-console). |
| **Google hasn't verified this app** | Una app External en Testing. Elija **Advanced** › **Go to …** solo si su administrador creó la app; o pídale que cambie a la app propia de su empresa. |

Todos los detalles para desarrolladores y operadores: [Google apps](../../../GOOGLE-APPS.md) (en inglés) y
[Google Drive](../../../GOOGLE-DRIVE.md) (en inglés).
