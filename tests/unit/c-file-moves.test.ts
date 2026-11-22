// The AI's move_files / copy_files / rename_file (server/src/tools/file-moves.ts) through the MCP handler: any file type,
// the same access checks as the Files screen, one question on the server's card when who can see the files changes,
// refusal with nobody to ask, skills/ out of reach, and the turn recorded in the file history.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeHandler } from '../../server/src/mcp/protocol'
import { fileSummaryOf, instructionLike, roomChangeDetails, roomChangeWrites } from '../../server/src/chat/turn'
import { patternName } from '../../server/src/tools/rename-pattern'
import { GUEST_TURN_TOOLS } from '../../server/src/chat/guest-tools'
import { PARENT_ONLY_TOOLS } from '../../server/src/chat/subagents'
import { OWN_WORDS_TOOLS, ROOM_FILE_TOOLS, SHARED_TOOLS, namedPaths } from '../../server/src/rooms/ai-tools'
import { stepLabel } from '@mycel/shared'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { legacyProjectFolder } from '../lib/legacy-project'

let A: CApp
beforeAll(async () => { A = await makeCApp('c-file-moves') })
afterAll(async () => { await A.close() })

const put = (rel: string, data: string | Uint8Array) => { const p = path.join(A.team, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data) }
const has = (rel: string) => fs.existsSync(path.join(A.team, ...rel.split('/')))
const bytes = (rel: string) => fs.readFileSync(path.join(A.team, ...rel.split('/')))
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0xff, 0x00, 0xfe])

type Asked = { answer: boolean; questions: string[]; beforeAnswer?: () => Promise<void>; end?: 'timeout' | 'ended'; unattended?: boolean; roomCardEach?: boolean }
let rpcId = 0
async function call(user: Person, name: string, args: unknown, o: { person?: Asked; turn?: boolean; turnId?: string; locale?: 'ko' | 'en' | 'es' } = {}) {
  const turnId = o.turnId ?? (o.turn ? A.turn(user, A.chat(user)) : null)
  const tc = A.toolCtx(user, turnId)
  if (o.person) {
    const p = o.person
    // like chat/tools.ts turnPerson: confirmWhy says how the card ended (a timeout is not a no); a scheduled run's person
    // is unattended and never asked
    tc.person = {
      locale: o.locale ?? 'ko', unattended: p.unattended, ...(p.roomCardEach ? { roomCardEach: true } : {}),
      async confirm(q) { p.questions.push(q); await p.beforeAnswer?.(); return p.answer },
      async confirmWhy(q) { p.questions.push(q); await p.beforeAnswer?.(); return p.answer ? 'yes' : p.end ?? 'declined' },
      *turnUrls() {},
    }
  }
  const h = makeHandler(A.ctx.files, A.ctx.db, tc)
  const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
  return { text: r.result.content[0].text as string, isError: !!r.result.isError, turnId }
}
const ask = (answer: boolean): Asked => ({ answer, questions: [] })

