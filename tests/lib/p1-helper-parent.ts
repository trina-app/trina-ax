// Child process for tests/unit/p1-helpers-orphan.test.ts: starts the gate and the launcher the way the server does,
// starts one turn whose engine ignores SIGTERM, prints the pids, then waits to be killed.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { nativeBinDir } from '../../server/src/config'
import { startGate, startLauncher } from '../../server/src/native'

const [dir, run] = process.argv.slice(2) as [string, string]
const agent = path.join(dir, 'agent')
const engine = path.join(dir, 'engine.sh')
fs.mkdirSync(agent, { recursive: true })
fs.writeFileSync(engine, "#!/bin/sh\ntrap '' TERM\nsleep 120 &\necho \"child $!\"\nexec sleep 120\n", { mode: 0o755 })
const upstream = net.createServer(() => {}).listen(path.join(run, 'up.sock'))
const gate = await startGate(nativeBinDir(), path.join(run, 'tools.sock'), path.join(run, 'up.sock'), 'x'.repeat(40))
const launcher = await startLauncher(nativeBinDir(), { listen: path.join(run, 'l.sock'), agentRoot: agent, toolsSock: path.join(run, 'tools.sock'), allowCmds: [engine] })
const c = net.createConnection(path.join(run, 'l.sock'))
c.write(JSON.stringify({ op: 'run', turnId: 't-1', chatDir: path.join(agent, 'chat-1'), cmd: engine, args: [], env: {}, token: 'x', systemPrompt: '', stdin: '', timeoutMs: 600_000 }) + '\n')
let buf = ''
let pid = 0
c.setEncoding('utf8')
c.on('data', (d: string) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
    if (ev.ev === 'started') pid = ev.pid
    const m = ev.ev === 'stdout' ? /child (\d+)/.exec(Buffer.from(ev.b64, 'base64').toString()) : null
    if (m) console.log(JSON.stringify({ gate: gate.pid, launcher: launcher.pid, engine: pid, child: Number(m[1]) }))
  }
})
void upstream
await new Promise(() => {})
