// connect_service cards (components/chat/ConnectCard.tsx, lib/connectCard.ts): the key leaves the card only sealed for
// 'integration.secret' and only to POST /api/turns/:id/connect (never /answer, never in plain, never in the store);
// "Not now" sends skip; a failed check keeps the card; the card shows where the key goes. Where it connects is the main
// line (the host, then the whole address, then what kind of connection it is) with a caution when the name is not in
// the host; an HTTP API's notes, saved with the connection for the AI, are shown in full and read-only. The card
// rendered and clicked (dom-host.ts): a wrong key then the right one, signing in (the window reserved in the click,
// the connection added, the sign-in polled, then done), Google Drive finished with done, and done again after a
// failed one.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SEAL_ALG, SealedSecret, TurnConnectBody, TurnRequest, uuidv7, type Locale, type SealingKey } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import ConnectCard from '../../src/components/chat/ConnectCard'
import { cardTrust, connectCase, notOfficialOf, connectWithKey, connectWithoutKey, finishConnect, hostOffName, skipConnect, type ConnectServiceRequest } from '../../src/lib/connectCard'
import { useChats } from '../../src/store/chats'
import { CHAT } from './fixtures'
import { installDom, mount, removeDom } from './dom-host'

const KEY = 'hf_live_9a8B7c6D5e4F3g2H1i0J'
const TURN = uuidv7()
const KID = '0123456789abcdef'
const realFetch = globalThis.fetch
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })

type Call = { method: string; path: string; url: string; body: any; raw: string }
let calls: Call[] = []
let connectAnswer: unknown = { state: 'connected', integrationId: 'i1', status: 'connected', lastError: null }
/** answers by "METHOD /path" before the default ones (a test's own server) */
let routes: Record<string, (c: Call) => Response> = {}
let server: CryptoKeyPair

