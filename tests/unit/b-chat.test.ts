// Component B: chat turns end to end with the fake engine through the real launcher / gate / bridge:
// streaming over the WebSocket, DB saves, queue, stop, resume / fresh sessions, retries, tools, ask_user,
// remember protection, branches, codex, timeouts, restart recovery, attachments.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, ApiError, CHAT_ERROR_MESSAGES, uuidv7, type Attachment, type Message } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { MEMORY_HEADROOM_MIB, setAvailableMemoryForTests, setLimitsPlatformForTests } from '../../server/src/system/limits'

setDefaultTimeout(30_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
let alice: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'b-chat', askUserTimeoutMs: 3000, turnTimeoutMs: 60_000 })
  alice = await h.ws('alice', { windowId: 'win-alice-main' })
  await alice.next('hello')
})
afterAll(async () => { alice?.close(); await h.close() })

const newChat = async (user = 'alice', body: { engine?: 'claude-code' | 'codex'; projectId?: string; title?: string } = {}) =>
  h.api(user).call(API.createChat, { body })

describe('a turn', () => {
  test('a skill-usage insert failure does not stop the permitted command turn', async () => {
    const rel = 'skills/usage-write-failure.md', abs = path.join(h.team, rel)
    fs.writeFileSync(abs, '---\nname: Usage failure\ndescription: synthetic skill\n---\nAnswer briefly.\n')
    h.ctx.db.exec("CREATE TRIGGER fail_skill_usage BEFORE INSERT ON turn_skill_usage BEGIN SELECT RAISE(ABORT,'synthetic usage failure'); END")
    try {
      const result = await ask(h, alice, 'alice', (await newChat()).id, '/Usage failure\n' + fake({ say: 'permitted command completed' }))
      expect(result.done.status).toBe('done')
      expect(result.done.content).toBe('permitted command completed')
      expect(h.ctx.db.query('SELECT COUNT(*) n FROM turn_skill_usage WHERE turn_id=?').get(result.started.turnId)).toEqual({ n: 0 })
    } finally {
      h.ctx.db.exec('DROP TRIGGER fail_skill_usage')
      fs.rmSync(abs, { force: true })
    }
  })
  test('command and successful file-tool reads record actual skill use once per turn', async () => {
    const rel = 'skills/queue-skill.md', abs = path.join(h.team, rel)
    fs.writeFileSync(abs, '---\nname: Queue test\ndescription: synthetic skill\n---\nAnswer briefly.\n')
    try {
      const command = await ask(h, alice, 'alice', (await newChat()).id, '/Queue test\n' + fake({ say: 'command used' }))
      expect(command.done.status).toBe('done')
      expect(h.ctx.db.query('SELECT skill_path,source FROM turn_skill_usage WHERE turn_id=?').all(command.started.turnId)).toEqual([{ skill_path: rel, source: 'command' }])
      const read = await ask(h, alice, 'alice', (await newChat()).id, fake(
        { tool: 'read', args: { file_path: rel } }, { tool: 'read', args: { file_path: rel } }, { say: 'read used' }))
      expect(read.done.status).toBe('done')
      expect(h.ctx.db.query('SELECT skill_path,source FROM turn_skill_usage WHERE turn_id=?').all(read.started.turnId)).toEqual([{ skill_path: rel, source: 'read' }])
      const absent = await ask(h, alice, 'alice', (await newChat()).id, fake({ tool: 'read', args: { file_path: 'skills/absent-synthetic.md' } }, { say: 'no skill' }))
      expect(h.ctx.db.query('SELECT COUNT(*) n FROM turn_skill_usage WHERE turn_id=?').get(absent.started.turnId)).toEqual({ n: 0 })
    } finally { fs.rmSync(abs, { force: true }) }
  })
  test('P4 folder skill: manifest injection, authorized resources, denied resources and one usage row', async () => {
    const name = 'standard-' + 's'.repeat(55), rel = `skills/${name}/SKILL.md`
    const dir = path.join(h.team, 'skills', name)
    const privateFolder = `skills/${name}/references/private`
    const description = 'D'.repeat(1024)
    fs.mkdirSync(path.join(dir, 'references/private'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\nallowed-tools: Bash(*) Read\n---\nP4_MANIFEST_BODY\nRead references/guide.md when needed.\n`)
    fs.writeFileSync(path.join(dir, 'references/guide.md'), '---\nname: Resource is not a skill\n---\nP4_REFERENCE_BODY\n')
    fs.writeFileSync(path.join(dir, 'references/private/hidden.md'), 'P4_DENIED_RESOURCE_BODY')
    fs.writeFileSync(path.join(dir, 'assets/template.txt'), 'P4_ASSET_BODY')
    fs.writeFileSync(path.join(dir, 'scripts/run.sh'), '#!/bin/sh\ntouch ../executed\n', { mode: 0o700 })
    h.ctx.db.query("INSERT INTO folders (id,path) VALUES ('p4-private-resource',?)").run(privateFolder)
    h.ctx.db.query("INSERT INTO folder_rules (id,folder_id,subject_type,subject_id,access) VALUES ('p4-private-deny','p4-private-resource','user','alice','none')").run()
    try {
      const listed = (await h.api('alice').call(API.listSkills)).items.filter(s => s.path.startsWith(`skills/${name}/`))
      expect(listed).toEqual([{ path: rel, name, description }])
      const command = await ask(h, alice, 'alice', (await newChat()).id, `/${name}\n` + fake(
        { echo: 'message' },
        { tool: 'read', args: { file_path: `skills/${name}/references/guide.md` }, sayResult: true },
        { tool: 'read', args: { file_path: `skills/${name}/assets/template.txt` }, sayResult: true },
        { tool: 'read', args: { file_path: `skills/${name}/references/private/hidden.md` }, sayResult: true },
        { tool: 'read', args: { file_path: rel } }, { tool: 'read', args: { file_path: rel } }))
      expect(command.done.status).toBe('done')
      expect(command.done.content).toContain(`<team_skill name="${name}" path="${rel}">`)
      expect(command.done.content).toContain('P4_MANIFEST_BODY')
      expect(command.done.content).toContain('P4_REFERENCE_BODY')
      expect(command.done.content).toContain('P4_ASSET_BODY')
      expect(command.done.content).not.toContain('P4_DENIED_RESOURCE_BODY')
      expect(h.ctx.db.query('SELECT skill_path, skill_name, source FROM turn_skill_usage WHERE turn_id=?').all(command.started.turnId))
        .toEqual([{ skill_path: rel, skill_name: name, source: 'command' }])
      const read = await ask(h, alice, 'alice', (await newChat()).id, fake({ tool: 'read', args: { file_path: rel } }, { say: 'read' }))
      expect(h.ctx.db.query('SELECT skill_path, source FROM turn_skill_usage WHERE turn_id=?').all(read.started.turnId)).toEqual([{ skill_path: rel, source: 'read' }])
      const resources = await ask(h, alice, 'alice', (await newChat()).id, fake(
        { tool: 'read', args: { file_path: `skills/${name}/references/guide.md` } }, { echo: 'tools' }))
      expect(h.ctx.db.query('SELECT COUNT(*) n FROM turn_skill_usage WHERE turn_id=?').get(resources.started.turnId)).toEqual({ n: 0 })
      expect(resources.done.content.toLowerCase()).not.toContain('bash')
      expect(resources.done.content.toLowerCase()).not.toContain('shell')
      expect(fs.existsSync(path.join(dir, 'executed'))).toBe(false)
    } finally {
      h.ctx.db.query("DELETE FROM folders WHERE id='p4-private-resource'").run()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  test('send -> 202, message.created, queue position 0, deltas, message.done; saved; title; idle again', async () => {
    const chat = await newChat()
    expect(chat.runState).toBe('idle')
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: 'Hello there\n' + fake({ say: 'Hi Alice, nice to meet you.' }), clientMessageId: cm(), attachmentIds: [] } })
    expect(r.userMessage?.role).toBe('user')
    expect(r.assistantMessage).toMatchObject({ role: 'assistant', status: 'streaming', content: '' })
    const created = await alice.next('message.created', (f) => f.data.message.id === r.assistantMessage.id)
    expect(created.data.chatId).toBe(chat.id)
    await alice.next('queue.position', (f) => f.data.turnId === r.turnId && f.data.position === 0)
    const done = await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    expect(done.data.status).toBe('done')
    expect(done.data.message.content).toBe('Hi Alice, nice to meet you.')
    expect(done.data.message.usage).toEqual({ inputTokens: 100, outputTokens: 20, costUsd: 0.001 })
    // deltas line up by offset
    const deltas = alice.frames.filter((f) => f.type === 'message.delta' && f.data.messageId === r.assistantMessage.id) as Extract<(typeof alice.frames)[number], { type: 'message.delta' }>[]
    let text = ''
    for (const d of deltas) { expect(d.data.offset).toBe(text.length); text += d.data.text }
    expect(text).toBe('Hi Alice, nice to meet you.')
    const page = await h.api('alice').call(API.listMessages, { params: { id: chat.id } })
    expect(page.items.map((m) => [m.role, m.status])).toEqual([['user', 'done'], ['assistant', 'done']])
    expect(page.items[1]!.content).toBe('Hi Alice, nice to meet you.')
    const after = await h.api('alice').call(API.getChat, { params: { id: chat.id } })
    expect(after.title).toBe('Hello there')
    expect(after.runState).toBe('idle')
    const turn = h.ctx.db.query('SELECT status, input_tokens, output_tokens, usage_source FROM turns WHERE id = ?').get(r.turnId)
    expect(turn).toEqual({ status: 'done', input_tokens: 100, output_tokens: 20, usage_source: 'engine' })
  })

  test('resending the same clientMessageId returns the first turn; a second message while one runs is refused (409)', async () => {
    const chat = await newChat()
    const id = cm()
    const body = { content: fake({ sleep: 600 }, { say: 'slow' }), clientMessageId: id, attachmentIds: [] }
    const a = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body })
    const b = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body })
    expect(b.turnId).toBe(a.turnId)
    expect(b.userMessage?.id).toBe(a.userMessage?.id)
    const other = await h.req('alice', `/api/chats/${chat.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'again', clientMessageId: cm() }) })
    expect(other.status).toBe(409)
    expect(((await other.json()) as { error: { code: string } }).error.code).toBe('conflict')
    await alice.next('message.done', (f) => f.data.messageId === a.assistantMessage.id, 20_000)
  })

  test('REST while streaming returns the live text, not the last 0.3 s save', async () => {
    const chat = await newChat()
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ say: 'part one. ' }, { sleep: 1200 }, { say: 'part two.' }), clientMessageId: cm(), attachmentIds: [] } })
    await alice.next('message.delta', (f) => f.data.messageId === r.assistantMessage.id && f.data.text.includes('.'))
    const live = await waitFor(async () => {
      const p = await h.api('alice').call(API.listMessages, { params: { id: chat.id } })
      const m = p.items.find((x) => x.id === r.assistantMessage.id)!
      return m.status === 'streaming' && m.content === 'part one. ' ? m : null
    }, { timeoutMs: 3000 })
    expect(live?.content).toBe('part one. ')
    await waitFor(() => (h.ctx.db.query('SELECT content FROM messages WHERE id = ?').get(r.assistantMessage.id) as { content: string }).content === 'part one. ', { timeoutMs: 2000 })
    expect((h.ctx.db.query('SELECT content FROM messages WHERE id = ?').get(r.assistantMessage.id) as { content: string }).content).toBe('part one. ')
    const done = await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    expect(done.data.message.content).toBe('part one. part two.')
  })

  test('stop a running turn: stopped, partial text kept, session still saved', async () => {
    const chat = await newChat()
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ say: 'started ' }, { sleep: 15000 }, { say: 'never' }), clientMessageId: cm(), attachmentIds: [] } })
    await alice.next('message.delta', (f) => f.data.messageId === r.assistantMessage.id && f.data.offset + f.data.text.length === 8)
    const s = await h.api('alice').call(API.stop, { params: { id: chat.id } })
    expect(s).toEqual({ stopped: true, turnId: r.turnId })
    const done = await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 15_000)
    expect(done.data.status).toBe('stopped')
    expect(done.data.message.content).toBe('started ')
    expect((h.ctx.db.query('SELECT status FROM turns WHERE id = ?').get(r.turnId) as { status: string }).status).toBe('stopped')
    expect(await h.api('alice').call(API.stop, { params: { id: chat.id } })).toEqual({ stopped: false, turnId: null })
  })
})

