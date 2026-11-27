// Sign in to the hosting console from the desktop app (docs/decisions/20261126-desktop-create-team.md, RFC 8252): the
// system browser opens `<console>/app/connect` with a state and a PKCE S256 challenge, the console returns to this
// app's own loopback listener (common/console-return.ts), and the one-time code becomes a 2-hour bearer token for
// `/api/app/v1/*` only (`POST /api/app/v1/token {v:1, code, verifier}`). The token is kept with the system's secure
// storage (Electron safeStorage) in <userData>/console-token.json; without secure storage it lives only until the app
// quits. Never logged.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { APP_PATHS, appConnectUrl, parseAppTokenAnswer, type AppEmailStart, type AppEmailVerify, type AppTokenAnswer } from '@mycel/shared/cloud-protocol/owner-claim'
import { ConsoleReturn, newState, pkcePair } from '../common/console-return'
import { emailSignInError, offerFromProbe, type CreateOffer, type EmailSignInError } from '../common/create-team'
import { debug } from './debug'

export type SignInResult = { ok: true; token: AppTokenAnswer } | { ok: false; error: 'cancelled' | 'expired' | 'offline' | 'closed' | 'failed' }
export type EmailResult = { ok: true } | { ok: false; error: EmailSignInError }
export type ApiAnswer = { status: number; body: unknown } | { status: null }

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export class ConsoleSignIn {
  private readonly ret: ConsoleReturn
  private mem: AppTokenAnswer | null = null
  private offer: { value: CreateOffer; at: number } | null = null
  private probing: Promise<CreateOffer> | null = null
  /** a sign-in under way: Cancel closes its listener */
  private running = 0
  /** the e-mail sign-in under way: the address and the PKCE verifier of its code (never written anywhere) */
  private email: { address: string; verifier: string } | null = null

  constructor(private readonly o: {
    origin: string
    userData: string
    fetch: Fetch
    openExternal: (url: string) => void
    locale: () => string
    /** the words of the browser's page after the return */
    donePage: () => string
  }) {
    this.ret = new ConsoleReturn({ page: o.donePage })
  }

  get origin() {
    return this.o.origin
  }

  /** Whether the console offers this flow (cached for the session once it answered 401 or 404; an unknown answer is
   * asked again after 30 s, or at once with `fresh`: main.ts retries an unknown answer until it is known). A redirect is
   * an error here (`redirect: "error"`; Electron's net.fetch throws on "manual" when one comes), so a portal or proxy
   * reads as unknown and is asked again. */
  async probe(fresh = false): Promise<CreateOffer> {
    if (this.offer && (this.offer.value !== 'unknown' || (!fresh && Date.now() - this.offer.at < 30_000))) return this.offer.value
    this.probing ??= (async () => {
      let status: number | null = null
      try {
        const r = await this.o.fetch(this.o.origin + APP_PATHS.me, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000) })
        status = r.status
      } catch {}
      const value = offerFromProbe(status)
      this.offer = { value, at: Date.now() }
      this.probing = null
      debug('console create offer', value)
      return value
    })()
    return this.probing
  }

  /** the last known answer of probe(), without asking */
  knownOffer(): CreateOffer | null {
    return this.offer?.value ?? null
  }

  /** the saved token while it is good (a minute of margin), else null */
  token(): AppTokenAnswer | null {
    const t = this.mem ?? this.load()
    if (!t || Date.parse(t.expiresAt) - 60_000 <= Date.now()) return null
    return t
  }

  forget() {
    this.mem = null
    try {
      rmSync(this.file(), { force: true })
    } catch {}
  }

  /** Open the browser and wait for the console's return; `store`: the Mac App Store build's read-and-open sign-in. */
  async signIn(store: boolean): Promise<SignInResult> {
    const run = ++this.running
    const state = newState()
    const { verifier, challenge } = pkcePair()
    const open = await this.ret.open(state)
    if (!open) return { ok: false, error: 'failed' }
    const lang = this.o.locale()
    this.o.openExternal(appConnectUrl(this.o.origin, { state, challenge, port: open.port, locale: /^[a-z]{2}$/.test(lang) ? lang : 'en', store }))
    const a = await open.answer
    if (run !== this.running) return { ok: false, error: 'closed' }
    if ('error' in a) {
      if (a.error === 'timeout' || a.error === 'expired') return { ok: false, error: 'expired' }
      if (a.error === 'closed') return { ok: false, error: 'closed' }
      return { ok: false, error: 'cancelled' }
    }
    let r: Response
    try {
      r = await this.o.fetch(this.o.origin + APP_PATHS.token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, code: a.code, verifier }),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      return { ok: false, error: 'offline' }
    }
    if (run !== this.running) return { ok: false, error: 'closed' }
    const token = r.ok ? parseAppTokenAnswer(await r.json().catch(() => null)) : null
    if (!token) return { ok: false, error: r.status === 400 || r.status === 410 ? 'expired' : 'failed' }
    this.save(token)
    return { ok: true, token }
  }

  /** Sign in without the browser, step 1: the console mails a 6-digit code to `address` (a new code each time: Send
   * again makes a new verifier, so only the newest code works). */
  async emailStart(address: string, store: boolean): Promise<EmailResult> {
    const { verifier, challenge } = pkcePair()
    const lang = this.o.locale()
    const body: AppEmailStart = { email: address, locale: /^[a-z]{2}$/.test(lang) ? lang : 'en', challenge, ...(store ? { store: true as const } : {}) }
    const r = await this.post(APP_PATHS.emailStart, body)
    if (r.status === null) return { ok: false, error: 'offline' }
    if (r.status >= 300) return { ok: false, error: emailSignInError(r.status, r.body) }
    this.email = { address, verifier }
    return { ok: true }
  }

  /** step 2: the code the person typed becomes the same token the browser's sign-in gives */
  async emailVerify(code: string): Promise<EmailResult> {
    const e = this.email
    if (!e) return { ok: false, error: 'codeExpired' }
    const body: AppEmailVerify = { email: e.address, code, verifier: e.verifier }
    const r = await this.post(APP_PATHS.emailVerify, body)
    if (r.status === null) return { ok: false, error: 'offline' }
    const token = r.status < 300 ? parseAppTokenAnswer(r.body) : null
    if (!token) return { ok: false, error: r.status < 300 ? 'failed' : emailSignInError(r.status, r.body) }
    this.email = null
    this.save(token)
    return { ok: true }
  }

  private async post(path: string, body: unknown): Promise<ApiAnswer> {
    try {
      const r = await this.o.fetch(this.o.origin + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      })
      return { status: r.status, body: await r.json().catch(() => null) }
    } catch {
      return { status: null }
    }
  }

  /** Cancel a sign-in under way: its listener closes (this listener only) */
  cancel() {
    this.running++
    this.ret.close()
  }

  /** One call of `/api/app/v1/*` with the bearer token and no cookie. status null: no answer. */
  async api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiAnswer> {
    const t = this.token()
    if (!t) return { status: 401, body: null }
    try {
      const r = await this.o.fetch(this.o.origin + path, {
        method,
        headers: { authorization: `Bearer ${t.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      })
      const json = await r.json().catch(() => null)
      if (r.status === 401) this.forget()
      return { status: r.status, body: json }
    } catch {
      return { status: null }
    }
  }

  private file() {
    return join(this.o.userData, 'console-token.json')
  }

  private save(t: AppTokenAnswer) {
    this.mem = t
    try {
      if (!safeStorage.isEncryptionAvailable()) return
      // Linux without a keyring: Electron's fixed-key fallback is no secret store, so nothing is written
      if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return
      writeFileSync(this.file(), JSON.stringify({ sealed: safeStorage.encryptString(JSON.stringify(t)).toString('base64') }), { mode: 0o600 })
    } catch (e) {
      debug('console token not saved', (e as Error).message)
    }
  }

  private load(): AppTokenAnswer | null {
    try {
      if (!existsSync(this.file()) || !safeStorage.isEncryptionAvailable()) return null
      const { sealed } = JSON.parse(readFileSync(this.file(), 'utf8')) as { sealed?: string }
      if (typeof sealed !== 'string') return null
      const t = parseAppTokenAnswer(JSON.parse(safeStorage.decryptString(Buffer.from(sealed, 'base64'))))
      this.mem = t
      return t
    } catch {
      return null
    }
  }
}