const card = (o: Partial<ConnectServiceRequest> = {}): ConnectServiceRequest => ({
  kind: 'connect_service',
  requestId: 'c1',
  target: 'service',
  name: 'Higgs Studio',
  scope: 'personal',
  service: { kind: 'mcp', url: 'https://mcp.higgsfield.example/mcp', host: 'mcp.higgsfield.example', auth: 'bearer', authHeader: null },
  why: 'You asked to make videos with Higgs Studio.',
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
  routes = {}
  connectAnswer = { state: 'connected', integrationId: 'i1', status: 'connected', lastError: null }
  useChats.getState().reset()
  server = (await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', server.publicKey)
  const sealingKey: SealingKey = { kid: KID, alg: SEAL_ALG, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://team.localhost')
    const raw = typeof init?.body === 'string' ? init.body : ''
    const call = { method: init?.method ?? 'GET', path: url.pathname, url: url.href, body: raw ? JSON.parse(raw) : undefined, raw }
    calls.push(call)
    const route = routes[`${call.method} ${call.path}`]
    if (route) return route(call)
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
    const signIn = html(card({ service: { kind: 'mcp', url: 'https://mcp.linear.example/mcp', host: 'mcp.linear.example', auth: 'oauth', authHeader: null }, name: 'Lineup' }))
    expect(signIn).toContain('Sign in to Lineup')
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
      expect(at).toBeGreaterThan(out.indexOf(translate('en', 'connect.title', { name: 'Higgs Studio' })))
      expect(at).toBeLessThan(out.indexOf('You asked to make videos with Higgs Studio.'))
    }
    // a long address scrolls instead of being cut
    const long = `https://mcp.higgsfield.example/${'p/'.repeat(300)}end`
    const out = html(card({ service: { ...card().service!, url: long } }))
    expect(part(out, 'p', 'connect-url')?.[1]).toBe(long)
    expect(part(out, 'p', 'connect-url')?.[0]).toContain('overflow-y-auto')
  })

  test('after a room read the server\'s line comes first, above where it connects; without it, no line', () => {
    setLocale('en')
    const lead = 'Messages from your conversations (other people\'s words) came in here, so changes are asked first.'
    const out = html(card({ lead }))
    expect(part(out, 'p', 'connect-lead')?.[1]).toBe(esc(lead))
    expect(out.indexOf('data-testid="connect-lead"')).toBeLessThan(out.indexOf('data-testid="connect-host"'))
    expect(html(card())).not.toContain('data-testid="connect-lead"')
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
    for (const locale of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
      setLocale(locale)
      // on a team template's card (an unknown service's card has its own warning box instead: one warning, not two)
      const warned = html(card({ name: 'GitHub', template: { id: 't1', version: 1 }, service: { kind: 'mcp', url: 'https://mcp.example.org/mcp', host: 'mcp.example.org', auth: 'oauth', authHeader: null } }))
      expect(part(warned, 'p', 'connect-host-caution')?.[0]).toContain(esc(translate(locale, 'connect.hostCaution', { name: 'GitHub' })))
      expect(html(card({ template: { id: 't1', version: 1 } }))).not.toContain('data-testid="connect-host-caution"')
      expect(html(card({ name: 'GitHub', service: { kind: 'mcp', url: 'https://mcp.example.org/mcp', host: 'mcp.example.org', auth: 'oauth', authHeader: null } }))).not.toContain('data-testid="connect-host-caution"')
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

  test('sign-in: a sign-in page opens in a new window, to check; the AI never sees the password', () => {
    for (const locale of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
      setLocale(locale)
      const out = html(card({ name: 'Lineup', service: { kind: 'mcp', url: 'https://mcp.linear.example/mcp', host: 'mcp.linear.example', auth: 'oauth', authHeader: null } }))
      const where = part(out, 'p', 'connect-where')![0]
      expect(where).toContain(esc(translate(locale, 'connect.signInWhere')))
      // the sign-in server comes from the address's own metadata: the sentence names neither the host nor the service
      expect(where).not.toContain('mcp.linear.example')
      expect(where).not.toContain('Lineup')
    }
    setLocale('en')
    expect(translate('en', 'connect.signInWhere')).toBe('Signing in opens a sign-in page in a new window. Check that it is the service you expect. The AI never sees your password.')
  })

  test('the whole name in the title, wrapping instead of being cut', () => {
    setLocale('en')
    const name = 'Higgs Studio Video Generation Platform For Teams'
    const title = part(html(card({ name })), 'span', 'connect-title')!
    expect(title[1]).toBe(esc(translate('en', 'connect.title', { name })))
    expect(title[0]).not.toContain('truncate')
    expect(title[0]).toContain('[overflow-wrap:anywhere]')
  })

  test('an admin\'s template: "your own key for" the name, from your team, and where the key goes', () => {
    for (const locale of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
      setLocale(locale)
      const out = html(card({ name: 'Demo Wiki', template: { id: 't1', version: 2 } }))
      expect(part(out, 'span', 'connect-title')![1]).toBe(esc(translate(locale, 'connect.templateTitle', { name: 'Demo Wiki' })))
      expect(out).toContain(esc(translate(locale, 'connect.fromTeam')))
      expect(out).toContain('data-testid="connect-template-note"')
      // the same address line and key box as any service card
      expect(out).toContain('data-testid="connect-host"')
      expect(out).toContain('data-testid="connect-key"')
    }
    // a plain card says nothing of a template
    setLocale('en')
    expect(html(card())).not.toContain('connect-template-note')
  })

  test('QA TC-127: the person\'s own connection that stopped working: "Sign in again to" (or "a new key for") the name, and a line that nothing new is added', () => {
    for (const locale of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
      setLocale(locale)
      const signIn = html(card({ name: 'Notion', reconnect: true, service: { kind: 'mcp', url: 'https://mcp.notion.com/mcp', host: 'mcp.notion.com', auth: 'oauth', authHeader: null } }))
      expect(part(signIn, 'span', 'connect-title')![1]).toBe(esc(translate(locale, 'connect.reconnectTitle', { name: 'Notion' })))
      expect(signIn).toContain('data-reconnect="yes"')
      expect(signIn).toContain(esc(translate(locale, 'connect.reconnectNote', { name: 'Notion' })))
      expect(signIn).toContain('data-testid="connect-sign-in"')
      expect(signIn).not.toContain('connect-template-note')
      const key = html(card({ name: 'Tasks', reconnect: true }))
      expect(part(key, 'span', 'connect-title')![1]).toBe(esc(translate(locale, 'connect.reconnectKeyTitle', { name: 'Tasks' })))
      expect(key).toContain('data-testid="connect-key"')
    }
    setLocale('en')
    expect(html(card())).not.toContain('data-reconnect')
  })

  test('what kind of connection it is, and the header a key goes in', () => {
    for (const locale of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
      setLocale(locale)
      expect(part(html(card()), 'p', 'connect-kind')![1]).toBe(esc(translate(locale, 'connect.kindMcp')))
      const http = html(card({ service: { kind: 'http', url: 'https://api.higgsfield.example/v1', host: 'api.higgsfield.example', auth: 'header', authHeader: 'X-API-Key' } }))
      expect(part(http, 'p', 'connect-kind')![1]).toBe(esc(`${translate(locale, 'connect.kindHttp')} · ${translate(locale, 'connect.headerKey', { header: 'X-API-Key' })}`))
    }
    setLocale('en')
    expect(translate('en', 'connect.headerKey', { header: 'X-API-Key' })).toBe('Key goes in the X-API-Key header')
    // bearer and sign-in: the kind alone; Google Drive has no address
    expect(part(html(card({ service: { ...card().service!, auth: 'oauth' } })), 'p', 'connect-kind')![1]).toBe('MCP server')
    expect(html(card({ target: 'google_drive', name: 'Google Drive', service: undefined }))).not.toContain('data-testid="connect-kind"')
  })

  // QA TC-135: the card vouches for an address only from the app's list (shared/src/service-catalog.ts)
  const notion = (url: string, o: Partial<ConnectServiceRequest> = {}) => card({ name: 'Notion', why: undefined, service: { kind: 'mcp', url, host: new URL(url).host, auth: 'oauth', authHeader: null }, ...o })
  test('TC-135: Notion at its official address says so, and offers the sign-in', () => {
    expect(cardTrust(notion('https://mcp.notion.com/mcp'))).toMatchObject({ kind: 'official', service: { id: 'notion' } })
    for (const locale of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
      setLocale(locale)
      const out = html(notion('https://mcp.notion.com/mcp'))
      expect(part(out, 'span', 'connect-title')![1]).toBe(esc(translate(locale, 'connect.title', { name: 'Notion' })))
      expect(out).toContain(esc(translate(locale, 'connect.official', { name: 'Notion' })))
      expect(out).toContain('data-testid="connect-sign-in"')
      expect(out).not.toContain('data-testid="connect-unlisted"')
    }
  })
  test('TC-135 retest: a listed name at another address says it is not that service\'s official address, and names the official one', () => {
    const made = 'https://notion-mcp.example.com/mcp'
    const server = notion(made, { name: 'notion-mcp.example.com', notOfficial: { name: 'Notion', url: 'https://mcp.notion.com/mcp' } })
    // an older server's card (the AI's name, no notOfficial) gets the same line, worked out here
    const older = notion(made)
    for (const r of [server, older]) expect(notOfficialOf(r, cardTrust(r))).toEqual({ name: 'Notion', host: 'mcp.notion.com' })
    for (const locale of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
      setLocale(locale)
      for (const r of [server, older]) {
        const out = html(r)
        const box = part(out, 'p', 'connect-not-official')![1]
        expect(box).toContain('<strong class="font-semibold">notion-mcp.example.com</strong>')
        expect(box).toContain(esc(translate(locale, 'connect.notOfficial', { name: 'Notion', official: 'mcp.notion.com' })))
        expect(out).not.toContain('data-testid="connect-unlisted"')
        expect(part(out, 'span', 'connect-title')![1]).toBe(esc(translate(locale, 'connect.title', { name: 'notion-mcp.example.com' })))
      }
    }
    setLocale('en')
    expect(translate('en', 'connect.notOfficial', { name: 'Notion', official: 'mcp.notion.com' })).toBe("This is not Notion's official address. Notion's official address is mcp.notion.com. Connect only if you know and trust this one.")
    // not for the official address, a plain unknown service or an admin's template
    expect(notOfficialOf(notion('https://mcp.notion.com/mcp'), cardTrust(notion('https://mcp.notion.com/mcp')))).toBeNull()
    expect(notOfficialOf(card(), cardTrust(card()))).toBeNull()
    const tpl = notion(made, { template: { id: 't1', version: 1 } })
    expect(notOfficialOf(tpl, cardTrust(tpl))).toBeNull()
    expect(html(card())).toContain('data-testid="connect-unlisted"')
  })
  test('TC-135 and editions: a listed name (or a look-alike) at another address is named by its host, with the warning, never "official"', () => {
    const cases = [
      ['Notion', 'https://notion-mcp.example.com/mcp'],
      ['Notion workspace', 'https://notion-mcp.example.com/mcp'],
      ['N\u043etion', 'https://notion-mcp.example.com/mcp'],
      ['노션', 'https://notion-mcp.example.com/mcp'],
      ['GitLab', 'https://gitlab.acme.com/api/v4/mcp'],
      ['Acme GitLab', 'https://gitlab.acme.com/api/v4/mcp'],
      // the official host but not https, or with a query: not "official" either
      ['Notion', 'http://mcp.notion.com/mcp'],
      ['Notion', 'https://mcp.notion.com/mcp?x=1'],
    ] as const
    for (const [name, url] of cases) {
      const host = new URL(url).host
      expect(cardTrust(notion(url, { name })), `${name} ${url}`).toEqual({ kind: 'unlisted', display: host })
    }
    for (const locale of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
      setLocale(locale)
      const out = html(notion('https://gitlab.acme.com/api/v4/mcp', { name: 'GitLab' }))
      expect(part(out, 'span', 'connect-title')![1]).toBe(esc(translate(locale, 'connect.title', { name: 'gitlab.acme.com' })))
      expect(out).toContain(esc(translate(locale, 'connect.signIn', { name: 'gitlab.acme.com' })))
      expect(part(out, 'p', 'connect-not-official')![1]).toContain('<strong class="font-semibold">gitlab.acme.com</strong>')
      expect(out).not.toContain('data-testid="connect-official"')
      // only the not-official line names GitLab, to say this is not its address
      expect(out.replace(part(out, 'p', 'connect-not-official')![0], '')).not.toContain('GitLab')
      expect(part(out, 'p', 'connect-not-official')![1]).toContain('gitlab.com')
    }
  })
  test('a service the app does not know: the address in bold and a plain warning above the button', () => {
    expect(cardTrust(card())).toEqual({ kind: 'unlisted', display: 'Higgs Studio' })
    for (const locale of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
      setLocale(locale)
      const out = html(card())
      const box = part(out, 'p', 'connect-unlisted')![1]
      expect(box).toContain('<strong class="font-semibold">mcp.higgsfield.example</strong>')
      expect(box).toContain(esc(translate(locale, 'connect.unlisted')))
      expect(out).not.toContain('data-testid="connect-official"')
    }
  })
  test('a team template or a reconnect at its own address: no "unlisted" box, no block', () => {
    const tpl = card({ name: 'Notion', template: { id: 't1', version: 1 }, service: { kind: 'mcp', url: 'https://wiki.example.com/mcp', host: 'wiki.example.com', auth: 'oauth', authHeader: null } })
    // the admin's template keeps the admin's name
    expect(cardTrust(tpl)).toEqual({ kind: 'template', display: 'Notion' })
    expect(cardTrust({ ...tpl, name: 'Team wiki', template: undefined, reconnect: true })).toEqual({ kind: 'template', display: 'Team wiki' })
    const out = html(tpl)
    expect(out).toContain('data-testid="connect-sign-in"')
    expect(out).not.toContain('data-testid="connect-unlisted"')
  })
  test('a reconnect card for a connection saved under a listed name before #582: titled by its host unless its address is official', () => {
    const old = (name: string, url: string) => card({ name, reconnect: true, service: { kind: 'mcp', url, host: new URL(url).host, auth: 'oauth', authHeader: null } })
    expect(cardTrust(old('Notion', 'https://notion-mcp.example.com/mcp'))).toEqual({ kind: 'template', display: 'notion-mcp.example.com' })
    expect(cardTrust(old('N\u043etion', 'https://wiki.example.com/mcp'))).toEqual({ kind: 'template', display: 'wiki.example.com' })
    expect(cardTrust(old('Notion', 'https://mcp.notion.com/mcp'))).toMatchObject({ kind: 'official', service: { id: 'notion' } })
    for (const locale of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
      setLocale(locale)
      const out = html(old('Notion', 'https://notion-mcp.example.com/mcp'))
      expect(part(out, 'span', 'connect-title')![1]).toBe(esc(translate(locale, 'connect.reconnectTitle', { name: 'notion-mcp.example.com' })))
      expect(out).toContain(esc(translate(locale, 'connect.signIn', { name: 'notion-mcp.example.com' })))
      expect(out.replace(part(out, 'p', 'connect-not-official')![0], '')).not.toContain('Notion')
      expect(part(out, 'p', 'connect-not-official')![1]).toContain('mcp.notion.com')
    }
  })
  test('a name that mixes Latin with another alphabet in a word is titled by its host, whatever it imitates', () => {
    const at = (name: string) => cardTrust(card({ name, service: { kind: 'mcp', url: 'https://x.example.com/mcp', host: 'x.example.com', auth: 'oauth', authHeader: null } }))
    // a mixed word that maps to no listed name still gets the host (the robust rule)
    for (const n of ['Ac\u043ceTools', 'Pay\u03c1al Tools', 'Sl\u0561ck']) expect(at(n), n).toEqual({ kind: 'unlisted', display: 'x.example.com' })
    // one script per word is not mixed
    for (const n of ['Нотион', 'Acme Нотион', '노션 Wiki', 'Acme Tools']) expect(at(n).kind, n).toBe('unlisted')
    expect(at('Acme Tools')).toEqual({ kind: 'unlisted', display: 'Acme Tools' })
  })
  test('bug 2: a reconnect card says it fixes the connection the person has, by sign-in or by key', () => {
    for (const locale of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
      setLocale(locale)
      const signIn = html(notion('https://mcp.notion.com/mcp', { reconnect: true }))
      expect(part(signIn, 'span', 'connect-title')![1]).toBe(esc(translate(locale, 'connect.reconnectTitle', { name: 'Notion' })))
      expect(part(signIn, 'p', 'connect-reconnect-note')![1]).toBe(esc(translate(locale, 'connect.reconnectNote', { name: 'Notion' })))
      const key = html(card({ reconnect: true }))
      expect(part(key, 'span', 'connect-title')![1]).toBe(esc(translate(locale, 'connect.reconnectKeyTitle', { name: 'Higgs Studio' })))
      expect(part(key, 'p', 'connect-reconnect-note')![1]).toBe(esc(translate(locale, 'connect.reconnectKeyNote', { name: 'Higgs Studio' })))
      expect(key).toContain('data-testid="connect-key"')
    }
    setLocale('en')
    expect(html(card())).not.toContain('connect-reconnect-note')
  })
  test('bug 5: a template you sign in to talks about your account, not a key', () => {
    for (const locale of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
      setLocale(locale)
      const out = html(notion('https://mcp.notion.com/mcp', { template: { id: 't1', version: 1 } }))
      expect(part(out, 'span', 'connect-title')![1]).toBe(esc(translate(locale, 'connect.templateTitleSignIn', { name: 'Notion' })))
      expect(part(out, 'p', 'connect-template-note')![1]).toBe(esc(translate(locale, 'connect.templateNoteSignIn')))
    }
    setLocale('en')
    expect(translate('en', 'connect.templateNoteSignIn')).not.toMatch(/\bkey\b/)
    expect(translate('en', 'integrations.asked.sendsSignIn', { host: 'h', name: 'N' })).not.toContain('token')
  })
})

describe('the card, clicked', () => {
  let dom: ReturnType<typeof installDom>
  const localeBefore = useLocaleStore.getState().locale
  beforeAll(() => {
    dom = installDom()
    useLocaleStore.setState({ locale: 'en' })
  })
  afterAll(() => {
    removeDom()
    useLocaleStore.setState({ locale: localeBefore })
  })
  const expiresAt = new Date(Date.now() + 600_000).toISOString()
  const CONNECT = `POST /api/turns/${TURN}/connect`
  const said = () => calls.map((c) => `${c.method} ${c.path}`)
  /** the connect answers in order, and what each connect sent */
  const connects = (...answers: unknown[]) => {
    routes[CONNECT] = () => { const a = answers.shift(); return a ? json(a) : json({ error: { code: 'conflict', message: 'not expected' } }, 409) }
  }
  const linear = () => card({ name: 'Lineup', service: { kind: 'mcp', url: 'https://mcp.linear.example/mcp', host: 'mcp.linear.example', auth: 'oauth', authHeader: null } })

  test('a key: a wrong one keeps the card with the reason and an empty box, the right one connects and closes it', async () => {
    const r = card()
    open(r)
    connects({ state: 'retry', integrationId: 'i1', status: 'error', lastError: 'The service refused the key (HTTP 401).' }, { state: 'connected', integrationId: 'i1', status: 'connected' })
    const m = await mount(<ConnectCard request={r} />)
    expect(m.get('connect-submit').disabled).toBe(true)
    await m.type('connect-key', 'wrong-key-0000')
    await m.click('connect-submit')
    await m.until(() => m.find('connect-last-error'), 'the reason')
    expect(m.get('connect-last-error').textContent).toContain('The service refused the key (HTTP 401).')
    expect((m.get('connect-key') as unknown as { value: string }).value).toBe('')
    expect(Object.keys(useChats.getState().requests)).toEqual(['c1'])
    await m.type('connect-key', KEY)
    await m.click('connect-submit')
    await m.until(() => !useChats.getState().requests.c1, 'the card closed')
    expect(said().filter((c) => c === CONNECT)).toHaveLength(2)
    // each key went sealed, never in plain
    expect(calls.filter((c) => c.path.endsWith('/connect')).every((c) => c.body.sealed && !c.raw.includes(KEY) && !c.raw.includes('wrong-key-0000'))).toBe(true)
    expect((await unseal(calls.filter((c) => c.path.endsWith('/connect'))[1]!.body.sealed)).secret).toBe(KEY)
    await m.unmount()
  })

  test('sign-in: the window is reserved in the click, the connection added, signed in, polled until done, then done', async () => {
    const r = linear()
    open(r)
    connects({ state: 'sign_in', integrationId: 'i9', status: 'needs_auth' }, { state: 'connected', integrationId: 'i9', status: 'connected' })
    routes['POST /api/integrations/i9/authorize'] = () => json({ flowId: 'f1', authorizationUrl: 'https://auth.linear.example/authorize?state=s1', expiresAt })
    let polls = 0
    routes['GET /api/integrations/flows/f1'] = () => json({ flowId: 'f1', state: ++polls < 2 ? 'pending' : 'completed', expiresAt, reason: null })
    const m = await mount(<ConnectCard request={r} />)
    await m.click('connect-sign-in')
    // a blank window opened during the click, sent to the sign-in page once the server answered
    // opened during the click (a browser would block it after an await): nothing was blocked
    expect(dom.blocked).toEqual([])
    expect(dom.opened.length).toBe(1)
    await m.until(() => dom.opened[0]!.replaced.length > 0, 'the sign-in page')
    expect(dom.opened[0]).toMatchObject({ url: 'about:blank', replaced: ['https://auth.linear.example/authorize?state=s1'], closed: false })
    expect(m.get('connect-signin').textContent).toContain(translate('en', 'integrations.signIn.waiting'))
    // the flow is polled until it completed, then the card says done and closes
    await m.until(() => !useChats.getState().requests.c1, 'the card closed', 10_000)
    expect(said()).toEqual([CONNECT, 'POST /api/integrations/i9/authorize', 'GET /api/integrations/flows/f1', 'GET /api/integrations/flows/f1', CONNECT])
    expect(calls[0]!.body).toEqual({ action: 'connect', requestId: 'c1' })
    expect(calls[4]!.body).toEqual({ action: 'done', requestId: 'c1' })
    expect(dom.opened[0]!.closed).toBe(true)
    await m.unmount()
  })

  test('sign-in in the desktop app: no blank window; the service\'s sign-in page opens in the system browser once known', async () => {
    const r = linear()
    open(r)
    connects({ state: 'sign_in', integrationId: 'i9', status: 'needs_auth' })
    routes['POST /api/integrations/i9/authorize'] = () => json({ flowId: 'f4', authorizationUrl: 'https://auth.linear.example/authorize?state=s4', expiresAt })
    routes['GET /api/integrations/flows/f4'] = () => json({ flowId: 'f4', state: 'pending', expiresAt, reason: null })
    // the desktop app's window handler (desktop/src/main/security.ts): http(s) to the system browser, never a window
    const asked: string[] = []
    const was = globalThis.open
    Object.assign(globalThis, { mycelDesktop: { bridgeVersion: 1 }, open: (url: string) => { asked.push(url); return null } })
    try {
      const m = await mount(<ConnectCard request={r} />)
      await m.click('connect-sign-in')
      await m.until(() => asked.length > 0, 'the sign-in page opened')
      expect(asked).toEqual(['https://auth.linear.example/authorize?state=s4'])
      expect(m.get('connect-signin').textContent).toContain(translate('en', 'integrations.signIn.waiting'))
      await m.unmount()
    } finally {
      delete (globalThis as Record<string, unknown>).mycelDesktop
      globalThis.open = was
    }
  })

  test('TC-020: a sign-in the service refused says why in words, never the server\'s code', async () => {
    const r = linear()
    open(r)
    connects({ state: 'sign_in', integrationId: 'i9', status: 'needs_auth' })
    routes['POST /api/integrations/i9/authorize'] = () => json({ flowId: 'f3', authorizationUrl: 'https://auth.linear.example/authorize?state=s3', expiresAt })
    routes['GET /api/integrations/flows/f3'] = () => json({ flowId: 'f3', state: 'failed', expiresAt, reason: 'client' })
    const m = await mount(<ConnectCard request={r} />)
    await m.click('connect-sign-in')
    await m.until(() => m.get('connect-signin').textContent!.includes(translate('en', 'integrations.signIn.reason.client')), 'the reason in words', 10_000)
    expect(m.get('connect-signin').textContent).not.toMatch(/\bclient\b/)
    expect(dom.opened[0]!.closed).toBe(true)
    await m.unmount()
  })

  test('Google Drive: signed in at Google, the account confirmed, then done', async () => {
    const r = card({ target: 'google_drive', name: 'Google Drive', service: undefined })
    open(r)
    connects({ state: 'connected' })
    const account = { name: 'Sam Lee', email: 'sam@example.com' }
    routes['POST /api/integrations/google-drive/authorize'] = () => json({ flowId: 'd1', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x', expiresAt })
    routes['GET /api/integrations/google-drive/flows/d1'] = () => json({ flowId: 'd1', state: 'ready', account, expiresAt, reason: null })
    routes['POST /api/integrations/google-drive/flows/d1/complete'] = () => json({ configured: true, status: 'connected', account, scopes: [], expiresAt: null })
    const m = await mount(<ConnectCard request={r} />)
    await m.click('connect-drive')
    expect(dom.blocked).toEqual([])
    expect(dom.opened.at(-1)!.url).toBe('about:blank')
    await m.until(() => m.find('drive-confirm'), 'the account to confirm', 8000)
    expect(m.get('drive-account').textContent).toContain('sam@example.com')
    // nothing told the AI before the person confirmed
    expect(said()).not.toContain(CONNECT)
    await m.click('drive-confirm')
    await m.until(() => !useChats.getState().requests.c1, 'the card closed')
    expect(said()).toEqual(['POST /api/integrations/google-drive/authorize', 'GET /api/integrations/google-drive/flows/d1', 'POST /api/integrations/google-drive/flows/d1/complete', CONNECT])
    expect(calls.at(-1)!.body).toEqual({ action: 'done', requestId: 'c1' })
    await m.unmount()
  })

  test('Google Drive in the desktop app: no blank window; Google\'s page opens in the system browser once the server answered', async () => {
    const r = card({ target: 'google_drive', name: 'Google Drive', service: undefined })
    open(r)
    connects({ state: 'connected' })
    const google = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x'
    routes['POST /api/integrations/google-drive/authorize'] = () => json({ flowId: 'd2', authorizationUrl: google, expiresAt })
    routes['GET /api/integrations/google-drive/flows/d2'] = () => json({ flowId: 'd2', state: 'pending', account: null, expiresAt, reason: null })
    // the desktop app's window handler (desktop/src/main/security.ts): http(s) to the system browser, never a window
    const asked: string[] = []
    const was = globalThis.open
    Object.assign(globalThis, { mycelDesktop: { bridgeVersion: 1 }, open: (url: string) => { asked.push(url); return null } })
    try {
      const m = await mount(<ConnectCard request={r} />)
      await m.click('connect-drive')
      await m.until(() => asked.length > 0, 'Google opened')
      expect(asked).toEqual([google])
      // "Continue with Google" stays as the way back to it
      expect(m.get('connect-card').textContent).toContain(translate('en', 'drive.openGoogle'))
      await m.unmount()
    } finally {
      delete (globalThis as Record<string, unknown>).mycelDesktop
      globalThis.open = was
    }
  })

  test('done that failed: the card offers it again, and the second one finishes', async () => {
    const r = linear()
    open(r)
    const answers: (() => Response)[] = [
      () => json({ state: 'sign_in', integrationId: 'i9', status: 'needs_auth' }),
      () => json({ error: { code: 'internal', message: 'The server could not finish this.' } }, 500),
      () => json({ state: 'connected', integrationId: 'i9', status: 'connected' }),
    ]
    routes[CONNECT] = () => answers.shift()!()
    routes['POST /api/integrations/i9/authorize'] = () => json({ flowId: 'f2', authorizationUrl: 'https://auth.linear.example/authorize?state=s2', expiresAt })
    routes['GET /api/integrations/flows/f2'] = () => json({ flowId: 'f2', state: 'completed', expiresAt, reason: null })
    const m = await mount(<ConnectCard request={r} />)
    await m.click('connect-sign-in')
    await m.until(() => m.find('connect-finish'), 'Retry after the failed done', 8000)
    expect(m.get('connect-error').textContent).toContain('The server could not finish this.')
    expect(Object.keys(useChats.getState().requests)).toEqual(['c1'])
    await m.click('connect-finish')
    await m.until(() => !useChats.getState().requests.c1, 'the card closed')
    expect(said().filter((c) => c === CONNECT)).toHaveLength(3)
    expect(calls.filter((c) => c.path.endsWith('/connect')).map((c) => c.body.action)).toEqual(['connect', 'done', 'done'])
    await m.unmount()
  })
})
