// Recommended skill packs (docs/DECISIONS.md "C. Onboarding: marketing skill pack and skill forms"). A new team has
// no skills; an owner or admin installs a pack in one click (POST /api/onboarding/packs/:id/install): its skills as
// plain files under skills/<pack>/<name>/SKILL.md in the team's language (English when the pack has none for it) and
// the folders that kind of team works in under shared/ (named in the team's language).
//
// Written as the person who asked, through the normal file services: folder rules decide, and version history, the
// skills/ change audit and the owner / admin notices follow from it, exactly as for a skill saved on the file screen.
// From then on the files are the team's own (not a plugin's managed copy): anyone who manages skills edits them.
// Installing again only adds what is missing. A file that is already there is never replaced, whatever it holds: the
// same text is `present`, other text (someone edited it) is `kept`.
//
// The pack text is in resources/skill-packs/<pack>/<locale>/<name>/SKILL.md, imported as text so a release bundle
// carries it inside the server code (no extra resource files to list or verify).
import type { Locale, PackItemStatus, SkillPackId, SkillPackInstallResult } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { teamDefaultLocale } from '../admin/settings'
import { readRegular } from '../files/store'
import { HttpError } from '../http/errors'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { listTeamSkills, sameSkillName, SKILL_FILE_MAX_BYTES } from '../chat/skills'
import { componentC } from '../team-files/component'
import { FileError } from '../team-files/errors'
import koAdCopy from '../../../resources/skill-packs/marketing/ko/ad-copy/SKILL.md' with { type: 'text' }
import koContentDraft from '../../../resources/skill-packs/marketing/ko/content-draft/SKILL.md' with { type: 'text' }
import koCampaignPlan from '../../../resources/skill-packs/marketing/ko/campaign-plan/SKILL.md' with { type: 'text' }
import koSeoBrief from '../../../resources/skill-packs/marketing/ko/seo-brief/SKILL.md' with { type: 'text' }
import koCompetitorBrief from '../../../resources/skill-packs/marketing/ko/competitor-brief/SKILL.md' with { type: 'text' }
import koBrandReview from '../../../resources/skill-packs/marketing/ko/brand-review/SKILL.md' with { type: 'text' }
import koWeeklyReport from '../../../resources/skill-packs/marketing/ko/weekly-report/SKILL.md' with { type: 'text' }
import enAdCopy from '../../../resources/skill-packs/marketing/en/ad-copy/SKILL.md' with { type: 'text' }
import enContentDraft from '../../../resources/skill-packs/marketing/en/content-draft/SKILL.md' with { type: 'text' }
import enCampaignPlan from '../../../resources/skill-packs/marketing/en/campaign-plan/SKILL.md' with { type: 'text' }
import enSeoBrief from '../../../resources/skill-packs/marketing/en/seo-brief/SKILL.md' with { type: 'text' }
import enCompetitorBrief from '../../../resources/skill-packs/marketing/en/competitor-brief/SKILL.md' with { type: 'text' }
import enBrandReview from '../../../resources/skill-packs/marketing/en/brand-review/SKILL.md' with { type: 'text' }
import enWeeklyReport from '../../../resources/skill-packs/marketing/en/weekly-report/SKILL.md' with { type: 'text' }

export interface SkillPack {
  /** skill name → its SKILL.md text, per language the pack is written in (English always) */
  skills: Partial<Record<Locale, Record<string, string>>> & { en: Record<string, string> }
  /** the team folders under shared/, per language (every locale) */
  folders: Record<Locale, string[]>
}

export const SKILL_PACKS: Record<SkillPackId, SkillPack> = {
  marketing: {
    skills: {
      ko: { 'ad-copy': koAdCopy, 'content-draft': koContentDraft, 'campaign-plan': koCampaignPlan, 'seo-brief': koSeoBrief, 'competitor-brief': koCompetitorBrief, 'brand-review': koBrandReview, 'weekly-report': koWeeklyReport },
      en: { 'ad-copy': enAdCopy, 'content-draft': enContentDraft, 'campaign-plan': enCampaignPlan, 'seo-brief': enSeoBrief, 'competitor-brief': enCompetitorBrief, 'brand-review': enBrandReview, 'weekly-report': enWeeklyReport },
    },
    folders: {
      ko: ['브랜드', '캠페인', '보고서', '경쟁사'],
      en: ['Brand', 'Campaigns', 'Reports', 'Competitors'],
      id: ['Merek', 'Kampanye', 'Laporan', 'Pesaing'],
      ja: ['ブランド', 'キャンペーン', 'レポート', '競合'],
      es: ['Marca', 'Campañas', 'Informes', 'Competencia'],
    },
  },
}

