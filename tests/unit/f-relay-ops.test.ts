// Relay operator API (control-plane RL-2, RL-3, RL-4, RL-6) in one process (Bun): the private listener only (the
// public one says 404), signatures, clock, replay, scopes, idempotent writes, the audit, closed registration with
// claim codes, the cloud pages (billing suspension, maintenance, cloud offline), renamed-address 308, /metrics without
// team labels, and no visitor IP in the relay log.
// The same relay under Node with real processes: tests/relay/f-cloud.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import path from 'node:path'
import {
  generateTeamKey, keyRotationString, loadPrivateKey, registerSigningString, signB64, type RelayEvent, type TeamKeyPair,
} from '@mycel/shared/relay-protocol'
import { OperatorTeamInfoSchema, OpsStatsSchema } from '@mycel/shared/cloud-protocol'
import type { RelayClient } from '../../server/src/relay-client/client.ts'
import { F_WORK, client, opsCall, opsCreateBody, startRelay, teamUrl, until, writeOpsKeys, type InProcessRelay, type OpsKeySet } from '../lib/f-relay'

const PORT = 19281
let R: InProcessRelay
let K: OpsKeySet
let ops: string
const events: RelayEvent[] = []

const cp = (method: string, p: string, body?: unknown, o?: Parameters<typeof opsCall>[6]) => opsCall(ops, 'cp', K.keys.cp!, method, p, body, o)
const app = async (req: Request) => {
  const u = new URL(req.url)
  if (u.pathname === '/own-hsts') return new Response('x', { headers: { 'strict-transport-security': 'max-age=60' } })
  return Response.json({ path: u.pathname })
}
const html = { accept: 'text/html' }

beforeAll(async () => {
  K = writeOpsKeys(path.join(F_WORK, `ops-keys-${process.pid}.json`), [
    { keyId: 'cp', scopes: ['teams:read', 'teams:write', 'claims:write', 'notice:write'] },
    { keyId: 'reader', scopes: ['teams:read'] },
    { keyId: 'claimer', scopes: ['claims:write'] },
  ])
  R = await startRelay(PORT, { RELAY_PRIVATE_LISTEN: '127.0.0.1:0', RELAY_OPERATOR_KEYS_FILE: K.file, RELAY_OPEN_REGISTRATION: '0', RELAY_HOLD_MS: '200' })
  ops = `http://127.0.0.1:${R.relay.privatePort}`
})
afterAll(async () => { await R.stop() })

