import { describe, expect, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import { ClaudeStreamParser } from '../../server/src/engine/claude-parse'
import { CodexEventParser } from '../../server/src/engine/codex-parse'
import { buildClaudeLaunch, CLAUDE_ALLOWED_TOOLS } from '../../server/src/engine/claude'
import { codexArgs } from '../../server/src/engine/codex'
import { WORK } from '../lib/env'

const L = (o: any) => JSON.stringify(o)

describe('claude stream-json -> EngineEvent', () => {
  test('text, tools, usage, session', () => {
    const p = new ClaudeStreamParser()
    const ev = [
      L({ type: 'system', subtype: 'init', session_id: 's1', tools: [] }),
      L({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } }),
      L({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } }),
      L({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } }),
      L({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 'tu1', name: 'mcp__team__read', input: { file_path: 'a.md' } }] } }),
      L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'Access denied' }] } }),
      L({ type: 'result', is_error: false, result: 'Hello', usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 }, total_cost_usd: 0.01, session_id: 's1' }),
    ].flatMap((l) => p.push(l))
    expect(ev.filter((e) => e.type === 'text').map((e: any) => e.delta).join('')).toBe('Hello')
    expect(ev.find((e) => e.type === 'session')).toEqual({ type: 'session', sessionId: 's1' })
    expect(ev.find((e) => e.type === 'tool_start')).toMatchObject({ id: 'tu1', name: 'mcp__team__read' })
    expect(ev.find((e) => e.type === 'tool_end')).toMatchObject({ id: 'tu1', ok: false })
    expect(ev.find((e) => e.type === 'usage')).toEqual({ type: 'usage', inputTokens: 15, outputTokens: 3, costUsd: 0.01 })
    expect(ev.some((e) => e.type === 'error')).toBe(false)
  })
  test('not logged in -> auth error', () => {
    const p = new ClaudeStreamParser()
    const ev = [L({ type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } }),
      L({ type: 'result', is_error: true, result: 'Not logged in · Please run /login', usage: {} })].flatMap((l) => p.push(l))
    expect(ev.filter((e) => e.type === 'error').every((e: any) => e.code === 'auth')).toBe(true)
  })
  test('refusal is detected (stop_reason refusal)', () => {
    const p = new ClaudeStreamParser()
    const ev = [L({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'refusal' } } }), L({ type: 'result', is_error: false, result: '', usage: {} })].flatMap((l) => p.push(l))
    expect(p.refused).toBe(true)
    expect(ev.find((e) => e.type === 'error')).toMatchObject({ code: 'refused' })
  })
  test('rate limit and context classification', () => {
    const a = new ClaudeStreamParser().push(L({ type: 'result', is_error: true, result: 'API Error: 429 rate_limit_error', usage: {} }))
    const b = new ClaudeStreamParser().push(L({ type: 'result', is_error: true, result: 'Prompt is too long', usage: {} }))
    expect(a.find((e) => e.type === 'error')).toMatchObject({ code: 'rate_limit' })
    expect(b.find((e) => e.type === 'error')).toMatchObject({ code: 'context' })
  })
})

describe('codex --json -> EngineEvent', () => {
  test('thread, mcp tool, message, usage; exec items are surfaced', () => {
    const p = new CodexEventParser()
    const ev = [L({ type: 'thread.started', thread_id: 'th1' }), L({ type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'team', tool: 'read', arguments: { file_path: 'x' }, status: 'in_progress' } }),
      L({ type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'team', tool: 'read', status: 'completed' } }),
      L({ type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: 'id', status: 'completed' } }),
      L({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'done' } }),
      L({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 5, reasoning_output_tokens: 7 } })].flatMap((l) => p.push(l))
    expect(ev.find((e) => e.type === 'tool_start')).toMatchObject({ name: 'mcp__team__read' })
    expect(p.itemTypes.get('command_execution')).toBe(1)
    expect(p.text).toBe('done')
    expect(ev.find((e) => e.type === 'usage')).toMatchObject({ inputTokens: 100, outputTokens: 12 })
  })
})