describe('queue', () => {
  test('team-wide limit: the turn over the limit waits (position 1), can be cancelled, and the next one starts when a slot frees', async () => {
    h.ctx.db.query("INSERT OR REPLACE INTO settings (key, value) VALUES ('concurrency', '1')").run()
    try {
      const c1 = await newChat(), c2 = await newChat(), c3 = await newChat()
      const t1 = await h.api('alice').call(API.sendMessage, { params: { id: c1.id }, body: { content: fake({ sleep: 1200 }, { say: 'one' }), clientMessageId: cm(), attachmentIds: [] } })
      const t2 = await h.api('alice').call(API.sendMessage, { params: { id: c2.id }, body: { content: fake({ say: 'two' }), clientMessageId: cm(), attachmentIds: [] } })
      const t3 = await h.api('alice').call(API.sendMessage, { params: { id: c3.id }, body: { content: fake({ say: 'three' }), clientMessageId: cm(), attachmentIds: [] } })
      expect(t1.queuePosition).toBe(0)
      expect(t2.queuePosition).toBe(1)
      expect(t3.queuePosition).toBe(2)
      expect((await h.api('alice').call(API.getChat, { params: { id: c2.id } })).runState).toBe('queued')
      // cancel the queued third turn: stopped without ever running
      expect((await h.api('alice').call(API.stop, { params: { id: c3.id } })).turnId).toBe(t3.turnId)
      const d3 = await alice.next('message.done', (f) => f.data.messageId === t3.assistantMessage.id)
      expect(d3.data.status).toBe('stopped')
      await alice.next('queue.position', (f) => f.data.turnId === t2.turnId && f.data.position === 0, 20_000)
      const d1 = await alice.next('message.done', (f) => f.data.messageId === t1.assistantMessage.id, 20_000)
      const d2 = await alice.next('message.done', (f) => f.data.messageId === t2.assistantMessage.id, 20_000)
      expect([d1.data.message.content, d2.data.message.content]).toEqual(['one', 'two'])
      const seq = (id: string) => alice.frames.findIndex((f) => f.type === 'message.done' && f.data.messageId === id)
      expect(seq(t1.assistantMessage.id)).toBeLessThan(seq(t2.assistantMessage.id))
    } finally {
      h.ctx.db.query("DELETE FROM settings WHERE key = 'concurrency'").run()
    }
  })
  test('short of memory: the second answer waits under the concurrency limit and starts once memory is back', async () => {
    setLimitsPlatformForTests('linux')
    setAvailableMemoryForTests(MEMORY_HEADROOM_MIB) // room for nothing more than the one that always may run
    try {
      const c1 = await newChat(), c2 = await newChat()
      const t1 = await h.api('alice').call(API.sendMessage, { params: { id: c1.id }, body: { content: fake({ sleep: 4000 }, { say: 'one' }), clientMessageId: cm(), attachmentIds: [] } })
      const t2 = await h.api('alice').call(API.sendMessage, { params: { id: c2.id }, body: { content: fake({ say: 'two' }), clientMessageId: cm(), attachmentIds: [] } })
      expect(t1.queuePosition).toBe(0)
      expect(t2.queuePosition).toBe(1) // concurrency is 3, memory holds it back
      expect((await h.api('alice').call(API.getChat, { params: { id: c2.id } })).runState).toBe('queued')
      setAvailableMemoryForTests(64 * 1024)
      await alice.next('queue.position', (f) => f.data.turnId === t2.turnId && f.data.position === 0, 10_000)
      const d2 = await alice.next('message.done', (f) => f.data.messageId === t2.assistantMessage.id, 20_000)
      expect(d2.data.message.content).toBe('two')
      await alice.next('message.done', (f) => f.data.messageId === t1.assistantMessage.id, 20_000)
    } finally {
      setAvailableMemoryForTests(undefined)
      setLimitsPlatformForTests(null)
    }
  })
})

