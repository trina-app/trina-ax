// The AI's file reads last for the chat, not one answer (limits audit #1, QA TC-4904;
// docs/decisions/20261118-read-state-for-the-chat.md, server/src/chat/carried-reads.ts, files/service.ts ReadHashes).
// Before: read state started empty in every answer, so "change the file you read" in a later message refused with
// "read it first" and make_file saved "report (2).docx" next to the original. Now: a file the person's AI read earlier
// on this branch is changed in place (main AI and sub-agents) while it is still that version; a file changed since
// asks for a new read (nothing saved); a regenerated branch, another person in a shared chat, a person who lost the
// file and an unknown call never get the read. Through the real launcher with the fake engine.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { API, uuidv7 } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { legacyProjectFolder, oldProject } from '../lib/legacy-project'
import { carriedReads, saveReads } from '../../server/src/chat/carried-reads'
import { TurnFiles } from '../../server/src/files/service'

setDefaultTimeout(120_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-chat-read-state', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'carol']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  legacyProjectFolder(h.ctx.db, h.team, 'projects/kestrel', [{ subjectType: 'user', subjectId: 'alice', access: 'write' }, { subjectType: 'user', subjectId: 'carol', access: 'write' }], 'alice')
  const p = await oldProject(h, 'alice', { name: 'Kestrel', folderPath: 'projects/kestrel', instructions: 'Kestrel notes.' })
  projectId = p.id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h?.close() })

const at = (rel: string) => path.join(h.team, rel)
const put = (rel: string, body: string | Uint8Array) => { fs.mkdirSync(path.dirname(at(rel)), { recursive: true }); fs.writeFileSync(at(rel), body) }
const read = (rel: string) => fs.readFileSync(at(rel), 'utf8')
const dirOf = () => `users/alice/reads-${uuidv7().slice(-8)}`
const newChat = async (user: string, body: Record<string, unknown> = {}) => (await h.api(user).call(API.createChat, { body })).id

/** one answer, after `parentId` when given (a regenerated / edited branch); the answer's text */
async function ask(user: string, chatId: string, content: string, parentId?: string | null) {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [], ...(parentId !== undefined ? { parentId } : {}) } })
  const done = await ws[user]!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 60_000)
  return { text: done.data.message.content as string, userId: r.userMessage!.id, assistantId: r.assistantMessage.id as string, parentId: r.userMessage!.parentId }
}

