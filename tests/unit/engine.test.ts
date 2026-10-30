import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClaudeStreamParser } from '../../server/src/engine/claude-parse'
import { CodexEventParser } from '../../server/src/engine/codex-parse'
import { buildClaudeLaunch, CLAUDE_ALLOWED_TOOLS } from '../../server/src/engine/claude'
import { buildCodexLaunch, codexArgs, prepareCodexTurn, type CodexConf } from '../../server/src/engine/codex'
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
    // the raw error text is not answer text (the person sees the translated auth error)
    expect(ev.some((e) => e.type === 'text')).toBe(false)
    expect(p.text).toBe('')
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
  test('the --max-turns end is a per-answer limit, not an error; usage still counts', () => {
    for (const result of [
      { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 51, usage: { input_tokens: 7, output_tokens: 3 }, total_cost_usd: 0.02, session_id: 's1' },
      { type: 'result', subtype: 'error_during_execution', terminal_reason: 'max_turns', is_error: true, usage: {} },
    ]) {
      const p = new ClaudeStreamParser()
      const ev = p.push(L(result))
      expect(p.maxTurns).toBe(true)
      expect(ev.filter((e) => e.type === 'error')).toEqual([])
      expect(ev).toContainEqual({ type: 'limit', kind: 'turns' })
      expect(ev.find((e) => e.type === 'usage')).toBeTruthy()
    }
    const other = new ClaudeStreamParser()
    expect(other.push(L({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', usage: {} })).find((e) => e.type === 'error')).toMatchObject({ code: 'crash' })
    expect(other.maxTurns).toBe(false)
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
  test('codex standalone web search (web.run): the query comes only with the end, as its summary', () => {
    // as Codex 0.163 writes them (recorded from the real CLI against a fake search answer)
    const ev = [L({ type: 'item.started', item: { id: 'call_1', type: 'web_search', query: '', action: { type: 'other' } } }),
      L({ type: 'item.completed', item: { id: 'call_1', type: 'web_search', query: 'debian 13 codename', action: { type: 'search', query: 'debian 13 codename' } } })].flatMap((l) => new CodexEventParser().push(l))
    expect(ev[0]).toMatchObject({ type: 'tool_start', id: 'call_1', name: 'web_search', summary: '' })
    expect(ev[1]).toEqual({ type: 'tool_end', id: 'call_1', ok: true, summary: 'debian 13 codename' })
  })
  test('a Codex search that never finishes (refused or failed: the model got "aborted") ends as failed with the turn, not done', () => {
    // as the real Codex 0.164 writes a search whose /alpha/search answered 403: the item starts, never completes
    const p = new CodexEventParser()
    const ev = [L({ type: 'item.started', item: { id: 'call_1', type: 'web_search', query: '', action: { type: 'other' } } }),
      L({ type: 'item.started', item: { id: 'call_2', type: 'web_search', query: '', action: { type: 'other' } } }),
      L({ type: 'item.completed', item: { id: 'call_2', type: 'web_search', query: 'ok one', action: { type: 'search', query: 'ok one' } } }),
      L({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })].flatMap((l) => p.push(l))
    expect(ev.filter((e) => e.type === 'tool_end')).toEqual([{ type: 'tool_end', id: 'call_2', ok: true, summary: 'ok one' }, { type: 'tool_end', id: 'call_1', ok: false }])
    const f = new CodexEventParser()
    const ev2 = [L({ type: 'item.started', item: { id: 'call_9', type: 'web_search', query: '' } }), L({ type: 'turn.failed', error: { message: 'boom' } })].flatMap((l) => f.push(l))
    expect(ev2.find((e) => e.type === 'tool_end')).toEqual({ type: 'tool_end', id: 'call_9', ok: false })
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
  test('claude proxy modes: own config dir and home in the chat folder, per-turn token for the launcher pipe, never in env', () => {
    const base = { turnId: 't', chatDir, token: 'tok', systemPrompt: 's', message: 'm', sessionId: 'x', resume: false, stash: null, maxTurns: 3, timeoutMs: 1, proxyToken: 'mpx_1' }
    // the kind follows the turn's AI connection (API key -> the API key descriptor; Claude subscription -> OAuth)
    const k = buildClaudeLaunch({ ...base, tokenKind: 'api-key' }, { bin: 'c', authMode: 'managed', agentHome: '/agent/home', modelProxy: { baseUrl: 'http://127.0.0.1:9' } })
    expect(k.env).toMatchObject({ HOME: path.join(chatDir, '.home'), CLAUDE_CONFIG_DIR: path.join(chatDir, '.claude'), ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' })
    expect(k.modelToken).toEqual({ kind: 'api-key', value: 'mpx_1' })
    const o = buildClaudeLaunch({ ...base, tokenKind: 'oauth' }, { bin: 'c', authMode: 'managed', agentHome: '/agent/home', modelProxy: { baseUrl: 'http://127.0.0.1:9' } })
    expect(o.modelToken).toEqual({ kind: 'oauth', value: 'mpx_1' })
    for (const r of [k, o]) {
      expect(JSON.stringify(r.env)).not.toContain('mpx_1'); expect(JSON.stringify(r.args)).not.toContain('mpx_1')
      expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); expect(r.env.ANTHROPIC_API_KEY).toBeUndefined()
    }
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

// security audit r1 (os-layer #2): dev engines now run in the sandbox, which only opens the turn's chat folder, so a
// dev Codex turn keeps CODEX_HOME, HOME and the locked catalog there instead of the shared <data>/codex-home (that
// shared folder also mixed every chat's Codex state). The server prepares those files outside the sandbox, so links
// the engine may have left in its chat folder must never be followed.
describe('codex per-chat state (dev-owner-symlink)', () => {
  const W = path.join(WORK, 'engine-codex-chat')
  fs.rmSync(W, { recursive: true, force: true })
  const chat = path.join(W, 'agent', 'c_1')
  const catalog = path.join(W, 'data', 'codex-catalog.json')
  const realAuth = path.join(W, 'owner', '.codex', 'auth.json')
  const owner = path.join(W, 'owner', '.claude')
  const conf: CodexConf = { bin: '/x/codex', codexHome: path.join(W, 'data', 'codex-home'), agentHome: path.join(W, 'data', 'codex-agent-home'), catalog, model: 'm', auth: 'dev-owner-symlink' }

  test('CODEX_HOME, HOME and the catalog are in the chat folder', () => {
    for (const d of [path.dirname(catalog), path.dirname(realAuth), owner]) fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(catalog, '{"models":[]}'); fs.writeFileSync(realAuth, '{}')
    prepareCodexTurn(conf, chat, realAuth)
    expect(fs.readlinkSync(path.join(chat, '.codex', 'auth.json'))).toBe(realAuth)
    expect(fs.readFileSync(path.join(chat, '.codex', 'catalog.json'), 'utf8')).toBe('{"models":[]}')
    const lr = buildCodexLaunch({ turnId: 't', chatDir: chat, token: 'k', systemPrompt: 's', message: 'm', timeoutMs: 1000 }, conf)
    expect(lr.env.CODEX_HOME).toBe(path.join(chat, '.codex'))
    expect(lr.env.HOME).toBe(path.join(chat, '.home'))
    expect(lr.args).toContain(`model_catalog_json=${JSON.stringify(path.join(chat, '.codex', 'catalog.json'))}`)
    expect(lr.args.join(' ')).not.toContain(path.join(W, 'data'))
    // role-account mode: the launcher makes <chat>/.codex (login copy) and <chat>/.home; the catalog stays in the
    // engine folder; HTTPS only through the model proxy
    const own = buildCodexLaunch({ turnId: 't', chatDir: chat, token: 'k', systemPrompt: 's', message: 'm', timeoutMs: 1000, proxy: { port: 47821, token: 'mpx_tok' } }, { ...conf, auth: 'agent-own' })
    expect(own.env.CODEX_HOME).toBe('{CHAT_DIR}/.codex')
    expect(own.env.HOME).toBe('{CHAT_DIR}/.home')
    expect(own.env.HTTPS_PROXY).toBe('http://turn:mpx_tok@127.0.0.1:47821')
    expect(own.env.SSL_CERT_FILE).toBe('/etc/ssl/cert.pem')
    expect(own.codexAuth).toBe(true)
    expect(own.args).toContain(`model_catalog_json=${JSON.stringify(catalog)}`)
    expect(own.args).toContain('cli_auth_credentials_store="file"')
    expect(() => buildCodexLaunch({ turnId: 't', chatDir: chat, token: 'k', systemPrompt: 's', message: 'm', timeoutMs: 1000 }, { ...conf, auth: 'agent-own' })).toThrow(/model proxy/)
  })

  test('links the engine left in its chat folder are removed, not followed', () => {
    fs.writeFileSync(path.join(owner, 'config.toml'), 'owner'); fs.mkdirSync(path.join(owner, 'skills'), { recursive: true })
    fs.writeFileSync(path.join(owner, 'skills', 'keep.md'), 'owner skill')
    // .codex -> the owner's config folder, .home -> the owner's config folder, catalog.json -> an owner file
    fs.rmSync(path.join(chat, '.codex'), { recursive: true, force: true }); fs.symlinkSync(owner, path.join(chat, '.codex'))
    fs.rmSync(path.join(chat, '.home'), { recursive: true, force: true }); fs.symlinkSync(owner, path.join(chat, '.home'))
    prepareCodexTurn(conf, chat, realAuth)
    expect(fs.readFileSync(path.join(owner, 'config.toml'), 'utf8')).toBe('owner')
    expect(fs.readFileSync(path.join(owner, 'skills', 'keep.md'), 'utf8')).toBe('owner skill')
    expect(fs.existsSync(path.join(owner, 'catalog.json'))).toBe(false)
    expect(fs.existsSync(path.join(owner, 'auth.json'))).toBe(false)
    expect(fs.lstatSync(path.join(chat, '.codex')).isDirectory()).toBe(true)
    expect(fs.lstatSync(path.join(chat, '.home')).isDirectory()).toBe(true)
    const victim = path.join(W, 'owner', 'victim.txt'); fs.writeFileSync(victim, 'owner data')
    fs.rmSync(path.join(chat, '.codex', 'catalog.json')); fs.symlinkSync(victim, path.join(chat, '.codex', 'catalog.json'))
    prepareCodexTurn(conf, chat, realAuth)
    expect(fs.readFileSync(victim, 'utf8')).toBe('owner data')
    expect(fs.lstatSync(path.join(chat, '.codex', 'catalog.json')).isFile()).toBe(true)
  })
})
