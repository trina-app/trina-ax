// Explicit live entrypoint. Merely importing this file never opens files, starts an engine or reads credentials.
import fs from 'node:fs'
import path from 'node:path'
import type { P2Limits, P2SmokeMarker } from './p2-smoke-preflight'

export interface P2Args { command: 'check' | 'attest' | 'execute'; values: Record<string, string> }
export function parseP2Args(argv: string[]): P2Args {
  const command = argv[0] ?? 'check'
  if (!['check', 'attest', 'execute'].includes(command)) throw new Error('P2_ARGUMENTS')
  const allowed = command === 'attest'
    ? ['run-id', 'expires-at', 'model', 'server-user', 'agent-user', 'provider-requests', 'engine-attempts', 'tool-turns', 'turn-timeout-ms', 'total-timeout-ms']
    : command === 'execute' ? ['run-id', 'provider-requests'] : []
  const values: Record<string, string> = {}
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2), value = argv[i + 1]
    if (!argv[i]?.startsWith('--') || !key || !allowed.includes(key) || Object.hasOwn(values, key) || !value || value.startsWith('--')) throw new Error('P2_ARGUMENTS')
    values[key] = value
  }
  if (allowed.some(k => !Object.hasOwn(values, k))) throw new Error('P2_ARGUMENTS')
  if (values['run-id'] && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values['run-id'])) throw new Error('P2_ARGUMENTS')
  for (const k of ['provider-requests', 'engine-attempts', 'tool-turns', 'turn-timeout-ms', 'total-timeout-ms']) {
    if (k in values && (!/^[1-9][0-9]*$/.test(values[k]!) || !Number.isSafeInteger(Number(values[k])))) throw new Error('P2_ARGUMENTS')
  }
  return { command: command as P2Args['command'], values }
}

/** No inherited provider tokens, login HOME, preload hooks, upstream overrides or model environment. */
export function p2WorkerEnvironment(): Record<string, string> {
  return { HOME: '/var/lib/mycel-p2-smoke/data', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    NODE_ENV: 'production', LANG: 'C.UTF-8', TZ: 'UTC', MYCEL_INSTALL_BASE: '/var/lib/mycel-p2-smoke', MYCEL_LABEL: 'mycel-p2-smoke' }
}

