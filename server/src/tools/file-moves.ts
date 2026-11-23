// The AI's move_files / copy_files / rename_file (mcp__team__<name>): the Files screen's move, copy and rename for any
// kind of file. `write` only saves text, so before these the AI could not put a PDF or an image a person attached in a
// chat into a team folder ("I can only save text files", 2026-10-28). Every path goes through the same checks as the
// Files screen (TeamFiles.move / copy: write access at both ends, managed folders for admins and owners only, nothing
// under users/ for rule folders, root / users / .system never move).
// Who can see the files: when the result lets more people read something, or fewer people keep reading it, the server
// asks the person once for the whole call on its own card (never the AI's ask_user, so an instruction hidden in a
// document cannot answer it). With nobody to ask (a scheduled run, no chat turn) such a call is refused, and the AI is
// told that nobody was asked (not "the user did not allow this"; policy/refusal.ts).
// Many changes in a place other people use (QA TC-r2u-25: 15 files of a folder 18 people see renamed and moved with no
// card): past BULK_CHANGE_FREE items in one answer, moved or renamed where someone else can read them, the server asks
// once on its own card that lists them; the yes covers the rest of that answer's moves and renames. The person's own
// "Always allow" for moves (kind move_files, Rule A) goes without it; a run with nobody to ask (a scheduled task the
// person set up, a call outside a chat) is not asked.
// A target folder that is not there yet is made after the card (docs/DECISIONS.md "move_files and copy_files make the
// target folder"); the card says it is new.
// Skill folders (skills/, a group's, a project's: what people's AI follows) are out of reach here: a skill changes only
// through write / edit with the person's approval on the card, and moves to another level with move_skill.
import { readThisAnswer } from '../files/service'
import { placeWords } from '../chat/place-words'
import { CopyFilesInput, MoveFilesInput, RENAME_FILES_MAX, RenameFileInput, RenameFilesInput } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import { fillPlurals } from '@mycel/shared/plural'
import type { AppContext } from '../context'
import type { ToolCtx } from '../files/service'
import { teamDefaultLocale } from '../admin/settings'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { atLeast } from '../policy/access'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { badSegment } from '../policy/names'
import { cardNext, cardReason, readOnlyNote, refusal, SCREEN } from '../policy/refusal'
import { inSkills, SKILL_FILES_REFUSAL } from '../skills/guard'
import { componentC } from '../team-files/component'
import { FileError } from '../team-files/errors'
import type { ToolRegistry } from './registry'
import { askConfirm } from './url-gate'
import { instructionLike, patternName } from './rename-pattern'


const persons = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`
/** Who can see the moved or copied items now, for the AI, in the card's own numbers (QA TC-cards-8: the card said 10 more
 * people, the answer said 11): `added` and `lost` are the very values the card was filled with (TEXT.added / TEXT.lost),
 * `total` the same pass's count of others who can read the target folder. '' when nobody's access changed. */
export function audienceResult(added: number, lost: number, total: number, mode: 'move' | 'copy', where: string): string {
  if (!added && !lost) return ''
  const change = [added ? `${persons(added)} more than before` : '', lost ? `${persons(lost)} fewer than before` : ''].filter(Boolean).join(', ')
  return `Who can see ${mode === 'move' ? 'them' : 'the copies'} now (the numbers the user's card showed; say these, never a count of your own): ${change}; ${persons(total + 1)} in all can see them in ${where}, the user included.`
}

/** The many-items card's own count for the AI, after the person's yes on it (QA S-122: the card said 17 people, the
 * answer counted 19): '' when no such card was shown in this call. */
export function bulkResult(people: number | undefined): string {
  if (people === undefined) return ''
  return `The card the user said yes to told them ${persons(people)} other than them can see these places; when you say how many people, say this number, never a count of your own.`
}

export const FILE_MOVE_TOOL_NAMES = ['move_files', 'copy_files', 'rename_file', 'rename_files'] as const

