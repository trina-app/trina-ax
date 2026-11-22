// A team file that is not at its path any more (server/src/files/moved.ts; QA TC-7234, TC-r2b-01, TC-r2b-02, TC-7241):
// the AI's file tools say where it went instead of only "not found" (so it edits it there and never says "deleted"),
// GET /api/files/moved tells the side panel, a move from a project folder into a wider one asks first on the Files
// screen, and POST /api/files/names-taken says which upload names a folder holds already.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeHandler } from '../../server/src/mcp/protocol'
import { whereNow } from '../../server/src/files/moved'
import { componentC } from '../../server/src/team-files/component'
import { makeCApp, jsonBody, type CApp, type Person } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('moved-files') })
afterAll(async () => { await A.close() })

const put = (rel: string, data: string) => { const p = path.join(A.team, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data) }
const dir = (rel: string) => fs.mkdirSync(path.join(A.team, ...rel.split('/')), { recursive: true })
const svc = () => componentC(A.ctx).files
let n = 0
const uniq = (s: string) => `${s}-${++n}`
let rpcId = 0
async function call(user: Person, name: string, args: unknown, turnId: string | null = null) {
  const tc = A.toolCtx(user, turnId)
  const h = makeHandler(A.ctx.files, A.ctx.db, tc)
  const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
  return { text: r.result.content[0].text as string, isError: !!r.result.isError }
}

