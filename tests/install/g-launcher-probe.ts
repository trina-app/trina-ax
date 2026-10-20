// Helper for tests/install/g-macos-install.ts: run ONE engine turn through an installed launcher socket and print
// {"code": <exit code>} or {"error": "..."}. Bundled into a self-contained file so the server account can run it.
//   bun g-launcher-probe.js <launcher.sock> <agent root> <engine> <chat id> <args...>
import path from 'node:path'
import { SocketLauncher } from '../../server/src/native'

const [sock, agentRoot, engine, chat, ...args] = process.argv.slice(2)
const h = new SocketLauncher(sock!).launch({
  op: 'run', turnId: 'probe' + Math.random().toString(36).slice(2, 8), chatDir: path.join(agentRoot!, chat!), cmd: engine!, args,
  env: {}, token: 'probe-token', systemPrompt: '', stdin: '', timeoutMs: 15_000,
})
let result: unknown = { error: 'no exit event' }
let stderr = ''
for await (const ev of h.events) {
  if (ev.ev === 'stderr') stderr += Buffer.from(ev.b64, 'base64').toString()
  if (ev.ev === 'exit') { result = { code: ev.code, stderr: stderr.trim() }; break }
  if (ev.ev === 'error') { result = { error: ev.message }; break }
}
console.log(JSON.stringify(result))