describe('operator API: where and who', () => {
  test('only on the private listener: /ops and /metrics are 404 on the public one', async () => {
    expect((await fetch(`${R.base}/ops/v1/stats`)).status).toBe(404)
    expect((await fetch(`${R.base}/metrics`)).status).toBe(404)
    // even correctly signed
    expect((await opsCall(R.base, 'cp', K.keys.cp!, 'GET', '/ops/v1/stats')).status).toBe(404)
    expect((await cp('GET', '/ops/v1/stats')).status).toBe(200)
  })
  test('refused: no signature, unknown key, bad signature, old or future timestamp', async () => {
    const r1 = await cp('GET', '/ops/v1/stats', undefined, { auth: null })
    expect([r1.status, (r1.json as { error: { code: string } }).error.code]).toEqual([401, 'unauthorized'])
    expect((await opsCall(ops, 'nobody', K.keys.cp!, 'GET', '/ops/v1/stats')).status).toBe(401)
    expect((await opsCall(ops, 'cp', generateTeamKey(), 'GET', '/ops/v1/stats')).status).toBe(401)
    expect((await cp('POST', '/ops/v1/holds', { name: 'acme', ttlSec: 60 }, { sign: '{"name":"other","ttlSec":60}' })).status).toBe(401)
    expect((await cp('GET', '/ops/v1/stats', undefined, { ts: Date.now() - 61_000 })).status).toBe(401)
    expect((await cp('GET', '/ops/v1/stats', undefined, { ts: Date.now() + 61_000 })).status).toBe(401)
    // the query string is signed too
    const signed = await cp('GET', '/ops/v1/teams?origin=cloud')
    expect(signed.status).toBe(200)
    const tampered = await fetch(`${ops}/ops/v1/teams?origin=addon`, { headers: { authorization: signed.auth } })
    expect(tampered.status).toBe(401)
  })
  test('replay: the same signed request is refused for 120 s', async () => {
    const first = await cp('GET', '/ops/v1/stats')
    expect(first.status).toBe(200)
    const again = await fetch(`${ops}/ops/v1/stats`, { headers: { authorization: first.auth } })
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('replayed')
  })
  test('scopes: a key does only what its scopes allow; unknown endpoints are 404', async () => {
    expect((await opsCall(ops, 'reader', K.keys.reader!, 'GET', '/ops/v1/stats')).status).toBe(200)
    const w = await opsCall(ops, 'reader', K.keys.reader!, 'POST', '/ops/v1/holds', { name: 'acme', ttlSec: 60 })
    expect([w.status, (w.json as { error: { code: string } }).error.code]).toEqual([403, 'forbidden'])
    expect((await opsCall(ops, 'claimer', K.keys.claimer!, 'GET', '/ops/v1/stats')).status).toBe(403)
    expect((await opsCall(ops, 'claimer', K.keys.claimer!, 'POST', '/ops/v1/teams/x/suspend', { reason: 'billing' })).status).toBe(403)
    expect((await cp('GET', '/ops/v1/nothing')).status).toBe(404)
    expect((await cp('POST', '/ops/v1/stats')).status).toBe(404)
  })
  test('bodies are checked: unknown fields and bad values are 400', async () => {
    expect((await cp('POST', '/ops/v1/holds', { name: 'acme', ttlSec: 99_999 })).status).toBe(400)
    expect((await cp('POST', '/ops/v1/holds', { name: 'acme', ttlSec: 60, extra: true })).status).toBe(400)
    expect((await cp('POST', '/ops/v1/claims', { name: 'acme', ttlSec: 3600 })).status).toBe(400)
    expect((await cp('GET', '/ops/v1/names/%E0%A4%A')).status).toBe(400)
  })
})

