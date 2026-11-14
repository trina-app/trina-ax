// The demo's own two words around the story, in the app's languages. They live here, not in src/i18n: the product's
// locale files ship in the normal build, which must not change for the demo. The badge reuses the app's "demo.bar".
// English first; a missing language falls back to English.
import type { Locale } from '@mycel/shared/api'

const WORDS = {
  restart: { en: 'Start over', ko: '처음부터', ja: '最初から', es: 'Empezar de nuevo', id: 'Mulai dari awal' },
  guideLabel: { en: 'Demo guide', ko: '데모 안내', ja: 'デモの案内', es: 'Guía de la demo', id: 'Panduan demo' },
} satisfies Record<string, Partial<Record<Locale, string>> & { en: string }>

export const demoWord = (key: keyof typeof WORDS, locale: Locale): string => (WORDS[key] as Partial<Record<Locale, string>>)[locale] ?? WORDS[key].en