describe('engine sessions', () => {
  test('the next turn resumes the stashed session; regenerate starts a fresh one with the branch history', async () => {
    const chat = await newChat()
    const one = await ask(h, alice, 'alice', chat.id, 'first question\n' + fake({ say: 'first answer' }))
    expect(one.done.content).toBe('first answer')
    const stashDir = path.join(h.dataDir, 'sessions', chat.id)
    expect(fs.readdirSync(stashDir).length).toBe(1)
    const two = await ask(h, alice, 'alice', chat.id, 'second\n' + fake({ echo: 'resume' }, { say: ' / ' }, { echo: 'history' }))
    expect(two.done.content).toStartWith('resumed=true / user: first question | assistant: first answer')
    // regenerate the first answer: different branch -> fresh session, history in the instructions
    const r = await h.api('alice').call(API.regenerate, { params: { id: chat.id, messageId: one.started.assistantMessage.id }, body: {} })
    expect(r.userMessage).toBeNull()
    const d = await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    // the user message is answered again (same directives) on a new engine session
    expect(d.data.message.content).toBe('first answer')
    expect((h.ctx.db.query('SELECT engine_session_leaf_id FROM chats WHERE id = ?').get(chat.id) as { engine_session_leaf_id: string }).engine_session_leaf_id).toBe(r.assistantMessage.id)
    expect(fs.readdirSync(stashDir).length).toBe(1)
    expect(d.data.message.branch).toMatchObject({ index: 1, count: 2 })
    expect(d.data.message.parentId).toBe(one.started.userMessage!.id)
    // the active branch now ends at the regenerated answer
    const page = await h.api('alice').call(API.listMessages, { params: { id: chat.id } })
    expect(page.items.map((m) => m.id)).toEqual([one.started.userMessage!.id, r.assistantMessage.id])
    // switch back to the first branch: newest leaf under the first answer is the second exchange
    const back = await h.api('alice').call(API.selectBranch, { params: { id: chat.id }, body: { messageId: one.started.assistantMessage.id } })
    expect(back.items.map((m) => m.id)).toEqual([one.started.userMessage!.id, one.started.assistantMessage.id, two.started.userMessage!.id, two.started.assistantMessage.id])
  })

  test('edit a message: sibling user message, fresh session with the history before it', async () => {
    const chat = await newChat()
    const one = await ask(h, alice, 'alice', chat.id, 'alpha\n' + fake({ say: 'A' }))
    const two = await ask(h, alice, 'alice', chat.id, 'beta\n' + fake({ say: 'B' }))
    const e = await h.api('alice').call(API.editMessage, { params: { id: chat.id, messageId: two.started.userMessage!.id }, body: { content: 'gamma\n' + fake({ echo: 'resume' }, { say: ' ' }, { echo: 'system' }), clientMessageId: cm(), attachmentIds: [] } })
    expect(e.userMessage!.parentId).toBe(one.started.assistantMessage.id)
    expect(e.userMessage!.branch).toMatchObject({ index: 1, count: 2 })
    const d = await alice.next('message.done', (f) => f.data.messageId === e.assistantMessage.id, 20_000)
    expect(d.data.message.content).toStartWith('resumed=false ')
    expect(d.data.message.content).toContain('<previous_conversation>')
    expect(d.data.message.content).toContain('User: alpha')
    expect(d.data.message.content).toContain('Assistant: A')
    expect(d.data.message.content).not.toContain('beta')
  })

  test('lost stash -> fresh session with history; "No conversation found" -> one retry without the session', async () => {
    const chat = await newChat()
    await ask(h, alice, 'alice', chat.id, 'remember the word kiwi\n' + fake({ say: 'ok kiwi' }))
    fs.rmSync(path.join(h.dataDir, 'sessions', chat.id), { recursive: true, force: true })
    const two = await ask(h, alice, 'alice', chat.id, fake({ echo: 'resume' }, { say: ' ' }, { echo: 'system' }))
    expect(two.done.content).toStartWith('resumed=false')
    expect(two.done.content).toContain('User: remember the word kiwi')
    const three = await ask(h, alice, 'alice', chat.id, fake({ loseSession: true }, { echo: 'resume' }, { say: ' ' }, { echo: 'system' }))
    expect(three.done.status).toBe('done')
    expect(three.done.content).toStartWith('resumed=false')
    expect(three.done.content).toContain('ok kiwi')
  })
})

