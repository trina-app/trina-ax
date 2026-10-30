// Sub-agents end to end (A5 stage 1, docs/DECISIONS.md "Sub-agents") with the fake engine through the real launcher,
// gate and bridge: a child's calls run as the same person with the same checks and audit rows, under its sub-task step;
// its text never reaches the answer; each child has its own read-before-write state (review M3); the per-answer limits
// and Stop work with children running; the init lockdown check stops a turn that starts with more tools.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, CHAT_ERROR_MESSAGES, type Step } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { SUBTASK_STEPS_KEPT } from '../../server/src/chat/subagents'

setDefaultTimeout(40_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const read = (file_path: string, extra: Record<string, unknown> = {}) => ({ tool: 'read', args: { file_path }, ...extra })
const write = (file_path: string, content: string) => ({ tool: 'write', args: { file_path, content } })

let h: Harness
let alice: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'b-subagents', askUserTimeoutMs: 3000, turnTimeoutMs: 60_000 })
  alice = await h.ws('alice', { windowId: 'win-alice-sub' })
  await alice.next('hello')
})
afterAll(async () => { alice?.close(); await h.close() })

const newChat = async (user = 'alice') => h.api(user).call(API.createChat, { body: {} })
const events = (turnId: string) => h.ctx.db.query("SELECT tool, summary, ok, user_id, tool_use_id, parent_tool_use_id FROM tool_events WHERE turn_id = ? AND tool <> '(connect)' ORDER BY id").all(turnId) as { tool: string; summary: string; ok: number; user_id: string; tool_use_id: string | null; parent_tool_use_id: string | null }[]
const byId = (steps: Step[], id: string) => steps.find((s) => s.id === id)

