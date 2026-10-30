// Scripted stand-in for Claude Code (`-p --output-format stream-json`) and the Codex CLI (`exec --json`), started
// by the real launcher exactly like the real engines (component B tests: deterministic chat turns).
// It speaks MCP to our tools through the bridge the launcher configured, keeps a session file the way Claude
// does (so stash / restore / resume can be tested), and follows directives found in the user's message:
//   @fake {"say": "text"}                    stream text (in small chunks)
//   @fake {"tool": "read", "args": {...}}    call one of our tools; {"sayResult": true} also says the result,
//                                            {"sayLength": true} only its length and the start of its last line
//   @fake {"sleep": 300}                     wait
//   @fake {"toolStarted": "read", "args": {...}}  report a call of one of our tools that never finishes (a long
//                                            download, a slow page): the step stays running until the turn ends
//   @fake {"saySplit": "한글"}               one text delta whose stdout line is written in two pieces, cut inside
//                                            the first multi-byte character (the launcher reads them separately)
//   @fake {"refuseUnless": "sonnet"}         refuse unless --model contains the word
//   @fake {"fail": "rate limit exceeded"}    end with an engine error
//   @fake {"claudeFail": "usage limit"}     the same, as Claude only (Codex goes on: the limit fallback)
//   @fake {"crashOnce": true}                exit 3 without output the first time in this chat folder
//   @fake {"loseSession": true}              on --resume: answer "No conversation found" (the stash went bad)
//   @fake {"echo": "system" | "message" | "tools" | "model" | "history" | "resume"}
//   @fake {"model": "prompt"}               call the model like Claude Code in subscription mode: the per-turn token
//                                            from the inherited fd (CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR), POST
//                                            $ANTHROPIC_BASE_URL/v1/messages?beta=true with stream, say the text deltas;
//                                            an HTTP error ends the turn like Claude Code's "API Error: <status> ..."
//   @fake {"echo": "secrets"}                say whether a model credential is visible in env / argv (it must not be)
//   @fake {"direct": "http://127.0.0.1:N/"}  try to reach an address other than the proxy; says direct=blocked|reached
//   @fake {"echo": "codexEnv"}               (Codex) say what the turn got: the (placeholder) login in CODEX_HOME, the
//                                            provider addresses, proxy variables, certificates, the refresh override
//   @fake {"codexModel": "prompt"}           (Codex, managed) call the model like Codex: POST <provider base_url>/responses
//                                            with the auth.json token (+ ChatGPT-Account-ID), stream, say the text deltas;
//                                            an HTTP error ends the turn like Codex ("unexpected status <n> ...")
//   @fake {"dumpHome": true}                 (Codex) say every file under CODEX_HOME, HOME and the chat folder (S-1)
//   @fake {"modelAny": "prompt"}             call the model whichever engine this is (Claude: "model", Codex: "codexModel")
//   @fake {"refreshAuth": "acc-1"}           (Codex) rewrite CODEX_HOME/auth.json like a token refresh, for that account
//   @fake {"linkAuth": "/path"}              (Codex) replace CODEX_HOME/auth.json by a symbolic link to the path
//   @fake {"connect": "host:443"}            (Codex) CONNECT through HTTPS_PROXY (or the provider's port with the
//                                            auth.json token), say the proxy's status line
//   @fake {"claudeCall": true}               (Codex) call the proxy's Claude path with this turn's proxy token, say the status
//   @fake {"exists": "rel/path"}             say whether the path exists in the chat folder (lstat)
//   @fake {"readAbs": "/abs/path"}           try to read a file anywhere; says read=ok|blocked (never its content)
//   @fake {"agents": [{...}, ...]}           (Claude) sub-agents like Claude Code's Agent tool: one main round of Agent
//                                            calls, the children run AT THE SAME TIME, each {"id", "type", "description",
//                                            "steps": [...], "fail": "API error text", "stats": {...}}. A step is
//                                            {"tool", "args", "lateLine": ms} (a team tool call; lateLine: the stream line
//                                            comes that long after the MCP call), {"say"} / {"thinking"} / {"refuse"}
//                                            (child messages that must never reach the answer), {"sleep": ms}. Child lines
//                                            carry parent_tool_use_id; task_started / task_progress / task_notification
//                                            and the Agent result (AgentOutput, or a plain string when "fail") follow.
//                                            Child calls do not count against --max-turns (like Claude Code).
//                                            "lateAgentLine": ms (next to "agents"): the Agent line comes that late.
//   @fake {"init": {"tools": [...], "agents": [...]}}  what the init event reports (lockdown check tests)
//   @fake {"echo": "agents" | "subagentPrompt" | "args"}  say the --agents file, the sub-agents' instructions, argv
// Every team tool call carries Claude Code's _meta {"claudecode/toolUseId": <the tool_use id>}.
// Like Claude Code it honours --max-turns: a tool call past that many ends the run with result subtype
// "error_max_turns" (is_error, exit 1), keeping the session and the answer so far.
// Without directives it answers "echo: <first line of the message>".
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
if (argv[0] === '--version') { process.stdout.write('0.0.1 (fake engine)\n'); process.exit(0) }
const codex = argv[0] === 'exec'
const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const stdin = await new Response(Bun.stdin.stream()).text()
// stdout is a pipe to the launcher: a big line (a 400 kB tool result) may still be on its way when the run ends, so
// finish() exits only once every write has been flushed (process.exit right away dropped the answer and the result
// event on a busy machine). After finish() nothing else is written and no further directive runs.
let stopped = false
let pendingWrites = 0
let onDrained: (() => void) | null = null
const out = (o: unknown) => {
  if (stopped) return
  pendingWrites++
  process.stdout.write(JSON.stringify(o) + '\n', () => { if (--pendingWrites === 0) onDrained?.() })
}