describe('engine trouble', () => {
  test('refusal -> one retry with another model, shown as a step and a notice', async () => {
    const chat = await newChat()
    const r = await ask(h, alice, 'alice', chat.id, fake({ refuseUnless: 'sonnet' }, { echo: 'model' }))
    expect(r.done.status).toBe('done')
    expect(r.done.content).toBe('model=sonnet')
    expect(r.done.steps.some((s) => s.tool === 'refusal')).toBe(true)
    await alice.next('notice', (f) => f.data.code === 'engine_refused_retry')
  })
  test('crash before any output -> retried once', async () => {
    const chat = await newChat()
    const r = await ask(h, alice, 'alice', chat.id, fake({ crashOnce: true }, { say: 'survived' }))
    expect(r.done).toMatchObject({ status: 'done', content: 'survived' })
  })
  test('engine error -> message error with a stable code and a localized text', async () => {
    const chat = await newChat()
    const r = await ask(h, alice, 'alice', chat.id, fake({ say: 'partial' }, { fail: 'rate limit exceeded (429)' }))
    expect(r.done.status).toBe('error')
    expect(r.done.error?.code).toBe('rate_limited')
    expect(r.done.error?.params).toEqual({ reason: 'rate_limit' })
    const saved = await h.api('alice').call(API.listMessages, { params: { id: chat.id } })
    expect(saved.items.find(m => m.id === r.done.id)?.error).toEqual(r.done.error)
    expect(r.done.error?.message).toContain('limit') // alice reads English
    expect(r.done.content).toBe('partial')
  })
  test('a Korean auth error keeps its distinct reason in the stream, database and reloaded chat', async () => {
    const bob = await h.ws('bob', { windowId: 'win-bob-i18n' })
    await bob.next('hello')
    try {
      const chat = await newChat('bob')
      const content = fake({ say: 'partial' }, { fail: 'authentication failed (401)' })
      const r = await ask(h, bob, 'bob', chat.id, content)
      const error = { code: 'engine_unavailable', message: CHAT_ERROR_MESSAGES.auth.ko, params: { reason: 'auth' } } as const
      expect(r.done).toMatchObject({ status: 'error', content: 'partial', error })
      const row = h.ctx.db.query('SELECT error FROM messages WHERE id = ?').get(r.done.id) as { error: string }
      expect(JSON.parse(row.error)).toEqual(error)
      const saved = await h.api('bob').call(API.listMessages, { params: { id: chat.id } })
      expect(saved.items.find(m => m.id === r.done.id)?.error).toEqual(error)
      expect(saved.items.find(m => m.role === 'user')?.content).toBe(content)
    } finally { bob.close() }
  })
  test('missing engine -> engine_unavailable, no launch', async () => {
    const chat = await newChat()
    const rt = h.rt()
    const confs = rt.engines.get()
    const saved = confs.codex
    confs.codex = null
    confs.problems.codex = 'engine_missing'
    try {
      await h.api('alice').call(API.updateChat, { params: { id: chat.id }, body: { engine: 'codex' } })
      const r = await ask(h, alice, 'alice', chat.id, 'hi')
      expect(r.done.status).toBe('error')
      expect(r.done.error?.code).toBe('engine_unavailable')
      expect(r.done.error?.params).toEqual({ reason: 'engine_missing' })
    } finally { confs.codex = saved; delete confs.problems.codex }
  })
})

