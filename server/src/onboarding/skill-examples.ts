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
// (examples/data/example-coffee/README.md says how). The everyday office skills have one in each of the six app
// languages, on a fictional local company; for the other skills, teams in other languages see the English one.
/// <reference path="./markdown.d.ts" />
// (the reference: the web tests' type check reads this file without the server's other files)
import type { Locale, PackExample } from '@mycel/shared/api'
import koHumanizerExample from '../../../resources/skill-packs/work/ko/humanizer/EXAMPLE.md' with { type: 'text' }
import enHumanizerExample from '../../../resources/skill-packs/work/en/humanizer/EXAMPLE.md' with { type: 'text' }
import koMeetingNotesExample from '../../../resources/skill-packs/work/ko/meeting-notes/EXAMPLE.md' with { type: 'text' }
import enMeetingNotesExample from '../../../resources/skill-packs/work/en/meeting-notes/EXAMPLE.md' with { type: 'text' }
import koTeamReportExample from '../../../resources/skill-packs/work/ko/team-report/EXAMPLE.md' with { type: 'text' }
import enTeamReportExample from '../../../resources/skill-packs/work/en/team-report/EXAMPLE.md' with { type: 'text' }
import koCustomerReplyExample from '../../../resources/skill-packs/work/ko/customer-reply/EXAMPLE.md' with { type: 'text' }
import enCustomerReplyExample from '../../../resources/skill-packs/work/en/customer-reply/EXAMPLE.md' with { type: 'text' }
import koContractReviewExample from '../../../resources/skill-packs/work/ko/contract-review/EXAMPLE.md' with { type: 'text' }
import enContractReviewExample from '../../../resources/skill-packs/work/en/contract-review/EXAMPLE.md' with { type: 'text' }
import jaMeetingNotesExample from '../../../resources/skill-packs/work/ja/meeting-notes/EXAMPLE.md' with { type: 'text' }
import jaTeamReportExample from '../../../resources/skill-packs/work/ja/team-report/EXAMPLE.md' with { type: 'text' }
import jaCustomerReplyExample from '../../../resources/skill-packs/work/ja/customer-reply/EXAMPLE.md' with { type: 'text' }
import jaContractReviewExample from '../../../resources/skill-packs/work/ja/contract-review/EXAMPLE.md' with { type: 'text' }
import zhMeetingNotesExample from '../../../resources/skill-packs/work/zh/meeting-notes/EXAMPLE.md' with { type: 'text' }
import zhTeamReportExample from '../../../resources/skill-packs/work/zh/team-report/EXAMPLE.md' with { type: 'text' }
import zhCustomerReplyExample from '../../../resources/skill-packs/work/zh/customer-reply/EXAMPLE.md' with { type: 'text' }
import zhContractReviewExample from '../../../resources/skill-packs/work/zh/contract-review/EXAMPLE.md' with { type: 'text' }
import esMeetingNotesExample from '../../../resources/skill-packs/work/es/meeting-notes/EXAMPLE.md' with { type: 'text' }
import esTeamReportExample from '../../../resources/skill-packs/work/es/team-report/EXAMPLE.md' with { type: 'text' }
import esCustomerReplyExample from '../../../resources/skill-packs/work/es/customer-reply/EXAMPLE.md' with { type: 'text' }
import esContractReviewExample from '../../../resources/skill-packs/work/es/contract-review/EXAMPLE.md' with { type: 'text' }
import idMeetingNotesExample from '../../../resources/skill-packs/work/id/meeting-notes/EXAMPLE.md' with { type: 'text' }
import idTeamReportExample from '../../../resources/skill-packs/work/id/team-report/EXAMPLE.md' with { type: 'text' }
import idCustomerReplyExample from '../../../resources/skill-packs/work/id/customer-reply/EXAMPLE.md' with { type: 'text' }
import idContractReviewExample from '../../../resources/skill-packs/work/id/contract-review/EXAMPLE.md' with { type: 'text' }

export type RegisteredExample = { kind: 'image'; skillHash: string } | { kind: 'text'; text: string }

/** The everyday office skills' examples in the other app languages, on a fictional local roaster each (spread below,
 * so the table is not read as one that needs every skill in every language: scripts/check-i18n.ts). */