// ---------------- what we were given ----------------
let system = ''
let message = stdin
let bridge: { command: string; args: string[] } | null = null
let sessionId = ''
let resumed = false
let history: { role: string; text: string }[] = []
let sessionFile = ''
const model = codex ? JSON.parse(argv.find((a) => a.startsWith('model='))?.slice(6) ?? '""') : arg('--model') ?? ''
const maxTurns = codex ? 0 : Number(arg('--max-turns') ?? 0)
let turnsUsed = 0

if (codex) {
  const m = /^<instructions>\n([\s\S]*?)\n<\/instructions>\n\n([\s\S]*)$/.exec(stdin)
  if (m) { system = m[1]!; message = m[2]! }
  const cmd = argv.find((a) => a.startsWith('mcp_servers.team.command='))
  const args = argv.find((a) => a.startsWith('mcp_servers.team.args='))
  if (cmd && args) bridge = { command: JSON.parse(cmd.slice('mcp_servers.team.command='.length)), args: JSON.parse(args.slice('mcp_servers.team.args='.length)) }
  sessionId = 'thread-' + crypto.randomUUID()
} else {
  const sp = arg('--append-system-prompt-file')
  if (sp && fs.existsSync(sp)) system = fs.readFileSync(sp, 'utf8')
  const cfgPath = arg('--mcp-config')
  if (cfgPath) bridge = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mcpServers.team
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(process.cwd(), '.claude')
  const projects = path.join(configDir, 'projects')
  if (arg('--resume')) {
    sessionId = arg('--resume')!
    resumed = true
    const restored = path.join(projects, 'restored', `${sessionId}.jsonl`)
    if (!fs.existsSync(restored) || stdin.includes('"loseSession"')) {
      process.stderr.write(`No conversation found with session ID: ${sessionId}\n`)
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `No conversation found with session ID: ${sessionId}`, session_id: sessionId, usage: { input_tokens: 0, output_tokens: 0 } })
      process.exit(1)
    }
    history = fs.readFileSync(restored, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    fs.rmSync(restored)
  } else sessionId = arg('--session-id') ?? crypto.randomUUID()
  sessionFile = path.join(projects, 'fake-project', `${sessionId}.jsonl`)
}

