// The AI's move_files / copy_files / rename_file (server/src/tools/file-moves.ts) through the MCP handler: any file type,
// the same access checks as the Files screen, one question on the server's card when who can see the files changes,
// refusal with nobody to ask, skills/ out of reach, and the turn recorded in the file history.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeHandler } from '../../server/src/mcp/protocol'
import { makeCApp, type CApp, type Person } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('c-file-moves') })
afterAll(async () => { await A.close() })

const put = (rel: string, data: string | Uint8Array) => { const p = path.join(A.team, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data) }
const has = (rel: string) => fs.existsSync(path.join(A.team, ...rel.split('/')))
const bytes = (rel: string) => fs.readFileSync(path.join(A.team, ...rel.split('/')))
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0xff, 0x00, 0xfe])

type Asked = { answer: boolean; questions: string[]; beforeAnswer?: () => Promise<void> }
let rpcId = 0
async function call(user: Person, name: string, args: unknown, o: { person?: Asked; turn?: boolean } = {}) {
  const turnId = o.turn ? A.turn(user, A.chat(user)) : null
  const tc = A.toolCtx(user, turnId)
  if (o.person) {
    const p = o.person
    tc.person = { locale: 'ko', async confirm(q) { p.questions.push(q); await p.beforeAnswer?.(); return p.answer }, *turnUrls() {} }
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
    expect(no.questions[0]).toContain('2개 항목을 shared/company 폴더로 옮기려고 해요')
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

  test('with nobody to ask (no chat person), a change of audience is refused and nothing moves', async () => {
    put('users/alice/private-plan.md', 'secret')
    const r = await call('alice', 'move_files', { paths: ['users/alice/private-plan.md'], to_folder: 'shared' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('nobody can confirm it here')
    expect(has('users/alice/private-plan.md')).toBe(true)
  })

  test('a path the person may not use fails alone (same answer as a missing one); the rest is moved', async () => {
    put('users/bob/mine.md', 'bob')
    const r = await call('bob', 'move_files', { paths: ['groups/marketing/campaign-brief.md', 'users/bob/mine.md', 'users/bob/nope.md'], to_folder: 'users/bob/archive-x' }, { person: ask(true) })
    // the target folder must exist
    expect(r.isError).toBe(true)
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

  test('a group folder moves only for admins and owners, as on the Files screen', async () => {
    fs.mkdirSync(path.join(A.team, 'shared/elsewhere'), { recursive: true })
    const r = await call('alice', 'move_files', { paths: ['groups/marketing'], to_folder: 'shared/elsewhere' }, { person: ask(true) })
    expect(r.isError).toBe(true)
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
    expect(p.questions[0]).toContain('파일 1개를 shared/certs 폴더에 복사하려고 해요')
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
