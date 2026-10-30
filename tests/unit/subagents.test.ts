// Sub-agents (A5 stage 1, docs/DECISIONS.md "Sub-agents"): the locked launch of Claude Code with the Agent tool, the
// definitions and instructions the children get, the stream parser's routing of child messages (review M2), the init
// lockdown check, the model proxy's tool-name check (M1) and the per-agent read state (M3).
import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { FILE_TOOLS, SUBAGENT_TYPES } from '@mycel/shared'
import { buildClaudeLaunch, CLAUDE_BUILTIN_DENIED, CLAUDE_LOCK_ENV, launcherLiteral, MAX_CONCURRENT_SUBAGENTS } from '../../server/src/engine/claude'
import { ClaudeStreamParser } from '../../server/src/engine/claude-parse'
import { buildAgentDefinitions, EXPLORE_TOOLS, initProblem, MAX_SUBAGENT_TURNS, PARENT_ONLY_TOOLS, SCHEDULE_TOOLS, subtaskSummary } from '../../server/src/chat/subagents'
import { SCHEDULE_TOOL_NAMES } from '../../server/src/tools/schedules'
import { checkToolNames, toolPolicyOf } from '../../server/src/proxy/model-proxy'
import { TurnFiles } from '../../server/src/files/service'
import { continuationBlock } from '../../server/src/chat/prompt'
import { BROWSER_TOOL_NAMES } from '../../server/src/realtime/browser-tools'
import { WORK } from '../lib/env'

const L = (o: unknown) => JSON.stringify(o)
const chatDir = path.join(WORK, 'unit-subagents', 'agent', 'c1')
const base = { turnId: 't', chatDir, token: 'tok', systemPrompt: 'sys', message: 'hi', sessionId: '11111111-1111-4111-8111-111111111111', resume: false, stash: null, maxTurns: 50, timeoutMs: 1000 }
const conf = { bin: '/x/claude', authMode: 'managed' as const, agentHome: '/nonexistent', modelProxy: { baseUrl: 'http://127.0.0.1:9' } }
const val = (a: string[], f: string) => a[a.indexOf(f) + 1]!
/** Claude Code's built-in tools that run commands or touch files outside our gate: never a child's, never the main AI's */
const BUILTIN_FILE_AND_SHELL = ['Read', 'Glob', 'Grep', 'Bash', 'PowerShell', 'Edit', 'Write', 'WebFetch', 'NotebookEdit', 'LSP', 'Skill', 'ToolSearch']
const turnTools = [...Object.keys(FILE_TOOLS), 'search', 'make_file', 'share_file', 'artifact', 'web_fetch', 'move_files', 'remember', 'forget', 'ask_user', 'set_title', 'schedule_create', 'schedule_list', 'schedule_delete', 'generate_video', 'navigate', 'computer', 'my_aipm_list']

