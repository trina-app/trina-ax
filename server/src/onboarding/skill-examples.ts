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
    'intro-deck': { kind: 'image', skillHash: '4662c49799a8' },
    'card-news': { kind: 'image', skillHash: '770cfeb3af9b' },
    'promo-video': { kind: 'image', skillHash: 'ce31de7f81c7' },
    humanizer: { kind: 'text', text: koHumanizerExample },
  },
  en: {
    'intro-deck': { kind: 'image', skillHash: 'ebe3af93e19e' },
    'card-news': { kind: 'image', skillHash: '6d167c88a374' },
    'promo-video': { kind: 'image', skillHash: 'ca6b242b7734' },
    humanizer: { kind: 'text', text: enHumanizerExample },
  },
}

/** An EXAMPLE.md without its front matter. */
export const exampleBody = (text: string): string => text.replace(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '').trim()

/** The example a team whose skill text is in `locale` sees (null: none yet, the viewer says it is being made). */
export function packExample(locale: Locale, name: string): PackExample | null {
  const at = locale === 'ko' ? 'ko' : 'en'
  const e = PACK_EXAMPLES[at][name]
  if (!e) return null
  return e.kind === 'image' ? { kind: 'image', url: `/skill-examples/${at}/${name}.webp` } : { kind: 'text', markdown: exampleBody(e.text) }
}
