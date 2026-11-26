// Personal skills the AI keeps on its own (docs/decisions/20261125-auto-personal-skills.md). The AI writes them with the
// plain write and edit tools; this is the turn's gate around those calls, before any other card:
// - only <name>/SKILL.md of text (skills/personal-guard.ts, also checked by the file layer);
// - the places of auto memory (TurnExec.autoMemoryPlace: no ✦ side chat, confidential chat, scheduled run, Slack,
//   template or guest) for every save; the switch "자동으로 기억하기" off: a new skill only when the person's own message
//   explicitly asks for one (asksForSkill, its one use);
// - for every save: the asker's own words only (auto memory's copy and address checks), AUTO_SKILLS_PER_ANSWER and
//   AUTO_SKILLS_PER_DAY (different skills a day: refining one skill again counts once);
// - a skill the AI made itself (`metadata: origin: auto`, written by the server) changes and goes to the trash with no
//   card; any other personal skill (the person wrote it or asked for it) only after the person's yes on a server card
//   that shows the change (and the file layer holds the approval for exactly those bytes: skills/guard.ts);
// - after the save: the step "스킬 저장함 / 고침 / 지움: <name>" with 보기 and 되돌리기 (web Steps.tsx, the file routes).
import fs from 'node:fs'
import path from 'node:path'
import type { Step, TurnRequest } from '@mycel/shared/api'
import crypto from 'node:crypto'
import { sha256 } from '../files/store'
import { readSkillTitle } from '@mycel/shared/api'
import { lineDiff } from '../skills/diff'
import { authorize } from '../policy/authorize'
import { checkSkill } from './skills'
import { audit } from '../admin/audit'
import { editedText, inPersonalSkills } from '../skills/guard'
import { ORIGIN_LINE, originAuto, personalSkillName, personalSkillProblem, PERSONAL_SKILL_FILES_REFUSAL, withOrigin } from '../skills/personal-guard'
export { originAuto, withOrigin }
import { addressesIn, autoMemoryOn, contactNotOwn, copiedFromOutside, othersWords, outsideAddress, ownWords, stripInvisible } from './auto-memory'
import { askerMessageId } from './asked-in'
import { withoutQuoteLines } from './read-rooms'
import { isGuestUser } from '../credentials/guest-ai'
import { tr } from './i18n'
import type { TurnExec } from './turn'
import type { StoredStep } from './store'

/** skill saves, changes and deletes: per answer (each call counts), and different skills per 24 hours (QA of #606: a
 * person refining one skill a few times hit the day's limit; the same skill again counts once) */
export const AUTO_SKILLS_PER_ANSWER = 2
export const AUTO_SKILLS_PER_DAY = 6

// ---------------- the person asks for a skill ----------------