/** The language of a pack's skill text for a team: the team's own, or English. */
export const packLocale = (pack: SkillPack, team: Locale): Locale => (pack.skills[team] ? team : 'en')

const refused = (e: unknown) => e instanceof Denied || e instanceof ToolError || e instanceof FileError || e instanceof HttpError

/** One skill file: written when the name is free, otherwise left as it is. A team skill elsewhere with the same
 * skill name blocks it: "/<name>" (and so a form, which runs by name) would run either one. */
function placeSkill(ctx: AppContext, userId: string, rel: string, name: string, text: string, team: { path: string; name: string }[]): { path: string; status: PackItemStatus; sameNameAs?: string } {
  const user = ctx.files.principal(userId)
  // the pack's own file (installed before) is not another skill; on a case-insensitive disk neither is its other spelling
  const fold = (p: string) => (ctx.files.fx.caseInsensitive ? p.normalize('NFC').toLowerCase() : p)
  const other = team.find((s) => sameSkillName(s.name, name) && fold(s.path) !== fold(rel))
  if (other) return { path: rel, status: 'blocked', sameNameAs: other.path }
  let r
  try { r = authorize(ctx.files.fx, ctx.files.rules(), user, rel, 'write', { createDirs: true }) } catch (e) {
    if (refused(e)) return { path: rel, status: 'blocked' }
    throw e
  }
  if (r.exists) {
    if (!r.st?.isFile()) return { path: r.rel, status: 'blocked' }
    try { return { path: r.rel, status: readRegular(r.abs, SKILL_FILE_MAX_BYTES).bytes.equals(Buffer.from(text, 'utf8')) ? 'present' : 'kept' } } catch (e) {
      if (refused(e)) return { path: r.rel, status: 'kept' }
      throw e
    }
  }
  try {
    // no "last seen" hash: should the file appear meanwhile, the save refuses (not_read) instead of replacing it
    ctx.files.humanSave(userId, rel, Buffer.from(text, 'utf8'), null)
  } catch (e) {
    if (e instanceof ToolError && e.code === 'not_read') return { path: r.rel, status: 'kept' }
    if (refused(e)) return { path: r.rel, status: 'blocked' }
    throw e
  }
  return { path: r.rel, status: 'created' }
}

/** One team folder under shared/: made through the file screen's own "new folder" when it is not there. */
function placeFolder(ctx: AppContext, userId: string, rel: string): { path: string; status: 'created' | 'present' | 'blocked' } {
  try {
    const r = authorize(ctx.files.fx, ctx.files.rules(), ctx.files.principal(userId), rel, 'write', { mustExist: false })
    if (r.exists) return { path: r.rel, status: r.st?.isDirectory() ? 'present' : 'blocked' }
    return { path: componentC(ctx).files.mkdir(userId, rel).path, status: 'created' }
  } catch (e) {
    if (refused(e)) return { path: rel, status: 'blocked' }
    throw e
  }
}

/** Install pack `id` as `userId` (the route lets owners and admins only). Idempotent; never replaces a file. */
export function installSkillPack(ctx: AppContext, userId: string, id: SkillPackId): SkillPackInstallResult {
  const pack = SKILL_PACKS[id]
  const team = teamDefaultLocale(ctx.db)
  const locale = packLocale(pack, team)
  const texts = pack.skills[locale]!
  // the team skills as the admin sees them (owners and admins read every team folder), personal ones left out
  const teamSkills = listTeamSkills(ctx.files, ctx.files.principal(userId)).map((s) => ({ path: s.path, name: s.name }))
  const skills = Object.entries(texts).map(([name, text]) => ({ name, ...placeSkill(ctx, userId, `skills/${id}/${name}/SKILL.md`, name, text, teamSkills) }))
  const folders = pack.folders[team].map((f) => placeFolder(ctx, userId, `shared/${f}`))
  const count = (s: string) => [...skills, ...folders].filter((x) => x.status === s).length
  audit(ctx.db, { actor: userId, action: 'onboarding.pack_install', target: `skills/${id}`, detail: { pack: id, locale, created: count('created'), present: count('present'), kept: count('kept'), blocked: count('blocked') } })
  return { pack: id, locale, skills, folders }
}
