---
title: Uso y límites
description: Vea las respuestas, los tokens y el coste estimado por persona, y fije límites de tokens para personas, grupos o el equipo.
---

Trina AX cuenta cada respuesta: quién preguntó, qué motor y qué modelo, cuántos tokens y un coste estimado.

:::note
Los costes son estimaciones del precio equivalente de la API, no facturas. Las conexiones por suscripción suman 0 por petición, pero sus tokens sí se cuentan.
:::

## Su propio uso

Abra **Configuración › Uso** (su foto abajo de la barra de la izquierda › **Configuración**; en un teléfono, la pestaña **Yo**). Muestra sus respuestas y su coste estimado, qué IA las respondió y cuánto ha usado de cada límite que se le aplica. Solo ve sus propios números.

![Configuración › Uso: su uso de este mes, si se le aplica un límite, sus respuestas y su coste estimado, y Sus respuestas por IA](../../images/usage/mine.webp "Su propio uso, en Configuración")

:::note
El uso personal es nuevo en la versión 0.4.0. Antes, solo los administradores ven el uso, en **Administración › Uso**.
:::

## El uso del equipo

Los administradores abren **Administración › Uso**. Está organizado como la página de uso de la Claude Console.

- **Filtros** arriba, cada uno un botón pequeño que muestra lo que está elegido:
  - **Grupo** (solo si el equipo tiene grupos) y **Rango**: hoy, los últimos 7 o 30 días, este mes o un rango personalizado.
  - **Persona**, **Motor**, **Modelo** y **Conexión de IA**, para ver uno de ellos. **Quitar filtros** vuelve a mostrarlo todo.
  - **Agrupar por** persona, grupo, motor, modelo, día, conexión de IA o habilidad.
- **Tarjetas** con los totales: tokens de entrada, tokens de salida, respuestas y el coste estimado.
- **Uso de tokens**: los tokens por día en barras apiladas, un color por cada valor de Agrupar por (los cinco mayores, el resto como "Otros"). Señale un día, o ponga el foco en el gráfico y use las flechas del teclado, para ver los números de ese día.
- **Desglose**: una fila por cada valor de Agrupar por, con las respuestas, los tokens, su proporción y el coste estimado.
- El botón **Descargar** guarda el desglose como CSV.

![Administración › Uso: botones de filtro, tarjetas con los totales, el gráfico Uso de tokens y el desglose](../../images/usage/team.webp "El uso del equipo, en Administración")

Las habilidades personales nunca se cuentan por su nombre, así que ningún administrador ve lo que alguien guarda en privado. Las habilidades de grupo se cuentan como las habilidades del equipo.

## Fijar límites

De forma predeterminada no hay límites. Los administradores los añaden en **Administración › Configuración del equipo**, en **Límites de uso**.

Para una sola persona es más rápido desde **Administración › Miembros e invitaciones**: abra su menú **…** y elija **Límite de uso…**. El
cuadro ya corresponde a esa persona y se abre con el límite que tiene, junto con cuánto ha usado. Elija **Por día** o
**Por mes** para ver o fijar cada uno, y **Quitar límite** para eliminar uno. Las personas con un límite lo muestran en una línea discreta
bajo su nombre, con **Límite superado** cuando se ha agotado. En un teléfono, abra la persona y toque **Límite de uso**.

| Límite para | Periodo |
|---|---|
| Una persona | por día o por mes |
| Un grupo | por día o por mes |
| Todo el equipo | por día o por mes |

Cuando se alcanza un límite, las personas a las que afecta no pueden empezar respuestas nuevas hasta que se reinicie el periodo. Su página de uso indica cuándo ocurrirá.
