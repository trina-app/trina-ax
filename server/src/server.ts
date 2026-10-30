// Engine core (stage 1): DB, file service, turn registry, MCP socket behind the native gate, optional local
// launcher. The HTTP app (app.ts / main.ts) starts it on first use through AppContext.core().
import fs from 'node:fs'
import path from 'node:path'
import type { Subprocess } from 'bun'
import type { Database } from 'bun:sqlite'
import { openDb } from './db'
import type { ServerConfig } from './config'
import { FileService } from './files/service'
import { TurnRegistry } from './turns'
import { startMcpSocket } from './mcp/socket'
import { SocketLauncher, startGate, startLauncher, type Launcher, type LauncherSandbox } from './native'
import { ModelProxyService, type ProxyServiceOptions } from './proxy/subscription'
import type { CredentialBroker } from './credentials/broker'

export interface Running {
  cfg: ServerConfig
  db: ReturnType<typeof openDb>
  files: FileService
  turns: TurnRegistry
  toolsSock: string
  launcherSock: string
  launcher: Launcher | null
  /** the model proxy the engine account talks through: model requests (the turn's AI connection swapped in) and
   * CONNECT tunnels (office local-login, the ChatGPT sign-in). Production and managed mode; null otherwise. */
  proxy: ModelProxyService | null
  rejected: () => { reason: string }[]
  close(): Promise<void>
}

/** Model-proxy peer check: the TCP client must be a process of the turn's engine session (lookup done by the launcher). */
export function proxyPeerCheck(srv: Running) {
  return async (clientPort: number, serverPort: number, turnId: string) => {
    const t = srv.turns.get(turnId)
    const l = srv.launcher as SocketLauncher | null
    if (!t || t.pgid === null || !l?.tcpPeer) return false
    const p = await l.tcpPeer(clientPort, serverPort)
    return !!p && p.sid === t.pgid
  }
}

/** proxy options for this core: the TCP peer of a request / tunnel must belong to the turn's engine session, asked of
 * this core's launcher */
function coreProxyOptions(running: Running, o: Omit<ProxyServiceOptions, 'db' | 'peerCheck'>): ProxyServiceOptions {
  const l = () => running.launcher as SocketLauncher | null
  return {
    ...o, db: running.db, peerCheck: proxyPeerCheck(running),
    // a turn stopped a moment ago that already ended is no longer registered: its row says 'stopped'
    stopReason: (turnId) => running.turns.get(turnId)?.stopReason
      ?? ((running.db.query('SELECT status FROM turns WHERE id = ?').get(turnId) as { status: string } | null)?.status === 'stopped' ? 'stopped' : null),
    connect: {
      ...o.connect,
      turnSession: (turnId) => running.turns.get(turnId)?.pgid ?? null,
      peerSession: async (clientPort, serverPort) => (await l()?.tcpPeer?.(clientPort, serverPort))?.sid ?? null,
    },
  }
}

/** Start the model proxy for a core started without one (tests): tunnels only when `broker` is null. Waits for the
 * bind and throws when the port is taken. Stops with srv.close(). */
export async function startEngineProxy(srv: Running, o: {
  port?: number; broker?: CredentialBroker | null; codexModels?: () => string[]; secretsDir?: string; connectHosts?: string[]; codexTurns?: boolean
  dial?: (host: string, port: number) => import('node:net').Socket
  log?: ProxyServiceOptions['log']
}) {
  const svc = new ModelProxyService(coreProxyOptions(srv, {
    port: o.port ?? 0, broker: o.broker ?? null, secretsDir: o.secretsDir ?? srv.cfg.dataDir, ...(o.codexModels ? { codexModels: o.codexModels } : {}), ...(o.log ? { log: o.log } : {}),
    connect: { ...(o.connectHosts ? { hosts: o.connectHosts } : {}), ...(o.codexTurns ? { codexTurns: true } : {}), ...(o.dial ? { dial: o.dial } : {}) },
  })).start()
  await svc.started
  if (!svc.ready) throw new Error(`model proxy could not listen on 127.0.0.1:${o.port ?? 0}`)
  srv.proxy = svc
  return svc
}

export interface StartOptions {
  launcher?: { allowCmds: string[]; sessionRoots?: string[]; sandbox?: LauncherSandbox; codexAuthDir?: string; proxyPort?: number }
  externalLauncher?: string
  toolsSockMode?: string
  /** reuse an open DB / file service (the HTTP server owns them); otherwise opened here and closed by close() */
  db?: Database
  files?: FileService
  /** run the model proxy (peer checks through this core's launcher) */
  modelProxy?: Omit<ProxyServiceOptions, 'db' | 'peerCheck'>
}

export async function startServer(cfg: ServerConfig, o: StartOptions = {}): Promise<Running> {
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(cfg.runDir, { recursive: true, mode: 0o755 })
  const ownDb = !o.db
  const db = o.db ?? openDb(path.join(cfg.dataDir, 'app.db'))
  const files = o.files ?? new FileService(db, cfg)
  const turns = new TurnRegistry(db, cfg.agentUid)
  const mcp = startMcpSocket(path.join(cfg.runDir, 'private', 'server.sock'), files, db, turns)
  const toolsSock = path.join(cfg.runDir, 'tools.sock')
  const procs: Subprocess<any, any, any>[] = []
  procs.push(await startGate(cfg.nativeBin, toolsSock, mcp.path, mcp.secret, o.toolsSockMode ?? '0600'))
  const launcherSock = path.join(cfg.runDir, 'private', 'launcher.sock')
  let launcher: Launcher | null = o.externalLauncher ? new SocketLauncher(o.externalLauncher) : null
  if (o.launcher) {
    procs.push(await startLauncher(cfg.nativeBin, { listen: launcherSock, agentRoot: cfg.agentRoot, toolsSock, allowCmds: o.launcher.allowCmds, sessionRoots: o.launcher.sessionRoots, sandbox: o.launcher.sandbox, codexAuthDir: o.launcher.codexAuthDir, proxyPort: o.launcher.proxyPort }))
    launcher = new SocketLauncher(launcherSock)
  }
  const running: Running = {
    cfg, db, files, turns, toolsSock, launcherSock, launcher, proxy: null,
    rejected: () => mcp.rejected,
    async close() { await running.proxy?.stop(); for (const p of procs) { p.kill(); await p.exited } mcp.stop(); if (ownDb) db.close() },
  }
  if (o.modelProxy) {
    running.proxy = new ModelProxyService(coreProxyOptions(running, o.modelProxy)).start()
    await running.proxy.started
  }
  return running
}
