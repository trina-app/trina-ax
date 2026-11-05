// Recommended skill packs (docs/DECISIONS.md "C. Onboarding: marketing skill pack and skill forms"). An owner or admin
// installs one in a click (the empty Team skills page, the wave-2 welcome wizard): plain skill files under
// skills/<pack>/<name>/SKILL.md in the team's language (English when the pack has none for it), and the folders that
// kind of team works in under shared/. The files are the team's own from then on: anyone who manages skills edits
// them like any other skill. Installing again only adds what is missing; it never replaces a file that is there.
import { z } from 'zod'
import { Locale } from './common'
import { endpoint } from './endpoint'

/** marketing: seven marketing skills and four team folders · general: every team's two skills (meeting notes → tasks,
 * a document's brief), no folders (docs/DECISIONS.md "M — One meeting note, everyone's own tasks") */
export const SKILL_PACK_IDS = ['marketing', 'general'] as const
export const SkillPackId = z.enum(SKILL_PACK_IDS)
export type SkillPackId = z.infer<typeof SkillPackId>

/** The general pack's skills, installed for every team by the welcome steps: "할 일 정리" (meeting notes → tasks per
 * person, or the asking person's own) and "핵심 정리" (a document's brief, or what the asking person needs to know). */
export const GENERAL_TASKS_SKILL = 'skills/general/meeting-tasks/SKILL.md'
export const GENERAL_BRIEF_SKILL = 'skills/general/doc-brief/SKILL.md'
/** "카드뉴스": the welcome steps' first result (docs/DECISIONS.md "N — The first result is the company's card news"):
 * five square cards from the company intro (an uploaded deck, or 회사 소개.md written from the website), the images the
 * website read collected and the brand colours. */
export const GENERAL_CARDNEWS_SKILL = 'skills/general/card-news/SKILL.md'
/** The artifact key the card news skill writes its cards under (both languages' SKILL.md name it): the web app opens
 * that artifact by itself when it is saved, as the cards are the whole answer (docs/DECISIONS.md "W2"). */
export const CARD_NEWS_ARTIFACT_KEY = 'card-news'

/** The meeting notes folder inside the team's own group folder (groups/<team>/회의록/), named in the team language. */
export const NOTES_FOLDER = { ko: '회의록', en: 'Meeting notes', id: 'Notulen rapat', ja: '議事録', es: 'Actas de reuniones' } as const satisfies Record<Locale, string>

/** Inside the team's own group folder: the brand folder (the company intro, 회사 소개.md) and its images folder (what
 * the website reading collected, and the photos made for the first card news): groups/<team>/브랜드/이미지/. */
export const BRAND_IMAGES_FOLDER = { ko: '이미지', en: 'Images', id: 'Gambar', ja: '画像', es: 'Imágenes' } as const satisfies Record<Locale, string>

/** The marketing pack's team folders under shared/, named in each language (installed in the team's language). The
 * Files screen tells what goes in each when it is empty (packFolderKind). */
export const PACK_FOLDERS = {
  brand: { ko: '브랜드', en: 'Brand', id: 'Merek', ja: 'ブランド', es: 'Marca' },
  campaigns: { ko: '캠페인', en: 'Campaigns', id: 'Kampanye', ja: 'キャンペーン', es: 'Campañas' },
  reports: { ko: '보고서', en: 'Reports', id: 'Laporan', ja: 'レポート', es: 'Informes' },
  competitors: { ko: '경쟁사', en: 'Competitors', id: 'Pesaing', ja: '競合', es: 'Competencia' },
} as const satisfies Record<string, Record<Locale, string>>
export type PackFolderKind = keyof typeof PACK_FOLDERS
export const PACK_FOLDER_KINDS = Object.keys(PACK_FOLDERS) as PackFolderKind[]

/** Which pack folder `shared/<name>` is (a name in any language, directly under shared/), or null. */
export function packFolderKind(path: string): PackFolderKind | null {
  const m = /^shared\/([^/]+)\/?$/.exec(path.normalize('NFC'))
  if (!m) return null
  return PACK_FOLDER_KINDS.find((k) => Object.values(PACK_FOLDERS[k]).some((n) => n.normalize('NFC') === m[1])) ?? null
}

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
  folders: z.array(z.object({ path: z.string(), status: z.enum(['created', 'present', 'blocked']) })),
})
export type SkillPackInstallResult = z.infer<typeof SkillPackInstallResult>

export const ONBOARDING_PACKS = {
  installSkillPack: endpoint({ method: 'POST', path: '/api/onboarding/packs/:id/install', auth: 'admin', owner: 'B', response: SkillPackInstallResult, summary: 'Install a recommended skill pack (id: marketing or general) as the caller: its skills under skills/<id>/ and its team folders under shared/, in the team language. Adds only what is missing; never replaces a file.' }),
} as const
