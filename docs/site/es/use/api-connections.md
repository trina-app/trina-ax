---
title: La API de su empresa
description: Deje que la IA use el sistema propio de su empresa a través de su API web con una clave, o que inicie sesión con una app que usted creó en el servicio, como NAVER WORKS, paso a paso.
---

Su empresa puede tener su propio sistema: un gestor de proyectos, un sistema de pedidos, una herramienta interna. Si
tiene una API web, la IA puede usarlo. Un propietario o administrador lo añade una vez en **Administración › Apps
conectadas**, con su dirección, una clave y unas líneas sobre cómo usarlo. Después, la IA solo puede llamar a direcciones
que estén dentro de esa.

Algunos servicios, como NAVER WORKS, no entregan claves: las personas inician sesión mediante una app de inicio de sesión
que su empresa crea en ese servicio. Eso se explica en [la segunda mitad de esta página](#iniciar-sesión-con-su-propia-app).

Para los datos de abajo necesita a alguien que conozca el sistema (su administrador o desarrollador). Nada de esto
requiere código.

## Conectar una API con una clave

:::tip
**Qué necesita**

- **Dirección**: la dirección base de la API, como `https://pm.acme.example/api/v1`. Pregúntela al administrador del
  sistema, o búsquela en su documentación de la API ("base URL").
- **Clave**: una clave de API o un token para ese sistema. Cree una solo para Trina AX, sin más permisos de los que
  necesita la IA.
- **Encabezado para la clave**: la mayoría de las API aceptan `Authorization: Bearer <key>`. Si la documentación de la
  API indica otro encabezado, como `X-API-Key`, anote su nombre exacto.
- **Notas de uso**: unas líneas sobre a qué direcciones debe llamar la IA. Están en la documentación de la API del
  sistema.
:::

:::steps
#### Abra el cuadro
1. Elija el logotipo de su equipo en la parte superior de la barra de la izquierda y luego **Administración › Apps
   conectadas**.
2. Desplácese hasta el final de **Descubrir**. Debajo de la lista, junto a "¿No aparece?", elija **Añadir por su
   dirección**. Se abre el cuadro **Añadir una app para el equipo**.
3. Cerca de la parte inferior del cuadro, abra **Avanzado** (está plegado). Ponga **Tipo** en **API** y **Método de
   inicio de sesión** en **Clave de API**. El cuadro muestra entonces los campos de abajo.

#### Rellene los campos
- **Nombre**: el nombre que las personas ven en los chats, como "AI PM".
- **Dirección**: la dirección base. La IA solo puede llamar a rutas que estén dentro de ella.
- **Encabezado para la clave**: deje **Authorization: Bearer (predeterminado)**, o elija **Otro encabezado** y escriba
  el **Nombre del encabezado** exactamente como aparece en la documentación.
- **Clave**: pegue la clave.
- **Notas de uso**: las rutas principales, los datos que necesitan y lo que la IA no debe hacer. Hasta 4.000 caracteres.

![Añadir una app para el equipo, rellenado para una API inventada de AI PM: la dirección https://pm.acme.example/api/v1, Authorization: Bearer (predeterminado), la clave, Tipo API, Método de inicio de sesión Clave de API y notas de uso con GET /projects y POST /tasks](../../images/connect/api-key-dialog.webp "Una API con una clave")

#### Elija quién puede usarla y guarde
**Para: Todo el equipo · Cambiar** elige los grupos o las personas. Al principio, deje **Escritura, eliminación y
envío** en **Preguntar cada vez**. Elija **Guardar**: Trina AX comprueba la dirección y la clave, y la línea muestra
**Conectado**.
:::

Una buena nota de uso tiene este aspecto:

```
List projects with GET /projects.
Create a task with POST /tasks and a JSON body {"projectId", "title", "dueDate"}.
Dates are YYYY-MM-DD. Never call DELETE.
```

La IA lee la nota cada vez que usa la API, así que manténgala corta y exacta.

## Iniciar sesión con su propia app

Algunos servicios dejan que las personas inicien sesión (OAuth), pero solo a través de una app registrada en el
servicio: NAVER WORKS y los propios servidores MCP de Google. Usted crea esa app una vez en la consola para
desarrolladores del servicio y después pega sus datos en Trina AX. Normalmente se añade como **plantilla**, para que
cada miembro inicie sesión con su propia cuenta.

:::tip
**Qué necesita, de la consola para desarrolladores del servicio**

- **ID de cliente** y **Secreto de cliente** de la app que creó allí.
- **Dirección de inicio de sesión** y **Dirección de token** (para una API; un servidor MCP las encuentra por sí solo).
- **Permisos (scope)**: los permisos que necesita la IA, separados por espacios.

**Qué le da al servicio**

- La **dirección de redirección** que muestra Trina AX: `https://<your team address>/api/integrations/oauth/callback`.
:::

:::steps
#### Abra primero el cuadro en Trina AX
1. En **Administración › Apps conectadas**, elija **Añadir por su dirección** (debajo de la lista **Descubrir**).
2. Abra **Avanzado** y ponga **Quién conecta** en **Cada miembro la suya**, **Tipo** en **API** (o **Servidor MCP**) y
   **Método de inicio de sesión** en **Iniciar sesión (OAuth)**. Para un servidor MCP, active también **Iniciar sesión
   con mi propia aplicación**.
3. El cuadro muestra ahora **Dirección de redirección que debe registrar en su aplicación del servicio**, con un botón
   de copiar. Cópiela con ese botón, no seleccionando el texto, y deje el cuadro abierto.

#### Cree la app en el servicio
En la consola para desarrolladores del servicio, cree una app (puede llamarse "OAuth app", "client" o "integration").
Pegue la dirección de redirección en su redirect URL, elija los permisos y copie su **Client ID** y su **Client secret**.

#### Rellene el resto y guarde
De vuelta en Trina AX, rellene **Nombre**, **Dirección**, **ID de cliente**, **Secreto de cliente**, la **Dirección de
inicio de sesión** y la **Dirección de token** (para una API) y **Permisos (scope)**. Elija **Crear plantilla**. Los
miembros la ven entonces en **Configuración › Conectores** e inician sesión con su propia cuenta.

![Añadir una app para el equipo como plantilla para NAVER WORKS: Cada miembro inicia sesión con su propia cuenta, la dirección de redirección con su botón de copiar, ID de cliente, Secreto de cliente, Dirección de inicio de sesión, Dirección de token y Permisos rellenados](../../images/connect/own-app-dialog.webp "Iniciar sesión con su propia app")
:::

### NAVER WORKS

| En Trina AX | Dato |
|---|---|
| **Tipo** | **API** |
| **Dirección** | `https://www.worksapis.com/v1.0` |
| **Dirección de inicio de sesión** | `https://auth.worksmobile.com/oauth2/v2.0/authorize` |
| **Dirección de token** | `https://auth.worksmobile.com/oauth2/v2.0/token` |
| **ID de cliente**, **Secreto de cliente** | De su app en NAVER WORKS Developer Console |
| **Permisos (scope)** | Lo que necesita la IA, por ejemplo `calendar mail file user.read` |
| **Notas de uso** | Las direcciones de la API a las que debe llamar la IA, según la documentación de la API de NAVER WORKS |

En NAVER WORKS Developer Console, abra su app (o añada una en API 2.0), ponga en su **Redirect URL** la dirección que
muestra Trina AX, marque los mismos **OAuth Scopes** y copie el **Client ID** y el **Client Secret**. NAVER WORKS explica
el inicio de sesión en su [guía de OAuth](https://developers.worksmobile.com/kr/docs/auth-oauth).

### Los servidores MCP de Google

Google también ofrece servidores MCP para Gmail, Calendar, Drive y más (`https://gmailmcp.googleapis.com/mcp/v1` y
similares), dentro del programa de vista previa de Google. Necesitan su propia app de inicio de sesión de Google, creada
como en [La app de Google de su empresa](google-own-app.md#en-google-cloud) pero con la dirección de redirección de
arriba. Para el uso diario, las [apps de Google](google-apps.md) integradas no necesitan ninguna app propia.

## Problemas

| Qué ve | Qué hacer |
|---|---|
| **El servicio no aceptó el ID de cliente ni el secreto de esta aplicación.** | El ID de cliente o el secreto se copiaron mal, o el secreto se renovó en el servicio. Edite la conexión, escriba de nuevo el secreto en **Avanzado** y vuelva a iniciar sesión. |
| El servicio dice que la dirección de redirección es incorrecta (`redirect_uri_mismatch`, "invalid redirect") | La redirect URL en la consola del servicio difiere de la que muestra Trina AX. Cópiela de nuevo con el botón de copiar; compruebe `https`, la dirección del equipo y que no haya una barra al final. |
| **El secreto de cliente guardado no pasa a una dirección nueva. Introdúzcalo de nuevo.** | Cambió la dirección o la dirección de inicio de sesión. Por seguridad, el secreto no se reutiliza: péguelo de nuevo. |
| Las llamadas responden 401 o 403 | La clave caducó, le falta un permiso o se copió con un espacio. Cree una clave nueva, o añada el permiso que falta en el servicio y vuelva a iniciar sesión. |
| La IA llama a rutas equivocadas | Haga más exactas las **Notas de uso**: enumere cada ruta con su método. |

Todos los detalles para desarrolladores: [Integrations](../../../INTEGRATIONS.md#your-own-app-client-id) (en inglés).