describe('operator API: a cloud team from start to end', () => {
  const kp = generateTeamKey()
  let teamId = ''
  let tc: RelayClient | null = null
  afterAll(() => tc?.stop())

  test('create with the tenant key (no proof of work); again = the same team (idempotent)', async () => {
    const body = opsCreateBody('acme', kp, 'cp-team-1')
    const r = await cp('POST', '/ops/v1/teams', body)
    expect(r.status).toBe(201)
    const info = OperatorTeamInfoSchema.parse(r.json)
    expect(info).toMatchObject({ name: 'acme', origin: 'cloud', externalRef: 'cp-team-1', region: 'kr-seoul-1', online: false, conns: 0, status: 'active' })
    teamId = info.teamId
    const again = await cp('POST', '/ops/v1/teams', opsCreateBody('acme', kp, 'cp-team-1'))
    expect([again.status, (again.json as { teamId: string }).teamId]).toEqual([200, teamId])
    const other = await cp('POST', '/ops/v1/teams', opsCreateBody('acme', generateTeamKey(), 'cp-team-1'))
    expect(other.status).toBe(409)
    expect((await cp('GET', '/ops/v1/names/acme')).json).toEqual({ name: 'acme', available: false, problem: 'taken' })
    expect((await cp('GET', '/ops/v1/names/fresh-name')).json).toEqual({ name: 'fresh-name', available: true, problem: null })
    const list = await cp('GET', '/ops/v1/teams?origin=cloud')
    expect((list.json as { teams: { teamId: string }[] }).teams.map((t) => t.teamId)).toContain(teamId)
    expect(R.relay.registry.auditLog().filter((a) => a.action === 'teams.create' && a.team_id === teamId).length).toBe(1)
  })

  test('offline cloud team: the cloud offline page (no "server Mac" advice); online once connected', async () => {
    const page = await fetch(teamUrl(PORT, 'acme', '/'), { headers: html })
    expect(page.status).toBe(503)
    expect(page.headers.get('x-relay-error')).toBe('team_offline_cloud')
    expect(await page.text()).toContain('status.treesoop.com')
    tc = client({ url: R.ws, teamId, kp, fetch: app, onEvent: (e) => { events.push(e) } })
    await until(() => tc!.state.state === 'connected' && tc!.state.conns === 2, 5000, 'acme connected')
    const info = OperatorTeamInfoSchema.parse((await cp('GET', `/ops/v1/teams/${teamId}`)).json)
    expect([info.online, info.conns]).toEqual([true, 2])
    expect(OpsStatsSchema.parse((await cp('GET', '/ops/v1/stats')).json).online).toBeGreaterThanOrEqual(1)
    expect((await fetch(teamUrl(PORT, 'acme', '/hello'))).status).toBe(200)
  })

  test('notice reaches the connected team server', async () => {
    expect((await cp('POST', `/ops/v1/teams/${teamId}/notice`, { level: 'warn', code: 'fair_use', message: 'please slow down' })).status).toBe(204)
    await until(() => events.find((e) => e.type === 'notice'), 3000, 'notice event')
    expect(events.find((e) => e.type === 'notice')).toMatchObject({ level: 'warn', code: 'fair_use' })
  })

  test('suspend for billing: payment page for visitors, the team server is cut at once; idempotent; unsuspend', async () => {
    const r = await cp('POST', `/ops/v1/teams/${teamId}/suspend`, { reason: 'billing' })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ status: 'suspended', suspendReason: 'billing' })
    const page = await fetch(teamUrl(PORT, 'acme', '/'), { headers: html })
    expect(page.status).toBe(403)
    expect(page.headers.get('x-relay-error')).toBe('team_suspended_billing')
    expect(await page.text()).toContain('account.treesoop.com')
    const api = await fetch(teamUrl(PORT, 'acme', '/api/x'), { headers: { cookie: 'mycel_locale=ko' } })
    expect(((await api.json()) as { error: { code: string; reason: string } }).error).toMatchObject({ code: 'forbidden', reason: 'team_suspended_billing' })
    await until(() => tc!.state.detail === 'suspended', 3000, 'team server told it is suspended')
    expect((await cp('POST', `/ops/v1/teams/${teamId}/suspend`, { reason: 'billing' })).status).toBe(200)
    expect(R.relay.registry.auditLog().filter((a) => a.action === 'teams.suspend' && a.team_id === teamId).length).toBe(1)
    // other reasons keep the plain suspended page
    await cp('POST', `/ops/v1/teams/${teamId}/suspend`, { reason: 'abuse' })
    expect((await fetch(teamUrl(PORT, 'acme', '/'), { headers: html })).headers.get('x-relay-error')).toBe('team_suspended')
    const un = await cp('POST', `/ops/v1/teams/${teamId}/unsuspend`)
    expect(un.json).toMatchObject({ status: 'active', suspendReason: null })
    expect((await cp('POST', `/ops/v1/teams/${teamId}/unsuspend`)).status).toBe(200)
  })

  test('maintenance: "being updated" while the team is offline, Retry-After 30; off again', async () => {
    tc?.stop()
    await until(async () => !(OperatorTeamInfoSchema.parse((await cp('GET', `/ops/v1/teams/${teamId}`)).json).online), 3000, 'offline')
    await Bun.sleep(250) // past the reconnect hold
    expect((await cp('POST', `/ops/v1/teams/${teamId}/maintenance`, { untilMs: Date.now() + 60_000 })).status).toBe(204)
    const page = await fetch(teamUrl(PORT, 'acme', '/'), { headers: html })
    expect([page.status, page.headers.get('x-relay-error'), page.headers.get('retry-after')]).toEqual([503, 'team_maintenance', '30'])
    expect(OperatorTeamInfoSchema.parse((await cp('GET', `/ops/v1/teams/${teamId}`)).json).maintenanceUntil).not.toBeNull()
    expect((await cp('POST', `/ops/v1/teams/${teamId}/maintenance`, { untilMs: Date.now() + 25 * 3600_000 })).status).toBe(400)
    expect((await cp('POST', `/ops/v1/teams/${teamId}/maintenance`, { untilMs: null })).status).toBe(204)
    expect((await fetch(teamUrl(PORT, 'acme', '/'), { headers: html })).headers.get('x-relay-error')).toBe('team_offline_cloud')
    expect((await cp('POST', `/ops/v1/teams/${teamId}/notice`, { level: 'info', code: 'x', message: 'y' })).status).toBe(409)
  })

  test('key rotation: the new key signs; the same rotation again is fine; a key someone else has is refused', async () => {
    const nk = generateTeamKey()
    const body = { publicKey: nk.publicKey, newKeySig: signB64(loadPrivateKey(nk.privatePem), keyRotationString(teamId, nk.publicKey)) }
    expect((await cp('PUT', `/ops/v1/teams/${teamId}/key`, { ...body, newKeySig: signB64(loadPrivateKey(kp.privatePem), keyRotationString(teamId, nk.publicKey)) })).status).toBe(401)
    expect((await cp('PUT', `/ops/v1/teams/${teamId}/key`, body)).status).toBe(200)
    expect(R.relay.registry.currentKey(teamId)?.public_key).toBe(nk.publicKey)
    expect((await cp('PUT', `/ops/v1/teams/${teamId}/key`, body)).status).toBe(200)
  })

  test('rename: the old address answers 308 to the new one (path kept), WebSockets get 404', async () => {
    const r = await cp('PATCH', `/ops/v1/teams/${teamId}`, { name: 'acme-corp' })
    expect(r.json).toMatchObject({ name: 'acme-corp' })
    const old = await fetch(teamUrl(PORT, 'acme', '/files/a?b=1'), { redirect: 'manual' })
    expect(old.status).toBe(308)
    expect(old.headers.get('location')).toBe(`http://acme-corp.localhost:${PORT}/files/a?b=1`)
    const ws = new WebSocket(`ws://acme.localhost:${PORT}/api/ws`)
    const outcome = await new Promise<string>((resolve) => { ws.onopen = () => resolve('open'); ws.onerror = () => resolve('error'); ws.onclose = () => resolve('closed') })
    expect(outcome).not.toBe('open')
    expect((await fetch(teamUrl(PORT, 'never-was', '/'), { headers: html })).headers.get('x-relay-error')).toBe('team_unknown')
  })

  test('delete: released (name held), again = the same answer', async () => {
    const r = await cp('DELETE', `/ops/v1/teams/${teamId}`)
    expect(r.json).toMatchObject({ status: 'released' })
    expect((await cp('DELETE', `/ops/v1/teams/${teamId}`)).status).toBe(200)
    expect((await cp('GET', '/ops/v1/names/acme-corp')).json).toMatchObject({ available: false, problem: 'taken' })
    expect((await cp('POST', `/ops/v1/teams/${teamId}/suspend`, { reason: 'billing' })).status).toBe(404)
    // the old name of a deleted team is not followed any more
    expect((await fetch(teamUrl(PORT, 'acme', '/'), { redirect: 'manual' })).status).toBe(404)
  })
})

