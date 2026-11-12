// QA TC-346: a page on one team address can leave cookies on the shared parent domain, which the browser then sends to
// every other team address. The relay forwards only the cookies a team server uses (__Host- ones; the dev session
// cookie on plain-http dev relays) and answers a head it cannot read with a page that says how to remove the cookies.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { headTooBigResponse } from '../../relay/src/pages.ts'
import { DEV_SESSION_COOKIE as SHARED_DEV_COOKIE, SESSION_COOKIE } from '../../shared/src/api/common.ts'
import { DEV_SESSION_COOKIE, teamCookie, teamRequestHeaders } from '../../relay/src/relay.ts'

describe('teamCookie', () => {
  test('keeps __Host- cookies only and drops the rest (cookies another page can set on the parent domain)', () => {
    expect(teamCookie(['f1=aaaa; __Host-sid=abc; mycel_locale=ko; f2=bbbb'], 'https')).toBe('__Host-sid=abc')
    expect(teamCookie(['a=1', '__Host-sid=x=y; b=2', '__Host-other=3'], 'https')).toBe('__Host-sid=x=y; __Host-other=3')
    expect(teamCookie(['f1=1; f2=2'], 'https')).toBeNull()
    expect(teamCookie([], 'https')).toBeNull()
  })

  test('the relay keeps the names the team server signs in with', () => {
    expect(DEV_SESSION_COOKIE).toBe(SHARED_DEV_COOKIE)
    expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true)
  })

  test('the dev session cookie only on a plain-http relay', () => {
    expect(teamCookie(['mycel-dev-sid=d; junk=1'], 'http')).toBe('mycel-dev-sid=d')
    expect(teamCookie(['mycel-dev-sid=d; junk=1'], 'https')).toBeNull()
  })

  test('teamRequestHeaders sends one filtered Cookie header and leaves the others as forwardRequestHeaders does', () => {
    const big = Array.from({ length: 60 }, (_, i) => `flood${i}=${'x'.repeat(4000)}`).join('; ')
    const h = teamRequestHeaders(['Host', 'acme.localhost', 'Accept', 'text/html', 'Cookie', big, 'Cookie', '__Host-sid=s1', 'X-Forwarded-For', '1.2.3.4'], 'http', 'https')
    expect(h).toEqual([['accept', 'text/html'], ['cookie', '__Host-sid=s1']])
    expect(teamRequestHeaders(['Cookie', big], 'ws', 'https')).toEqual([])
  })
})

describe('headTooBigResponse', () => {
  const raw = headTooBigResponse()
  const [head, body] = raw.split('\r\n\r\n') as [string, string]

  test('a 431 with an HTML page, its length right, never cached, connection closed', () => {
    expect(head.split('\r\n')[0]).toBe('HTTP/1.1 431 Request Header Fields Too Large')
    expect(head).toContain('content-type: text/html; charset=utf-8')
    expect(head).toContain(`content-length: ${Buffer.byteLength(body)}`)
    expect(head).toContain('cache-control: no-store')
    expect(head).toContain('connection: close')
    expect(head).not.toMatch(/clear-site-data/i)
    expect(head).not.toMatch(/strict-transport-security/i)
    expect(headTooBigResponse(true)).toContain('strict-transport-security: max-age=31536000\r\n')
    expect(body).toContain('too many cookies')
  })

  test('the script the page runs is the one the CSP allows', () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(body)![1]!
    const hash = createHash('sha256').update(script).digest('base64')
    expect(head).toContain(`script-src 'sha256-${hash}'`)
    expect(head).toContain("default-src 'none'")
  })

  /** runs the page's script against a small fake browser; returns what it did */
  function run(o: { host: string; path: string; cookies: string[] }) {
    const script = /<script>([\s\S]*)<\/script>/.exec(body)![1]!
    const els: Record<string, { textContent: string; hidden: boolean; onclick: (() => void) | null }> = {}
    for (const id of ['t', 'b', 'a', 'x']) els[id] = { textContent: '', hidden: true, onclick: null }
    const writes: string[] = []
    let reloaded = false
    const document = {
      documentElement: { lang: '' }, title: '',
      get cookie() { return o.cookies.join('; ') },
      set cookie(v: string) { writes.push(v) },
      getElementById: (id: string) => els[id],
    }
    const location = { hostname: o.host, pathname: o.path, protocol: 'https:', reload: () => { reloaded = true } }
    new Function('document', 'location', script)(document, location)
    return { els, writes, document, click: () => { els.x!.onclick!(); return reloaded } }
  }

  test('shows the language of the team page (mycel_locale), English otherwise', () => {
    expect(run({ host: 'acme.trina.app', path: '/', cookies: ['mycel_locale=ko'] }).document.documentElement.lang).toBe('ko')
    for (const l of ['id', 'ja', 'es']) expect(run({ host: 'acme.trina.app', path: '/', cookies: [`mycel_locale=${l}`] }).document.documentElement.lang).toBe(l)
    const en = run({ host: 'acme.trina.app', path: '/', cookies: ['x=1'] })
    expect(en.document.documentElement.lang).toBe('en')
    expect(en.els.a!.textContent).toContain('trina.app')
    expect(en.els.x!.hidden).toBe(false)
  })

  test('the button removes the cookies from the parent domain(s) on every path up to the page, never __Host- ones, then reloads', () => {
    const r = run({ host: 'acme.teams.example.com', path: '/chat/1', cookies: ['flood1=a', '__Host-sid=s', 'flood2=b', 'nameless'] })
    expect(r.click()).toBe(true)
    expect(r.writes.some((w) => w.startsWith('__Host-'))).toBe(false)
    for (const n of ['flood1=', 'flood2=', 'nameless']) {
      for (const d of ['teams.example.com', 'example.com']) {
        for (const p of ['/', '/chat', '/chat/', '/chat/1', '/chat/1/']) {
          expect(r.writes).toContain(`${n}; Domain=${d}; Path=${p}; Max-Age=0; Secure`)
          expect(r.writes).toContain(`${n}; Domain=${d}; Path=${p}; Max-Age=0; Secure; Partitioned`)
        }
      }
    }
    // never the host itself (host-only cookies are this address's own) and never a bare top-level domain
    expect(r.writes.some((w) => /Domain=(acme\.teams\.example\.com|com);/.test(w))).toBe(false)
  })
})
