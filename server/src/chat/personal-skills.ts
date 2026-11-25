// Personal skills the AI keeps on its own (docs/decisions/20261125-auto-personal-skills.md). The AI writes them with the
// plain write and edit tools (no card); this is the turn's gate around those calls, before any card:
// - only <name>/SKILL.md of text (skills/personal-guard.ts, also checked by the file layer);
// - the auto-memory rules: the switch "자동으로 기억하기" and the places of auto memory (TurnExec.autoMemoryPlace); off,
//   or a ✦ side chat, a confidential chat …, a skill is saved only when the person's own message asks for one; never a
//   guest, a scheduled run, Slack or a template run;
// - on its own: the asker's own words only (auto memory's copy and address checks), AUTO_SKILLS_PER_ANSWER and
//   AUTO_SKILLS_PER_DAY, and a change only to a skill it made itself (`metadata: origin: auto`, which the server writes);
// - after the save: the step "스킬 저장함 / 고침: <name>" with 보기 and 되돌리기 (web Steps.tsx, through the file routes).
// delete_files moves an origin:auto personal skill to the trash with no card (deleteAutoSkills).
import fs from 'node:fs'
import path from 'node:path'
import type { Step } from '@mycel/shared/api'
import { authorize } from '../policy/authorize'
import { audit } from '../admin/audit'
import { editedText, inPersonalSkills } from '../skills/guard'
import { personalSkillName, personalSkillProblem, PERSONAL_SKILL_FILES_REFUSAL } from '../skills/personal-guard'
import { addressesIn, autoMemoryOn, contactNotOwn, copiedFromOutside, othersWords, outsideAddress, ownWords, stripInvisible } from './auto-memory'
import { askerMessageId } from './asked-in'
import { withoutQuoteLines } from './read-rooms'
import { isGuestUser } from '../credentials/guest-ai'
import { tr } from './i18n'
import type { TurnExec } from './turn'
import type { StoredStep } from './store'

/** saves the person did not ask for: per answer and per 24 hours (a new skill, a change and a delete each count) */
export const AUTO_SKILLS_PER_ANSWER = 2
export const AUTO_SKILLS_PER_DAY = 6

// ---------------- origin: auto (in the header's metadata) ----------------