// ---------------- MCP client over the bridge ----------------
let br: ReturnType<typeof Bun.spawn> | null = null
const pend = new Map<number, (m: any) => void>()
let rid = 0
async function startBridge() {
  if (!bridge || br) return
  br = Bun.spawn([bridge.command, ...bridge.args], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  ;(async () => {
    let buf = ''
    for await (const c of br!.stdout as ReadableStream<Uint8Array>) {
      buf += new TextDecoder().decode(c)
      let i
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); pend.get(m.id)?.(m) } catch {} }
    }
    for (const f of pend.values()) f({ closed: true })
  })()
  await rpc('initialize', { protocolVersion: '2025-06-18' })
}
function rpc(method: string, params: unknown): Promise<any> {
  return new Promise((res) => {
    const k = ++rid
    pend.set(k, (m) => { pend.delete(k); res(m) })
    const w = br!.stdin as import('bun').FileSink
    w.write(JSON.stringify({ jsonrpc: '2.0', id: k, method, params }) + '\n'); w.flush()
  })
}

// ---------------- output helpers ----------------
let answer = ''
let toolN = 0
if (codex) out({ type: 'thread.started', thread_id: sessionId })
else {
  const init = message.split('\n').filter((l) => l.startsWith('@fake ')).map((l) => { try { return JSON.parse(l.slice(6)) } catch { return {} } }).find((d) => d.init)?.init
  out({ type: 'system', subtype: 'init', session_id: sessionId, model, tools: init?.tools ?? [], ...(init?.agents ? { agents: init.agents } : {}) })
}

// consecutive says form one text block, like one Claude message part (a tool call closes it)
let blockOpen = false
let codexText = ''
function closeBlock() {
  if (codex) {
    if (codexText) { answer += (answer ? '\n\n' : '') + codexText; out({ type: 'item.completed', item: { id: `msg-${++toolN}`, type: 'agent_message', text: codexText } }); codexText = '' }
    return
  }
  if (blockOpen) { out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }); blockOpen = false }
}
async function say(text: string) {
  if (!text || stopped) return
  if (codex) { codexText += text; return }
  if (!blockOpen) { out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }); blockOpen = true }
  for (let i = 0; i < text.length; i += 7) {
    const d = text.slice(i, i + 7)
    answer += d
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: d } } })
    await Bun.sleep(2)
  }
}

async function saySplit(text: string) {
  if (codex || !text) return say(text)
  if (!blockOpen) { out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }); blockOpen = true }
  answer += text
  const line = Buffer.from(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } }) + '\n')
  // first byte of a multi-byte character, plus one: the cut lands inside that character
  const first = line.findIndex((b) => b >= 0xc0)
  const cut = first >= 0 ? first + 1 : line.length >> 1
  await new Promise<void>((res) => process.stdout.write(line.subarray(0, cut), () => res()))
  await Bun.sleep(150)
  await new Promise<void>((res) => process.stdout.write(line.subarray(cut), () => res()))
}

