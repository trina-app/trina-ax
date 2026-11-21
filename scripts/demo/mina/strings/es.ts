// Every word of the demo story in Spanish (strings/en.ts, adapted, not word for word). Register: neutral Spanish that
// reads well in Spain and Latin America. Trina and the guide line say usted, as the app does (web/src/i18n/es.ts);
// colleagues say tú to each other, warm and relaxed, and so do the visitor's own prompts and the social captions;
// a properly formal email in `mail.formal`. People's names stay as in English; the product is "Yuzu y Jengibre".
// Pictures and team files are the `.es.` files in ../assets; banner words in ../source/banners/copy.es.json.
//
// Plain strings only. `{project}` in a text becomes a link to the campaign project; {time}, {subject}, {reply} are
// filled in by the story (../story.ts) or the engine.
import type { Strings } from './en'

export const es: Strings = {
  company: 'Steepling',

  people: {
    mina: { name: 'Mina Lee', title: 'Marketing · primer día' },
    sara: { name: 'Sara Jensen', title: 'Responsable de Marketing' },
    daniel: { name: 'Daniel Okoye', title: 'CEO' },
    leo: { name: 'Leo Santos', title: 'Marketing (se pasa a Ventas)' },
    tom: { name: 'Tom Becker', title: 'Responsable de Operaciones' },
    aiko: { name: 'Aiko Tanaka', title: 'Ventas' },
    omar: { name: 'Omar Haddad', title: 'Tienda online' },
    chris: { name: 'Chris Walker', title: 'Director de cuentas', org: 'Fieldnote' },
  },
  marketingGroup: 'Marketing',
  project: { name: 'Campaña de lanzamiento de Yuzu y Jengibre', description: 'Lanzamiento de Yuzu y Jengibre de invierno, el lunes' },

  brandSkill: 'brand-guide',

  paths: {
    companyIntro: 'shared/Presentación de la empresa.md',
    brief: 'Brief de lanzamiento de Yuzu y Jengibre.md',
    leoBanner: 'banner-lanzamiento-leo-v1.png',
    banner: 'banner-lanzamiento-nuevo.jpg',
    square: 'instagram-cuadrado.jpg',
    story: 'instagram-historia.jpg',
    captions: 'textos.md',
    photo: 'higgsfield-foto-yuzu-jengibre.jpg',
  },

  steps: {
    read: 'Leer',
    useSkill: 'Usar habilidad',
    save: 'Guardar',
    makeBanner: 'Crear banner',
    makeSquare: 'Crear post cuadrado de Instagram',
    makeStory: 'Crear historia de Instagram',
    writeCaptions: 'Escribir textos',
    higgsfieldHero: 'Generar foto · bolsa y Yuzu y Jengibre con hielo junto a una ventana empañada, luz de mañana, 16:9',
    higgsfieldCrops: 'Generar foto · misma escena, 1:1 y 9:16',
    gmailSearch: 'Buscar correo "Chris"',
    gmailSend: 'Enviar correo',
  },

  home: {
    title: '¡Bienvenida a bordo, Mina! Feliz primer día.',
    subtitle: 'Invitación de Sara · Aquí ya están 7 personas',
  },

  rooms: {
    everyone: [
      { from: 'daniel', text: 'Hoy Mina Lee se une a nuestro equipo de Marketing. ¡Todos a saludar! 🎉' },
      { from: 'tom', text: '¡Bienvenida, Mina! Para cualquier cosa de pedidos o envíos, escríbele a Operaciones.' },
      { from: 'aiko', text: 'Hola, Mina ☺️ ¿Un café esta semana?' },
      { from: 'omar', text: '¡Bienvenida! Avísame cuando haya que subir un banner a la tienda.' },
    ],
    marketing: [
      { from: 'leo', text: 'Ya está en el proyecto el primer borrador del banner de lanzamiento. Opiniones sinceras, por favor 😅' },
      { from: 'sara', text: 'Gracias, Leo, ahora le echo un vistazo.' },
    ],
  },

  leoChat: {
    title: 'Banner de lanzamiento, primer borrador',
    ask: 'Haz un banner de lanzamiento para la mezcla Yuzu y Jengibre. 20% de descuento las dos primeras semanas',
    answer: 'Aquí tienes un primer borrador del banner.',
  },

  answers: {
    company: {
      prompt: '¿A qué se dedica nuestra empresa?',
      text: [
        '**Steepling** hace bolsitas de té para preparar en frío. Una bolsita en agua fría y listo. Somos 12 y vendemos online y a cafeterías.',
        '',
        '**Su trabajo**: banners de lanzamiento y redes sociales, en el equipo de Marketing de Sara.',
        '',
        '**Esta semana**: Yuzu y Jengibre sale el **lunes**. El banner de lanzamiento es lo más urgente.',
        '',
        '**Habilidades del equipo**: su equipo comparte habilidades listas para usar, como *Guía de marca* y *3 opciones de post para redes*. Yo las uso por usted.',
      ].join('\n'),
      personLine: '{name}, {title}: {text}',
      peopleTitle: 'Personas clave',
      people: {
        sara: 'pregúntele lo que necesite.',
        leo: 'hizo el primer banner y ahora se lo pasa a usted.',
        daniel: 'da el visto bueno al lanzamiento.',
      },
    },
    banner: {
      prompt: 'Sigue nuestra guía de marca y crea un fondo nuevo con Higgsfield',
      text: [
        'Hecho con Higgsfield: nuestra bolsa verde y un Yuzu y Jengibre con hielo junto a una ventana empañada. El cuadrado y la historia salen de la misma escena, así que la bolsa se ve igual en todas partes.',
        '',
        'Como dice la Guía de marca: titular en Fraunces, el resto en Pretendard, y amarillo yuzu solo en la etiqueta del 20%.',
        '',
        'Textos:',
      ].join('\n'),
      after: 'El borrador de Leo sigue intacto.',
    },
    captions: [
      'Novedad de invierno: Yuzu y Jengibre 🍋 Deja una bolsita en agua fría antes de dormir y despierta con algo que te alegra la mañana. 20% de descuento durante las dos primeras semanas.',
      'yuzu + jengibre. y ya. ese es el post. (ok, también tiene un 20% de descuento esta semana)',
      'Confesión: en el equipo llevamos meses bebiéndolo a escondidas. Desde el lunes, es todo tuyo.',
    ],
    captionsTitle: 'Textos: lanzamiento de Yuzu y Jengibre',
    deliverables: {
      banner: 'Banner web · 1200×628',
      square: 'Post cuadrado de Instagram · 1080×1080',
      story: 'Historia de Instagram · 1080×1920',
      captions: '3 textos',
      photo: 'Foto de Higgsfield',
    },
    compare: { before: 'Antes: el borrador de Leo', after: 'Después' },
    otherSizes: 'El mismo estilo, en todos los tamaños:',
    sendTo: 'Enviar a #Marketing',
    mail: {
      prompt: 'Envíale el banner a Chris por correo',
      intro: 'Aquí tiene un borrador. Encontré la dirección de Chris en correos anteriores de su equipo.',
    },
  },

  mail: {
    to: 'Chris Walker (chris.walker@fieldnote.example)',
    labels: { to: 'Para', subject: 'Asunto', attachments: 'Adjuntos' },
    plain: {
      subject: 'Banner final para el lanzamiento del lunes',
      body: [
        'Hola, Chris:',
        '',
        'Soy Mina, acabo de entrar en Marketing en Steepling. A partir de ahora seré tu contacto para los banners.',
        '',
        'Te adjunto el banner final del lanzamiento (1200×628) y el post cuadrado de Instagram. Daniel ya les dio el visto bueno. ¿Puedes publicarlos a partir del lunes?',
        '',
        '¡Gracias!',
        'Mina',
      ],
    },
    formal: {
      subject: 'Campaña de lanzamiento de Steepling: archivos finales del banner',
      body: [
        'Estimado Chris:',
        '',
        'Espero que se encuentre bien. Mi nombre es Mina Lee y acabo de incorporarme al equipo de Marketing de Steepling.',
        '',
        'Le adjunto el banner final de la campaña de lanzamiento (1200×628) y la versión cuadrada para Instagram. Ambos cuentan con la aprobación de nuestro CEO. ¿Sería tan amable de publicarlos a partir del lunes, día del lanzamiento?',
        '',
        'Muchas gracias. Será un placer trabajar con usted.',
        '',
        'Un cordial saludo,',
        'Mina Lee',
        'Marketing, Steepling',
      ],
    },
    confirm: '¿Enviar este correo con Gmail?',
    send: 'Enviar',
    makeFormal: 'Hacerlo más formal',
    sendShort: 'Enviar el más corto',
    formalIntro: 'Versión más formal:',
    sent: 'Enviado a Chris: "{subject}", con el banner y el post cuadrado adjuntos.',
  },

  events: {
    leadDm: 'Al banner de Leo para el lanzamiento del lunes le falta cariño. Tú tienes buen ojo para el diseño: ¿te animas a darle un repaso? Tienes todo en el proyecto.\n\n{project}',
    leadDmToast: '¿Tienes un momento? 🙏',
    ceoShip: '🔥 Esto es. Adelante.',
    leoHow: 'espera, ¿cómo lo hiciste tan rápido? 😂',
    leadGmail: 'Mina, Gmail ya está conectado. Pídele a Trina que se lo envíe a Chris, de Fieldnote, nuestra agencia.',
    chrisReply: '¡Queda genial! Lo publicamos el lunes.',
    chrisRelayed: 'Chris acaba de responder a tu correo: "{reply}" 🎉 Gran primer día, Mina.',
    ceoShoutout: 'Un aplauso para @Mina Lee: primer día y la campaña de lanzamiento del lunes ya está lista 🎉',
    saraWelcome: 'Bienvenida al equipo, Mina 💛',
  },

  guide: {
    ask: { text: 'Pregúntele a Trina por la empresa →', away: 'Su primera pregunta está en Inicio →' },
    dm: { text: 'Sara le envió un mensaje →', away: 'Sara le espera en sus mensajes directos →' },
    project: { text: 'Abra el proyecto del mensaje de Sara →', away: 'Sara le espera en sus mensajes directos →' },
    banner: { text: 'Pídale a Trina que lo rehaga con Higgsfield →', away: 'El banner de Leo le espera en el proyecto →' },
    share: { text: 'Envíelo a #Marketing →', away: 'Su banner nuevo está listo para compartir →' },
    room: { text: 'Abra #Marketing: el equipo está reaccionando →', away: 'Abra #Marketing: el equipo está reaccionando →' },
    mail: { text: 'Pídale a ✦ Trina que le escriba a Chris →', away: 'Chris todavía necesita el banner →' },
    everyone: { text: 'Vea lo que publicó Daniel en #Todos →', away: 'Vea lo que publicó Daniel en #Todos →' },
  },

  fallback: { text: 'Esta demo sigue las preguntas sugeridas. Pruebe con esta:', question: 'Siguiente paso' },

  end: {
    title: 'El primer día de Mina: campaña de lanzamiento lista en {time}',
    body: 'De "¿a qué nos dedicamos?" a un banner de lanzamiento aprobado por el CEO y publicado por la agencia. En su primer día.',
    stats: {
      time: 'Tiempo',
      filesRead: 'Archivos leídos',
      deliverables: 'Entregables',
      approvals: 'Aprobación del CEO',
      emails: 'Correo enviado',
    },
    usually: 'normalmente ~2 días',
    signup: 'Ver planes',
    explore: 'Echar un vistazo',
    tryLive: 'Ahora pruébelo usted mismo',
    liveBusy: 'La demo en vivo está llena en este momento',
    liveRetry: 'Reintentar',
    popupTitle: 'Así fue el primer día de Mina 🎉',
    popupLine: 'Campaña de lanzamiento lista en {time}. Normalmente lleva unos 2 días.',
    recap: ['Leyó 2 archivos del equipo', 'Usó la habilidad Guía de marca', 'Creó 4 piezas con Higgsfield', 'Aprobación del CEO', 'Correo a la agencia'],
  },
}
