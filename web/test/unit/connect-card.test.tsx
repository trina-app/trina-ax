// connect_service cards (components/chat/ConnectCard.tsx, lib/connectCard.ts): the key leaves the card only sealed for
// 'integration.secret' and only to POST /api/turns/:id/connect (never /answer, never in plain, never in the store);
// "Not now" sends skip; a failed check keeps the card; the card shows where the key goes. Where it connects is the main
// line (the host, then the whole address) with a caution when the name is not in the host; an HTTP API's notes, saved
// with the connection for the AI, are shown in full and read-only.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SEAL_ALG, SealedSecret, TurnConnectBody, TurnRequest, uuidv7, type Locale, type SealingKey } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import ConnectCard from '../../src/components/chat/ConnectCard'
import { connectCase, connectWithKey, connectWithoutKey, finishConnect, hostOffName, skipConnect, type ConnectServiceRequest } from '../../src/lib/connectCard'
import { useChats } from '../../src/store/chats'
import { CHAT } from './fixtures'

const KEY = 'hf_live_9a8B7c6D5e4F3g2H1i0J'
const TURN = uuidv7()
const KID = '0123456789abcdef'
const realFetch = globalThis.fetch
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })

let calls: { method: string; path: string; url: string; body: any; raw: string }[] = []
let connectAnswer: unknown = { state: 'connected', integrationId: 'i1', status: 'connected', lastError: null }
let server: CryptoKeyPair

const card = (o: Partial<ConnectServiceRequest> = {}): ConnectServiceRequest => ({
  kind: 'connect_service',
  requestId: 'c1',
  target: 'service',
  name: 'Higgsfield',
  scope: 'personal',
  service: { kind: 'mcp', url: 'https://mcp.higgsfield.example/mcp', host: 'mcp.higgsfield.example', auth: 'bearer', authHeader: null },
  why: 'You asked to make videos with Higgsfield.',
  ...o,
})
const open = (r: ConnectServiceRequest) => useChats.getState().handleEvent({ type: 'turn.request', seq: 1, at: 0, data: { turnId: TURN, chatId: CHAT, messageId: uuidv7(), request: r } })

const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0))
/** what the team server would read out of it (server/src/credentials/seal.ts unseal, without the replay check) */
async function unseal(s: SealedSecret): Promise<{ secret: string; nonce: string; purpose: string }> {
  const subtle = globalThis.crypto.subtle
  const epk = await subtle.importKey('raw', fromB64u(s.epk), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = await subtle.deriveBits({ name: 'ECDH', public: epk }, server.privateKey, 256)
  const hk = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  const aes = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(`mycel-seal-v1|${s.kid}`) }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
  return JSON.parse(new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(s.iv) }, aes, fromB64u(s.ct))))
}

