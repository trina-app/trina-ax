// Recommended skill packs (docs/DECISIONS.md "C. Onboarding: marketing skill pack and skill forms", "DS3 — Only skills
// with a known origin ship; no auto-add", "W6 — Onboarding v6: skills catalog and 내 스킬";
// docs/decisions/20261122-onboarding-everyday-skills.md): general (the intro deck, the card news, the promo video) and
// work (meeting notes, reports and notices, customer replies, contract review, natural writing). A new team has no skills. The catalog (skillPackCatalog: GET
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
// (skill-examples.ts PACK_EXAMPLES).
import type { Locale, PackCatalog, PackCatalogSkill, PackItemStatus, PackOnboarding, PackSkillSource, SkillPackId, SkillPackInstallResult } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { teamDefaultLocale } from '../admin/settings'
import { readRegular } from '../files/store'
import { HttpError, fail } from '../http/errors'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { listTeamSkills, sameSkillName, SKILL_FILE_MAX_BYTES } from '../chat/skills'
import { readCompanyProfile } from './profile'
import { packExample } from './skill-examples'
import { FileError } from '../team-files/errors'
import koCardNews from '../../../resources/skill-packs/general/ko/card-news/SKILL.md' with { type: 'text' }
import enCardNews from '../../../resources/skill-packs/general/en/card-news/SKILL.md' with { type: 'text' }
import koPromoVideo from '../../../resources/skill-packs/general/ko/promo-video/SKILL.md' with { type: 'text' }
import enPromoVideo from '../../../resources/skill-packs/general/en/promo-video/SKILL.md' with { type: 'text' }
import koIntroDeck from '../../../resources/skill-packs/general/ko/intro-deck/SKILL.md' with { type: 'text' }
import enIntroDeck from '../../../resources/skill-packs/general/en/intro-deck/SKILL.md' with { type: 'text' }
import koWorkHumanizer from '../../../resources/skill-packs/work/ko/humanizer/SKILL.md' with { type: 'text' }
import enWorkHumanizer from '../../../resources/skill-packs/work/en/humanizer/SKILL.md' with { type: 'text' }
import koMeetingNotes from '../../../resources/skill-packs/work/ko/meeting-notes/SKILL.md' with { type: 'text' }
import enMeetingNotes from '../../../resources/skill-packs/work/en/meeting-notes/SKILL.md' with { type: 'text' }
import koTeamReport from '../../../resources/skill-packs/work/ko/team-report/SKILL.md' with { type: 'text' }
import enTeamReport from '../../../resources/skill-packs/work/en/team-report/SKILL.md' with { type: 'text' }
import koCustomerReply from '../../../resources/skill-packs/work/ko/customer-reply/SKILL.md' with { type: 'text' }
import enCustomerReply from '../../../resources/skill-packs/work/en/customer-reply/SKILL.md' with { type: 'text' }
import koContractReview from '../../../resources/skill-packs/work/ko/contract-review/SKILL.md' with { type: 'text' }
import enContractReview from '../../../resources/skill-packs/work/en/contract-review/SKILL.md' with { type: 'text' }
import jaMeetingNotes from '../../../resources/skill-packs/work/ja/meeting-notes/SKILL.md' with { type: 'text' }
import jaTeamReport from '../../../resources/skill-packs/work/ja/team-report/SKILL.md' with { type: 'text' }
import jaCustomerReply from '../../../resources/skill-packs/work/ja/customer-reply/SKILL.md' with { type: 'text' }
import jaContractReview from '../../../resources/skill-packs/work/ja/contract-review/SKILL.md' with { type: 'text' }
import zhMeetingNotes from '../../../resources/skill-packs/work/zh/meeting-notes/SKILL.md' with { type: 'text' }
import zhTeamReport from '../../../resources/skill-packs/work/zh/team-report/SKILL.md' with { type: 'text' }
import zhCustomerReply from '../../../resources/skill-packs/work/zh/customer-reply/SKILL.md' with { type: 'text' }
import zhContractReview from '../../../resources/skill-packs/work/zh/contract-review/SKILL.md' with { type: 'text' }
import esMeetingNotes from '../../../resources/skill-packs/work/es/meeting-notes/SKILL.md' with { type: 'text' }
import esTeamReport from '../../../resources/skill-packs/work/es/team-report/SKILL.md' with { type: 'text' }
import esCustomerReply from '../../../resources/skill-packs/work/es/customer-reply/SKILL.md' with { type: 'text' }
import esContractReview from '../../../resources/skill-packs/work/es/contract-review/SKILL.md' with { type: 'text' }
import idMeetingNotes from '../../../resources/skill-packs/work/id/meeting-notes/SKILL.md' with { type: 'text' }
import idTeamReport from '../../../resources/skill-packs/work/id/team-report/SKILL.md' with { type: 'text' }
import idCustomerReply from '../../../resources/skill-packs/work/id/customer-reply/SKILL.md' with { type: 'text' }
import idContractReview from '../../../resources/skill-packs/work/id/contract-review/SKILL.md' with { type: 'text' }

