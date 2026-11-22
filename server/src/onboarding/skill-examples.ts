// The examples of the kept skills (EXAMPLES-PLAN.md; docs/DECISIONS.md "W6"), one per skill in Korean and in English,
// made by the skills themselves on the fictional company 예시커피 / Example Coffee (its inputs, all invented:
// examples/data/example-coffee/). The catalog (skill-packs.ts skillPackCatalog) sends them; the mock server of the web
// tests imports this module as it is, so it keeps no server imports.
// - an image: `web/public/skill-examples/<locale>/<name>.webp` in the web build (WebP, at most
//   PACK_EXAMPLE_LIMITS.imageBytes, loaded only when the viewer opens), for a result that is a picture anyway (the deck,
//   the cards, the video's frames);
// - a text: `resources/skill-packs/<pack>/<locale>/<name>/EXAMPLE.md`, imported as text like the SKILL.md (front matter
//   `fictional: true`, `company`, `made`, `engine`, `skillHash`, then the before → after excerpt in Markdown, at most
//   PACK_EXAMPLE_LIMITS.textChars). It is never installed into a team: only SKILL.md is.
// Each records `skillHash`, the first 12 hex digits of the sha256 of the SKILL.md it was made from: a SKILL.md that
// changes fails tests/unit/b-skill-catalog.test.ts until its example is made again in the same PR
// (examples/data/example-coffee/README.md says how). Teams in other languages see the English one (their text is English).
/// <reference path="./markdown.d.ts" />
// (the reference: the web tests' type check reads this file without the server's other files)
import type { Locale, PackExample } from '@mycel/shared/api'
import koHumanizerExample from '../../../resources/skill-packs/work/ko/humanizer/EXAMPLE.md' with { type: 'text' }
import enHumanizerExample from '../../../resources/skill-packs/work/en/humanizer/EXAMPLE.md' with { type: 'text' }

export type RegisteredExample = { kind: 'image'; skillHash: string } | { kind: 'text'; text: string }

/** The examples by the language of the skill text and the skill name. */
export const PACK_EXAMPLES: Record<'ko' | 'en', Partial<Record<string, RegisteredExample>>> = {
  ko: {
    'intro-deck': { kind: 'image', skillHash: 'bdb11396144f' },
    'card-news': { kind: 'image', skillHash: '65f4638c14b7' },
    'promo-video': { kind: 'image', skillHash: 'b5561aed57bc' },
    humanizer: { kind: 'text', text: koHumanizerExample },
  },
  en: {
    'intro-deck': { kind: 'image', skillHash: '2b8cf1b31e35' },
    'card-news': { kind: 'image', skillHash: 'fd16b67cef75' },
    'promo-video': { kind: 'image', skillHash: 'd63330fdbb71' },
    humanizer: { kind: 'text', text: enHumanizerExample },
  },
}

/** Pictures made in every app language, not only Korean and English: the team's language picks the picture
 * (`web/public/skill-examples/<locale>/<name>.webp`), so a Japanese team sees a Japanese deck. The intro deck since
 * 2026-11-22, made on 숲틈 / Soopteum (examples/data/soopteum/<locale>/). */
export const EXAMPLE_LOCALES: Partial<Record<string, readonly Locale[]>> = { 'intro-deck': ['ko', 'en', 'ja', 'zh', 'es', 'id'] }
/** The invented company of a skill's example when it is not 예시커피 / Example Coffee, by the picture's language. */
export const EXAMPLE_COMPANY_OF: Partial<Record<string, Partial<Record<Locale, string>>>> = {
  'intro-deck': { ko: '숲틈', en: 'Soopteum', ja: 'Soopteum', zh: 'Soopteum', es: 'Soopteum', id: 'Soopteum' },
}

/** An EXAMPLE.md without its front matter. */
export const exampleBody = (text: string): string => text.replace(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '').trim()

/** The example a team whose skill text is in `locale` sees (null: none yet, the viewer says it is being made). `team`:
 * the team's own language, which picks the picture of a skill made in every language (EXAMPLE_LOCALES). */
export function packExample(locale: Locale, name: string, team?: Locale): PackExample | null {
  const at = locale === 'ko' ? 'ko' : 'en'
  const e = PACK_EXAMPLES[at][name]
  if (!e) return null
  if (e.kind === 'text') return { kind: 'text', markdown: exampleBody(e.text) }
  const pic = team && EXAMPLE_LOCALES[name]?.includes(team) ? team : at
  const company = EXAMPLE_COMPANY_OF[name]?.[pic]
  return { kind: 'image', url: `/skill-examples/${pic}/${name}.webp`, ...(company ? { company } : {}) }
}