async function tool(name: string, args: unknown, expectImage = false, inspectImages = false): Promise<string> {
  if (stopped) return ''
  if (maxTurns > 0 && turnsUsed >= maxTurns) { finish({ maxTurns: true }); return '' }
  turnsUsed++
  closeBlock()
  await startBridge()
  const id = `toolu_${++toolN}`
  const full = `mcp__team__${name}`
  if (codex) out({ type: 'item.started', item: { id, type: 'mcp_tool_call', server: 'team', tool: name, arguments: args, status: 'in_progress' } })
  else out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: full, input: args }] } })
  const r = br ? await rpc('tools/call', { name, arguments: args, ...(codex ? {} : { _meta: { 'claudecode/toolUseId': id, progressToken: toolN } }) }) : { error: { message: 'no tools' } }
  const content = r.result?.content ?? [{ type: 'text', text: JSON.stringify(r.error ?? r) }]
  const text = content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
  const isError = !!r.result?.isError || !!r.error
  if (codex) out({ type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'team', tool: name, arguments: args, status: 'completed', result: { content, is_error: isError } } })
  else out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } })
  if(expectImage) {
    const image=content.find((c:any)=>c.type==='image' && c.mimeType==='image/jpeg' && typeof c.data==='string')
    return image ? 'IMAGE_BLOCK_OK:image/jpeg' : 'IMAGE_BLOCK_MISSING'
  }
  // structuredContent next to an image makes Codex drop the image (openai/codex#10334): say whether it was there
  if (inspectImages) return JSON.stringify({ text, structured: r.result?.structuredContent !== undefined, images: content.filter((c: any) => c.type === 'image').map((c: any) => ({ mimeType: c.mimeType, magic: Buffer.from(c.data, 'base64').subarray(0, 8).toString('hex') })) })
  return text
}

function finish(o: { error?: string; refused?: boolean; maxTurns?: boolean } = {}) {
  if (stopped) return
  closeBlock()
  if (sessionFile) {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true })
    const lines = [...history, { role: 'user', text: message }, { role: 'assistant', text: answer }]
    fs.writeFileSync(sessionFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }
  if (codex) {
    if (o.error) out({ type: 'turn.failed', error: { message: o.error } })
    else out({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } })
  } else {
    if (o.refused) out({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'refusal' } } })
    if (o.maxTurns) out({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: turnsUsed + 1, session_id: sessionId, usage: { input_tokens: 100, output_tokens: 20 }, total_cost_usd: 0.001 })
    else out({ type: 'result', subtype: o.error ? 'error_during_execution' : 'success', is_error: !!o.error, result: o.error ?? answer, session_id: sessionId,
      stop_reason: o.refused ? 'refusal' : 'end_turn', usage: { input_tokens: 100, output_tokens: 20 }, total_cost_usd: 0.001 })
  }
  stopped = true
  try { br?.kill() } catch {}
  const code = o.error || o.maxTurns ? 1 : 0
  if (pendingWrites === 0) process.exit(code)
  onDrained = () => process.exit(code)
  setTimeout(() => process.exit(code), 10_000).unref?.() // a reader that never drains the pipe: give up like before
}

// ---------------- the model, through the team server's proxy (subscription mode) ----------------
let modelToken: string | null = null
function proxyToken(): string {
  if (modelToken !== null) return modelToken
  const fdVar = process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR ? 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR' : 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR'
  const fd = Number(process.env[fdVar])
  modelToken = Number.isInteger(fd) && fd > 2 ? fs.readFileSync(fd, 'utf8').trim() : ''
  delete process.env[fdVar] // like Claude Code: read once, then forget where it came from
  return modelToken
}
async function callModel(prompt: string) {
  const base = process.env.ANTHROPIC_BASE_URL
  if (!base) return finish({ error: 'no ANTHROPIC_BASE_URL' })
  let r: Response
  try {
    r = await fetch(base.replace(/\/$/, '') + '/v1/messages?beta=true', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + proxyToken(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14', 'user-agent': 'claude-cli/0.0.0-fake (external, cli)', 'x-app': 'cli', 'x-stainless-os': 'MacOS' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 200, stream: true, messages: [{ role: 'user', content: prompt }] }),
    })
  } catch (e) { return finish({ error: `API Error: Connection error (${(e as Error).message})` }) }
  if (!r.ok) return finish({ error: `API Error: ${r.status} ${(await r.text()).slice(0, 300)}` })
  let buf = ''
  const dec = new TextDecoder()
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!l.startsWith('data:')) continue
      try { const ev = JSON.parse(l.slice(5)); if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') await say(ev.delta.text) } catch {}
    }
  }
}
/** where a Codex turn reaches the proxy and with which token: HTTPS_PROXY (agent-own) or the provider's base_url and
 * the placeholder auth.json (managed) */