describe('tools', () => {
  test('file tools: steps with labels, files.changed to everyone who can see the path, summary under the answer', async () => {
    const bob = await h.ws('bob', { windowId: 'win-bob-tools' })
    await bob.next('hello')
    const erin = await h.ws('erin', { windowId: 'win-erin-tools' })
    await erin.next('hello')
    const chat = await newChat()
    const r = await ask(h, alice, 'alice', chat.id, fake(
      { tool: 'read', args: { file_path: 'shared/glossary.md' } },
      { tool: 'write', args: { file_path: 'shared/notes/b-test.md', content: '# note\n' } },
      { tool: 'write', args: { file_path: 'groups/marketing/b-plan.md', content: 'plan\n' } },
      { tool: 'write', args: { file_path: 'groups/finance/steal.md', content: 'x' } },
      { say: 'done' },
    ))
    expect(r.done.steps.map((s) => [s.tool, s.status])).toEqual([['read', 'ok'], ['write', 'ok'], ['write', 'ok'], ['write', 'error']])
    expect(r.done.steps[0]!.label).toBe('Read · shared/glossary.md')
    expect(r.done.files).toEqual({
      saved: [{ path: 'shared/notes/b-test.md', action: 'create' }, { path: 'groups/marketing/b-plan.md', action: 'create' }],
      conflicts: [],
      rejected: [{ path: 'groups/finance/steal.md', reason: expect.stringContaining('not found or no access') }],
    })
    // bob (finance) sees the shared file but not marketing's; erin (marketing) sees both
    const bf = await bob.next('files.changed')
    expect(bf.data.changes.map((c) => c.path)).toEqual(['shared/notes/b-test.md'])
    await waitFor(() => erin.frames.filter((f) => f.type === 'files.changed').length >= 2, { timeoutMs: 3000 })
    const ep = erin.frames.flatMap((f) => (f.type === 'files.changed' ? f.data.changes.map((c) => c.path) : []))
    expect(ep).toEqual(['shared/notes/b-test.md', 'groups/marketing/b-plan.md'])
    expect(bob.frames.some((f) => f.type === 'files.changed' && f.data.changes.some((c) => c.path.startsWith('groups/')))).toBe(false)
    bob.close(); erin.close()
  })

  test('large tool results reach the engine whole (the tool socket finishes partial writes)', async () => {
    const lines = Array.from({ length: 1900 }, (_, i) => `line ${i + 1} ` + 'x'.repeat(200))
    fs.writeFileSync(path.join(h.team, 'users/alice/big.md'), lines.join('\n') + '\n')
    const chat = await newChat()
    const r = await ask(h, alice, 'alice', chat.id, fake({ tool: 'read', args: { file_path: 'users/alice/big.md' }, sayLength: true }))
    const n = Number(/length=(\d+)/.exec(r.done.content)?.[1])
    expect(n).toBeGreaterThan(380_000)
    expect(r.done.content).toContain('tail=  1900\tline')
  })

  test('tools offered to a web turn: file tools + remember / forget / ask_user / set_title (+ registered tools), no browser tools', async () => {
    const savedTools = h.ctx.services.turnTools
    h.ctx.services.turnTools = [{
      name: 'web_fetch', description: 'test tool', inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      async call(args, t) { return { content: [{ type: 'text', text: `fetched ${(args as { url: string }).url} for ${t.userId} in ${t.chatId}` }] } },
    }]
    try {
      const chat = await newChat()
      const r = await ask(h, alice, 'alice', chat.id, fake({ echo: 'tools' }, { say: ' | ' }, { tool: 'web_fetch', args: { url: 'https://example.com' }, sayResult: true }))
      // set_title: the first message of a new chat (chat/title.ts)
      expect(r.done.content.split(' | ')[0]).toBe('ask_user,edit,forget,glob,grep,list,read,remember,set_title,web_fetch,write')
      expect(r.done.content).toContain(`fetched https://example.com for alice in ${chat.id}`)
      const audit = h.ctx.db.query("SELECT tool, ok FROM tool_events WHERE turn_id = ? AND tool = 'web_fetch'").all(r.started.turnId)
      expect(audit).toEqual([{ tool: 'web_fetch', ok: 1 }])
    } finally { h.ctx.services.turnTools = savedTools }
  })

  test('ask_user: card to every window, listed for reloads, answered once, then closed', async () => {
    const other = await h.ws('alice', { windowId: 'win-alice-other' })
    await other.next('hello')
    const chat = await newChat()
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'ask_user', args: { question: 'Which color?', options: [{ label: 'Red', value: 'red' }, { label: 'Blue', value: 'blue' }] }, sayResult: true }), clientMessageId: cm(), attachmentIds: [] } })
    const card = await alice.next('turn.request', (f) => f.data.turnId === r.turnId)
    await other.next('turn.request', (f) => f.data.turnId === r.turnId)
    expect(card.data.request).toMatchObject({ kind: 'ask_user', question: 'Which color?' })
    const open = await h.api('alice').call(API.listTurnRequests, { params: { id: chat.id } })
    expect(open.items.map((x) => x.request.requestId)).toEqual([card.data.request.requestId])
    // bob cannot answer alice's turn
    const bobTry = await h.req('bob', `/api/turns/${r.turnId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'ask_user', requestId: card.data.request.requestId, answer: 'red' }) })
    expect(bobTry.status).toBe(404)
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'blue' } })
    await other.next('turn.request.closed', (f) => f.data.requestId === card.data.request.requestId && f.data.reason === 'answered')
    const again = await h.req('alice', `/api/turns/${r.turnId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'ask_user', requestId: card.data.request.requestId, answer: 'red' }) })
    expect(again.status).toBe(409)
    const d = await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    expect(d.data.message.content).toBe('{"answer":"blue"}')
    expect(d.data.message.steps.find((s) => s.kind === 'ask_user')).toMatchObject({ label: 'Question: Which color?', detail: 'blue', status: 'ok' })
    other.close()
  })

  test('ask_user without an answer: skipped after the wait (time limit paused meanwhile)', async () => {
    const chat = await newChat()
    const r = await ask(h, alice, 'alice', chat.id, fake({ tool: 'ask_user', args: { question: 'Anyone?' }, sayResult: true }), { ms: 20_000 })
    expect(r.done.content).toBe('{"skipped":true}')
    await alice.next('turn.request.closed', (f) => f.data.turnId === r.started.turnId && f.data.reason === 'timeout')
  })
})

