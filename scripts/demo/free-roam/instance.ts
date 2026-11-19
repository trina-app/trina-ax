// One development server on a free-roam base folder (the snapshot builder's, or a clone of a snapshot), on 127.0.0.1
// only: no relay, no push gateway, no speech model download. The base folder holds everything of the instance
// (server/src/system/layout.ts, dev layout): server.json and demo.json, data/ (the database, the setup token), secrets/
// (made by the server: the connections' and Drive's keys), team/ (the team folder) and, for the demo's fakes, fakes/.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..', '..', '..')

/** inside a base folder (the demo gate's manifest names them: demo-gate/src/pool.ts) */
export const SNAPSHOT_CONFIG = 'config/server.json'
export const SNAPSHOT_DEMO_FILE = 'demo.json'
/** the server.json of a base folder: dev mode, 127.0.0.1, its data and team folders beside config/ (paths resolve from
 * config/), no file-list runs (no AI outside turns). 'snapshot': the free-roam instance's (the team's AI through the
 * gate: managed; demo-gate/src/pool.ts adds the listener port, the model upstream and the rest); 'build': this Mac's
 * local login, which the builder never uses (no AI runs) */
export const baseConfig = (use: 'build' | 'snapshot') => ({
  mode: 'dev', dataDir: '../data', teamRoot: '../team', listen: { host: '127.0.0.1', port: 0 },
  engine: { authMode: use === 'snapshot' ? 'managed' : 'local-login' }, fileList: { enabled: false },
})

export const baseLayout = (base: string) => ({
  config: path.join(base, SNAPSHOT_CONFIG),
  demo: path.join(base, SNAPSHOT_DEMO_FILE),
  data: path.join(base, 'data'),
  team: path.join(base, 'team'),
  secrets: path.join(base, 'secrets'),
  fakes: path.join(base, 'fakes'),
})

/** a free TCP port on 127.0.0.1 */
export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

/** A short temporary folder: the engine's Unix sockets live under <data>/run and macOS allows 103 bytes for their path. */
export function shortTemp(prefix: string): string {
  const roots = process.platform === 'darwin' && fs.existsSync('/private/tmp') ? ['/private/tmp', os.tmpdir()] : [os.tmpdir()]
  return fs.mkdtempSync(path.join(roots[0]!, `${prefix}-`))
}

export interface Instance { url: string; port: number; stop(): Promise<void>; output(): string }

/** The server's environment: nothing of this machine's own server configuration (MYCEL_*, TEAM_AX_*) comes along. */
export function instanceEnv(base: string, port: number, base_env: Record<string, string | undefined> = process.env): Record<string, string> {
  const L = baseLayout(base)
  const env = Object.fromEntries(Object.entries(base_env).filter(([k, v]) => v !== undefined && !/^(MYCEL_|TEAM_AX_)/.test(k))) as Record<string, string>
  return {
    ...env,
    MYCEL_CONFIG: L.config,
    MYCEL_HOST: '127.0.0.1',
    MYCEL_PORT: String(port),
    MYCEL_PUBLIC_ORIGINS: `http://127.0.0.1:${port},http://localhost:${port}`,
    MYCEL_RELAY_URL: '',
    MYCEL_PUSH_GATEWAY: '',
    MYCEL_SPEECH_PREFETCH: '0',
    MYCEL_LOG_LEVEL: 'warn',
    MYCEL_DEMO: L.demo,
  }
}

/** Start the server on `base` and wait until it answers (at most two minutes). */
export async function startInstance(base: string, o: { port?: number } = {}): Promise<Instance> {
  const port = o.port ?? await freePort()
  // in the base folder, as the gate starts each instance in its clone (the demo file's fakes.content is relative to it)
  const child = Bun.spawn([process.execPath, path.join(ROOT, 'server', 'src', 'main.ts')], { cwd: base, env: instanceEnv(base, port), stdout: 'pipe', stderr: 'pipe' })
  let out = ''
  const read = async (s: ReadableStream<Uint8Array>) => { for await (const chunk of s) out = (out + new TextDecoder().decode(chunk)).slice(-20_000) }
  void read(child.stdout)
  void read(child.stderr)
  const url = `http://127.0.0.1:${port}`
  const stop = async () => {
    if (child.exitCode !== null) return
    child.kill('SIGTERM')
    const done = await Promise.race([child.exited.then(() => true), Bun.sleep(15_000).then(() => false)])
    if (!done) { child.kill('SIGKILL'); await child.exited }
  }
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(`the server stopped (${child.exitCode}):\n${out.slice(-4000)}`)
    try { if ((await fetch(`${url}/api/setup`)).ok) return { url, port, stop, output: () => out } } catch {}
    await Bun.sleep(500)
  }
  await stop()
  throw new Error(`the server did not answer within two minutes:\n${out.slice(-4000)}`)
}

/** Copy a base folder: an APFS clone (cp -c, no bytes copied) on macOS, else a plain copy. */
export function cloneBase(from: string, to: string): void {
  if (fs.existsSync(to)) throw new Error(`${to} is there already`)
  if (process.platform === 'darwin') {
    const r = Bun.spawnSync(['cp', '-c', '-R', from, to])
    if (r.exitCode === 0) return
    fs.rmSync(to, { recursive: true, force: true })
  }
  fs.cpSync(from, to, { recursive: true, preserveTimestamps: true })
}
