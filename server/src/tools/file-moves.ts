// The AI's move_files / copy_files / rename_file (mcp__team__<name>): the Files screen's move, copy and rename for any
// kind of file. `write` only saves text, so before these the AI could not put a PDF or an image a person attached in a
// chat into a team folder ("I can only save text files", 2026-10-28). Every path goes through the same checks as the
// Files screen (TeamFiles.move / copy: write access at both ends, managed folders for admins and owners only, nothing
// under users/ for rule folders, root / users / .system never move).
// Who can see the files: when the result lets more people read something, or fewer people keep reading it, the server
// asks the person once for the whole call on its own card (never the AI's ask_user, so an instruction hidden in a
// document cannot answer it). With nobody to ask (a scheduled run, no chat turn) such a call is refused, and the AI is
// told that nobody was asked (not "the user did not allow this"; policy/refusal.ts).
// A target folder that is not there yet is made after the card (docs/DECISIONS.md "move_files and copy_files make the
// target folder"); the card says it is new.
// Skill folders (skills/, a group's, a project's: what people's AI follows) are out of reach here: a skill changes only
// through write / edit with the person's approval on the card, and moves to another level with move_skill.
import { placeWords } from '../chat/place-words'
import { CopyFilesInput, MoveFilesInput, RenameFileInput } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import { fillPlurals } from '@mycel/shared/plural'
import type { AppContext } from '../context'
import type { ToolCtx } from '../files/service'
import { teamDefaultLocale } from '../admin/settings'
import { atLeast } from '../policy/access'
import { Denied, ToolError } from '../policy/errors'
import { badSegment } from '../policy/names'
import { cardNext, cardReason, readOnlyNote, refusal, SCREEN } from '../policy/refusal'
import { inSkills, SKILL_FILES_REFUSAL } from '../skills/guard'
import { componentC } from '../team-files/component'
import { FileError } from '../team-files/errors'
import type { ToolRegistry } from './registry'
import { askConfirm } from './url-gate'

export const FILE_MOVE_TOOL_NAMES = ['move_files', 'copy_files', 'rename_file'] as const

