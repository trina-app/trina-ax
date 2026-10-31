// Helper for tests/install/g-macos-install.ts and g-linux-install.ts: run ONE engine turn through an installed launcher
// socket and print {"code": <exit code>} or {"error": "..."}. Bundled into a self-contained file so the server account
// can run it.
//   bun g-launcher-probe.js [--code <bash program>] <launcher.sock> <agent root> <engine> <chat id> <args...>
// --code: a code-sandbox turn (docs/DECISIONS.md "Code sandbox"); once the engine runs, the program runs through the
// launcher's "code" op and the answer gets {"run": <code_exit or error>}.
import path from 'node:path'
import { SocketLauncher, launcherCode } from '../../server/src/native'

const argv = process.argv.slice(2)
const code = argv[0] === '--code' ? argv.splice(0, 2)[1]! : null
const [sock, agentRoot, engine, chat, ...args] = argv
const turnId = 'probe' + Math.random().toString(36).slice(2, 8)
const h = new SocketLauncher(sock!).launch({
  op: 'run', turnId, chatDir: path.join(agentRoot!, chat!), cmd: engine!, args,
  env: {}, token: 'probe-token', systemPrompt: '', stdin: '', timeoutMs: 15_000, ...(code ? { codeSandbox: true } : {}),
})
let result: Record<string, unknown> = { error: 'no exit event' }
let stderr = ''
let run: Promise<unknown> | null = null
for await (const ev of h.events) {
  if (ev.ev === 'started' && code) run = launcherCode(sock!, { turnId, lang: 'bash', code, timeoutMs: 10_000 })
  if (ev.ev === 'stderr') stderr += Buffer.from(ev.b64, 'base64').toString()
  if (ev.ev === 'exit') { result = { code: ev.code, stderr: stderr.trim() }; break }
  if (ev.ev === 'error') { result = { error: ev.message }; break }
}
if (run) result.run = await run
console.log(JSON.stringify(result))
