// The AI reads a file's earlier versions (QA TC-4547, manual row MAN-022; docs/decisions/20261117-ai-file-versions.md).
// Before: asked "What did qa-member2 change in QA-plan.md?", the AI said it had no version history and sent the person
// to the Files screen. Now `read` with `versions` lists the kept versions (when, who, size) and shows the changes
// between the current file and the previous version (or a chosen one), with exactly the access a read of the file has:
// a file the caller cannot read looks like one that does not exist, and other people's personal folders never open.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeHandler } from '../../server/src/mcp/protocol'
import { saveVersion } from '../../server/src/files/store'
import { jsonBody, makeCApp, sha256hex, type CApp, type Person } from '../lib/c-app'

setDefaultTimeout(30_000)

let A: CApp
beforeAll(async () => { A = await makeCApp('c-ai-file-versions') })
afterAll(async () => { await A.close() })

const save = async (as: Person, p: string, content: string, base: string | null) => {
  const r = await A.json('/api/files/content', { ...jsonBody({ path: p, content, baseSha256: base === null ? null : sha256hex(base) }, 'PUT'), as })
  expect(r.status).toBe(200)
}
let rpcId = 0
async function read(user: Person, args: Record<string, unknown>) {
  const tc = A.toolCtx(user, A.turn(user, A.chat(user)))
  const h = makeHandler(A.ctx.files, A.ctx.db, tc)
  const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'read', arguments: args } })
  const text = (r.result.content as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  return { text, isError: r.result.isError === true, files: tc.files }
}

const v1 = 'QA plan\nline two: check sign-in\nline three: check files\n'
const v2 = 'QA plan\nline two: check sign-in and sign-out\nline three: check files\n'