describe('memories', () => {
  test('remember in a clean chat: saved as "ai", chip step, memory.changed; next turn sees it in the instructions; forget removes it', async () => {
    const chat = await newChat()
    const r = await ask(h, alice, 'alice', chat.id, fake({ tool: 'remember', args: { text: 'Prefers short answers' }, sayResult: true }))
    const { id } = JSON.parse(r.done.content) as { id: string }
    expect(h.ctx.db.query('SELECT source, created_turn_id FROM memories WHERE id = ?').get(id)).toEqual({ source: 'ai', created_turn_id: r.started.turnId })
    expect(r.done.steps[0]).toMatchObject({ tool: 'remember', label: 'Remembered: Prefers short answers', detail: `memory:${id}` })
    await alice.next('memory.changed', (f) => f.data.change === 'created' && f.data.memory?.id === id)
    const list = await h.api('alice').call(API.listMemories, {})
    expect(list.items.map((m) => m.text)).toContain('Prefers short answers')
    const chat2 = await newChat()
    const p = await ask(h, alice, 'alice', chat2.id, fake({ echo: 'system' }))
    expect(p.done.content).toContain(`<memories_about_the_user>`)
    expect(p.done.content).toContain(`- [${id}] Prefers short answers`)
    const f = await ask(h, alice, 'alice', chat2.id, fake({ tool: 'forget', args: { id }, sayResult: true }))
    expect(f.done.content).toBe('{"ok":true}')
    expect((await h.api('alice').call(API.listMemories, {})).items.some((m) => m.id === id)).toBe(false)
  })

  test('remember after reading other people\'s content needs the person\'s OK (saved as "user"); "no" keeps nothing', async () => {
    const chat = await newChat()
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'read', args: { file_path: 'shared/glossary.md' } }, { tool: 'remember', args: { text: 'Works on ARR reports' }, sayResult: true }), clientMessageId: cm(), attachmentIds: [] } })
    const card = await alice.next('turn.request', (f) => f.data.turnId === r.turnId)
    expect(card.data.request.kind).toBe('ask_user')
    expect((card.data.request as { question: string }).question).toContain('Works on ARR reports')
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'yes' } })
    const d = await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    const { id } = JSON.parse(d.data.message.content) as { id: string }
    expect((h.ctx.db.query('SELECT source FROM memories WHERE id = ?').get(id) as { source: string }).source).toBe('user')
    // same (tainted) chat, declined
    const r2 = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'remember', args: { text: 'Likes durian' }, sayResult: true }), clientMessageId: cm(), attachmentIds: [] } })
    const card2 = await alice.next('turn.request', (f) => f.data.turnId === r2.turnId)
    await h.api('alice').call(API.answerTurn, { params: { id: r2.turnId }, body: { kind: 'ask_user', requestId: card2.data.request.requestId, answer: 'no' } })
    const d2 = await alice.next('message.done', (f) => f.data.messageId === r2.assistantMessage.id, 20_000)
    expect(d2.data.message.content).toContain('did not confirm')
    expect((h.ctx.db.query("SELECT COUNT(*) n FROM memories WHERE text = 'Likes durian'").get() as { n: number }).n).toBe(0)
  })

  test('too long memories are refused; REST delete one / clear all (own only)', async () => {
    const chat = await newChat()
    const r = await ask(h, alice, 'alice', chat.id, fake({ tool: 'remember', args: { text: 'x'.repeat(301) }, sayResult: true }))
    expect(r.done.content).toContain('under 300 characters')
    h.ctx.db.query("INSERT INTO memories (id, user_id, text) VALUES (?, 'bob', 'bob secret')").run(uuidv7())
    const mine = await h.api('alice').call(API.listMemories, { query: { limit: 1 } })
    if (mine.items[0]) {
      const bobDel = await h.req('bob', `/api/memories/${mine.items[0].id}`, { method: 'DELETE' })
      expect(bobDel.status).toBe(404)
    }
    await h.api('alice').call(API.clearMemories, {})
    expect((await h.api('alice').call(API.listMemories, {})).items).toEqual([])
    expect((await h.api('bob').call(API.listMemories, {})).items.map((m) => m.text)).toEqual(['bob secret'])
    await alice.next('memory.changed', (f) => f.data.change === 'cleared')
  })
})