const t = (ko: string, en: string, id: string, ja: string, es: string, zh: string): Record<Locale, string> => ({ ko, en, id, ja, es, zh })
export const TEXT = {
  move: t('AI가 {n}개 항목을 {to} 폴더로 옮기려고 해요.', 'The AI wants to move {n, plural, one {# item} other {# items}} to {to}.', 'AI ingin memindahkan {n} item ke {to}.', "AIが{n}個の項目を{to}に移動しようとしています。", "La IA quiere mover {n, plural, one {# elemento} other {# elementos}} a {to}.", "AI 想把{n, plural, one {#个项目} other {#个项目}}移到{to}。"),
  copy: t('AI가 파일 {n}개를 {to} 폴더에 복사하려고 해요.', 'The AI wants to copy {n, plural, one {# file} other {# files}} to {to}.', 'AI ingin menyalin {n} berkas ke {to}.', "AIが{n}個のファイルを{to}にコピーしようとしています。", "La IA quiere copiar {n, plural, one {# archivo} other {# archivos}} a {to}.", "AI 想把{n, plural, one {#个文件} other {#个文件}}复制到{to}。"),
  // the target folder is not there yet: the tool makes it after a yes
  moveNew: t('AI가 {n}개 항목을 새로 만들 {to} 폴더로 옮기려고 해요.', 'The AI wants to move {n, plural, one {# item} other {# items}} to {to}, a new folder it will make.', 'AI ingin memindahkan {n} item ke {to}, folder baru yang akan dibuatnya.', "AIが{n}個の項目を、新しく作るフォルダー{to}に移動しようとしています。", "La IA quiere mover {n, plural, one {# elemento} other {# elementos}} a {to}, una carpeta nueva que creará.", "AI 想把{n, plural, one {#个项目} other {#个项目}}移到{to}，这是它将新建的文件夹。"),
  copyNew: t('AI가 파일 {n}개를 새로 만들 {to} 폴더에 복사하려고 해요.', 'The AI wants to copy {n, plural, one {# file} other {# files}} to {to}, a new folder it will make.', 'AI ingin menyalin {n} berkas ke {to}, folder baru yang akan dibuatnya.', "AIが{n}個のファイルを、新しく作るフォルダー{to}にコピーしようとしています。", "La IA quiere copiar {n, plural, one {# archivo} other {# archivos}} a {to}, una carpeta nueva que creará.", "AI 想把{n, plural, one {#个文件} other {#个文件}}复制到{to}，这是它将新建的文件夹。"),
  added: t('지금보다 {n}명이 더 볼 수 있게 돼요.', '{n, plural, one {# more person} other {# more people}} will be able to see {count, plural, one {it} other {them}}.', '{n} orang lagi akan bisa melihatnya.', "{count, plural, one {この項目} other {これらの項目}}を閲覧できる人が{n}人増えます。", "{n, plural, one {# persona más podrá} other {# personas más podrán}} {count, plural, one {verlo} other {verlos}}.", "将有{n, plural, one {另外#人} other {另外#人}}能看到{count, plural, one {它} other {它们}}。"),
  lost: t('지금 볼 수 있는 {n}명은 더 이상 볼 수 없게 돼요.', '{n, plural, one {# person} other {# people}} who can see {count, plural, one {it} other {them}} now will no longer be able to.', '{n} orang yang kini bisa melihatnya tidak akan bisa lagi.', "{count, plural, one {この項目} other {これらの項目}}を現在閲覧できる{n}人が閲覧できなくなります。", "{n, plural, one {# persona que ahora puede} other {# personas que ahora pueden}} {count, plural, one {verlo} other {verlos}} {n, plural, one {dejará} other {dejarán}} de tener acceso.", "现在能看到{count, plural, one {它} other {它们}}的{n, plural, one {#人} other {#人}}将无法再看到。"),
  askMove: t('옮길까요?', '{count, plural, one {Move it?} other {Move them?}}', 'Pindahkan?', "{count, plural, one {移動しますか？} other {移動しますか？}}", "{count, plural, one {¿Moverlo?} other {¿Moverlos?}}", "{count, plural, one {要移动吗？} other {要移动吗？}}"),
  askCopy: t('복사할까요?', '{count, plural, one {Copy it?} other {Copy them?}}', 'Salin?', "{count, plural, one {コピーしますか？} other {コピーしますか？}}", "{count, plural, one {¿Copiarlo?} other {¿Copiarlos?}}", "{count, plural, one {要复制吗？} other {要复制吗？}}"),
  more: t('외 {n}개', 'and {n} more', 'dan {n} lainnya', "ほか{n}個", "y {n} más", "等另外{n}个"),
  // many moves or renames where other people look (QA TC-r2u-25): one card for the rest of the answer
  bulkMove: t('AI가 {people}명이 함께 보는 곳에서 항목 {n}개를 {to} 폴더로 옮기려고 해요.', 'The AI wants to move {n, plural, one {# item} other {# items}} that {people, plural, one {# other person sees} other {# other people see}} to {to}.', 'AI ingin memindahkan {n} item yang juga dilihat {people} orang lain ke {to}.', "AIが、ほかの{people}人も見ている項目{n}個を{to}に移動しようとしています。", "La IA quiere mover a {to} {n, plural, one {# elemento} other {# elementos}} que {people, plural, one {ve otra persona} other {ven otras # personas}}.", "AI 想把另外{people}人也能看到的{n}个项目移到{to}。"),
  bulkRename: t('AI가 {people}명이 함께 보는 곳에서 항목 {n}개의 이름을 바꾸려고 해요.', 'The AI wants to rename {n, plural, one {# item} other {# items}} that {people, plural, one {# other person sees} other {# other people see}}.', 'AI ingin mengganti nama {n} item yang juga dilihat {people} orang lain.', "AIが、ほかの{people}人も見ている項目{n}個の名前を変えようとしています。", "La IA quiere cambiar el nombre de {n, plural, one {# elemento} other {# elementos}} que {people, plural, one {ve otra persona} other {ven otras # personas}}.", "AI 想重命名另外{people}人也能看到的{n}个项目。"),
  bulkEarlier: t('이 답변에서 이미 {n}개를 옮기거나 이름을 바꿨어요.', 'It already moved or renamed {n, plural, one {# item} other {# items}} in this answer.', 'Di jawaban ini sudah {n} item dipindahkan atau diganti namanya.', "この回答ですでに{n}個を移動または名前変更しました。", "En esta respuesta ya movió o cambió el nombre de {n, plural, one {# elemento} other {# elementos}}.", "这次回答中已经移动或重命名了{n}个项目。"),
  bulkRest: t('허용하면 이 답변에서는 이 질문을 다시 하지 않아요. 진행할까요?', 'If you allow it, this answer won\'t ask this again. Go ahead?', 'Jika diizinkan, jawaban ini tidak akan menanyakan ini lagi. Lanjutkan?', "許可すると、この回答ではこの確認をもう一度しません。進めますか？", "Si lo permite, esta respuesta no volverá a preguntarlo. ¿Continuar?", "允许后，这次回答不会再问这个问题。要继续吗？"),
  bulkList: t('바뀌는 항목', 'What changes', 'Yang berubah', "変わる項目", "Lo que cambia", "将更改的项目"),
  bulkYes: t('진행하기', 'Go ahead', 'Lanjutkan', "進める", "Continuar", "继续"),
  yesMove: t('옮기기', 'Move', 'Pindahkan', "移動", "Mover", "移动"),
  yesCopy: t('복사하기', 'Copy', 'Salin', "コピー", "Copiar", "复制"),
  no: t('하지 않기', 'Don’t', 'Jangan', "実行しない", "No hacerlo", "不要"),
}
/** A count's form first ("{n, plural, one {# item} other {# items}}", shared/src/plural.ts), then the plain values. */
const fill = (s: string, v: Record<string, string | number>, L: Locale) => fillPlurals(s, v, L).replace(/\{(\w+)\}/g, (_, k) => String(v[k]))

