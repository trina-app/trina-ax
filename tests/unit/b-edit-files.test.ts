// edit_files (docs/DECISIONS.md "Bulk edits in one call"): the same exact replacement in up to 50 files in one call,
// each file run as its own edit call through the MCP handler: the same access check, read-first rule, version,
// conflict copy, cards (skills/, wider audience), audit row and file event as a separate edit; failures do not stop the
// others; confidential chats and the remote connector never get it. Fake engine through the real launcher and gate.
//
// Fixture (tests/lib/fixtures.ts): alice = marketing member, bob = finance, carol = admin, dana = owner; shared/ is
// everyone-write, skills/ everyone-read (admins write).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type Step } from '@mycel/shared/api'
import { EDIT_FILES_MAX, EDIT_FILES_TOOL, FILE_TOOLS, OTHER_TOOLS, stepLabel } from '@mycel/shared'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { makeHandler } from '../../server/src/mcp/protocol'
import { TurnFiles } from '../../server/src/files/service'
import { buildTurnPrompt, BULK_REPORT_RULE } from '../../server/src/chat/prompt'
import type { TurnToolSet } from '../../server/src/turns'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const read = (file_path: string) => ({ tool: 'read', args: { file_path } })
const editFiles = (file_paths: string[], old_string: string, new_string: string, extra: Record<string, unknown> = {}) =>
  ({ tool: EDIT_FILES_TOOL, args: { file_paths, old_string, new_string, ...extra }, sayResult: true })

let h: Harness
const socks: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-edit-files', askUserTimeoutMs: 4000, turnTimeoutMs: 60_000 })
  for (const u of ['alice', 'dana']) { socks[u] = await h.ws(u, { windowId: `win-ef-${u}` }); await socks[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h?.close() })

