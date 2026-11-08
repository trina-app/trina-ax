// Recommended skill packs (docs/DECISIONS.md "C. Onboarding: marketing skill pack and skill forms", "DS3 — Only skills
// with a known origin ship; no auto-add", "W6 — Onboarding v6: skills catalog and 내 스킬"): the kept skills, chosen by
// name. The owner's 내 스킬 step and the Team skills page's catalog ("트리나가 준비한 스킬 · N개 더", owners and admins)
// read GET /api/onboarding/packs and install what was checked (POST /api/onboarding/packs/:id/install with `skills`):
// plain skill files under skills/<pack>/<name>/SKILL.md in the team's language (English when the pack has none for it).
// The files are the team's own from then on: anyone who manages skills edits them like any other skill. Installing again
// only adds what is missing; it never replaces a file that is there. Nothing adds a pack by itself, and a skill shipped
// later only raises the catalog's count (no notice, dot or prompt).
import { z } from 'zod'
import { Locale } from './common'
import { endpoint } from './endpoint'

/** general: every team's three skills (the intro deck, the card news, the promo video), installed by the welcome steps ·
 * work: natural writing (humanizer). Only skills with a known origin ship (docs/DECISIONS.md "DS3"). */
export const SKILL_PACK_IDS = ['general', 'work'] as const
export const SkillPackId = z.enum(SKILL_PACK_IDS)
export type SkillPackId = z.infer<typeof SkillPackId>

/** The packs whose skills the catalog offers, in this order (each pack's own order inside: server/src/onboarding/
 * skill-packs.ts CATALOG). */
export const RECOMMENDED_SKILL_PACKS = ['general', 'work'] as const satisfies readonly SkillPackId[]
/** How many skills the catalog holds today (the general pack's three and natural writing; a test holds it to the packs). */
export const RECOMMENDED_PACK_SKILLS = 4

/** "카드뉴스": the welcome steps' first result from docs/DECISIONS.md "N" until the promo video ("V"); no longer the
 * first result, still installed for every team: five square cards from the company intro (an uploaded deck, or
 * 회사 소개.md written from the website), the images the website read collected and the brand colours. */
export const GENERAL_CARDNEWS_SKILL = 'skills/general/card-news/SKILL.md'
/** The artifact key the card news skill writes its cards under (both languages' SKILL.md name it): the web app opens
 * that artifact by itself when it is saved, as the cards are the whole answer (docs/DECISIONS.md "W2"). */
export const CARD_NEWS_ARTIFACT_KEY = 'card-news'
/** "홍보 영상": the welcome steps' first result of docs/DECISIONS.md "V" until the intro deck ("D2"); no longer the first
 * result, still installed for every team: the company's promo video, its slots filled by the AI with the promo_video
 * tool from the company intro and the brand images folder. Its artifact (PROMO_ARTIFACT_KEY, promo-video.ts) opens
 * beside the chat by itself like the cards. */
export const GENERAL_PROMO_SKILL = 'skills/general/promo-video/SKILL.md'
/** "회사 소개서": the welcome steps' first result (docs/DECISIONS.md "D2 — The first result is the company's intro
 * deck"): the company's intro deck, 6–10 slides whose slots the AI fills with the intro_deck tool from the company
 * intro and the brand images folder. Its artifact (DECK_ARTIFACT_KEY, intro-deck.ts) opens beside the chat by itself
 * like the video; the deck downloads as PowerPoint and PDF. */
export const GENERAL_DECK_SKILL = 'skills/general/intro-deck/SKILL.md'

/** The meeting notes folder inside the team's own group folder (groups/<team>/회의록/), named in the team language. */
export const NOTES_FOLDER = { ko: '회의록', en: 'Meeting notes', id: 'Notulen rapat', ja: '議事録', es: 'Actas de reuniones' } as const satisfies Record<Locale, string>

/** Inside the team's own group folder: the brand folder (the company intro, 회사 소개.md), named in each language
 * (made in the team's language): groups/<team>/브랜드/. */
export const BRAND_FOLDER = { ko: '브랜드', en: 'Brand', id: 'Merek', ja: 'ブランド', es: 'Marca' } as const satisfies Record<Locale, string>

/** Inside the brand folder: its images folder (what the website reading collected, and the photos made for the first
 * card news): groups/<team>/브랜드/이미지/. */
export const BRAND_IMAGES_FOLDER = { ko: '이미지', en: 'Images', id: 'Gambar', ja: '画像', es: 'Imágenes' } as const satisfies Record<Locale, string>

/** created: written now · present: already there with the pack's own text · kept: there with other text (someone
 * edited it, or another file has the name): left as it is · blocked: could not be written here (folder rules, a
 * plugin's folder, a name that clashes with another file's) */
