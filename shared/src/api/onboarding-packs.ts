// Recommended skill packs (docs/DECISIONS.md "C. Onboarding: marketing skill pack and skill forms"). An owner or admin
// installs one in a click (the empty Team skills page, the wave-2 welcome wizard): plain skill files under
// skills/<pack>/<name>/SKILL.md in the team's language (English when the pack has none for it), and the folders that
// kind of team works in under shared/. The files are the team's own from then on: anyone who manages skills edits
// them like any other skill. Installing again only adds what is missing; it never replaces a file that is there.
import { z } from 'zod'
import { Locale } from './common'
import { endpoint } from './endpoint'

export const SKILL_PACK_IDS = ['marketing'] as const
export const SkillPackId = z.enum(SKILL_PACK_IDS)
export type SkillPackId = z.infer<typeof SkillPackId>

/** created: written now · present: already there with the pack's own text · kept: there with other text (someone
 * edited it, or another file has the name): left as it is · blocked: could not be written here (folder rules, a
 * plugin's folder, a name that clashes with another file's) */
export const PackItemStatus = z.enum(['created', 'present', 'kept', 'blocked'])
export type PackItemStatus = z.infer<typeof PackItemStatus>

export const SkillPackInstallResult = z.object({
  pack: SkillPackId,
  /** the language of the skill text that was used (the team's language, or English) */
  locale: Locale,
  skills: z.array(z.object({ name: z.string(), path: z.string(), status: PackItemStatus })),
  folders: z.array(z.object({ path: z.string(), status: z.enum(['created', 'present', 'blocked']) })),
})
export type SkillPackInstallResult = z.infer<typeof SkillPackInstallResult>

export const ONBOARDING_PACKS = {
  installSkillPack: endpoint({ method: 'POST', path: '/api/onboarding/packs/:id/install', auth: 'admin', owner: 'B', response: SkillPackInstallResult, summary: 'Install a recommended skill pack (id: marketing) as the caller: its skills under skills/<id>/ and its team folders under shared/, in the team language. Adds only what is missing; never replaces a file.' }),
} as const