describe('closed registration and claim codes (RL-3)', () => {
  const signedReg = (name: string, kp: TeamKeyPair, claimCode?: string) => {
    const ts = Date.now()
    return { name, publicKey: kp.publicKey, ts, sig: signB64(loadPrivateKey(kp.privatePem), registerSigningString(name, kp.publicKey, ts)), ...(claimCode ? { claimCode } : {}) }
  }
  const post = async (b: unknown) => { const r = await fetch(`${R.base}/teams`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, json: (await r.json()) as { error?: { code: string }; teamId?: string; address?: string } } }

  test('public registration is closed: proof of work alone gets 403 registration_closed; /teams/pow says so', async () => {
    expect(await (await fetch(`${R.base}/teams/pow`)).json()).toMatchObject({ open: false })
    const r = await post({ ...signedReg('selfteam', generateTeamKey()), nonce: '1' })
    expect([r.status, r.json.error?.code]).toEqual([403, 'registration_closed'])
  })
  test('a claim code registers its name once; wrong code / other name are bad_claim', async () => {
    const c = await opsCall(ops, 'claimer', K.keys.claimer!, 'POST', '/ops/v1/claims', { name: 'clinic', ttlSec: 7 * 86400, externalRef: 'addon-team-1' })
    expect(c.status).toBe(201)
    const code = (c.json as { code: string }).code
    expect((await cp('GET', '/ops/v1/names/clinic')).json).toMatchObject({ available: false, problem: 'reserved' })
    const kp = generateTeamKey()
    expect((await post(signedReg('clinic', kp, 'AAAA-BBBB-CCCC-DDDD-EEEE'))).json.error?.code).toBe('bad_claim')
    expect((await post(signedReg('other-name', kp, code))).json.error?.code).toBe('bad_claim')
    const ok = await post(signedReg('clinic', kp, code))
    expect(ok.status).toBe(201)
    expect(ok.json.address).toBe(`http://clinic.localhost:${PORT}`)
    expect(R.relay.registry.team(ok.json.teamId!)).toMatchObject({ origin: 'addon', external_ref: 'addon-team-1' })
    expect((await post(signedReg('clinic', generateTeamKey(), code))).json.error?.code).toBe('bad_claim')
    // withdrawn codes stop working and free the name
    const c2 = await opsCall(ops, 'claimer', K.keys.claimer!, 'POST', '/ops/v1/claims', { name: 'dental', ttlSec: 3600, externalRef: 'addon-team-2' })
    expect((await opsCall(ops, 'claimer', K.keys.claimer!, 'DELETE', '/ops/v1/claims/addon-team-2')).status).toBe(204)
    expect((await post(signedReg('dental', generateTeamKey(), (c2.json as { code: string }).code))).json.error?.code).toBe('bad_claim')
    expect((await cp('GET', '/ops/v1/names/dental')).json).toMatchObject({ available: true })
  })
  test('holds: a signup in progress keeps the name from public registration until released', async () => {
    const h = await cp('POST', '/ops/v1/holds', { name: 'signing-up', ttlSec: 1800 })
    expect(h.status).toBe(200)
    expect(Date.parse((h.json as { holdUntil: string }).holdUntil)).toBeGreaterThan(Date.now() + 1700_000)
    expect((await cp('GET', '/ops/v1/names/signing-up')).json).toMatchObject({ available: false, problem: 'reserved' })
    // the control plane then creates the team with that name (holds do not stop the operator API)
    expect((await cp('POST', '/ops/v1/teams', opsCreateBody('signing-up', generateTeamKey(), 'cp-team-9'))).status).toBe(201)
    const h2 = await cp('POST', '/ops/v1/holds', { name: 'abandoned', ttlSec: 60 })
    expect(h2.status).toBe(200)
    expect((await cp('DELETE', '/ops/v1/holds/abandoned')).status).toBe(204)
    expect((await cp('GET', '/ops/v1/names/abandoned')).json).toMatchObject({ available: true })
    expect((await cp('POST', '/ops/v1/holds', { name: 'www', ttlSec: 60 })).status).toBe(409)
  })
})

