// Component A: a hosted team made from the desktop app (server/src/auth/setup-console.ts,
// docs/decisions/20261126-desktop-create-team.md). Covers: only a hosted server; the per-address guard and the claim's
// shape before any call to the console (a bad shape is counted and never sent); the CSRF rule of public POSTs; reserve
// → bootstrapOwner → confirm, in that order, signed with the relay team key over the owner-claim signing string; the
// preview spends nothing; a weak or missing password leaves the claim unspent (no account, no confirm); a Google owner
// gets no password; the username comes from the e-mail; a confirm that fails is tried again; an unknown claim, a team set
// up already, a console that is down or older (404); a desktop session with a cookie, audit `setup` method `console`.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { OWNER_CLAIM_CONFIRM_PATH, OWNER_CLAIM_RESERVE_PATH, ownerClaimSigningString, parseOwnerClaimRequest, type OwnerClaimOwner, type OwnerClaimPath } from '../../shared/src/cloud-protocol/owner-claim'
import { parseDriveBrokerAuthorization } from '../../shared/src/cloud-protocol/drive-broker'
import { confirmInBackground, setOwnerClaimClient, type OwnerClaimClient } from '../../server/src/auth/setup-console'
import { bootstrapOwner } from '../../server/src/auth/accounts'
import { getUser } from '../../server/src/auth/users'
import { getTeamSettings } from '../../server/src/admin/settings'
import { harness, type Harness } from './a-lib'

setDefaultTimeout(30_000)

const ORIGIN = 'https://account.cp.test'
const PREVIEW = '/api/setup/console/preview'
const SETUP = '/api/setup/console'
const claimOf = () => crypto.randomBytes(32).toString('base64url')
const OWNER: OwnerClaimOwner = { teamName: 'Acme Studio', email: 'alex.kim+trina@example.com', name: 'Alex Kim', locale: 'en', timeZone: 'Asia/Seoul', google: null }

/** a fake console: checks each call's signature with the key it knows, keeps claims, answers in turn when told to */
class FakeCp {
  readonly key = crypto.generateKeyPairSync('ed25519').privateKey
  readonly publicKey = crypto.createPublicKey(this.key).export({ format: 'der', type: 'spki' }).toString('base64')
  claims = new Map<string, { owner: OwnerClaimOwner; spent: boolean }>()
  calls: { path: string; claim: string }[] = []
  /** forced answers for the next calls: an HTTP status, or 'throw' (no answer) */
  next: Array<number | 'throw'> = []
  readonly fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).slice(ORIGIN.length) as OwnerClaimPath
    expect([OWNER_CLAIM_RESERVE_PATH, OWNER_CLAIM_CONFIRM_PATH]).toContain(path)
    const body = String(init!.body)
    const auth = parseDriveBrokerAuthorization(new Headers(init!.headers).get('authorization'))!
    expect(auth.key).toBe(this.publicKey)
    const signed = ownerClaimSigningString(path, auth.ts, auth.nonce, crypto.createHash('sha256').update(body).digest('hex'))
    expect(crypto.verify(null, Buffer.from(signed, 'utf8'), crypto.createPublicKey({ key: Buffer.from(auth.key, 'base64'), format: 'der', type: 'spki' }), Buffer.from(auth.sig, 'base64'))).toBe(true)
    const req = parseOwnerClaimRequest(JSON.parse(body))!
    expect(req).not.toBeNull()
    this.calls.push({ path, claim: req.claim })
    const forced = this.next.shift()
    if (forced === 'throw') throw new Error('offline')
    if (forced !== undefined) return Response.json({ error: { code: forced === 404 ? 'not_found' : 'oops', message: 'x' } }, { status: forced })
    const c = this.claims.get(req.claim)
    if (!c || (c.spent && path === OWNER_CLAIM_RESERVE_PATH)) return Response.json({ error: { code: 'invalid_claim', message: 'x' } }, { status: 410 })
    if (path === OWNER_CLAIM_RESERVE_PATH) return Response.json(c.owner)
    const spent = !c.spent
    c.spent = true
    return Response.json({ ok: true, spent })
  }) as typeof fetch
  client(): OwnerClaimClient { return { origin: ORIGIN, identity: () => ({ key: this.key, publicKey: this.publicKey }), fetch: this.fetch, retryMs: [1, 1, 1] } }
  add(owner: OwnerClaimOwner = OWNER): string { const c = claimOf(); this.claims.set(c, { owner, spent: false }); return c }
}

