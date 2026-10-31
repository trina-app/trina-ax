// F2 sleep and wake under the real relay runtime (Node) with real processes: the control plane marks a hosted team
// asleep (operator API), the team server goes away, and a visitor's request makes the relay ask a fake control plane to
// wake it (signed MycelRelayWake request). Browsers get the reloading "Waking up your team" page, API calls a
// retryable 503, WebSockets close 1013; once the fake control plane starts the team server, requests are forwarded
// (an OAuth callback with its query intact) and the sleep flag is gone. busy / unknown answers, and a relay without
// RELAY_WAKE_URL (feature off).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { generateTeamKey } from '@mycel/shared/relay-protocol'
import { WAKE_API_PATH, parseWakeAuthorizationHeader, parseWakeRequest, wakeSigningString } from '@mycel/shared/cloud-protocol/relay-ops'
import { F_WORK, opsCall, opsCreateBody, spawnFakeTeam, spawnNodeRelay, teamUrl, until, waitHttp, writeOpsKeys, type Proc } from '../lib/f-relay'

setDefaultTimeout(60_000)
const PORT = 19295, PRIV = 19296, CP_PORT = 19297, PORT_OFF = 19298, PRIV_OFF = 19299
const procs: Proc[] = []
const dataDir = (tag: string) => { const d = path.join(F_WORK, `sleep-${tag}-${process.pid}`); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d }

// the relay's wake key; the fake control plane pins its public half
const wakeKey = crypto.generateKeyPairSync('ed25519')
const dir = dataDir('main')
const wakeKeyFile = path.join(dir, 'wake-key.pem')
fs.writeFileSync(wakeKeyFile, wakeKey.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })

interface WakeCall { teamId: string; reason: string; ts: number; sigOk: boolean }
const calls: WakeCall[] = []
/** answer per team id; 'start' = answer waking and start that team's server (the VM resumes) */
const answers = new Map<string, { state: string; retryAfterSec: number; start?: () => void }>()
let cpServer: ReturnType<typeof Bun.serve> | null = null

let keys: ReturnType<typeof writeOpsKeys>
const cp = (base: string, m: string, p: string, b?: unknown) => opsCall(base, 'cp', keys.keys.cp!, m, p, b)
const ops = `http://127.0.0.1:${PRIV}`

interface Team { id: string; name: string; env: Record<string, string>; proc: Proc | null }
async function makeTeam(name: string, base = ops, port = PORT): Promise<Team> {
  const kp = generateTeamKey()
  const created = await cp(base, 'POST', '/ops/v1/teams', opsCreateBody(name, kp, `cp-${name}`))
  expect(created.status).toBe(201)
  const id = (created.json as { teamId: string }).teamId
  const keyFile = path.join(dir, `${name}-${port}.pem`)
  fs.writeFileSync(keyFile, kp.privatePem, { mode: 0o600 })
  const t: Team = { id, name, env: { RELAY_URL: `ws://127.0.0.1:${port}/connect`, TEAM_ID: id, KEY_FILE: keyFile }, proc: null }
  start(t)
  await waitHttp(teamUrl(port, name, '/hello'), 10_000)
  return t
}
function start(t: Team) { t.proc = spawnFakeTeam(t.env, `sleep-${t.name}-${process.pid}-${Date.now()}`); procs.push(t.proc) }
/** the control plane hibernates the VM: sleep flag on, then the team server is gone */
async function sleep(t: Team, base = ops) {
  const r = await cp(base, 'POST', `/ops/v1/teams/${t.id}/sleep`, { sleeping: true })
  expect(r.status).toBe(200)
  expect((r.json as { sleepingSince: string | null }).sleepingSince).toBeString()
  t.proc!.kill()
  await t.proc!.p.exited
  await until(async () => !((await cp(base, 'GET', `/ops/v1/teams/${t.id}`)).json as { online: boolean }).online, 10_000, 'team offline')
}