function codexProxy(): { host: string; port: string; token: string } {
  if (process.env.HTTPS_PROXY) { const px = new URL(process.env.HTTPS_PROXY); return { host: px.hostname, port: px.port, token: decodeURIComponent(px.password) } }
  const base = (argv.find((a) => a.startsWith('model_providers.teamax.base_url=')) ?? '').split('=').slice(1).join('=').replace(/^"|"$/g, '')
  let token = ''
  try { const a = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME ?? '', 'auth.json'), 'utf8')); token = a.tokens?.access_token ?? a.OPENAI_API_KEY ?? '' } catch {}
  try { const u = new URL(base); return { host: u.hostname, port: u.port, token } } catch { return { host: '127.0.0.1', port: '1', token } }
}
/** call the model like Codex 0.163 with the custom provider: POST <base_url>/responses, SSE */
async function callCodexModel(prompt: string) {
  const base = (argv.find((a) => a.startsWith('model_providers.teamax.base_url=')) ?? '').split('=').slice(1).join('=').replace(/^"|"$/g, '')
  if (!base) return finish({ error: 'no provider base_url' })
  let auth: any = {}
  try { auth = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME ?? '', 'auth.json'), 'utf8')) } catch {}
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream', originator: 'codex_exec', 'user-agent': 'codex_exec/0.0.0-fake', 'session-id': 's-1' }
  if (auth.auth_mode === 'chatgpt') { headers.authorization = 'Bearer ' + auth.tokens.access_token; headers['chatgpt-account-id'] = auth.tokens.account_id }
  else headers.authorization = 'Bearer ' + (auth.OPENAI_API_KEY ?? '')
  const version = (argv.find((a) => a.startsWith('model_providers.teamax.http_headers=')) ?? '').match(/version = "([^"]+)"/)?.[1]
  if (version) headers.version = version
  let r: Response
  try {
    r = await fetch(base.replace(/\/$/, '') + '/responses', { method: 'POST', headers, body: JSON.stringify({ model, instructions: 'x', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }], tools: [{ type: 'function', name: 'team__read', parameters: {} }, { type: 'web_search' }], stream: true, store: false }) })
  } catch (e) { return finish({ error: `stream error: ${(e as Error).message}` }) }
  if (!r.ok) return finish({ error: `unexpected status ${r.status}: ${(await r.text()).slice(0, 300)}` })
  let buf = ''
  const dec = new TextDecoder()
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!l.startsWith('data:')) continue
      try { const ev = JSON.parse(l.slice(5)); if (ev.type === 'response.output_text.delta') await say(ev.delta) } catch {}
    }
  }
}
function secretsVisible(): string {
  const looks = (v: string) => /mpx_|sk-ant-/.test(v)
  const env = Object.entries(process.env).filter(([, v]) => v && looks(v)).map(([k]) => k)
  return `envSecrets=${env.join(',') || 'none'} argvSecrets=${process.argv.some(looks) ? 'yes' : 'none'} fdVar=${process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR ?? 'none'} base=${process.env.ANTHROPIC_BASE_URL ?? 'none'}`
}