describe('instructions', () => {
  test('person, writable folders, language, team rules, project instructions', async () => {
    const proj = await h.api('alice').call(API.createProject, { body: { name: 'Falcon', folderPath: 'projects/falcon', instructions: 'Always cite the plan file.' } })
    const chat = await newChat('alice', { projectId: proj.id })
    const r = await ask(h, alice, 'alice', chat.id, fake({ echo: 'system' }))
    const s = r.done.content
    expect(s).toContain('User: Alice Kim (id alice, role member, groups Marketing)')
    expect(s).toMatch(/Writable folders: .*groups\/marketing.*projects\/falcon.*shared.*users\/alice/)
    expect(s).toContain('Read-only folders: projects/falcon/public, skills')
    expect(s).toContain('Answer in English')
    expect(s).toContain('### skills/team-rules.md')
    expect(s).toContain('## Project: Falcon')
    expect(s).toContain('<project_instructions>\nAlways cite the plan file.\n</project_instructions>')
    expect(s).not.toContain('## Browser')
    expect(s).not.toContain('CANARY')
  })
})

describe('codex', () => {
  test('codex chat: same tools, the branch history travels in the instructions every turn', async () => {
    const chat = await newChat('alice', { engine: 'codex' })
    const one = await ask(h, alice, 'alice', chat.id, 'apple\n' + fake({ tool: 'read', args: { file_path: 'users/alice/todo.md' }, sayResult: true }))
    expect(one.done.content).toContain('Draft Q4 campaign report')
    expect(one.done.engine).toBe('codex')
    expect(one.done.steps[0]).toMatchObject({ tool: 'read', status: 'ok' })
    const two = await ask(h, alice, 'alice', chat.id, fake({ echo: 'system' }, { echo: 'model' }))
    expect(two.done.content).toContain('User: apple')
    expect(two.done.content).toContain('model=fake-1')
  })
})

