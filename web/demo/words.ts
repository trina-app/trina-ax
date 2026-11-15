// The demo's own few words around the story, in the app's languages. They live here, not in src/i18n: the product's
// locale files ship in the normal build, which must not change for the demo. The badge reuses the app's "demo.bar".
// English first; a missing language falls back to English.
import type { Locale } from '@mycel/shared/api'

const WORDS = {
  restart: { en: 'Start over', ko: '처음부터', ja: '最初から', es: 'Reiniciar', id: 'Mulai dari awal', zh: '重新开始' },
  guideLabel: { en: 'Demo guide', ko: '데모 안내', ja: 'デモの案内', es: 'Guía de la demo', id: 'Panduan demo', zh: '演示引导' },
  working: { en: 'Trina is working…', ko: '트리나가 작업 중이에요…', ja: 'トリナが作業中です…', es: 'Trina está trabajando…', id: 'Trina sedang bekerja…', zh: 'Trina 正在处理…' },
  waiting: { en: 'Something is on its way…', ko: '곧 소식이 와요…', ja: 'まもなく届きます…', es: 'Algo está en camino…', id: 'Sebentar lagi…', zh: '马上就来…' },
  openChat: { en: 'Open “{title}” →', ko: '“{title}” 열기 →', ja: '「{title}」を開く →', es: 'Abra «{title}» →', id: 'Buka “{title}” →', zh: '打开“{title}” →' },
  pressSend: { en: 'Press send →', ko: '보내기를 누르세요 →', ja: '送信を押してください →', es: 'Pulse enviar →', id: 'Tekan kirim →', zh: '点击发送 →' },
  card: { en: "Choose on Trina's card →", ko: '트리나의 카드에서 골라 주세요 →', ja: 'トリナのカードで選んでください →', es: 'Elija en la tarjeta de Trina →', id: 'Pilih di kartu Trina →', zh: '在 Trina 的卡片上选择 →' },
} satisfies Record<string, Partial<Record<Locale, string>> & { en: string }>

export const demoWord = (key: keyof typeof WORDS, locale: Locale): string => (WORDS[key] as Partial<Record<Locale, string>>)[locale] ?? WORDS[key].en
