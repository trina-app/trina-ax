// Scripted stand-in for Claude Code (`-p --output-format stream-json`) and the Codex CLI (`exec --json`), started
// by the real launcher exactly like the real engines (component B tests: deterministic chat turns).
// It speaks MCP to our tools through the bridge the launcher configured, keeps a session file the way Claude
// does (so stash / restore / resume can be tested), and follows directives found in the user's message:
//   @fake {"say": "text"}                    stream text (in small chunks)
//   @fake {"tool": "read", "args": {...}}    call one of our tools; {"sayResult": true} also says the result,
//                                            {"sayLength": true} only its length and the start of its last line
//   @fake {"sleep": 300}                     wait
//   @fake {"refuseUnless": "sonnet"}         refuse unless --model contains the word
//   @fake {"fail": "rate limit exceeded"}    end with an engine error
//   @fake {"crashOnce": true}                exit 3 without output the first time in this chat folder
//   @fake {"loseSession": true}              on --resume: answer "No conversation found" (the stash went bad)
//   @fake {"echo": "system" | "message" | "tools" | "model" | "history" | "resume"}
// Without directives it answers "echo: <first line of the message>".
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
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
  else if (d.refuseUnless !== undefined) { if (!String(model).includes(d.refuseUnless)) finish({ refused: true }) }
  else if (d.fail) finish({ error: String(d.fail) })
  else if (d.crashOnce) {
    const marker = path.join(process.cwd(), '.crashed-once')
    if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); process.exit(3) }
  } else if (d.echo === 'system') await say(system)
  else if (d.echo === 'message') await say(message)
  else if (d.echo === 'model') await say(`model=${model}`)
  else if (d.echo === 'resume') await say(`resumed=${resumed}`)
  else if (d.echo === 'history') await say(history.map((h) => `${h.role}: ${h.text.split('\n')[0]}`).join(' | ') || '(no history)')
  else if (d.echo === 'tools') {
    await startBridge()
    const l = br ? await rpc('tools/list', {}) : { result: { tools: [] } }
    await say((l.result?.tools ?? []).map((t: any) => t.name).sort().join(','))
  }
}
finish()
