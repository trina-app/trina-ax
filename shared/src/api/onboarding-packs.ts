// Recommended skill packs (docs/DECISIONS.md "C. Onboarding: marketing skill pack and skill forms", "DS3 — Only skills
// with a known origin ship; no auto-add"). The welcome steps install the general pack once; an owner or admin installs
// a pack in a click (the empty Team skills page): plain skill files under skills/<pack>/<name>/SKILL.md in the team's
// language (English when the pack has none for it). The files are the team's own from then on: anyone who manages
// skills edits them like any other skill. Installing again only adds what is missing; it never replaces a file that is
// there. Nothing adds a pack by itself.
import { z } from 'zod'
import { Locale } from './common'
import { endpoint } from './endpoint'

/** general: every team's three skills (the intro deck, the card news, the promo video), installed by the welcome steps ·
 * work: natural writing (humanizer). Only skills with a known origin ship (docs/DECISIONS.md "DS3"). */
export const SKILL_PACK_IDS = ['general', 'work'] as const
export const SkillPackId = z.enum(SKILL_PACK_IDS)
export type SkillPackId = z.infer<typeof SkillPackId>

/** The packs the empty Team skills page installs on its one admin button ("추천 스킬 넣기"), in this order. */
export const RECOMMENDED_SKILL_PACKS = ['general', 'work'] as const satisfies readonly SkillPackId[]
/** How many skills that button adds (the general pack's three and natural writing; a test holds it to the packs). */
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

export const ONBOARDING_PACKS = {
  installSkillPack: endpoint({ method: 'POST', path: '/api/onboarding/packs/:id/install', auth: 'admin', owner: 'B', response: SkillPackInstallResult, summary: 'Install a recommended skill pack (id: general or work) as the caller: its skills under skills/<id>/, in the team language. Adds only what is missing; never replaces a file.' }),
} as const
