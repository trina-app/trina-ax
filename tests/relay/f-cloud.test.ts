// The relay's cloud additions under the real runtime (Node 26 in production, any Node >= 24 here) with real processes:
// TLS with the Authenticated Origin Pulls client certificate (RL-5), an old registry file through node:sqlite (RL-1),
// the operator API on the private listener with a team server process (RL-2), closed registration (RL-3), the
// per-process health port of the a/b deploy (RL-9), and metrics (RL-6).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { generateTeamKey } from '@mycel/shared/relay-protocol'
import {
  F_WORK, REPO, makeTestPki, opsCall, opsCreateBody, spawnFakeTeam, spawnNodeRelay, teamUrl, until, waitHttp, writeOldRegistry,
  writeOpsKeys, type Proc, type TestPki,
} from '../lib/f-relay'

setDefaultTimeout(30_000)
const procs: Proc[] = []
afterAll(() => { for (const p of procs) p.kill() })
const dataDir = (tag: string) => { const d = path.join(F_WORK, `cloud-${tag}-${process.pid}`); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d }

test('node runtime: >= 24 (production pins 26 LTS)', () => {
  const v = Bun.spawnSync(['node', '--version']).stdout.toString().trim()
  expect(Number(/^v(\d+)/.exec(v)?.[1])).toBeGreaterThanOrEqual(24)
  console.log(`relay suite on node ${v}`)
})

describe('TLS with a client certificate (Authenticated Origin Pulls)', () => {
  const PORT = 19283
  let pki: TestPki
  beforeAll(async () => {
    pki = makeTestPki(path.join(F_WORK, `pki-${process.pid}`))
    procs.push(spawnNodeRelay(PORT, dataDir('tls'), { RELAY_TLS_CERT: pki.srvCrt, RELAY_TLS_KEY: pki.srvKey, RELAY_TLS_CLIENT_CA: pki.aopCaCrt }, 'cloud-tls'))
    const ca = fs.readFileSync(pki.caCrt, 'utf8'), cert = fs.readFileSync(pki.cliCrt, 'utf8'), key = fs.readFileSync(pki.cliKey, 'utf8')
    await until(async () => { try { return (await fetch(`https://127.0.0.1:${PORT}/healthz`, { tls: { ca, cert, key } } as RequestInit)).ok } catch { return false } }, 10_000, 'tls relay up')
  })

  test('with the client certificate: served (HTTP and the WebSocket upgrade of /connect)', async () => {
    const r = await fetch(`https://127.0.0.1:${PORT}/healthz`, { tls: { ca: fs.readFileSync(pki.caCrt, 'utf8'), cert: fs.readFileSync(pki.cliCrt, 'utf8'), key: fs.readFileSync(pki.cliKey, 'utf8') } } as RequestInit)
    expect(r.status).toBe(200)
    const head = await new Promise<string>((resolve, reject) => {
      const s = tls.connect({ host: '127.0.0.1', port: PORT, ca: fs.readFileSync(pki.caCrt), cert: fs.readFileSync(pki.cliCrt), key: fs.readFileSync(pki.cliKey), servername: 'localhost' }, () => {
        s.write('GET /connect HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')
      })
      s.once('data', (d) => { resolve(d.toString('latin1')); s.destroy() })
      s.once('error', reject)
    })
    expect(head).toStartWith('HTTP/1.1 101')
  })
  test('without a client certificate, or with one from another CA: no TLS session at all', async () => {
    const ca = fs.readFileSync(pki.caCrt, 'utf8')
    const outcome = async (init: object) => { try { const r = await fetch(`https://127.0.0.1:${PORT}/healthz`, init as RequestInit); return `status ${r.status}` } catch { return 'refused' } }
    expect(await outcome({ tls: { ca } })).toBe('refused')
    expect(await outcome({ tls: { ca, cert: fs.readFileSync(pki.otherCrt, 'utf8'), key: fs.readFileSync(pki.otherKey, 'utf8') } })).toBe('refused')
    // and plain HTTP to the TLS port is not answered as HTTP
    expect(await outcome({})).not.toBe('status 200')
    const plain = await (async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/healthz`)).status } catch { return 'refused' } })()
    expect(plain).not.toBe(200)
  })
})

describe('an old registry file opens under node:sqlite', () => {
  test('the relay starts on it and the CLI lists the old team with origin self', async () => {
    const PORT = 19284
    const dir = dataDir('old')
    const kp = generateTeamKey()
    writeOldRegistry(path.join(dir, 'registry.db'), kp)
    const relay = spawnNodeRelay(PORT, dir, {}, 'cloud-old')
    procs.push(relay)
    await waitHttp(`http://127.0.0.1:${PORT}/healthz`, 10_000)
    relay.kill('SIGTERM')
    await relay.p.exited
    const p = Bun.spawnSync(['node', '--disable-warning=ExperimentalWarning', path.join(REPO, 'relay/src/main.ts'), 'teams', '--dev', '--data', dir], { cwd: REPO })
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString()).toMatch(/^oldteam\tsuspended\tself\tteam-old-1/m)
    const v = Bun.spawnSync(['node', '--disable-warning=ExperimentalWarning', '-e', `const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(path.join(dir, 'registry.db'))}); console.log(d.prepare('PRAGMA user_version').get().user_version)`])
    expect(v.stdout.toString().trim()).toBe('1')
  })
})

