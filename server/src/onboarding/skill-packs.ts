// Recommended skill packs (docs/DECISIONS.md "C. Onboarding: marketing skill pack and skill forms", "DS3 — Only skills
// with a known origin ship; no auto-add", "W6 — Onboarding v6: skills catalog and 내 스킬"): general (the intro deck, the
// card news, the promo video) and work (natural writing). A new team has no skills. The catalog (skillPackCatalog: GET
// /api/onboarding/packs) lists the kept skills with their one line, example and source, and whether the team has each;
// the owner's 내 스킬 step and the Team skills page's "트리나가 준비한 스킬 · N개 더" (owners and admins) install what a
// person checked (POST /api/onboarding/packs/:id/install with `skills`): plain files under skills/<pack>/<name>/SKILL.md
// in the team's language (English when the pack has none for it). Nothing adds a pack's skills by itself; a skill
// shipped later only raises the catalog's count.
//
// Written as the person who asked, through the normal file services: folder rules decide, and version history, the
// skills/ change audit and the owner / admin notices follow from it, exactly as for a skill saved on the file screen.
// From then on the files are the team's own (not a plugin's managed copy): anyone who manages skills edits them.
// Installing again only adds what is missing. A file that is already there is never replaced, whatever it holds: the
// same text (or an earlier release's text of it: earlierPackTexts) is `present`, other text (someone edited it) `kept`.
// An install that holds a visual skill (made from the company profile) runs the hooks of onVisualSkillInstall first: the
// welcome steps' brand action puts the website's pictures and 회사 소개.md in the team's brand folder there (FLOW-v6 §1A).
//
// The pack text is in resources/skill-packs/<pack>/<locale>/<name>/SKILL.md, imported as text so a release bundle
// carries it inside the server code (no extra resource files to list or verify). The examples follow the same rule
// (PACK_EXAMPLES).
import type { Locale, PackCatalog, PackCatalogSkill, PackExample, PackItemStatus, PackSkillSource, SkillPackId, SkillPackInstallResult } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { teamDefaultLocale } from '../admin/settings'
import { readRegular } from '../files/store'
import { HttpError, fail } from '../http/errors'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { listTeamSkills, parseSkill, sameSkillName, SKILL_FILE_MAX_BYTES } from '../chat/skills'
import { readCompanyProfile } from './profile'
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
  // the intro deck, the card news and the promo video, each calling a tool of its own and made from the company profile
  general: {
    skills: {
      ko: { 'card-news': koCardNews, 'promo-video': koPromoVideo, 'intro-deck': koIntroDeck },
      en: { 'card-news': enCardNews, 'promo-video': enPromoVideo, 'intro-deck': enIntroDeck },
    },
  },
  // "humanizer" (natural writing, docs/DECISIONS.md "DS2"). Korean: written by the company from the Korean writing skill
  // it used itself. English: adapted from the open-source "humanizer" skill (Siqi Chen, MIT), rewritten with examples of
  // our own; it keeps its MIT notice (and LICENSE next to it in resources/).
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

/** Install pack `id` as `userId` (the route lets owners and admins only): the skills named in `only` (each a skill of
 * the pack: anything else is refused before anything is written), else the whole pack. Idempotent; never replaces a
 * file. The hooks of onVisualSkillInstall run first when a visual skill is among them. */