const t = (ko: string, en: string, id: string, ja: string, es: string): Record<Locale, string> => ({ ko, en, id, ja, es })
export const TEXT = {
  move: t('AI가 {n}개 항목을 {to} 폴더로 옮기려고 해요.', 'The AI wants to move {n, plural, one {# item} other {# items}} to {to}.', 'AI ingin memindahkan {n} item ke {to}.', "AIが{n}個の項目を{to}に移動しようとしています。", "La IA quiere mover {n, plural, one {# elemento} other {# elementos}} a {to}."),
  copy: t('AI가 파일 {n}개를 {to} 폴더에 복사하려고 해요.', 'The AI wants to copy {n, plural, one {# file} other {# files}} to {to}.', 'AI ingin menyalin {n} berkas ke {to}.', "AIが{n}個のファイルを{to}にコピーしようとしています。", "La IA quiere copiar {n, plural, one {# archivo} other {# archivos}} a {to}."),
  // the target folder is not there yet: the tool makes it after a yes
  moveNew: t('AI가 {n}개 항목을 새로 만들 {to} 폴더로 옮기려고 해요.', 'The AI wants to move {n, plural, one {# item} other {# items}} to {to}, a new folder it will make.', 'AI ingin memindahkan {n} item ke {to}, folder baru yang akan dibuatnya.', "AIが{n}個の項目を、新しく作るフォルダー{to}に移動しようとしています。", "La IA quiere mover {n, plural, one {# elemento} other {# elementos}} a {to}, una carpeta nueva que creará."),
  copyNew: t('AI가 파일 {n}개를 새로 만들 {to} 폴더에 복사하려고 해요.', 'The AI wants to copy {n, plural, one {# file} other {# files}} to {to}, a new folder it will make.', 'AI ingin menyalin {n} berkas ke {to}, folder baru yang akan dibuatnya.', "AIが{n}個のファイルを、新しく作るフォルダー{to}にコピーしようとしています。", "La IA quiere copiar {n, plural, one {# archivo} other {# archivos}} a {to}, una carpeta nueva que creará."),
  added: t('지금보다 {n}명이 더 볼 수 있게 돼요.', '{n, plural, one {# more person} other {# more people}} will be able to see {count, plural, one {it} other {them}}.', '{n} orang lagi akan bisa melihatnya.', "{count, plural, one {この項目} other {これらの項目}}を閲覧できる人が{n}人増えます。", "{n, plural, one {# persona más podrá} other {# personas más podrán}} {count, plural, one {verlo} other {verlos}}."),
  lost: t('지금 볼 수 있는 {n}명은 더 이상 볼 수 없게 돼요.', '{n, plural, one {# person} other {# people}} who can see {count, plural, one {it} other {them}} now will no longer be able to.', '{n} orang yang kini bisa melihatnya tidak akan bisa lagi.', "{count, plural, one {この項目} other {これらの項目}}を現在閲覧できる{n}人が閲覧できなくなります。", "{n, plural, one {# persona que ahora puede} other {# personas que ahora pueden}} {count, plural, one {verlo} other {verlos}} {n, plural, one {dejará} other {dejarán}} de tener acceso."),
  askMove: t('옮길까요?', '{count, plural, one {Move it?} other {Move them?}}', 'Pindahkan?', "{count, plural, one {移動しますか？} other {移動しますか？}}", "{count, plural, one {¿Moverlo?} other {¿Moverlos?}}"),
  askCopy: t('복사할까요?', '{count, plural, one {Copy it?} other {Copy them?}}', 'Salin?', "{count, plural, one {コピーしますか？} other {コピーしますか？}}", "{count, plural, one {¿Copiarlo?} other {¿Copiarlos?}}"),
  more: t('외 {n}개', 'and {n} more', 'dan {n} lainnya', "ほか{n}個", "y {n} más"),
  yesMove: t('옮기기', 'Move', 'Pindahkan', "移動", "Mover"),
  yesCopy: t('복사하기', 'Copy', 'Salin', "コピー", "Copiar"),
  no: t('하지 않기', 'Don’t', 'Jangan', "実行しない", "No hacerlo"),
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

export function registerFileMoveTools(ctx: AppContext, reg: ToolRegistry) {
  const svc = componentC(ctx).files
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
    if (!ok.length) throw new ToolError(`nothing was ${verb}:\n${lines(failed)}`)

    // who can see them: one question for the whole call, on the server's card; after a room read this card stands in
    // for the room card, so it asks even when nobody's access changes (TurnPerson.roomsSeen)
    const { added, lost, isNew } = svc.audienceChange(tc.user.id, ok, folder, mode)
    const L = tc.person?.locale ?? teamDefaultLocale(ctx.db)
    const where = `${folder || 'the team root'}${isNew ? ' (a new folder)' : ''}`
    const change = `this would change who can see ${ok.length === 1 ? 'it' : 'these files'} in ${where}: ${added} more, ${lost} fewer people`
    let confirmed = false
    if (added > 0 || lost > 0 || tc.person?.roomsSeen) {
      // a scheduled run has a person who is never asked (unattended): the same answer as no chat at all
      if (!tc.person || tc.person.unattended) {
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
      const question = [fill(lead, { n: count, to: placeWords(ctx.db, folder, L, tc.user.id) }, L), added ? fill(TEXT.added[L], { n: added, count }, L) : '', lost ? fill(TEXT.lost[L], { n: lost, count }, L) : '',
        fill(TEXT[mode === 'move' ? 'askMove' : 'askCopy'][L], { count }, L)].filter(Boolean).join(' ') + '\n\n' + names
      const end = await askConfirm(tc.person, question, TEXT[mode === 'move' ? 'yesMove' : 'yesCopy'][L], TEXT.no[L])
      if (end !== 'yes') {
        throw new ToolError(refusal({
          done: end === 'declined' ? `The user did not allow this, so nothing was ${verb}.` : `Nothing was ${verb}.`,
          why: cardReason(end), also: `${change}. Do not put these files anywhere else that changes who can see them`,
          next: end === 'declined' ? 'ask the user what they want' : cardNext(end), names: [folder || '/'],
        }))
      }
      confirmed = true
    }
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
          // confirm only what the person saw: a narrowing that appears after the question fails this item
          const r = svc.move(tc.user.id, p, join(folder, nameOf(p)), 'rename', { confirm: confirmed && lost > 0, turnId: tc.turnId, tool })
          done.push({ from: p, to: r.entry.path })
        } else {
          const r = await svc.copy(tc.user.id, p, join(folder, nameOf(p)), { onExists: 'rename', turnId: tc.turnId, tool })
          if ('path' in r) done.push({ from: p, to: r.path })
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
      failed.length ? `Not ${verb}:\n${lines(failed)}` : '',
    ].filter(Boolean).join('\n\n')
    const summary = `${tool} ${done.length}/${done.length + failed.length} -> ${folder}${confirmed ? ` (confirmed by the user: +${added} -${lost})` : ''}`
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
      'Names are kept; " (2)" is added when a name is taken. Files only, not folders. A target folder that does not exist yet is made. ' +
      'When more people can see the target folder than the originals, the user is asked first.',
    input: CopyFilesInput,
    describe: (a) => `copy_files ${a.paths.length} -> ${a.to_folder}`,
    run: (a, tc) => batch('copy', a, tc),
  })
  reg.register({
    name: 'rename_file',
    description: 'Rename a file or folder in place (it stays in the same folder). Give the new name only; to move it elsewhere use move_files.',
    input: RenameFileInput,
    describe: (a) => `rename_file ${a.path} -> ${a.new_name}`,
    run(a, tc) {
      const p = clean(a.path)
      const name = a.new_name.normalize('NFC')
      if (name.includes('/')) throw new ToolError('new_name is a name, not a path: use move_files to put it in another folder')
      const bad = badSegment(name)
      if (bad) throw new ToolError(`invalid name: ${bad}`)
      // the new name counts too: groups/<g>/drafts renamed "skills" would become that group's skills folder
      if (inSkills(p) || inSkills(join(parentOf(p), name))) throw new ToolError(SKILLS)
      try {
        // the same folder: the same people see it, nothing to ask
        const r = svc.move(tc.user.id, p, join(parentOf(p), name), 'fail', { turnId: tc.turnId, tool: 'rename_file' })
        return { text: `Renamed ${p} to ${r.entry.path}.`, summary: `rename_file ${p} -> ${r.entry.path}`, structured: { path: r.entry.path } }
      } catch (e) {
        // an admin-only folder names the admins (B14); a read-only place says who can give write access (B2)
        if (e instanceof FileError) throw new ToolError(why(e, tc))
        if (e instanceof Denied) { const note = readOnly(e.message, tc.person?.locale ?? teamDefaultLocale(ctx.db), tc); if (note) throw new Denied(`${e.message}. ${note}`) }
        throw e
      }
    },
  })
}