describe('locked launch with the Agent tool', () => {
  const sub = { agents: buildAgentDefinitions({ tools: turnTools, webSearch: true }), prompt: 'CHILD RULES {CHAT_DIR}' }
  test('the Agent tool next to WebSearch; built-ins, the fork and nothing else denied; definitions and instructions as turn files', () => {
    const r = buildClaudeLaunch({ ...base, extraTools: ['make_file'], subagents: sub }, conf)
    expect(val(r.args, '--tools')).toBe('WebSearch,Agent')
    expect(val(r.args, '--allowedTools').split(',')).toContain('Agent')
    const denied = val(r.args, '--disallowedTools').split(',')
    for (const t of [...BUILTIN_FILE_AND_SHELL, 'AskUserQuestion', 'Agent(fork)', 'EnterWorktree', 'SendMessage', 'TaskOutput', 'Monitor']) expect(denied).toContain(t)
    expect(denied).not.toContain('Agent')
    expect(denied).not.toContain('WebSearch')
    expect(r.args).toContain('--restricted')
    expect(val(r.args, '--agents')).toBe('{TURN_DIR}/agents.json')
    expect(val(r.args, '--append-subagent-system-prompt-file')).toBe('{TURN_DIR}/subagent.md')
    expect(r.args).not.toContain('--forward-subagent-text')
    const files = Object.fromEntries((r.files ?? []).map((f) => [f.rel, f.content]))
    expect(Object.keys(files).sort()).toEqual(['.turn/agents.json', '.turn/subagent.md'])
    expect(Object.keys(JSON.parse(files['.turn/agents.json']!)).sort()).toEqual([...SUBAGENT_TYPES].sort())
    // the launcher fills {CHAT_DIR} into file contents: text from the team keeps it as written
    expect(files['.turn/subagent.md']).not.toContain('{CHAT_DIR}')
    expect(files['.turn/subagent.md']).toContain('CHAT_DIR')
    expect(r.env).toMatchObject({ CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1', CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(MAX_CONCURRENT_SUBAGENTS), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' })
    expect(MAX_CONCURRENT_SUBAGENTS).toBe(4)
    expect(r.env.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT).toBeUndefined()
  })
  test('without sub-agents: the same lockdown, the Agent tool denied, no definitions', () => {
    const r = buildClaudeLaunch(base, conf)
    expect(val(r.args, '--tools')).toBe('WebSearch')
    expect(val(r.args, '--allowedTools').split(',')).not.toContain('Agent')
    expect(val(r.args, '--disallowedTools').split(',')).toContain('Agent')
    expect(r.args).toContain('--restricted')
    expect(r.args).not.toContain('--agents')
    expect(r.files).toBeUndefined()
    // the sub-agent switches are on every turn (a fork or a built-in definition never appears)
    expect(r.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS).toBe('1')
    expect(r.env.CLAUDE_CODE_FORK_SUBAGENT).toBe('0')
  })
  test('no web search (confidential chat, approved template): only the Agent tool, WebSearch denied', () => {
    const r = buildClaudeLaunch({ ...base, webSearch: false, subagents: { agents: buildAgentDefinitions({ tools: turnTools, webSearch: false }), prompt: 'x' } }, conf)
    expect(val(r.args, '--tools')).toBe('Agent')
    expect(val(r.args, '--disallowedTools').split(',')).toContain('WebSearch')
    expect(val(r.args, '--allowedTools').split(',')).not.toContain('WebSearch')
    const defs = JSON.parse(r.files!.find((f) => f.rel === '.turn/agents.json')!.content)
    for (const d of Object.values(defs) as { tools: string[] }[]) expect(d.tools).not.toContain('WebSearch')
  })
  test('every denied name is a Claude Code tool name (no typo leaves one open)', () => {
    for (const t of CLAUDE_BUILTIN_DENIED) expect(t).toMatch(/^[A-Z][A-Za-z]+(\(fork\))?$/)
    expect(new Set(CLAUDE_BUILTIN_DENIED).size).toBe(CLAUDE_BUILTIN_DENIED.length)
    expect(CLAUDE_LOCK_ENV.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1')
  })
  test('launcherLiteral keeps the launcher\'s placeholders as text', () => {
    expect(launcherLiteral('a {TURN_DIR} b {CHAT_DIR} {OTHER}')).not.toMatch(/\{(TURN_DIR|CHAT_DIR)\}/)
    expect(launcherLiteral('a {OTHER}')).toBe('a {OTHER}')
  })
})

describe('sub-agent definitions', () => {
  test('our tools by exact name only: no built-in file or shell tool, no tool of the main AI only', () => {
    const d = buildAgentDefinitions({ tools: turnTools, webSearch: true })
    for (const def of Object.values(d)) {
      for (const t of def.tools) expect(t === 'WebSearch' || t.startsWith('mcp__team__')).toBe(true)
      for (const t of BUILTIN_FILE_AND_SHELL) expect(def.tools).not.toContain(t)
      for (const t of PARENT_ONLY_TOOLS) expect(def.tools).not.toContain('mcp__team__' + t)
      expect(def.disallowedTools).toContain('Agent')
      expect(def.model).toBe('inherit')
      expect(def.maxTurns).toBe(MAX_SUBAGENT_TURNS)
      expect(def.omitClaudeMd).toBe(true)
      for (const k of ['permissionMode', 'mcpServers', 'hooks', 'skills', 'memory', 'isolation', 'background']) expect(k in def).toBe(false)
    }
    expect(MAX_SUBAGENT_TURNS).toBe(50)
    // general-purpose: every tool of the turn except the main AI's own (writes included, like Claude Code)
    expect(d['general-purpose'].tools).toEqual([...Object.keys(FILE_TOOLS), 'search', 'make_file', 'share_file', 'artifact', 'web_fetch', 'move_files', 'my_aipm_list'].map((t) => 'mcp__team__' + t).concat('WebSearch'))
    // Explore: read-only
    expect(d.Explore.tools).toEqual(['list', 'glob', 'grep', 'read', 'search', 'web_fetch'].map((t) => 'mcp__team__' + t).concat('WebSearch'))
    for (const t of d.Explore.tools) expect(t === 'WebSearch' || EXPLORE_TOOLS.has(t.slice('mcp__team__'.length))).toBe(true)
    expect(d.Explore.tools).not.toContain('mcp__team__write')
  })
  test('the main AI\'s own tools: asking, memories, title, schedules, video, the browser', () => {
    for (const t of ['ask_user', 'set_title', 'remember', 'forget', 'generate_video', ...SCHEDULE_TOOL_NAMES, ...BROWSER_TOOL_NAMES]) expect(PARENT_ONLY_TOOLS.has(t)).toBe(true)
    expect([...SCHEDULE_TOOLS]).toEqual([...SCHEDULE_TOOL_NAMES])
    for (const t of ['read', 'write', 'edit', 'make_file', 'web_fetch', 'artifact', 'share_file']) expect(PARENT_ONLY_TOOLS.has(t)).toBe(false)
  })
  test('no WebSearch for a child of a turn without it', () => {
    for (const def of Object.values(buildAgentDefinitions({ tools: turnTools, webSearch: false }))) expect(def.tools).not.toContain('WebSearch')
  })
  test('audit summaries never hold the prompt; long descriptions are cut', () => {
    expect(subtaskSummary({ type: 'Explore', description: 'Compare\ncontracts' })).toBe('agent Explore started: "Compare contracts"')
    expect(subtaskSummary({ type: 'general-purpose', description: 'x', end: { ok: true, toolUses: 12, ms: 80_400 } })).toBe('agent general-purpose done: "x" (12 tool uses, 80 s)')
    expect(subtaskSummary({ type: 'general-purpose', description: 'x', end: { ok: false } })).toBe('agent general-purpose failed: "x"')
    expect(subtaskSummary({ type: 'general-purpose', description: 'y'.repeat(300) }).length).toBeLessThan(140)
  })
})

describe('init lockdown check', () => {
  const tools = ['mcp__team__read', 'mcp__team__write', 'WebSearch', 'Task']
  test('2.1.305 lists the Agent tool as Task; our two definitions only', () => {
    expect(initProblem({ tools, agents: ['Explore', 'general-purpose'] }, { webSearch: true, subagents: true })).toBeNull()
    expect(initProblem({ tools: [...tools.slice(0, 3), 'Agent'], agents: [] }, { webSearch: true, subagents: true })).toBeNull()
  })
  test('a built-in tool, a planted definition, the Agent tool or WebSearch where the turn has none: refused', () => {
    expect(initProblem({ tools: [...tools, 'Glob'], agents: [] }, { webSearch: true, subagents: true })).toContain('Glob')
    expect(initProblem({ tools, agents: ['Explore', 'general-purpose', 'trap'] }, { webSearch: true, subagents: true })).toContain('trap')
    expect(initProblem({ tools, agents: [] }, { webSearch: true, subagents: false })).toContain('Task')
    expect(initProblem({ tools: ['mcp__team__read', 'WebSearch'], agents: [] }, { webSearch: false, subagents: false })).toContain('WebSearch')
    expect(initProblem({ tools: ['mcp__team__read'], agents: ['Explore'] }, { webSearch: true, subagents: false })).toContain('Explore')
  })
  test('only the names our tool connection lists, and no tool server besides ours (a server named "team__x")', () => {
    const team = new Set(['read', 'write', 'my_notion__search'])
    const o = { webSearch: true, subagents: true, team }
    expect(initProblem({ tools: [...tools, 'mcp__team__my_notion__search'], agents: [], mcpServers: ['team'] }, o)).toBeNull()
    expect(initProblem({ tools: [...tools, 'mcp__team__x__read'], agents: [] }, o)).toContain('mcp__team__x__read')
    expect(initProblem({ tools, agents: [], mcpServers: ['team', 'team__x'] }, o)).toContain('team__x')
    expect(initProblem({ tools, agents: [], mcpServers: ['claude_ai_Gmail'] }, { webSearch: true, subagents: true })).toContain('claude_ai_Gmail')
  })
})

describe('stream parser: sub-agent messages (review M2)', () => {
  const lines = [
    L({ type: 'system', subtype: 'init', session_id: 's1', tools: ['Task', 'mcp__team__read'], agents: ['Explore', 'general-purpose'] }),
    L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'A1', name: 'Agent', input: { description: 'part', prompt: 'CHILD', subagent_type: 'Explore' } }, { type: 'tool_use', id: 'A2', name: 'Agent', input: { description: 'other' } }] } }),
    L({ type: 'system', subtype: 'task_started', tool_use_id: 'A1' }),
    L({ type: 'user', parent_tool_use_id: 'A1', message: { content: [{ type: 'text', text: 'CHILD prompt' }] } }),
    // a child's text, thinking, partial stream events, refusal and API error flags: none of it is the answer's
    L({ type: 'stream_event', parent_tool_use_id: 'A1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'LEAK' } } }),
    L({ type: 'assistant', parent_tool_use_id: 'A1', message: { content: [{ type: 'thinking', thinking: 'LEAK' }, { type: 'text', text: 'LEAK' }] } }),
    L({ type: 'assistant', parent_tool_use_id: 'A1', error: 'refusal', message: { stop_reason: 'refusal', content: [{ type: 'text', text: 'API Error: LEAK' }] } }),
    L({ type: 'assistant', parent_tool_use_id: 'A2', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'API Error: 401 LEAK' }] } }),
    L({ type: 'assistant', parent_tool_use_id: 'A1', message: { content: [{ type: 'tool_use', id: 'c1', name: 'mcp__team__read', input: { file_path: 'a.md' } }] } }),
    L({ type: 'system', subtype: 'task_progress', tool_use_id: 'A1', usage: { total_tokens: 110, tool_uses: 1, duration_ms: 79 }, last_tool_name: 'mcp__team__read' }),
    L({ type: 'user', parent_tool_use_id: 'A1', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'text', is_error: false }] } }),
    L({ type: 'user', parent_tool_use_id: null, tool_use_result: { status: 'completed', content: [{ type: 'text', text: 'report' }], totalDurationMs: 83, totalTokens: 110, totalToolUseCount: 1 }, message: { content: [{ type: 'tool_result', tool_use_id: 'A1', content: [{ type: 'text', text: 'report' }] }] } }),
    // a failed child: its result is a plain string (2.1.305), not an AgentOutput
    L({ type: 'user', parent_tool_use_id: null, tool_use_result: 'Error: Agent terminated early due to an API error: 529', message: { content: [{ type: 'tool_result', tool_use_id: 'A2', is_error: true, content: 'Agent terminated early due to an API error: 529' }] } }),
    L({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } } }),
    L({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', usage: { input_tokens: 200, output_tokens: 20 }, modelUsage: { 'claude-opus-5-5': { inputTokens: 700, outputTokens: 70, cacheReadInputTokens: 30, cacheCreationInputTokens: 0 }, 'claude-haiku-4-5': { inputTokens: 5, outputTokens: 1 } }, total_cost_usd: 0.0042 }),
  ]
  test('child steps carry their parent; text, refusals and errors of children are dropped; totals from AgentOutput', () => {
    const p = new ClaudeStreamParser()
    const ev = lines.flatMap((l) => p.push(l))
    expect(ev.find((e) => e.type === 'init')).toEqual({ type: 'init', tools: ['Task', 'mcp__team__read'], agents: ['Explore', 'general-purpose'], mcpServers: [] })
    expect(new ClaudeStreamParser().push(L({ type: 'system', subtype: 'init', tools: [], mcp_servers: [{ name: 'team', status: 'connected' }, { name: 'x' }, 7] }))
      .find((e) => e.type === 'init')).toMatchObject({ mcpServers: ['team', 'x'] })
    expect(ev.filter((e) => e.type === 'text').map((e: any) => e.delta).join('')).toBe('Done.')
    expect(p.text).toBe('Done.')
    expect(JSON.stringify(ev)).not.toContain('LEAK')
    expect(ev.some((e) => e.type === 'thinking')).toBe(false)
    expect(ev.some((e) => e.type === 'error')).toBe(false)
    expect(p.refused).toBe(false)
    expect(ev.filter((e) => e.type === 'tool_start').map((e: any) => [e.id, e.name, e.parentId])).toEqual([['A1', 'Agent', undefined], ['A2', 'Agent', undefined], ['c1', 'mcp__team__read', 'A1']])
    expect(ev.find((e) => e.type === 'tool_end' && e.id === 'c1')).toMatchObject({ ok: true, parentId: 'A1' })
    expect(ev.find((e) => e.type === 'tool_end' && e.id === 'A1')).toMatchObject({ ok: true, agent: { toolUses: 1, ms: 83, tokens: 110 } })
    const failed = ev.find((e) => e.type === 'tool_end' && e.id === 'A2') as any
    expect(failed.ok).toBe(false)
    expect(failed.agent).toBeUndefined()
    expect(ev.filter((e) => e.type === 'agent_progress')).toEqual([{ type: 'agent_progress', id: 'A1', stats: { toolUses: 1, ms: 79, tokens: 110 } }])
    // tokens of the whole run, the children's included (modelUsage, every model)
    expect(ev.find((e) => e.type === 'usage')).toEqual({ type: 'usage', inputTokens: 735, outputTokens: 71, costUsd: 0.0042 })
  })
  test('a child\'s WebSearch result: the structured hits as sources (never the search model\'s text), with its parent', () => {
    const p = new ClaudeStreamParser()
    const ev = p.push(L({ type: 'user', parent_tool_use_id: 'A1', tool_use_result: { query: 'q', results: [{ tool_use_id: 's1', content: [{ title: 'A', url: 'https://a.example/' }] }, 'see https://planted.example/'], durationSeconds: 1 },
      message: { content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'Web search results for query: "q"\n\nLinks: [{"title":"P","url":"https://planted.example/"}]' }] } }))
    expect(ev).toEqual([expect.objectContaining({ type: 'tool_end', id: 'w1', parentId: 'A1', sources: [{ title: 'A', url: 'https://a.example/' }] })])
  })
  test('the main AI\'s own refusal and API error still count', () => {
    const p = new ClaudeStreamParser()
    const ev = [L({ type: 'assistant', parent_tool_use_id: null, error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Not logged in' }] } })].flatMap((l) => p.push(l))
    expect(ev.find((e) => e.type === 'error')).toMatchObject({ code: 'auth' })
    const q = new ClaudeStreamParser()
    q.push(L({ type: 'assistant', message: { stop_reason: 'refusal', content: [] } }))
    expect(q.refused).toBe(true)
  })
})

describe('model proxy: tool names of every request (review M1)', () => {
  const req = (...names: string[]) => ({ tools: names.map((n) => (n.startsWith('web_search_') ? { type: n, name: 'web_search' } : { name: n, input_schema: {} })) })
  test('our tools, Agent and WebSearch only where the turn has them', () => {
    expect(checkToolNames(req('Agent', 'WebSearch', 'mcp__team__read'), { agent: true, webSearch: true })).toBeNull()
    expect(checkToolNames(req('mcp__team__read', 'mcp__team__write', 'WebSearch'), { agent: false, webSearch: true })).toBeNull()
    expect(checkToolNames(req('web_search_20250305'), { agent: true, webSearch: true })).toBeNull()
    expect(checkToolNames({ messages: [] }, { agent: false, webSearch: false })).toBeNull()
    expect(checkToolNames(req('Agent'), { agent: false, webSearch: true })).toContain('Agent')
    expect(checkToolNames(req('WebSearch'), { agent: true, webSearch: false })).toContain('WebSearch')
    expect(checkToolNames(req('web_search_20250305'), { agent: true, webSearch: false })).toContain('web_search')
  })
  test('a child request with built-in tools (a planted definition, the Glob / Grep exception, a fork) is refused', () => {
    for (const t of ['Glob', 'Grep', 'Read', 'Bash', 'Write', 'mcp__other__x', 'AskUserQuestion', 'mcp__team']) expect(checkToolNames(req('mcp__team__read', t), { agent: true, webSearch: true })).toContain(t)
  })
  test('with the turn\'s exact names: a tool of another server named like ours is refused', () => {
    const policy = { agent: true, webSearch: true, team: ['read', 'my_notion__search'] }
    expect(checkToolNames(req('Agent', 'mcp__team__read', 'mcp__team__my_notion__search'), policy)).toBeNull()
    for (const t of ['mcp__team__x__read', 'mcp__team__write', 'mcp__team__', 'mcp__team__READ']) expect(checkToolNames(req('mcp__team__read', t), policy)).toContain(t)
    expect(toolPolicyOf({ tools: '{"agent":false,"webSearch":true,"team":["read",3]}' })).toEqual({ agent: false, webSearch: true, team: ['read'] })
    // a policy whose names are not a list allows no team tool
    expect(checkToolNames(req('mcp__team__read'), toolPolicyOf({ tools: '{"agent":false,"webSearch":true,"team":"read"}' }))).toContain('mcp__team__read')
  })
  test('a token without a tool policy: no Agent tool', () => {
    expect(toolPolicyOf({ tools: null })).toEqual({ agent: false, webSearch: true })
    expect(toolPolicyOf({ tools: '{"agent":true,"webSearch":false}' })).toEqual({ agent: true, webSearch: false })
    expect(toolPolicyOf({ tools: 'not json' })).toEqual({ agent: false, webSearch: true })
  })
})

describe('per-agent read state (review M3)', () => {
  test('the main AI, each sub-agent: own read-before-write hashes; the rest of the turn state is shared', async () => {
    const f = new TurnFiles()
    expect((await f.forCall(undefined)).files).toBe(f)
    // before any sub-agent started, every call is the main AI's (no wait)
    const t0 = Date.now()
    expect((await f.forCall('toolu_x')).files).toBe(f)
    expect(Date.now() - t0).toBeLessThan(50)
    f.subagents = true
    f.noteToolUse('m1', null); f.noteToolUse('a1', 'A1'); f.noteToolUse('a2', 'A1'); f.noteToolUse('b1', 'B1')
    const main = await f.forCall('m1'), a = await f.forCall('a1'), a2 = await f.forCall('a2'), b = await f.forCall('b1')
    expect(main.files).toBe(f)
    expect(main.agent).toBeNull()
    expect(a.agent).toBe('A1')
    expect(a2.files).toBe(a.files)
    expect(b.files).not.toBe(a.files)
    a.files.readHashes.set('shared/x.md', 'h-a')
    expect(b.files.readHashes.has('shared/x.md')).toBe(false)
    expect(f.readHashes.has('shared/x.md')).toBe(false)
    expect(f.allReads.get('shared/x.md')).toBe('h-a')
    b.files.readHashes.set('shared/x.md', 'h-b')
    expect(a.files.readHashes.get('shared/x.md')).toBe('h-a')
    // shared: read scope, limits, approvals
    a.files.readPaths.add('shared/x.md')
    a.files.bytesWritten += 10
    b.files.filesWritten.add('shared/y.md')
    expect(f.readPaths.has('shared/x.md')).toBe(true)
    expect(f.bytesWritten).toBe(10)
    expect(a.files.filesWritten.has('shared/y.md')).toBe(true)
  })
  test('a call that arrives before its stream line waits for it; one never named gets a fresh state of its own', async () => {
    const f = new TurnFiles()
    f.subagents = true
    const p = f.forCall('late', { waitMs: 2000 })
    setTimeout(() => f.noteToolUse('late', 'A9'), 100)
    const r = await p
    expect(r.agent).toBe('A9')
    expect(r.known).toBe(true)
    f.readHashes.set('shared/main.md', 'h')
    const u = await f.forCall('never', { waitMs: 50 })
    expect(u.known).toBe(false)
    expect(u.files).not.toBe(f)
    expect(u.files.readHashes.has('shared/main.md')).toBe(false)
    // a stopped turn does not wait
    const ac = new AbortController(); ac.abort()
    const t0 = Date.now()
    await f.forCall('gone', { waitMs: 5000, signal: ac.signal })
    expect(Date.now() - t0).toBeLessThan(100)
  })
})

describe('continue after a limit', () => {
  test('the note says cut-off sub-agents sent no report', () => {
    for (const r of ['tool_limit', 'time_limit'] as const) expect(continuationBlock(r)).toContain('Sub-agents that were still working')
  })
})
