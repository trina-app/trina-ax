// Run one fake-engine turn through the real launcher/bridge/gate path.
import type { Running } from '../../server/src/server'
import path from 'node:path'

export const FAKE_ENGINE = path.join(import.meta.dir, 'fake-engine.ts')

export async function fakeTurn(srv: Running, user: string, spec: unknown, o: { chatId?: string; onStarted?: (pid: number) => void | Promise<void> } = {}) {
  const chatId = o.chatId ?? 'c_' + crypto.randomUUID().slice(0, 8)
  const { turn, token } = srv.turns.create(user, chatId, 'fake')
  const h = srv.launcher!.launch({
    op: 'run', turnId: turn.id, chatDir: path.join(srv.cfg.agentRoot, chatId), cmd: process.execPath,
    args: [FAKE_ENGINE, '--mcp-config', '{MCP_CONFIG}'], env: { PATH: '/usr/bin:/bin', HOME: srv.cfg.agentRoot },
    token, systemPrompt: 'fake', timeoutMs: 120000, stdin: JSON.stringify(spec),
  })
  let stdout = '', stderr = '', exit: any = null
  for await (const e of h.events) {
    if (e.ev === 'started') { srv.turns.bind(turn.id, e.pgid); await o.onStarted?.(e.pid) }
    else if (e.ev === 'stdout') stdout += Buffer.from(e.b64, 'base64').toString()
    else if (e.ev === 'stderr') stderr += Buffer.from(e.b64, 'base64').toString()
    else if (e.ev === 'exit' || e.ev === 'error') exit = e
  }
  srv.turns.revoke(turn.id)
  const lines = stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } })
  return { turnId: turn.id, lines, results: lines.filter((l) => l.tool), stderr, exit }
}