describe('locked engine invocations', () => {
  const chatDir = path.join(WORK, 'unit-engine', 'agent', 'c1')
  test('claude: exact flags, tools limited to team tools + WebSearch', () => {
    const r = buildClaudeLaunch({ turnId: 't', chatDir, token: 'tok', systemPrompt: 'sys', message: 'hi', sessionId: '11111111-1111-4111-8111-111111111111', resume: false, stash: null, maxTurns: 5, timeoutMs: 1000 },
      { bin: '/x/claude', authMode: 'local-login', agentHome: '/nonexistent' })
    const a = r.args
    const val = (f: string) => a[a.indexOf(f) + 1]
    expect(val('--tools')).toBe('WebSearch')
    expect(val('--allowedTools').split(',')).toEqual(['mcp__team__list', 'mcp__team__glob', 'mcp__team__grep', 'mcp__team__read', 'mcp__team__write', 'mcp__team__edit', 'WebSearch'])
    expect(CLAUDE_ALLOWED_TOOLS.length).toBe(7)
    expect(val('--setting-sources')).toBe('')
    expect(JSON.parse(val('--settings'))).toEqual({ autoMemoryEnabled: false, disableAllHooks: true, includeGitInstructions: false, enabledPlugins: { 'cc-plugin-agents-md@builtin': false, 'cc-plugin-plugin-authoring@builtin': false } })
    expect(val('--permission-mode')).toBe('dontAsk')
    expect(val('--mcp-config')).toBe('{MCP_CONFIG}')
    expect(val('--append-system-prompt-file')).toBe('{SYSTEM_PROMPT_FILE}')
    expect(val('--max-turns')).toBe('5')
    for (const f of ['--strict-mcp-config', '--disable-slash-commands', '-p', '--verbose', '--include-partial-messages']) expect(a).toContain(f)
    expect(val('--session-id')).toBe('11111111-1111-4111-8111-111111111111')
    for (const k of ['CLAUDE_CODE_DISABLE_FILE_MENTIONS', 'CLAUDE_CODE_DISABLE_ATTACHMENTS', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS'])
      expect(r.env[k]).toBe('1')
    expect(r.env.TMPDIR).toBe(path.join(chatDir, '.tmp')); expect(r.env.CLAUDE_CODE_TMPDIR).toBe(path.join(chatDir, '.tmp'))
    expect(JSON.stringify(r.args) + JSON.stringify(r.env)).not.toContain('tok') // token never in argv/env
    expect(r.stdin).toBe('hi')
    expect(r.env.ANTHROPIC_API_KEY).toBeUndefined()
  })
  test('claude proxy mode: own config dir, per-turn token in the right variable', () => {
    const base = { turnId: 't', chatDir, token: 'tok', systemPrompt: 's', message: 'm', sessionId: 'x', resume: false, stash: null, maxTurns: 3, timeoutMs: 1, proxyToken: 'mpx_1' }
    const k = buildClaudeLaunch(base, { bin: 'c', authMode: 'proxy', agentHome: '/agent/home', modelProxy: { baseUrl: 'http://127.0.0.1:9', kind: 'api-key' } })
    expect(k.env).toMatchObject({ HOME: '/agent/home', CLAUDE_CONFIG_DIR: path.join(chatDir, '.claude'), ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: 'mpx_1' })
    const o = buildClaudeLaunch(base, { bin: 'c', authMode: 'proxy', agentHome: '/agent/home', modelProxy: { baseUrl: 'http://127.0.0.1:9', kind: 'oauth' } })
    expect(o.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('mpx_1'); expect(o.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(o.sessionCollect).toEqual({ dir: path.join(chatDir, '.claude', 'projects'), name: 'x.jsonl', removeDir: true })
  })
  test('claude local-login keeps the real home (CLI login) and stashes under ~/.claude/projects/<slug>', () => {
    const r = buildClaudeLaunch({ turnId: 't', chatDir, token: 'tok', systemPrompt: 's', message: 'm', sessionId: 'x', resume: true, stash: Buffer.from('{}'), maxTurns: 3, timeoutMs: 1 }, { bin: 'c', authMode: 'local-login', agentHome: '/a' })
    expect(r.env.HOME).toBe(os.homedir()); expect(r.env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(r.sessionRestore!.dir.startsWith(path.join(os.homedir(), '.claude', 'projects', '-'))).toBe(true)
    expect(r.args).toContain('--resume')
  })
  test('codex: features off via -c, local catalog, our MCP only, read-only, ephemeral', () => {
    const a = codexArgs({ bin: 'codex', codexHome: '/h', agentHome: '/a', catalog: '/cat.json', model: 'm1', auth: 'agent-own' })
    for (const f of ['--ephemeral', '--ignore-rules', '--ignore-user-config', '--skip-git-repo-check', '--json']) expect(a).toContain(f)
    expect(a[a.indexOf('-s') + 1]).toBe('read-only')
    for (const f of ['shell_tool', 'unified_exec', 'code_mode', 'multi_agent', 'apps', 'view_image', 'hooks', 'plugins', 'computer_use', 'browser_use']) expect(a).toContain(`features.${f}=false`)
    expect(a).toContain('model_catalog_json="/cat.json"')
    expect(a).toContain('mcp_servers.team.command="{BRIDGE}"')
    expect(a).toContain('mcp_servers.team.default_tools_approval_mode="approve"')
    expect(a).toContain('mcp_servers.team.enabled_tools=["list","glob","grep","read","write","edit"]')
    expect(a.some((x) => x.startsWith('--disable'))).toBe(false)
  })
})