// ---------------- sub-agents (Claude Code's Agent tool) ----------------
async function childTool(parent: string, step: any): Promise<{ ok: boolean }> {
  await startBridge()
  const id = `toolu_${++toolN}`
  const line = () => out({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name: `mcp__team__${step.tool}`, input: step.args ?? {} }] } })
  if (!step.lateLine) line()
  const call = br ? rpc('tools/call', { name: step.tool, arguments: step.args ?? {}, _meta: { 'claudecode/toolUseId': id, progressToken: toolN } }) : Promise.resolve({ error: { message: 'no tools' } })
  if (step.lateLine) { await Bun.sleep(Number(step.lateLine)); line() }
  const r = await call
  const content = r.result?.content ?? [{ type: 'text', text: JSON.stringify(r.error ?? r) }]
  const isError = !!r.result?.isError || !!r.error
  out({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } })
  return { ok: !isError }
}
async function runAgents(agents: any[], lateAgentLine = 0) {
  if (maxTurns > 0 && turnsUsed >= maxTurns) { finish({ maxTurns: true }); return }
  turnsUsed++ // the Agent calls are one round of the main session; the children's rounds are their own
  closeBlock()
  const t0 = Date.now()
  const agentLine = () => out({ type: 'assistant', message: { content: agents.map((a) => ({ type: 'tool_use', id: a.id, name: 'Agent', input: { description: a.description ?? 'part', prompt: a.prompt ?? 'do it', ...(a.type ? { subagent_type: a.type } : {}) } })) } })
  // lateAgentLine: the main AI's Agent line reaches the server that long after the children started (a slow stream)
  if (lateAgentLine) setTimeout(agentLine, lateAgentLine)
  else agentLine()
  await Promise.all(agents.map(async (a) => {
    out({ type: 'system', subtype: 'task_started', tool_use_id: a.id, description: a.description ?? 'part', subagent_type: a.type ?? 'general-purpose' })
    out({ type: 'user', parent_tool_use_id: a.id, message: { content: [{ type: 'text', text: a.prompt ?? 'do it' }] } })
    let uses = 0
    for (const st of a.steps ?? []) {
      if (stopped) return
      if (st.tool) {
        uses++
        out({ type: 'system', subtype: 'task_progress', tool_use_id: a.id, usage: { total_tokens: 100 * uses, tool_uses: uses, duration_ms: Date.now() - t0 }, last_tool_name: `mcp__team__${st.tool}` })
        await childTool(a.id, st)
      } else if (st.say !== undefined) out({ type: 'assistant', parent_tool_use_id: a.id, message: { content: [{ type: 'text', text: String(st.say) }] } })
      else if (st.thinking !== undefined) out({ type: 'assistant', parent_tool_use_id: a.id, message: { content: [{ type: 'thinking', thinking: String(st.thinking) }] } })
      else if (st.refuse) out({ type: 'assistant', parent_tool_use_id: a.id, error: 'refusal', message: { stop_reason: 'refusal', content: [{ type: 'text', text: 'API Error: refused' }] } })
      else if (st.apiError) out({ type: 'assistant', parent_tool_use_id: a.id, error: 'rate_limit', message: { content: [{ type: 'text', text: 'API Error: 429 rate limited' }] } })
      else if (st.sleep) await Bun.sleep(Number(st.sleep))
    }
    if (stopped) return
    const ms = Date.now() - t0
    const stats = { totalToolUseCount: uses, totalDurationMs: ms, totalTokens: 100 * uses + 50, ...(a.stats ?? {}) }
    if (a.fail) {
      out({ type: 'system', subtype: 'task_notification', tool_use_id: a.id, status: 'failed', usage: { total_tokens: stats.totalTokens, tool_uses: uses, duration_ms: ms } })
      out({ type: 'user', parent_tool_use_id: null, tool_use_result: `Error: Agent terminated early due to an API error: ${a.fail}`, message: { content: [{ type: 'tool_result', tool_use_id: a.id, is_error: true, content: `Agent terminated early due to an API error: ${a.fail}` }] } })
    } else {
      out({ type: 'system', subtype: 'task_notification', tool_use_id: a.id, status: 'completed', usage: { total_tokens: stats.totalTokens, tool_uses: uses, duration_ms: ms } })
      out({ type: 'user', parent_tool_use_id: null, tool_use_result: { status: 'completed', agentType: a.type ?? 'general-purpose', content: [{ type: 'text', text: a.report ?? `report of ${a.id}` }], ...stats },
        message: { content: [{ type: 'tool_result', tool_use_id: a.id, content: [{ type: 'text', text: `[Subagent hand-back] ${a.report ?? `report of ${a.id}`}` }] }] } })
    }
  }))
}