describe('move_files', () => {
  test('attachments (an image and a PDF) into a team folder: one question for the batch, then moved byte for byte', async () => {
    put('users/alice/.attachments/c1/logo.png', png)
    put('users/alice/.attachments/c1/license.pdf', '%PDF-1.4 fake')
    fs.mkdirSync(path.join(A.team, 'shared/company'), { recursive: true })
    const no = ask(false)
    const r0 = await call('alice', 'move_files', { paths: ['users/alice/.attachments/c1/logo.png', 'users/alice/.attachments/c1/license.pdf'], to_folder: 'shared/company' }, { person: no })
    expect(r0.isError).toBe(true)
    expect(r0.text).toContain('did not allow')
    expect(no.questions).toHaveLength(1)
    expect(no.questions[0]).toContain('2개 항목을 전사 공유 › company 폴더로 옮기려고 해요')
    expect(no.questions[0]).toMatch(/\d+명이 더 볼 수 있게 돼요/)
    expect(no.questions[0]).toContain('logo.png')
    expect(has('users/alice/.attachments/c1/logo.png')).toBe(true) // declined: nothing moved
    expect(has('shared/company/logo.png')).toBe(false)

    const yes = ask(true)
    const r = await call('alice', 'move_files', { paths: ['users/alice/.attachments/c1/logo.png', 'users/alice/.attachments/c1/license.pdf'], to_folder: 'shared/company/' }, { person: yes, turn: true })
    expect(r.isError).toBe(false)
    expect(yes.questions).toHaveLength(1)
    expect(r.text).toContain('Moved 2 to shared/company')
    expect(bytes('shared/company/logo.png')).toEqual(Buffer.from(png))
    expect(has('users/alice/.attachments/c1/logo.png')).toBe(false)
    // the file history says which chat turn moved it, and with which tool
    const ev = A.ctx.db.query("SELECT turn_id, detail FROM file_events WHERE path = 'shared/company/logo.png' AND action = 'create' ORDER BY id DESC LIMIT 1").get() as { turn_id: string; detail: string }
    expect(ev.turn_id).toBe(r.turnId!)
    expect(JSON.parse(ev.detail)).toMatchObject({ movedFrom: 'users/alice/.attachments/c1/logo.png', tool: 'move_files' })
    const audit = A.ctx.db.query("SELECT summary FROM tool_events WHERE tool = 'move_files' ORDER BY id DESC LIMIT 1").get() as { summary: string }
    expect(audit.summary).toContain('confirmed by the user')
  })

  test('within the same audience nobody is asked; a taken name gets " (2)"', async () => {
    put('shared/inbox-a/report.md', 'one')
    put('shared/inbox-b/report.md', 'two')
    const p = ask(false)
    const r = await call('alice', 'move_files', { paths: ['shared/inbox-a/report.md'], to_folder: 'shared/inbox-b' }, { person: p })
    expect(r.isError).toBe(false)
    expect(p.questions).toHaveLength(0)
    expect(r.text).toContain('shared/inbox-b/report (2).md')
    expect(bytes('shared/inbox-b/report.md').toString()).toBe('two')
  })

  test('into the personal folder: the people who lose sight of it are counted and asked about', async () => {
    put('shared/to-hide.md', 'x')
    const p = ask(true)
    const r = await call('alice', 'move_files', { paths: ['shared/to-hide.md'], to_folder: 'users/alice' }, { person: p })
    expect(r.isError).toBe(false)
    expect(p.questions[0]).toMatch(/볼 수 있는 \d+명은 더 이상 볼 수 없게 돼요/)
    expect(has('users/alice/to-hide.md')).toBe(true)
  })

  // App review 2026-11-01 sweep: "move 1 item(s)", "1 more people will be able to see them"
  test('English and Spanish cards count one item and one person in the singular', async () => {
    put('shared/one-en.md', 'x')
    const en = ask(false)
    await call('alice', 'move_files', { paths: ['shared/one-en.md'], to_folder: 'users/alice' }, { person: en, locale: 'en' })
    expect(en.questions[0]).toContain('The AI wants to move 1 item to My folder.')
    expect(en.questions[0]).not.toContain('(s)')
    const lost = /(\d+) (person|people) who can see (it|them) now will no longer be able to\. Move (it|them)\?/.exec(en.questions[0]!)
    expect(lost).not.toBeNull()
    expect(lost![2]).toBe(lost![1] === '1' ? 'person' : 'people')
    expect([lost![3], lost![4]]).toEqual(['it', 'it'])
    put('users/alice/one-es.md', 'x')
    const es = ask(false)
    await call('alice', 'copy_files', { paths: ['users/alice/one-es.md'], to_folder: 'shared' }, { person: es, locale: 'es' })
    expect(es.questions[0]).toContain('La IA quiere copiar 1 archivo a Toda la empresa.')
    const added = /(\d+) (persona más podrá|personas más podrán) verlo\. ¿Copiarlo\?/.exec(es.questions[0]!)
    expect(added).not.toBeNull()
    expect(added![2]).toBe(added![1] === '1' ? 'persona más podrá' : 'personas más podrán')
  })

  test('with nobody to ask (no chat person), a change of audience is refused and nothing moves', async () => {
    put('users/alice/private-plan.md', 'secret')
    const r = await call('alice', 'move_files', { paths: ['users/alice/private-plan.md'], to_folder: 'shared' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('nobody can confirm it here')
    expect(has('users/alice/private-plan.md')).toBe(true)
  })

  // bug 1 (docs/DECISIONS.md "Refusals say why, who and what next"): a scheduled run's person is never asked, and the
  // text said "the user did not allow this"
  test('a scheduled run (an unattended person): nobody is asked, and the text says so, never "did not allow"', async () => {
    put('users/alice/weekly.md', 'w')
    const p: Asked = { answer: true, questions: [], unattended: true }
    const r = await call('alice', 'move_files', { paths: ['users/alice/weekly.md'], to_folder: 'shared' }, { person: p })
    expect(r.isError).toBe(true)
    expect(p.questions).toHaveLength(0)
    expect(r.text).toContain('Nothing was moved.')
    expect(r.text).toContain('Why: nobody could be asked: this is a scheduled run with nobody watching')
    expect(r.text).toContain('The user did not refuse anything')
    expect(r.text).not.toContain('did not allow')
    expect(r.text).toContain('Next step: the user can do it in a chat, where they answer the card, or on the Files screen ("파일")')
    expect(has('users/alice/weekly.md')).toBe(true)
  })

  test('a card that timed out is not a no; a no says so', async () => {
    put('users/alice/late.md', 'l')
    const late: Asked = { answer: false, questions: [], end: 'timeout' }
    const r = await call('alice', 'copy_files', { paths: ['users/alice/late.md'], to_folder: 'shared' }, { person: late })
    expect(r.isError).toBe(true)
    expect(late.questions).toHaveLength(1)
    expect(r.text).toContain('Nothing was copied.')
    expect(r.text).toContain('did not answer the confirmation card in time')
    expect(r.text).toContain('This is not a no')
    expect(r.text).not.toContain('did not allow')
    const no = await call('alice', 'copy_files', { paths: ['users/alice/late.md'], to_folder: 'shared' }, { person: ask(false) })
    expect(no.text).toContain('The user did not allow this, so nothing was copied.')
    expect(no.text).toContain('Why: the user did not allow it: they said no on the confirmation card.')
    expect(no.text).toContain('Next step: ask the user what they want.')
    expect(has('shared/late.md')).toBe(false)
  })

  // B9 / bug 5: the target folder is made (the prompt told the AI to write a README.md to make one)
  test('into a folder that is not there yet: the card says it is new, the folder is made after the yes, and nothing else is written', async () => {
    put('users/alice/contracts/a.pdf', '%PDF-1.4 a')
    put('users/alice/contracts/b.pdf', '%PDF-1.4 b')
    const no = ask(false)
    const r0 = await call('alice', 'move_files', { paths: ['users/alice/contracts/a.pdf', 'users/alice/contracts/b.pdf'], to_folder: 'shared/계약서/2026' }, { person: no })
    expect(r0.isError).toBe(true)
    expect(no.questions[0]).toContain('AI가 2개 항목을 새로 만들 전사 공유 › 계약서 › 2026 폴더로 옮기려고 해요.')
    expect(r0.text).toContain('shared/계약서/2026 (a new folder)')
    // a no makes no folder
    expect(has('shared/계약서')).toBe(false)

    const en = ask(false)
    await call('alice', 'move_files', { paths: ['users/alice/contracts/a.pdf'], to_folder: 'shared/계약서/2026' }, { person: en, locale: 'en' })
    expect(en.questions[0]).toContain('The AI wants to move 1 item to Company-wide › 계약서 › 2026, a new folder it will make.')

    const yes = ask(true)
    const r = await call('alice', 'move_files', { paths: ['users/alice/contracts/a.pdf', 'users/alice/contracts/b.pdf'], to_folder: 'shared/계약서/2026' }, { person: yes, turn: true })
    expect(r.isError).toBe(false)
    expect(yes.questions).toHaveLength(1)
    expect(r.text).toContain('Made the new folder shared/계약서/2026.')
    expect(r.text).toContain('Moved 2 to shared/계약서/2026')
    expect(fs.readdirSync(path.join(A.team, 'shared/계약서/2026')).sort()).toEqual(['a.pdf', 'b.pdf'])
    expect(fs.readdirSync(path.join(A.team, 'shared/계약서'))).toEqual(['2026'])
    // no README or any other file was made on the way
    expect(has('shared/계약서/README.md') || has('shared/계약서/2026/README.md')).toBe(false)
    // each new folder is in the file history with the turn and the tool
    const made = A.ctx.db.query("SELECT path, detail FROM file_events WHERE turn_id = ? AND action = 'create' AND detail LIKE '%\"folder\":true%' ORDER BY id").all(r.turnId) as { path: string; detail: string }[]
    expect(made.map((m) => m.path)).toEqual(['shared/계약서', 'shared/계약서/2026'])
    expect(JSON.parse(made[0]!.detail)).toMatchObject({ folder: true, tool: 'move_files' })

    // the same audience (no card): copy_files makes the folder too
    put('shared/inbox-n/note.md', 'n')
    const quiet = ask(false)
    const c = await call('alice', 'copy_files', { paths: ['shared/inbox-n/note.md'], to_folder: 'shared/new-copies/2026' }, { person: quiet })
    expect(c.isError).toBe(false)
    expect(quiet.questions).toHaveLength(0)
    expect(bytes('shared/new-copies/2026/note.md').toString()).toBe('n')
  })

  test('TC-018: the answer\'s file summary counts the moved files, not the folder made for them, and says they moved', async () => {
    put('users/alice/tc018/a.md', 'a')
    put('users/alice/tc018/b.md', 'b')
    const r = await call('alice', 'move_files', { paths: ['users/alice/tc018/a.md', 'users/alice/tc018/b.md'], to_folder: 'shared/tc018/2026' }, { person: ask(true), turn: true })
    expect(r.isError).toBe(false)
    const rows = A.ctx.db.query('SELECT path, action, detail FROM file_events WHERE turn_id = ? ORDER BY id').all(r.turnId) as { path: string; action: string; detail: string | null }[]
    // the turn made two folders and moved two files: two files, both moved ("3 files saved · Created" before)
    expect(rows.filter((x) => x.action === 'create').length).toBe(4)
    expect(fileSummaryOf(rows)).toEqual({ saved: [{ path: 'shared/tc018/2026/a.md', action: 'create', moved: true }, { path: 'shared/tc018/2026/b.md', action: 'create', moved: true }], conflicts: [], rejected: [] })
    // only folders made (empty): nothing to show
    expect(fileSummaryOf(rows.filter((x) => JSON.parse(x.detail ?? '{}').folder))).toBeNull()
  })

  test('the file summary of moves within one answer: a file it made and then moved is new where it is now; a changed one moved says moved; a folder that came with its files stays a row', () => {
    const ev = (path: string, action: string, detail: Record<string, unknown> = {}) => ({ path, action, detail: JSON.stringify(detail) })
    const rows = [
      ev('shared/drafts', 'create', { folder: true, tool: 'make_folder' }),
      ev('shared/drafts/new.md', 'create', { tool: 'write' }),
      ev('shared/old.md', 'update', { tool: 'edit' }),
      ev('shared/drafts/new.md', 'delete', { movedTo: 'shared/final/new.md', folder: false, tool: 'move_files' }),
      ev('shared/final/new.md', 'create', { movedFrom: 'shared/drafts/new.md', folder: false, tool: 'move_files' }),
      ev('shared/old.md', 'delete', { movedTo: 'shared/final/old.md', folder: false, tool: 'move_files' }),
      ev('shared/final/old.md', 'create', { movedFrom: 'shared/old.md', folder: false, tool: 'move_files' }),
      // a folder moved with its files, and a skill copied whole (one event for the folder): each still one row
      ev('shared/box', 'delete', { movedTo: 'shared/final/box', folder: true, tool: 'move_files' }),
      ev('shared/final/box', 'create', { movedFrom: 'shared/box', folder: true, tool: 'move_files' }),
      ev('skills/brief', 'create', { folder: true, copiedFrom: 'users/alice/skills/brief', sourcePaths: ['users/alice/skills/brief'], files: 2, tool: 'skill_files' }),
      ev('shared/final/copy.md', 'create', { copiedFrom: 'shared/x.md', tool: 'copy_files' }),
    ]
    expect(fileSummaryOf(rows)?.saved).toEqual([
      { path: 'shared/final/new.md', action: 'create' },
      { path: 'shared/final/old.md', action: 'create', moved: true },
      { path: 'shared/final/box', action: 'create', moved: true },
      { path: 'skills/brief', action: 'create' },
      { path: 'shared/final/copy.md', action: 'create' },
    ])
  })

  // independent review: a folder made for a call where nothing went in stayed behind, empty, as a "new folder"
  test('a new folder where nothing went in (a folder copied, a group folder for a member) is taken away again', async () => {
    put('shared/inbox-f/sub/a.md', 'a')
    const c = await call('alice', 'copy_files', { paths: ['shared/inbox-f/sub'], to_folder: 'shared/never-made' }, { person: ask(true), turn: true })
    expect(c.isError).toBe(true)
    expect(c.text).not.toContain('Made the new folder')
    expect(has('shared/never-made')).toBe(false)
    const m = await call('alice', 'move_files', { paths: ['groups/marketing'], to_folder: 'shared/never-made-2/x' }, { person: ask(true), turn: true })
    expect(m.isError).toBe(true)
    expect(has('shared/never-made-2')).toBe(false)
    const ev = A.ctx.db.query("SELECT COUNT(*) AS n FROM file_events WHERE path LIKE 'shared/never-made%'").get() as { n: number }
    expect(ev.n).toBe(0)
  })

  test('a new folder where the person may not write is refused like any save there', async () => {
    put('users/alice/x.md', 'x')
    const r = await call('alice', 'move_files', { paths: ['users/alice/x.md'], to_folder: 'groups/finance/new' }, { person: ask(true) })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('not found or no access')
    expect(has('groups/finance/new')).toBe(false)
  })

  test('a path the person may not use fails alone (same answer as a missing one); the rest is moved', async () => {
    put('users/bob/mine.md', 'bob')
    fs.mkdirSync(path.join(A.team, 'users/bob/archive'), { recursive: true })
    const r2 = await call('bob', 'move_files', { paths: ['groups/marketing/campaign-brief.md', 'users/bob/mine.md', 'users/bob/nope.md'], to_folder: 'users/bob/archive' }, { person: ask(true) })
    expect(r2.isError).toBe(false)
    expect(r2.text).toContain('users/bob/mine.md -> users/bob/archive/mine.md')
    expect(r2.text).toContain('Not moved:')
    expect(r2.text).toContain('groups/marketing/campaign-brief.md: not found or no access')
    expect(r2.text).toContain('users/bob/nope.md: not found')
    expect(has('groups/marketing/campaign-brief.md')).toBe(true)
  })

  test('skills/ is out of reach, both ways', async () => {
    const into = await call('carol', 'move_files', { paths: ['shared/glossary.md'], to_folder: 'skills' }, { person: ask(true) })
    expect(into.isError).toBe(true)
    expect(into.text).toContain('skills/')
    const out = await call('carol', 'move_files', { paths: ['skills/team-rules.md'], to_folder: 'shared' }, { person: ask(true) })
    expect(out.isError).toBe(true)
    expect(has('skills/team-rules.md')).toBe(true)
  })

  test('a group\'s skills folder (docs/DECISIONS.md "Group skills") cannot be made by a rename or a move, nor emptied', async () => {
    // groups/marketing/skills is not there yet: a renamed or moved folder would become the group's skills
    put('groups/marketing/drafts/evil.md', '---\nname: Evil\ndescription: x\n---\nsteps\n')
    put('groups/marketing/tmp/skills/evil2.md', '---\nname: Evil2\ndescription: x\n---\nsteps\n')
    const renamed = await call('alice', 'rename_file', { path: 'groups/marketing/drafts', new_name: 'skills' }, { person: ask(true), turn: true })
    expect(renamed.isError).toBe(true)
    expect(renamed.text).toContain('skills folder')
    const moved = await call('alice', 'move_files', { paths: ['groups/marketing/tmp/skills'], to_folder: 'groups/marketing' }, { person: ask(true), turn: true })
    expect(moved.isError).toBe(true)
    expect(has('groups/marketing/skills')).toBe(false)
    // the file layer refuses it too, for any AI move (turn set); a person on the Files screen (no turn) may
    const { componentC } = await import('../../server/src/team-files/component')
    const turnId = A.turn('alice', A.chat('alice'))
    expect(() => componentC(A.ctx).files.move('alice', 'groups/marketing/drafts', 'groups/marketing/skills', 'fail', { turnId })).toThrow(/skills folder/)
    const adminTurn = A.turn('carol', A.chat('carol'))
    expect(() => componentC(A.ctx).files.move('carol', 'groups/marketing/tmp', 'groups/tmp2', 'fail', { turnId: adminTurn })).toThrow(/skills folder/)
    // and out of an existing one
    put('groups/marketing/skills/kept.md', '---\nname: Kept\ndescription: x\n---\nsteps\n')
    const out = await call('alice', 'move_files', { paths: ['groups/marketing/skills/kept.md'], to_folder: 'groups/marketing/drafts' }, { person: ask(true), turn: true })
    expect(out.isError).toBe(true)
    expect(has('groups/marketing/skills/kept.md')).toBe(true)
  })

  test('an admin\'s AI cannot move a group folder holding skills out (its skills would leave); a person on the Files screen can', async () => {
    put('groups/gs-sales/skills/offer.md', '---\nname: Offer\ndescription: x\n---\nsteps\n')
    put('groups/gs-sales/notes.md', 'notes\n')
    fs.mkdirSync(path.join(A.team, 'shared/archive'), { recursive: true })
    const { componentC } = await import('../../server/src/team-files/component')
    const turnId = A.turn('carol', A.chat('carol'))
    expect(() => componentC(A.ctx).files.move('carol', 'groups/gs-sales', 'shared/archive/gs-sales', 'fail', { turnId })).toThrow(/skills folder/)
    // a rename inside groups/ too
    expect(() => componentC(A.ctx).files.move('carol', 'groups/gs-sales', 'groups/gs-sales-2', 'fail', { turnId })).toThrow(/skills folder/)
    const tool = await call('carol', 'move_files', { paths: ['groups/gs-sales'], to_folder: 'shared/archive' }, { person: ask(true), turn: true })
    expect(tool.isError).toBe(true)
    expect(has('groups/gs-sales/skills/offer.md')).toBe(true)
    // the same move by a person (no turn): allowed, as before
    componentC(A.ctx).files.move('carol', 'groups/gs-sales', 'shared/archive/gs-sales', 'fail')
    expect(has('shared/archive/gs-sales/skills/offer.md')).toBe(true)
  })

  test('the refusal points at move_skill for a move and for a copy, and forbids stand-ins (docs/DECISIONS.md "Project skills")', async () => {
    const r = await call('carol', 'move_files', { paths: ['skills/team-rules.md'], to_folder: 'projects/falcon' }, { person: ask(true), turn: true })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('do not move or copy with the file tools')
    expect(r.text).toContain('use move_skill: to move it, or with keep: true to copy it when the user asks for a copy')
    expect(r.text).toContain('Never leave a README or an empty skills folder as a stand-in')
    // a copy the person asked for is no longer forbidden
    expect(r.text).not.toContain('a README or a copy')
    // the old pointer at the Files screen is gone
    expect(r.text).not.toContain('or the Files screen')
  })

  test('a project\'s skills folder (projects/<name>/skills) cannot be made, emptied or taken along by the AI', async () => {
    const { componentC } = await import('../../server/src/team-files/component')
    put('projects/falcon/drafts/skills/evil/SKILL.md', '---\nname: evil\ndescription: x\n---\nsteps\n')
    // made by a rename or a move into the project folder
    const renamed = await call('alice', 'rename_file', { path: 'projects/falcon/drafts', new_name: 'skills' }, { person: ask(true), turn: true })
    expect(renamed.isError).toBe(true)
    const moved = await call('alice', 'move_files', { paths: ['projects/falcon/drafts/skills'], to_folder: 'projects/falcon' }, { person: ask(true), turn: true })
    expect(moved.isError).toBe(true)
    expect(has('projects/falcon/skills/evil')).toBe(false)
    // a folder holding a skills/ folder into projects/: it would become a project's skills folder. An admin who is no
    // member writes nothing in projects/<name> (docs/DECISIONS.md "Project contents only for members"); someone a rule
    // on projects/ lets write there meets the skill guard
    put('shared/kit/skills/x/SKILL.md', '---\nname: x\ndescription: x\n---\nsteps\n')
    const turnId = A.turn('carol', A.chat('carol'))
    const aliceTurn = A.turn('alice', A.chat('alice'))
    expect(() => componentC(A.ctx).files.move('carol', 'shared/kit', 'projects/kit', 'fail', { turnId })).toThrow(/not found or no access|only a new project makes a folder directly in 'projects\/'/)
    A.ctx.db.query("INSERT INTO folders (id, path) VALUES ('f_moves_projects_top', 'projects')").run()
    A.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_moves_projects_top', 'f_moves_projects_top', 'user', 'alice', 'write')").run()
    try {
      expect(() => componentC(A.ctx).files.move('alice', 'shared/kit', 'projects/kit', 'fail', { turnId: aliceTurn })).toThrow(/do not move or copy with the file tools/)
      // the rule on projects/ does not reach in for an admin
      expect(() => componentC(A.ctx).files.move('carol', 'shared/kit', 'projects/kit', 'fail', { turnId })).toThrow(/not found or no access|only a new project makes a folder directly in 'projects\/'/)
    } finally {
      A.ctx.db.query("DELETE FROM folder_rules WHERE id = 'r_moves_projects_top'").run()
      A.ctx.db.query("DELETE FROM folders WHERE id = 'f_moves_projects_top'").run()
    }
    expect(has('projects/kit')).toBe(false)
    // emptied, or carried off with the project's folder (by its member; an admin who is no member does not see it)
    put('projects/falcon/skills/kept/SKILL.md', '---\nname: kept\ndescription: x\n---\nsteps\n')
    const out = await call('alice', 'move_files', { paths: ['projects/falcon/skills/kept'], to_folder: 'projects/falcon/drafts' }, { person: ask(true), turn: true })
    expect(out.isError).toBe(true)
    expect(() => componentC(A.ctx).files.move('carol', 'projects/falcon', 'shared/falcon-old', 'fail', { turnId })).toThrow(/not found or no access|only a new project makes a folder directly in 'projects\/'/)
    await expect(componentC(A.ctx).files.copy('carol', 'shared/glossary.md', 'projects/falcon/skills/kept/notes.md', { turnId })).rejects.toThrow(/not found or no access|only a new project makes a folder directly in 'projects\/'/)
    // carol as a member who writes all of it (person rules on its rule folders, as its members dialog adds them): the
    // skill guard for the AI; and a project's folder never leaves projects/, also on the Files screen (409)
    type Rule = { subjectType: 'everyone' | 'role' | 'group' | 'user'; subjectId: string | null; access: 'none' | 'read' | 'write' }
    const rulesOf = (p: string) => A.ctx.db.query('SELECT r.subject_type AS subjectType, r.subject_id AS subjectId, r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = ?').all(p) as Rule[]
    const kept = ['projects/falcon', 'projects/falcon/public'].map((p) => [p, rulesOf(p)] as const)
    for (const [p, rules] of kept) legacyProjectFolder(A.ctx.db, A.team, p, [...rules, { subjectType: 'user', subjectId: 'carol', access: 'write' }])
    try {
      expect(() => componentC(A.ctx).files.move('carol', 'projects/falcon', 'shared/falcon-old', 'fail', { turnId })).toThrow(/do not move or copy with the file tools/)
      await expect(componentC(A.ctx).files.copy('carol', 'shared/glossary.md', 'projects/falcon/skills/kept/notes.md', { turnId })).rejects.toThrow(/do not move or copy with the file tools/)
      let err: unknown
      try { componentC(A.ctx).files.move('carol', 'projects/falcon', 'shared/falcon-old', 'fail') } catch (e) { err = e }
      expect((err as { params?: Record<string, unknown> } | undefined)?.params).toEqual({ reason: 'project_location' })
    } finally {
      for (const [p, rules] of kept) legacyProjectFolder(A.ctx.db, A.team, p, rules)
    }
    await expect(componentC(A.ctx).files.copy('alice', 'shared/glossary.md', 'projects/falcon/skills/kept/notes.md', { turnId: aliceTurn })).rejects.toThrow(/do not move or copy with the file tools/)
    expect(has('projects/falcon/skills/kept/SKILL.md')).toBe(true)
    expect(has('shared/falcon-old')).toBe(false)
  })

  test('an admin moving a project\'s folder into projects/ is refused when no member there: nothing moves, no skill switches on', async () => {
    const { componentC } = await import('../../server/src/team-files/component')
    put('shared/pricing/skills/margin/SKILL.md', '---\nname: margin\ndescription: x\n---\nsteps\n')
    put('shared/pricing/skills/README.md', '# x\n')
    A.ctx.db.query('INSERT INTO projects (id, name, folder_path, created_by, created_at) VALUES (?,?,?,?,?)').run('01900000-0000-7000-8000-0000000c0001', 'Pricing', 'shared/pricing', 'carol', new Date().toISOString())
    const svc = componentC(A.ctx).files
    // projects/<name> is its members' (docs/DECISIONS.md "Project contents only for members"): asked first or not, an
    // admin writes no new folder there, so the skills are never switched on there
    for (const skillsOk of [false, true]) expect(() => svc.move('carol', 'shared/pricing', 'projects/pricing', 'fail', { skillsOk })).toThrow(/not found or no access|only a new project makes a folder directly in 'projects\/'/)
    expect(has('shared/pricing/skills/margin/SKILL.md')).toBe(true)
    expect(has('projects/pricing')).toBe(false)
    expect(A.ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'skills.change' AND target = 'projects/pricing/skills/margin/SKILL.md'").get()).toBeNull()
  })

  test('a project\'s folder is not renamed inside projects/, also by an admin who is its member: a new name is a new entry right in projects/; its skills stay where they are', async () => {
    const { componentC } = await import('../../server/src/team-files/component')
    const svc = componentC(A.ctx).files
    legacyProjectFolder(A.ctx.db, A.team, 'projects/pricing-1', [{ subjectType: 'user', subjectId: 'carol', access: 'write' }], 'carol')
    put('projects/pricing-1/skills/margin/SKILL.md', '---\nname: margin\ndescription: x\n---\nsteps\n')
    // nobody but the server makes an entry directly in projects/ (docs/DECISIONS.md "Project contents only for members")
    for (const skillsOk of [false, true]) expect(() => svc.move('carol', 'projects/pricing-1', 'projects/pricing-2', 'fail', { skillsOk })).toThrow()
    expect(has('projects/pricing-1/skills/margin/SKILL.md')).toBe(true)
    expect(has('projects/pricing-2')).toBe(false)
    expect(A.ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'skills.change' AND target LIKE 'projects/pricing-2%'").get()).toBeNull()
  })

  test('the AI cannot copy into skills/ or a group\'s skills folder (the file layer); a person can', async () => {
    const { componentC } = await import('../../server/src/team-files/component')
    put('groups/marketing/skills/.keep', '')
    const turnId = A.turn('carol', A.chat('carol'))
    await expect(componentC(A.ctx).files.copy('carol', 'shared/glossary.md', 'skills/copied-glossary.md', { turnId })).rejects.toThrow(/skills folder/)
    await expect(componentC(A.ctx).files.copy('carol', 'shared/glossary.md', 'groups/marketing/skills/copied-glossary.md', { turnId })).rejects.toThrow(/skills folder/)
    expect(has('skills/copied-glossary.md')).toBe(false)
    expect(has('groups/marketing/skills/copied-glossary.md')).toBe(false)
    await componentC(A.ctx).files.copy('carol', 'shared/glossary.md', 'skills/copied-glossary.md')
    expect(has('skills/copied-glossary.md')).toBe(true)
  })

  test('a group folder moves only for admins and owners, as on the Files screen; the text says where, naming no admin (B14)', async () => {
    fs.mkdirSync(path.join(A.team, 'shared/elsewhere'), { recursive: true })
    const r = await call('alice', 'move_files', { paths: ['groups/marketing'], to_folder: 'shared/elsewhere' }, { person: ask(true) })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('can only be moved, renamed or deleted by an admin. The user is not an admin; an admin can do it on the Files screen ("파일").')
    // roles stay hidden (the people directory shows none): no admin by name
    expect(r.text).not.toMatch(/Dana Choi|Carol Park/)
    expect(has('groups/marketing/campaign-brief.md')).toBe(true)
  })

  test('at most 50 paths per call', async () => {
    const r = await call('alice', 'move_files', { paths: Array.from({ length: 51 }, (_, i) => `shared/x${i}.md`), to_folder: 'shared' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Invalid input')
  })
})

describe('copy_files', () => {
  test('a personal PDF into a team folder: asked, copied, the original stays', async () => {
    put('users/alice/certs/business.pdf', '%PDF-1.4 cert')
    fs.mkdirSync(path.join(A.team, 'shared/certs'), { recursive: true })
    const p = ask(true)
    const r = await call('alice', 'copy_files', { paths: ['users/alice/certs/business.pdf'], to_folder: 'shared/certs' }, { person: p, turn: true })
    expect(r.isError).toBe(false)
    expect(p.questions).toHaveLength(1)
    expect(p.questions[0]).toContain('파일 1개를 전사 공유 › certs 폴더에 복사하려고 해요')
    expect(bytes('shared/certs/business.pdf').toString()).toBe('%PDF-1.4 cert')
    expect(has('users/alice/certs/business.pdf')).toBe(true)
    const ev = A.ctx.db.query("SELECT turn_id, detail FROM file_events WHERE path = 'shared/certs/business.pdf' ORDER BY id DESC LIMIT 1").get() as { turn_id: string; detail: string }
    expect(ev.turn_id).toBe(r.turnId!)
    expect(JSON.parse(ev.detail)).toMatchObject({ sourcePaths: ['users/alice/certs/business.pdf'], widened: true, tool: 'copy_files' })
  })

  test('a file only some people may read is never copied where others can see it without the person saying yes', async () => {
    const p = ask(false)
    const r = await call('bob', 'copy_files', { paths: ['groups/finance/budget.md'], to_folder: 'shared' }, { person: p })
    expect(r.isError).toBe(true)
    expect(p.questions).toHaveLength(1)
    expect(fs.readdirSync(path.join(A.team, 'shared')).some((n) => n.startsWith('budget'))).toBe(false)
  })

  test('folders are not copied', async () => {
    fs.mkdirSync(path.join(A.team, 'users/alice/folder-to-copy'), { recursive: true })
    put('users/alice/folder-to-copy/a.md', 'a')
    const r = await call('alice', 'copy_files', { paths: ['users/alice/folder-to-copy'], to_folder: 'users/alice/drafts' }, { person: ask(true) })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('copy_files copies files only')
  })
})

describe('rename_file', () => {
  test('in place, without a question; a bad name, a path or a taken name is refused', async () => {
    put('users/alice/old-name.md', 'r')
    const p = ask(false)
    const r = await call('alice', 'rename_file', { path: 'users/alice/old-name.md', new_name: '새 이름.md' }, { person: p })
    expect(r.isError).toBe(false)
    expect(p.questions).toHaveLength(0)
    expect(has('users/alice/새 이름.md')).toBe(true)
    expect((await call('alice', 'rename_file', { path: 'users/alice/새 이름.md', new_name: 'shared/x.md' })).text).toContain('use move_files')
    expect((await call('alice', 'rename_file', { path: 'users/alice/새 이름.md', new_name: 'bad?.md' })).text).toContain('invalid name')
    put('users/alice/taken.md', 't')
    const taken = await call('alice', 'rename_file', { path: 'users/alice/새 이름.md', new_name: 'taken.md' })
    expect(taken.isError).toBe(true)
    expect(bytes('users/alice/taken.md').toString()).toBe('t')
  })
})

// TC-4983: before, one rename_file call per file ("rename these 200 photos" took 200 calls)
describe('rename_files', () => {
  test('a list in one call: each with rename_file\'s checks, a failing item alone; no question; the turn in the history', async () => {
    put('users/alice/batch/a.md', 'a'); put('users/alice/batch/b.md', 'b'); put('users/alice/batch/c.md', 'c'); put('users/alice/batch/taken.md', 't')
    const p = ask(false)
    const r = await call('alice', 'rename_files', { renames: [
      { path: 'users/alice/batch/a.md', new_name: 'a-2026.md' },
      { path: 'users/alice/batch/b.md', new_name: 'taken.md' },
      { path: 'users/alice/batch/c.md', new_name: 'bad?.md' },
      { path: 'groups/finance/budget.md', new_name: 'x.md' },
      { path: 'users/alice/batch/c.md', new_name: 'twice.md' },
    ] }, { person: p, turn: true })
    expect(r.isError).toBe(false)
    expect(p.questions).toHaveLength(0)
    expect(r.text).toContain('Renamed 1:\n- users/alice/batch/a.md -> a-2026.md')
    expect(r.text).toContain('- users/alice/batch/b.md: ')
    expect(r.text).toContain('- users/alice/batch/c.md: invalid name')
    expect(r.text).toContain('- groups/finance/budget.md: not found or no access')
    expect(has('users/alice/batch/a-2026.md')).toBe(true)
    expect(bytes('users/alice/batch/taken.md').toString()).toBe('t')
    expect(has('users/alice/batch/b.md') && has('users/alice/batch/c.md')).toBe(true)
    const ev = A.ctx.db.query("SELECT turn_id, detail FROM file_events WHERE path = 'users/alice/batch/a-2026.md' AND action = 'create' ORDER BY id DESC LIMIT 1").get() as { turn_id: string; detail: string }
    expect(ev.turn_id).toBe(r.turnId!)
    expect(JSON.parse(ev.detail)).toMatchObject({ movedFrom: 'users/alice/batch/a.md', tool: 'rename_files' })
    const audit = A.ctx.db.query("SELECT summary FROM tool_events WHERE tool = 'rename_files' ORDER BY id DESC LIMIT 1").get() as { summary: string }
    expect(audit.summary).toBe('rename_files 1/4')
  })

  test('200 photos by a pattern in one call; a regular expression with groups; only names directly inside the folder', async () => {
    for (let i = 1; i <= 200; i++) put(`users/alice/photos/IMG_${String(i).padStart(4, '0')}.jpg`, `p${i}`)
    put('users/alice/photos/notes.txt', 'n'); put('users/alice/photos/deeper/IMG_9999.jpg', 'deep')
    const r = await call('alice', 'rename_files', { folder: 'users/alice/photos', find: 'IMG_', replace: 'trip-' }, { turn: true })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('Renamed 200 in users/alice/photos:')
    expect(r.text).not.toContain('more names match')
    expect(has('users/alice/photos/trip-0001.jpg') && has('users/alice/photos/trip-0200.jpg')).toBe(true)
    expect(has('users/alice/photos/IMG_0001.jpg')).toBe(false)
    expect(has('users/alice/photos/notes.txt') && has('users/alice/photos/deeper/IMG_9999.jpg')).toBe(true)
    // at the end of a name only (and the start, below): "jpg-notes.txt" keeps its "jpg"
    put('users/alice/photos/jpg-notes.txt', 'j')
    const re = await call('alice', 'rename_files', { folder: 'users/alice/photos', find: '.jpg', replace: '.jpeg', at: 'end' }, { turn: true })
    expect(re.isError).toBe(false)
    expect(has('users/alice/photos/trip-0001.jpeg') && has('users/alice/photos/jpg-notes.txt')).toBe(true)
    expect((await call('alice', 'rename_files', { folder: 'users/alice/photos', find: 'trip-', replace: 'day-', at: 'start' })).text).toContain('Renamed 200')
    expect(has('users/alice/photos/day-0200.jpeg')).toBe(true)
    // nothing matches: said so
    expect((await call('alice', 'rename_files', { folder: 'users/alice/photos', find: 'nothing-like-this', replace: 'x' })).text).toContain('Nothing was renamed')
    // no regular expressions (review of #1327): regex is not an argument, and "(" is plain text
    expect((await call('alice', 'rename_files', { folder: 'users/alice/photos', find: '(', replace: 'x', regex: true })).isError).toBe(true)
    expect((await call('alice', 'rename_files', { folder: 'users/alice/photos', find: '(', replace: 'x' })).text).toContain('Nothing was renamed')
    // a folder the person cannot see answers like a missing one
    expect((await call('alice', 'rename_files', { folder: 'groups/finance', find: 'budget', replace: 'b' })).text).toContain('not found or no access')
    // one way or the other, not both
    expect((await call('alice', 'rename_files', { folder: 'users/alice/photos' })).isError).toBe(true)
    expect((await call('alice', 'rename_files', { renames: [{ path: 'users/alice/photos/notes.txt', new_name: 'n.txt' }], folder: 'users/alice/photos', find: 'x' })).isError).toBe(true)
  })

  test('more than 500 matches: the first 500 are renamed, the answer says how many are left, a second call does the rest', async () => {
    for (let i = 0; i < 520; i++) put(`users/alice/many/f-${i}.txt`, 'x')
    const r = await call('alice', 'rename_files', { folder: 'users/alice/many', find: 'f-', replace: 'file-' })
    expect(r.text).toContain('Renamed 500')
    expect(r.text).toContain('20 more names match: at most 500 are renamed per call')
    const rest = await call('alice', 'rename_files', { folder: 'users/alice/many', find: 'f-', replace: 'file-' })
    expect(rest.text).toContain('Renamed 20')
    expect(fs.readdirSync(path.join(A.team, 'users/alice/many')).filter((n) => n.startsWith('file-'))).toHaveLength(520)
    // a list over 500 is refused by its input check
    // (520 files made and renamed: room for a busy machine, 7 s seen under a load of 50)
    expect((await call('alice', 'rename_files', { renames: Array.from({ length: 501 }, (_, i) => ({ path: `users/alice/many/file-${i}.txt`, new_name: `g-${i}.txt` })) })).isError).toBe(true)
  }, 60_000)

  test('offered wherever rename_file is (shared chats, guests, sub-agents); what it names; the room card sees where names land', () => {
    for (const set of [SHARED_TOOLS, GUEST_TURN_TOOLS, ROOM_FILE_TOOLS, OWN_WORDS_TOOLS]) expect([set.has('rename_file'), set.has('rename_files')]).toEqual([true, true])
    expect([PARENT_ONLY_TOOLS.has('rename_file'), PARENT_ONLY_TOOLS.has('rename_files')]).toEqual([false, false])
    // every listed path and a pattern's folder count as read in a shared chat (its read card)
    expect(namedPaths('rename_files', { renames: [{ path: 'a/x.md', new_name: 'y.md' }, { path: 'b/z.md', new_name: 'w.md' }] }).map((x) => x.value)).toEqual(['a/x.md', 'b/z.md'])
    expect(namedPaths('rename_files', { folder: 'shared/photos', find: 'IMG', replace: 'p' }).map((x) => x.value)).toEqual(['shared/photos'])
    // a rename onto an instruction file is seen before the call, from a list and from a pattern (the names it would make)
    const tree = (p: string) => (p === 'shared/notes' ? ['readme.md', 'plan.md', 'sub/deep.md'] : [])
    expect(roomChangeWrites('rename_files', { renames: [{ path: 'shared/notes/readme.md', new_name: 'CLAUDE.md' }] }, tree).targets.some(instructionLike)).toBe(true)
    expect(roomChangeWrites('rename_files', { folder: 'shared/notes', find: 'readme', replace: 'CLAUDE', at: 'start' }, tree).targets.some(instructionLike)).toBe(true)
    const plain = roomChangeWrites('rename_files', { folder: 'shared/notes', find: 'plan', replace: 'plan-v2' }, tree)
    expect(plain.targets).toEqual(['shared/notes/plan-v2.md'])
    expect(plain.targets.some(instructionLike)).toBe(false)
    // past the scan limit or a pattern that cannot be read: counted as holding one
    expect(roomChangeWrites('rename_files', { folder: 'shared/notes', find: 'x', replace: 'y' }, () => null).targets.some(instructionLike)).toBe(true)
    // the card lists the files a pattern renames, old → new, the first 50 then "+N"
    const card = roomChangeDetails('rename_files', { folder: 'shared/notes', find: 'plan', replace: 'plan-v2' }, 'en', undefined, undefined, '', tree)
    expect(card[0]!.text).toBe('plan.md → plan-v2.md')
    const many = Array.from({ length: 80 }, (_, i) => `IMG_${i}.jpg`)
    expect(roomChangeDetails('rename_files', { folder: 'shared/p', find: 'IMG_', replace: 'p-' }, 'en', undefined, undefined, '', () => many)[0]!.text.split('\n')).toEqual([...many.slice(0, 50).map((n) => `${n} → ${n.replace('IMG_', 'p-')}`), '… +30'])
    expect(stepLabel('rename_files', { folder: 'shared/photos', find: 'IMG', replace: 'p' }, 'en', new Set())).toBe('Rename files · shared/photos')
    expect(stepLabel('rename_files', { renames: [{ path: 'a/x.md', new_name: 'y' }, { path: 'a/z.md', new_name: 'w' }] }, 'en', new Set())).toBe('Rename files · a/x.md +1')
  })

  test('matching is plain text in linear time: the patterns that took seconds as regular expressions finish at once', () => {
    const t0 = performance.now()
    for (const find of ['((a)+)+$', '((a+))+$', '(?:(a+))+$', '(a+)+$', '(a|aa)+$']) {
      for (const name of ['a'.repeat(254) + '!', 'a'.repeat(255), `${'a'.repeat(120)}${find}${'a'.repeat(100)}`]) patternName(name, find, 'x')
    }
    expect(performance.now() - t0).toBeLessThan(100)
    expect(patternName(`x${'(a+)+$'}y`, '(a+)+$', '-')).toBe('x-y')
    expect(patternName('aaa', 'a', 'b')).toBe('bbb')
    expect(patternName('IMG_1.IMG', 'IMG', 'p', 'start')).toBe('p_1.IMG')
    expect(patternName('IMG_1.IMG', 'IMG', 'p', 'end')).toBe('IMG_1.p')
    expect(patternName('same', 'x', 'y')).toBeNull()
  })

  test('each item is checked again when it runs: a folder that changed after the card cannot land an instruction file', async () => {
    put('users/alice/late/a-notes.md', 'a'); put('users/alice/late/b-pack/readme.md', 'b')
    // what a room's card would have weighed before the call: nothing instruction-like
    const before = fs.readdirSync(path.join(A.team, 'users/alice/late'))
    expect(roomChangeWrites('rename_files', { folder: 'users/alice/late', find: 'notes', replace: 'CLAUDE' }, () => before).targets.some(instructionLike)).toBe(false)
    // ...then, before it runs, someone adds names that make the same pattern land on instruction files
    put('users/alice/late/AGENTS-notes.md', 'planted'); put('users/alice/late/b-pack/SKILL.md', 'planted')
    const r = await call('alice', 'rename_files', { renames: [{ path: 'users/alice/late/AGENTS-notes.md', new_name: 'AGENTS.md' }, { path: 'users/alice/late/b-pack', new_name: 'c-pack' }, { path: 'users/alice/late/a-notes.md', new_name: 'a-v2.md' }] }, { turn: true })
    expect(r.text).toContain('users/alice/late/AGENTS-notes.md: rename_files does not make or move an instruction file')
    expect(r.text).toContain('users/alice/late/b-pack: rename_files does not make or move an instruction file')
    expect(has('users/alice/late/AGENTS-notes.md') && has('users/alice/late/b-pack/SKILL.md') && has('users/alice/late/a-v2.md')).toBe(true)
    const p = await call('alice', 'rename_files', { folder: 'users/alice/late', find: '-notes', replace: '' }, { turn: true })
    expect(p.isError).toBe(true)
    expect(has('users/alice/late/AGENTS.md')).toBe(false)
  })

  test('skill folders stay out of reach, by the old name and the new one (also through "./")', async () => {
    put('skills/batch-rule.txt', 'rule'); put('groups/marketing/drafts-b/x.md', 'x')
    const one = await call('carol', 'rename_files', { renames: [{ path: './skills/batch-rule.txt', new_name: 'changed.txt' }, { path: 'groups/marketing/drafts-b', new_name: 'skills' }] }, { turn: true })
    expect(one.isError).toBe(true)
    expect(one.text).toContain('skills/')
    expect(has('skills/batch-rule.txt') && has('groups/marketing/drafts-b/x.md')).toBe(true)
    const pattern = await call('carol', 'rename_files', { folder: 'groups/marketing', find: 'drafts-b', replace: 'skills' }, { turn: true })
    expect(pattern.isError).toBe(true)
    expect(has('groups/marketing/drafts-b/x.md')).toBe(true)
  })
})


// QA TC-r2u-25 (S-122): the AI renamed and moved 15 files of a folder everyone sees with no card
describe('many moves and renames where other people look: one card for the rest of the answer', () => {
  const seed = (dir: string, n: number) => Array.from({ length: n }, (_, i) => { const rel = `${dir}/memo-${i + 1}.txt`; put(rel, `memo ${i + 1}`); return rel })

  test('a rename_files of 15 in a shared folder asks once, listing them; no: nothing renamed; yes: renamed, and the moves after it in the answer go without asking', async () => {
    const files = seed('shared/mkt-1225', 15)
    const no = ask(false)
    const r0 = await call('alice', 'rename_files', { renames: files.map((f, i) => ({ path: f, new_name: `2026-10-${String(i + 1).padStart(2, '0')}_memo.txt` })) }, { person: no, turn: true })
    expect(r0.isError).toBe(true)
    expect(r0.text).toContain('did not allow')
    expect(no.questions).toHaveLength(1)
    expect(no.questions[0]).toMatch(/AI가 \d+명이 함께 보는 곳에서 항목 15개의 이름을 바꾸려고 해요/)
    expect(no.questions[0]).toContain('이 질문을 다시 하지 않아요')
    expect(has(files[0]!)).toBe(true)

    const yes = ask(true)
    const turnId = A.turn('alice', A.chat('alice'))
    const r = await call('alice', 'rename_files', { renames: files.map((f, i) => ({ path: f, new_name: `2026-10-${String(i + 1).padStart(2, '0')}_memo.txt` })) }, { person: yes, turnId })
    expect(r.isError).toBe(false)
    expect(yes.questions).toHaveLength(1)
    expect(has('shared/mkt-1225/2026-10-01_memo.txt')).toBe(true)
    // then one move per date folder, as the AI did: no more cards in that answer
    for (let i = 1; i <= 15; i++) {
      const d = String(i).padStart(2, '0')
      const m = await call('alice', 'move_files', { paths: [`shared/mkt-1225/2026-10-${d}_memo.txt`], to_folder: `shared/mkt-1225/2026-10-${d}` }, { person: yes, turnId })
      expect(m.isError).toBe(false)
    }
    expect(yes.questions).toHaveLength(1)
    expect(has('shared/mkt-1225/2026-10-15/2026-10-15_memo.txt')).toBe(true)
  })

  test('one at a time: three moves and renames go, the fourth asks, and its no stops only that one', async () => {
    const files = seed('shared/mkt-1226', 5)
    const p = ask(false)
    const turnId = A.turn('alice', A.chat('alice'))
    expect((await call('alice', 'rename_file', { path: files[0]!, new_name: 'a.txt' }, { person: p, turnId })).isError).toBe(false)
    expect((await call('alice', 'move_files', { paths: [files[1]!], to_folder: 'shared/mkt-1226/sub' }, { person: p, turnId })).isError).toBe(false)
    expect((await call('alice', 'rename_file', { path: files[2]!, new_name: 'c.txt' }, { person: p, turnId })).isError).toBe(false)
    expect(p.questions).toHaveLength(0)
    const fourth = await call('alice', 'move_files', { paths: [files[3]!], to_folder: 'shared/mkt-1226/sub' }, { person: p, turnId })
    expect(fourth.isError).toBe(true)
    expect(p.questions).toHaveLength(1)
    expect(p.questions[0]).toContain('항목 1개를')
    expect(p.questions[0]).toContain('이미 3개를 옮기거나 이름을 바꿨어요')
    expect(has(files[3]!)).toBe(true)
    // a new answer starts its own count
    expect((await call('alice', 'rename_file', { path: files[3]!, new_name: 'd.txt' }, { person: p, turn: true })).isError).toBe(false)
  })

  test('my own folder, a copy, a scheduled run or no chat person: no card', async () => {
    const mine = seed('users/alice/sort-1227', 10)
    const p = ask(false)
    expect((await call('alice', 'rename_files', { renames: mine.map((f, i) => ({ path: f, new_name: `n-${i}.txt` })) }, { person: p, turn: true })).isError).toBe(false)
    const shared = seed('shared/mkt-1227', 6)
    expect((await call('alice', 'copy_files', { paths: shared, to_folder: 'shared/mkt-1227-copy' }, { person: p, turn: true })).isError).toBe(false)
    expect(p.questions).toHaveLength(0)
    const run = { ...ask(false), unattended: true }
    expect((await call('alice', 'rename_files', { renames: shared.map((f, i) => ({ path: f, new_name: `s-${i}.txt` })) }, { person: run, turn: true })).isError).toBe(false)
    expect(run.questions).toHaveLength(0)
    expect((await call('alice', 'rename_files', { folder: 'shared/mkt-1227', find: 's-', replace: 't-' }, { turn: true })).isError).toBe(false)
  })

  test('a move that changes who can see the files asks once on its own card, which also stands for the many-items card', async () => {
    const files = seed('shared/mkt-1228', 6)
    const p = ask(true)
    const r = await call('alice', 'move_files', { paths: files, to_folder: 'users/alice/kept-1228' }, { person: p, turn: true })
    expect(r.isError).toBe(false)
    expect(p.questions).toHaveLength(1)
    expect(p.questions[0]).toContain('더 이상 볼 수 없게 돼요')
    // it says that its yes covers the rest of the answer, and then the next renames there go without a card
    expect(p.questions[0]).toContain('이 질문을 다시 하지 않아요')
  })

  test('after a room read the room card asks before each call: no second card for many items', async () => {
    const files = seed('shared/mkt-1229', 6)
    const p = { ...ask(false), roomCardEach: true }
    const r = await call('alice', 'rename_files', { renames: files.map((f, i) => ({ path: f, new_name: `r-${i}.txt` })) }, { person: p, turn: true })
    expect(r.isError).toBe(false)
    expect(p.questions).toHaveLength(0)
  })
})

test('an audience change while the person confirms refuses both moves and copies', async () => {
  for (const tool of ['move_files', 'copy_files']) {
    const source = `users/alice/pending-${tool}.txt`, target = `shared/pending-${tool}.txt`
    put(source, 'private review fixture')
    A.ctx.db.query("UPDATE users SET status='disabled' WHERE id='bob'").run()
    try {
      const person = { ...ask(true), beforeAnswer: async () => {
        A.ctx.db.query("UPDATE users SET status='active' WHERE id='bob'").run()
      } }
      const result = await call('alice', tool, { paths: [source], to_folder: 'shared' }, { person, turn: true })
      expect(result.isError).toBe(true)
      expect(result.text).toContain('audience changed')
      expect(has(source)).toBe(true)
      expect(has(target)).toBe(false)
    } finally { A.ctx.db.query("UPDATE users SET status='active' WHERE id='bob'").run() }
  }
})

test('move, copy and rename refuse symlink sources and destination directories', async () => {
  const outside = fs.mkdtempSync('/tmp/core-review-file-link-')
  const link = 'users/alice/review-link.txt', dir = 'users/alice/review-link-dir'
  try {
    fs.writeFileSync(path.join(outside, 'private.txt'), 'outside fixture')
    fs.symlinkSync(path.join(outside, 'private.txt'), path.join(A.team, link))
    fs.symlinkSync(outside, path.join(A.team, dir))
    for (const tool of ['move_files', 'copy_files']) {
      expect((await call('alice', tool, { paths: [link], to_folder: 'shared' }, { person: ask(true), turn: true })).isError).toBe(true)
      const source = `users/alice/link-target-${tool}.txt`
      put(source, 'inside fixture')
      expect((await call('alice', tool, { paths: [source], to_folder: dir }, { person: ask(true), turn: true })).isError).toBe(true)
      expect(has(source)).toBe(true)
    }
    expect((await call('alice', 'rename_file', { path: link, new_name: 'renamed.txt' })).isError).toBe(true)
    expect(fs.readdirSync(outside)).toEqual(['private.txt'])
    expect(fs.readFileSync(path.join(outside, 'private.txt'), 'utf8')).toBe('outside fixture')
  } finally {
    fs.rmSync(path.join(A.team, link), { force: true }); fs.rmSync(path.join(A.team, dir), { force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('dot-segment aliases cannot bypass the skills boundary', async () => {
  for (const tool of ['move_files', 'copy_files', 'rename_file']) {
    const source = `skills/review-alias-${tool}.txt`
    put(source, 'team rule fixture')
    const person = ask(true)
    const args = tool === 'rename_file' ? { path: './' + source, new_name: 'changed-rule.txt' } : { paths: ['./' + source], to_folder: 'shared' }
    const result = await call('carol', tool, args, { person, turn: true })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('skills/')
    expect(person.questions).toHaveLength(0)
    expect(has(source)).toBe(true)
  }
  for (const tool of ['move_files', 'copy_files']) {
    const source = `shared/review-alias-into-${tool}.txt`
    put(source, 'unapproved rule fixture')
    expect((await call('carol', tool, { paths: [source], to_folder: './/skills/.' }, { person: ask(true), turn: true })).isError).toBe(true)
    expect(has(source)).toBe(true)
  }
})