describe('metrics and logs (RL-6)', () => {
  test('/metrics: Prometheus text, no team label, no team id or name anywhere', async () => {
    const r = await fetch(`${ops}/metrics`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/plain')
    const text = await r.text()
    for (const m of ['relay_teams{status="active"}', 'relay_teams_online', 'relay_ctl_connections', 'relay_open_streams', 'relay_client_websockets', 'relay_ctl_connects_total', 'relay_http_requests_total{outcome="proxied"}', 'relay_http_requests_total{outcome="maintenance"}', 'relay_ws_total{outcome="unknown"}', 'relay_bytes_total{dir="in"}', 'relay_registrations_total{kind="claim"}', 'relay_registrations_total{kind="operator"}', 'process_resident_memory_bytes']) expect(text).toContain(m)
    expect(text).toMatch(/relay_registrations_total\{kind="claim"\} [1-9]/)
    expect(text).toMatch(/relay_http_requests_total\{outcome="redirect"\} [1-9]/)
    for (const t of R.relay.registry.list()) { expect(text).not.toContain(t.id); expect(text).not.toContain(`"${t.name}"`) }
    expect(text).not.toMatch(/team=/)
    for (const line of text.split('\n').filter((l) => l && !l.startsWith('#'))) expect(line).toMatch(/^[a-z0-9_]+(\{[a-z]+="[a-z]+"\})? [0-9.e+-]+$/)
  })
  test('the relay log holds no client IP, path or host, also for operator calls', () => {
    const all = R.logLines.join('\n')
    expect(all).toContain('"ev":"ops"')
    expect(all).not.toContain('127.0.0.1')
    expect(all).not.toContain('/ops/v1')
    expect(all).not.toContain('localhost')
  })
})

describe('HSTS and several domains (RL-4)', () => {
  let R2: InProcessRelay
  let tc2: RelayClient
  beforeAll(async () => {
    R2 = await startRelay(19282, { RELAY_PUBLIC_PROTO: 'https', RELAY_DOMAIN: 'localhost,alt.localhost' })
    const { registerTeam } = await import('../lib/f-relay')
    const t = await registerTeam(R2.base, 'zeta')
    tc2 = client({ url: R2.ws, teamId: t.teamId, kp: t.kp, fetch: app })
    await until(() => tc2.state.state === 'connected', 5000, 'zeta connected')
  })
  afterAll(async () => { tc2.stop(); await R2.stop() })

  test('the team answers under every domain; registration answers use the first one', async () => {
    expect(R2.cfg.domains).toEqual(['localhost', 'alt.localhost'])
    expect((await fetch(`http://zeta.alt.localhost:19282/hello`)).status).toBe(200)
    expect((await fetch(`http://zeta.localhost:19282/hello`)).status).toBe(200)
    // relay.<second domain> is the relay's own address too
    expect((await fetch(`http://relay.alt.localhost:19282/healthz`)).status).toBe(200)
  })
  test('HSTS is added to team answers that have none (one year, no subdomains), kept when the team sets its own', async () => {
    const a = await fetch(`http://zeta.alt.localhost:19282/hello`)
    expect(a.headers.get('strict-transport-security')).toBe('max-age=31536000')
    const own = await fetch(`http://zeta.localhost:19282/own-hsts`)
    expect(own.headers.get('strict-transport-security')).toBe('max-age=60')
    const page = await fetch(`http://nobody.localhost:19282/`)
    expect(page.headers.get('strict-transport-security')).toBe('max-age=31536000')
    // not on the relay's own API, and never on plain-http relays (the first suite's relay)
    expect((await fetch(`http://127.0.0.1:19282/healthz`)).headers.get('strict-transport-security')).toBeNull()
    expect((await fetch(teamUrl(PORT, 'nobody', '/'))).headers.get('strict-transport-security')).toBeNull()
  })
})