describe('read with versions (TC-4547)', () => {
  const p = 'shared/qa/QA-plan.md'
  beforeAll(async () => {
    await save('alice', p, v1, null)
    await save('erin', p, v2, v1)
  })

  test('lists the versions with who saved them and shows what the last save changed', async () => {
    const r = await read('alice', { file_path: p, versions: true })
    expect(r.isError).toBe(false)
    // who made the current content and who made the version before it, by name (never ids or storage paths)
    expect(r.text).toContain('Erin Yoo')
    expect(r.text).toContain('Alice Kim')
    expect(r.text).not.toContain('.system')
    expect(r.text).not.toMatch(/\berin\b/)
    // the change of line 2, as removed / added lines
    expect(r.text).toContain('-line two: check sign-in\n')
    expect(r.text).toContain('+line two: check sign-in and sign-out')
    expect(r.text).not.toContain('-line three')
    // times in UTC, in the form list gives them
    expect(r.text).toMatch(/\d{4}-\d\d-\d\d \d\d:\d\d UTC/)
    // the file joins the turn's read scope (what a later save that widens the audience is judged by), but it is not
    // "read" for read-before-write: the AI did not get the whole current text
    expect(r.files.readPaths.has(p)).toBe(true)
    expect(r.files.readHashes.get(p)).toBeUndefined()
  })

  test('a chosen version is compared with the current file', async () => {
    await save('bob', p, v2 + 'line four: check rooms\n', v2)
    const r = await read('alice', { file_path: p, version: 1 })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('version 1')
    expect(r.text).toContain('+line two: check sign-in and sign-out')
    expect(r.text).toContain('+line four: check rooms')
    const unknown = await read('alice', { file_path: p, version: 99 })
    expect(unknown.isError).toBe(true)
  })

  test('a file with no earlier version says so', async () => {
    await save('alice', 'shared/qa/new.md', 'fresh\n', null)
    const r = await read('alice', { file_path: 'shared/qa/new.md', versions: true })
    expect(r.isError).toBe(false)
    expect(r.text).toMatch(/no earlier versions/i)
  })

  test('a file the caller cannot read looks like one that does not exist', async () => {
    const f = 'groups/finance/q4-notes.md'
    await save('bob', f, 'a\n', null)
    await save('bob', f, 'b\n', 'a\n')
    const hidden = await read('alice', { file_path: f, versions: true })
    const missing = await read('alice', { file_path: 'groups/finance/nothing-here.md', versions: true })
    expect(hidden.isError).toBe(true)
    expect(hidden.text).not.toContain('Bob')
    expect(hidden.text.replace('q4-notes', 'X')).toBe(missing.text.replace('nothing-here', 'X'))
    // and it is the same answer as a plain read of that file
    expect(hidden.text).toBe((await read('alice', { file_path: f })).text)
    // bob, who may read it, sees the change
    expect((await read('bob', { file_path: f, versions: true })).text).toContain('+b')
  })

  test('another person\'s personal folder never opens, not even for an admin', async () => {
    const f = 'users/bob/plan.md'
    await save('bob', f, 'one\n', null)
    await save('bob', f, 'two\n', 'one\n')
    for (const who of ['alice', 'carol', 'dana'] as const) {
      const r = await read(who, { file_path: f, versions: true })
      expect(r.isError).toBe(true)
      expect(r.text).not.toContain('two')
    }
    expect((await read('bob', { file_path: f, versions: true })).text).toContain('+two')
  })

  // a Word file: both versions turned into text by the extractor a read uses (pandoc), then compared
  const pandoc = Bun.which('pandoc')
  test.skipIf(!pandoc)('a Word file shows its text changes', async () => {
    const docx = (text: string) => {
      const md = path.join(A.data, `v-${crypto.randomUUID()}.md`), out = md.replace(/\.md$/, '.docx')
      fs.writeFileSync(md, text)
      expect(Bun.spawnSync([pandoc!, md, '-o', out]).exitCode).toBe(0)
      return fs.readFileSync(out)
    }
    const f = 'shared/qa/brief.docx'
    const abs = path.join(A.team, ...f.split('/'))
    const before = docx('Budget: 100\n\nOwner: Alice\n')
    saveVersion(A.ctx.db, A.team, f, before, { userId: 'erin', turnId: null })
    fs.writeFileSync(abs, docx('Budget: 250\n\nOwner: Alice\n'))
    const r = await read('alice', { file_path: f, versions: true })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('-Budget: 100')
    expect(r.text).toContain('+Budget: 250')
    expect(r.text).not.toContain('-Owner')
  })

  // review round 1
  test('a file moved out of a narrower folder: its old place joins the read scope; who cannot read that place sees only later versions', async () => {
    const from = 'groups/finance/moved.md', to = 'shared/qa/moved.md'
    await save('bob', from, 'salary 9000\n', null)
    await save('bob', from, 'salary 9500\n', 'salary 9000\n')
    expect((await A.json('/api/files/move', { ...jsonBody({ from, to }), as: 'bob' })).status).toBe(200)
    const b = await read('bob', { file_path: to, versions: true })
    expect(b.text).toContain('-salary 9000')
    expect(b.files.readPaths.has(from)).toBe(true)
    expect([...b.files.readPaths].some((p) => p === 'groups/finance')).toBe(true)
    // alice can read the file where it is now, not where those versions were saved
    const a0 = await read('alice', { file_path: to, versions: true })
    expect(a0.isError).toBe(false)
    expect(a0.text).toMatch(/no earlier versions/i)
    expect(a0.text).not.toContain('9000')
    // a save in the shared place makes a version alice may see; still nothing of finance's text but the current one
    await save('alice', to, 'salary hidden\n', 'salary 9500\n')
    const a = await read('alice', { file_path: to, versions: true })
    expect(a.text).not.toContain('9000')
    expect(a.text).toContain('-salary 9500')
    expect(a.files.readPaths.has(from)).toBe(false)
  })

  test('a version whose folder is in the trash stays hidden from a member', async () => {
    const inside = 'groups/marketing/salaries/note.md', out = 'shared/qa/note.md'
    await save('carol', inside, 'pay A\n', null)
    await save('carol', inside, 'pay B\n', 'pay A\n')
    expect((await A.json('/api/files/move', { ...jsonBody({ from: inside, to: out }), as: 'carol' })).status).toBe(200)
    expect((await A.json('/api/files?' + new URLSearchParams({ path: 'groups/marketing/salaries' }), { method: 'DELETE', headers: { 'x-mycel-csrf': '1' }, as: 'carol' })).status).toBe(200)
    const r = await read('alice', { file_path: out, versions: true })
    expect(r.isError).toBe(false)
    expect(r.text).not.toContain('pay A')
    // an admin sees the list, but the version is not compared: its folder's audience is parked in the trash, and the
    // old path alone would be judged by today's rules (fail closed)
    const c = await read('carol', { file_path: out, versions: true })
    expect(c.isError).toBe(false)
    expect(c.text).toContain('version 1')
    expect(c.text).toMatch(/could not be compared/)
    expect(c.text).not.toContain('-pay A')
    expect([...c.files.readPaths].some((p) => p.includes('salaries'))).toBe(false)
  })

  test('a binary file, a very large one, and a version whose stored copy is gone keep the list', async () => {
    const bin = 'shared/qa/blob.bin'
    saveVersion(A.ctx.db, A.team, bin, new Uint8Array([0, 1, 2, 0, 3]), { userId: 'erin', turnId: null })
    fs.writeFileSync(path.join(A.team, ...bin.split('/')), new Uint8Array([0, 9, 9, 0, 9]))
    const b = await read('alice', { file_path: bin, versions: true })
    expect(b.isError).toBe(false)
    expect(b.text).toContain('version 1')
    expect(b.text).toMatch(/binary/)

    const big = 'shared/qa/big.txt'
    const line = 'x'.repeat(99) + '\n'
    saveVersion(A.ctx.db, A.team, big, Buffer.from(line.repeat(22_000)), { userId: 'erin', turnId: null })
    fs.writeFileSync(path.join(A.team, ...big.split('/')), line.repeat(22_001))
    const g = await read('alice', { file_path: big, versions: true })
    expect(g.isError).toBe(false)
    expect(g.text).toMatch(/too large to compare/)
    // a plain text file over 6 MB is not read at all for the comparison
    const huge = 'shared/qa/huge.txt'
    saveVersion(A.ctx.db, A.team, huge, Buffer.from('a\n'), { userId: 'erin', turnId: null })
    fs.writeFileSync(path.join(A.team, ...huge.split('/')), Buffer.alloc(7 * 1024 * 1024, 98))
    expect((await read('alice', { file_path: huge, versions: true })).text).toMatch(/too large to compare/)

    const gone = 'shared/qa/gone.md'
    await save('alice', gone, 'old\n', null)
    await save('erin', gone, 'new\n', 'old\n')
    const row = A.ctx.db.query('SELECT storage_path FROM file_versions WHERE path = ?').get(gone) as { storage_path: string }
    fs.rmSync(path.join(A.team, ...row.storage_path.split('/')))
    const n = await read('alice', { file_path: gone, versions: true })
    expect(n.isError).toBe(false)
    expect(n.text).toContain('Erin Yoo')
    expect(n.text).toMatch(/no longer kept/)
  })

  test('a change too long to compare line by line says so instead of giving counts', async () => {
    const f = 'shared/qa/rewrite.txt'
    const text = (tag: string) => Array.from({ length: 2100 }, (_, i) => `${tag} ${i}`).join('\n') + '\n'
    saveVersion(A.ctx.db, A.team, f, Buffer.from(text('old')), { userId: 'erin', turnId: null })
    fs.writeFileSync(path.join(A.team, ...f.split('/')), text('new'))
    const r = await read('alice', { file_path: f, versions: true })
    expect(r.text).toMatch(/too much changed to compare line by line/)
    expect(r.text).not.toMatch(/2100 removed/)
  })
})