beforeAll(async () => {
  cpServer = Bun.serve({
    port: CP_PORT, hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url)
      if (req.method !== 'POST' || u.pathname !== WAKE_API_PATH) return new Response('no', { status: 404 })
      const body = await req.text()
      const auth = parseWakeAuthorizationHeader(req.headers.get('authorization'))
      const b = parseWakeRequest(JSON.parse(body))
      if (!auth || !b.ok || auth.keyId !== 'relay-test') return Response.json({ error: { code: 'unauthorized' } }, { status: 401 })
      const sigOk = crypto.verify(null, Buffer.from(wakeSigningString(WAKE_API_PATH, auth.ts, body)), wakeKey.publicKey, Buffer.from(auth.sig, 'base64'))
      calls.push({ teamId: b.value.teamId, reason: b.value.reason, ts: auth.ts, sigOk })
      if (!sigOk) return Response.json({ error: { code: 'unauthorized' } }, { status: 401 })
      const a = answers.get(b.value.teamId) ?? { state: 'unknown', retryAfterSec: 0 }
      a.start?.()
      return Response.json({ state: a.state, retryAfterSec: a.retryAfterSec })
    },
  })
  keys = writeOpsKeys(path.join(dir, 'operator-keys.json'), [{ keyId: 'cp', scopes: ['teams:read', 'teams:write'] }])
  const common = { RELAY_OPERATOR_KEYS_FILE: keys.file, RELAY_OPEN_REGISTRATION: '0', RELAY_HOLD_MS: '300' }
  procs.push(spawnNodeRelay(PORT, dir, {
    ...common, RELAY_PRIVATE_LISTEN: `127.0.0.1:${PRIV}`,
    RELAY_WAKE_URL: `http://127.0.0.1:${CP_PORT}`, RELAY_WAKE_KEY_FILE: wakeKeyFile, RELAY_WAKE_KEY_ID: 'relay-test',
    RELAY_WAKE_HOLD_MS: '4000', RELAY_WAKE_PAGE_MS: '400',
  }, `sleep-main-${process.pid}`))
  procs.push(spawnNodeRelay(PORT_OFF, dataDir('off'), { ...common, RELAY_PRIVATE_LISTEN: `127.0.0.1:${PRIV_OFF}` }, `sleep-off-${process.pid}`))
  await waitHttp(`http://127.0.0.1:${PORT}/healthz`, 10_000)
  await waitHttp(`http://127.0.0.1:${PORT_OFF}/healthz`, 10_000)
})
afterAll(() => { for (const p of procs) p.kill(); cpServer?.stop(true) })

describe('a sleeping team that stays asleep (the control plane answers waking)', () => {
  let t: Team
  beforeAll(async () => {
    t = await makeTeam('sleepy')
    answers.set(t.id, { state: 'waking', retryAfterSec: 4 })
    await sleep(t)
  })

  test('browser: the waking page (503, Retry-After 3) reloads the same address and does not echo it', async () => {
    const r = await fetch(teamUrl(PORT, 'sleepy', '/inbox?secret=s3cr3t'), { headers: { accept: 'text/html' } })
    expect([r.status, r.headers.get('x-relay-error'), r.headers.get('retry-after')]).toEqual([503, 'team_waking', '3'])
    const html = await r.text()
    expect(html).toContain('<meta http-equiv="refresh" content="3">')
    expect(html).toContain('Waking up your team')
    expect(html).not.toContain('s3cr3t')
    const ko = await fetch(teamUrl(PORT, 'sleepy', '/'), { headers: { accept: 'text/html', cookie: 'mycel_locale=ko' } })
    expect(await ko.text()).toContain('팀을 깨우고 있어요')
  })
  test('the wake call is signed, says http, and is made once per team in 10 s', async () => {
    const mine = calls.filter((c) => c.teamId === t.id)
    expect(mine.length).toBe(1)
    expect(mine[0]).toMatchObject({ reason: 'http', sigOk: true })
  })
  test('API / desktop / mobile: held, then a retryable 503 team_waking with the control plane\'s Retry-After', async () => {
    const t0 = Date.now()
    const r = await fetch(teamUrl(PORT, 'sleepy', '/api/me'), { headers: { accept: 'application/json' } })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(3500)
    expect([r.status, r.headers.get('retry-after')]).toEqual([503, '4'])
    expect(await r.json()).toMatchObject({ error: { code: 'unavailable', reason: 'team_waking', retryAfter: 4 } })
  })
  test('WebSocket: held, then closed 1013', async () => {
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(teamUrl(PORT, 'sleepy', '/chat').replace('http:', 'ws:'))
      ws.onclose = (e) => resolve(e.code)
    })
    expect(code).toBe(1013)
  })
})