const EVERYDAY_OTHER_EXAMPLES = {
  ja: {
    'meeting-notes': { kind: 'text', text: jaMeetingNotesExample },
    'team-report': { kind: 'text', text: jaTeamReportExample },
    'customer-reply': { kind: 'text', text: jaCustomerReplyExample },
    'contract-review': { kind: 'text', text: jaContractReviewExample },
  },
  zh: {
    'meeting-notes': { kind: 'text', text: zhMeetingNotesExample },
    'team-report': { kind: 'text', text: zhTeamReportExample },
    'customer-reply': { kind: 'text', text: zhCustomerReplyExample },
    'contract-review': { kind: 'text', text: zhContractReviewExample },
  },
  es: {
    'meeting-notes': { kind: 'text', text: esMeetingNotesExample },
    'team-report': { kind: 'text', text: esTeamReportExample },
    'customer-reply': { kind: 'text', text: esCustomerReplyExample },
    'contract-review': { kind: 'text', text: esContractReviewExample },
  },
  id: {
    'meeting-notes': { kind: 'text', text: idMeetingNotesExample },
    'team-report': { kind: 'text', text: idTeamReportExample },
    'customer-reply': { kind: 'text', text: idCustomerReplyExample },
    'contract-review': { kind: 'text', text: idContractReviewExample },
  },
} satisfies Partial<Record<Locale, Partial<Record<string, RegisteredExample>>>>

/** The examples by the language of the skill text and the skill name. */
export const PACK_EXAMPLES: Record<Locale, Partial<Record<string, RegisteredExample>>> = {
  ko: {
    'intro-deck': { kind: 'image', skillHash: 'bdb11396144f' },
    'card-news': { kind: 'image', skillHash: '65f4638c14b7' },
    'promo-video': { kind: 'image', skillHash: 'b5561aed57bc' },
    humanizer: { kind: 'text', text: koHumanizerExample },
    'meeting-notes': { kind: 'text', text: koMeetingNotesExample },
    'team-report': { kind: 'text', text: koTeamReportExample },
    'customer-reply': { kind: 'text', text: koCustomerReplyExample },
    'contract-review': { kind: 'text', text: koContractReviewExample },
  },
  en: {
    'intro-deck': { kind: 'image', skillHash: '2b8cf1b31e35' },
    'card-news': { kind: 'image', skillHash: 'fd16b67cef75' },
    'promo-video': { kind: 'image', skillHash: 'd63330fdbb71' },
    humanizer: { kind: 'text', text: enHumanizerExample },
    'meeting-notes': { kind: 'text', text: enMeetingNotesExample },
    'team-report': { kind: 'text', text: enTeamReportExample },
    'customer-reply': { kind: 'text', text: enCustomerReplyExample },
    'contract-review': { kind: 'text', text: enContractReviewExample },
  },
  ...EVERYDAY_OTHER_EXAMPLES,
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

/** The example a team whose skill text is in `locale` sees (null: none yet, the viewer says it is being made): that
 * language's when the skill has one in it (the everyday office skills: all six), else Korean or English. `team`: the
 * team's own language, which picks the picture of a skill made in every language (EXAMPLE_LOCALES). */
export function packExample(locale: Locale, name: string, team?: Locale): PackExample | null {
  const at: Locale = PACK_EXAMPLES[locale]?.[name] ? locale : locale === 'ko' ? 'ko' : 'en'
  const e = PACK_EXAMPLES[at][name]
  if (!e) return null
  if (e.kind === 'text') return { kind: 'text', markdown: exampleBody(e.text) }
  const pic = team && EXAMPLE_LOCALES[name]?.includes(team) ? team : at
  const company = EXAMPLE_COMPANY_OF[name]?.[pic]
  return { kind: 'image', url: `/skill-examples/${pic}/${name}.webp`, ...(company ? { company } : {}) }
}

/** The example `viewer` sees (an app language that is not the team's: a Korean account on an English team): the one in
 * the viewer's own language when the skill has one (an EXAMPLE.md, a picture made in it), marked with its `locale` when
 * that is not the skill text's (`textLocale`), so the line under it names that example's company; else the team's
 * (packExample, as before). The installed skill text never changes. */
export function viewerExample(viewer: Locale, name: string, textLocale: Locale, team?: Locale): PackExample | null {
  const own = PACK_EXAMPLES[viewer]?.[name] || EXAMPLE_LOCALES[name]?.includes(viewer)
  if (!own) return packExample(textLocale, name, team)
  const e = packExample(viewer, name, viewer)
  return e && viewer !== textLocale ? { ...e, locale: viewer } : e
}

/** Rows that carry a kept skill's example and its text language (the catalog's, Home's "팀에 준비된 것"): each example
 * picked for `viewer` (viewerExample); a row without an example or a language stays as it is. */
export function inViewerLanguage<T extends { name: string; example?: PackExample | null; locale?: Locale }>(rows: readonly T[], viewer: Locale, team: Locale): T[] {
  return rows.map((r) => {
    if (!r.example || !r.locale) return r
    try {
      const e = viewerExample(viewer, r.name, r.locale, team)
      return e ? { ...r, example: e } : r
    } catch { return r }
  })
}
