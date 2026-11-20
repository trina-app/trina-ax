// The team's name on the hosting service (shared/src/cloud-protocol/team-name.ts, server/src/system/cloud-team-name.ts).
// Covers: the one name rule (length, white space, NFC, control, bidi and zero-width characters) and the strict body;
// only a hosted server reports (a self-installed one never calls the hosting service); each report is signed with the
// relay team key over the Drive broker's signing string with this path, and that signature does not verify for a Drive
// broker path; answers map to sent / unchanged / refused / failed; a failed report is tried again and the latest name
// wins; an owner's rename in Admin › Team settings reports the new name, a save without a new name reports nothing.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { makeCApp, jsonBody, type CApp } from '../lib/c-app'
import {
  parseTeamNameReport, TEAM_NAME_MAX, TEAM_NAME_PATH, teamNameProblem, teamNameSigningString, teamNameToSend,
} from '../../shared/src/cloud-protocol/team-name'
import { DRIVE_BROKER_PATHS, driveBrokerSigningString, parseDriveBrokerAuthorization } from '../../shared/src/cloud-protocol/drive-broker'
import { reportTeamName, sendTeamName, setTeamNameSync, teamNameSyncFor, type TeamNameSync } from '../../server/src/system/cloud-team-name'

const ORIGIN = 'https://account.cp.test'

/** a fake control plane: checks the signature with the key it knows, records the names, answers `answers` in turn */
class FakeCp {
  readonly key = crypto.generateKeyPairSync('ed25519').privateKey
  readonly publicKey = crypto.createPublicKey(this.key).export({ format: 'der', type: 'spki' }).toString('base64')
  names: string[] = []
  answers: Array<number | 'throw'> = []
  current = 'Old name'
  readonly fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(ORIGIN + TEAM_NAME_PATH)
    const next = this.answers.shift() ?? 200
    if (next === 'throw') throw new Error('offline')
    const body = String(init!.body)
    const auth = parseDriveBrokerAuthorization(new Headers(init!.headers).get('authorization'))!
    expect(auth.key).toBe(this.publicKey)
    const signed = teamNameSigningString(auth.ts, auth.nonce, crypto.createHash('sha256').update(body).digest('hex'))
    expect(crypto.verify(null, Buffer.from(signed, 'utf8'), crypto.createPublicKey({ key: Buffer.from(auth.key, 'base64'), format: 'der', type: 'spki' }), Buffer.from(auth.sig, 'base64'))).toBe(true)
    const report = parseTeamNameReport(JSON.parse(body))
    expect(report).not.toBeNull()
    this.names.push(report!.displayName)
    if (next !== 200) return new Response(JSON.stringify({ error: { code: next === 403 ? 'not_hosted' : 'oops', message: 'x' } }), { status: next })
    const changed = this.current !== report!.displayName
    this.current = report!.displayName
    return Response.json({ ok: true, changed })
  }) as typeof fetch
  sync(retryMs = [1, 1, 1]): TeamNameSync { return { origin: ORIGIN, identity: () => ({ key: this.key, publicKey: this.publicKey }), fetch: this.fetch, retryMs } }
}

let a: CApp, cp: FakeCp, i = 0
beforeEach(async () => {
  a = await makeCApp('team-name-' + ++i)
  ;(a.ctx.config as any).deployment = 'hosted'
  cp = new FakeCp()
})
afterEach(async () => { await a?.close() })

test('the one name rule: 1-100 characters, no surrounding spaces, NFC, no control, bidi or zero-width characters; the body is strict', () => {
  for (const ok of ['Acme', '포텐랩', 'Café Ünïcode', 'A'.repeat(TEAM_NAME_MAX), '👨‍👩‍👧 family', 'R&D · 팀 2']) expect(teamNameProblem(ok)).toBeNull()
  expect(teamNameProblem('')).toBe('empty')
  expect(teamNameProblem('   ')).toBe('empty')
  expect(teamNameProblem('A'.repeat(TEAM_NAME_MAX + 1))).toBe('too_long')
  expect(teamNameProblem('🙂'.repeat(TEAM_NAME_MAX))).toBeNull() // code points, not UTF-16 units
  expect(teamNameProblem(' Acme')).toBe('spaces')
  expect(teamNameProblem('Café')).toBe('not_nfc')
  for (const bad of ['A\nB', 'A\tB', 'A\u0000B', 'A\u007fB', 'A\u0085B', 'A B', 'A B', 'A‮B', 'A⁦B', 'A​B', 'A‏B', 'A﻿B', 'A\ud800B'])
    expect(teamNameProblem(bad)).toBe('bad_character')
  expect(teamNameProblem(42)).toBe('not_text')
  // what a server sends: trimmed and NFC; null when that is still no name
  expect(teamNameToSend('  Café ')).toBe('Café')
  expect(teamNameToSend('  ')).toBeNull()
  expect(teamNameToSend('A‮B')).toBeNull()
  expect(parseTeamNameReport({ v: 1, displayName: 'Acme' })).toEqual({ v: 1, displayName: 'Acme' })
  for (const bad of [null, [], 'Acme', { v: 2, displayName: 'Acme' }, { v: 1 }, { v: 1, displayName: 'Acme', teamId: 'x' }, { v: 1, displayName: ' Acme' }, { v: 1, displayName: 'A\nB' }])
    expect(parseTeamNameReport(bad)).toBeNull()
  // the path is in the signed string: a team name signature is not a Drive broker signature
  expect(teamNameSigningString(1, 'n', 'h')).toBe(driveBrokerSigningString(TEAM_NAME_PATH, 1, 'n', 'h'))
  for (const p of Object.values(DRIVE_BROKER_PATHS)) expect(driveBrokerSigningString(p, 1, 'n', 'h')).not.toBe(teamNameSigningString(1, 'n', 'h'))
})