function serviceState(unit: 'server' | 'launcher', expected: 'active' | 'inactive') {
  const p = Bun.spawnSync(['/usr/bin/systemctl', 'is-active', `mycel-p2-smoke-${unit}.service`], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  if (p.stdout.toString().trim() !== expected || p.exitCode !== (expected === 'active' ? 0 : 3)) throw new Error('P2_SERVICE_STATE')
}

export async function p2Main(argv: string[]): Promise<number> {
  const args = parseP2Args(argv)
  if (process.platform !== 'linux') throw new Error('P2_LINUX_REQUIRED')
  // Clear BEFORE importing app modules whose constants may consult process.env.
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, p2WorkerEnvironment())
  const preflight = await import('./p2-smoke-preflight')
  const { P2_SMOKE_BASE: base, P2_SMOKE_MARKER: markerFile, P2_SMOKE_ID: id } = preflight
  serviceState('server', 'inactive'); serviceState('launcher', 'active')
  if (args.command === 'attest') {
    const io = preflight.p2PreflightIO(), now = Date.now(), values = args.values
    const attestation = preflight.collectP2RootAttestation(io, now)
    const server = io.account(values['server-user']!), agent = io.account(values['agent-user']!)
    if (!server || !agent || server.uid === agent.uid || server.uid < 100 || server.uid > 999 || agent.uid < 100 || agent.uid > 999) throw new Error('P2_ACCOUNT_IDENTITY')
    const limits: P2Limits = { providerRequests: Number(values['provider-requests']), engineAttempts: Number(values['engine-attempts']), toolTurns: Number(values['tool-turns']),
      turnTimeoutMs: Number(values['turn-timeout-ms']), totalTimeoutMs: Number(values['total-timeout-ms']) }
    const expires = Date.parse(values['expires-at']!)
    if (!Number.isFinite(expires) || expires < now + limits.totalTimeoutMs || expires > now + 7200000 || limits.totalTimeoutMs > 7200000
      || limits.turnTimeoutMs > limits.totalTimeoutMs || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/.test(values.model!)) throw new Error('P2_ARGUMENTS')
    const bundleDir = io.realpath(`${base}/app/current`)
    if (!new RegExp(`^${base}/app/versions/[0-9A-Za-z][0-9A-Za-z.+_-]{0,49}$`).test(bundleDir)) throw new Error('P2_BUNDLE_PATH')
    const marker: P2SmokeMarker = { schema: 1, purpose: 'p2-linux-claude-smoke', id, base, runId: values['run-id']!, expiresAt: new Date(expires).toISOString(),
      configSha256: io.sha256(`${base}/config/server.json`), bundleManifestSha256: io.sha256(`${bundleDir}/manifest.json`),
      server: { name: server.name, uid: server.uid, gid: server.gid }, agent: { name: agent.name, uid: agent.uid, gid: agent.gid },
      model: values.model!, credentialFile: `${base}/secrets/p2-claude.json`, limits, ...attestation }
    const fd = fs.openSync(markerFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    try { fs.fchownSync(fd, 0, server.gid); fs.fchmodSync(fd, 0o640); fs.writeFileSync(fd, JSON.stringify(marker) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    const dir = fs.openSync(path.dirname(markerFile), fs.constants.O_RDONLY)
    try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
    process.stdout.write(JSON.stringify({ schema: 1, status: 'attested', runId: marker.runId }) + '\n')
    return 0
  }
  const plan = preflight.preflightP2Smoke()
  if (args.command === 'check') {
    process.stdout.write(JSON.stringify({ schema: 1, status: 'ready', runId: plan.marker.runId, modelRequests: 0 }) + '\n')
    return 0
  }
  if (args.values['run-id'] !== plan.marker.runId || Number(args.values['provider-requests']) !== plan.marker.limits.providerRequests) throw new Error('P2_EXECUTION_CONFIRMATION')
  const { claimP2Receipt, readP2Credential, prepareP2Fixture } = await import('./p2-smoke-prepare')
  const receipt = claimP2Receipt(plan.receiptFile, plan.marker.runId, plan.marker.limits)
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  let db: import('bun:sqlite').Database | undefined, closeDb = true
  try {
    const fixture = await prepareP2Fixture(plan, readP2Credential(plan.credentialFile, plan.marker.server.uid))
    db = fixture.db
    if (controller.signal.aborted) throw new Error('P2_INTERRUPTED')
    const { runInstalledSmoke } = await import('./p2-smoke-installed')
    closeDb = false // A failed/unfinished context may still own SQLite; do not close underneath it.
    const report = await runInstalledSmoke({ cfg: plan.config, db, runId: plan.marker.runId, users: fixture.users, credentialId: fixture.credentialId,
      model: plan.marker.model, files: fixture.files, limits: plan.marker.limits, persistAdmission: counts => receipt.persist(counts), signal: controller.signal,
      assertToolsSocket: () => preflight.assertP2ToolsSocket(plan) })
    closeDb = report.cleanup?.contextClosed === true
    receipt.finish(controller.signal.aborted ? 'interrupted' : report.ok ? 'passed' : 'failed')
    process.stdout.write(JSON.stringify({ schema: 1, runId: plan.marker.runId, scope: 'reviewed-source-api-and-installed-native',
      configSha256: plan.marker.configSha256, bundleManifestSha256: plan.marker.bundleManifestSha256, ...report }) + '\n')
    return report.ok && !controller.signal.aborted ? 0 : 1
  } catch {
    try { receipt.finish(controller.signal.aborted ? 'interrupted' : 'failed') } catch {}
    throw new Error(controller.signal.aborted ? 'P2_INTERRUPTED' : 'P2_SMOKE_FAILED')
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
    try { if (closeDb) db?.close() }
    finally {
      try { receipt.close() }
      finally {
        // Product startup can fail before registering its MCP closer. After the durable failed receipt/report,
        // bound this worker's lifetime; the external systemd cgroup deadline additionally covers native children.
        if (!closeDb) { process.exitCode = 1; setTimeout(() => process.exit(1), 1000).unref() }
      }
    }
  }
}

if (import.meta.main) {
  try { process.exitCode = await p2Main(process.argv.slice(2)) }
  catch (e) {
    const message = e instanceof Error ? e.message : ''
    process.stderr.write(JSON.stringify({ schema: 1, status: 'failed', code: /^P2_[A-Z_]+$/.test(message) ? message : 'P2_SMOKE_FAILED' }) + '\n')
    process.exitCode = 1
  }
}