describe('sub-tasks under the answer', () => {
  test('parallel children: steps under their sub-task, totals, audit rows; child text never in the answer', async () => {
    const chat = await newChat()
    const r = await ask(h, alice, 'alice', chat.id, fake(
      { say: 'Splitting the work.' },
      { agents: [
        { id: 'toolu_A1', type: 'Explore', description: 'Read the meetings', steps: [{ say: 'CHILD-TEXT-LEAK' }, { thinking: 'CHILD-THINK-LEAK' }, read('shared/glossary.md'), read('shared/policies/remote-work-v2.md')] },
        { id: 'toolu_B1', type: 'general-purpose', description: 'Draft the summary', steps: [{ refuse: true }, { apiError: true }, write('users/alice/sub-summary.md', '# Summary\n')] },
      ] },
      { say: 'All done.' }))
    expect(r.done.status).toBe('done')
    expect(r.done.error).toBeNull()
    expect(r.done.content).toBe('Splitting the work.\n\nAll done.')
    expect(r.done.content).not.toContain('LEAK')
    const steps = r.done.steps
    expect(byId(steps, 'toolu_A1')).toMatchObject({ kind: 'tool', tool: 'agent', label: 'Sub-task: Read the meetings', status: 'ok', subtask: { toolUses: 2 } })
    expect(byId(steps, 'toolu_B1')).toMatchObject({ tool: 'agent', label: 'Sub-task: Draft the summary', status: 'ok', subtask: { toolUses: 1 } })
    expect(typeof byId(steps, 'toolu_A1')!.subtask!.ms).toBe('number')
    const children = steps.filter((s) => s.parentId)
    expect(children.map((s) => [s.tool, s.parentId, s.status])).toEqual(expect.arrayContaining([['read', 'toolu_A1', 'ok'], ['read', 'toolu_A1', 'ok'], ['write', 'toolu_B1', 'ok']]))
    expect(children).toHaveLength(3)
    expect(children.find((s) => s.tool === 'write')!.label).toBe('Save · users/alice/sub-summary.md')
    expect(steps.filter((s) => !s.parentId && s.kind === 'thinking')).toHaveLength(0)
    expect(fs.readFileSync(path.join(h.team, 'users/alice/sub-summary.md'), 'utf8')).toBe('# Summary\n')
    // audit: the sub-task's start and end rows, each child call as alice in this turn, tied to its sub-task
    const ev = events(r.started.turnId)
    expect(ev.filter((e) => e.tool === 'agent').map((e) => [e.summary.replace(/ \(.*\)$/, ''), e.tool_use_id])).toEqual(expect.arrayContaining([
      ['agent Explore started: "Read the meetings"', 'toolu_A1'], ['agent general-purpose started: "Draft the summary"', 'toolu_B1'],
      ['agent Explore done: "Read the meetings"', 'toolu_A1'], ['agent general-purpose done: "Draft the summary"', 'toolu_B1']]))
    const calls = ev.filter((e) => e.tool !== 'agent')
    expect(calls.map((e) => [e.tool, e.parent_tool_use_id, e.user_id, e.ok])).toEqual(expect.arrayContaining([['read', 'toolu_A1', 'alice', 1], ['read', 'toolu_A1', 'alice', 1], ['write', 'toolu_B1', 'alice', 1]]))
    for (const c of calls) expect(c.tool_use_id).toMatch(/^toolu_/)
    // measured per answer (no limit yet, review M6)
    expect(h.ctx.db.query('SELECT subagents, subagent_tool_uses, subagent_tokens FROM turns WHERE id = ?').get(r.started.turnId)).toEqual({ subagents: 2, subagent_tool_uses: 3, subagent_tokens: 400 })
    // the main AI's own calls: no sub-task
    const main = await ask(h, alice, 'alice', chat.id, fake(read('users/alice/todo.md'), { say: 'ok' }))
    expect(events(main.started.turnId).find((e) => e.tool === 'read')).toMatchObject({ parent_tool_use_id: null })
  })

  test('a failed child: its sub-task is an error step, the answer goes on; the turn is not a refusal or an error', async () => {
    const chat = await newChat()
    const r = await ask(h, alice, 'alice', chat.id, fake({ agents: [{ id: 'toolu_F1', description: 'Will fail', fail: '529 overloaded', steps: [read('shared/glossary.md'), { refuse: true }] }] }, { say: 'The helper failed; here is what I know.' }))
    expect(r.done).toMatchObject({ status: 'done', error: null, content: 'The helper failed; here is what I know.' })
    expect(byId(r.done.steps, 'toolu_F1')).toMatchObject({ tool: 'agent', status: 'error' })
    expect(r.done.steps.some((s) => s.tool === 'refusal')).toBe(false) // no refusal retry for a child's refusal (M2)
    expect(events(r.started.turnId).find((e) => e.tool === 'agent' && e.ok === 0)?.summary).toContain('agent general-purpose failed: "Will fail"')
  })

  test('the definitions and the sub-agents\' instructions reach the engine; no memories or history in them', async () => {
    h.ctx.db.query("INSERT INTO memories (id, user_id, text, source, created_at) VALUES ('m-sub', 'alice', 'MEMORY-NOT-FOR-CHILDREN', 'user', ?)").run(new Date().toISOString())
    try {
      const chat = await newChat()
      const r = await ask(h, alice, 'alice', chat.id, fake({ echo: 'agents' }, { say: '\n----\n' }, { echo: 'subagentPrompt' }, { say: '\n----\n' }, { echo: 'args' }, { say: '\n----\n' }, { echo: 'system' }))
      const [agentsJson, childPrompt, argsJson, system] = r.done.content.split('\n----\n')
      const defs = JSON.parse(agentsJson!)
      expect(Object.keys(defs).sort()).toEqual(['Explore', 'general-purpose'])
      expect(defs['general-purpose'].tools).toContain('mcp__team__write')
      expect(defs['general-purpose'].tools).not.toContain('mcp__team__ask_user')
      expect(defs['general-purpose'].tools).not.toContain('mcp__team__remember')
      expect(defs.Explore.tools).not.toContain('mcp__team__write')
      expect(childPrompt).toContain('Rules from the team server for sub-agents')
      expect(childPrompt).toContain('Personal folder: users/alice')
      expect(childPrompt).not.toContain('MEMORY-NOT-FOR-CHILDREN')
      expect(childPrompt).not.toContain('previous_conversation')
      const args = JSON.parse(argsJson!) as string[]
      expect(args[args.indexOf('--tools') + 1]).toBe('WebSearch,Agent')
      expect(args).toContain('--restricted')
      expect(args[args.indexOf('--agents') + 1]).toBe('./.turn/agents.json')
      // the main AI is told how to use them
      expect(system).toContain('At most 4 run at the same time')
      expect(system).toContain('MEMORY-NOT-FOR-CHILDREN')
    } finally { h.ctx.db.query("DELETE FROM memories WHERE id = 'm-sub'").run() }
  })

  test('the admin switch off: no Agent tool, no definitions, no rule in the instructions', async () => {
    h.ctx.db.query("INSERT INTO settings (key, value) VALUES ('aiSubagents', 'false') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run()
    try {
      const chat = await newChat()
      const r = await ask(h, alice, 'alice', chat.id, fake({ echo: 'args' }, { say: '\n----\n' }, { echo: 'agents' }, { say: '\n----\n' }, { echo: 'system' }))
      const [argsJson, agents, system] = r.done.content.split('\n----\n')
      const args = JSON.parse(argsJson!) as string[]
      expect(args[args.indexOf('--tools') + 1]).toBe('WebSearch')
      expect(args[args.indexOf('--disallowedTools') + 1]!.split(',')).toContain('Agent')
      expect(args).not.toContain('--agents')
      expect(agents).toBe('(no --agents)')
      expect(system).not.toContain('Agent tool')
    } finally { h.ctx.db.query("DELETE FROM settings WHERE key = 'aiSubagents'").run() }
  })
})

describe('the same person, the same checks', () => {
  test('a child cannot read what the person cannot; another person\'s child can (each its own access)', async () => {
    const a = await ask(h, alice, 'alice', (await newChat()).id, fake({ agents: [{ id: 'toolu_D1', steps: [read('groups/finance/budget.md')] }] }, { say: 'done' }))
    const denied = events(a.started.turnId).find((e) => e.tool === 'read')!
    expect(denied).toMatchObject({ user_id: 'alice', ok: 0, parent_tool_use_id: 'toolu_D1' })
    expect(denied.summary).toContain('denied')
    expect(byId(a.done.steps, 'toolu_D1')!.status).toBe('ok')
    expect(a.done.steps.find((s) => s.parentId === 'toolu_D1')!.status).toBe('error')
    const bob = await h.ws('bob', { windowId: 'win-bob-sub' })
    await bob.next('hello')
    try {
      const b = await ask(h, bob, 'bob', (await newChat('bob')).id, fake({ agents: [{ id: 'toolu_D2', steps: [read('groups/finance/budget.md')] }] }, { say: 'done' }))
      expect(events(b.started.turnId).find((e) => e.tool === 'read')).toMatchObject({ user_id: 'bob', ok: 1, parent_tool_use_id: 'toolu_D2' })
    } finally { bob.close() }
  })

  test('access taken away while a child works applies from its next call', async () => {
    const chat = await newChat()
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ agents: [{ id: 'toolu_R1', steps: [read('groups/marketing/campaign-brief.md'), { sleep: 1500 }, read('groups/marketing/campaign-brief.md')] }] }, { say: 'done' }), clientMessageId: cm(), attachmentIds: [] } })
    await waitFor(() => events(r.turnId).some((e) => e.tool === 'read'), { timeoutMs: 10_000 })
    h.ctx.db.query("DELETE FROM group_members WHERE group_id = 'marketing' AND user_id = 'alice'").run()
    try {
      await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
      expect(events(r.turnId).filter((e) => e.tool === 'read').map((e) => e.ok)).toEqual([1, 0])
    } finally { h.ctx.db.query("INSERT INTO group_members VALUES ('marketing', 'alice')").run() }
  })

  test('a child\'s save to a wider folder asks the person (the same card); declined, nothing is saved', async () => {
    const chat = await newChat()
    const target = `shared/sub-wider-${Date.now()}.md`
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ agents: [{ id: 'toolu_W1', steps: [read('groups/marketing/campaign-brief.md'), write(target, 'brief copy')] }] }, { say: 'done' }), clientMessageId: cm(), attachmentIds: [] } })
    const card = await alice.next('turn.request', (f) => f.data.turnId === r.turnId, 15_000)
    expect(card.data.request.kind).toBe('ask_user')
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'skip' } })
    await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    expect(fs.existsSync(path.join(h.team, target))).toBe(false)
    expect(events(r.turnId).find((e) => e.tool === 'write')).toMatchObject({ ok: 0, parent_tool_use_id: 'toolu_W1' })
    expect(events(r.turnId).find((e) => e.tool === 'write')!.summary).toContain('not allowed by the user')
  })

  test('confidential chat: a child gets no web tools (refused at the gate), like the main AI', async () => {
    const chat = await newChat()
    h.ctx.db.query('INSERT OR IGNORE INTO safe_ops_chats (chat_id) VALUES (?)').run(chat.id)
    const r = await ask(h, alice, 'alice', chat.id, fake({ echo: 'args' }, { agents: [{ id: 'toolu_C1', steps: [{ tool: 'web_fetch', args: { url: 'https://example.com/' } }] }] }))
    const args = JSON.parse(r.done.content) as string[]
    expect(args[args.indexOf('--tools') + 1]).toBe('Agent')
    expect(r.done.steps.find((s) => s.parentId === 'toolu_C1')!.status).toBe('error')
  })

  test('outside content a child read taints the chat: the main AI\'s remember then needs the person\'s OK', async () => {
    const chat = await newChat()
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ agents: [{ id: 'toolu_T1', steps: [read('shared/glossary.md')] }] }, { tool: 'remember', args: { text: 'Likes glossaries' }, sayResult: true }), clientMessageId: cm(), attachmentIds: [] } })
    const card = await alice.next('turn.request', (f) => f.data.turnId === r.turnId, 15_000)
    expect(card.data.request).toMatchObject({ kind: 'ask_user', question: expect.stringContaining('Likes glossaries') })
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'no' } })
    const done = await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    expect(done.data.message.content).toContain('did not confirm')
  })
})