describe('the control plane wakes the team (its server starts on the wake call)', () => {
  let t: Team
  beforeAll(async () => {
    t = await makeTeam('wakeme')
    await sleep(t)
    answers.set(t.id, { state: 'waking', retryAfterSec: 3, start: () => { if (!t.proc || t.proc.p.exitCode !== null || t.proc.p.killed) start(t) } })
  })

  test('an API call waits for the wake and is forwarded; the sleep flag is gone', async () => {
    const r = await fetch(teamUrl(PORT, 'wakeme', '/hello'), { headers: { accept: 'application/json' } })
    expect(r.status).toBe(200)
    expect(calls.filter((c) => c.teamId === t.id).length).toBe(1)
    expect(((await cp(ops, 'GET', `/ops/v1/teams/${t.id}`)).json as { sleepingSince: string | null }).sleepingSince).toBeNull()
  })
  test('an OAuth callback: the waking page first, then the reload of the same URL reaches the team server intact', async () => {
    await sleep(t)
    const url = teamUrl(PORT, 'wakeme', '/api/integrations/oauth/callback?code=abc123&state=st%2Fx')
    await Bun.sleep(10_500) // past the per-team gap: this sleep needs a new wake call
    const first = await fetch(url, { headers: { accept: 'text/html' } })
    // the team server may connect within the short browser hold; either way the callback must arrive intact
    if (first.status === 503) {
      expect(first.headers.get('x-relay-error')).toBe('team_waking')
      await waitHttp(teamUrl(PORT, 'wakeme', '/hello'), 10_000)
      const again = await fetch(url, { headers: { accept: 'text/html' } })
      expect(await again.json()).toEqual({ path: '/api/integrations/oauth/callback', query: '?code=abc123&state=st%2Fx' })
    } else {
      expect(await first.json()).toEqual({ path: '/api/integrations/oauth/callback', query: '?code=abc123&state=st%2Fx' })
    }
    expect(calls.filter((c) => c.teamId === t.id).length).toBe(2)
  })
})

describe('busy and unknown answers', () => {
  test('busy: team_busy with the control plane\'s Retry-After, at once', async () => {
    const t = await makeTeam('crowded')
    answers.set(t.id, { state: 'busy', retryAfterSec: 42 })
    await sleep(t)
    const t0 = Date.now()
    const r = await fetch(teamUrl(PORT, 'crowded', '/api/me'), { headers: { accept: 'application/json' } })
    expect(Date.now() - t0).toBeLessThan(3000)
    expect([r.status, r.headers.get('x-relay-error'), r.headers.get('retry-after')]).toEqual([503, 'team_busy', '42'])
  })
  test('unknown: the usual cloud offline page', async () => {
    const t = await makeTeam('ghost')
    answers.set(t.id, { state: 'unknown', retryAfterSec: 0 })
    await sleep(t)
    const r = await fetch(teamUrl(PORT, 'ghost', '/'), { headers: { accept: 'text/html' } })
    expect([r.status, r.headers.get('x-relay-error')]).toEqual([503, 'team_offline_cloud'])
  })
})

describe('feature off (no RELAY_WAKE_URL)', () => {
  test('a sleeping team gets the offline page and no wake call is made', async () => {
    const before = calls.length
    const t = await makeTeam('offwake', `http://127.0.0.1:${PRIV_OFF}`, PORT_OFF)
    await sleep(t, `http://127.0.0.1:${PRIV_OFF}`)
    const r = await fetch(teamUrl(PORT_OFF, 'offwake', '/'), { headers: { accept: 'text/html' } })
    expect([r.status, r.headers.get('x-relay-error')]).toEqual([503, 'team_offline_cloud'])
    expect(calls.length).toBe(before)
  })
})