export interface SkillPack {
  /** skill name → its SKILL.md text, per language (English always, with every skill; another language may hold only
   * some skills: skillLocale picks per skill) */
  skills: Partial<Record<Locale, Record<string, string>>> & { en: Record<string, string> }
}

/** The everyday office skills in the other app languages (natural writing stays Korean and English: its patterns are
 * language-specific). Spread into the work pack, so the pack is not read as a table that needs every skill in every
 * language (scripts/check-i18n.ts). */
const EVERYDAY_OTHER_LOCALES = {
  ja: { 'meeting-notes': jaMeetingNotes, 'team-report': jaTeamReport, 'customer-reply': jaCustomerReply, 'contract-review': jaContractReview },
  zh: { 'meeting-notes': zhMeetingNotes, 'team-report': zhTeamReport, 'customer-reply': zhCustomerReply, 'contract-review': zhContractReview },
  es: { 'meeting-notes': esMeetingNotes, 'team-report': esTeamReport, 'customer-reply': esCustomerReply, 'contract-review': esContractReview },
  id: { 'meeting-notes': idMeetingNotes, 'team-report': idTeamReport, 'customer-reply': idCustomerReply, 'contract-review': idContractReview },
} satisfies Partial<Record<Locale, Record<string, string>>>

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
  // The everyday office skills (docs/decisions/20261122-onboarding-everyday-skills.md): meeting notes, reports and
  // notices, customer replies, contract review. Text only, rewritten in both languages from Anthropic's Apache-2.0
  // skills (anthropics/skills internal-comms, anthropics/knowledge-work-plugins) at pinned commits; each SKILL.md ends
  // with its credits, and LICENSE and NOTICE sit next to it in resources/.
  work: {
    skills: {
      ko: { humanizer: koWorkHumanizer, 'meeting-notes': koMeetingNotes, 'team-report': koTeamReport, 'customer-reply': koCustomerReply, 'contract-review': koContractReview },
      en: { humanizer: enWorkHumanizer, 'meeting-notes': enMeetingNotes, 'team-report': enTeamReport, 'customer-reply': enCustomerReply, 'contract-review': enContractReview },
      ...EVERYDAY_OTHER_LOCALES,
    },
  },
}

/** The language of one skill's text for a team: the team's own when the pack has that skill in it, or English (the work
 * pack has the everyday skills in all six languages, natural writing in Korean and English only). */
export const skillLocale = (pack: SkillPack, name: string, team: Locale): Locale => (pack.skills[team]?.[name] ? team : 'en')
/** One skill's text for a team (undefined: not a skill of the pack). */
const skillText = (pack: SkillPack, name: string, team: Locale): string | undefined => pack.skills[skillLocale(pack, name, team)]?.[name]

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
      const bytes = readRegular(r.abs, SKILL_FILE_MAX_BYTES, r.st).bytes
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
  const locale = skillLocale(pack, name, teamDefaultLocale(ctx.db))
  const text = skillText(pack, name, locale)
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
  // every skill of the pack is in English; each goes in in the team's language when the pack has it in that one
  const names = only ? [...new Set(only)] : Object.keys(pack.skills.en)
  const unknown = names.findIndex((n) => !Object.hasOwn(pack.skills.en, n))
  if (unknown >= 0) fail('validation', undefined, { fields: { [`body.skills.${unknown}`]: 'not a skill of this pack' } })
  if (names.some((n) => VISUAL.has(n))) visualInstallHooks().forEach((fn) => {
    try { fn(ctx, userId) } catch (err) { ctx.log.warn('before a visual skill install: a hook failed', { err }) }
  })
  // the team skills as the admin sees them (owners and admins read every team folder), personal ones left out
  const teamSkills = listTeamSkills(ctx.files, ctx.files.principal(userId)).map((s) => ({ path: s.path, name: s.name }))
  const skills = names.map((name) => ({ name, ...placeSkill(ctx, userId, `skills/${id}/${name}/SKILL.md`, name, skillText(pack, name, team)!, teamSkills) }))
  // the result's language: the team's when at least one skill went in in it, else English
  const locale: Locale = names.some((n) => skillLocale(pack, n, team) === team) ? team : 'en'
  const count = (s: string) => skills.filter((x) => x.status === s).length
  audit(ctx.db, { actor: userId, action: 'onboarding.pack_install', target: `skills/${id}`, detail: { pack: id, locale, ...(only ? { skills: names } : {}), created: count('created'), present: count('present'), kept: count('kept'), blocked: count('blocked') } })
  return { pack: id, locale, skills }
}

