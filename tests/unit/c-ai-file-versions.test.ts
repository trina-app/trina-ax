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
})
