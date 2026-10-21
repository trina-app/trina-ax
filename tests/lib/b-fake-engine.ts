// Scripted stand-in for Claude Code (`-p --output-format stream-json`) and the Codex CLI (`exec --json`), started
// by the real launcher exactly like the real engines (component B tests: deterministic chat turns).
// It speaks MCP to our tools through the bridge the launcher configured, keeps a session file the way Claude
// does (so stash / restore / resume can be tested), and follows directives found in the user's message:
//   @fake {"say": "text"}                    stream text (in small chunks)
//   @fake {"tool": "read", "args": {...}}    call one of our tools; {"sayResult": true} also says the result,
//                                            {"sayLength": true} only its length and the start of its last line
//   @fake {"sleep": 300}                     wait
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
//   @fake {"echo": "codexEnv"}               (Codex) say what the turn got: login copy in CODEX_HOME, proxy, certificates
//   @fake {"refreshAuth": "acc-1"}           (Codex) rewrite CODEX_HOME/auth.json like a token refresh, for that account
//   @fake {"linkAuth": "/path"}              (Codex) replace CODEX_HOME/auth.json by a symbolic link to the path
//   @fake {"connect": "host:443"}            (Codex) CONNECT through HTTPS_PROXY, say the proxy's status line
//   @fake {"claudeCall": true}               (Codex) call the proxy's Claude path with this turn's proxy token, say the status
//   @fake {"exists": "rel/path"}             say whether the path exists in the chat folder (lstat)
//   @fake {"readAbs": "/abs/path"}           try to read a file anywhere; says read=ok|blocked (never its content)
// Without directives it answers "echo: <first line of the message>".
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
if (argv[0] === '--version') { process.stdout.write('0.0.1 (fake engine)\n'); process.exit(0) }
const codex = argv[0] === 'exec'
const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const stdin = await new Response(Bun.stdin.stream()).text()
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')

// ---------------- what we were given ----------------
let system = ''
let message = stdin
let bridge: { command: string; args: string[] } | null = null
let sessionId = ''
let resumed = false
let history: { role: string; text: string }[] = []
let sessionFile = ''
const model = codex ? JSON.parse(argv.find((a) => a.startsWith('model='))?.slice(6) ?? '""') : arg('--model') ?? ''

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
else out({ type: 'system', subtype: 'init', session_id: sessionId, model, tools: [] })

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
  if (!text) return
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

async function tool(name: string, args: unknown): Promise<string> {
  closeBlock()
  await startBridge()
  const id = `toolu_${++toolN}`
  const full = `mcp__team__${name}`
  if (codex) out({ type: 'item.started', item: { id, type: 'mcp_tool_call', server: 'team', tool: name, arguments: args, status: 'in_progress' } })
  else out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: full, input: args }] } })
  const r = br ? await rpc('tools/call', { name, arguments: args }) : { error: { message: 'no tools' } }
  const content = r.result?.content ?? [{ type: 'text', text: JSON.stringify(r.error ?? r) }]
  const text = content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
  const isError = !!r.result?.isError || !!r.error
  if (codex) out({ type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'team', tool: name, arguments: args, status: 'completed', result: { content, is_error: isError } } })
  else out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } })
  return text
}

function finish(o: { error?: string; refused?: boolean } = {}) {
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
    out({ type: 'result', subtype: o.error ? 'error_during_execution' : 'success', is_error: !!o.error, result: o.error ?? answer, session_id: sessionId,
      stop_reason: o.refused ? 'refusal' : 'end_turn', usage: { input_tokens: 100, output_tokens: 20 }, total_cost_usd: 0.001 })
  }
  try { br?.kill() } catch {}
  process.exit(o.error ? 1 : 0)
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
function secretsVisible(): string {
  const looks = (v: string) => /mpx_|sk-ant-/.test(v)
  const env = Object.entries(process.env).filter(([, v]) => v && looks(v)).map(([k]) => k)
  return `envSecrets=${env.join(',') || 'none'} argvSecrets=${process.argv.some(looks) ? 'yes' : 'none'} fdVar=${process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR ?? 'none'} base=${process.env.ANTHROPIC_BASE_URL ?? 'none'}`
}

// ---------------- run the directives ----------------
const directives = message.split('\n').filter((l) => l.startsWith('@fake ')).map((l) => JSON.parse(l.slice(6)))
if (!directives.length) await say('echo: ' + (message.split('\n')[0] ?? ''))
for (const d of directives) {
  if (d.say !== undefined) await say(String(d.say))
  else if (d.tool) {
    const r = await tool(d.tool, d.args ?? {})
    if (d.sayResult) await say(r)
    if (d.sayLength) await say(`length=${r.length} tail=${r.trimEnd().split('\n').at(-1)?.slice(0, 12)}`)
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
    let account: string | null = null
    try { account = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).tokens?.account_id ?? null } catch {}
    const px = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null
    await say(JSON.stringify({ codexHome: path.relative(process.cwd(), home), account, homeEmpty: fs.readdirSync(process.env.HOME!).length === 0,
      proxyUser: px?.username ?? null, proxyHost: px ? `${px.hostname}:${px.port}` : null, sslCertFile: process.env.SSL_CERT_FILE ?? null,
      credStore: argv.includes('cli_auth_credentials_store="file"') }))
  } else if (d.refreshAuth) {
    const f = path.join(process.env.CODEX_HOME!, 'auth.json')
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    j.tokens.account_id = String(d.refreshAuth); j.tokens.refresh_token = 'rt-' + Date.now(); j.last_refresh = new Date().toISOString()
    fs.writeFileSync(f + '.new', JSON.stringify(j)); fs.renameSync(f + '.new', f)
    await say('refreshed')
  } else if (d.claudeCall) {
    const px = new URL(process.env.HTTPS_PROXY ?? 'http://none:0@127.0.0.1:1')
    let status = 'error'
    try {
      const r = await fetch(`http://${px.hostname}:${px.port}/v1/messages`, { method: 'POST', headers: { 'x-api-key': decodeURIComponent(px.password), 'content-type': 'application/json' }, body: '{"model":"claude-x","max_tokens":1,"messages":[]}' })
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
    const px = new URL(process.env.HTTPS_PROXY ?? 'http://none:0@127.0.0.1:1')
    const status = await new Promise<string>((res) => {
      const c = require('node:net').connect(Number(px.port), px.hostname)
      let b = ''
      c.on('connect', () => c.write(`CONNECT ${d.connect} HTTP/1.1\r\nHost: ${d.connect}\r\nProxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(px.username)}:${decodeURIComponent(px.password)}`).toString('base64')}\r\n\r\n`))
      c.on('data', (x: Buffer) => { b += x.toString(); if (b.includes('\r\n')) { c.destroy(); res(b.split('\r\n')[0]!) } })
      c.on('error', (e: Error) => res('error ' + e.message))
      c.on('close', () => res(b.split('\r\n')[0] || 'closed'))
    })
    await say(status)
  } else if (d.echo === 'tools') {
    await startBridge()
    const l = br ? await rpc('tools/list', {}) : { result: { tools: [] } }
    await say((l.result?.tools ?? []).map((t: any) => t.name).sort().join(','))
  }
}
finish()