// ---------------------------------------------------------------- the catalog (docs/DECISIONS.md "W6")

/** The upstream commits the adapted skills were read at (their NOTICE files and SKILL.md credits name them too). */
export const KWP_COMMIT = '0e0fcacddcc892eb92a1b7873ff9d68159c47571'
export const ANTHROPIC_SKILLS_COMMIT = 'e4bb5d960d87126ff3b3a8af1a104b7db67560ba'
const KWP = (path: string) => ({ kind: 'adapted' as const, author: 'Anthropic', project: 'knowledge-work-plugins', license: 'Apache-2.0', url: `https://github.com/anthropics/knowledge-work-plugins/tree/${KWP_COMMIT}/${path}` })
/** The kept skills in the order the catalog shows them (내 스킬's rows, the Team skills fold): every skill of every pack
 * is here once (a test holds it to SKILL_PACKS), so a skill shipped later only adds a row. `visual`: made from the company
 * profile (the brand action runs before it goes in). `onboarding` (docs/decisions/20261122-onboarding-everyday-skills.md):
 * the owner's setup step "팀이 쓸 스킬을 골라 주세요" shows the skill, checked (`checked`) or not (`offered`); null: only on
 * Team skills › "트리나가 준비한 스킬 · N개 더" (card news, promo video). */
export const CATALOG: readonly { pack: SkillPackId; name: string; visual: boolean; onboarding: PackOnboarding | null; source: (locale: Locale) => PackSkillSource }[] = [
  { pack: 'work', name: 'meeting-notes', visual: false, onboarding: 'checked', source: () => KWP('sales/skills/call-summary') },
  { pack: 'work', name: 'team-report', visual: false, onboarding: 'checked', source: () => ({ kind: 'adapted', author: 'Anthropic', project: 'internal-comms', license: 'Apache-2.0', url: `https://github.com/anthropics/skills/tree/${ANTHROPIC_SKILLS_COMMIT}/skills/internal-comms` }) },
  { pack: 'work', name: 'customer-reply', visual: false, onboarding: 'checked', source: () => KWP('customer-support/skills/draft-response') },
  { pack: 'work', name: 'contract-review', visual: false, onboarding: 'offered', source: () => KWP('legal/skills/review-contract') },
  // the Korean text is the company's own; the English one is Siqi Chen's MIT "humanizer" rewritten (DS2)
  { pack: 'work', name: 'humanizer', visual: false, onboarding: 'checked', source: (l) => (l === 'ko' ? { kind: 'team_writing' } : { kind: 'adapted', author: 'Siqi Chen', project: 'humanizer', license: 'MIT', url: 'https://github.com/blader/humanizer' }) },
  { pack: 'general', name: 'intro-deck', visual: true, onboarding: 'offered', source: () => ({ kind: 'team' }) },
  { pack: 'general', name: 'card-news', visual: true, onboarding: null, source: () => ({ kind: 'team' }) },
  { pack: 'general', name: 'promo-video', visual: true, onboarding: null, source: () => ({ kind: 'team' }) },
]
const VISUAL = new Set(CATALOG.filter((c) => c.visual).map((c) => c.name))

