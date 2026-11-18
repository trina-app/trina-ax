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
import { carriedReads, CARRIED_READS_PER_ANSWER, CARRIED_READS_PER_CHAT, compactionsIn, forgetSessionText, mayCarryReads, saveReads } from '../../server/src/chat/carried-reads'
import { TurnFiles, type CarriedReads, type ToolCtx } from '../../server/src/files/service'
import { placeProduced } from '../../server/src/tools/make-file'
import { componentC } from '../../server/src/team-files/component'

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
const sha = (b: string | Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')
const rowsOf = (chat: string) => (h.ctx.db.query('SELECT COUNT(*) AS n FROM chat_reads WHERE chat_id = ?').get(chat) as { n: number }).n
/** a CarriedReads stand-in: one path at `hash`, the file's hash now from `now`, read in session `in` */
function carried(rel: string, hash: string, now: () => string | null, readIn: string | null = 's1'): CarriedReads {
  let session: string | null = null
  return { hashes: new Map([[rel, hash]]), current: () => now(), inSession: (s) => { session = s }, wholeFile: (r) => r === rel && !!session && session === readIn }
}
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

  test('a sub-agent of a later answer may edit it, but never replace it whole (it never saw the text)', async () => {
    const f = `${dirOf()}/list.md`
    put(f, 'a\n')
    const chat = await newChat('alice')
    await ask('alice', chat, `read\n${fake({ tool: 'read', args: { file_path: f } }, { say: 'read' })}`)
    const w = await ask('alice', chat, `delegate\n${fake({ agents: [{ id: 'k1', type: 'general-purpose', description: 'rewrite the list', steps: [{ tool: 'write', args: { file_path: f, content: 'guessed\n' }, sayChildResult: true }] }] })}`)
    expect(w.text).toContain('first (with read)')
    expect(read(f)).toBe('a\n')
    const r = await ask('alice', chat, `delegate\n${fake({ agents: [{ id: 'k2', type: 'general-purpose', description: 'fix the list', steps: [{ tool: 'edit', args: { file_path: f, old_string: 'a', new_string: 'b' }, sayChildResult: true }] }] })}`)
    expect(r.text).toContain(`Edited ${f}`)
    expect(read(f)).toBe('b\n')
    // the sub-agent's own read is saved without a session: the main session never saw it
    const row = h.ctx.db.query('SELECT session_id FROM chat_reads WHERE chat_id = ? AND path = ? ORDER BY id DESC LIMIT 1').get(chat, f) as { session_id: string | null }
    expect(row.session_id).toBeNull()
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
      // alice's next answer still has her own read: an edit goes through (her session was not resumed after carol's
      // turn, so a whole-file write would ask for a new read)
      const mine = await ask('alice', chat, `fix\n${fake({ tool: 'edit', args: { file_path: f, old_string: 'v1', new_string: 'v2' }, sayResult: true })}`)
      expect(mine.text).toContain(`Edited ${f}`)
      expect(read(f)).toBe('brief v2\n')
    } finally {}
  })
})

describe('a fresh engine session (the stash is lost: it no longer holds the file\'s text)', () => {
  test('write and make_file ask for a new read; edit still changes it in place', async () => {
    const dir = dirOf()
    const f = `${dir}/fresh.md`, doc = `${dir}/fresh.docx`
    put(f, 'line one\n')
    const chat = await newChat('alice')
    await ask('alice', chat, `read\n${fake({ tool: 'read', args: { file_path: f } }, { tool: 'make_file', args: { format: 'docx', source: f, output: doc } }, { say: 'read' })}`)
    // the resumed session answers "No conversation found": the server starts a fresh one from the chat's text
    const w = await ask('alice', chat, `rewrite\n${fake({ loseSession: true }, { tool: 'write', args: { file_path: f, content: 'guessed\n' }, sayResult: true })}`)
    expect(w.text).toContain('first (with read)')
    expect(read(f)).toBe('line one\n')
    const m = await ask('alice', chat, `again\n${fake({ loseSession: true }, { tool: 'make_file', args: { format: 'docx', content: '# guessed', output: doc }, sayResult: true })}`)
    expect(m.text).toContain('this conversation was started again since')
    expect(fs.readdirSync(at(dir)).sort()).toEqual(['fresh.docx', 'fresh.md'])
    const e = await ask('alice', chat, `fix\n${fake({ loseSession: true }, { tool: 'edit', args: { file_path: f, old_string: 'one', new_string: 'two' }, sayResult: true })}`)
    expect(e.text).toContain(`Edited ${f}`)
    expect(read(f)).toBe('line two\n')
  })
})