describe('each sub-agent reads before it writes (review M3)', () => {
  test('two children read the same file: the second write becomes a conflict copy, not a silent overwrite', async () => {
    const file = `shared/sub-race-${Date.now()}.md`
    fs.writeFileSync(path.join(h.team, file), 'v0\n')
    const r = await ask(h, alice, 'alice', (await newChat()).id, fake({ agents: [
      { id: 'toolu_S1', steps: [read(file), write(file, 'from A\n')] },
      { id: 'toolu_S2', steps: [read(file), { sleep: 800 }, write(file, 'from B\n')] },
    ] }, { say: 'done' }))
    expect(fs.readFileSync(path.join(h.team, file), 'utf8')).toBe('from A\n')
    expect(r.done.files?.conflicts.map((c) => c.path)).toEqual([file])
    const copy = r.done.files!.conflicts[0]!.copyPath
    expect(fs.readFileSync(path.join(h.team, copy), 'utf8')).toBe('from B\n')
  })

  test('a child cannot overwrite a file only its sibling or the main AI read; its own read counts, even when the stream line comes late', async () => {
    const file = `shared/sub-own-${Date.now()}.md`
    fs.writeFileSync(path.join(h.team, file), 'v0\n')
    const r = await ask(h, alice, 'alice', (await newChat()).id, fake(
      read(file),
      { agents: [
        { id: 'toolu_O1', steps: [read(file, { lateLine: 400 })] },
        { id: 'toolu_O2', steps: [{ sleep: 900 }, write(file, 'from O2\n')] },
      ] },
      { agents: [{ id: 'toolu_O3', steps: [read(file), { tool: 'edit', args: { file_path: file, old_string: 'v0', new_string: 'v1' }, lateLine: 300 }] }] },
      { say: 'done' }))
    const ev = events(r.started.turnId)
    const o2 = ev.find((e) => e.tool === 'write' && e.parent_tool_use_id === 'toolu_O2')!
    expect(o2.ok).toBe(0)
    expect(o2.summary).toContain('read')
    expect(ev.find((e) => e.tool === 'read' && e.parent_tool_use_id === 'toolu_O1')?.ok).toBe(1)
    expect(ev.find((e) => e.tool === 'edit' && e.parent_tool_use_id === 'toolu_O3')?.ok).toBe(1)
    expect(fs.readFileSync(path.join(h.team, file), 'utf8')).toBe('v1\n')
  })

  test('a child call that comes before the server has read any Agent line still is not the main AI\'s', async () => {
    // the turn offers sub-agents: from the start, a call waits for its stream line instead of passing as the main AI's
    const file = `shared/sub-early-${Date.now()}.md`
    fs.writeFileSync(path.join(h.team, file), 'v0\n')
    const r = await ask(h, alice, 'alice', (await newChat()).id, fake(
      read(file),
      { agents: [{ id: 'toolu_E1', steps: [{ ...write(file, 'child\n'), lateLine: 300 }] }], lateAgentLine: 1200 },
      { say: 'done' }))
    const w = events(r.started.turnId).find((e) => e.tool === 'write')!
    expect(w).toMatchObject({ ok: 0, parent_tool_use_id: 'toolu_E1' })
    expect(fs.readFileSync(path.join(h.team, file), 'utf8')).toBe('v0\n')
  })

  test('the main AI after its children: it reads again before changing what a child wrote', async () => {
    const file = `shared/sub-main-${Date.now()}.md`
    fs.writeFileSync(path.join(h.team, file), 'v0\n')
    const r = await ask(h, alice, 'alice', (await newChat()).id, fake(
      read(file),
      { agents: [{ id: 'toolu_M1', steps: [read(file), write(file, 'child\n')] }] },
      write(file, 'main\n'),
      { say: 'done' }))
    // the main AI's read was before the child's write: its save is a conflict copy, the child's text stays
    expect(fs.readFileSync(path.join(h.team, file), 'utf8')).toBe('child\n')
    expect(r.done.files?.conflicts.map((c) => c.path)).toEqual([file])
  })
})