describe('operator API and closed registration, Node relay + team server process', () => {
  const PORT = 19285
  const PRIV = 19286
  const HEALTH = 19287
  let keys: ReturnType<typeof writeOpsKeys>
  let ops: string
  const cp = (m: string, p: string, b?: unknown) => opsCall(ops, 'cp', keys.keys.cp!, m, p, b)
  beforeAll(async () => {
    const dir = dataDir('ops')
    keys = writeOpsKeys(path.join(dir, 'operator-keys.json'), [{ keyId: 'cp', scopes: ['teams:read', 'teams:write', 'claims:write', 'notice:write'] }])
    procs.push(spawnNodeRelay(PORT, dir, {
      RELAY_PRIVATE_LISTEN: `127.0.0.1:${PRIV}`, RELAY_HEALTH_LISTEN: `127.0.0.1:${HEALTH}`, RELAY_OPERATOR_KEYS_FILE: keys.file,
      RELAY_OPEN_REGISTRATION: '0', RELAY_HOLD_MS: '500',
    }, 'cloud-ops'))
    ops = `http://127.0.0.1:${PRIV}`
    await waitHttp(`http://127.0.0.1:${PORT}/healthz`, 10_000)
  })

  test('health port of this process: version and pid (a/b deploy)', async () => {
    const h = (await (await fetch(`http://127.0.0.1:${HEALTH}/healthz`)).json()) as { ok: boolean; version: string; pid: number }
    expect(h.ok).toBe(true)
    expect(h.pid).toBeGreaterThan(0)
    expect((await fetch(`http://127.0.0.1:${HEALTH}/ops/v1/stats`)).status).toBe(404)
  })
  test('public: /ops is 404, registration closed; private: signed calls work, a replay is refused', async () => {
    expect((await fetch(`http://127.0.0.1:${PORT}/ops/v1/stats`)).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${PORT}/teams`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' })).status).toBe(403)
    const s = await cp('GET', '/ops/v1/stats')
    expect(s.status).toBe(200)
    expect((await fetch(`${ops}/ops/v1/stats`, { headers: { authorization: s.auth } })).status).toBe(409)
    expect((await fetch(`${ops}/ops/v1/stats`)).status).toBe(401)
  })
  test('a team made by the operator API: its server connects with its own key, suspend shows the billing page', async () => {
    const kp = generateTeamKey()
    const created = await cp('POST', '/ops/v1/teams', opsCreateBody('omega', kp, 'cp-omega'))
    expect(created.status).toBe(201)
    const teamId = (created.json as { teamId: string }).teamId
    const keyFile = path.join(F_WORK, `omega-${process.pid}.pem`)
    fs.writeFileSync(keyFile, kp.privatePem, { mode: 0o600 })
    procs.push(spawnFakeTeam({ RELAY_URL: `ws://127.0.0.1:${PORT}/connect`, TEAM_ID: teamId, KEY_FILE: keyFile }, `cloud-omega-${process.pid}`))
    await waitHttp(teamUrl(PORT, 'omega', '/hello'), 10_000)
    expect((await cp('GET', `/ops/v1/teams/${teamId}`)).json).toMatchObject({ online: true, origin: 'cloud' })
    expect((await cp('POST', `/ops/v1/teams/${teamId}/suspend`, { reason: 'billing' })).status).toBe(200)
    const page = await fetch(teamUrl(PORT, 'omega', '/'), { headers: { accept: 'text/html' } })
    expect([page.status, page.headers.get('x-relay-error')]).toEqual([403, 'team_suspended_billing'])
    await until(async () => !((await cp('GET', `/ops/v1/teams/${teamId}`)).json as { online: boolean }).online, 5000, 'team server cut')
    const metrics = await (await fetch(`${ops}/metrics`)).text()
    expect(metrics).toContain('relay_teams{status="suspended"} 1')
    expect(metrics).toContain('relay_registrations_total{kind="operator"} 1')
    expect(metrics).not.toContain(teamId)
  })
})