const SKILLS = SKILL_FILES_REFUSAL
// Match the policy resolver's dot/empty-segment normalization before checking protected skills paths.
const clean = (p: string) => p.normalize('NFC').split('/').filter(s => s !== '' && s !== '.').join('/')
const nameOf = (p: string) => p.split('/').pop() ?? ''
const parentOf = (p: string) => p.split('/').slice(0, -1).join('/')
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)

type Mode = 'move' | 'copy'

/** names looked at inside a folder rename_files renames (more: refused, it might hold an instruction file) */
const HOLDS_SCAN_MAX = 2000
const INSTRUCTION_REFUSAL = 'rename_files does not make or move an instruction file (CLAUDE.md, AGENTS.md, GEMINI.md, SKILL.md or a skill), by its new name or inside a renamed folder; nothing was changed for this item. Use rename_file for it, one at a time'

/** Moves and renames in places other people see that one answer makes without a card; past it, one card (QA TC-r2u-25) */
export const BULK_CHANGE_FREE = 3
/** item lines on that card (the rest: "and N more") */
const BULK_LINES_MAX = 50
/** answers whose count is kept (the oldest is forgotten past it: a long-gone turn) */
const BULK_TURNS_MAX = 1000

export function registerFileMoveTools(ctx: AppContext, reg: ToolRegistry) {
  const svc = componentC(ctx).files
  /** per answer: moves and renames so far in places other people see, and whether the person said yes to more */
  const bulkTurns = new Map<string, { done: number; approved: boolean }>()
  const bulkOf = (turnId: string) => {
    let b = bulkTurns.get(turnId)
    if (!b) {
      bulkTurns.set(turnId, (b = { done: 0, approved: false }))
      if (bulkTurns.size > BULK_TURNS_MAX) bulkTurns.delete(bulkTurns.keys().next().value!)
    }
    return b
  }
  /** This call's items that someone else can read (at the item, or at the target folder of a move) and how many people
   * that is; `ask`: past BULK_CHANGE_FREE in this answer, not yet allowed. Nothing for a call nobody can be asked about
   * (no chat turn, a scheduled run: the person set it up). */
  function bulkPlan(tc: ToolCtx, paths: readonly string[], folder?: string) {
    // the room card asked for this very call already (a chat that read rooms): not a second card
    if (!tc.person || tc.person.unattended || tc.person.roomCardEach || !tc.turnId) return null
    const b = bulkOf(tc.turnId)
    // allowed for this answer: nothing left to count or ask
    if (b.approved) return null
    const target = folder !== undefined && svc.othersReading(tc.user.id, [folder], { any: true }) > 0
    const shared = target ? [...paths] : svc.readByOthers(tc.user.id, paths)
    if (!shared.length) return null
    const extra = folder !== undefined ? [folder] : []
    return { b, shared, ask: b.done + shared.length > BULK_CHANGE_FREE, people: () => svc.othersReading(tc.user.id, [...shared, ...extra]), said: undefined as number | undefined }
  }
  /** The card for many moves or renames; null on a yes (the rest of the answer goes on without it), else the refusal. */
  async function bulkAsk(tc: ToolCtx, plan: NonNullable<ReturnType<typeof bulkPlan>>, lines: string[], o: { move?: { to: string } }): Promise<string | null> {
    const L = tc.person!.locale ?? teamDefaultLocale(ctx.db)
    const n = lines.length
    // one count, shown on the card and given back to the AI (QA S-122: the card said 17 people, the answer 19)
    const people = plan.people()
    const lead = o.move ? fill(TEXT.bulkMove[L], { n, people, to: o.move.to }, L) : fill(TEXT.bulkRename[L], { n, people }, L)
    const question = [lead, plan.b.done ? fill(TEXT.bulkEarlier[L], { n: plan.b.done }, L) : '', TEXT.bulkRest[L]].filter(Boolean).join(' ')
    const text = lines.slice(0, BULK_LINES_MAX).join('\n') + (n > BULK_LINES_MAX ? `\n${fill(TEXT.more[L], { n: n - BULK_LINES_MAX }, L)}` : '')
    const end = await askConfirm(tc.person!, question, TEXT.bulkYes[L], TEXT.no[L], { always: 'move_files', details: [{ label: TEXT.bulkList[L], text, noSize: true }] })
    if (end === 'yes') { plan.b.approved = true; plan.said = people; return null }
    const verb = o.move ? 'moved' : 'renamed'
    return refusal({
      done: end === 'declined' ? `The user did not allow this, so nothing was ${verb}.` : `Nothing was ${verb}.`,
      why: cardReason(end),
      also: `More than ${BULK_CHANGE_FREE} moves and renames in one answer in places other people see need the user's yes on one card first`,
      next: end === 'declined' ? 'ask the user what they want; do not move or rename these items another way' : cardNext(end),
    })
  }
  /** Who can give write access, the project's creator only when the person may read that project (policy/refusal.ts). */
  const readOnly = (msg: string, L: Locale, tc: ToolCtx) => {
    const rules = ctx.files.rules()
    return readOnlyNote(ctx.db, msg, L, { userId: tc.user.id, sees: (segs) => atLeast(rules.access(tc.user, segs), 'read'), button: false })
  }
  /** The reason for one path, as the checks wrote it (a hidden path answers "not found or no access", like a missing
   * one, and nothing is added to it); an admin-only folder names the admins (B14), a read-only one who can give write
   * access (B2). */
  const why = (e: unknown, tc: ToolCtx): string => {
    const L = tc.person?.locale ?? teamDefaultLocale(ctx.db)
    // admins are not named: roles stay hidden (policy/refusal.ts)
    if (e instanceof FileError && e.key === 'ruleFolder') return `${e.message} The user is not an admin; an admin can do it on ${SCREEN.files(L)}.`
    if (e instanceof Denied) return [e.message, readOnly(e.message, L, tc)].filter(Boolean).join('. ')
    return e instanceof ToolError || e instanceof FileError ? e.message : 'internal error'
  }

  /** The file `to` when the person can read it and it holds exactly what `from` holds (both files, same size, same
   * sha256); null otherwise, also on any error (the copy goes on as before). */
  async function sameFileThere(tc: ToolCtx, from: string, to: string): Promise<string | null> {
    try {
      const rules = ctx.files.rules()
      const a = authorize(ctx.files.fx, rules, tc.user, from, 'read')
      const b = authorize(ctx.files.fx, rules, tc.user, to, 'read')
      if (!a.exists || !b.exists || !a.st?.isFile() || !b.st?.isFile() || a.abs === b.abs || a.st.size !== b.st.size) return null
      const sha = (abs: string) => new Promise<string>((res, rej) => {
        const h = createHash('sha256')
        fs.createReadStream(abs).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej)
      })
      return (await sha(a.abs)) === (await sha(b.abs)) ? b.rel : null
    } catch { return null }
  }

  async function batch(mode: Mode, a: { paths: string[]; to_folder: string }, tc: ToolCtx) {
    const tool = mode === 'move' ? 'move_files' : 'copy_files'
    const verb = mode === 'move' ? 'moved' : 'copied'
    const folder = clean(a.to_folder)
    if (inSkills(folder)) throw new ToolError(SKILLS)
    // each path on its own first: one the person may not use fails alone, the rest go on
    const ok: string[] = []
    const audiences = new Map<string, string>()
    const failed: { path: string; error: string }[] = []
    for (const p of [...new Set(a.paths.map(clean))]) {
      // nor into one: a folder named "skills" moved into groups/<g>/ would become that group's skills folder
      if (inSkills(p) || inSkills(join(folder, nameOf(p)))) { failed.push({ path: p, error: SKILLS }); continue }
      try { audiences.set(p, svc.audienceChange(tc.user.id, [p], folder, mode).fingerprint); ok.push(p) } catch (e) { failed.push({ path: p, error: why(e, tc) }) }
    }
    const lines = (rows: { path: string; error: string }[]) => rows.map((f) => `- ${f.path}: ${f.error}`).join('\n')
    // a copy whose target folder already holds the same file (its name, the same bytes: sha256) is already there: no
    // card, nothing written, the result says so (QA S-018: "복사할까요? 15명이 더 볼 수 있게 돼요" for a file that was
    // there, then a duplicate " (2)")
    const there: { from: string; to: string }[] = []
    if (mode === 'copy') {
      for (const p of [...ok]) {
        const to = await sameFileThere(tc, p, join(folder, nameOf(p)))
        if (to) { there.push({ from: p, to }); ok.splice(ok.indexOf(p), 1) }
      }
    }
    const thereText = there.length ? `Already there (the same file, same name and content), nothing copied:\n${there.map((d) => `- ${d.from} = ${d.to}`).join('\n')}` : ''
    if (!ok.length && there.length) {
      const text = [thereText, failed.length ? `Not ${verb}:\n${lines(failed)}` : ''].filter(Boolean).join('\n\n')
      return { text, summary: `${tool} 0/${there.length + failed.length} -> ${folder} (${there.length} already there)`, structured: { copied: [], already: there, failed } }
    }
    if (!ok.length) throw new ToolError(`nothing was ${verb}:\n${lines(failed)}`)

    // who can see them: one question for the whole call, on the server's card; after a room read this card stands in
    // for the room card, so it asks even when nobody's access changes (TurnPerson.roomsSeen)
    const { added, lost, total, isNew } = svc.audienceChange(tc.user.id, ok, folder, mode)
    const L = tc.person?.locale ?? teamDefaultLocale(ctx.db)
    const where = `${folder || 'the team root'}${isNew ? ' (a new folder)' : ''}`
    const change = `this would change who can see ${ok.length === 1 ? 'it' : 'these files'} in ${where}: ${added} more, ${lost} fewer people`
    let confirmed = false
    // the card did not show: the person's own Always let it go (the summary says so, never "confirmed")
    let underAlways = false
    // many moves where other people look (QA TC-r2u-25; not copies: the originals stay): one card for the rest of the
    // answer; when the card below asks anyway, its yes (which lists them too) stands for it
    const bulk = mode === 'move' ? bulkPlan(tc, ok, folder) : null
    // the person's own message of this turn asked to save, move or copy there and named the place (docs/decisions/
    // 20261122-ask-less-explicit-save.md, QA TC-ask2-8): a card that would only say more people can see them there is
    // skipped. Never when someone loses access (a move out of a shared place), after a room read, or under the many-items
    // card (that one still asks); the person's words alone, never other people's (TurnPerson.explicitPlace), and the
    // files the person's too: named, attached or made in this answer (a place they named does not cover files the AI chose)
    const asked = added > 0 && !lost && !tc.person?.roomsSeen && !tc.person?.unattended && !(bulk?.ask) && !!tc.person?.explicitPlace?.(folder, ok)
    const audienceCard = !asked && (added > 0 || lost > 0 || !!tc.person?.roomsSeen)
    if (bulk?.ask && !audienceCard) {
      const no = await bulkAsk(tc, bulk, ok.map(nameOf), { move: { to: placeWords(ctx.db, folder, L, tc.user.id) } })
      if (no) throw new ToolError(no)
    }
    if (audienceCard) {
      // a scheduled run has a person who is never asked (unattended): the same answer as no chat at all, unless their own
      // Always for moves holds there (Rule A: askConfirm below answers yes)
      if (!tc.person || (tc.person.unattended && !tc.person.alwaysOn?.('move_files'))) {
        throw new ToolError(refusal({
          done: `Nothing was ${verb}.`, why: cardReason('unattended', { run: tc.person ? undefined : 'a call outside a chat' }), also: change,
          next: `the user can do it in a chat, where they answer the card, or on ${SCREEN.files(L)}; tell them in the summary`, names: [folder || '/'],
        }))
      }
      const names = ok.slice(0, 10).map(nameOf).join('\n') + (ok.length > 10 ? `\n${fill(TEXT.more[L], { n: ok.length - 10 }, L)}` : '')
      // n: people, count: the items ("1 more person will be able to see it")
      const count = ok.length
      const lead = TEXT[isNew ? (mode === 'move' ? 'moveNew' : 'copyNew') : mode][L]
      // the folder in words (전사 공유 › 영업, 팀 폴더 맨 위), not its path (chat/place-words.ts)
      // (when this card stands for the "many items" card too, it says so: its yes covers the rest of the answer)
      const question = [fill(lead, { n: count, to: placeWords(ctx.db, folder, L, tc.user.id) }, L), added ? fill(TEXT.added[L], { n: added, count }, L) : '', lost ? fill(TEXT.lost[L], { n: lost, count }, L) : '',
        bulk?.ask && bulk.b.done ? fill(TEXT.bulkEarlier[L], { n: bulk.b.done }, L) : '',
        bulk?.ask ? TEXT.bulkRest[L] : fill(TEXT[mode === 'move' ? 'askMove' : 'askCopy'][L], { count }, L)].filter(Boolean).join(' ') + '\n\n' + names
      underAlways = !!tc.person.alwaysOn?.('move_files')
      const end = await askConfirm(tc.person, question, TEXT[mode === 'move' ? 'yesMove' : 'yesCopy'][L], TEXT.no[L], { always: 'move_files' })
      if (end !== 'yes') {
        throw new ToolError(refusal({
          done: end === 'declined' ? `The user did not allow this, so nothing was ${verb}.` : `Nothing was ${verb}.`,
          why: cardReason(end), also: `${change}. Do not put these files anywhere else that changes who can see them`,
          next: end === 'declined' ? 'ask the user what they want' : cardNext(end), names: [folder || '/'],
        }))
      }
      confirmed = true
      if (bulk?.ask) bulk.b.approved = true
    }
    if (asked) confirmed = true
    // (counted before they run: an item that then fails still counts, so the card comes sooner, never later)
    if (bulk) bulk.b.done += bulk.shared.length
    // a new target folder: made now (after the yes), then filled; recorded once something went in, else taken away
    // again (a folder, a group folder for a member, a folder into itself: refused per item below)
    let made: string[] = []
    if (isNew && !tc.signal?.aborted) {
      try { made = svc.ensureFolder(tc.user.id, folder).created } catch (e) { throw new ToolError(`the folder ${folder} could not be made, so nothing was ${verb}: ${why(e, tc)}`) }
    }

    const done: { from: string; to: string }[] = []
    for (const p of ok) {
      if (tc.signal?.aborted) { failed.push({ path: p, error: 'cancelled' }); continue }
      try {
        if (svc.audienceChange(tc.user.id, [p], folder, mode).fingerprint !== audiences.get(p)) {
          throw new ToolError('the audience changed while this call waited; nothing was changed for this item. Ask again with the current audience.')
        }
        if (mode === 'move') {
          // confirm only what the person saw: a narrowing that appears after the question fails this item (the audience
          // was compared just above); a move into a folder its owner shares asks on this same card (added > 0), and
          // move() asks for that whatever the client says (W7), so the card's yes is passed on
          const r = svc.move(tc.user.id, p, join(folder, nameOf(p)), 'rename', { confirm: confirmed && (lost > 0 || added > 0), turnId: tc.turnId, tool })
          done.push({ from: p, to: r.entry.path })
        } else {
          // onto a file of that name the AI read in this answer: a new version of it (its old content kept), never a
          // "(2)" next to it (QA TC-7234 real run: the remade poster could not reach the moved one). A change since the
          // read keeps both (copy's baseSha256: a conflict copy), as for any save
          const at = join(folder, nameOf(p))
          const seen = readThisAnswer(tc.files, at)
          const r = await svc.copy(tc.user.id, p, at, seen ? { onExists: 'replace', baseSha256: seen, turnId: tc.turnId, tool, confirm: confirmed && added > 0 } : { onExists: 'rename', turnId: tc.turnId, tool, confirm: confirmed && added > 0 })
          if ('path' in r) done.push({ from: p, to: !seen ? r.path : r.path === at ? `${r.path} (a new version of it; its earlier content is kept)` : `${r.path} (${at} changed after you read it, so it was kept unchanged and this copy was saved next to it; tell the person)` })
        }
      } catch (e) {
        failed.push({ path: p, error: e instanceof ToolError && e.code === 'is_folder' ? 'this is a folder: copy_files copies files only (move_files moves folders)' : why(e, tc) })
      }
    }
    if (made.length) {
      if (done.length) svc.recordFolders(tc.user.id, made, { turnId: tc.turnId, tool })
      else { svc.dropFolders(made); made = [] }
    }
    const text = [
      made.length ? `Made the new folder ${made.at(-1)}.` : '',
      done.length ? `${mode === 'move' ? 'Moved' : 'Copied'} ${done.length} to ${folder || 'the team root'}:\n${done.map((d) => `- ${d.from} -> ${d.to}`).join('\n')}` : `Nothing was ${verb}.`,
      thereText,
      failed.length ? `Not ${verb}:\n${lines(failed)}` : '',
      done.length ? audienceResult(added, lost, total, mode, where) : '',
      done.length ? bulkResult(bulk?.said) : '',
    ].filter(Boolean).join('\n\n')
    const summary = `${tool} ${done.length}/${done.length + failed.length + there.length} -> ${folder}${asked ? ` (asked for in the user's message: +${added})` : confirmed ? ` (${underAlways ? 'Always allow, no card' : 'confirmed by the user'}: +${added} -${lost})` : ''}`
    if (!done.length) return { text, isError: true, summary }
    return { text, summary, structured: mode === 'move' ? { moved: done, failed } : { copied: done, failed } }
  }

  reg.register({
    name: 'move_files',
    description: 'Move files or folders of any type (PDF, images, Office files, chat attachments) into another folder of the team drive. ' +
      'Names are kept; " (2)" is added when a name is taken. A target folder that does not exist yet is made (no README or placeholder file needed). ' +
      'To keep a file the user attached in a chat for the team, move it out of their .attachments folder. When this lets more people see the files, ' +
      'or fewer people keep seeing them, the user is asked first.',
    input: MoveFilesInput,
    describe: (a) => `move_files ${a.paths.length} -> ${a.to_folder}`,
    run: (a, tc) => batch('move', a, tc),
  })
  reg.register({
    name: 'copy_files',
    description: 'Copy files of any type (PDF, images, Office files) into another folder of the team drive; the originals stay. ' +
      'Names are kept; " (2)" is added when a name is taken, except over a file you read in this answer: then your copy replaces it as a new version (its earlier content is kept as a version), which is how you change a picture or any file you remade elsewhere in place. Files only, not folders, between team folders. A target folder that does not exist yet is made. ' +
      'When more people can see the target folder than the originals, the user is asked first. ' +
      'In a Trina chat it also copies between the team folder, this chat\'s files (chat:files/…) and this chat\'s work folder (chat:work/…, $TRINA_WORK in box_shell): ' +
      'to_folder "chat:work/in/" brings team files, whole team folders (an HTML file with its images folder) or chat files into the work folder for your commands; ' +
      'to_folder "chat:files/" attaches a file (a team file, or one from chat:work/) to your answer for everyone in a chat shared with people (a chat only the user sees attaches nothing: link the file in their own folder instead); ' +
      'a chat file or a work-folder file into a team folder saves a copy there. In a project chat the project folder is the place to save, and chat:files/ is read-only.',
    input: CopyFilesInput,
    describe: (a) => `copy_files ${a.paths.length} -> ${a.to_folder}`,
    run: (a, tc) => batch('copy', a, tc),
  })
  /** One rename in place, with every check of rename_file (the name, skill folders, the file layer's access and a taken
   * name: fails, never " (2)"); the new path. The same folder: the same people see it, nothing to ask. */
  function renameOne(p: string, newName: string, tc: ToolCtx, tool: 'rename_file' | 'rename_files'): string {
    const name = newName.normalize('NFC')
    if (name.includes('/')) throw new ToolError('new_name is a name, not a path: use move_files to put it in another folder')
    const bad = badSegment(name)
    if (bad) throw new ToolError(`invalid name: ${bad}`)
    // the new name counts too: groups/<g>/drafts renamed "skills" would become that group's skills folder
    if (inSkills(p) || inSkills(join(parentOf(p), name))) throw new ToolError(SKILLS)
    return svc.move(tc.user.id, p, join(parentOf(p), name), 'fail', { turnId: tc.turnId, tool }).entry.path
  }

  /** Does the folder at `rel` hold an instruction file (CLAUDE.md, AGENTS.md, GEMINI.md, SKILL.md, a skill) among what
   * the person sees in it? A file: false. Past HOLDS_SCAN_MAX names: true (it might). */
  function holdsInstructions(userId: string, rel: string): boolean {
    const todo = [rel]
    let seen = 0
    while (todo.length) {
      let entries: { path: string; type: string }[]
      try { entries = svc.tree(userId, todo.pop()!, undefined, Number.MAX_SAFE_INTEGER).entries } catch (e) { if (e instanceof ToolError && e.code === 'not_folder') return false; throw e }
      for (const e of entries) {
        if (++seen > HOLDS_SCAN_MAX || instructionLike(e.path)) return true
        if (e.type === 'folder') todo.push(e.path)
      }
    }
    return false
  }

  /** Many renames where other people look (QA TC-r2u-25): null to go on, else the refusal. Counts this call's items. */
  async function renameBulk(items: { path: string; new_name: string }[], tc: ToolCtx): Promise<{ no: string } | { said?: number } | null> {
    const plan = bulkPlan(tc, items.map((it) => it.path))
    if (!plan) return null
    if (plan.ask) {
      const shared = new Set(plan.shared)
      const no = await bulkAsk(tc, plan, items.filter((it) => shared.has(it.path)).map((it) => `${nameOf(it.path)} → ${it.new_name.normalize('NFC')}`), {})
      if (no) return { no }
    }
    plan.b.done += plan.shared.length
    return plan.said === undefined ? null : { said: plan.said }
  }

  /** rename_files: a list of renames, or a find/replace on the names directly inside one folder; each item on its own
   * (one that fails is reported, the rest go on), at most RENAME_FILES_MAX per call. */
  async function renameMany(a: { renames?: { path: string; new_name: string }[]; folder?: string; find?: string; replace?: string; at?: 'anywhere' | 'start' | 'end' }, tc: ToolCtx) {
    let items: { path: string; new_name: string }[]
    let left = 0
    let where = ''
    if (a.renames) {
      const seen = new Set<string>()
      items = a.renames.map((r) => ({ path: clean(r.path), new_name: r.new_name })).filter((r) => (seen.has(r.path) ? false : (seen.add(r.path), true)))
    } else {
      const folder = clean(a.folder ?? '')
      where = folder || 'the team root'
      const src = a.find ?? ''
      let entries: { path: string; name: string }[]
      try { entries = svc.tree(tc.user.id, folder, undefined, Number.MAX_SAFE_INTEGER).entries } catch (e) { throw new ToolError(`nothing was renamed: ${why(e, tc)}`) }
      const all: { path: string; new_name: string }[] = []
      for (const e of entries) {
        const to = patternName(e.name.normalize('NFC'), src, a.replace ?? '', a.at ?? 'anywhere')
        if (to !== null) all.push({ path: clean(e.path), new_name: to })
      }
      if (!all.length) return { text: `Nothing was renamed: no name directly inside ${where} has a match for ${JSON.stringify(src)} that changes it.`, isError: true, summary: `rename_files 0/0 in ${folder}` }
      items = all.slice(0, RENAME_FILES_MAX)
      left = all.length - items.length
    }
    const bulk = await renameBulk(items, tc)
    if (bulk && 'no' in bulk) return { text: bulk.no, isError: true, summary: `rename_files 0/${items.length} (not allowed)` }
    const done: { from: string; to: string }[] = []
    const failed: { path: string; error: string }[] = []
    for (const it of items) {
      if (tc.signal?.aborted) { failed.push({ path: it.path, error: 'cancelled' }); continue }
      try {
        // never an instruction file by a batch (its new name, or one inside a renamed folder), checked now and not only on
        // a room's card before the call: the folder may have changed since (review of #1327); rename_file does one
        if (instructionLike(join(parentOf(it.path), it.new_name.normalize('NFC'))) || holdsInstructions(tc.user.id, it.path)) throw new ToolError(INSTRUCTION_REFUSAL)
        done.push({ from: it.path, to: renameOne(it.path, it.new_name, tc, 'rename_files') })
      } catch (e) { failed.push({ path: it.path, error: why(e, tc) }) }
    }
    const text = [
      done.length ? `Renamed ${done.length}${where ? ` in ${where}` : ''}:\n${done.map((d) => `- ${d.from} -> ${nameOf(d.to)}`).join('\n')}` : 'Nothing was renamed.',
      failed.length ? `Not renamed:\n${failed.map((f) => `- ${f.path}: ${f.error}`).join('\n')}` : '',
      done.length ? bulkResult(bulk && 'said' in bulk ? bulk.said : undefined) : '',
      left ? `${left} more name${left === 1 ? '' : 's'} match: at most ${RENAME_FILES_MAX} are renamed per call. Call rename_files again with the same folder and find for the rest (a name renamed above is changed again only if its new name still matches).` : '',
    ].filter(Boolean).join('\n\n')
    const summary = `rename_files ${done.length}/${done.length + failed.length}${where ? ` in ${a.folder}` : ''}${left ? ` (${left} left)` : ''}`
    if (!done.length) return { text, isError: true, summary }
    return { text, summary, structured: { renamed: done, failed, left } }
  }

  reg.register({
    name: 'rename_file',
    description: 'Rename a file or folder in place (it stays in the same folder). Give the new name only; to move it elsewhere use move_files.',
    input: RenameFileInput,
    describe: (a) => `rename_file ${a.path} -> ${a.new_name}`,
    async run(a, tc) {
      const p = clean(a.path)
      // one at a time counts too: the fourth rename in this answer where other people look asks (QA TC-r2u-25)
      const bulk = await renameBulk([{ path: p, new_name: a.new_name }], tc)
      if (bulk && 'no' in bulk) throw new ToolError(bulk.no)
      try {
        const to = renameOne(p, a.new_name, tc, 'rename_file')
        return { text: [`Renamed ${p} to ${to}.`, bulkResult(bulk && 'said' in bulk ? bulk.said : undefined)].filter(Boolean).join('\n\n'), summary: `rename_file ${p} -> ${to}`, structured: { path: to } }
      } catch (e) {
        // an admin-only folder names the admins (B14); a read-only place says who can give write access (B2)
        if (e instanceof FileError) throw new ToolError(why(e, tc))
        if (e instanceof Denied) { const note = readOnly(e.message, tc.person?.locale ?? teamDefaultLocale(ctx.db), tc); if (note) throw new Denied(`${e.message}. ${note}`) }
        throw e
      }
    },
  })
  reg.register({
    name: 'rename_files',
    description: `Rename many files or folders in place in one call (each stays in its folder), with the same checks as rename_file: either renames, a list of { path, new_name }, or a pattern: folder with find and replace on the names directly inside that folder (plain text; at: "start" or "end" for only the start or end of a name). At most ${RENAME_FILES_MAX} per call; when more names match, the answer says how many are left. A name that is taken, or a place the user may not change, fails for that item only. Use it instead of many rename_file calls.`,
    input: RenameFilesInput,
    describe: (a) => (a.renames ? `rename_files ${a.renames.length}` : `rename_files ${a.folder} ${JSON.stringify(a.find)} -> ${JSON.stringify(a.replace ?? '')}`),
    run: (a, tc) => renameMany(a, tc),
  })
}
