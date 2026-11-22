// The team's name on the hosting service (shared/src/cloud-protocol/team-name.ts, server/src/system/cloud-team-name.ts).
// Covers: the one name rule (1-60 characters, white space, NFC, controls, every default-ignorable character, the Arabic
// letter mark, Hangul fillers, the Braille blank, stacked marks; a joiner only inside an emoji) and the strict body;
// only a hosted server reports (a self-installed one never calls the hosting service); each report is signed with the
// relay team key over the Drive broker's signing string with this path, and that signature does not verify for a Drive
// broker path; answers map to sent / unchanged / refused / failed; a failed report is tried again and the latest name
// wins; a 401 is tried once more at once; a refusal is logged with its status and code; the start report waits; an
// owner's rename in Admin › Team settings reports the new name, a save without a new name reports nothing; on a hosted
// server a name the hosting service would refuse fails the save and the setup with an error (a self-installed server
// keeps its 1-100 rule).
import { afterEach, beforeEach, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { makeCApp, jsonBody, type CApp } from '../lib/c-app'
import {
  parseTeamNameReport, TEAM_NAME_MAX, TEAM_NAME_PATH, teamNameProblem, teamNameSigningString, teamNameToSend,
} from '../../shared/src/cloud-protocol/team-name'
import { DRIVE_BROKER_PATHS, driveBrokerSigningString, parseDriveBrokerAuthorization } from '../../shared/src/cloud-protocol/drive-broker'
import { reportTeamName, reportTeamNameAtStart, sendTeamName, setTeamNameSync, teamNameSyncFor, type TeamNameSync } from '../../server/src/system/cloud-team-name'
import { bootstrapOwner } from '../../server/src/auth/accounts'
import { getTeamSettings } from '../../server/src/admin/settings'

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

/** names the hosting service refuses (written as escapes: they are invisible) */
const HIDDEN: Record<string, string> = {
  newline: 'A\nB', tab: 'A\tB', nul: 'A\u0000B', del: 'A\u007fB', c1: 'A\u0085B', lineSep: 'A B', paraSep: 'A B',
  rlo: 'A‮B', lri: 'A⁦B', zwsp: 'A​B', zwnj: 'A‌B', zwj: 'A‍B', rlm: 'A‏B', bom: 'A﻿B',
  lone: 'A\ud800B', wordJoiner: 'A⁠B', invisibleTimes: 'A⁢B', deprecatedFormat: 'A⁪B', softHyphen: 'A­B',
  arabicLetterMark: 'A؜B', cgj: 'A͏B', mongolianVs: 'A᠎B', vs16: 'A️B', tag: 'A\u{e0041}B',
  hangulFiller: 'TrinaㅤSupport', hangulFillerOnly: 'ㅤ', halfwidthFiller: 'AﾠB', choseongFiller: 'AᅟB',
  jungseongFiller: 'AᅠB', brailleBlank: 'Trina⠀Support', joinerAfterEmojiThenLetter: '\u{1f468}‍A',
  stackedMarks: 'A' + '́'.repeat(6),
}

test('the one name rule: 1-60 characters, no surrounding spaces, NFC, no hidden characters (a joiner only in an emoji); the body is strict', () => {
  expect(TEAM_NAME_MAX).toBe(60)
  const ok = ['Acme', '포텐랩', 'Café Ünïcode', 'A'.repeat(TEAM_NAME_MAX), 'R&D · 팀 2',
    '\u{1f468}‍\u{1f469}‍\u{1f467} family', '❤️ Acme', '\u{1f44d}\u{1f3fd} team', 'A B', 'é̂̃̄̅'.normalize('NFC')]
  for (const n of ok) expect([n, teamNameProblem(n)]).toEqual([n, null])
  expect(teamNameProblem('')).toBe('empty')
  expect(teamNameProblem('   ')).toBe('empty')
  expect(teamNameProblem('A'.repeat(TEAM_NAME_MAX + 1))).toBe('too_long')
  expect(teamNameProblem('\u{1f642}'.repeat(TEAM_NAME_MAX))).toBeNull() // code points, not UTF-16 units
  expect(teamNameProblem(' Acme')).toBe('spaces')
  expect(teamNameProblem('Café')).toBe('not_nfc')
  for (const [what, n] of Object.entries(HIDDEN)) expect([what, teamNameProblem(n)]).toEqual([what, 'bad_character'])
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
  // a self-installed server that renames its team: no call, even with a control plane at hand; its own rule stays
  setTeamNameSync(a.ctx, cp.sync())
  expect((await a.json('/api/admin/settings', { ...jsonBody({ teamName: 'Self team' }, 'PATCH'), as: 'dana' })).status).toBe(200)
  expect((await a.json('/api/admin/settings', { ...jsonBody({ teamName: 'S'.repeat(100) }, 'PATCH'), as: 'dana' })).status).toBe(200)
  reportTeamNameAtStart(a.ctx, () => 'Self team', 0)
  await Bun.sleep(10)
  expect(cp.names).toEqual([])
})

test('a signed report; the answers map to sent, unchanged, refused (no retry) and failed (retry); a 401 is tried once more', async () => {
  const s = cp.sync()
  expect((await sendTeamName(s, ' New name ')).result).toBe('sent')
  expect(cp.names).toEqual(['New name'])
  expect((await sendTeamName(s, 'New name')).result).toBe('unchanged')
  cp.answers = [403]; expect(await sendTeamName(s, 'X')).toEqual({ result: 'refused', status: 403, code: 'not_hosted' })
  cp.answers = [400]; expect(await sendTeamName(s, 'X')).toEqual({ result: 'refused', status: 400, code: 'oops' })
  cp.answers = [429]; expect((await sendTeamName(s, 'X')).result).toBe('failed')
  cp.answers = [502]; expect((await sendTeamName(s, 'X')).result).toBe('failed')
  cp.answers = ['throw']; expect(await sendTeamName(s, 'X')).toEqual({ result: 'failed', status: null, code: 'unreachable' })
  // a 401 once (a clock step, a nonce seen): tried again at once with a new time and nonce; twice: refused
  cp.names = []; cp.answers = [401, 200]
  expect((await sendTeamName(s, 'After 401')).result).toBe('sent')
  expect(cp.names).toEqual(['After 401', 'After 401'])
  cp.names = []; cp.answers = [401, 401, 200]
  expect(await sendTeamName(s, 'Twice 401')).toEqual({ result: 'refused', status: 401, code: 'oops' })
  expect(cp.names.length).toBe(2)
  cp.answers = []
  const before = cp.names.length
  expect((await sendTeamName(s, 'A‮B')).result).toBe('refused') // never sent: the control plane would refuse it
  expect(cp.names.length).toBe(before)
})

test('a failed report is tried again; a refusal is not and is logged with its status and code; the latest name wins', async () => {
  const warned: unknown[] = []
  ;(a.ctx as any).log = { ...a.ctx.log, warn: (m: string, f: unknown) => warned.push([m, f]), info() {} }
  setTeamNameSync(a.ctx, cp.sync())
  cp.answers = ['throw', 503, 200]
  await reportTeamName(a.ctx, 'Retry team')
  expect(cp.names).toEqual(['Retry team', 'Retry team']) // the first try never reached it
  expect(cp.answers).toEqual([])
  expect(cp.current).toBe('Retry team')
  expect(warned).toEqual([])
  cp.names = []; cp.answers = [403]
  await reportTeamName(a.ctx, 'Refused team')
  expect(cp.names).toEqual(['Refused team'])
  expect(warned).toEqual([['team name not reported to the hosting service', { result: 'refused', status: 403, code: 'not_hosted' }]])
  expect(JSON.stringify(warned)).not.toContain('Refused team')
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

test('the start report waits its delay, reads the name then, and is dropped when the server stops first', async () => {
  setTeamNameSync(a.ctx, cp.sync())
  let name = 'At start'
  reportTeamNameAtStart(a.ctx, () => name, 40)
  await Bun.sleep(10)
  expect(cp.names).toEqual([]) // not yet
  name = 'Renamed before the delay'
  for (let n = 0; n < 50 && cp.names.length === 0; n++) await Bun.sleep(5)
  expect(cp.names).toEqual(['Renamed before the delay'])
  // the default delay is 0-60 s: nothing goes out at once; a stop cancels it
  reportTeamNameAtStart(a.ctx, () => 'Later')
  await Bun.sleep(10)
  expect(cp.names).toEqual(['Renamed before the delay'])
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

test('on a hosted server a name the hosting service would refuse fails the save and the setup with an error; spaces are trimmed', async () => {
  setTeamNameSync(a.ctx, cp.sync())
  for (const bad of [HIDDEN.hangulFiller!, HIDDEN.zwsp!, HIDDEN.rlo!, 'A'.repeat(61), '   ']) {
    const r = await a.json('/api/admin/settings', { ...jsonBody({ teamName: bad }, 'PATCH'), as: 'dana' })
    expect(r.status).toBe(400)
    expect(r.body.error.fields['body.teamName']).toBeTruthy()
    expect(r.body.error.message).toContain('60')
  }
  expect(getTeamSettings(a.ctx.db).teamName).not.toBe('A'.repeat(61))
  await Bun.sleep(10)
  expect(cp.names).toEqual([])
  // white space around the name and a decomposed accent: kept trimmed and NFC, sent the same
  const ok = await a.json('/api/admin/settings', { ...jsonBody({ teamName: '  Café Team  ' }, 'PATCH'), as: 'dana' })
  expect(ok.status).toBe(200)
  expect(ok.body.teamName).toBe('Café Team')
  for (let n = 0; n < 50 && cp.names.length === 0; n++) await Bun.sleep(2)
  expect(cp.names).toEqual(['Café Team'])
  // setup: the same rule before anything is made
  const owner = { username: 'newowner', name: 'New Owner', credential: { password: 'a-long-enough-password-1' }, locale: 'en' as const }
  await expect(bootstrapOwner(a.ctx, { ...owner, teamName: HIDDEN.hangulFiller! })).rejects.toMatchObject({ status: 400 })
  await expect(bootstrapOwner(a.ctx, { ...owner, teamName: 'Fine name' })).rejects.toMatchObject({ status: 409 }) // set up already
})