test('only a hosted server reports its name; a self-installed one never calls the hosting service', async () => {
  expect(teamNameSyncFor(a.ctx, { MYCEL_GOOGLE_DRIVE_BROKER_URL: ORIGIN })?.origin).toBe(ORIGIN)
  expect(teamNameSyncFor(a.ctx, { MYCEL_GOOGLE_DRIVE_BROKER_URL: 'off' })).toBeNull()
  expect(teamNameSyncFor(a.ctx, { NODE_ENV: 'test' })).toBeNull() // a test app never calls the real hosting service
  ;(a.ctx.config as any).deployment = 'self'
  expect(teamNameSyncFor(a.ctx, { MYCEL_GOOGLE_DRIVE_BROKER_URL: ORIGIN })).toBeNull()
  expect(teamNameSyncFor(a.ctx, {})).toBeNull()
  // a self-installed server that renames its team: no call, even with a control plane at hand
  setTeamNameSync(a.ctx, cp.sync())
  const res = await a.json('/api/admin/settings', { ...jsonBody({ teamName: 'Self team' }, 'PATCH'), as: 'dana' })
  expect(res.status).toBe(200)
  await Bun.sleep(5)
  expect(cp.names).toEqual([])
})

test('a signed report; the answers map to sent, unchanged, refused (no retry) and failed (retry)', async () => {
  const s = cp.sync()
  expect(await sendTeamName(s, ' New name ')).toBe('sent')
  expect(cp.names).toEqual(['New name'])
  expect(await sendTeamName(s, 'New name')).toBe('unchanged')
  cp.answers = [403]; expect(await sendTeamName(s, 'X')).toBe('refused')
  cp.answers = [400]; expect(await sendTeamName(s, 'X')).toBe('refused')
  cp.answers = [429]; expect(await sendTeamName(s, 'X')).toBe('failed')
  cp.answers = [502]; expect(await sendTeamName(s, 'X')).toBe('failed')
  cp.answers = ['throw']; expect(await sendTeamName(s, 'X')).toBe('failed')
  const before = cp.names.length
  expect(await sendTeamName(s, 'A‮B')).toBe('refused') // never sent: the control plane would refuse it
  expect(cp.names.length).toBe(before)
})

test('a failed report is tried again; a refusal is not; the latest name wins', async () => {
  setTeamNameSync(a.ctx, cp.sync())
  cp.answers = ['throw', 503, 200]
  await reportTeamName(a.ctx, 'Retry team')
  expect(cp.names).toEqual(['Retry team', 'Retry team']) // the first try never reached it
  expect(cp.answers).toEqual([])
  expect(cp.current).toBe('Retry team')
  cp.names = []; cp.answers = [403]
  await reportTeamName(a.ctx, 'Refused team')
  expect(cp.names).toEqual(['Refused team'])
  // a rename while the first report waits for another try: the newer name goes next, the older one is dropped
  cp.names = []; cp.answers = [503]
  setTeamNameSync(a.ctx, cp.sync([5_000]))
  const first = reportTeamName(a.ctx, 'First')
  await Bun.sleep(5)
  await reportTeamName(a.ctx, 'Second')
  await first
  expect(cp.names).toEqual(['First', 'Second'])
  expect(cp.current).toBe('Second')
})

test("an owner's rename in Admin › Team settings reports the new name; saving other settings reports nothing", async () => {
  setTeamNameSync(a.ctx, cp.sync())
  const res = await a.json('/api/admin/settings', { ...jsonBody({ teamName: 'Renamed team' }, 'PATCH'), as: 'dana' })
  expect(res.status).toBe(200)
  for (let n = 0; n < 50 && cp.names.length === 0; n++) await Bun.sleep(2)
  expect(cp.names).toEqual(['Renamed team'])
  expect(cp.current).toBe('Renamed team')
  await a.json('/api/admin/settings', { ...jsonBody({ teamName: 'Renamed team', defaultLocale: 'en' }, 'PATCH'), as: 'dana' })
  await Bun.sleep(10)
  expect(cp.names).toEqual(['Renamed team'])
  // an admin may not rename the team: nothing is reported
  expect((await a.json('/api/admin/settings', { ...jsonBody({ teamName: 'Admin name' }, 'PATCH'), as: 'carol' })).status).toBe(403)
  await Bun.sleep(10)
  expect(cp.names).toEqual(['Renamed team'])
})
