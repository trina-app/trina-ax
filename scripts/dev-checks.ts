// Checks `bun run dev` makes before it starts anything (scripts/dev.ts).
//
// - Ports: the dev ports are fixed (19100 server, 19161 relay, 19140 vite; TEAM_AX_DEV_PORT / TEAM_AX_DEV_RELAY_PORT
//   move the first two), so a second `bun run dev`, the dev service (`bun run dev:service`) or any other program on
//   them used to give a half-started setup with a bare EADDRINUSE from one child. Now the runner says which process holds which port, and how to free it.
// - Data folder: the engine's Unix sockets live under <data>/run, and a socket path holds at most 103 bytes on
//   macOS; a long data folder used to fail only at the first chat ("The AI engine stopped unexpectedly").
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { engineSockets, maxSocketPathBytes, socketPathMessage, tooLongSockets, underSandboxDeniedTmp } from '../server/src/system/sockets'

export interface PortHolder { pid: number; command: string }

/** Who listens on this TCP port (lsof; empty when nobody does or lsof is missing). */
export function portHolders(port: number): PortHolder[] {
  const lsof = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((p) => fs.existsSync(p)) ?? Bun.which('lsof')
  if (!lsof) return []
  const r = Bun.spawnSync([lsof, '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { stdout: 'pipe', stderr: 'ignore' })
  const pids = [...new Set(r.stdout.toString().split('\n').filter((l) => l.startsWith('p')).map((l) => Number(l.slice(1))).filter((n) => n > 0))]
  return pids.map((pid) => {
    const ps = Bun.spawnSync(['/bin/ps', '-o', 'command=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' })
    return { pid, command: ps.stdout.toString().trim() || '?' }
  })
}

/** Can this process listen on 127.0.0.1:port right now? */
export function canListen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)))
  })
}

export interface PortCheck { port: number; what: string }

/** One problem line per port that is taken (empty array: all free). */
export async function checkPorts(ports: PortCheck[], holders: (port: number) => PortHolder[] = portHolders): Promise<string[]> {
  const out: string[] = []
  for (const p of ports) {
    const who = holders(p.port)
    if (!who.length && (await canListen(p.port))) continue
    const by = who.length ? who.map((h) => `pid ${h.pid}: ${h.command.length > 160 ? h.command.slice(0, 157) + '...' : h.command}`).join('; ') : 'another program (lsof could not tell which)'
    const ours = who.some((h) => /server\/src\/main\.ts|relay\/src\/main\.ts|scripts\/dev\.ts|vite/.test(h.command))
    const hint = ours
      ? 'This looks like another `bun run dev` or the dev service: stop it with `bun run dev:service stop` (or Ctrl-C in its terminal).'
      : `Stop that program, or find it with \`lsof -nP -iTCP:${p.port} -sTCP:LISTEN\`.`
    out.push(`port ${p.port} (${p.what}) is in use by ${by}. ${hint}`)
  }
  return out
}

/** Problems with the data folder's engine sockets: errors stop the dev runner, warnings are printed. */
export function checkDataDir(dataDir: string, platform: NodeJS.Platform = process.platform): { errors: string[]; warnings: string[] } {
  const runDir = path.join(dataDir, 'run')
  const long = tooLongSockets(engineSockets(runDir), platform)
  const errors = long.length ? [`${socketPathMessage(long, true)} (data folder ${dataDir}; limit ${maxSocketPathBytes(platform)} bytes)`] : []
  const warnings = platform === 'darwin' && underSandboxDeniedTmp(dataDir)
    ? [`the data folder ${dataDir} is under a temporary folder (/tmp, /private/var/folders): the engine sandbox denies it, so chats can fail. Use a short folder in your home (the default ~/.team-ax-dev).`]
    : []
  return { errors, warnings }
}