describe('time limit', () => {
  test('the total wall-time limit keeps its own explanation after storage', async () => {
    const rt = h.rt() as unknown as { wallTimeoutMs: number }
    const saved = rt.wallTimeoutMs
    rt.wallTimeoutMs = 1500
    try {
      const chat = await newChat()
      const r = await ask(h, alice, 'alice', chat.id, fake({ say: 'working' }, { sleep: 20000 }), { ms: 20_000 })
      expect(r.done.error).toEqual({ code: 'busy', message: CHAT_ERROR_MESSAGES.wall_timeout.en, params: { reason: 'wall_timeout' } })
      const saved = await h.api('alice').call(API.listMessages, { params: { id: chat.id } })
      expect(saved.items.find(m => m.id === r.done.id)?.error).toEqual(r.done.error)
    } finally { rt.wallTimeoutMs = saved }
  })
  test('a turn over the limit is stopped with a timeout error', async () => {
    const rt = h.rt() as unknown as { turnTimeoutMs: number }
    const saved = rt.turnTimeoutMs
    rt.turnTimeoutMs = 1500
    try {
      const chat = await newChat()
      const r = await ask(h, alice, 'alice', chat.id, fake({ say: 'working' }, { sleep: 20000 }), { ms: 20_000 })
      expect(r.done.status).toBe('error')
      expect(r.done.error?.code).toBe('busy')
      expect(r.done.error?.params).toEqual({ reason: 'timeout' })
      expect(r.done.content).toBe('working')
    } finally { rt.turnTimeoutMs = saved }
  })
})

describe('attachments', () => {
  test('attachments from the attachment store become part of the message; unknown ids are refused', async () => {
    const chat = await newChat()
    const att: Attachment = { id: uuidv7(), name: 'brief.md', path: `users/alice/.attachments/${chat.id}/brief.md`, size: 12, mime: 'text/markdown', kind: 'text' }
    fs.mkdirSync(path.join(h.team, 'users/alice/.attachments', chat.id), { recursive: true })
    fs.writeFileSync(path.join(h.team, att.path), 'brief: hello')
    const savedStore = h.ctx.services.attachments
    h.ctx.services.attachments = { get: (u, c, ids) => (u === 'alice' && c === chat.id ? ids.filter((i) => i === att.id).map(() => att) : []) }
    try {
      const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ echo: 'message' }, { tool: 'read', args: { file_path: att.path }, sayResult: true }), clientMessageId: cm(), attachmentIds: [att.id] } })
      expect(r.userMessage!.attachments).toEqual([att])
      const d = await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
      expect(d.data.message.content).toContain(`- ${att.path} (brief.md, text/markdown, 12 bytes)`)
      expect(d.data.message.content).toContain('brief: hello')
      const bad = await h.req('alice', `/api/chats/${chat.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'x', clientMessageId: cm(), attachmentIds: [uuidv7()] }) })
      expect(bad.status).toBe(400)
    } finally { h.ctx.services.attachments = savedStore }
  })
})

describe('restart recovery', () => {
  test('running turns become interrupted; queued turns run again', async () => {
    const chat = await newChat()
    const chat2 = await newChat()
    const db = h.ctx.db
    const mk = (chatId: string, status: string, content: string) => {
      const u = uuidv7(), a = uuidv7(), t = uuidv7()
      db.query("INSERT INTO messages (id, chat_id, role, author_id, content, status) VALUES (?, ?, 'user', 'alice', ?, 'done')").run(u, chatId, content)
      db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status, turn_id) VALUES (?, ?, ?, 'assistant', 'half', 'streaming', ?)").run(a, chatId, u, t)
      db.query('INSERT INTO turns (id, chat_id, user_id, engine, status, message_id, user_message_id, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(t, chatId, 'alice', 'claude-code', status, a, u, new Date().toISOString())
      db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(a, chatId)
      return { u, a, t }
    }
    const was = mk(chat.id, 'running', 'old')
    const q = mk(chat2.id, 'queued', fake({ say: 'requeued ok' }))
    h.rt().recover()
    const m = (await h.api('alice').call(API.listMessages, { params: { id: chat.id } })).items.at(-1) as Message
    expect(m).toMatchObject({ id: was.a, status: 'error', content: 'half' })
    expect(m.error?.code).toBe('unavailable')
    expect((db.query('SELECT status FROM turns WHERE id = ?').get(was.t) as { status: string }).status).toBe('interrupted')
    const d = await alice.next('message.done', (f) => f.data.messageId === q.a, 20_000)
    expect(d.data.message.content).toBe('requeued ok')
  })
})

describe('access', () => {
  test("other people's chats are not found; trash, restore and purge", async () => {
    const chat = await newChat()
    for (const p of [`/api/chats/${chat.id}`, `/api/chats/${chat.id}/messages`]) expect((await h.req('bob', p)).status).toBe(404)
    const del = await h.api('alice').call(API.deleteChat, { params: { id: chat.id } })
    expect(new Date(del.purgeAt).getTime() - new Date(del.deletedAt).getTime()).toBe(7 * 86400_000)
    expect((await h.api('alice').call(API.listChats, {})).items.some((c) => c.id === chat.id)).toBe(false)
    expect((await h.api('alice').call(API.listChats, { query: { trash: '1' } })).items.map((c) => c.id)).toContain(chat.id)
    await h.api('alice').call(API.restoreChat, { params: { id: chat.id } })
    expect((await h.api('alice').call(API.listChats, {})).items.some((c) => c.id === chat.id)).toBe(true)
    await h.api('alice').call(API.deleteChat, { params: { id: chat.id } })
    h.ctx.db.query('UPDATE chats SET deleted_at = ? WHERE id = ?').run(new Date(Date.now() - 8 * 86400_000).toISOString(), chat.id)
    expect(h.rt().purgeTrash()).toBe(1)
    await alice.next('chat.updated', (f) => f.data.chatId === chat.id && f.data.change === 'purged')
    await expect(h.api('alice').call(API.getChat, { params: { id: chat.id } })).rejects.toBeInstanceOf(ApiError)
  })
})