const put = (rel: string, s: string) => { const p = path.join(h.team, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
const text = (rel: string) => fs.readFileSync(path.join(h.team, rel), 'utf8')
const note = (id: string, status: string) => `---\nid: ${id}\nstatus: ${status}\n---\n진행 상황: 견적 진행 중\n`
const events = (turnId: string) => h.ctx.db.query("SELECT tool, summary, ok, tool_use_id, parent_tool_use_id FROM tool_events WHERE turn_id = ? AND tool <> '(connect)' ORDER BY id").all(turnId) as { tool: string; summary: string; ok: number; tool_use_id: string | null; parent_tool_use_id: string | null }[]
const versions = (rel: string) => (h.ctx.db.query('SELECT COUNT(*) AS n FROM file_versions WHERE path = ?').get(rel) as { n: number }).n
const step = (steps: Step[]) => steps.find((s) => s.tool === EDIT_FILES_TOOL)!
/** a server card (ask_user with origin / preview) */
const asCard = (r: unknown) => r as { origin?: string; preview?: { kind: string; path: string } }

describe('edit_files', () => {
  test('S17 shape: one call, each file checked on its own; already done, unread and no-access files are listed, the rest edited', async () => {
    const dir = 'users/alice/crm'
    put(`${dir}/C001.md`, note('C001', '진행')); put(`${dir}/C002.md`, note('C002', '진행')); put(`${dir}/C003.md`, note('C003', '진행'))
    put(`${dir}/C035.md`, note('C035', '완료')); put(`${dir}/C099.md`, note('C099', '진행'))
    const paths = [`${dir}/C001.md`, `${dir}/C002.md`, `${dir}/C003.md`, `${dir}/C035.md`, `${dir}/C099.md`, 'users/bob/notes.md', `${dir}/C001.md`]
    const r = await ask(h, socks.alice!, 'alice', (await h.api('alice').call(API.createChat, { body: {} })).id, fake(
      read(`${dir}/C001.md`), read(`${dir}/C002.md`), read(`${dir}/C003.md`), read(`${dir}/C035.md`),
      editFiles(paths, 'status: 진행', 'status: 완료')))
    expect(r.done.status).toBe('done')
    const out = r.done.content
    expect(out).toStartWith('3 of 6 files edited. Each file was checked and saved on its own:')
    expect(out).toContain(`- ${dir}/C001.md: Edited ${dir}/C001.md (1 replacement)`)
    expect(out).toContain(`- ${dir}/C035.md: Error: old_string not found in the file`)
    expect(out).toContain(`- ${dir}/C099.md: Error: read '${dir}/C099.md' first (with read) before editing it`)
    expect(out).toMatch(/- users\/bob\/notes\.md: Access denied: /)
    // the duplicate path ran once
    expect(out.split(`- ${dir}/C001.md:`)).toHaveLength(2)
    for (const id of ['C001', 'C002', 'C003']) expect(text(`${dir}/${id}.md`)).toBe(note(id, '완료'))
    expect(text(`${dir}/C035.md`)).toBe(note('C035', '완료'))
    expect(text(`${dir}/C099.md`)).toBe(note('C099', '진행'))
    expect(text('users/bob/notes.md')).toContain('CANARY-BOB-4402')
    // only the front-matter line changed: "진행 상황" in the body stays (exact string, once per file)
    expect(text(`${dir}/C001.md`)).toContain('진행 상황: 견적 진행 중')
    // the history keeps each old version, like a separate edit
    for (const id of ['C001', 'C002', 'C003']) expect(versions(`${dir}/${id}.md`)).toBe(1)
    expect(versions(`${dir}/C099.md`)).toBe(0)
    // one step under the answer; the audit has the batch row and one edit row per file, all with the call's id
    const s = step(r.done.steps)
    expect(s).toMatchObject({ status: 'ok', label: `Edit files · ${dir}/C001.md +5` })
    const ev = events(r.started.turnId).filter((e) => e.tool === 'edit' || e.tool === EDIT_FILES_TOOL)
    expect(ev.map((e) => [e.tool, e.ok])).toEqual([['edit', 1], ['edit', 1], ['edit', 1], ['edit', 0], ['edit', 0], ['edit', 0], [EDIT_FILES_TOOL, 1]])
    expect(new Set(ev.map((e) => e.tool_use_id)).size).toBe(1)
    expect(ev.at(-1)!.summary).toBe(`${EDIT_FILES_TOOL} 6 files -> 3 edited, 3 not`)
    expect(ev[5]!.summary).toContain('denied')
    // the answer's file summary: three saved, bob's file rejected (as for an edit there)
    expect(r.done.files!.saved.map((x) => x.path).sort()).toEqual([`${dir}/C001.md`, `${dir}/C002.md`, `${dir}/C003.md`])
    expect(r.done.files!.rejected.map((x) => x.path)).toEqual(['users/bob/notes.md'])
  })

  test('every file failing is an error; bad input changes nothing; at most 50 files', async () => {
    const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
    const r = await ask(h, socks.alice!, 'alice', chat, fake(editFiles(['users/alice/todo.md', 'shared/glossary.md'], 'Draft', 'Final')))
    expect(r.done.content).toStartWith('0 of 2 files edited.')
    expect(step(r.done.steps).status).toBe('error')
    expect(events(r.started.turnId).find((e) => e.tool === EDIT_FILES_TOOL)).toMatchObject({ ok: 0 })
    expect(text('users/alice/todo.md')).toContain('Draft Q4')
    const many = Array.from({ length: EDIT_FILES_MAX + 1 }, (_, i) => `users/alice/many/${i}.md`)
    for (const args of [{ file_paths: many, old_string: 'a', new_string: 'b' }, { file_paths: [], old_string: 'a', new_string: 'b' },
      { file_paths: ['users/alice/todo.md'], old_string: '', new_string: 'b' }, { file_paths: ['users/alice/todo.md'], old_string: 'a', new_string: 'b', content: 'x' }]) {
      const bad = await ask(h, socks.alice!, 'alice', chat, fake(read('users/alice/todo.md'), { tool: EDIT_FILES_TOOL, args, sayResult: true }))
      expect(bad.done.content).toStartWith('Invalid input:')
      expect(events(bad.started.turnId).filter((e) => e.tool === 'edit')).toHaveLength(0)
      expect(events(bad.started.turnId).find((e) => e.tool === EDIT_FILES_TOOL)).toMatchObject({ summary: `${EDIT_FILES_TOOL} -> invalid input`, ok: 0 })
    }
    expect(text('users/alice/todo.md')).toContain('Draft Q4')
  })

  test('someone changed a file after the AI read it: a conflict copy for that file, the original stays', async () => {
    put('users/alice/conf/a.md', 'v: 1\n'); put('users/alice/conf/b.md', 'v: 1\n')
    const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
    // the reads, then b.md changes on the server, then the batch (the fake engine waits in between)
    const sent = await h.api('alice').call(API.sendMessage, { params: { id: chat }, body: { clientMessageId: cm(), attachmentIds: [], content: fake(
      read('users/alice/conf/a.md'), read('users/alice/conf/b.md'), { sleep: 1500 }, editFiles(['users/alice/conf/a.md', 'users/alice/conf/b.md'], 'v: 1', 'v: 2')) } })
    await socks.alice!.next('message.step', (f) => f.data.messageId === sent.assistantMessage.id && f.data.step.label?.includes('conf/b.md') && f.data.step.status === 'ok')
    put('users/alice/conf/b.md', 'v: 1\nby hand\n')
    const done = await socks.alice!.next('message.done', (f) => f.data.messageId === sent.assistantMessage.id, 30_000)
    expect(done.data.message.content).toContain('2 of 2 files edited.')
    expect(done.data.message.content).toMatch(/- users\/alice\/conf\/b\.md: Conflict: 'users\/alice\/conf\/b\.md' was changed/)
    expect(text('users/alice/conf/a.md')).toBe('v: 2\n')
    expect(text('users/alice/conf/b.md')).toBe('v: 1\nby hand\n')
    expect(done.data.message.files!.conflicts.map((c) => c.path)).toEqual(['users/alice/conf/b.md'])
  })

  test('saving where more people see it: the wider-audience card, once for the folder, as for separate edits', async () => {
    put('users/alice/private-plan.md', 'secret plan\n'); put('shared/bulk/x.md', 'owner: nobody\n'); put('shared/bulk/y.md', 'owner: nobody\n')
    const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
    const sent = await h.api('alice').call(API.sendMessage, { params: { id: chat }, body: { clientMessageId: cm(), attachmentIds: [], content: fake(
      read('users/alice/private-plan.md'), read('shared/bulk/x.md'), read('shared/bulk/y.md'), editFiles(['shared/bulk/x.md', 'shared/bulk/y.md'], 'owner: nobody', 'owner: alice')) } })
    const card = await socks.alice!.next('turn.request', (f) => f.data.turnId === sent.turnId)
    expect(asCard(card.data.request).origin).toBe('server')
    await h.api('alice').call(API.answerTurn, { params: { id: sent.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'save' } })
    const done = await socks.alice!.next('message.done', (f) => f.data.messageId === sent.assistantMessage.id, 30_000)
    expect(done.data.message.content).toStartWith('2 of 2 files edited.')
    expect(text('shared/bulk/x.md')).toBe('owner: alice\n')
    expect(text('shared/bulk/y.md')).toBe('owner: alice\n')
    expect(socks.alice!.frames.filter((f) => f.type === 'turn.request' && f.data.turnId === sent.turnId)).toHaveLength(1)
  })

  test('skills/: the server card for each file, as for separate edits; a declined one is not saved', async () => {
    put('skills/bulk-a.md', '# A\n- 표로 정리한다\n'); put('skills/bulk-b.md', '# B\n- 표로 정리한다\n')
    const chat = (await h.api('dana').call(API.createChat, { body: {} })).id
    const sent = await h.api('dana').call(API.sendMessage, { params: { id: chat }, body: { clientMessageId: cm(), attachmentIds: [], content: fake(
      read('skills/bulk-a.md'), read('skills/bulk-b.md'), editFiles(['skills/bulk-a.md', 'skills/bulk-b.md'], '- 표로 정리한다', '- 표와 그래프로 정리한다')) } })
    const first = await socks.dana!.next('turn.request', (f) => f.data.turnId === sent.turnId)
    expect(asCard(first.data.request).preview).toMatchObject({ kind: 'skill_write', path: 'skills/bulk-a.md' })
    await h.api('dana').call(API.answerTurn, { params: { id: sent.turnId }, body: { kind: 'ask_user', requestId: first.data.request.requestId, answer: 'save' } })
    const second = await socks.dana!.next('turn.request', (f) => f.data.turnId === sent.turnId && f.data.request.requestId !== first.data.request.requestId)
    expect(asCard(second.data.request).preview).toMatchObject({ kind: 'skill_write', path: 'skills/bulk-b.md' })
    await h.api('dana').call(API.answerTurn, { params: { id: sent.turnId }, body: { kind: 'ask_user', requestId: second.data.request.requestId, answer: 'skip' } })
    const done = await socks.dana!.next('message.done', (f) => f.data.messageId === sent.assistantMessage.id, 30_000)
    expect(done.data.message.content).toStartWith('1 of 2 files edited.')
    expect(done.data.message.content).toContain("- skills/bulk-b.md: The user did not allow saving 'skills/bulk-b.md' under skills/")
    expect(text('skills/bulk-a.md')).toContain('표와 그래프로')
    expect(text('skills/bulk-b.md')).toBe('# B\n- 표로 정리한다\n')
    expect(h.ctx.db.query("SELECT target FROM audit_log WHERE action = 'skills.ai_write_refused' ORDER BY id DESC LIMIT 1").get()).toEqual({ target: 'skills/bulk-b.md' })
  })

  test('a sub-agent\'s batch uses its own reads, and its audit rows name its sub-task', async () => {
    put('users/alice/sub/a.md', 'state: old\n'); put('users/alice/sub/b.md', 'state: old\n')
    const r = await ask(h, socks.alice!, 'alice', (await h.api('alice').call(API.createChat, { body: {} })).id, fake(
      read('users/alice/sub/a.md'),
      { agents: [{ id: 'toolu_EF1', type: 'general-purpose', description: 'Update states', steps: [read('users/alice/sub/b.md'), editFiles(['users/alice/sub/a.md', 'users/alice/sub/b.md'], 'state: old', 'state: new')] }] },
      { say: 'done' }))
    expect(r.done.content).toBe('done')
    // the main AI's read of a.md does not count for the child (review M3), b.md it read itself
    expect(text('users/alice/sub/a.md')).toBe('state: old\n')
    expect(text('users/alice/sub/b.md')).toBe('state: new\n')
    const child = events(r.started.turnId).filter((e) => e.tool === 'edit' || e.tool === EDIT_FILES_TOOL)
    expect(child.map((e) => [e.tool, e.ok, e.parent_tool_use_id])).toEqual([['edit', 0, 'toolu_EF1'], ['edit', 1, 'toolu_EF1'], [EDIT_FILES_TOOL, 1, 'toolu_EF1']])
    expect(r.done.steps.find((s) => s.tool === EDIT_FILES_TOOL)!.parentId).toBe('toolu_EF1')
  })

  test('confidential chats are not offered it, and a call there is refused at the gate', async () => {
    const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
    const open = await ask(h, socks.alice!, 'alice', chat, fake({ echo: 'tools' }))
    expect(open.done.content.split(',')).toContain(EDIT_FILES_TOOL)
    h.ctx.db.query('INSERT INTO safe_ops_chats (chat_id, material) VALUES (?, 1)').run(chat)
    const locked = await ask(h, socks.alice!, 'alice', chat, fake({ echo: 'tools' }))
    expect(locked.done.content.split(',')).not.toContain(EDIT_FILES_TOOL)
    expect(locked.done.content.split(',')).toContain('edit')
    put('users/alice/locked.md', 'a\n')
    const call = await ask(h, socks.alice!, 'alice', chat, fake(read('users/alice/locked.md'), editFiles(['users/alice/locked.md'], 'a', 'b')))
    expect(text('users/alice/locked.md')).toBe('a\n')
    expect(events(call.started.turnId).filter((e) => e.tool === 'edit')).toHaveLength(0)
  })
})

describe('edit_files in the MCP handler', () => {
  const ctxOf = (signal?: AbortSignal) => ({ user: h.ctx.files.principal('alice'), turnId: null, files: new TurnFiles(), ...(signal ? { signal } : {}) })
  const call = (handle: ReturnType<typeof makeHandler>, name: string, args: unknown) => handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  const said = (res: { result: { content: { text: string }[] } }) => res.result.content.map((c) => c.text).join('\n')

  test('not a file tool: without a chat turn\'s tool set it is neither listed nor run; the remote connector never has it', async () => {
    expect(Object.keys(FILE_TOOLS)).not.toContain(EDIT_FILES_TOOL)
    expect(Object.keys(OTHER_TOOLS)).toContain(EDIT_FILES_TOOL)
    const handle = makeHandler(h.ctx.files, h.ctx.db, ctxOf())
    const listed = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    expect(listed.result.tools.map((t: { name: string }) => t.name)).not.toContain(EDIT_FILES_TOOL)
    put('users/alice/plain.md', 'a\n')
    await call(handle, 'read', { file_path: 'users/alice/plain.md' })
    const res = await call(handle, EDIT_FILES_TOOL, { file_paths: ['users/alice/plain.md'], old_string: 'a', new_string: 'b' })
    expect(res.result.isError).toBe(true)
    expect(text('users/alice/plain.md')).toBe('a\n')
  })

  test('each file passes the turn\'s own check as an edit call (template scope, cards); Stop ends the batch before the next file', async () => {
    for (const n of ['p', 'q', 'r', 's']) put(`users/alice/gate/${n}.md`, 'x: 0\n')
    const seen: [string, unknown][] = []
    const abort = new AbortController()
    const extra: TurnToolSet = {
      list: () => [{ name: EDIT_FILES_TOOL, description: '', inputSchema: {} }],
      has: (n) => n === EDIT_FILES_TOOL,
      call: async () => ({ content: [{ type: 'text', text: 'must not run' }], isError: true, summary: 'x' }),
      beforeFileTool: async (name, args) => {
        seen.push([name, args])
        if (name !== 'edit') return null
        const p = (args as { file_path: string }).file_path
        if (p.endsWith('q.md')) return { refusal: 'This scheduled template only reads its approved folder.', summary: 'scheduled template scope refused' }
        if (p.endsWith('r.md')) abort.abort()
        return null
      },
    }
    const handle = makeHandler(h.ctx.files, h.ctx.db, ctxOf(abort.signal), extra)
    for (const n of ['p', 'q', 'r', 's']) await call(handle, 'read', { file_path: `users/alice/gate/${n}.md` })
    const paths = ['p', 'q', 'r', 's'].map((n) => `users/alice/gate/${n}.md`)
    const res = await call(handle, EDIT_FILES_TOOL, { file_paths: paths, old_string: 'x: 0', new_string: 'x: 1', replace_all: true })
    expect(seen.filter(([n]) => n === 'edit').map(([, a]) => a)).toEqual(paths.slice(0, 3).map((file_path) => ({ file_path, old_string: 'x: 0', new_string: 'x: 1', replace_all: true })))
    expect(said(res)).toContain('2 of 4 files edited.')
    expect(said(res)).toContain('- users/alice/gate/q.md: This scheduled template only reads its approved folder.')
    expect(said(res)).toContain('- users/alice/gate/s.md: not changed (the answer was stopped)')
    expect(['p', 'q', 'r', 's'].map((n) => text(`users/alice/gate/${n}.md`))).toEqual(['x: 1\n', 'x: 0\n', 'x: 1\n', 'x: 0\n'])
  })

  test('the step label and the instructions', () => {
    const paths = ['work/crm/notes/C001.md', 'work/crm/notes/C002.md', 'work/crm/notes/C003.md']
    expect(stepLabel(EDIT_FILES_TOOL, { file_paths: paths }, 'ko', new Set())).toBe('여러 파일 수정 · work/crm/notes/C001.md +2')
    expect(stepLabel(EDIT_FILES_TOOL, { file_paths: paths.slice(0, 1) }, 'en', new Set())).toBe('Edit files · work/crm/notes/C001.md')
    expect(stepLabel(EDIT_FILES_TOOL, {}, 'ja', new Set())).toBe('複数のファイルを編集')
    const input = { user: h.ctx.files.principal('alice'), groupNames: [], locale: 'en' as const, timeZone: 'UTC', memories: [], project: null, browser: false, history: null }
    const withTool = buildTurnPrompt(h.ctx.files, { ...input, tools: [EDIT_FILES_TOOL] })
    expect(withTool).toContain('then change them all with one edit_files call')
    expect(withTool).toContain(BULK_REPORT_RULE)
    const without = buildTurnPrompt(h.ctx.files, { ...input, tools: [] })
    expect(without).not.toContain('edit_files')
    expect(without).toContain(BULK_REPORT_RULE)
  })
})