describe('more branches and people', () => {
  test('a regenerated answer does not get the reads of the answer it replaced', async () => {
    const f = `${dirOf()}/regen.md`
    put(f, 'same\n')
    const chat = await newChat('alice')
    const first = await ask('alice', chat, `read\n${fake({ tool: 'read', args: { file_path: f } }, { say: 'read' })}`)
    expect(rowsOf(chat)).toBe(1)
    // regenerated while the file is away (its read fails), then the very same bytes come back
    fs.rmSync(at(f))
    const r = await h.api('alice').call(API.regenerate, { params: { id: chat, messageId: first.assistantId }, body: {} })
    await ws.alice!.next('message.done', (x) => x.data.messageId === r.assistantMessage.id, 60_000)
    put(f, 'same\n')
    const w = await ask('alice', chat, `rewrite\n${fake({ tool: 'write', args: { file_path: f, content: 'other\n' }, sayResult: true })}`, r.assistantMessage.id)
    expect(w.text).toContain('first (with read)')
    expect(read(f)).toBe('same\n')
  })

  test('a person who lost access between messages gets nothing from the read', async () => {
    const f = `projects/kestrel/lost-${uuidv7().slice(-6)}.md`
    put(f, 'secret v1\n')
    const chat = await newChat('alice', { projectId })
    await ask('carol', chat, `read\n${fake({ tool: 'read', args: { file_path: f } }, { say: 'read' })}`)
    const folder = (h.ctx.db.query("SELECT id FROM folders WHERE path = 'projects/kestrel'").get() as { id: string }).id
    const rule = h.ctx.db.query("SELECT * FROM folder_rules WHERE folder_id = ? AND subject_type = 'user' AND subject_id = 'carol'").get(folder) as Record<string, string | number | null>
    h.ctx.db.query('DELETE FROM folder_rules WHERE id = ?').run(rule.id!)
    try {
      expect(carriedReads(h.ctx.db, h.ctx.files, { chatId: chat, userId: 'carol', answers: h.ctx.db.query("SELECT id FROM messages WHERE chat_id = ? AND role = 'assistant'").all(chat).map((x) => (x as { id: string }).id) })!.current(f)).toBeNull()
    } finally {
      const cols = Object.keys(rule)
      h.ctx.db.query(`INSERT INTO folder_rules (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...(Object.values(rule) as (string | number | null)[]))
    }
  })

  test('a guest or a restricted run neither keeps nor gets reads', () => {
    expect(mayCarryReads(h.ctx.db, 'erin', false)).toBe(true)
    expect(mayCarryReads(h.ctx.db, 'erin', true)).toBe(false)
    h.ctx.db.query('UPDATE users SET guest = 1 WHERE id = ?').run('erin')
    try { expect(mayCarryReads(h.ctx.db, 'erin', false)).toBe(false) } finally { h.ctx.db.query('UPDATE users SET guest = 0 WHERE id = ?').run('erin') }
  })
})

describe('carriedReads (the rows)', () => {
  test('only the person\'s own rows of the answers given, newest wins; a person who cannot read the file now gets nothing', async () => {
    const f = `${dirOf()}/rows.md`
    put(f, 'rows\n')
    const now = sha('rows\n')
    const chat = await newChat('alice')
    const a1 = await ask('alice', chat, 'one')
    const a2 = await ask('alice', chat, 'two')
    const db = h.ctx.db
    saveReads(db, { chatId: chat, messageId: a1.assistantId, userId: 'alice' }, new Map([[f, 'old']]), new Map([[f, 's1']]))
    saveReads(db, { chatId: chat, messageId: a2.assistantId, userId: 'alice' }, new Map([[f, now]]), new Map([[f, 's2']]))
    const mine = carriedReads(db, h.ctx.files, { chatId: chat, userId: 'alice', answers: [a1.assistantId, a2.assistantId] })!
    expect(mine.hashes.get(f)).toBe(now)
    expect(mine.current(f)).toBe(now)
    // a whole-file replace only in the session that read it
    expect(mine.wholeFile(f)).toBe(false)
    mine.inSession('s1'); expect(mine.wholeFile(f)).toBe(false)
    mine.inSession('s2'); expect(mine.wholeFile(f)).toBe(true)
    // only the first answer on this branch: its older hash (and so a stale read)
    expect(carriedReads(db, h.ctx.files, { chatId: chat, userId: 'alice', answers: [a1.assistantId] })!.hashes.get(f)).toBe('old')
    // another person: none of alice's rows
    expect(carriedReads(db, h.ctx.files, { chatId: chat, userId: 'carol', answers: [a1.assistantId, a2.assistantId] })).toBeNull()
    // bob's own row on alice's private file: bob may not read it, so it is never "the same version"
    saveReads(db, { chatId: chat, messageId: a2.assistantId, userId: 'bob' }, new Map([[f + '.x', now]]), new Map([[f + '.x', null]]))
    expect(carriedReads(db, h.ctx.files, { chatId: chat, userId: 'bob', answers: [a2.assistantId] })!.current(f)).toBeNull()
  })

  test('the newest paths of an answer are kept, a chat keeps at most its newest rows; rows go with the answer and the chat', async () => {
    const chat = await newChat('alice')
    const a1 = await ask('alice', chat, 'one')
    const a2 = await ask('alice', chat, 'two')
    const db = h.ctx.db
    const many = new Map(Array.from({ length: CARRIED_READS_PER_ANSWER + 5 }, (_, i) => [`p/${i}.md`, 'h'] as [string, string]))
    saveReads(db, { chatId: chat, messageId: a1.assistantId, userId: 'alice' }, many, new Map())
    const kept = (db.query('SELECT path FROM chat_reads WHERE message_id = ?').all(a1.assistantId) as { path: string }[]).map((r) => r.path)
    expect(kept.length).toBe(CARRIED_READS_PER_ANSWER)
    expect(kept).toContain(`p/${CARRIED_READS_PER_ANSWER + 4}.md`)
    expect(kept).not.toContain('p/0.md')
    expect(CARRIED_READS_PER_CHAT).toBeGreaterThan(CARRIED_READS_PER_ANSWER)
    saveReads(db, { chatId: chat, messageId: a2.assistantId, userId: 'alice' }, new Map([['q.md', 'h']]), new Map([['q.md', null]]))
    db.query('DELETE FROM messages WHERE id = ?').run(a2.assistantId)
    expect(db.query('SELECT 1 FROM chat_reads WHERE message_id = ?').get(a2.assistantId)).toBeNull()
    expect(rowsOf(chat)).toBe(CARRIED_READS_PER_ANSWER)
    db.query('DELETE FROM chats WHERE id = ?').run(chat)
    expect(rowsOf(chat)).toBe(0)
  })

  test('TurnFiles: a stale carried read throws stale_read on get and is false on has; a call of an unknown agent gets none', async () => {
    const tf = new TurnFiles()
    let now: string | null = 'h1'
    tf.carried = carried('a.md', 'h1', () => now)
    expect(tf.readHashes.get('a.md')).toBe('h1')
    expect(tf.forAgent('k1').readHashes.has('a.md')).toBe(true)
    now = 'h2'
    expect(tf.readHashes.has('a.md')).toBe(false)
    expect(() => tf.readHashes.get('a.md')).toThrow(/read it earlier in this chat/)
    tf.readHashes.set('a.md', 'h2')
    expect(tf.readHashes.get('a.md')).toBe('h2')
    now = null
    expect(tf.forAgent('k2').readHashes.get('a.md')).toBeUndefined()
    const u = new TurnFiles()
    u.carried = carried('a.md', 'h1', () => 'h1')
    u.subagents = true
    const r = await u.forCall('toolu_unknown', { waitMs: 1 })
    expect(r.known).toBe(false)
    expect(r.files.readHashes.has('a.md')).toBe(false)
    expect(r.files.carried).toBeNull()
  })

  test('placeProduced: make_file replaces from a read of this session; thisAnswerOnly (save_url, a room save) still keeps a copy', async () => {
    const dir = dirOf()
    const rel = `${dir}/saved.txt`
    put(rel, 'v1\n')
    const files = componentC(h.ctx).files
    const ctx = (tf: TurnFiles): ToolCtx => ({ user: h.ctx.files.principal('alice'), turnId: null, files: tf })
    const tmp = () => { const p = path.join(h.ctx.config.dataDir, `produced-${uuidv7()}`); fs.writeFileSync(p, 'v2\n'); return p }
    const inSession = () => { const tf = new TurnFiles(); tf.carried = carried(rel, sha('v1\n'), () => sha(fs.readFileSync(at(rel)))); tf.carried.inSession('s1'); return tf }
    const copy = await placeProduced(h.ctx, files, ctx(inSession()), rel.split('/'), tmp(), 'save_url', undefined, { thisAnswerOnly: true })
    expect(copy.conflictCopyOf).toBe(rel)
    expect(read(rel)).toBe('v1\n')
    const made = await placeProduced(h.ctx, files, ctx(inSession()), rel.split('/'), tmp(), 'make_file')
    expect(made.conflictCopyOf).toBeUndefined()
    expect(read(rel)).toBe('v2\n')
  })
})

describe('the session a read was made in', () => {
  test('a turn that moves to another session (an account switch, a lost stash) saves its earlier reads without one', () => {
    const tf = new TurnFiles()
    tf.engineSession('s1', true)
    tf.readHashes.set('a.md', 'h1')
    expect(tf.readSessions.get('a.md')).toBe('s1')
    tf.forAgent('k1').readHashes.set('b.md', 'h2')
    expect(tf.readSessions.get('b.md')).toBeNull()
    tf.engineSession('s2', false)
    expect(tf.readSessions.get('a.md')).toBeNull()
    tf.readHashes.set('c.md', 'h3')
    expect(tf.readSessions.get('c.md')).toBe('s2')
    // the same session again (a continue after a connect): nothing changes
    tf.engineSession('s2', true)
    expect(tf.readSessions.get('c.md')).toBe('s2')
  })

  test('a sub-agent view never offers a whole-file replace from an earlier read', () => {
    const tf = new TurnFiles()
    tf.carried = carried('a.md', 'h1', () => 'h1')
    tf.engineSession('s1', true)
    expect(tf.carried.wholeFile('a.md')).toBe(true)
    const sub = tf.forAgent('k1')
    expect(sub.carried!.wholeFile('a.md')).toBe(false)
    expect(sub.readHashes.get('a.md')).toBe('h1')
  })

  test('a compaction in the stash: the chat\'s reads lose their session (edit only from then on)', async () => {
    const line = (o: unknown) => JSON.stringify(o) + '\n'
    expect(compactionsIn(Buffer.from(line({ type: 'user' })))).toBe(0)
    expect(compactionsIn(Buffer.from(line({ type: 'system', subtype: 'compact_boundary' }) + line({ type: 'user' })))).toBe(1)
    expect(compactionsIn(Buffer.from(line({ type: 'system', subtype: 'microcompact_boundary' }) + line({ type: 'system', subtype: 'compact_boundary' })))).toBe(2)
    const chat = await newChat('alice')
    const a1 = await ask('alice', chat, 'one')
    const db = h.ctx.db
    saveReads(db, { chatId: chat, messageId: a1.assistantId, userId: 'alice' }, new Map([['x.md', 'h']]), new Map([['x.md', 's1']]))
    forgetSessionText(db, chat)
    expect((db.query('SELECT session_id FROM chat_reads WHERE chat_id = ?').get(chat) as { session_id: string | null }).session_id).toBeNull()
    const tf = new TurnFiles()
    tf.engineSession('s1', true)
    tf.readHashes.set('y.md', 'h')
    tf.sessionLostText()
    expect(tf.readSessions.get('y.md')).toBeNull()
  })
})
