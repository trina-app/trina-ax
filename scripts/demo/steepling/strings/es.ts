// Las frases del demo de exploración libre fuera de la historia guiada (español, adaptado de en.ts, no palabra por
// palabra): las salas y chats con vida alrededor de la historia, los otros equipos, la carpeta de la CEO, el Gmail y el
// Drive de mentira, las sugerencias de la barra. Personas, empresa, cifras y direcciones son inventadas (../README.md).
// Las frases de la historia salen de scripts/demo/mina/strings/es.ts. Trina habla de usted; entre colegas, de tú.
import type { FreeRoamStrings } from './en'

export const es: FreeRoamStrings = {
  groups: {
    marketing: 'Campañas, redes sociales, banners y páginas de producto',
    operations: { name: 'Operaciones', description: 'Pedidos, envíos y consultas de clientes' },
    sales: { name: 'Ventas', description: 'Cafeterías y oficinas' },
    shop: { name: 'Tienda online', description: 'La tienda y las suscripciones' },
  },

  leadership: {
    folder: 'shared/Dirección',
    files: [
      {
        name: 'Plan 2027 (borrador).md',
        text: [
          '# Plan 2027 (borrador, solo CEO)',
          '',
          'Steepling es una empresa ficticia inventada para este demo. Esta página es contenido de ejemplo.',
          '',
          '- Dos mezclas nuevas de invierno en 2027 (nombres provisionales: Pera Especiada, Rooibos con Cacao)',
          '- Abrir una segunda región de cafeterías socias en primavera',
          '- Contratar: una persona más en Operaciones y un diseñador',
          '',
          'Todavía no se ha compartido. Hable conmigo antes de planificar nada con esto.',
        ].join('\n'),
      },
    ],
  },

  files: [
    {
      path: 'groups/Operaciones/Envíos.md',
      text: '# Envíos\n\nContenido de ejemplo para el demo.\n\n- Los pedidos recibidos antes de las **14:00** salen el mismo día\n- Cafeterías: reparto semanal los martes, como siempre\n- Consultas de clientes: responder en un día laborable\n',
    },
    {
      path: 'groups/Ventas/Cuentas de cafeterías.md',
      text: '# Cuentas de cafeterías\n\nContenido de ejemplo para el demo.\n\n| Cafetería | Zona | Pedido | Próxima visita |\n|---|---|---|---|\n| Harbour Beans | Zona del puerto | 40 cajas / mes | Martes |\n| The Reading Room | Casco antiguo | 25 cajas / mes | La semana que viene |\n| Corner Kettle | Ribera | 15 cajas / mes | En dos semanas |\n',
    },
    {
      path: 'groups/Tienda online/Calendario de la tienda.md',
      text: '# Calendario de la tienda\n\nContenido de ejemplo para el demo.\n\n- Lanzamiento el lunes, 7:00: subir el banner (Yuzu y Jengibre, 20% de descuento)\n- Domingo de la segunda semana: termina la oferta de lanzamiento\n- Todos los días: los pedidos antes de las 14:00 salen el mismo día\n',
    },
    {
      path: 'groups/Marketing/Notas de la competencia.md',
      text: '# Notas de la competencia\n\nContenido de ejemplo para el demo. Todas las marcas son inventadas.\n\n| Marca | Novedad de este mes | Precio |\n|---|---|---|\n| Coldleaf | Mezcla de menta de invierno, 2x1 | $10,50 / 10 bolsitas |\n| Brewbright | Suscripción para oficinas, 15% de descuento | $8,90 / 10 bolsitas |\n| Teatime Co. | Nueva botella de vidrio | $12,00 / 10 bolsitas |\n',
    },
  ],

  personas: {
    mina: 'Soy Mina Lee. Hoy me incorporé al equipo de Marketing de Steepling.',
    sara: 'Soy Sara Jensen, responsable de Marketing de Steepling.',
  },

  memory: 'Mina entró en Marketing en la semana del lanzamiento de Yuzu y Jengibre; se hace cargo de los banners y las publicaciones de Leo.',

  profile: {
    oneLine: 'Steepling hace bolsitas de té para preparar en frío: una bolsita en agua fría y a las pocas horas está listo.',
    products: 'Steepling Cold Brew Tea en 6 sabores ($9,90 por 10 bolsitas); la mezcla de invierno Yuzu y Jengibre ($11,90 por 10 bolsitas)',
    audience: 'Gente que quiere té sin hervir agua; cafeterías y oficinas',
    tone: ['Tranquilo y cálido', 'Sencillo y cercano', 'Sin exagerar'],
    avoid: '"El mejor" o "número uno", y cifras que no podamos respaldar',
  },

  everyoneBefore: [
    { from: 'tom', minutesAgo: 7 * 1440 + 120, text: 'Aviso: los pedidos recibidos antes de las **14:00** ya salen el mismo día. Los detalles, en nuestra carpeta.' },
    { from: 'omar', minutesAgo: 5 * 1440 + 300, text: 'Mañana a las 7:00 la tienda estará 10 minutos parada por una actualización.' },
    { from: 'daniel', minutesAgo: 3 * 1440 + 60, text: 'Octubre fue nuestro mejor mes online hasta ahora. Gracias a todos 🙏' },
    { from: 'aiko', minutesAgo: 2 * 1440 + 200, text: 'Harbour Beans duplicó su próximo pedido ☕' },
  ],
  marketingBefore: [
    { from: 'sara', minutesAgo: 6 * 1440 + 30, text: 'Semanal: el brief del lanzamiento de Yuzu y Jengibre está en la carpeta del grupo. Leo, el primer borrador del banner para el miércoles, por favor.' },
    { from: 'leo', minutesAgo: 6 * 1440 + 20, text: 'Voy 👍' },
  ],
  shareNote: 'Nuevo banner de lanzamiento, cuadrado e historia para el lunes 👇',
  leoDm: '¡Bienvenida, Mina! Mis archivos de banner antiguos están en el proyecto de lanzamiento. Si algo no se entiende, escríbeme 🙂',
  bannerThread: '@Mina Lee Me encanta la ventana empañada. ¿Puedes mandarle el cuadrado a Omar para la página de la tienda también?',
  launchDay: {
    name: 'Día del lanzamiento',
    messages: [
      { from: 'omar', text: 'El lunes a las 7:00 subo el banner nuevo a la tienda.' },
      { from: 'sara', text: 'Perfecto. Los archivos finales de Mina están en el proyecto.' },
      { from: 'tom', text: 'Operaciones está lista para los pedidos 📦' },
    ],
  },

  pressRelease: {
    title: 'Nota de prensa, primer borrador',
    ask: 'Usa nuestra habilidad de nota de prensa para el lanzamiento de Yuzu y Jengibre',
    answer: [
      'Aquí tiene un primer borrador, siguiendo la habilidad del equipo **Borrador de nota de prensa**.',
      '',
      '**Steepling lanza Yuzu y Jengibre, un té de invierno para preparar en frío**',
      '',
      '*Yuzu brillante y un toque cálido de jengibre, listo en agua fría de un día para otro.*',
      '',
      'Steepling, la empresa de té para preparar en frío, lanza el [fecha de lanzamiento] su mezcla de invierno Yuzu y Jengibre. Una bolsita en una botella de agua fría y a las pocas horas está lista.',
      '',
      '"[cita]", dijo Daniel Okoye, CEO de Steepling.',
      '',
      'Yuzu y Jengibre cuesta $11,90 por 10 bolsitas en la tienda online de Steepling y en las cafeterías socias, con 20% de descuento las dos primeras semanas.',
      '',
      '**Sobre Steepling**: Steepling hace bolsitas de té para preparar en frío. Somos 10 personas y vendemos online y a cafeterías y oficinas.',
      '',
      '**Contacto**: [nombre, correo]',
      '',
      'Por comprobar: la cita del CEO y la fecha de lanzamiento.',
    ].join('\n'),
  },

  gmail: {
    welcome: {
      subject: '¡Bienvenida a Steepling!',
      body: 'Hola, Mina:\n\n¡Bienvenida a bordo! Tus cuentas ya están listas. En el proyecto de lanzamiento está todo lo del lunes, y a las 10 nos tomamos un café.\n\nSara',
    },
    specs: {
      subject: 'Medidas de los banners para el lanzamiento de Yuzu y Jengibre',
      body: 'Hola, Leo:\n\nPara el lanzamiento de Yuzu y Jengibre usaremos 1200×628 en la web y 1080×1080 en Instagram. Envíanos los finales antes del viernes y los programamos desde el lunes.\n\nUn saludo,\nChris\nFieldnote Studio',
    },
    replyBody: 'Hola, Mina:\n\n¡Bienvenida al equipo! {reply}\n\nChris\nFieldnote Studio',
    forwardNote: 'Para que lo tengas: las medidas de Chris para el lanzamiento. Ahora él es tu contacto.',
    forwarded: '---------- Mensaje reenviado ----------',
    forwardPrefix: 'Fwd: ',
    replyPrefix: 'Re: ',
  },

  drive: [
    { id: 'media-plan', name: 'Plan de medios de Fieldnote, lanzamiento de Yuzu y Jengibre', mimeType: 'application/vnd.google-apps.spreadsheet', folder: 'Fieldnote', minutesAgo: 9 * 1440, text: 'Canal,Tamaño,Inicio,Duración,Presupuesto\nBanner web,1200×628,Lanzamiento el lunes,2 semanas,$1200\nInstagram,1080×1080,Lanzamiento el lunes,2 semanas,$800\nHistoria de Instagram,1080×1920,Lanzamiento el lunes,1 semana,$400\n' },
    { id: 'photo-ideas', name: 'Ideas de fotos del lanzamiento', mimeType: 'application/vnd.google-apps.document', folder: '', minutesAgo: 4 * 1440, text: 'Ideas de fotos del lanzamiento\n\n- Ventana empañada, luz de la mañana\n- La bolsa verde junto a un vaso con hielo\n- Sin texto dentro de la foto\n' },
  ],

  skillTitles: {
    'brand-guide': 'Guía de marca',
    'social-posts': 'Posts para redes',
    'press-release': 'Borrador de nota de prensa',
    'competitor-roundup': 'Resumen de la competencia',
    handover: 'Ayuda de traspaso',
    'review-digest': 'Resumen de reseñas de clientes',
  },

  suggestions: [
    { label: 'Publicaciones de la próxima semana', prompt: 'Redacta los dos huecos vacíos del calendario de redes de la próxima semana' },
    { label: 'Resumir las reseñas', prompt: 'Resume las reseñas más recientes de los clientes' },
    { label: '¿Ha respondido Chris?', prompt: '¿Ha respondido Chris a mi correo? Mira en mi Gmail' },
    { label: 'Ver la carpeta de dirección', prompt: 'Muéstrame la carpeta de dirección' },
  ],
}
