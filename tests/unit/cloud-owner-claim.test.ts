// A team made from the desktop app: the contract (shared/src/cloud-protocol/owner-claim.ts) and its vectors.
// Covers: the claim's shape and fragment; the strict reserve/confirm body and the reserve answer; the signing string
// (the Drive broker's, with the path, so a signature for one path never verifies for another or for a Drive broker
// call); the vectors' signatures verify with the fixed test key; the app's connect address round-trips through the
// console's parser and refuses anything extra; the token, team and me answers; address labels from team names.
import { describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import {
  appCallbackUrl, appConnectUrl, isOwnerClaim, OWNER_CLAIM_CONFIRM_PATH, OWNER_CLAIM_RESERVE_PATH, ownerClaimSetupUrl,
  ownerClaimSigningString, parseAppConnectParams, parseAppCreateTeam, parseAppError, parseAppMe, parseAppTeam,
  parseAppTokenAnswer, parseAppTokenRequest, parseOwnerClaimConfirmAnswer, parseOwnerClaimOwner, parseOwnerClaimRequest,
  readOwnerClaimFragment, suggestTeamSlug, teamSlugOk,
} from '../../shared/src/cloud-protocol/owner-claim'
import { DRIVE_BROKER_PATHS, driveBrokerSigningString, parseDriveBrokerAuthorization } from '../../shared/src/cloud-protocol/drive-broker'
import { buildVectors } from '../../shared/src/cloud-protocol/vectors'

const V = buildVectors()
const O = V.ownerClaim
const pub = crypto.createPublicKey({ key: Buffer.from(V.key.publicKeySpkiB64, 'base64'), format: 'der', type: 'spki' })
const verifies = (s: string, sig: string) => crypto.verify(null, Buffer.from(s, 'utf8'), pub, Buffer.from(sig, 'base64'))

describe('owner claim', () => {
  test('a claim is 43 base64url characters, in a fragment with nothing else', () => {
    expect(isOwnerClaim(O.claim)).toBe(true)
    expect(isOwnerClaim(O.claim + 'A')).toBe(false)
    expect(isOwnerClaim(O.claim.slice(0, 42) + '+')).toBe(false)
    expect(O.setupUrl).toBe(`https://acme.treesoop.com/app-setup#c=${O.claim}`)
    expect(readOwnerClaimFragment(`#c=${O.claim}`)).toBe(O.claim)
    expect(readOwnerClaimFragment(`#c=${O.claim}&x=1`)).toBeNull()
    expect(readOwnerClaimFragment(`#x=${O.claim}`)).toBeNull()
    expect(readOwnerClaimFragment('')).toBeNull()
    expect(() => ownerClaimSetupUrl('https://acme.treesoop.com', 'short')).toThrow()
    // the address keeps only the origin
    expect(ownerClaimSetupUrl('https://acme.treesoop.com/some/path?q=1', O.claim)).toBe(O.setupUrl)
  })

  test('reserve and confirm bodies are strict', () => {
    for (const ok of O.request.valid) expect(parseOwnerClaimRequest(ok)).toEqual(ok as never)
    for (const bad of O.request.invalid) expect(parseOwnerClaimRequest(bad.raw), bad.why).toBeNull()
    expect(parseOwnerClaimRequest(null)).toBeNull()
    expect(parseOwnerClaimRequest([1])).toBeNull()
  })

  test('the reserve answer is strict', () => {
    for (const ok of O.owner.valid) expect(parseOwnerClaimOwner(ok)).toEqual(ok as never)
    for (const bad of O.owner.invalid) expect(parseOwnerClaimOwner(bad.raw), bad.why).toBeNull()
    expect(parseOwnerClaimConfirmAnswer({ ok: true, spent: true })).toEqual({ ok: true, spent: true })
    expect(parseOwnerClaimConfirmAnswer({ ok: true })).toBeNull()
  })

  test('the vectors are signed with the test key over the path; one path never verifies for another', () => {
    for (const s of [O.reserve, O.confirm]) {
      expect(s.bodySha256).toBe(crypto.createHash('sha256').update(s.body).digest('hex'))
      expect(s.string).toBe(ownerClaimSigningString(s.path, s.ts, s.nonce, s.bodySha256))
      expect(verifies(s.string, s.sig)).toBe(true)
      const auth = parseDriveBrokerAuthorization(s.authorization)!
      expect(auth).toMatchObject({ key: V.key.publicKeySpkiB64, ts: s.ts, nonce: s.nonce, sig: s.sig })
    }
    expect(verifies(ownerClaimSigningString(OWNER_CLAIM_CONFIRM_PATH, O.reserve.ts, O.reserve.nonce, O.reserve.bodySha256), O.reserve.sig)).toBe(false)
    expect(verifies(driveBrokerSigningString(DRIVE_BROKER_PATHS.status, O.reserve.ts, O.reserve.nonce, O.reserve.bodySha256), O.reserve.sig)).toBe(false)
    expect(() => ownerClaimSigningString('/api/drive-broker/v1/status' as never, 1, 'n', 'h')).toThrow()
    expect(O.claimSha256).toBe(crypto.createHash('sha256').update(O.claim, 'utf8').digest('hex'))
    expect(OWNER_CLAIM_RESERVE_PATH).toBe('/api/hosted-team/v1/owner/reserve')
  })
})

describe('app and console', () => {
  test('the connect address round-trips and refuses anything extra', () => {
    const p = parseAppConnectParams(new URL(O.connect.url).searchParams)!
    expect(p).toMatchObject({ port: 53682, locale: 'en', store: false })
    expect(parseAppConnectParams(new URL(O.connect.storeUrl).searchParams)!.store).toBe(true)
    expect(new URL(O.connect.url).pathname).toBe('/app/connect')
    const q = (extra: string) => new URLSearchParams(new URL(O.connect.url).search.slice(1) + extra)
    expect(parseAppConnectParams(q('&redirect=https://evil.example'))).toBeNull()
    expect(parseAppConnectParams(q('&state=again'))).toBeNull()
    expect(parseAppConnectParams(q('&store=0'))).toBeNull()
    const low = new URL(O.connect.url); low.searchParams.set('port', '80')
    expect(parseAppConnectParams(low.searchParams)).toBeNull()
    expect(O.connect.callback.startsWith('http://127.0.0.1:53682/console-callback?code=')).toBe(true)
    expect(new URL(O.connect.cancelled).searchParams.get('error')).toBe('cancelled')
    expect(appCallbackUrl(1234, { code: O.claim, state: 's' })).toContain('127.0.0.1')
    expect(appConnectUrl('https://account.treesoop.com/x', { state: 'a', challenge: 'b', port: 2000, locale: 'ko', store: false })).toStartWith('https://account.treesoop.com/app/connect?')
  })

  test('token request and answer', () => {
    const verifier = crypto.randomBytes(32).toString('base64url')
    expect(parseAppTokenRequest({ v: 1, code: O.claim, verifier })).toEqual({ v: 1, code: O.claim, verifier })
    expect(parseAppTokenRequest({ v: 1, code: O.claim, verifier: 'short' })).toBeNull()
    expect(parseAppTokenRequest({ v: 1, code: O.claim, verifier, extra: 1 })).toBeNull()
    const token = crypto.randomBytes(32).toString('base64url')
    expect(parseAppTokenAnswer({ token, expiresAt: '2026-11-26T12:00:00Z', store: false })).toEqual({ token, expiresAt: '2026-11-26T12:00:00Z', store: false })
    expect(parseAppTokenAnswer({ token: 'x', expiresAt: '2026-11-26T12:00:00Z', store: false })).toBeNull()
  })

  const team = { id: 't_1', name: 'Acme', slug: 'acme', url: 'https://acme.treesoop.com', state: 'provisioning', setUp: false, planId: 'free', comeback: false, provisioning: { step: 1, error: null, waitingCapacity: false } }
  test('team and me answers', () => {
    expect(parseAppTeam(team)).toEqual(team as never)
    expect(parseAppTeam({ ...team, url: 'http://evil.example' })).toBeNull()
    expect(parseAppTeam({ ...team, url: 'http://acme.localhost:19100' })).not.toBeNull()
    expect(parseAppTeam({ ...team, state: 'gone' })).toBeNull()
    expect(parseAppTeam({ ...team, provisioning: { step: 9, error: null, waitingCapacity: false } })).toBeNull()
    const freePlan = { maxActiveMembers: 3, maxConcurrency: 1, diskGB: 5, termsUrl: 'https://ax.trina.app/terms', privacyUrl: 'https://ax.trina.app/privacy', termsVersion: '2026-11-01' }
    const me = { accountId: 'a_1', email: 'owner@example.com', team: null, freeLeft: true, waitlist: false, freePlan, store: false }
    expect(parseAppMe(me)).toEqual(me)
    expect(parseAppMe({ ...me, team })!.team!.slug).toBe('acme')
    expect(parseAppMe({ ...me, team: { ...team, slug: 'A' } })).toBeNull()
    expect(parseAppMe({ ...me, freePlan: { ...freePlan, termsUrl: 'http://x' } })).toBeNull()
    expect(parseAppError({ error: { code: 'capacity_full', message: 'x', fields: { pool: 'free' } } })).toEqual({ code: 'capacity_full', fields: { pool: 'free' } })
    expect(parseAppError({ error: { code: 'Bad Code' } })).toBeNull()
  })

  test('create team body', () => {
    const body = { v: 1, planId: 'free', displayName: 'Acme', slug: 'acme', timeZone: 'Asia/Seoul', locale: 'en', consent: { termsVersion: '2026-11-01', shownAt: '2026-11-26T12:00:00.000Z' } }
    expect(parseAppCreateTeam(body)).toEqual(body as never)
    expect(parseAppCreateTeam({ ...body, planId: 'team' })).toBeNull()
    expect(parseAppCreateTeam({ ...body, slug: 'ab' })).toBeNull()
    expect(parseAppCreateTeam({ ...body, consent: { termsVersion: '1' } })).toBeNull()
    expect(parseAppCreateTeam({ ...body, displayName: 'x'.repeat(61) })).toBeNull()
  })

  test('address labels from team names', () => {
    for (const s of O.slugs) expect(s.out, s.name).toBe(s.slug)
    expect(teamSlugOk('xn--abc')).toBe(false)
    expect(teamSlugOk('a-b')).toBe(true)
    expect(teamSlugOk('-ab')).toBe(false)
    for (const name of ['Acme', 'ab--cd', 'a'.repeat(80), '東京 Team', '---']) expect(teamSlugOk(suggestTeamSlug(name, 'q1w2'))).toBe(true)
  })
})