describe('a file read in an earlier message', () => {
  test('write and edit change it in place without a new read; its old version is kept', async () => {
    const f = `${dirOf()}/notes.md`
    put(f, '# Notes\n\ndate: 1 May\n')
    const chat = await newChat('alice')
    await ask('alice', chat, `read it\n${fake({ tool: 'read', args: { file_path: f } }, { say: 'read' })}`)
    await ask('alice', chat, 'thanks')
    const third = await ask('alice', chat, `change the date\n${fake({ tool: 'edit', args: { file_path: f, old_string: '1 May', new_string: '2 May' }, sayResult: true })}`)
    expect(third.text).toContain(`Edited ${f}`)
    expect(read(f)).toBe('# Notes\n\ndate: 2 May\n')
    // the edit's own hash goes on: the next message writes over it without reading
    const fourth = await ask('alice', chat, `rewrite\n${fake({ tool: 'write', args: { file_path: f, content: '# Notes\n\ndate: 3 May\n' }, sayResult: true })}`)
    expect(fourth.text).toContain(`Updated ${f}`)
    expect(read(f)).toBe('# Notes\n\ndate: 3 May\n')
    const versions = h.ctx.db.query('SELECT COUNT(*) AS n FROM file_versions WHERE path = ?').get(f) as { n: number }
    expect(versions.n).toBe(2)
  })

  test('make_file saves over the document it read earlier (no "(2)" copy); a file it never read still gets a copy', async () => {
    const dir = dirOf()
    const src = `${dir}/report.md`, out = `${dir}/report.docx`
    put(src, '# Report\n\nv1\n')
    const chat = await newChat('alice')
    // message 1 makes it (its hash is the chat's), message 2 reads it, message 3 changes it
    await ask('alice', chat, `make it\n${fake({ tool: 'make_file', args: { format: 'docx', source: src, output: out }, sayResult: true })}`)
    const other = await newChat('alice')
    await ask('alice', other, `read the report\n${fake({ tool: 'read', args: { file_path: out } }, { say: 'ok' })}`)
    await ask('alice', other, 'and?')
    put(src, '# Report\n\nv2\n')
    const third = await ask('alice', other, `update it\n${fake({ tool: 'make_file', args: { format: 'docx', source: src, output: out }, sayResult: true })}`)
    expect(third.text).toContain(`Saved ${out}`)
    expect(third.text).not.toContain('already exists')
    expect(fs.readdirSync(at(dir)).filter((n) => n.endsWith('.docx'))).toEqual(['report.docx'])
    // a chat that never read it: kept both, as before
    const fresh = await newChat('alice')
    const copy = await ask('alice', fresh, `make it\n${fake({ tool: 'make_file', args: { format: 'docx', source: src, output: out }, sayResult: true })}`)
    expect(copy.text).toContain('already exists and was not read in this chat')
    expect(fs.readdirSync(at(dir)).filter((n) => n.endsWith('.docx')).length).toBe(2)
  })

  test('changed by someone since: the AI is asked to read it again and nothing is saved (no overwrite, no copy)', async () => {
    const dir = dirOf()
    const f = `${dir}/plan.md`
    put(f, 'plan v1\n')
    const chat = await newChat('alice')
    await ask('alice', chat, `read\n${fake({ tool: 'read', args: { file_path: f } }, { say: 'read' })}`)
    put(f, 'plan v1 (changed by erin)\n')
    const w = await ask('alice', chat, `rewrite\n${fake({ tool: 'write', args: { file_path: f, content: 'plan v2\n' }, sayResult: true })}`)
    expect(w.text).toContain('changed after you read it earlier in this chat')
    const e = await ask('alice', chat, `edit\n${fake({ tool: 'edit', args: { file_path: f, old_string: 'plan v1', new_string: 'plan v3' }, sayResult: true })}`)
    expect(e.text).toContain('changed after you read it earlier in this chat')
    expect(read(f)).toBe('plan v1 (changed by erin)\n')
    expect(fs.readdirSync(at(dir))).toEqual(['plan.md'])
    // read again: it goes through
    const ok = await ask('alice', chat, `again\n${fake({ tool: 'read', args: { file_path: f } }, { tool: 'write', args: { file_path: f, content: 'plan v2\n' }, sayResult: true })}`)
    expect(ok.text).toContain(`Updated ${f}`)
  })

  test('a sub-agent of a later answer may change it too', async () => {
    const f = `${dirOf()}/list.md`
    put(f, 'a\n')
    const chat = await newChat('alice')
    await ask('alice', chat, `read\n${fake({ tool: 'read', args: { file_path: f } }, { say: 'read' })}`)
    const r = await ask('alice', chat, `delegate\n${fake({ agents: [{ id: 'k1', type: 'general-purpose', description: 'fix the list', steps: [{ tool: 'write', args: { file_path: f, content: 'b\n' }, sayChildResult: true }] }] })}`)
    expect(r.text).toContain(`Updated ${f}`)
    expect(read(f)).toBe('b\n')
  })

  test('another branch of the chat (an edited message) does not get the read', async () => {
    const f = `${dirOf()}/branch.md`
    put(f, 'x\n')
    const chat = await newChat('alice')
    const first = await ask('alice', chat, `read\n${fake({ tool: 'read', args: { file_path: f } }, { say: 'read' })}`)
    // the first message asked again without the read: a sibling of it, on a branch with no read above
    const sibling = await ask('alice', chat, `no read\n${fake({ say: 'ok' })}`, first.parentId)
    expect(sibling.parentId).toBe(first.parentId)
    // on top of the sibling (not the read): refused as before
    const w = await ask('alice', chat, `rewrite\n${fake({ tool: 'write', args: { file_path: f, content: 'y\n' }, sayResult: true })}`, sibling.assistantId)
    expect(w.text).toContain('first (with read)')
    expect(read(f)).toBe('x\n')
  })
})

