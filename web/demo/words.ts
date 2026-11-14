// The demo's own few words around the story, in the app's languages. They live here, not in src/i18n: the product's
// locale files ship in the normal build, which must not change for the demo. The badge reuses the app's "demo.bar".
// English first; a missing language falls back to English.
import type { Locale } from '@mycel/shared/api'

const WORDS = {
  restart: { en: 'Start over', ko: '처음부터', ja: '最初から', es: 'Empezar de nuevo', id: 'Mulai dari awal' },
  guideLabel: { en: 'Demo guide', ko: '데모 안내', ja: 'デモの案内', es: 'Guía de la demo', id: 'Panduan demo' },
  working: { en: 'Trina is working…', ko: '트리나가 작업 중이에요…', ja: 'トリナが作業中です…', es: 'Trina está trabajando…', id: 'Trina sedang bekerja…' },
  waiting: { en: 'Something is on its way…', ko: '곧 소식이 와요…', ja: 'まもなく届きます…', es: 'Algo está en camino…', id: 'Sebentar lagi…' },
  card: { en: 'Choose on the card above →', ko: '위 카드에서 골라 주세요 →', ja: '上のカードで選んでください →', es: 'Elige en la tarjeta de arriba →', id: 'Pilih di kartu di atas →' },
} satisfies Record<string, Partial<Record<Locale, string>> & { en: string }>

export const demoWord = (key: keyof typeof WORDS, locale: Locale): string => (WORDS[key] as Partial<Record<Locale, string>>)[locale] ?? WORDS[key].en
