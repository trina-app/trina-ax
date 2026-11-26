// A fake hosting console and a fake new team for create-team.spec.ts (started by the spec itself, in its own process,
// on ports the system picks). Test data only (owner@example.com, "Acme Cafe").
//
//   console  http://127.0.0.1:<port>   /api/app/v1/* of shared/src/cloud-protocol/owner-claim.ts: token (PKCE S256
//            checked), me, teams, teams/:id[/retry|/resume|/owner-claim], waitlist. Without a token GET /me answers 401
//            (the app offers the create row), or 404 when `old` (an older hosting service).
//   team     http://cafe.localhost:<port>   /api/health, and the owner setup page /app-setup#c=<claim> as a stub of the
//            team server's (S5: "Welcome to {team}, {name}", a password for an e-mail owner, Continue), then "/".
//
// The spec plays the person's browser: browse(connectUrl) reads the connect address the app opened, makes a one-time
// code for its challenge and sends the browser's GET to the app's loopback callback.
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { APP_CALLBACK_PATH, parseAppConnectParams, parseAppEmailStart, parseAppEmailVerify, parseAppCreateTeam, type AppMe, type AppTeam, type AppTeamState } from '@mycel/shared/cloud-protocol/owner-claim'

export interface Scenario {
  /** an older hosting service: /api/app/v1/* answers 404 */
  old: boolean
  email: string
  owner: 'google' | 'email'
  team: AppTeam | null
  freeLeft: boolean
  waitlist: boolean
  /** POST /teams answers this error instead of making the team (once, or `sticky`) */
  createError: { code: string; status: number; fields?: Record<string, string>; sticky?: boolean } | null
  /** POST /teams/:id/owner-claim answers this error */
  claimError: { code: string; status: number; fields?: Record<string, string> } | null
  /** how many GET /teams/:id answers say "provisioning" before the team is active */
  provisionPolls: number
  /** every GET /teams/:id answers 401 (the token expired while the team was made) */
  expireOnPoll: boolean
  /** POST /teams/:id/resume answers this error */
  resumeError: { code: string; status: number } | null
  /** POST /email/verify answers code_expired for the newest code */
  emailCodeExpired: boolean
  /** the next GET /teams/:id of a team being made says this setup failure (still provisioning), until a retry */
  provisionError: 'slug_conflict' | 'setup_failed' | null
  /** the bodies of POST /teams/:id/retry */
  retries: unknown[]
}

const freePlan = { maxActiveMembers: 3, maxConcurrency: 1, diskGB: 5, termsUrl: 'https://terms.example.test/free', privacyUrl: 'https://terms.example.test/privacy', termsVersion: 'free-2026-11' }

