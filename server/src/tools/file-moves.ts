// The AI's move_files / copy_files / rename_file (mcp__team__<name>): the Files screen's move, copy and rename for any
// kind of file. `write` only saves text, so before these the AI could not put a PDF or an image a person attached in a
// chat into a team folder ("I can only save text files", 2026-10-28). Every path goes through the same checks as the
// Files screen (TeamFiles.move / copy: write access at both ends, managed folders for admins and owners only, nothing
// under users/ for rule folders, root / users / .system never move).
// Who can see the files: when the result lets more people read something, or fewer people keep reading it, the server
// asks the person once for the whole call on its own card (never the AI's ask_user, so an instruction hidden in a
// document cannot answer it). With nobody to ask (a scheduled run, no chat turn) such a call is refused.
// skills/ (team skills and rules every teammate's AI follows) is out of reach here: it changes only through write /
// edit with the person's approval on the card, or on the Files screen.
import { CopyFilesInput, MoveFilesInput, RenameFileInput } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { ToolCtx } from '../files/service'
import { Denied, ToolError } from '../policy/errors'
import { badSegment } from '../policy/names'
import { inSkills } from '../skills/guard'
import { componentC } from '../team-files/component'
import { FileError } from '../team-files/errors'
import type { ToolRegistry } from './registry'

export const FILE_MOVE_TOOL_NAMES = ['move_files', 'copy_files', 'rename_file'] as const

const t = (ko: string, en: string, id: string, ja: string, es: string): Record<Locale, string> => ({ ko, en, id, ja, es })
export const TEXT = {
  move: t('AI가 {n}개 항목을 {to} 폴더로 옮기려고 해요.', 'The AI wants to move {n} item(s) to {to}.', 'AI ingin memindahkan {n} item ke {to}.', "AIが{n}個の項目を{to}に移動しようとしています。", "La IA quiere mover {n} elementos a {to}."),
  copy: t('AI가 파일 {n}개를 {to} 폴더에 복사하려고 해요.', 'The AI wants to copy {n} file(s) to {to}.', 'AI ingin menyalin {n} berkas ke {to}.', "AIが{n}個のファイルを{to}にコピーしようとしています。", "La IA quiere copiar {n} archivos a {to}."),
  added: t('지금보다 {n}명이 더 볼 수 있게 돼요.', '{n} more people will be able to see them.', '{n} orang lagi akan bisa melihatnya.', "閲覧できる人が{n}人増えます。", "{n} personas más podrán verlos."),
  lost: t('지금 볼 수 있는 {n}명은 더 이상 볼 수 없게 돼요.', '{n} people who can see them now will no longer be able to.', '{n} orang yang kini bisa melihatnya tidak akan bisa lagi.', "現在閲覧できる{n}人が閲覧できなくなります。", "{n} personas que ahora pueden verlos dejarán de tener acceso."),
  askMove: t('옮길까요?', 'Move them?', 'Pindahkan?', "移動しますか？", "¿Moverlos?"),
  askCopy: t('복사할까요?', 'Copy them?', 'Salin?', "コピーしますか？", "¿Copiarlos?"),
  more: t('외 {n}개', 'and {n} more', 'dan {n} lainnya', "ほか{n}個", "y {n} más"),
  yesMove: t('옮기기', 'Move', 'Pindahkan', "移動", "Mover"),
  yesCopy: t('복사하기', 'Copy', 'Salin', "コピー", "Copiar"),
  no: t('하지 않기', 'Don’t', 'Jangan', "実行しない", "No hacerlo"),
}
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k]))

