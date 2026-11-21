// Demo gate entry point. Runs on Node 24+ (production: the relay's pinned Node 26):
//   node demo-gate/src/main.ts --config /path/gate.json        (or DEMO_GATE_CONFIG=/path/gate.json)
// Two loopback listeners: the public one (pages, start, the reverse proxy; the tunnel delivers demo.<domain> to it) and
// the model upstream the instances call. See demo-gate/README.md.
import fs from 'node:fs'
import http from 'node:http'
import { ConfigError, instanceUserProblem, loadConfig, readSecretFile } from './config.ts'
import { createLog } from './log.ts'
import { Pool } from './pool.ts'
import { createPublic } from './public.ts'
import { GateState } from './state.ts'
import { GateStats } from './stats.ts'
import { createUpstream } from './upstream.ts'

function listen(server: http.Server, host: string, port: number): Promise<number> {
  return new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen({ host, port, exclusive: true }, () => { server.off('error', fail); ok((server.address() as { port: number }).port) })
  })
}

async function main() {
  const args = process.argv.slice(2)
  const i = args.indexOf('--config')
  const file = i >= 0 ? args[i + 1] : process.env.DEMO_GATE_CONFIG
  if (!file) throw new ConfigError('usage: node demo-gate/src/main.ts --config <gate.json>')
  const cfg = loadConfig(file)
  const log = createLog(undefined, process.env.DEMO_GATE_QUIET === '1')
  // instances never run as the gate's own user: that user can read the credential file
  const userProblem = instanceUserProblem(cfg, process.getuid?.() ?? -1)
  if (userProblem) throw new ConfigError(userProblem)
  if (cfg.pool.allowSameUser) log.warn('instances run as the gate\'s own user (allowSameUser): tests and development only')
  // both secrets must be there and private before anything listens (the values stay in their files)
  readSecretFile(cfg.ai.credentialFile)
  readSecretFile(cfg.turnstile.secretFile)
  for (const h of [cfg.listen.host, cfg.upstreamListen.host]) if (h !== '127.0.0.1' && h !== '::1' && h !== 'localhost') throw new ConfigError('config: the gate listens on loopback only (the tunnel reaches it there)')

  let pauseSeen = { at: 0, on: false }
  const paused = () => {
    const now = Date.now()
    if (now - pauseSeen.at > 1000) pauseSeen = { at: now, on: fs.existsSync(cfg.pauseFile) }
    return pauseSeen.on
  }
  const state = new GateState(cfg.stateDir)
  const stats = new GateStats(cfg.stateDir)
  let upstreamPort = cfg.upstreamListen.port
  const pool = new Pool(cfg, log, () => `http://127.0.0.1:${upstreamPort}`, paused)
  // time active, never instance lifetime: an instance lives on to its ttl whether the visitor is there or not
  pool.onEnded = (inst, why) => {
    if (!inst.assignedAt || why === 'persona_failed') return
    const last = inst.sockets ? Date.now() : inst.lastSeenAt ?? inst.assignedAt
    stats.duration(inst.locale, last - inst.assignedAt)
  }
  const upstream = createUpstream({ cfg, log, state, stats, paused, instance: (id, secret) => pool.bySecret(id, secret) })
  upstreamPort = await listen(upstream.server, cfg.upstreamListen.host, cfg.upstreamListen.port)
  const pub = createPublic({ cfg, log, pool, state, stats, paused, upstreamStatus: () => upstream.status() })
  const publicPort = await listen(pub.server, cfg.listen.host, cfg.listen.port)
  pool.start()
  log.info('gate started', { publicPort, upstreamPort, mode: cfg.ai.mode, codeVersion: cfg.pool.codeVersion, maxLive: cfg.pool.maxLive })

  let stopping = false
  const stop = async (sig: string) => {
    if (stopping) return
    stopping = true
    log.info('gate stopping', { signal: sig })
    pub.close()
    pub.server.close()
    upstream.server.close()
    await pool.stop()
    state.flush()
    stats.flush()
    process.exit(0)
  }
  process.on('SIGTERM', () => void stop('SIGTERM'))
  process.on('SIGINT', () => void stop('SIGINT'))
}

main().catch((e) => {
  process.stderr.write(`demo-gate: ${e instanceof ConfigError ? e.message : (e as Error)?.stack ?? e}\n`)
  process.exit(1)
})
