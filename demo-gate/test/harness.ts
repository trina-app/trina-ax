// Test harness: a real Node gate process with a fake instance command (./fake-instance.ts), a fake model upstream and
// a fake Turnstile verify endpoint (both in the test process). Nothing here is a real secret.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'

export const ROOT = path.resolve(import.meta.dir, '..', '..')
export const NODE = Bun.which('node')
export const FAKE_CREDENTIAL = 'sk-ant-oat01-' + 'f'.repeat(40) // a made-up token-shaped string
export const DUMMY_CREDENTIAL = 'sk-ant-oat01-' + '0'.repeat(40)

export async function until<T>(f: () => T | Promise<T>, ms = 15_000, what = 'condition'): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    try { const v = await f(); if (v) return v as NonNullable<T> } catch {}
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(50)
  }
}

export interface SeenRequest { path: string; headers: Record<string, string>; body: string }
/** the fake Anthropic API: `behave` decides each answer, `seen` keeps what arrived */
export function fakeUpstream() {
  const seen: SeenRequest[] = []
  let behave: (req: Request, path: string) => Response | Promise<Response> = () => Response.json({ id: 'msg_1', type: 'message', usage: { input_tokens: 1, output_tokens: 1 } })
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0, idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const headers: Record<string, string> = {}
      req.headers.forEach((v, k) => { headers[k] = v })
      seen.push({ path: url.pathname + url.search, headers, body: await req.text() })
      return behave(req, url.pathname)
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, seen, set(b: typeof behave) { behave = b }, stop: () => server.stop(true) }
}