export const PackItemStatus = z.enum(['created', 'present', 'kept', 'blocked'])
export type PackItemStatus = z.infer<typeof PackItemStatus>

export const SkillPackInstallResult = z.object({
  pack: SkillPackId,
  /** the language of the skill text that was used (the team's language, or English) */
  locale: Locale,
  skills: z.array(z.object({
    name: z.string(), path: z.string(), status: PackItemStatus,
    /** blocked because another team skill the caller can read already has this name ("/<name>" would run either one):
     * its path */
    sameNameAs: z.string().optional(),
  })),
})
export type SkillPackInstallResult = z.infer<typeof SkillPackInstallResult>

/** `skills`: only these skills of the pack (each by its name, as the catalog lists it); absent: the whole pack. */
export const InstallSkillPack = z.object({ skills: z.array(z.string().min(1).max(64)).min(1).max(20).optional() }).strict()
export type InstallSkillPack = z.infer<typeof InstallSkillPack>

/** Where a kept skill comes from, as its source line says it (docs/DECISIONS.md "DS3": only skills with a known origin
 * ship): `team` written by the company ("트리나 팀이 만들었어요"); `team_writing` the company's own Korean writing skill
 * ("트리나 팀이 쓰던 한국어 글쓰기 스킬을 바탕으로 만들었어요"); `adapted` an open-source skill the company rewrote, with its
 * author, project, licence and the one link out ("원본 보기 ↗"). */
export const PackSkillSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('team') }),
  z.object({ kind: z.literal('team_writing') }),
  z.object({ kind: z.literal('adapted'), author: z.string(), project: z.string(), license: z.string(), url: z.string().url() }),
])
export type PackSkillSource = z.infer<typeof PackSkillSource>

/** Size limits of the examples (EXAMPLES-PLAN, FLOW-v6 §8; a test holds the files to them): an image of at most 90 KB,
 * a text excerpt of at most 900 characters in Korean and 1,200 in English. */
export const PACK_EXAMPLE_LIMITS = { imageBytes: 90 * 1024, textChars: { ko: 900, en: 1200 } } as const

/** One example of a kept skill, made on the fictional company 예시커피 / Example Coffee (EXAMPLES-PLAN): an image the
 * web build serves (web/public/skill-examples/<locale>/<name>.webp, loaded only when the viewer opens) for a result that
 * is a picture anyway, or a short before → after text the page draws in its own theme (Markdown, its front matter left
 * out). */
export const PackExample = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), url: z.string() }),
  z.object({ kind: z.literal('text'), markdown: z.string() }),
])
export type PackExample = z.infer<typeof PackExample>

/** A kept skill as the catalog lists it. */
export const PackCatalogSkill = z.object({
  pack: SkillPackId,
  /** its skill name ("intro-deck"): what the install's `skills` names, and what "/<name>" runs */
  name: z.string(),
  /** where it goes (skills/<pack>/<name>/SKILL.md) */
  path: z.string(),
  /** its title as the team will read it (the SKILL.md's, in the language of the text the team gets) */
  title: z.string(),
  /** one line in the caller's language: what it makes */
  description: z.string(),
  /** the team has it: this path, or another team skill of the same name ("/<name>" would run either one) */
  inTeam: z.boolean(),
  /** made from the company profile (the intro deck, the card news, the promo video): checked on 내 스킬 when a profile
   * is saved, and the brand action runs before it goes in */
  visual: z.boolean(),
  /** null: none yet (the viewer says it is being made) */
  example: PackExample.nullable(),
  /** the language of its text and example (the team's, or English) */
  locale: Locale,
  source: PackSkillSource,
})
export type PackCatalogSkill = z.infer<typeof PackCatalogSkill>

export const PackCatalog = z.object({
  /** every kept skill in the catalog's order, the team's own ones too (`inTeam`) */
  skills: z.array(PackCatalogSkill),
  /** a company profile is saved (skills/company-profile.json is there for the caller) */
  profile: z.boolean(),
})
export type PackCatalog = z.infer<typeof PackCatalog>

export const ONBOARDING_PACKS = {
  listSkillPacks: endpoint({ method: 'GET', path: '/api/onboarding/packs', auth: 'admin', owner: 'B', response: PackCatalog, summary: 'The kept skills an owner or admin can put in the team (내 스킬, the Team skills catalog): each with its title, one line, whether the team has it (by path or skill name), its example and its source.' }),
  installSkillPack: endpoint({ method: 'POST', path: '/api/onboarding/packs/:id/install', auth: 'admin', owner: 'B', body: InstallSkillPack, response: SkillPackInstallResult, summary: 'Install the skills of a recommended pack (id: general or work) the caller named (`skills`; absent: the whole pack), as the caller: under skills/<id>/, in the team language. Adds only what is missing; never replaces a file.' }),
} as const