// ---------------- run the directives ----------------
const directives = message.split('\n').filter((l) => l.startsWith('@fake ')).map((l) => JSON.parse(l.slice(6)))
if (!directives.length) await say('echo: ' + (message.split('\n')[0] ?? ''))
for (const d of directives) {
  if (stopped) break
  if (d.say !== undefined) await say(String(d.say))
  else if (d.tool) {
    const r = await tool(d.tool, d.args ?? {}, !!d.expectImage, !!d.inspectImages)
    if (d.sayResult) await say(r)
    if (d.sayLength) await say(`length=${r.length} tail=${r.trimEnd().split('\n').at(-1)?.slice(0, 12)}`)
  } else if (d.toolStarted) {
    turnsUsed++
    closeBlock()
    const id = `toolu_${++toolN}`
    if (codex) out({ type: 'item.started', item: { id, type: 'mcp_tool_call', server: 'team', tool: d.toolStarted, arguments: d.args ?? {}, status: 'in_progress' } })
    else out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__team__${d.toolStarted}`, input: d.args ?? {} }] } })
  } else if (d.sleep) await Bun.sleep(Number(d.sleep))
  else if (d.saySplit !== undefined) await saySplit(String(d.saySplit))
  else if (d.refuseUnless !== undefined) { if (!String(model).includes(d.refuseUnless)) finish({ refused: true }) }
  else if (d.fail) finish({ error: String(d.fail) })
  else if (d.claudeFail) { if (!codex) finish({ error: String(d.claudeFail) }) }
  else if (d.crashOnce) {
    const marker = path.join(process.cwd(), '.crashed-once')
    if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); process.exit(3) }
  } else if (d.echo === 'system') await say(system)
  else if (d.echo === 'message') await say(message)
  else if (d.echo === 'model') await say(`model=${model}`)
  else if (d.echo === 'resume') await say(`resumed=${resumed}`)
  else if (d.model !== undefined) await callModel(String(d.model))
  else if (d.echo === 'secrets') await say(secretsVisible())
  else if (d.direct) {
    let reached = false
    try { await fetch(String(d.direct), { signal: AbortSignal.timeout(3000) }); reached = true } catch {}
    await say(`direct=${reached ? 'reached' : 'blocked'}`)
  } else if (d.echo === 'history') await say(history.map((h) => `${h.role}: ${h.text.split('\n')[0]}`).join(' | ') || '(no history)')
  else if (d.echo === 'codexEnv') {
    const home = process.env.CODEX_HOME ?? ''
    let auth: any = null
    try { auth = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')) } catch {}
    const px = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null
    const conf = (k: string) => { const a = argv.find((x) => x.startsWith(k + '=')); return a ? a.slice(k.length + 1).replace(/^"|"$/g, '') : null }
    const tok = auth?.tokens?.access_token ?? auth?.OPENAI_API_KEY ?? ''
    await say(JSON.stringify({ codexHome: path.relative(process.cwd(), home), account: auth?.tokens?.account_id ?? null, authMode: auth?.auth_mode ?? null,
      turnToken: /^mpx_[A-Za-z0-9_-]{43}$/.test(tok), refresh: auth?.tokens?.refresh_token ?? null,
      homeEmpty: fs.readdirSync(process.env.HOME!).length === 0,
      proxyUser: px?.username ?? null, proxyHost: px ? `${px.hostname}:${px.port}` : null, sslCertFile: process.env.SSL_CERT_FILE ?? null,
      provider: conf('model_provider'), baseUrl: conf('model_providers.teamax.base_url'), chatgptBaseUrl: conf('chatgpt_base_url'),
      refreshOverride: process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE ?? null, apiKeyEnv: process.env.OPENAI_API_KEY ?? process.env.CODEX_API_KEY ?? null,
      credStore: argv.includes('cli_auth_credentials_store="file"') }))
  } else if (d.codexModel !== undefined) await callCodexModel(String(d.codexModel))
  else if (d.modelAny !== undefined) { if (codex) await callCodexModel(String(d.modelAny)); else await callModel(String(d.modelAny)) }
  else if (d.dumpHome) {
    const seen: string[] = []
    const walk = (dir: string, depth = 0) => {
      if (depth > 6) return
      let names: string[] = []
      try { names = fs.readdirSync(dir) } catch { return }
      for (const n of names) {
        const f = path.join(dir, n)
        let st: fs.Stats
        try { st = fs.lstatSync(f) } catch { continue }
        if (st.isDirectory()) walk(f, depth + 1)
        else if (st.isFile() && st.size < 256 * 1024) try { seen.push(`${path.relative(process.cwd(), f)}:${fs.readFileSync(f, 'utf8')}`) } catch {}
      }
    }
    walk(process.cwd())
    await say(Buffer.from(seen.join('\n')).toString('base64'))
  } else if (d.refreshAuth) {
    const f = path.join(process.env.CODEX_HOME!, 'auth.json')
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    j.tokens.account_id = String(d.refreshAuth); j.tokens.refresh_token = 'rt-' + Date.now(); j.last_refresh = new Date().toISOString()
    fs.writeFileSync(f + '.new', JSON.stringify(j)); fs.renameSync(f + '.new', f)
    await say('refreshed')
  } else if (d.claudeCall) {
    const p = codexProxy()
    let status = 'error'
    try {
      const r = await fetch(`http://${p.host}:${p.port}/v1/messages`, { method: 'POST', headers: { 'x-api-key': p.token, 'content-type': 'application/json' }, body: '{"model":"claude-x","max_tokens":1,"messages":[]}' })
      status = String(r.status)
    } catch (e) { status = 'error ' + (e as Error).message }
    await say(status)
  } else if (d.readAbs !== undefined) {
    let ok = false
    try { fs.readFileSync(String(d.readAbs)); ok = true } catch {}
    await say(`read=${ok ? 'ok' : 'blocked'}`)
  } else if (d.exists !== undefined) {
    let there = true
    try { fs.lstatSync(path.join(process.cwd(), String(d.exists))) } catch { there = false }
    await say(String(there))
  } else if (d.linkAuth) {
    const f = path.join(process.env.CODEX_HOME!, 'auth.json')
    fs.rmSync(f); fs.symlinkSync(String(d.linkAuth), f)
    await say('linked')
  } else if (d.connect) {
    const p = codexProxy()
    const status = await new Promise<string>((res) => {
      const c = require('node:net').connect(Number(p.port), p.host)
      let b = ''
      c.on('connect', () => c.write(`CONNECT ${d.connect} HTTP/1.1\r\nHost: ${d.connect}\r\nProxy-Authorization: Basic ${Buffer.from(`turn:${p.token}`).toString('base64')}\r\n\r\n`))
      c.on('data', (x: Buffer) => { b += x.toString(); if (b.includes('\r\n')) { c.destroy(); res(b.split('\r\n')[0]!) } })
      c.on('error', (e: Error) => res('error ' + e.message))
      c.on('close', () => res(b.split('\r\n')[0] || 'closed'))
    })
    await say(status)
  } else if (d.agents) await runAgents(d.agents, Number(d.lateAgentLine ?? 0))
  else if (d.init) { /* reported in the init event above */ }
  else if (d.echo === 'agents') { const f = arg('--agents'); await say(f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '(no --agents)') }
  else if (d.echo === 'subagentPrompt') { const f = arg('--append-subagent-system-prompt-file'); await say(f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '(none)') }
  else if (d.echo === 'args') await say(JSON.stringify(argv))
  else if (d.echo === 'tools') {
    await startBridge()
    const l = br ? await rpc('tools/list', {}) : { result: { tools: [] } }
    await say((l.result?.tools ?? []).map((t: any) => t.name).sort().join(','))
  }
}
finish()
