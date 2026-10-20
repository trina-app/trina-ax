// Scripted stand-in for the AI engine (design tab 7 "통합": 대본대로 도구를 부르는 프로그램).
// Started by the launcher exactly like the real engine; reads the MCP config the launcher wrote, starts the
// bridge, then runs the calls given on stdin. Prints one JSON line per call result, then {"done":true}.
// stdin: {"calls":[{"tool":"read","args":{...}}...], "raw"?: [...jsonrpc messages], "attack"?: "<script path>"}
import fs from 'node:fs'
const cfgPath = process.argv[process.argv.indexOf('--mcp-config') + 1]
const spec = JSON.parse(await new Response(Bun.stdin.stream()).text())
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mcpServers.team
const br = Bun.spawn([cfg.command, ...cfg.args], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
const pend = new Map<number, (m: any) => void>()
let id = 0
;(async () => {
  let buf = ''
  for await (const c of br.stdout as any) {
    buf += new TextDecoder().decode(c)
    let i
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); (pend.get(m.id) ?? ((x: any) => console.log(JSON.stringify({ unsolicited: x }))))(m) } catch {} }
  }
  for (const f of pend.values()) f({ closed: true })
})()
const rpc = (method: string, params: unknown) => new Promise<any>((res) => {
  const k = ++id; pend.set(k, res); br.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: k, method, params }) + '\n'); br.stdin.flush()
  setTimeout(() => res({ timeout: true }), 20000)
})
const init = await rpc('initialize', { protocolVersion: '2025-06-18' })
console.log(JSON.stringify({ init: init.result?.serverInfo ?? init.error ?? init }))
if (init.result) {
  const list = await rpc('tools/list', {})
  console.log(JSON.stringify({ tools: list.result?.tools?.map((t: any) => t.name) }))
  for (const c of spec.calls ?? []) {
    const r = await rpc('tools/call', { name: c.tool, arguments: c.args })
    console.log(JSON.stringify({ tool: c.tool, args: c.args, isError: !!r.result?.isError, text: r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r) }))
  }
}
if (spec.attack) {
  const p = Bun.spawnSync(['/bin/sh', spec.attack], { env: { ...process.env, ...(spec.attackEnv ?? {}) } })
  console.log(JSON.stringify({ attack: p.stdout.toString() + p.stderr.toString() }))
}
if (spec.sleepMs) await Bun.sleep(spec.sleepMs)
console.log(JSON.stringify({ done: true }))
br.kill()
process.exit(0)
