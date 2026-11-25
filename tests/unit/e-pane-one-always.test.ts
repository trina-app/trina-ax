// The desktop app's browser and the person's one Always (docs/decisions/20261125-one-site-always-desktop-browser.md):
// what the team server says the person already allowed counts for that answer here, and an Always answered on this
// computer goes back with the result. Pure parts (common/site-permissions.ts, common/browser-result.ts).
import { describe, expect, test } from 'bun:test'
import { SitePermissions } from '../../desktop/src/common/site-permissions'
import { ALWAYS_BACK_MAX, toBrowserResult, withAlways } from '../../desktop/src/common/browser-result'
import { BrowserResult } from '../../shared/src/api/browser'

describe('allowForTurn: the server\'s allowed sites for one answer', () => {
  test('a site key covers its subdomains, only in that answer, and is never saved', () => {
    const p = new SitePermissions()
    p.allowForTurn('t1', ['naver.com'])
    // the measured case: Always on "naver.com" on the server card, then stock.naver.com on the desktop
    expect(p.isAllowed('site', 'stock.naver.com', 't1')).toBe(true)
    expect(p.isAllowed('site', 'finance.naver.com', 't1')).toBe(true)
    expect(p.isAllowed('site', 'naver.com', 't1')).toBe(true)
    expect(p.isAllowed('site', 'stock.naver.com', 't2')).toBe(false)
    expect(p.isAllowed('site', 'navercorp.com', 't1')).toBe(false)
    expect(p.toJSON().always).toEqual([])
  })

  test('a host key covers only that host (and keeps its port); a typed www address arrives without "www."', () => {
    const p = new SitePermissions()
    p.allowForTurn('t1', ['etk.srail.kr', 'shop.example:8443'])
    expect(p.isAllowed('site', 'etk.srail.kr', 't1')).toBe(true)
    expect(p.isAllowed('site', 'www.srail.kr', 't1')).toBe(false)
    expect(p.isAllowed('site', 'shop.example:8443', 't1')).toBe(true)
    expect(p.isAllowed('site', 'shop.example', 't1')).toBe(false)
  })

  test('office addresses count for the site and the office scope; public sites never for the office scope', () => {
    const p = new SitePermissions()
    p.allowForTurn('t1', ['intranet.example'], ['192.168.0.5', '[fd00::5]'])
    expect(p.isAllowed('private', '192.168.0.5', 't1')).toBe(true)
    expect(p.isAllowed('site', '192.168.0.5', 't1')).toBe(true)
    expect(p.isAllowed('private', '[fd00::5]', 't1')).toBe(true)
    expect(p.isAllowed('private', 'intranet.example', 't1')).toBe(false)
  })

  test('no turn, empty or odd keys: nothing changes', () => {
    const p = new SitePermissions()
    p.allowForTurn(undefined, ['naver.com'])
    p.allowForTurn('t1', ['', 'x'.repeat(400)])
    expect(p.isAllowed('site', 'naver.com', undefined)).toBe(false)
    expect(p.isAllowed('site', 'naver.com', 't1')).toBe(false)
  })

  test('the person\'s own "ask" choice is kept; an Always saved on this computer still counts (older servers)', () => {
    const p = new SitePermissions({ always: ['korail.com'] })
    p.allowForTurn('t1', [])
    expect(p.isAllowed('site', 'www.korail.com', 't9')).toBe(true)
    expect(p.siteAccess).toBe('ask')
  })
})

describe('withAlways: what the person answered Always to goes back with the result', () => {
  const base = toBrowserResult('c1', { content: [{ type: 'text', text: 'ok' }], isError: false })

  test('none: the result is unchanged (what an older server reads)', () => {
    expect(withAlways(base, undefined)).toEqual(base)
    expect(withAlways(base, { site: new Set(), private: new Set() })).toEqual(base)
  })

  test('sites and office hosts, valid keys only, bounded, and the result still parses', () => {
    const r = withAlways(base, { site: new Set(['stock.naver.com', 'Bad Key']), private: new Set(['192.168.0.5:8080']) })
    expect(r.always).toEqual({ sites: ['stock.naver.com'], office: ['192.168.0.5:8080'] })
    expect(BrowserResult.safeParse(r).success).toBe(true)
    const many = withAlways(base, { site: new Set(Array.from({ length: 80 }, (_, i) => `s${i}.example`)), private: new Set() })
    expect(many.always!.sites!.length).toBe(ALWAYS_BACK_MAX)
    expect(BrowserResult.safeParse(many).success).toBe(true)
  })

  test('an error result keeps its error and carries the Always too', () => {
    const e = toBrowserResult('c2', { content: [{ type: 'text', text: 'denied later' }], isError: true })
    const r = withAlways(e, { site: new Set(['a.example']), private: new Set() })
    expect(r.ok).toBe(false)
    expect(r.error).toBeDefined()
    expect(r.always).toEqual({ sites: ['a.example'] })
  })
})
