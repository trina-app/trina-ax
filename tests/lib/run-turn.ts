// Run one fake-engine turn through the real launcher/bridge/gate path.
import type { Running } from '../../server/src/server'
import path from 'node:path'

export const FAKE_ENGINE = path.join(import.meta.dir, 'fake-engine.ts')

/** Linux sandbox tests (tests/linux): the fake engine lives in its own engine folder (MYCEL_FAKE_ENGINE_DIR, holding a
 * copy of bun and fake-engine.ts), the only folder besides the chat folder that the turn sandbox shows. */
const SANDBOX_ENGINE_DIR = process.env.MYCEL_FAKE_ENGINE_DIR
export const fakeEngineCmd = () => SANDBOX_ENGINE_DIR ? path.join(SANDBOX_ENGINE_DIR, 'bun') : process.execPath
const fakeEngineScript = () => SANDBOX_ENGINE_DIR ? path.join(SANDBOX_ENGINE_DIR, 'fake-engine.ts') : FAKE_ENGINE

export async function fakeTurn(srv: Running, user: string, spec: unknown, o: { chatId?: string; onStarted?: (pid: number) => void | Promise<void>; onLine?: (line: any) => void | Promise<void> } = {}) {
  const chatId = o.chatId ?? 'c_' + crypto.randomUUID().slice(0, 8)
  const { turn, token } = srv.turns.create(user, chatId, 'fake')
  const h = srv.launcher!.launch({
    op: 'run', turnId: turn.id, chatDir: path.join(srv.cfg.agentRoot, chatId), cmd: fakeEngineCmd(),
    args: [fakeEngineScript(), '--mcp-config', '{MCP_CONFIG}'], env: { PATH: '/usr/bin:/bin', HOME: srv.cfg.agentRoot, ...(SANDBOX_ENGINE_DIR ? { TMPDIR: '{CHAT_DIR}/.tmp' } : {}) },
    token, systemPrompt: 'fake', timeoutMs: 120000, stdin: JSON.stringify(spec),
  })
  let stdout = '', stderr = '', exit: any = null, pending = ''
  for await (const e of h.events) {
    if (e.ev === 'started') { srv.turns.bind(turn.id, e.pgid); await o.onStarted?.(e.pid) }
    else if (e.ev === 'stdout') {
      const chunk = Buffer.from(e.b64, 'base64').toString()
      stdout += chunk
      if (o.onLine) {
        // complete lines only: the launcher forwards raw chunks, a line can span two of them
        pending += chunk
        let i
        while ((i = pending.indexOf('\n')) >= 0) {
          const l = pending.slice(0, i); pending = pending.slice(i + 1)
          if (l) { let v: any; try { v = JSON.parse(l) } catch { v = { raw: l } } await o.onLine(v) }
        }
      }
    }
    else if (e.ev === 'stderr') stderr += Buffer.from(e.b64, 'base64').toString()
    else if (e.ev === 'exit' || e.ev === 'error') exit = e
  }
  srv.turns.revoke(turn.id)
  const lines = stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } })
  return { turnId: turn.id, lines, results: lines.filter((l) => l.tool), stderr, exit }
}