describe('a shared chat: each person their own reads', () => {
  test('carol cannot change what alice\'s answer read; her own read then goes through', async () => {
    try {
      const f = `projects/kestrel/brief-${uuidv7().slice(-6)}.md`
      put(f, 'brief v1\n')
      const chat = await newChat('alice', { projectId })
      await ask('alice', chat, `read\n${fake({ tool: 'read', args: { file_path: f } }, { say: 'read' })}`)
      const theirs = await ask('carol', chat, `rewrite\n${fake({ tool: 'write', args: { file_path: f, content: 'brief by carol\n' }, sayResult: true })}`)
      expect(theirs.text).toContain('first (with read)')
      expect(read(f)).toBe('brief v1\n')
      // alice's next answer still has her own read
      const mine = await ask('alice', chat, `rewrite\n${fake({ tool: 'write', args: { file_path: f, content: 'brief v2\n' }, sayResult: true })}`)
      expect(mine.text).toContain(`Updated ${f}`)
    } finally {}
  })
})

describe('carriedReads (the rows)', () => {
  test('only the person\'s own rows of the answers given, newest wins; a person who cannot read the file now gets nothing', async () => {
    const f = `${dirOf()}/rows.md`
    put(f, 'rows\n')
    const sha = crypto.createHash('sha256').update('rows\n').digest('hex')
    const chat = await newChat('alice')
    const a1 = await ask('alice', chat, 'one')
    const a2 = await ask('alice', chat, 'two')
    const db = h.ctx.db
    saveReads(db, { chatId: chat, messageId: a1.assistantId, userId: 'alice' }, new Map([[f, 'old']]))
    saveReads(db, { chatId: chat, messageId: a2.assistantId, userId: 'alice' }, new Map([[f, sha]]))
    const mine = carriedReads(db, h.ctx.files, { chatId: chat, userId: 'alice', answers: [a1.assistantId, a2.assistantId] })!
    expect(mine.hashes.get(f)).toBe(sha)
    expect(mine.current(f)).toBe(sha)
    // only the first answer on this branch: its older hash (and so a stale read)
    expect(carriedReads(db, h.ctx.files, { chatId: chat, userId: 'alice', answers: [a1.assistantId] })!.hashes.get(f)).toBe('old')
    // another person: none of alice's rows
    expect(carriedReads(db, h.ctx.files, { chatId: chat, userId: 'carol', answers: [a1.assistantId, a2.assistantId] })).toBeNull()
    // rows of bob's own on alice's private file: bob may not read it now, so it is never "the same version"
    saveReads(db, { chatId: chat, messageId: a2.assistantId, userId: 'bob' }, new Map([[`${f}.bob`, sha]]))
    const bobs = carriedReads(db, h.ctx.files, { chatId: chat, userId: 'bob', answers: [a2.assistantId] })!
    expect(bobs.current(f)).toBeNull()
  })

  test('TurnFiles: a stale carried read throws stale_read on get and is false on has; a call of an unknown agent gets none', () => {
    const tf = new TurnFiles()
    let now: string | null = 'h1'
    tf.carried = { hashes: new Map([['a.md', 'h1']]), current: () => now }
    expect(tf.readHashes.get('a.md')).toBe('h1')
    expect(tf.forAgent('k1').readHashes.has('a.md')).toBe(true)
    now = 'h2'
    expect(tf.readHashes.has('a.md')).toBe(false)
    expect(() => tf.readHashes.get('a.md')).toThrow(/read it earlier in this chat/)
    // a read in this answer wins over the carried one
    tf.readHashes.set('a.md', 'h2')
    expect(tf.readHashes.get('a.md')).toBe('h2')
    // gone or not readable now: as if never read
    now = null
    expect(tf.forAgent('k2').readHashes.get('a.md')).toBeUndefined()
  })

  test('an unknown call (sub-agents running, owner never named) fails closed: no carried reads', async () => {
    const tf = new TurnFiles()
    tf.carried = { hashes: new Map([['a.md', 'h1']]), current: () => 'h1' }
    tf.subagents = true
    const r = await tf.forCall('toolu_unknown', { waitMs: 1 })
    expect(r.known).toBe(false)
    expect(r.files.readHashes.has('a.md')).toBe(false)
    expect(r.files.carried).toBeNull()
  })
})