// An explicit request to save, make, change or delete a skill (review of #594: a sentence that only mentions skills,
// "Tell me how to add skills in Claude.", must not count): the skill word and a request form of the verb in one
// sentence, in the app's six languages. A question or a refusal in the same sentence never counts.
const ASKS: RegExp[] = [
  // ko: "스킬로 저장해 줘", "이 스킬 고쳐 줘", "주간 보고 스킬 지워 주세요"
  /스킬.{0,30}?(?:저장|만들어|남겨|추가|등록|고쳐|수정|바꿔|지워|삭제)\s*(?:해\s*)?(?:줘|주세요|줄래|둬|두세요|놔|해요|하자|해)/u,
  // en: an imperative at the start of the sentence ("save this as a skill", "please update my weekly skill")
  /^(?:(?:please|pls|also|and|so|ok|okay|now|just|hey)[\s,]+)*(?:save|make|create|turn|keep|add|update|fix|change|edit|delete|remove)\b[^,;:]{0,60}?(?<![/\w])skills?(?![/\w])/iu,
  // ja: "スキルにして", "スキルを直して", "スキルとして保存して"
  /スキル.{0,20}?(?:にして|保存して|作って|作成して|追加して|直して|更新して|変更して|削除して)/u,
  // zh: "把这个保存为技能", "删除这个技能", "修改周报技能"
  /(?:保存|做成|创建|添加|新建|修改|更新|删除)(?:为|成)?.{0,12}?技能|技能.{0,12}?(?:保存|修改|更新|删除)一下/u,
  // es: "guarda esto como habilidad"
  /^(?:(?:por\s+favor|y|también)[\s,]+)*(?:guarda|crea|haz|añade|actualiza|cambia|borra|elimina)\b[^,;:]{0,60}?\bhabilidad(?:es)?\b/iu,
  // id: "simpan ini sebagai skill"
  /^(?:(?:tolong|harap|mohon|dan)\s+)*(?:simpan|buat|tambah|perbarui|ubah|hapus)(?:kan|lah)?\b[^,;:]{0,60}?(?<![/\w])(?:skill|keterampilan)(?![/\w])/iu,
]
const NOT = /지\s*마|하지\s*않|말아|\b(?:don['\u2019]?t|do\s+not|never)\b|ないで|不要|别|別|jangan/iu

/** The person's own message, cut into sentences, quote lines left out by the caller. */
const sentences = (m: string) => stripInvisible(m).normalize('NFKC').split(/(?<=[.!?。！？\n])/u).map((x) => x.trim()).filter(Boolean)

/** Does the person's own message explicitly ask to save, make, change or delete a skill? */
export function asksForSkill(message: string | null | undefined): boolean {
  if (!message) return false
  return sentences(message).some((s) => !/[?？]$/u.test(s) && !NOT.test(s) && ASKS.some((re) => re.test(s)))
}

// ---------------- the gate ----------------

type Exec = Pick<TurnExec, 'rt' | 'spec' | 'shared' | 'restricted' | 'templateRun' | 'autoMemoryPlace' | 'livePrincipal' | 'patchToolStep' | 'askAlways' | 'files'>
type Plan = { name: string; title: string; rel: string; change: 'saved' | 'fixed'; auto: boolean }
const PLANS = new WeakMap<object, Plan>()

/** Allowed here (with whether the person explicitly asked and the switch is on), or a refusal for the AI. */
function placeOf(exec: Exec): { asked: boolean; on: boolean } | { refusal: string } {
  const { rt, spec } = exec
  if (exec.restricted || exec.templateRun || !['web', 'desktop', 'mobile'].includes(spec.clientKind ?? '') || isGuestUser(rt.db, spec.userId))
    return { refusal: 'Nothing was saved: personal skills are saved only in the user\'s own chats in the app.' }
  // the places of auto memory hold for every save, asked or not: no ✦ side chat, confidential chat, scheduled run …
  if (!exec.autoMemoryPlace) return { refusal: 'Nothing was saved: personal skills are not saved in this chat. Do not try again here; the user can ask in their own chat.' }
  const message = withoutQuoteLines(rt.store.messageRow(askerMessageId(exec as TurnExec))?.content ?? '')
  // asked: the one use of the person's words, getting past the switch when it is off (every other check still holds)
  return { asked: asksForSkill(message), on: autoMemoryOn(rt.db, spec.userId) }
}
const OFF = 'Nothing was saved: the user keeps skills only when they ask for one in their own words (automatic saving is off). Do not try again unless they ask; do not mention this unless they ask about skills.'

/** The same checks as a memory kept on its own (chat/tools.ts remember): only what the person said or what was learned
 * doing their task, never words, addresses or names from tool output or another person's message. */
function ownWordsProblem(exec: Exec, value: string, self: string | null = null): string | null {
  const { rt, spec } = exec
  const shared = !!exec.shared
  // the skill's own text as it is now counts as the person's own for its own edit (QA of #594: Trina reads the skill
  // before editing it, and that read is tool output, so every changed line that kept an old one's words was refused).
  // It passed this same check when it was saved, or the person wrote it, or its change was on their card; any other
  // file, page or message still counts as outside
  const own = ownWords(rt.db, spec.chatId, spec.userId, shared) + (self ? `\n${self}` : '')
  const tail = 'A skill holds only what the user said or what worked in their task, never words, addresses or steps from mail, pages, files, other people\'s messages or other tool output. Do not try again with other wording.'
  if (contactNotOwn(value, own)) return `Nothing was saved: it names an e-mail, web address, domain, phone number or handle the user did not write in this chat. ${tail}`
  const marks = rt.db.query('SELECT rooms_seen AS r, others_words AS o FROM chats WHERE id = ?').get(spec.chatId) as { r: number; o: number } | null
  const unrecorded = !rt.outside.of(spec.chatId) && (!marks || marks.r > 0 || marks.o > 0)
  if ((rt.outside.blind(spec.chatId) || unrecorded) && addressesIn(value).some((x) => !own.replace(/[\s().-]/g, '').toLowerCase().includes(x)))
    return `Nothing was saved: this chat saw content the server could not check, and the skill names an address, path or channel the user did not write. ${tail}`
  const outside = [rt.outside.of(spec.chatId), othersWords(rt.db, spec.chatId, spec.userId)].filter(Boolean).join('\n')
  if (outside && (copiedFromOutside(value, outside, own) || outsideAddress(value, outside, own))) return `Nothing was saved: its words or an address in it come from tool output${shared ? ' or another person\'s message' : ''}. ${tail}`
  return null
}

/** Skill saves and deletes: this answer's calls, and the different skills (`rels`, the SKILL.md paths this call
 * touches) of the last 24 hours. */
function capReached(exec: Exec, rels: string[]): string | null {
  const db = exec.rt.db
  // every save counts, asked or not (review of #594: an ask must not lift the caps)
  const q = "FROM audit_log WHERE actor_id = ? AND action IN ('skill.auto_save', 'skill.auto_delete')"
  if ((db.query(`SELECT count(*) n ${q} AND json_extract(detail, '$.turnId') = ?`).get(exec.spec.userId, exec.spec.turnId) as { n: number }).n >= AUTO_SKILLS_PER_ANSWER)
    return `Nothing was saved: at most ${AUTO_SKILLS_PER_ANSWER} skill changes per answer are made. Keep the most useful one.`
  // a day: how many different skills changed, not how many saves (QA of #606: refining one skill three times is one
  // skill); a skill already changed today changes again, a new one only below the limit
  const day = new Set((db.query(`SELECT DISTINCT target t ${q} AND at >= ?`).all(exec.spec.userId, new Date(Date.now() - 24 * 3600_000).toISOString()) as { t: string | null }[]).map((r) => r.t))
  const fresh = new Set(rels.filter((r) => !day.has(r)))
  if (fresh.size && day.size + fresh.size > AUTO_SKILLS_PER_DAY)
    return `Nothing was saved: at most ${AUTO_SKILLS_PER_DAY} different skills change in a day, and that is reached. A skill already changed today can still be fixed. Do not try a new one again today.`
  return null
}

/** The file tools' gate (chat/tools.ts beforeFileTool), before any card: a write, edit or edit_files into a person's own
 * skills folder. Returns the refusal, or null (not such a call, or allowed: the step is made after the save). A new
 * skill saved on its own gets `origin: auto` written into its header here (the call's own arguments). */
export async function beforeSkillWrite(exec: Exec, tool: string, args: unknown, main = true): Promise<string | null> {
  if (!args || typeof args !== 'object') return null
  const a = args as Record<string, unknown>
  const { rt } = exec
  const me = exec.livePrincipal()
  const resolve = (p: unknown) => { if (typeof p !== 'string') return null; try { return authorize(rt.files.fx, rt.files.rules(), me, p, 'write', { createDirs: true }) } catch { return null } }
  if (tool === 'edit_files') {
    const edits = Array.isArray(a.edits) ? a.edits : []
    return edits.some((e) => { const r = resolve((e as { file_path?: unknown } | null)?.file_path); return !!r && inPersonalSkills(r.rel) }) ? 'Nothing was changed: change a personal skill with write or edit, one call for its SKILL.md.' : null
  }
  if (tool !== 'write' && tool !== 'edit') return null
  const r = resolve(a.file_path)
  if (!r || !inPersonalSkills(r.rel)) return null
  const name = personalSkillName(r.rel)
  if (!name || r.segs[1] !== me.id) return PERSONAL_SKILL_FILES_REFUSAL
  // the main AI's own call: a sub-agent reports to it (the step and its 되돌리기 are the main AI's)
  if (!main) return 'Nothing was saved: a personal skill is saved by the main assistant, not a sub-task. Say in your report what should be kept.'
  const place = placeOf(exec)
  if ('refusal' in place) return place.refusal
  let before: string | null = null
  try { before = r.exists ? fs.readFileSync(r.abs, 'utf8') : null } catch { before = null }
  const theirs = before !== null && !originAuto(before)
  // the switch: a new skill or a change to one the AI made needs it on, or the person's explicit ask; a change to the
  // person's own skill asks on its card instead
  if (!theirs && !place.on && !place.asked) return OFF
  const auto = !place.asked
  let after: string
  if (tool === 'write') {
    if (typeof a.content !== 'string') return null
    // the origin: a new skill kept on its own is marked auto, one the person asked for is theirs; a change keeps it
    after = withOrigin(a.content, before === null ? auto : originAuto(before))
    a.content = after
  } else {
    if (before === null || typeof a.old_string !== 'string' || typeof a.new_string !== 'string') return null
    after = editedText(before, a.old_string, a.new_string, a.replace_all === true)
    if (originAuto(after) !== originAuto(before) || withOrigin(after, originAuto(after)) !== after) return 'Nothing was changed: leave the skill\'s "origin" line to the server; do not add, move or remove it.'
  }
  const problem = personalSkillProblem(r.rel, Buffer.from(after, 'utf8'))
  if (problem) return problem
  // own words and the caps for every save, asked or not: only the header's name and origin lines are left out (review
  // of #594: the description and the body are checked like the rest)
  const seen = new Set((before ?? '').split('\n').map((l) => l.trim()))
  const header = (l: string) => /^---\s*$/.test(l) || l.trim() === `name: ${name}` || /^metadata:\s*$/.test(l) || ORIGIN_LINE.test(l)
  const fresh = after.split('\n').filter((l) => !seen.has(l.trim()) && !header(l)).join('\n')
  const own = fresh.trim() ? ownWordsProblem(exec, fresh, before) : null
  if (own) return own
  const cap = capReached(exec, [r.rel])
  if (cap) return cap
  // a skill the AI did not make (the person wrote it or asked for it): only with the person's yes on the card, which
  // shows the change; the yes is an approval for exactly these bytes (skills/guard.ts requireSkillApproval)
  if (theirs) {
    const no = await askOwnSkill(exec, 'change', [{ name, rel: r.rel, before: before!, after }])
    if (no) return no
    exec.files.skillApprovals.set(r.rel, sha256(Buffer.from(after, 'utf8')))
  }
  PLANS.set(args, { name, title: titleOf(after, r.rel, name), rel: r.rel, change: before === null ? 'saved' : 'fixed', auto })
  return null
}

/** The skill's name as people read it (its `metadata: title`, in their language), else the first heading of its text
 * (a skill the person wrote by hand often has "# 회의록 정리" and no title), else its folder name: the step line and the
 * cards say this, never the file or its path (QA of #594: "SKILL.md" and "/weekly-report" in the notice). */
export function titleOf(text: string, rel: string, name: string): string {
  const c = checkSkill(text, rel)
  if (c.ok && c.title) return c.title
  const body = c.ok ? c.body : text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '')
  // (not a "#" line inside a code block)
  const heading = /^#{1,3}[ \t]+(.+?)[ \t#]*$/m.exec(body.replace(/^(```|~~~)[\s\S]*?^\1/gm, ''))?.[1]?.replace(/[*_`]/g, '').trim()
  return readSkillTitle(heading) ?? name
}

/** The card for a change or a delete of the person's own skills that the AI did not make. null: yes. */
async function askOwnSkill(exec: Exec, what: 'change' | 'delete', items: { name: string; rel: string; before: string; after?: string }[]): Promise<string | null> {
  const L = exec.spec.locale
  const names = items.map((i) => `"${titleOf(i.before, i.rel, i.name)}"`).join(', ')
  const one = items[0]!
  const d = what === 'change' ? lineDiff(one.before, one.after ?? '') : lineDiff(one.before, '')
  const req = {
    kind: 'ask_user', origin: 'server', requestId: crypto.randomUUID(),
    question: tr(what === 'change' ? 'ownSkillChangeConfirm' : 'ownSkillDeleteConfirm', L, { names }),
    options: [{ label: tr(what === 'change' ? 'ownSkillSave' : 'ownSkillDelete', L), value: 'save' }, { label: tr('ownSkillDont', L), value: 'skip' }],
    multiple: false, allowText: false,
    preview: { kind: 'skill_write', path: one.rel, isNew: false, skillName: one.name, diff: d.text, added: d.added, removed: d.removed, truncated: d.truncated },
    expiresAt: new Date(Date.now() + exec.rt.askUserTimeoutMs()).toISOString(),
  } as TurnRequest & { options: { label: string; value: string }[] }
  const { value, missing } = await exec.askAlways('skill_save', req, 'save', { label: 'cardAlwaysSkills' })
  const picked = Array.isArray(value) && value.length === 1 ? value[0] : value
  if (picked === 'save') return null
  audit(exec.rt.db, { actor: exec.spec.userId, action: 'skills.ai_write_refused', target: one.rel, detail: { what, turnId: exec.spec.turnId, answer: missing ? 'none' : 'declined' } })
  return missing
    ? `Nothing was ${what === 'change' ? 'changed' : 'deleted'}: ${names} ${items.length === 1 ? 'is a skill' : 'are skills'} the user wrote or asked for, and their yes on the card did not come (${missing}). Do not try again unless they ask.`
    : `The user did not allow ${what === 'change' ? 'changing' : 'deleting'} their skill ${names}, so nothing was ${what === 'change' ? 'changed' : 'deleted'}. Do not try again unless they ask.`
}

/** Is this the first skill the AI keeps on its own for the person (the step's one-time line)? Marks it seen. */
function firstAutoSkill(exec: Exec): boolean {
  const db = exec.rt.db
  try {
    const r = db.query('SELECT prefs FROM users WHERE id = ?').get(exec.spec.userId) as { prefs: string | null } | null
    const p = JSON.parse(r?.prefs || '{}') as Record<string, unknown>
    if (p.autoSkillNotice === 'seen') return false
    db.query('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify({ ...p, autoSkillNotice: 'seen' }), exec.spec.userId)
    return true
  } catch { return false }
}

/** After the save (chat/tools.ts afterFileTool): the step says what Trina learned, with what 되돌리기 needs. */
export function afterSkillWrite(exec: Exec, tool: string, args: unknown, isError: boolean): void {
  const plan = args && typeof args === 'object' ? PLANS.get(args) : undefined
  if (!plan) return
  PLANS.delete(args as object)
  if (isError) return
  const { rt, spec } = exec
  // a change keeps the text before as a file version (files/service.ts saveVersion): 되돌리기 restores it
  const version = plan.change === 'fixed' ? (rt.db.query('SELECT id FROM file_versions WHERE path = ? AND turn_id = ? ORDER BY version DESC LIMIT 1').get(plan.rel, spec.turnId) as { id: string } | null)?.id : undefined
  audit(rt.db, { actor: spec.userId, action: 'skill.auto_save', target: plan.rel, detail: { change: plan.change, auto: plan.auto, turnId: spec.turnId } })
  const first = plan.auto && firstAutoSkill(exec)
  const skill: NonNullable<Step['skill']> = { name: plan.title, path: plan.rel, change: plan.change, ...(version ? { versionId: version } : {}), ...(first ? { first: true as const } : {}) }
  exec.patchToolStep(tool, () => ({ label: tr(plan.change === 'saved' ? 'skillSaved' : 'skillFixed', spec.locale, { name: plan.title }), skill } as Partial<StoredStep>))
}

/** delete_files of the person's own skills (each folder holds only its SKILL.md), to the trash: one the AI made on its own
 * (`origin: auto`) with no card, any other only after the person's yes on a card that names it. One step "스킬 지움:
 * <names>" whose 되돌리기 restores every one. null: not such a call (delete_files itself goes on, and refuses skill folders). */
export async function deletePersonalSkills(exec: Exec, args: unknown): Promise<{ text: string; isError?: boolean } | null> {
  const paths = (args as { paths?: unknown } | null)?.paths
  if (!Array.isArray(paths) || !paths.length) return null
  const { rt, spec } = exec
  const me = exec.livePrincipal()
  const skills: { name: string; rel: string; dir: string; text: string; auto: boolean }[] = []
  for (const p of paths) {
    if (typeof p !== 'string') return null
    let r
    try { r = authorize(rt.files.fx, rt.files.rules(), me, p.replace(/\/+$/, ''), 'write', { mustExist: true }) } catch { return null }
    const rel = r.st!.isDirectory() ? `${r.rel}/SKILL.md` : r.rel
    const name = personalSkillName(rel)
    if (!name || r.segs[1] !== me.id) return null
    const dir = path.join(rt.files.fx.root, ...rel.split('/').slice(0, -1))
    let text: string | null = null
    try { text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8') } catch { return null }
    if (fs.readdirSync(dir).some((f) => f !== 'SKILL.md')) return null
    skills.push({ name, rel, dir, text, auto: originAuto(text) })
  }
  const place = placeOf(exec)
  if ('refusal' in place) return { text: place.refusal, isError: true }
  if (skills.some((x) => x.auto) && !place.on && !place.asked) return { text: OFF, isError: true }
  const capped = capReached(exec, skills.map((x) => x.rel))
  if (capped) return { text: capped, isError: true }
  const own = skills.filter((x) => !x.auto)
  if (own.length) {
    const no = await askOwnSkill(exec, 'delete', own.map((x) => ({ name: x.name, rel: x.rel, before: x.text })))
    if (no) return { text: no, isError: true }
  }
  const done: string[] = [], trashIds: string[] = []
  for (const x of skills) {
    trashIds.push(rt.files.deleteFile(spec.userId, x.rel, spec.turnId))
    try { fs.rmdirSync(x.dir) } catch { /* not empty: it stays */ }
    audit(rt.db, { actor: spec.userId, action: 'skill.auto_delete', target: x.rel, detail: { auto: x.auto && !place.asked, turnId: spec.turnId } })
    done.push(titleOf(x.text, x.rel, x.name))
  }
  // one step for the call, with every trash item: its 되돌리기 brings all of them back
  exec.patchToolStep('delete_files', () => ({ label: tr('skillDeleted', spec.locale, { name: done.join(', ') }), skill: { name: done.join(', ').slice(0, 200), path: skills[0]!.rel, change: 'deleted', trashIds } } as Partial<StoredStep>))
  return { text: `Deleted the user's own skill${done.length === 1 ? '' : 's'} ${done.map((n) => `"${n}"`).join(', ')} (in the trash; the step under your answer can undo it).` }
}