describe('the AI is told where a moved file went', () => {
  test('moved to a folder the person may read: the new path, who and "not deleted"; a read there works', async () => {
    const d = uniq('mkt')
    dir(`shared/${d}`)
    put('projects/falcon/poster.png', 'png bytes')
    svc().move('alice', 'projects/falcon/poster.png', `shared/${d}/poster.png`, 'fail')
    const r = await call('bob', 'read', { file_path: 'projects/falcon/poster.png' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain(`Alice Kim moved it to 'shared/${d}/poster.png'`)
    expect(r.text).toContain('not deleted')
    expect(r.text).not.toMatch(/deleted it|removed it/)
    // an edit tool's refusal says the same (tools/registry.ts)
    const e = await call('alice', 'edit', { file_path: 'projects/falcon/poster.png', old_string: 'png', new_string: 'jpg' })
    expect(e.text).toContain(`moved it to 'shared/${d}/poster.png'`)
  })

  test('moved where the person cannot read: that it moved, never the place; someone who could not see the old folder hears nothing', async () => {
    const f = uniq('plan') + '.md'
    put(`projects/falcon/${f}`, 'plan')
    svc().move('alice', `projects/falcon/${f}`, `groups/marketing/${f}`, 'fail')
    // bob reads falcon (finance) but not groups/marketing
    const bob = await call('bob', 'read', { file_path: `projects/falcon/${f}` })
    expect(bob.text).toContain('moved it on')
    expect(bob.text).toContain('cannot open now')
    expect(bob.text).not.toContain('groups/marketing')
    // erin cannot read projects/falcon at all: the usual refusal only
    const erin = await call('erin', 'read', { file_path: `projects/falcon/${f}` })
    expect(erin.isError).toBe(true)
    expect(erin.text).not.toContain('moved')
    expect(erin.text).not.toContain('Alice')
  })

  test('a chat shared with people: the new place is named only when everyone in it may open it there', async () => {
    const db = A.ctx.db
    const f = uniq('deal') + '.md'
    put(`shared/${f}`, 'deal')
    // alice moves it into the marketing folder, which bob cannot open
    svc().move('alice', `shared/${f}`, `groups/marketing/${f}`, 'fail')
    const chat = A.chat('alice')
    db.query('UPDATE chats SET people_shared_at = ? WHERE id = ?').run(new Date().toISOString(), chat)
    db.query("INSERT INTO chat_audience (chat_id, subject_type, subject_id, added_by, added_at) VALUES (?, 'user', 'bob', 'alice', ?)").run(chat, new Date().toISOString())
    const r = await call('alice', 'read', { file_path: `shared/${f}` }, A.turn('alice', chat))
    expect(r.text).toContain('not everyone in this chat may open')
    expect(r.text).not.toContain('groups/marketing')
    // her own chat: the place is named
    const own = await call('alice', 'read', { file_path: `shared/${f}` }, A.turn('alice', A.chat('alice')))
    expect(own.text).toContain(`moved it to 'groups/marketing/${f}'`)
  })

  test('put in the trash: who and when, nothing guessed', async () => {
    const f = `shared/${uniq('old')}.md`
    put(f, 'x')
    svc().remove('bob', f)
    const r = await call('alice', 'read', { file_path: f })
    expect(r.text).toContain('Bob Lee put it in the trash')
  })

  test('a folder above moved: the file is followed into it', async () => {
    const sub = uniq('sub')
    put(`shared/${sub}/a.md`, 'a')
    const to = uniq('moved')
    svc().move('bob', `shared/${sub}`, `shared/${to}`, 'fail')
    const r = await call('alice', 'read', { file_path: `shared/${sub}/a.md` })
    expect(r.text).toContain(`moved it to 'shared/${to}/a.md'`)
  })

  test('the follow: a later move of where it went, a folder trashed after the file left it, a new file trashed at the old path', async () => {
    const db = A.ctx.db
    const d1 = uniq('d1')
    put(`shared/${d1}/f.md`, 'f')
    svc().move('alice', `shared/${d1}/f.md`, `shared/${d1}-f.md`, 'fail')
    svc().remove('bob', `shared/${d1}`)
    expect(whereNow(db, `shared/${d1}/f.md`)).toMatchObject({ kind: 'moved', to: `shared/${d1}-f.md`, by: 'alice' })
    // moved on again by bob: the newest mover is named, the newest place given
    svc().move('bob', `shared/${d1}-f.md`, `shared/${d1}-g.md`, 'fail')
    expect(whereNow(db, `shared/${d1}/f.md`)).toMatchObject({ kind: 'moved', to: `shared/${d1}-g.md`, by: 'bob' })
    // a new file made at a moved file's old path, then trashed: that one is what the path says now
    const p = `shared/${uniq('p')}.md`
    put(p, 'one')
    svc().move('alice', p, `${p}.moved`, 'fail')
    put(p, 'two')
    // (a file made outside the app leaves no event: the file screen's upload would; the trash is what counts)
    svc().remove('alice', p)
    expect(whereNow(db, p)).toMatchObject({ kind: 'trashed', by: 'alice' })
  })

  test('the place the moves lead to is gone: nothing is told rather than a wrong fact', async () => {
    const f = `shared/${uniq('gone')}.md`
    put(f, 'x')
    svc().move('alice', f, `${f}.2`, 'fail')
    fs.rmSync(path.join(A.team, ...`${f}.2`.split('/')))
    const r = await call('alice', 'read', { file_path: f })
    expect(r.text).not.toContain('moved')
  })
})

describe('access taken away after a read in this chat (QA TC-r2u-28)', () => {
  test('the AI is told the person cannot open it any more, not "not found"; another chat, or another person, hears nothing', async () => {
    const db = A.ctx.db
    const f = `groups/marketing/${uniq('price')}.md`
    put(f, 'prices')
    const chat = A.chat('alice')
    const t1 = A.turn('alice', chat)
    const msg = crypto.randomUUID()
    db.query("INSERT INTO messages (id, chat_id, role, content, turn_id) VALUES (?,?, 'assistant', 'read it', ?)").run(msg, chat, t1)
    const sha = new Bun.CryptoHasher('sha256').update('prices').digest('hex')
    db.query("INSERT INTO message_sources (message_id, ord, path, sha256, via) VALUES (?, 0, ?, ?, 'read')").run(msg, f, sha)
    // alice leaves the marketing group: the folder closes to her
    db.query("DELETE FROM group_members WHERE group_id = 'marketing' AND user_id = 'alice'").run()
    try {
      const t2 = A.turn('alice', chat)
      const r = await call('alice', 'read', { file_path: f }, t2)
      expect(r.isError).toBe(true)
      expect(r.text).toContain('can no longer open it')
      // another chat of hers: the usual refusal only
      const other = await call('alice', 'read', { file_path: f }, A.turn('alice', A.chat('alice')))
      expect(other.text).not.toContain('can no longer')
      // bob never read it here
      const bob = await call('bob', 'read', { file_path: f }, A.turn('bob', A.chat('bob')))
      expect(bob.text).not.toContain('can no longer')
      // another file at that path since (other bytes): never confirmed
      put(f, 'other prices')
      const changed = await call('alice', 'read', { file_path: f }, A.turn('alice', chat))
      expect(changed.text).not.toContain('can no longer')
    } finally {
      db.query("INSERT INTO group_members VALUES ('marketing', 'alice')").run()
    }
  })
})

describe('HTTP', () => {
  test('GET /api/files/moved: moved with the new path, hidden for someone who cannot see the old folder', async () => {
    const f = uniq('card') + '.png'
    put(`projects/falcon/${f}`, 'x')
    svc().move('alice', `projects/falcon/${f}`, `shared/${f}`, 'fail')
    const q = `/api/files/moved?path=${encodeURIComponent(`projects/falcon/${f}`)}`
    const a = await A.json(q, { as: 'alice' })
    expect(a.status).toBe(200)
    expect(a.body).toMatchObject({ status: 'moved', to: `shared/${f}`, by: { id: 'alice', name: 'Alice Kim' } })
    const e = await A.json(q, { as: 'erin' })
    expect(e.body).toEqual({ status: 'no' })
    const none = await A.json('/api/files/moved?path=shared/never-there.md', { as: 'alice' })
    expect(none.body).toEqual({ status: 'no' })
  })

  test('a move from a project folder into a company-wide one asks first (askWiden), and moves once confirmed', async () => {
    const f = uniq('wide') + '.md'
    put(`projects/falcon/${f}`, 'x')
    const body = { from: `projects/falcon/${f}`, to: `shared/${f}`, onExists: 'fail', askWiden: true }
    const r = await A.json('/api/files/move', { as: 'alice', ...jsonBody(body) })
    expect(r.status, JSON.stringify(r.body)).toBe(409)
    expect(r.body.error.params.reason).toBe("audience_widened")
    expect(Number(r.body.error.params.viewersAdded)).toBeGreaterThan(0)
    const ok = await A.json('/api/files/move', { as: 'alice', ...jsonBody({ ...body, confirm: true }) })
    expect(ok.status).toBe(200)
    // within one personal folder: never asked
    put(`users/alice/${f}`, 'y')
    const own = await A.json('/api/files/move', { as: 'alice', ...jsonBody({ from: `users/alice/${f}`, to: `users/alice/${f}.2`, onExists: 'fail', askWiden: true }) })
    expect(own.status).toBe(200)
  })

  test('POST /api/files/names-taken: taken names as the server compares them, with the name on disk and its type', async () => {
    const d = `shared/${uniq('up')}`
    put(`${d}/Minutes.docx`, 'x')
    dir(`${d}/Photos`)
    const r = await A.json('/api/files/names-taken', { as: 'alice', ...jsonBody({ folder: d, names: ['minutes.docx', 'photos', 'new.txt'] }) })
    expect(r.status).toBe(200)
    expect(r.body.taken).toEqual([
      { name: 'minutes.docx', existing: 'Minutes.docx', type: 'file' },
      { name: 'photos', existing: 'Photos', type: 'folder' },
    ])
    // a folder the person cannot write: refused like an upload there
    const no = await A.json('/api/files/names-taken', { as: 'erin', ...jsonBody({ folder: 'groups/finance', names: ['a'] }) })
    expect(no.status).toBeGreaterThanOrEqual(400)
  })
})