export async function startFakeConsole() {
  const tokens = new Map<string, { store: boolean; expires: number }>()
  const codes = new Map<string, { challenge: string; store: boolean }>()
  /** e-mail sign-ins: the newest code per address, its challenge, and the wrong tries */
  const mails = new Map<string, { code: string; challenge: string; store: boolean; wrong: number }>()
  const sent: { email: string; code: string; locale: string; store: boolean }[] = []
  let mailSeq = 0
  const log: { method: string; path: string; body: unknown; auth: string | null; cookie: string | null }[] = []
  let polls = 0
  const sc: Scenario = { old: false, email: 'owner@example.com', owner: 'google', team: null, freeLeft: true, waitlist: false, createError: null, claimError: null, provisionPolls: 1, expireOnPoll: false, resumeError: null, emailCodeExpired: false, provisionError: null, retries: [] }
  const claims = new Set<string>()
  const setups: { claim: string; password: string | null }[] = []

  const team = http.createServer()
  await new Promise<void>((r) => team.listen(0, '127.0.0.1', r))
  const teamPort = (team.address() as AddressInfo).port
  const teamUrl = `http://cafe.localhost:${teamPort}`

  const newTeam = (name: string, slug: string, state: AppTeamState = 'provisioning'): AppTeam => ({
    id: 'team_cafe1', name, slug, url: teamUrl, state, setUp: false, planId: 'free', comeback: false,
    provisioning: state === 'provisioning' ? { step: 1, error: null, waitingCapacity: false } : null,
  })

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const fail = (res: http.ServerResponse, status: number, code: string, fields?: Record<string, string>) => send(res, status, { error: { code, message: code, ...(fields ? { fields } : {}) } })
  const readBody = (req: http.IncomingMessage) => new Promise<unknown>((resolve) => {
    let b = ''
    req.on('data', (d) => (b += d))
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : null) } catch { resolve(null) } })
  })

  const consoleServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const p = url.pathname
    const body = req.method === 'POST' ? await readBody(req) : null
    log.push({ method: req.method ?? '', path: p, body, auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null })
    if (sc.old && p.startsWith('/api/app/')) return fail(res, 404, 'not_found')
    if (p === '/api/app/v1/email/start' && req.method === 'POST') {
      const b = parseAppEmailStart(body)
      if (!b) return fail(res, 400, 'invalid_request')
      const code = String(100000 + ++mailSeq)
      mails.set(b.email, { code, challenge: b.challenge, store: b.store === true, wrong: 0 })
      sent.push({ email: b.email, code, locale: String(b.locale), store: b.store === true })
      return send(res, 200, { ok: true })
    }
    if (p === '/api/app/v1/email/verify' && req.method === 'POST') {
      const b = parseAppEmailVerify(body)
      const m = b ? mails.get(b.email) : undefined
      if (!b || !m || typeof b.verifier !== 'string' || createHash('sha256').update(b.verifier).digest('base64url') !== m.challenge) return fail(res, 400, 'code_invalid')
      if (sc.emailCodeExpired) return fail(res, 400, 'code_expired')
      if (b.code !== m.code) {
        if (++m.wrong >= 3) { mails.delete(b.email!); return fail(res, 429, 'code_exhausted') }
        return fail(res, 400, 'code_invalid')
      }
      mails.delete(b.email!)
      const token = randomBytes(32).toString('base64url')
      tokens.set(token, { store: m.store, expires: Date.now() + 2 * 3600_000 })
      sc.email = b.email!
      return send(res, 200, { token, expiresAt: new Date(Date.now() + 2 * 3600_000).toISOString(), store: m.store })
    }
    if (p === '/api/app/v1/token' && req.method === 'POST') {
      const b = body as { v?: number; code?: string; verifier?: string } | null
      const c = b?.code ? codes.get(b.code) : undefined
      if (!b || b.v !== 1 || !c || typeof b.verifier !== 'string' || createHash('sha256').update(b.verifier).digest('base64url') !== c.challenge) return fail(res, 400, 'invalid_request')
      codes.delete(b.code!)
      const token = randomBytes(32).toString('base64url')
      tokens.set(token, { store: c.store, expires: Date.now() + 2 * 3600_000 })
      return send(res, 200, { token, expiresAt: new Date(Date.now() + 2 * 3600_000).toISOString(), store: c.store })
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    const tok = bearer ? tokens.get(bearer) : undefined
    if (!tok) return fail(res, 401, 'unauthorized')
    if (p === '/api/app/v1/me' && req.method === 'GET') {
      const me: AppMe = { accountId: 'acc_1', email: sc.email, team: sc.team, freeLeft: sc.freeLeft, waitlist: sc.waitlist, freePlan, store: tok.store }
      return send(res, 200, me)
    }
    if (p === '/api/app/v1/teams' && req.method === 'POST') {
      if (tok.store) return fail(res, 403, 'forbidden')
      const c = parseAppCreateTeam(body)
      if (!c) return fail(res, 400, 'invalid_request')
      if (sc.createError) {
        const e = sc.createError
        if (!e.sticky) sc.createError = null
        return fail(res, e.status, e.code, e.fields)
      }
      sc.team = newTeam(c.displayName, c.slug)
      polls = 0
      return send(res, 201, { team: sc.team })
    }
    const m = /^\/api\/app\/v1\/teams\/([^/]+)(?:\/(retry|resume|owner-claim))?$/.exec(p)
    if (m) {
      if (!sc.team || sc.team.id !== m[1]) return fail(res, 404, 'not_found')
      const op = m[2]
      if (!op && req.method === 'GET') {
        if (sc.expireOnPoll) {
          tokens.delete(bearer!)
          return fail(res, 401, 'unauthorized')
        }
        if (sc.team.state === 'provisioning' && sc.provisionError) {
          sc.team = { ...sc.team, provisioning: { step: 1, error: sc.provisionError, waitingCapacity: false } }
          return send(res, 200, { team: sc.team })
        }
        if (sc.team.state === 'provisioning') {
          polls++
          if (polls > sc.provisionPolls) sc.team = { ...sc.team, state: 'active', provisioning: null }
          else sc.team = { ...sc.team, provisioning: { step: Math.min(3, polls + 1) as 1 | 2 | 3, error: null, waitingCapacity: false } }
        }
        return send(res, 200, { team: sc.team })
      }
      if ((op === 'resume' || op === 'retry') && req.method === 'POST') {
        if (tok.store) return fail(res, 403, 'forbidden')
        if (op === 'resume' && sc.resumeError) return fail(res, sc.resumeError.status, sc.resumeError.code)
        if (op === 'retry') {
          const b = body as { slug?: unknown } | null
          sc.retries.push(b)
          sc.provisionError = null
          if (typeof b?.slug === 'string') sc.team = { ...sc.team, slug: b.slug, url: sc.team.url }
        }
        sc.team = { ...sc.team, state: 'provisioning', provisioning: { step: 1, error: null, waitingCapacity: false } }
        polls = 0
        return send(res, 200, { team: sc.team })
      }
      if (op === 'owner-claim' && req.method === 'POST') {
        if (sc.claimError) return fail(res, sc.claimError.status, sc.claimError.code, sc.claimError.fields)
        if (sc.team.setUp) return fail(res, 409, 'already_set_up')
        const claim = randomBytes(32).toString('base64url')
        claims.add(claim)
        return send(res, 200, { url: `${teamUrl}/app-setup#c=${claim}` })
      }
    }
    if (p === '/api/app/v1/waitlist' && req.method === 'POST') {
      if (tok.store) return fail(res, 403, 'forbidden')
      return send(res, 200, { ok: true })
    }
    fail(res, 404, 'not_found')
  })
  await new Promise<void>((r) => consoleServer.listen(0, '127.0.0.1', r))
  const consolePort = (consoleServer.address() as AddressInfo).port

  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  team.on('request', async (req, res) => {
    const url = new URL(req.url ?? '/', teamUrl)
    const p = url.pathname
    if (p === '/api/health') return send(res, 200, { ok: true, version: '0.0.0-test', schema: { applied: 2, readerLevel: 1 }, uptimeSec: 1, time: new Date().toISOString() })
    if (p === '/api/me') return send(res, 401, { error: { code: 'unauthorized', message: 'no' } })
    if (p === '/api/setup/console/preview' && req.method === 'POST') {
      const b = (await readBody(req)) as { claim?: string } | null
      if (!b?.claim || !claims.has(b.claim)) return send(res, 410, { error: { code: 'invalid_claim', message: 'no' } })
      return send(res, 200, { team: sc.team?.name ?? '', name: sc.email.split('@')[0], google: sc.owner === 'google' })
    }
    if (p === '/api/setup/console' && req.method === 'POST') {
      const b = (await readBody(req)) as { claim?: string; password?: string } | null
      if (!b?.claim || !claims.delete(b.claim)) return send(res, 410, { error: { code: 'invalid_claim', message: 'no' } })
      setups.push({ claim: b.claim, password: b.password ?? null })
      if (sc.team) sc.team = { ...sc.team, setUp: true }
      return send(res, 200, { ok: true })
    }
    if (p === '/app-setup') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(`<!doctype html><title>Setup</title><main id="s5">…</main><script>
const claim = /^#c=([A-Za-z0-9_-]{43})$/.exec(location.hash)?.[1]
history.replaceState(null, '', '/app-setup')
const main = document.getElementById('s5')
if (!claim) main.textContent = 'no claim'
else fetch('/api/setup/console/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claim }) }).then((r) => r.json()).then((o) => {
  main.innerHTML = '<h1 id="welcome"></h1>' + (o.google ? '' : '<label>Choose a password <input id="pw" type="password"></label>') + '<button id="go">Continue</button>'
  document.getElementById('welcome').textContent = 'Welcome to ' + o.team + ', ' + o.name
  document.getElementById('go').onclick = () => fetch('/api/setup/console', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o.google ? { claim } : { claim, password: document.getElementById('pw').value }) }).then((r) => { if (r.ok) location.href = '/' })
})
</script>`)
    }
    if (p === '/setup') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(`<!doctype html><title>Old setup</title><h1 id="old-setup"></h1><script>document.getElementById('old-setup').textContent = 'Old setup ' + location.hash</script>`)
    }
    if (p === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(`<!doctype html><title>${esc(sc.team?.name ?? 'Team')}</title><h1 id="team-home">${esc(sc.team?.name ?? 'Team')} home</h1>`)
    }
    res.writeHead(404)
    res.end()
  })

  /** the person's browser: the connect address the app opened → the app's loopback callback (code, or an error) */
  async function browse(connectUrl: string, o: { error?: 'cancelled' | 'expired' | 'denied' } = {}): Promise<number> {
    const u = new URL(connectUrl)
    if (u.origin !== `http://127.0.0.1:${consolePort}` || u.pathname !== '/app/connect') throw new Error(`not the connect page: ${u.origin}${u.pathname}`)
    const params = parseAppConnectParams(u.searchParams)
    if (!params) throw new Error('bad connect params')
    const back = new URL(`http://127.0.0.1:${params.port}${APP_CALLBACK_PATH}`)
    if (o.error) back.searchParams.set('error', o.error)
    else {
      const code = randomBytes(32).toString('base64url')
      codes.set(code, { challenge: params.challenge, store: params.store })
      back.searchParams.set('code', code)
    }
    back.searchParams.set('state', params.state)
    // a page load as a browser sends it (fetch() would say sec-fetch-mode: cors)
    return new Promise<number>((resolve, reject) => {
      http.get(back, { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, agent: false }, (r) => {
        r.resume()
        r.on('end', () => resolve(r.statusCode ?? 0))
      }).on('error', reject)
    })
  }

  return {
    origin: `http://127.0.0.1:${consolePort}`,
    teamUrl,
    sc,
    log,
    setups,
    newTeam,
    browse,
    /** forget every token (as a 2-hour expiry would) */
    expireTokens: () => tokens.clear(),
    /** the codes "mailed" so far (newest last) */
    sent,
    reset() {
      Object.assign(sc, { old: false, email: 'owner@example.com', owner: 'google', team: null, freeLeft: true, waitlist: false, createError: null, claimError: null, provisionPolls: 1, expireOnPoll: false, resumeError: null, emailCodeExpired: false, provisionError: null, retries: [] })
      log.length = 0
      sent.length = 0
      mails.clear()
      setups.length = 0
      polls = 0
    },
    async close() {
      consoleServer.closeAllConnections?.()
      team.closeAllConnections?.()
      await Promise.all([new Promise((r) => consoleServer.close(r)), new Promise((r) => team.close(r))])
    },
  }
}
export type FakeConsole = Awaited<ReturnType<typeof startFakeConsole>>