describe('limits, stop and the lockdown check', () => {
  test('a child\'s rounds do not count against the per-answer tool-round limit', async () => {
    const rt = h.rt() as unknown as { maxEngineTurns: number }
    const saved = rt.maxEngineTurns
    rt.maxEngineTurns = 2
    try {
      const steps = Array.from({ length: 5 }, () => read('users/alice/todo.md'))
      const r = await ask(h, alice, 'alice', (await newChat()).id, fake({ agents: [{ id: 'toolu_L1', steps }] }, { say: 'done' }))
      expect(r.done).toMatchObject({ status: 'done', content: 'done' })
      expect(r.done.stopReason).toBeUndefined()
      const over = await ask(h, alice, 'alice', (await newChat()).id, fake({ agents: [{ id: 'toolu_L2', steps: [read('users/alice/todo.md')] }] }, read('users/alice/todo.md'), read('users/alice/todo.md'), { say: 'never' }))
      expect(over.done.stopReason).toBe('tool_limit')
    } finally { rt.maxEngineTurns = saved }
  })

  test('the time limit while children work: the answer pauses (continue), the cut sub-tasks are audited', async () => {
    const rt = h.rt() as unknown as { turnTimeoutMs: number }
    const saved = rt.turnTimeoutMs
    rt.turnTimeoutMs = 2000
    try {
      const chat = await newChat()
      const r = await ask(h, alice, 'alice', chat.id, fake({ say: 'Working.' }, { agents: [{ id: 'toolu_P1', steps: [read('users/alice/todo.md'), { sleep: 20000 }] }, { id: 'toolu_P2', steps: [{ sleep: 20000 }] }] }), { ms: 25_000 })
      expect(r.done).toMatchObject({ status: 'done', error: null, stopReason: 'time_limit' })
      expect(events(r.started.turnId).filter((e) => e.tool === 'agent' && e.ok === 0).map((e) => e.tool_use_id).sort()).toEqual(['toolu_P1', 'toolu_P2'])
      expect(events(r.started.turnId).find((e) => e.tool === 'agent' && e.ok === 0)!.summary).toContain('stopped with the answer')
      const next = await ask(h, alice, 'alice', chat.id, fake({ echo: 'message' }))
      expect(next.done.content).toContain('Sub-agents that were still working')
    } finally { rt.turnTimeoutMs = saved }
  })

  test('Stop while a child waits: stopped, the gate takes no more of its calls', async () => {
    const chat = await newChat()
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ say: 'go' }, { agents: [{ id: 'toolu_X1', steps: [read('users/alice/todo.md'), { sleep: 2500 }, read('users/alice/todo.md')] }] }), clientMessageId: cm(), attachmentIds: [] } })
    await waitFor(() => events(r.turnId).some((e) => e.tool === 'read'), { timeoutMs: 10_000 })
    await h.api('alice').call(API.stop, { params: { id: chat.id } })
    const done = await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    expect(done.data.status).toBe('stopped')
    await Bun.sleep(3000)
    expect(events(r.turnId).filter((e) => e.tool === 'read')).toHaveLength(1)
  })

  test('an engine that starts with a built-in tool or another definition: the answer stops with the lockdown error, no tool runs', async () => {
    for (const init of [{ tools: ['Glob', 'mcp__team__read'] }, { tools: ['Task'], agents: ['general-purpose', 'Explore', 'trap'] }]) {
      const r = await ask(h, alice, 'alice', (await newChat()).id, fake({ init }, { sleep: 500 }, read('users/alice/todo.md'), { say: 'never' }))
      expect(r.done.status).toBe('error')
      expect(r.done.error).toMatchObject({ code: 'engine_unavailable', params: { reason: 'lockdown' }, message: CHAT_ERROR_MESSAGES.lockdown.en })
      expect(events(r.started.turnId)).toHaveLength(0)
      expect(r.done.content).not.toContain('never')
    }
    expect((h.ctx.db.query("SELECT count(*) AS n FROM audit_log WHERE action = 'engine.lockdown'").get() as { n: number }).n).toBeGreaterThanOrEqual(2)
  })

  test('a long sub-task keeps its most recent steps with the answer and counts the others', async () => {
    const steps = Array.from({ length: SUBTASK_STEPS_KEPT + 5 }, () => read('users/alice/todo.md'))
    const r = await ask(h, alice, 'alice', (await newChat()).id, fake({ agents: [{ id: 'toolu_K1', steps }] }, { say: 'done' }), { ms: 40_000 })
    const kept = r.done.steps.filter((s) => s.parentId === 'toolu_K1')
    expect(kept).toHaveLength(SUBTASK_STEPS_KEPT)
    expect(byId(r.done.steps, 'toolu_K1')!.subtask).toMatchObject({ toolUses: SUBTASK_STEPS_KEPT + 5, hidden: 5 })
  })
})
