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
// Benign containment instrumentation for the Linux turn-sandbox test (tests/linux/driver.ts, spec 3.9.1): the
// "engine" reports what the sandbox lets it reach, and the driver asserts the sandbox shut it out. Each probe is one
// JSON line {"probe": id, result}. Kinds: "stat"/"read"/"ls" of a path, "connect" to host:port, "write" a path,
// "listdir" the agent root. Nothing here attacks another process; the per-syscall blocking is covered by the
// mycel-sandbox Go tests. errno-style strings come back as the result.
if (Array.isArray(spec.probe)) {
  const fsp = await import('node:fs/promises')
  const net = await import('node:net')
  const errOf = (e: any) => (e?.code ?? String(e?.message ?? e)).toString()
  const connect = (host: string, port: number, kind: 'tcp' | 'udp') => new Promise<string>((res) => {
    if (kind === 'udp') {
      const dgram = require('node:dgram')
      const s = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4')
      let done = false; const fin = (r: string) => { if (!done) { done = true; try { s.close() } catch {}; res(r) } }
      s.on('error', (e: any) => fin(errOf(e)))
      s.send(Buffer.from('x'), port, host, (e: any) => fin(e ? errOf(e) : 'sent'))
      setTimeout(() => fin('timeout'), 2000)
    } else {
      const c = net.connect({ host, port })
      let done = false; const fin = (r: string) => { if (!done) { done = true; try { c.destroy() } catch {}; res(r) } }
      c.on('connect', () => fin('ok')); c.on('error', (e: any) => fin(errOf(e)))
      setTimeout(() => fin('timeout'), 2000)
    }
  })
  for (const p of spec.probe) {
    let result: unknown
    try {
      if (p.kind === 'stat') { const st = await fsp.lstat(p.path); result = { entries: st.isDirectory() ? (await fsp.readdir(p.path)).length : null, mtimeMs: st.mtimeMs } }
      else if (p.kind === 'read') result = { text: (await fsp.readFile(p.path, 'utf8')).slice(0, 200) }
      else if (p.kind === 'ls') result = { entries: await fsp.readdir(p.path) }
      else if (p.kind === 'write') { await fsp.writeFile(p.path, 'x'); result = 'wrote' }
      else if (p.kind === 'connect') result = await connect(p.host, p.port, p.proto ?? 'tcp')
      else if (p.kind === 'usetoken') {
        // assert a (handed-in, "stolen") turn token is refused on tools.sock from this session (the gate binds the
        // token to the turn's session id; another session, or a setsid escapee, is "not authorized")
        result = await new Promise<string>((res) => {
          const c = net.connect(p.sock)
          let b = ''; let done = false; const fin = (r: string) => { if (!done) { done = true; try { c.destroy() } catch {}; res(r) } }
          c.on('connect', () => c.write(JSON.stringify({ hello: { token: p.token } }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: { file_path: p.file } } }) + '\n'))
          c.on('data', (d: Buffer) => { b += d.toString(); if (b.includes('\n')) fin(b.split('\n')[0]!.slice(0, 250)) })
          c.on('error', (e: any) => fin(errOf(e))); setTimeout(() => fin('timeout ' + b.slice(0, 120)), 4000)
        })
      }
      else result = 'unknown-kind'
    } catch (e: any) { result = errOf(e) }
    console.log(JSON.stringify({ probe: p.id, result }))
  }
}
if (spec.sleepMs) await Bun.sleep(spec.sleepMs)
console.log(JSON.stringify({ done: true }))
br.kill()
process.exit(0)