describe('setup from the hosting console', () => {
  let h: Harness, cp: FakeCp, n = 0
  beforeEach(async () => {
    h = await harness('setup-console-' + ++n)
    ;(h.ctx.config as any).deployment = 'hosted'
    cp = new FakeCp()
    setOwnerClaimClient(h.ctx, cp.client())
  })
  afterEach(async () => { await h.close() })

  const users = () => (h.ctx.db.query('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
  const guardCount = (ip: string) => (h.ctx.db.query('SELECT COUNT(*) AS n FROM login_attempts WHERE key = ?').get(`token-ip:${ip}`) as { n: number }).n

  test('reserve → owner → confirm: an e-mail owner with a password, a desktop session, username from the e-mail', async () => {
    const claim = cp.add()
    const app = h.client()
    const pre = await app.call('POST', PREVIEW, { claim })
    expect(pre).toEqual({ teamName: 'Acme Studio', name: 'Alex Kim', email: OWNER.email, google: false })
    // the preview spends nothing and makes nothing
    expect(cp.claims.get(claim)!.spent).toBe(false)
    expect(users()).toBe(0)
    const res = await app.raw('POST', SETUP, { claim, password: 'owner horse battery 42' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as any
    expect(body.token).toBeUndefined()
    expect(body.me.session.client).toBe('desktop')
    expect(body.me.user.role).toBe('owner')
    expect(body.me.user.username).toBe('alex.kim')
    expect(body.me.team.name).toBe('Acme Studio')
    expect((await app.call('GET', '/api/me')).user.username).toBe('alex.kim')
    expect(cp.calls.map((x) => x.path)).toEqual([OWNER_CLAIM_RESERVE_PATH, OWNER_CLAIM_RESERVE_PATH, OWNER_CLAIM_CONFIRM_PATH])
    expect(cp.claims.get(claim)!.spent).toBe(true)
    expect(getTeamSettings(h.ctx.db).teamName).toBe('Acme Studio')
    // the owner signs in with that password from another device
    expect((await h.client().try('POST', '/api/auth/login', { username: 'alex.kim', password: 'owner horse battery 42' })).status).toBe(200)
    const a = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'setup'").get() as { detail: string }
    expect(JSON.parse(a.detail)).toMatchObject({ method: 'console', teamName: 'Acme Studio' })
    expect(a.detail).not.toContain(claim)
    // the claim is spent: the same link again is gone, and the team is set up
    expect((await h.client().try('POST', SETUP, { claim, password: 'owner horse battery 42' })).status).toBe(409)
  })

  test('a Google owner gets no password; a password sent along is refused', async () => {
    const claim = cp.add({ ...OWNER, google: { sub: '109876543210', email: OWNER.email, hd: null } })
    expect((await h.client().call('POST', PREVIEW, { claim })).google).toBe(true)
    expect((await h.client().try('POST', SETUP, { claim, password: 'owner horse battery 42' })).status).toBe(400)
    expect(users()).toBe(0)
    const app = h.client()
    const r = await app.call('POST', SETUP, { claim })
    const u = getUser(h.ctx.db, r.me.user.id)!
    expect(u.password_hash).toBeNull()
    const ident = h.ctx.db.query('SELECT * FROM login_identities WHERE user_id = ?').get(u.id) as any
    expect(ident.subject ?? ident.sub).toBe('109876543210')
    expect(cp.claims.get(claim)!.spent).toBe(true)
  })

  test('a weak or missing password leaves the claim unspent and makes nothing', async () => {
    const claim = cp.add()
    const weak = await h.client().try('POST', SETUP, { claim, password: 'short' })
    expect(weak.status).toBe(400)
    expect(weak.body.error.fields['body.password']).toBeTruthy()
    const none = await h.client().try('POST', SETUP, { claim })
    expect(none.status).toBe(400)
    expect(none.body.error.fields['body.password']).toBe('required')
    expect(users()).toBe(0)
    expect(cp.calls.every((x) => x.path === OWNER_CLAIM_RESERVE_PATH)).toBe(true)
    expect(cp.claims.get(claim)!.spent).toBe(false)
    // and it still works with a good one
    expect((await h.client().try('POST', SETUP, { claim, password: 'owner horse battery 42' })).status).toBe(201)
  })

  test('the guard and the shape check come before any call to the console', async () => {
    const c = h.client({ ip: '10.8.8.8' })
    for (const claim of ['short', 'A'.repeat(42) + '+', 'A'.repeat(44)]) expect((await c.try('POST', PREVIEW, { claim })).status).toBe(410)
    expect(cp.calls).toEqual([])
    expect(guardCount('10.8.8.8')).toBe(3)
    // over the limit: refused before the shape check and before the console
    for (let i = 0; i < 30; i++) await c.try('POST', SETUP, { claim: 'x' })
    const over = await c.try('POST', PREVIEW, { claim: cp.add() })
    expect(over.status).toBe(429)
    expect(cp.calls).toEqual([])
  })

  test('an unknown claim is gone and counted; a team that is set up is a conflict', async () => {
    const c = h.client({ ip: '10.7.7.7' })
    expect((await c.try('POST', PREVIEW, { claim: claimOf() })).status).toBe(410)
    expect(guardCount('10.7.7.7')).toBe(1)
    await bootstrapOwner(h.ctx, { username: 'olga', name: 'Olga', teamName: 'Acme', locale: 'en', credential: { password: 'owner horse battery 42' } })
    const before = cp.calls.length
    expect((await c.try('POST', PREVIEW, { claim: cp.add() })).status).toBe(409)
    expect(cp.calls.length).toBe(before)
  })

  test('a console that is down, older (404) or refuses: unavailable, nothing made', async () => {
    const claim = cp.add()
    cp.next = ['throw']
    expect((await h.client().try('POST', PREVIEW, { claim })).status).toBe(503)
    cp.next = [404]
    expect((await h.client().try('POST', SETUP, { claim, password: 'owner horse battery 42' })).status).toBe(503)
    cp.next = [403]
    expect((await h.client().try('POST', SETUP, { claim, password: 'owner horse battery 42' })).status).toBe(503)
    expect(users()).toBe(0)
    // no console configured (a test app never calls the real one)
    setOwnerClaimClient(h.ctx, null)
    expect((await h.client().try('POST', PREVIEW, { claim })).status).toBe(503)
  })

  test('a failed confirm does not stop the sign-in and is tried again', async () => {
    const claim = cp.add()
    const realFetch = cp.fetch
    let confirms = 0
    setOwnerClaimClient(h.ctx, { ...cp.client(), fetch: (async (u: any, i: any) => {
      if (String(u).endsWith(OWNER_CLAIM_CONFIRM_PATH) && ++confirms <= 2) throw new Error('offline')
      return realFetch(u, i)
    }) as typeof fetch })
    expect((await h.client().try('POST', SETUP, { claim, password: 'owner horse battery 42' })).status).toBe(201)
    for (let i = 0; i < 50 && !cp.claims.get(claim)!.spent; i++) await Bun.sleep(5)
    expect(cp.claims.get(claim)!.spent).toBe(true)
    expect(confirms).toBe(3)
    // a repeat confirm (a lost answer) is harmless
    expect(await confirmInBackground(h.ctx, cp.client(), claim).done).toBe(true)
  })

  test('only a hosted server; CSRF like every public POST', async () => {
    const claim = cp.add()
    expect((await h.client().try('POST', PREVIEW, { claim }, { 'x-mycel-csrf': '' })).status).toBe(403)
    expect((await h.client().try('POST', PREVIEW, { claim }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    ;(h.ctx.config as any).deployment = 'self'
    expect((await h.client().try('POST', PREVIEW, { claim })).status).toBe(404)
    expect(cp.calls).toEqual([])
  })

  test('bootstrapOwner: the username from the e-mail when none is given', async () => {
    const id = await bootstrapOwner(h.ctx, { email: 'Sam_Lee+x@example.com', name: 'Sam', teamName: 'Acme', locale: 'en', credential: { password: 'owner horse battery 42' } })
    expect(getUser(h.ctx.db, id)!.username).toBe('sam_lee')
  })
})