const SKILLS = 'skills/ (team skills and rules) cannot be changed with this tool: use write / edit, which ask the user, or the Files screen'
// Match the policy resolver's dot/empty-segment normalization before checking protected skills paths.
const clean = (p: string) => p.normalize('NFC').split('/').filter(s => s !== '' && s !== '.').join('/')
const nameOf = (p: string) => p.split('/').pop() ?? ''
const parentOf = (p: string) => p.split('/').slice(0, -1).join('/')
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)
/** The reason for one path, as the checks wrote it (a hidden path answers "not found or no access", like a missing one). */
const why = (e: unknown) => (e instanceof Denied || e instanceof ToolError || e instanceof FileError ? e.message : 'internal error')

type Mode = 'move' | 'copy'

export function registerFileMoveTools(ctx: AppContext, reg: ToolRegistry) {
  const svc = componentC(ctx).files

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
      if (inSkills(p)) { failed.push({ path: p, error: SKILLS }); continue }
      try { audiences.set(p, svc.audienceChange(tc.user.id, [p], folder, mode).fingerprint); ok.push(p) } catch (e) { failed.push({ path: p, error: why(e) }) }
    }
    const lines = (rows: { path: string; error: string }[]) => rows.map((f) => `- ${f.path}: ${f.error}`).join('\n')
    if (!ok.length) throw new ToolError(`nothing was ${verb}:\n${lines(failed)}`)

    // who can see them: one question for the whole call, on the server's card
    const { added, lost } = svc.audienceChange(tc.user.id, ok, folder, mode)
    let confirmed = false
    if (added > 0 || lost > 0) {
      if (!tc.person) throw new ToolError(`this would change who can see these files (${added} more, ${lost} fewer people) and nobody can confirm it here, so nothing was ${verb}. Ask the user to do it in a chat or on the Files screen.`)
      const L = tc.person.locale
      const names = ok.slice(0, 10).map(nameOf).join('\n') + (ok.length > 10 ? `\n${fill(TEXT.more[L], { n: ok.length - 10 })}` : '')
      const question = [fill(TEXT[mode][L], { n: ok.length, to: folder || '/' }), added ? fill(TEXT.added[L], { n: added }) : '', lost ? fill(TEXT.lost[L], { n: lost }) : '',
        TEXT[mode === 'move' ? 'askMove' : 'askCopy'][L]].filter(Boolean).join(' ') + '\n\n' + names
      if (!(await tc.person.confirm(question, TEXT[mode === 'move' ? 'yesMove' : 'yesCopy'][L], TEXT.no[L]))) {
        throw new ToolError(`the user did not allow this, so nothing was ${verb}. Do not put these files anywhere else that changes who can see them; ask the user what they want.`)
      }
      confirmed = true
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
        failed.push({ path: p, error: e instanceof ToolError && e.code === 'is_folder' ? 'this is a folder: copy_files copies files only (move_files moves folders)' : why(e) })
      }
    }
    const text = [
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
      'Names are kept; " (2)" is added when a name is taken. To keep a file the user attached in a chat for the team, move it out of their ' +
      '.attachments folder. When this lets more people see the files, or fewer people keep seeing them, the user is asked first.',
    input: MoveFilesInput,
    describe: (a) => `move_files ${a.paths.length} -> ${a.to_folder}`,
    run: (a, tc) => batch('move', a, tc),
  })
  reg.register({
    name: 'copy_files',
    description: 'Copy files of any type (PDF, images, Office files) into another folder of the team drive; the originals stay. ' +
      'Names are kept; " (2)" is added when a name is taken. Files only, not folders. When more people can see the target folder ' +
      'than the originals, the user is asked first.',
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
      if (inSkills(p)) throw new ToolError(SKILLS)
      try {
        // the same folder: the same people see it, nothing to ask
        const r = svc.move(tc.user.id, p, join(parentOf(p), name), 'fail', { turnId: tc.turnId, tool: 'rename_file' })
        return { text: `Renamed ${p} to ${r.entry.path}.`, summary: `rename_file ${p} -> ${r.entry.path}`, structured: { path: r.entry.path } }
      } catch (e) {
        if (e instanceof FileError) throw new ToolError(e.message)
        throw e
      }
    },
  })
}