export function fakeTurnstile() {
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      const f = new URLSearchParams(await req.text())
      if (f.get('secret') !== 'test-turnstile-secret') return Response.json({ success: false })
      const r = f.get('response')
      if (r === 'ok') return Response.json({ success: true, hostname: 'demo.trina.app' })
      if (r === 'elsewhere') return Response.json({ success: true, hostname: 'evil.example' })
      return Response.json({ success: false })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

export const SSE = (events: unknown[], extra: Record<string, string> = {}) =>
  new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', ...extra } })

let portBase = 21000 + Math.floor(Math.random() * 300) * 100

export interface Gate {
  base: string
  upstreamBase: string
  root: string
  instancesDir: string
  pauseFile: string
  log: () => string
  health(): Promise<any>
  stop(): Promise<void>
}

export interface GateOpts {
  upstream: string
  turnstile: string
  pool?: Record<string, unknown>
  limits?: Record<string, unknown>
  ai?: Record<string, unknown>
  codeVersion?: string
  snapshotVersion?: string
  locales?: string[]
  /** made before the gate starts (orphan test) */
  before?: (g: { instancesDir: string; snapshotsDir: string }) => void
}

function writeSnapshot(dir: string, locale: string, version: string, name = 'snap-1', createdAt = new Date().toISOString()) {
  const s = path.join(dir, locale, name)
  fs.mkdirSync(path.join(s, 'base', 'config'), { recursive: true })
  fs.mkdirSync(path.join(s, 'base', 'data'), { recursive: true })
  fs.mkdirSync(path.join(s, 'base', 'secrets'), { recursive: true })
  fs.writeFileSync(path.join(s, 'manifest.json'), JSON.stringify({ codeVersion: version, locale, createdAt, config: 'config/server.json', demoFile: 'demo.json' }))
  fs.writeFileSync(path.join(s, 'base', 'config', 'server.json'), JSON.stringify({
    listen: { host: '127.0.0.1', port: 1 }, dataDir: '../data',
    engine: { authMode: 'managed', modelUpstream: 'https://elsewhere.example' },
    relay: { url: 'wss://relay.example/connect', teamName: 'x' }, update: { channel: 'beta', feedUrl: 'https://feed.example', auto: true },
  }))
  fs.writeFileSync(path.join(s, 'base', 'demo.json'), '{}')
  fs.writeFileSync(path.join(s, 'base', 'data', 'seed.txt'), `seed ${locale}`)
  return s
}
export { writeSnapshot }

export async function startGate(o: GateOpts): Promise<Gate> {
  if (!NODE) throw new Error('node is not on PATH')
  const id = crypto.randomBytes(3).toString('hex')
  // short: the instances' sockets must fit 104 bytes (config refuses a long instancesDir)
  const root = `/tmp/tdg-${id}`
  const instancesDir = path.join(root, 'i')
  const snapshotsDir = path.join(root, 'snap')
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(instancesDir, { recursive: true })
  const locales = o.locales ?? ['en', 'ko']
  for (const l of locales) writeSnapshot(snapshotsDir, l, o.snapshotVersion ?? '9.9.9')
  fs.writeFileSync(path.join(root, 'cred'), FAKE_CREDENTIAL, { mode: 0o600 })
  fs.writeFileSync(path.join(root, 'turnstile'), 'test-turnstile-secret', { mode: 0o600 })
  o.before?.({ instancesDir, snapshotsDir })
  const from = (portBase += 100)
  const pauseFile = path.join(root, 'PAUSE')
  const cfg = {
    publicOrigin: 'https://demo.trina.app',
    listen: { host: '127.0.0.1', port: 0 },
    upstreamListen: { host: '127.0.0.1', port: 0 },
    stateDir: path.join(root, 'state'),
    pauseFile,
    turnstile: { siteKey: '1x00000000000000000000AA', secretFile: path.join(root, 'turnstile'), verifyUrl: o.turnstile },
    ai: { mode: 'claude-subscription', credentialFile: path.join(root, 'cred'), upstream: o.upstream, ...o.ai },
    pool: {
      snapshotsDir, instancesDir, codeVersion: o.codeVersion ?? '9.9.9', locales,
      warmPerLocale: 1, maxLive: 10, ttlHours: 24, sweepMs: 300, startTimeoutMs: 10_000,
      command: [NODE, '--disable-warning=ExperimentalWarning', path.join(ROOT, 'demo-gate/test/fake-instance.ts'), '--config', '{config}'],
      portRange: [from, from + 99],
      ...o.pool,
    },
    limits: { startsPerHour: 100, startsPerDay: 100, livePerIp: 10, maxStreams: 4, streamWaitMs: 2000, dailyWeightedTokens: 1_000_000, ...o.limits },
    links: { scriptedDemo: 'https://ax.trina.app/demo', pricing: 'https://ax.trina.app/pricing', statusOrigins: ['https://ax.trina.app'] },
  }
  const cfgFile = path.join(root, 'gate.json')
  fs.writeFileSync(cfgFile, JSON.stringify(cfg))
  const logFile = path.join(root, 'gate.log')
  const fd = fs.openSync(logFile, 'a')
  const p = Bun.spawn([NODE, '--disable-warning=ExperimentalWarning', path.join(ROOT, 'demo-gate/src/main.ts'), '--config', cfgFile], {
    cwd: ROOT, stdout: fd, stderr: fd,
    // a value the instances must never see (their env is built from scratch)
    env: { ...process.env, GATE_ONLY_VALUE: 'must-not-leak' },
  })
  const log = () => { try { return fs.readFileSync(logFile, 'utf8') } catch { return '' } }
  const started = await until(() => {
    if (p.exitCode !== null) throw new Error('gate exited: ' + log())
    const line = log().split('\n').find((l) => l.includes('"gate started"'))
    return line ? JSON.parse(line) as { publicPort: number; upstreamPort: number } : null
  }, 15_000, 'gate start').catch((e) => { throw new Error(`${(e as Error).message}\n${log()}`) })
  const base = `http://127.0.0.1:${started.publicPort}`
  const g: Gate = {
    base, upstreamBase: `http://127.0.0.1:${started.upstreamPort}`, root, instancesDir, pauseFile, log,
    health: async () => (await fetch(`${base}/__demo/health`)).json(),
    async stop() {
      p.kill('SIGTERM')
      await Promise.race([p.exited, Bun.sleep(10_000)])
      try { p.kill('SIGKILL') } catch {}
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
  return g
}

/** wait until each locale has a warm instance */
export async function warm(g: Gate, n = 1, locale = 'en') {
  return until(async () => ((await g.health()).pool.warmByLocale[locale] ?? 0) >= n, 15_000, `${n} warm ${locale}`)
}

export interface Visitor { ip: string; cookies: Map<string, string> }
export const visitor = (ip = `203.0.113.${1 + Math.floor(Math.random() * 250)}`): Visitor => ({ ip, cookies: new Map() })
export const cookieHeader = (v: Visitor) => [...v.cookies].map(([k, x]) => `${k}=${x}`).join('; ')
export function keepCookies(v: Visitor, r: Response) {
  for (const c of r.headers.getSetCookie()) {
    const [kv] = c.split(';')
    const i = kv!.indexOf('=')
    const k = kv!.slice(0, i), val = kv!.slice(i + 1)
    if (/max-age=0/i.test(c)) v.cookies.delete(k)
    else v.cookies.set(k, val)
  }
}
export async function get(g: Gate, v: Visitor, p: string, init: RequestInit = {}) {
  const r = await fetch(g.base + p, { redirect: 'manual', ...init, headers: { 'cf-connecting-ip': v.ip, cookie: cookieHeader(v), ...(init.headers as Record<string, string> ?? {}) } })
  keepCookies(v, r)
  return r
}
export async function startVisit(g: Gate, v: Visitor, o: { token?: string; lang?: string; origin?: string } = {}) {
  return get(g, v, '/__demo/start', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: o.origin ?? 'https://demo.trina.app' },
    body: new URLSearchParams({ lang: o.lang ?? 'en', 'cf-turnstile-response': o.token ?? 'ok' }).toString(),
  })
}

/** a raw WebSocket upgrade through the gate; resolves with the 101 head and an echo of `payload` */
export function wsEcho(port: number, p: string, cookie: string, payload: Buffer): Promise<{ head: string; echo: Buffer }> {
  return new Promise((ok, fail) => {
    const s = net.connect(port, '127.0.0.1')
    let buf = Buffer.alloc(0)
    let head = ''
    const t = setTimeout(() => { s.destroy(); fail(new Error('ws timeout: ' + head + buf.toString())) }, 5000)
    s.on('connect', () => s.write(`GET ${p} HTTP/1.1\r\nHost: demo.trina.app\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nOrigin: https://demo.trina.app\r\nCookie: ${cookie}\r\ncf-connecting-ip: 203.0.113.9\r\n\r\n`))
    s.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      if (!head) {
        const i = buf.indexOf('\r\n\r\n')
        if (i < 0) return
        head = buf.subarray(0, i).toString('latin1')
        buf = buf.subarray(i + 4)
        if (!head.startsWith('HTTP/1.1 101')) { clearTimeout(t); s.destroy(); return ok({ head, echo: Buffer.alloc(0) }) }
        s.write(payload)
      }
      if (buf.length >= payload.length) { clearTimeout(t); s.destroy(); ok({ head, echo: buf.subarray(0, payload.length) }) }
    })
    s.on('error', (e) => { clearTimeout(t); fail(e) })
  })
}
