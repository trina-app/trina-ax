// The server's words of "Ask for access" on a chat's or project's link (chat/access-requests.ts), in every language.
import type { Locale } from '@mycel/shared/api'

export const ACCESS_REQUEST_TEXT: Record<'requestOff' | 'tooMany' | 'notSharer', Record<Locale, string>> = {
  requestOff: {
    en: 'You can\'t ask for access here. Ask the person who sent the link.',
    ko: '여기서는 액세스를 요청할 수 없어요. 링크를 보낸 사람에게 물어보세요.',
    id: 'Anda tidak bisa meminta akses di sini. Tanyakan kepada pengirim tautan.',
    ja: 'ここではアクセスをリクエストできません。リンクを送った人に聞いてください。',
    es: 'Aquí no puede pedir acceso. Pregunte a quien le envió el enlace.',
    zh: '这里无法请求访问。请询问发送链接的人。',
  },
  tooMany: {
    en: 'You\'ve asked for access many times. Try again later.',
    ko: '액세스를 너무 많이 요청했어요. 나중에 다시 해 주세요.',
    id: 'Anda sudah terlalu sering meminta akses. Coba lagi nanti.',
    ja: 'アクセスのリクエストが多すぎます。後でもう一度お試しください。',
    es: 'Ha pedido acceso muchas veces. Inténtelo más tarde.',
    zh: '你请求访问的次数太多了。请稍后再试。',
  },
  notSharer: {
    en: 'Only someone who can share it can answer this request.',
    ko: '공유할 수 있는 사람만 이 요청에 답할 수 있어요.',
    id: 'Hanya orang yang bisa membagikannya yang bisa menjawab permintaan ini.',
    ja: '共有できる人だけがこのリクエストに答えられます。',
    es: 'Solo quien puede compartirlo puede responder a esta solicitud.',
    zh: '只有能共享它的人可以回复这个请求。',
  },
}
