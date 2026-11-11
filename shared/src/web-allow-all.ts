// "Allow all websites" for the AI's web reads (docs/DECISIONS.md "Allow all websites covers the AI's web reads"): the
// one risk sentence every place that turns it on shows (the server's address card, Settings › Browser, the desktop
// app's own window), versioned as one text. The version is stored with the person's switch: a new sentence is a new
// version, and everyone's switch reads as off until they accept the new one.

/** The version of WEB_ALLOW_ALL_RISK a person accepts to turn it on. Change the sentence, raise this. */
export const WEB_ALLOW_ALL_WARNING_VERSION = 1

/** The risk, in the app's five languages (English first). */
export const WEB_ALLOW_ALL_RISK = {
  en: 'A hidden instruction in a document, page or room message can make the AI send anything it can read to any site.',
  ko: '문서, 웹 페이지, 대화방 메시지에 숨겨진 지시 하나로 AI가 읽을 수 있는 내용을 어떤 사이트로든 보낼 수 있어요.',
  id: 'Instruksi tersembunyi di dokumen, halaman, atau pesan ruang obrolan dapat membuat AI mengirim apa pun yang bisa dibacanya ke situs mana pun.',
  ja: '文書・ページ・トークルームのメッセージに隠された指示によって、AIが読める内容をどのサイトにでも送らせることができます。',
  es: 'Una instrucción oculta en un documento, una página o un mensaje de una sala puede hacer que la IA envíe cualquier cosa que pueda leer a cualquier sitio.',
} as const satisfies Record<'en' | 'ko' | 'id' | 'ja' | 'es', string>

/** The value of the address card's "Allow all websites (turn off in Settings)" answer (server/src/tools/url-gate.ts). */
export const ALL_SITES_ANSWER = 'all_sites'