export function installSkillPack(ctx: AppContext, userId: string, id: SkillPackId, only?: readonly string[]): SkillPackInstallResult {
  const pack = SKILL_PACKS[id]
  const team = teamDefaultLocale(ctx.db)
  const locale = packLocale(pack, team)
  const texts = pack.skills[locale]!
  const names = only ? [...new Set(only)] : Object.keys(texts)
  const unknown = names.findIndex((n) => !Object.hasOwn(texts, n))
  if (unknown >= 0) fail('validation', undefined, { fields: { [`body.skills.${unknown}`]: 'not a skill of this pack' } })
  if (names.some((n) => VISUAL.has(n))) visualInstallHooks().forEach((fn) => {
    try { fn(ctx, userId) } catch (err) { ctx.log.warn('before a visual skill install: a hook failed', { err }) }
  })
  // the team skills as the admin sees them (owners and admins read every team folder), personal ones left out
  const teamSkills = listTeamSkills(ctx.files, ctx.files.principal(userId)).map((s) => ({ path: s.path, name: s.name }))
  const skills = names.map((name) => ({ name, ...placeSkill(ctx, userId, `skills/${id}/${name}/SKILL.md`, name, texts[name]!, teamSkills) }))
  const count = (s: string) => skills.filter((x) => x.status === s).length
  audit(ctx.db, { actor: userId, action: 'onboarding.pack_install', target: `skills/${id}`, detail: { pack: id, locale, ...(only ? { skills: names } : {}), created: count('created'), present: count('present'), kept: count('kept'), blocked: count('blocked') } })
  return { pack: id, locale, skills }
}

// ---------------------------------------------------------------- the catalog (docs/DECISIONS.md "W6")

/** The kept skills in the order the catalog shows them (내 스킬's rows, the Team skills fold): every skill of every pack
 * is here once (a test holds it to SKILL_PACKS), so a skill shipped later only adds a row. `visual`: made from the company
 * profile (checked on 내 스킬 when a profile is saved; the brand action runs before it goes in). */
export const CATALOG: readonly { pack: SkillPackId; name: string; visual: boolean; source: (locale: Locale) => PackSkillSource }[] = [
  { pack: 'general', name: 'intro-deck', visual: true, source: () => ({ kind: 'team' }) },
  { pack: 'general', name: 'card-news', visual: true, source: () => ({ kind: 'team' }) },
  { pack: 'general', name: 'promo-video', visual: true, source: () => ({ kind: 'team' }) },
  // the Korean text is the company's own; the English one is Siqi Chen's MIT "humanizer" rewritten (DS2), its only link out
  { pack: 'work', name: 'humanizer', visual: false, source: (l) => (l === 'ko' ? { kind: 'team_writing' } : { kind: 'adapted', author: 'Siqi Chen', project: 'humanizer', license: 'MIT', url: 'https://github.com/blader/humanizer' }) },
]
const VISUAL = new Set(CATALOG.filter((c) => c.visual).map((c) => c.name))

/** One line per kept skill in the caller's language: what it makes (the SKILL.md's description is written for the AI). */
const SUMMARY: Record<string, Record<Locale, string>> = {
  'intro-deck': {
    ko: '회사 소개로 6~10장짜리 소개서를 만들어요', en: 'Makes a 6–10 slide company profile from the company intro',
    id: 'Membuat profil perusahaan 6–10 slide dari info perusahaan', ja: '会社紹介から6〜10枚の会社紹介資料を作ります',
    es: 'Crea un dosier de empresa de 6 a 10 diapositivas con la información de la empresa',
  },
  'card-news': {
    ko: '회사 소개로 정사각형 카드 5장을 만들어요', en: 'Makes 5 square promo cards from the company intro',
    id: 'Membuat 5 kartu persegi dari info perusahaan', ja: '会社紹介から正方形のカードを5枚作ります',
    es: 'Crea 5 tarjetas cuadradas con la información de la empresa',
  },
  'promo-video': {
    ko: '회사 소개로 18초짜리 세로 영상을 만들어요', en: 'Makes an 18-second vertical video from the company intro',
    id: 'Membuat video vertikal 18 detik dari info perusahaan', ja: '会社紹介から18秒の縦長の動画を作ります',
    es: 'Crea un vídeo vertical de 18 segundos con la información de la empresa',
  },
  humanizer: {
    ko: 'AI가 쓴 티가 나는 글을 사람이 쓴 것처럼 다듬어요', en: 'Rewrites text that reads as AI-written so a person seems to have written it',
    id: 'Merapikan tulisan yang terasa buatan AI agar terdengar ditulis manusia', ja: 'AIが書いたように見える文章を、人が書いたように整えます',
    es: 'Reescribe textos que suenan a IA para que parezcan escritos por una persona',
  },
}

