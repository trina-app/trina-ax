---
name: review-digest
description: Resumen de reseñas de clientes. Resume las reseñas de clientes con temas y recuentos, tres citas que podemos usar y tres próximos pasos. Úsela para "resume las reseñas", "qué dicen los clientes" y peticiones parecidas.
metadata:
  title: Resumen de reseñas de clientes
---

# Resumen de reseñas de clientes

## Fuente
- Solo `projects/Voz del cliente/Reseñas Oct–Nov.csv`: una fila por reseña (mes, sabor, estrellas, tema, qué dijeron,
  nombre, Cita OK). Es pequeño: léalo una vez y cuente a partir de él. No abra ningún otro archivo.

## Cómo
1. Una línea: cuántas reseñas hay, la media de estrellas y el sabor favorito (de los meses pedidos; si no, de todos).
2. **Temas**: | Tema | Reseñas | Qué dicen |, primero los de más reseñas.
3. **Citas que podemos usar**: tres, solo filas con Cita OK "sí", con nombre de pila y sabor.
4. **Próximos pasos**: tres, una línea cada uno, con quién podría encargarse (Atención al cliente, Operaciones, Marketing, la tienda).

## Reglas
- Recuentos y medias solo del archivo, nunca a ojo: los recuentos por tema suman el total.
- No cite nunca a quien tenga Cita OK "no".
- Responda en el chat. Guarde solo si se lo piden.