/** One line per kept skill in the caller's language: what it makes (the SKILL.md's description is written for the AI). */
const SUMMARY: Record<string, Record<Locale, string>> = {
  'intro-deck': {
    ko: '회사 소개로 6~10장짜리 소개서를 만들어요', en: 'Makes a 6–10 slide company slide deck from the company intro',
    id: 'Membuat slide perusahaan 6–10 halaman dari info perusahaan', ja: '会社紹介から6〜10枚の会社紹介資料を作ります',
    es: 'Crea un dosier de empresa de 6 a 10 diapositivas con la información de la empresa',
    zh: '根据公司介绍制作6–10页的公司介绍资料',
  },
  'card-news': {
    ko: '회사 소개로 정사각형 카드 5장을 만들어요', en: 'Makes 5 square promo cards from the company intro',
    id: 'Membuat 5 kartu persegi dari info perusahaan', ja: '会社紹介から正方形のカードを5枚作ります',
    es: 'Crea 5 tarjetas cuadradas con la información de la empresa',
    zh: '根据公司介绍制作5张方形宣传卡片',
  },
  'promo-video': {
    ko: '회사 소개로 18초짜리 세로 영상을 만들어요', en: 'Makes an 18-second vertical video from the company intro',
    id: 'Membuat video vertikal 18 detik dari info perusahaan', ja: '会社紹介から18秒の縦長の動画を作ります',
    es: 'Crea un vídeo vertical de 18 segundos con la información de la empresa',
    zh: '根据公司介绍制作18秒的竖版视频',
  },
  'meeting-notes': {
    ko: '회의 메모나 녹음 대본으로 결정 사항과 담당·기한이 붙은 할 일을 정리해요', en: 'Turns meeting notes or a transcript into decisions and to-dos with owners and due dates',
    id: 'Merangkum catatan atau transkrip rapat jadi keputusan dan tugas lengkap dengan penanggung jawab dan tenggat', ja: '会議メモや文字起こしから、決定事項と担当・期限つきのToDoをまとめます',
    es: 'Convierte notas o transcripciones de reuniones en decisiones y tareas con responsable y fecha',
    zh: '把会议记录或录音文字稿整理成决定事项和带负责人、期限的待办',
  },
  'team-report': {
    ko: '주간 보고, 팀 공지, 장애 보고를 깔끔한 회사 양식으로 써요', en: 'Writes weekly reports, team notices and incident reports in a clean company format',
    id: 'Menulis laporan mingguan, pengumuman tim, dan laporan insiden dengan format kantor yang rapi', ja: '週報、チームへのお知らせ、障害報告を整った社内の書式で書きます',
    es: 'Redacta informes semanales, avisos al equipo e informes de incidencias con un formato claro de empresa',
    zh: '用规范的公司格式写周报、团队通知和故障报告',
  },
  'customer-reply': {
    ko: '고객 문의나 불만에 보낼 정중한 답장 초안을 써요', en: 'Drafts polite replies to customer questions and complaints',
    id: 'Menyusun draf balasan yang sopan untuk pertanyaan dan keluhan pelanggan', ja: 'お客様の問い合わせや苦情への丁寧な返信の下書きを書きます',
    es: 'Redacta borradores de respuestas amables a preguntas y quejas de clientes',
    zh: '为客户咨询和投诉起草礼貌的回复',
  },
  'contract-review': {
    ko: '계약서의 위험한 조항, 빠진 내용, 물어볼 질문을 짚어요 (법률 자문은 아니에요)', en: 'Points out risky clauses, missing items and questions to ask in a contract (not legal advice)',
    id: 'Menandai klausul berisiko, hal yang kurang, dan pertanyaan yang perlu diajukan dalam kontrak (bukan nasihat hukum)', ja: '契約書のリスクのある条項、抜けている点、確認すべき質問を指摘します(法的助言ではありません)',
    es: 'Señala cláusulas de riesgo, lo que falta y qué preguntar en un contrato (no es asesoría legal)',
    zh: '指出合同中的风险条款、遗漏内容和需要问的问题(不构成法律意见)',
  },
  humanizer: {
    ko: 'AI가 쓴 티가 나는 글을 사람이 쓴 것처럼 다듬어요', en: 'Rewrites text that reads as AI-written so a person seems to have written it',
    id: 'Merapikan tulisan yang terasa buatan AI agar terdengar ditulis manusia', ja: 'AIが書いたように見える文章を、人が書いたように整えます',
    es: 'Reescribe textos que suenan a IA para que parezcan escritos por una persona',
    zh: '把读起来像AI写的文字改写得像真人写的',
  },
}

/** A kept skill's one line in `locale` ('' for a name that is not one). */
export const packSummary = (name: string, locale: Locale): string => SUMMARY[name]?.[locale] ?? ''

/** Each kept skill's display name in every app language (QA TC-7962, TC-7963): the catalog, the setup step and Home show
 * it in the viewer's language, like the one line, whatever language the installed text is in. Where a pack has text in a
 * language this is that SKILL.md's own `title` (tests/unit/b-skill-catalog.test.ts holds them equal); the slash name
 * never changes. */