/** An example of a kept skill (EXAMPLES-PLAN.md; FLOW-v6 §2.2, §8), registered by the language of the skill text and
 * the skill name once its file is in (none yet: the viewer says the example is being made):
 * - an image: `'intro-deck': { kind: 'image' }`, with web/public/skill-examples/<locale>/intro-deck.webp in the web build
 *   (WebP, at most PACK_EXAMPLE_LIMITS.imageBytes);
 * - a text: `humanizer: { kind: 'text', text: koHumanizerExample }`, imported as text like the SKILL.md from
 *   resources/skill-packs/<pack>/<locale>/<name>/EXAMPLE.md (front matter `fictional: true`, `company`, `made`,
 *   `engine`, `skillHash`, then the before → after excerpt in Markdown, at most PACK_EXAMPLE_LIMITS.textChars). It is
 *   never installed into a team: only SKILL.md (and LICENSE) are.
 * Teams in other languages see the English one (the text they get is English). */
export const PACK_EXAMPLES: Record<'ko' | 'en', Partial<Record<string, { kind: 'image' } | { kind: 'text'; text: string }>>> = { ko: {}, en: {} }

/** An EXAMPLE.md without its front matter. */
export const exampleBody = (text: string): string => text.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '').trim()

export function packExample(locale: Locale, name: string): PackExample | null {
  const at = locale === 'ko' ? 'ko' : 'en'
  const e = PACK_EXAMPLES[at][name]
  if (!e) return null
  return e.kind === 'image' ? { kind: 'image', url: `/skill-examples/${at}/${name}.webp` } : { kind: 'text', markdown: exampleBody(e.text) }
}

/** Whether the team has this kept skill: its own path, or another team skill of its name ("/<name>" would run either
 * one, so placeSkill blocks it). */
function inTeam(ctx: AppContext, rel: string, name: string, team: { path: string; name: string }[]): boolean {
  const fold = (p: string) => (ctx.files.fx.caseInsensitive ? p.normalize('NFC').toLowerCase() : p)
  return team.some((s) => fold(s.path) === fold(rel) || sameSkillName(s.name, name))
}

/** The catalog as `userId` (an owner or admin) sees it: every kept skill, in CATALOG's order, in the team's language
 * (`locale`: the caller's, for the one line). */
export function skillPackCatalog(ctx: AppContext, userId: string, locale: Locale): PackCatalog {
  const me = ctx.files.principal(userId)
  const team = teamDefaultLocale(ctx.db)
  const teamSkills = listTeamSkills(ctx.files, me).map((s) => ({ path: s.path, name: s.name }))
  const skills: PackCatalogSkill[] = CATALOG.flatMap((c) => {
    const pack = SKILL_PACKS[c.pack]
    const at = packLocale(pack, team)
    const text = pack.skills[at]?.[c.name]
    if (!text) return []
    const path = `skills/${c.pack}/${c.name}/SKILL.md`
    return [{
      pack: c.pack, name: c.name, path, title: parseSkill(text, path)?.title ?? c.name, description: SUMMARY[c.name]?.[locale] ?? '',
      inTeam: inTeam(ctx, path, c.name, teamSkills), visual: c.visual, example: packExample(at, c.name), locale: at, source: c.source(at),
    }]
  })
  return { skills, profile: !!readCompanyProfile(ctx.files, me) }
}

/** What runs before a visual skill goes in (onboarding/welcome.ts's brand action: the website's pictures and 회사
 * 소개.md in the team's brand folder when the row has no `brandAt`). Registered by the module that owns it; a hook that
 * throws is logged, never fatal: the skill still goes in. */
type VisualInstallHook = (ctx: AppContext, userId: string) => void
// kept on a hoisted function, not a module constant: a module registering while an import cycle has not run this
// module's body yet still finds the list
function visualInstallHooks(): VisualInstallHook[] { return ((visualInstallHooks as unknown as { list?: VisualInstallHook[] }).list ??= []) }
export function onVisualSkillInstall(fn: VisualInstallHook): void { if (!visualInstallHooks().includes(fn)) visualInstallHooks().push(fn) }