beforeEach(async () => {
  calls = []
  connectAnswer = { state: 'connected', integrationId: 'i1', status: 'connected', lastError: null }
  useChats.getState().reset()
  server = (await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', server.publicKey)
  const sealingKey: SealingKey = { kid: KID, alg: SEAL_ALG, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://team.localhost')
    const raw = typeof init?.body === 'string' ? init.body : ''
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, url: url.href, body: raw ? JSON.parse(raw) : undefined, raw })
    if (url.pathname === '/api/credentials/sealing-key') return json(sealingKey)
    if (url.pathname === `/api/turns/${TURN}/connect`) return json(connectAnswer)
    return json({ error: { code: 'not_found', message: 'not here' } }, 404)
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('the key leaves the card only sealed', () => {
  test('sealed for integration.secret, posted to /connect with the card id; the plain key is in no request', async () => {
    const r = card()
    open(r)
    const res = await connectWithKey(r, `  ${KEY}\n`, 'everyone')
    expect(res?.state).toBe('connected')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/credentials/sealing-key', `POST /api/turns/${TURN}/connect`])
    // not in any address, body or field of any request
    for (const c of calls) {
      expect(c.url).not.toContain(KEY)
      expect(c.raw).not.toContain(KEY)
    }
    const body = calls[1]!.body
    // a personal connection: no access; the body is exactly the contract's connect action
    expect(Object.keys(body).sort()).toEqual(['action', 'requestId', 'sealed'])
    expect(TurnConnectBody.parse(body)).toEqual(body)
    expect(body.action).toBe('connect')
    expect(body.requestId).toBe('c1')
    expect(SealedSecret.safeParse(body.sealed).success).toBe(true)
    expect(body.sealed.kid).toBe(KID)
    // what the server opens: the trimmed key, for this purpose only
    const opened = await unseal(body.sealed)
    expect(opened.secret).toBe(KEY)
    expect(opened.purpose).toBe('integration.secret')
    // connected: the card is gone, and the store never held the key
    expect(useChats.getState().requests).toEqual({})
    expect(JSON.stringify(useChats.getState())).not.toContain(KEY)
    expect(calls.some((c) => c.path.endsWith('/answer'))).toBe(false)
  })

  test('a team connection says who may use it', async () => {
    const r = card({ scope: 'team' })
    open(r)
    await connectWithKey(r, KEY, 'me')
    expect(calls[1]!.body.access).toBe('me')
    expect(calls[1]!.raw).not.toContain(KEY)
  })

  test('a failed check (retry) keeps the card open for another key', async () => {
    const r = card()
    open(r)
    connectAnswer = { state: 'retry', integrationId: 'i1', status: 'error', lastError: 'The service refused the key (HTTP 401).' }
    const res = await connectWithKey(r, KEY, 'me')
    expect(res).toEqual(connectAnswer as never)
    expect(Object.keys(useChats.getState().requests)).toEqual(['c1'])
  })
})

describe('the other buttons', () => {
  test('"Not now" sends skip and closes the card', async () => {
    const r = card()
    open(r)
    connectAnswer = { state: 'skipped' }
    await skipConnect(r)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.path).toBe(`/api/turns/${TURN}/connect`)
    expect(calls[0]!.body).toEqual({ action: 'skip', requestId: 'c1' })
    expect(useChats.getState().requests).toEqual({})
  })

  test('sign-in: connect without a key gives the connection to sign in to, then done tells the server', async () => {
    const r = card({ scope: 'team', service: { kind: 'mcp', url: 'https://mcp.linear.example/mcp', host: 'mcp.linear.example', auth: 'oauth', authHeader: null } })
    open(r)
    connectAnswer = { state: 'sign_in', integrationId: 'i9', status: 'needs_auth' }
    expect((await connectWithoutKey(r, 'everyone'))?.integrationId).toBe('i9')
    expect(calls[0]!.body).toEqual({ action: 'connect', requestId: 'c1', access: 'everyone' })
    // still open while the person signs in
    expect(Object.keys(useChats.getState().requests)).toEqual(['c1'])
    connectAnswer = { state: 'connected', integrationId: 'i9', status: 'connected' }
    await finishConnect(r)
    expect(calls[1]!.body).toEqual({ action: 'done', requestId: 'c1' })
    expect(useChats.getState().requests).toEqual({})
  })

  test('a card that is no longer open sends nothing', async () => {
    expect(await skipConnect(card())).toBeNull()
    expect(calls).toHaveLength(0)
  })

  test('the case follows the target and how it signs in', () => {
    expect(connectCase(card())).toBe('key')
    expect(connectCase(card({ service: { ...card().service!, auth: 'header', authHeader: 'X-API-Key' } }))).toBe('key')
    expect(connectCase(card({ service: { ...card().service!, auth: 'oauth' } }))).toBe('sign_in')
    expect(connectCase(card({ service: { ...card().service!, auth: 'none' } }))).toBe('none')
    expect(connectCase(card({ target: 'google_drive', name: 'Google Drive', service: undefined }))).toBe('google_drive')
  })
})

describe('what the card shows', () => {
  // Server rendering reads the store's initial state: set the language there
  const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
  const before = useLocaleStore.getInitialState().locale
  afterEach(() => setLocale(before))
  const html = (r: ConnectServiceRequest) => renderToStaticMarkup(<ConnectCard request={r} />)

  for (const locale of ['en', 'ko'] as const) {
    test(`${locale}: a password box that says where the key goes, Connect and Not now`, () => {
      setLocale(locale)
      const out = html(card())
      const input = /<input[^>]*data-testid="connect-key"[^>]*>/.exec(out)?.[0] ?? ''
      expect(input).toContain('type="password"')
      expect(input).toContain('autoComplete="off"')
      expect(input).toContain('value=""')
      expect(out).toContain(translate(locale, 'connect.keyWhere', { host: 'mcp.higgsfield.example' }))
      expect(out).toContain(translate(locale, 'connect.connect'))
      expect(out).toContain(translate(locale, 'connect.notNow'))
      // nothing typed yet: Connect stays off
      expect(/<button[^>]*data-testid="connect-submit"[^>]*>/.exec(out)?.[0]).toContain('disabled=""')
    })
  }

  test('team: who may use it, "Just me" picked first', () => {
    setLocale('en')
    const out = html(card({ scope: 'team' }))
    expect(out).toContain('Who may use it')
    expect(/<input[^>]*data-testid="connect-access-me"[^>]*>/.exec(out)?.[0]).toContain('checked=""')
    expect(/<input[^>]*data-testid="connect-access-everyone"[^>]*>/.exec(out)?.[0]).not.toContain('checked=""')
    expect(html(card())).not.toContain('data-testid="connect-access-me"')
  })

  test('sign-in, no key and Google Drive have no key box', () => {
    setLocale('en')
    const signIn = html(card({ service: { kind: 'mcp', url: 'https://mcp.linear.example/mcp', host: 'mcp.linear.example', auth: 'oauth', authHeader: null }, name: 'Linear' }))
    expect(signIn).toContain('Sign in to Linear')
    expect(signIn).toContain('mcp.linear.example')
    expect(signIn).not.toContain('data-testid="connect-key"')
    const drive = html(card({ target: 'google_drive', name: 'Google Drive', service: undefined }))
    expect(drive).toContain(translate('en', 'drive.connect'))
    expect(drive).not.toContain('data-testid="connect-key"')
    expect(html(card({ service: { ...card().service!, auth: 'none' } }))).not.toContain('data-testid="connect-key"')
  })

  /** a text as React writes it into markup */
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
  /** the text of the element with this test id (its first one) */
  const part = (out: string, tag: string, testId: string) => new RegExp(`<${tag}[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</${tag}>`).exec(out)

  test('where it connects is the main line under the title, for every service case: the host, then the whole address', () => {
    setLocale('en')
    for (const auth of ['bearer', 'header', 'none', 'oauth'] as const) {
      const out = html(card({ service: { ...card().service!, auth, authHeader: auth === 'header' ? 'X-API-Key' : null } }))
      expect({ auth, host: part(out, 'p', 'connect-host')?.[1] }).toEqual({ auth, host: expect.stringContaining('>mcp.higgsfield.example<') })
      expect(part(out, 'p', 'connect-url')?.[1]).toBe('https://mcp.higgsfield.example/mcp')
      // above the AI's own line, right under the title
      const at = out.indexOf('data-testid="connect-host"')
      expect(at).toBeGreaterThan(out.indexOf(translate('en', 'connect.title', { name: 'Higgsfield' })))
      expect(at).toBeLessThan(out.indexOf('You asked to make videos with Higgsfield.'))
    }
    // a long address scrolls instead of being cut
    const long = `https://mcp.higgsfield.example/${'p/'.repeat(300)}end`
    const out = html(card({ service: { ...card().service!, url: long } }))
    expect(part(out, 'p', 'connect-url')?.[1]).toBe(long)
    expect(part(out, 'p', 'connect-url')?.[0]).toContain('overflow-y-auto')
  })

  test('a caution when no word of the name is in the host', () => {
    expect(hostOffName('GitHub', 'github-mcp.evil.example')).toBe(false)
    expect(hostOffName('GitHub', 'mcp.example.org')).toBe(true)
    expect(hostOffName('Higgsfield AI', 'mcp.higgsfield.example')).toBe(false)
    expect(hostOffName('Linear', 'MCP.LINEAR.APP')).toBe(false)
    expect(hostOffName('Google Calendar', 'calendarmcp.example.com')).toBe(false)
    // only words of 3+ characters count
    expect(hostOffName('X', 'api.x.com')).toBe(true)
    expect(hostOffName('My AI', 'my.ai.example')).toBe(true)
    for (const locale of ['en', 'ko', 'id', 'ja', 'es'] as const) {
      setLocale(locale)
      const warned = html(card({ name: 'GitHub', service: { kind: 'mcp', url: 'https://mcp.example.org/mcp', host: 'mcp.example.org', auth: 'oauth', authHeader: null } }))
      expect(part(warned, 'p', 'connect-host-caution')?.[0]).toContain(esc(translate(locale, 'connect.hostCaution', { name: 'GitHub' })))
      expect(html(card())).not.toContain('data-testid="connect-host-caution"')
    }
    setLocale('en')
    expect(translate('en', 'connect.hostCaution', { name: 'GitHub' })).toBe("This address is not on GitHub's own site. Check it before you connect.")
  })

  test('an HTTP API\'s notes: on the card in full, read-only, said to be saved and given to the AI', () => {
    setLocale('en')
    const notes = 'GET /tasks lists the tasks.\nPOST /tasks adds one.\n' + 'Use the cursor field to page. '.repeat(120) + 'END-OF-NOTES'
    const r = card({ service: { kind: 'http', url: 'https://api.higgsfield.example/v1', host: 'api.higgsfield.example', auth: 'bearer', authHeader: null }, notes })
    // the contract carries them as they are
    expect(TurnRequest.parse(r)).toMatchObject({ notes })
    const out = html(r)
    expect(out).toContain(translate('en', 'connect.notes'))
    const block = part(out, 'pre', 'connect-notes-text')!
    expect(block[1]).toBe(notes) // never cut: the block scrolls
    for (const cls of ['max-h-40', 'overflow-auto', 'font-mono', 'text-muted', 'whitespace-pre-wrap']) expect(block[0]).toContain(cls)
    expect(block[0]).toContain('tabindex="0"')
    expect(out).not.toContain('<textarea')
    // no notes, no block
    expect(html(card())).not.toContain('data-testid="connect-notes"')
  })

  test('sign-in: the service\'s sign-in page opens, the AI never sees the password', () => {
    for (const locale of ['en', 'ko', 'id', 'ja', 'es'] as const) {
      setLocale(locale)
      const out = html(card({ name: 'Linear', service: { kind: 'mcp', url: 'https://mcp.linear.example/mcp', host: 'mcp.linear.example', auth: 'oauth', authHeader: null } }))
      const where = part(out, 'p', 'connect-where')![0]
      expect(where).toContain(esc(translate(locale, 'connect.signInWhere', { name: 'Linear' })))
      // the host is the card's main line; this sentence does not name one (the sign-in server is often another)
      expect(where).not.toContain('mcp.linear.example')
    }
    setLocale('en')
    expect(translate('en', 'connect.signInWhere', { name: 'Linear' })).toBe("Signing in opens Linear's sign-in page. The AI never sees your password.")
  })
})