const TITLE: Record<string, Record<Locale, string>> = {
  'meeting-notes': { ko: '회의록 정리', en: 'Meeting notes', id: 'Notulen rapat', ja: '議事録まとめ', es: 'Actas de reunión', zh: '会议纪要' },
  'team-report': { ko: '주간 보고·공지', en: 'Reports & announcements', id: 'Laporan & pengumuman', ja: '週報・お知らせ', es: 'Informes y avisos', zh: '周报与通知' },
  'customer-reply': { ko: '고객 답장', en: 'Customer replies', id: 'Balasan pelanggan', ja: 'お客様への返信', es: 'Respuestas a clientes', zh: '客户回复' },
  'contract-review': { ko: '계약서 검토', en: 'Contract review', id: 'Tinjauan kontrak', ja: '契約書チェック', es: 'Revisión de contratos', zh: '合同审阅' },
  humanizer: { ko: '자연스러운 글', en: 'Natural writing', id: 'Tulisan alami', ja: '自然な文章', es: 'Escritura natural', zh: '自然文风' },
  'intro-deck': { ko: '회사 소개서', en: 'Company slide deck', id: 'Slide perusahaan', ja: '会社紹介資料', es: 'Dosier de empresa', zh: '公司介绍资料' },
  'card-news': { ko: '카드뉴스', en: 'Promo cards', id: 'Kartu promosi', ja: '紹介カード', es: 'Tarjetas promocionales', zh: '宣传卡片' },
  'promo-video': { ko: '홍보 영상', en: 'Promo video', id: 'Video promosi', ja: '紹介動画', es: 'Vídeo promocional', zh: '宣传视频' },
}

/** A kept skill's display name in `locale` (the name itself for one that is not a kept skill). */
export const packTitle = (name: string, locale: Locale): string => TITLE[name]?.[locale] ?? name
/** Whether `title` is still one a kept skill ships with (any language) or its bare name: not a title the team wrote. */
export const isPackTitle = (name: string, title: string): boolean => title === name || Object.values(TITLE[name] ?? {}).includes(title)

// The examples (EXAMPLES-PLAN.md; FLOW-v6 §2.2, §8): skill-examples.ts, which the web tests' mock server imports too.
export { exampleBody, PACK_EXAMPLES, packExample } from './skill-examples'

/** Whether the team has this kept skill: its own path, or another team skill of its name ("/<name>" would run either
 * one, so placeSkill blocks it). */
function inTeam(ctx: AppContext, rel: string, name: string, team: { path: string; name: string }[]): boolean {
  const fold = (p: string) => (ctx.files.fx.caseInsensitive ? p.normalize('NFC').toLowerCase() : p)
  return team.some((s) => fold(s.path) === fold(rel) || sameSkillName(s.name, name))
}

/** Where the setup puts a skill for this team: a `checked` skill whose text the team gets in another language (English
 * for a team in a language it has no text in: natural writing on a Japanese team) is offered unchecked. */
export const setupMark = (mark: PackOnboarding | null, at: Locale, team: Locale): PackOnboarding | null => (mark === 'checked' && at !== team ? 'offered' : mark)

/** The catalog as `userId` (an owner or admin) sees it: every kept skill, in CATALOG's order, its text and example in
 * the team's language; its name and one line in the caller's (`locale`: the viewer's UI language). */
export function skillPackCatalog(ctx: AppContext, userId: string, locale: Locale): PackCatalog {
  const me = ctx.files.principal(userId)
  const team = teamDefaultLocale(ctx.db)
  const teamSkills = listTeamSkills(ctx.files, me).map((s) => ({ path: s.path, name: s.name }))
  const skills: PackCatalogSkill[] = CATALOG.flatMap((c) => {
    const pack = SKILL_PACKS[c.pack]
    const at = skillLocale(pack, c.name, team)
    const text = pack.skills[at]?.[c.name]
    if (!text) return []
    const path = `skills/${c.pack}/${c.name}/SKILL.md`
    return [{
      pack: c.pack, name: c.name, path, title: packTitle(c.name, locale), description: packSummary(c.name, locale),
      inTeam: inTeam(ctx, path, c.name, teamSkills), visual: c.visual, onboarding: setupMark(c.onboarding, at, team), example: packExample(at, c.name, team), locale: at, source: c.source(at),
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
