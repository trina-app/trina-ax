// Recommended skill packs (docs/DECISIONS.md "C. Onboarding: marketing skill pack and skill forms", "DS3 — Only skills
// with a known origin ship; no auto-add"): general (the intro deck, the card news, the promo video) and work (natural
// writing). A new team has no skills; the welcome steps install the general pack once (onboarding/welcome.ts
// setupWelcomeTeam), and an owner or admin installs a pack in one click (POST /api/onboarding/packs/:id/install): its
// skills as plain files under skills/<pack>/<name>/SKILL.md in the team's language (English when the pack has none for
// it). Nothing adds a pack's skills by itself.
//
// Written as the person who asked, through the normal file services: folder rules decide, and version history, the
// skills/ change audit and the owner / admin notices follow from it, exactly as for a skill saved on the file screen.
// From then on the files are the team's own (not a plugin's managed copy): anyone who manages skills edits them.
// Installing again only adds what is missing. A file that is already there is never replaced, whatever it holds: the
// same text (or an earlier release's text of it: earlierPackTexts) is `present`, other text (someone edited it) `kept`.
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
import { FileError } from '../team-files/errors'
import koCardNews from '../../../resources/skill-packs/general/ko/card-news/SKILL.md' with { type: 'text' }
import enCardNews from '../../../resources/skill-packs/general/en/card-news/SKILL.md' with { type: 'text' }
import koPromoVideo from '../../../resources/skill-packs/general/ko/promo-video/SKILL.md' with { type: 'text' }
import enPromoVideo from '../../../resources/skill-packs/general/en/promo-video/SKILL.md' with { type: 'text' }
import koIntroDeck from '../../../resources/skill-packs/general/ko/intro-deck/SKILL.md' with { type: 'text' }
import enIntroDeck from '../../../resources/skill-packs/general/en/intro-deck/SKILL.md' with { type: 'text' }
import koWorkHumanizer from '../../../resources/skill-packs/work/ko/humanizer/SKILL.md' with { type: 'text' }
import enWorkHumanizer from '../../../resources/skill-packs/work/en/humanizer/SKILL.md' with { type: 'text' }

export interface SkillPack {
  /** skill name → its SKILL.md text, per language the pack is written in (English always) */
  skills: Partial<Record<Locale, Record<string, string>>> & { en: Record<string, string> }
}

export const SKILL_PACKS: Record<SkillPackId, SkillPack> = {
  // every team's skills, installed by the welcome steps (onboarding/welcome.ts setupWelcomeTeam): the intro deck (the
  // first result), the card news and the promo video, each calling a tool of its own
  general: {
    skills: {
      ko: { 'card-news': koCardNews, 'promo-video': koPromoVideo, 'intro-deck': koIntroDeck },
      en: { 'card-news': enCardNews, 'promo-video': enPromoVideo, 'intro-deck': enIntroDeck },
    },
  },
  // "humanizer" (natural writing, docs/DECISIONS.md "DS2"). Korean: written by the company, adapted from its own Korean
  // humanizer skill. English: adapted from the open-source "humanizer" skill (Siqi Chen, MIT), with examples of our own;
  // it keeps its MIT notice (and LICENSE next to it in resources/).
  work: {
    skills: {
      ko: { humanizer: koWorkHumanizer },
      en: { humanizer: enWorkHumanizer },
    },
  },
}

/** The language of a pack's skill text for a team: the team's own, or English. */
export const packLocale = (pack: SkillPack, team: Locale): Locale => (pack.skills[team] ? team : 'en')

/** The texts an earlier release of the pack wrote for this one: the same file without its metadata `title` line (the
 * titles came after the first install on some teams), without its `recurring` line (docs/DECISIONS.md "S"), or without
 * both. A file holding exactly such bytes was never edited, so it is `present`, not `kept`; it is not replaced (no file
 * is), and it shows the skill's name until someone adds the line. */
export function earlierPackTexts(text: string): string[] {
  const noTitle = (t: string) => t.replace(/^(metadata:\r?\n)[ \t]+title:[^\r\n]*\r?\n/m, '$1')
  const noRecurring = (t: string) => t.replace(/^[ \t]+recurring:[^\r\n]*\r?\n(?=---)/m, '')
  return [...new Set([noTitle(text), noRecurring(text), noTitle(noRecurring(text))])].filter((t) => t !== text)
}

/** Every skill name a pack has (any pack, any language): a team skill made later never takes one (skill-draft.ts). */
export const packSkillNames = (): string[] => [...new Set(Object.values(SKILL_PACKS).flatMap((p) => Object.values(p.skills).flatMap((t) => Object.keys(t ?? {}))))]

const refused = (e: unknown) => e instanceof Denied || e instanceof ToolError || e instanceof FileError || e instanceof HttpError

/** One skill file: written when the name is free, otherwise left as it is. A team skill elsewhere with the same
 * skill name blocks it: "/<name>" (and so a form, which runs by name) would run either one. */
export function placeSkill(ctx: AppContext, userId: string, rel: string, name: string, text: string, team: { path: string; name: string }[]): { path: string; status: PackItemStatus; sameNameAs?: string } {
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
    try {
      const bytes = readRegular(r.abs, SKILL_FILE_MAX_BYTES).bytes
      return { path: r.rel, status: [text, ...earlierPackTexts(text)].some((t) => bytes.equals(Buffer.from(t, 'utf8'))) ? 'present' : 'kept' }
    } catch (e) {
      if (refused(e)) return { path: r.rel, status: 'kept' }
      throw e
    }
  }
  try {
    // no "last seen" hash: should the file appear meanwhile, the save refuses (not_read) instead of replacing it
    // marked as the pack's: the person who pressed install did not write it (skills/author.ts)
    ctx.files.humanSave(userId, rel, Buffer.from(text, 'utf8'), null, 'pack_install')
  } catch (e) {
    if (e instanceof ToolError && e.code === 'not_read') return { path: r.rel, status: 'kept' }
    if (refused(e)) return { path: r.rel, status: 'blocked' }
    throw e
  }
  return { path: r.rel, status: 'created' }
}

/** One skill of a pack, alone (the welcome steps' first result adds "회사 소개서" to a team whose general pack was
 * recorded before the skill existed, once: docs/DECISIONS.md "N", "V", "D2"). Like the pack install: never replaces a
 * file, a team skill of the same name elsewhere blocks it, written as the person through the file layer. */
export function installPackSkill(ctx: AppContext, userId: string, id: SkillPackId, name: string): { path: string; status: PackItemStatus; sameNameAs?: string } {
  const pack = SKILL_PACKS[id]
  const locale = packLocale(pack, teamDefaultLocale(ctx.db))
  const text = pack.skills[locale]![name]
  if (!text) throw new Error(`no skill ${name} in pack ${id}`)
  const teamSkills = listTeamSkills(ctx.files, ctx.files.principal(userId)).map((s) => ({ path: s.path, name: s.name }))
  const r = placeSkill(ctx, userId, `skills/${id}/${name}/SKILL.md`, name, text, teamSkills)
  audit(ctx.db, { actor: userId, action: 'onboarding.pack_install', target: `skills/${id}/${name}`, detail: { pack: id, locale, skill: name, status: r.status } })
  return r
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
  const count = (s: string) => skills.filter((x) => x.status === s).length
  audit(ctx.db, { actor: userId, action: 'onboarding.pack_install', target: `skills/${id}`, detail: { pack: id, locale, created: count('created'), present: count('present'), kept: count('kept'), blocked: count('blocked') } })
  return { pack: id, locale, skills }
}