const HEADER = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/
const ORIGIN_LINE = /^[ \t]+origin:[ \t]*["']?auto["']?[ \t]*\r?$/m

/** The skill was made by the AI on its own: `metadata:` holds `origin: auto`. */
export function originAuto(text: string | null): boolean {
  const h = text ? HEADER.exec(text) : null
  if (!h) return false
  const meta = /^metadata:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m.exec(h[2]!)
  return !!meta && ORIGIN_LINE.test(meta[1]!)
}

/** `text` with `origin: auto` in its metadata (`auto`) or without it. Text without a header stays as it is. */
export function withOrigin(text: string, auto: boolean): string {
  const h = HEADER.exec(text)
  if (!h || originAuto(text) === auto) return text
  let head = h[2]!
  if (auto) head = /^metadata:[ \t]*$/m.test(head) ? head.replace(/^metadata:[ \t]*$/m, 'metadata:\n  origin: auto') : `${head}\nmetadata:\n  origin: auto`
  else head = head.replace(/^[ \t]+origin:[ \t]*["']?auto["']?[ \t]*(?:\r?\n|$)/gm, '').replace(/^metadata:[ \t]*\r?\n(?![ \t])/gm, '').replace(/\r?\nmetadata:[ \t]*$/, '').replace(/\n+$/, '')
  const out = h[1] + head + h[3] + text.slice(h[0].length)
  // every origin line is gone (review of #594: only the first one was taken out)
  if (originAuto(out) !== auto) throw new Error('origin line not changed')
  return out
}

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

/** Does the message name the skill `name` ("weekly-sales-report", also as "weekly sales report")? */
export function namesSkill(message: string | null | undefined, name: string): boolean {
  if (!message) return false
  const m = stripInvisible(message).normalize('NFKC').toLowerCase()
  const n = name.normalize('NFKC').toLowerCase()
  // as a word of its own, not inside a path or a longer name ("users/…/skills/weekly/SKILL.md" is no naming)
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [n, n.replace(/-/g, ' ')].some((x) => new RegExp(`(?<![\\p{L}\\p{N}/_-])${esc(x)}(?![\\p{L}\\p{N}/_-])`, 'u').test(m))
}

// ---------------- the gate ----------------

type Exec = Pick<TurnExec, 'rt' | 'spec' | 'shared' | 'restricted' | 'templateRun' | 'autoMemoryPlace' | 'livePrincipal' | 'patchToolStep'>
type Plan = { name: string; rel: string; change: 'saved' | 'fixed'; auto: boolean }
const PLANS = new WeakMap<object, Plan>()

/** Saved on its own (not asked) and allowed here, or a refusal for the AI; `asked`: the person's own words. */
function placeOf(exec: Exec): { auto: boolean; message: string } | { refusal: string } {
  const { rt, spec } = exec
  if (exec.restricted || exec.templateRun || !['web', 'desktop', 'mobile'].includes(spec.clientKind ?? '') || isGuestUser(rt.db, spec.userId))
    return { refusal: 'Nothing was saved: personal skills are saved only in the user\'s own chats in the app.' }
  // the places of auto memory hold for every save, asked or not: no ✦ side chat, confidential chat, scheduled run …
  if (!exec.autoMemoryPlace) return { refusal: 'Nothing was saved: personal skills are not saved in this chat. Do not try again here; the user can ask in their own chat.' }
  const message = withoutQuoteLines(rt.store.messageRow(askerMessageId(exec as TurnExec))?.content ?? '')
  if (asksForSkill(message)) return { auto: false, message }
  // the switch off: only an explicit request in the person's own words
  if (!autoMemoryOn(rt.db, spec.userId))
    return { refusal: 'Nothing was saved: the user keeps skills only when they ask for one in their own words (automatic saving is off). Do not try again unless they ask; do not mention this unless they ask about skills.' }
  return { auto: true, message }
}

/** The same checks as a memory kept on its own (chat/tools.ts remember): only what the person said or what was learned
 * doing their task, never words, addresses or names from tool output or another person's message. */
function ownWordsProblem(exec: Exec, value: string): string | null {
  const { rt, spec } = exec
  const shared = !!exec.shared
  const own = ownWords(rt.db, spec.chatId, spec.userId, shared)
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

/** Skill saves and deletes, this answer and the last 24 hours. */
function capReached(exec: Exec): string | null {
  const db = exec.rt.db
  // every save counts, asked or not (review of #594: an ask must not lift the caps)
  const q = "SELECT count(*) n FROM audit_log WHERE actor_id = ? AND action IN ('skill.auto_save', 'skill.auto_delete')"
  if ((db.query(`${q} AND json_extract(detail, '$.turnId') = ?`).get(exec.spec.userId, exec.spec.turnId) as { n: number }).n >= AUTO_SKILLS_PER_ANSWER)
    return `Nothing was saved: at most ${AUTO_SKILLS_PER_ANSWER} skill changes per answer are made. Keep the most useful one.`
  if ((db.query(`${q} AND at >= ?`).get(exec.spec.userId, new Date(Date.now() - 24 * 3600_000).toISOString()) as { n: number }).n >= AUTO_SKILLS_PER_DAY)
    return 'Nothing was saved: the daily number of skill changes is reached. Do not try again today.'
  return null
}

/** The file tools' gate (chat/tools.ts beforeFileTool), before any card: a write, edit or edit_files into a person's own
 * skills folder. Returns the refusal, or null (not such a call, or allowed: the step is made after the save). A new
 * skill saved on its own gets `origin: auto` written into its header here (the call's own arguments). */
export function beforeSkillWrite(exec: Exec, tool: string, args: unknown, main = true): string | null {
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
  let after: string
  if (tool === 'write') {
    if (typeof a.content !== 'string') return null
    // the origin: a new skill kept on its own is marked auto, one the person asked for is theirs; a change keeps it
    after = withOrigin(a.content, before === null ? place.auto : originAuto(before))
    a.content = after
  } else {
    if (before === null || typeof a.old_string !== 'string' || typeof a.new_string !== 'string') return null
    after = editedText(before, a.old_string, a.new_string, a.replace_all === true)
    if (originAuto(after) !== originAuto(before)) return 'Nothing was changed: leave the skill\'s "origin" line as it is.'
  }
  // a skill the person wrote or asked for: changed only when their own message asks to change that very skill (names
  // it, or it is the skill loaded for this answer), never on its own (review of #594)
  if (before !== null && !originAuto(before)) {
    const loaded = !!rt.db.query('SELECT 1 FROM turn_skill_runs WHERE turn_id = ? AND skill_path = ? AND source IN (\'command\', \'tool\')').get(exec.spec.turnId, r.rel)
    if (place.auto || !(namesSkill(place.message, name) || loaded))
      return `Nothing was changed: "${name}" is a skill the user wrote or asked for. Change it only when their own message asks to change that skill.`
  }
  const problem = personalSkillProblem(r.rel, Buffer.from(after, 'utf8'))
  if (problem) return problem
  // own words and the caps for every save, asked or not: only the header's name and origin lines are left out (review
  // of #594: the description and the body are checked like the rest)
  const seen = new Set((before ?? '').split('\n').map((l) => l.trim()))
  const header = (l: string) => /^---\s*$/.test(l) || l.trim() === `name: ${name}` || /^metadata:\s*$/.test(l) || ORIGIN_LINE.test(l)
  const fresh = after.split('\n').filter((l) => !seen.has(l.trim()) && !header(l)).join('\n')
  const own = fresh.trim() ? ownWordsProblem(exec, fresh) : null
  if (own) return own
  const cap = capReached(exec)
  if (cap) return cap
  PLANS.set(args, { name, rel: r.rel, change: before === null ? 'saved' : 'fixed', auto: place.auto })
  return null
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
  const skill: NonNullable<Step['skill']> = { name: plan.name, path: plan.rel, change: plan.change, ...(version ? { versionId: version } : {}), ...(first ? { first: true as const } : {}) }
  exec.patchToolStep(tool, () => ({ label: tr(plan.change === 'saved' ? 'skillSaved' : 'skillFixed', spec.locale, { name: plan.name }), skill } as Partial<StoredStep>))
}

/** delete_files of skills the AI made on its own (`origin: auto`, the skill's folder holds only its SKILL.md): to the
 * trash with no card, each a step "스킬 지움: <name>" whose 되돌리기 restores it. null: not such a call (delete_files
 * itself goes on, and refuses skill folders). */
export function deleteAutoSkills(exec: Exec, args: unknown): { text: string; isError?: boolean } | null {
  const paths = (args as { paths?: unknown } | null)?.paths
  if (!Array.isArray(paths) || !paths.length) return null
  const { rt, spec } = exec
  const me = exec.livePrincipal()
  const skills: { name: string; rel: string; dir: string }[] = []
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
    if (!originAuto(text) || fs.readdirSync(dir).some((f) => f !== 'SKILL.md')) return null
    skills.push({ name, rel, dir })
  }
  const place = placeOf(exec)
  if ('refusal' in place) return { text: place.refusal, isError: true }
  const done: string[] = [], trashIds: string[] = []
  let capped: string | null = null
  for (const s of skills) {
    capped = capReached(exec)
    if (capped) break
    trashIds.push(rt.files.deleteFile(spec.userId, s.rel, spec.turnId))
    try { fs.rmdirSync(s.dir) } catch { /* not empty: it stays */ }
    audit(rt.db, { actor: spec.userId, action: 'skill.auto_delete', target: s.rel, detail: { auto: place.auto, turnId: spec.turnId } })
    done.push(s.name)
  }
  // one step for the call, with every trash item: its 되돌리기 brings all of them back (review of #594)
  if (done.length) exec.patchToolStep('delete_files', () => ({ label: tr('skillDeleted', spec.locale, { name: done.join(', ') }), skill: { name: done.join(', ').slice(0, 200), path: skills[0]!.rel, change: 'deleted', trashIds } } as Partial<StoredStep>))
  if (capped) return { text: capped + (done.length ? ` Deleted already: ${done.join(', ')}.` : ''), isError: true }
  return { text: `Deleted the user's own skill${done.length === 1 ? '' : 's'} ${done.map((n) => `"${n}"`).join(', ')} (in the trash; the step under your answer can undo it).` }
}
