// In-app browser after the owner's LinkedIn test (2026-10-21): "사내망 요청을 막았어요: static.licdn.com" and "AI가
// linkedin.com에서 스크립트를 실행했어요" stacked over the page.
//  - the host classifier never calls a public name "office network" because DNS was slow, failed or empty (split DNS
//    such as Tailscale MagicDNS); real office answers (private, IPv6 ULA, NAT64-mapped private, mixed) stay private
//  - the address a response really came from decides afterwards (responseSourceVerdict), proxies excepted
//  - routine events go to the activity log; at most one notice over the page (common/pane-activity.ts)
//  - site access "all": every public site allowed, office addresses still need their own grant
import { describe, expect, test } from 'bun:test'
import { HostClassifier } from '../../desktop/src/main/pane/classify'
import { publicRequestVerdict, REBIND_CHECKED_TYPES, responseSourceVerdict, type ResponseSource } from '../../desktop/src/common/net-policy'
import { addActivity, dismissNotice, emptyActivity, isNotice, markSeen, MAX_ACTIVITY_LOG, type ActivityKind, type PaneActivity } from '../../desktop/src/common/pane-activity'
import { SitePermissions } from '../../desktop/src/common/site-permissions'

const LICDN = ['172.64.154.50', '104.18.33.206', '2606:4700:440c::ac40:9a32', '2606:4700:4406::6812:21ce']
const never = () => new Promise<string[]>(() => {})

describe('host classifier under slow or failing DNS', () => {
  test('static.licdn.com with its real answers is public', async () => {
    const c = new HostClassifier(new Set(), new Set(), async () => LICDN)
    expect(await c.classify('static.licdn.com')).toBe('public')
  })

  test('a lookup that never answers lets the request go on (public) after the timeout, not office network', async () => {
    const c = new HostClassifier(new Set(), new Set(), never, 50)
    const t0 = Date.now()
    expect(await c.classify('static.licdn.com')).toBe('public')
    expect(Date.now() - t0).toBeLessThan(1000)
    // and it is watched afterwards: a private address answering for it now means rebinding
    expect(c.wasResolvedPublic('static.licdn.com')).toBe(true)
  })

  test('a failing lookup (ENOTFOUND / SERVFAIL / ETIMEOUT) and an empty answer are not office network', async () => {
    for (const resolve of [
      async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND static.licdn.com'), { code: 'ENOTFOUND' })
      },
      async () => {
        throw Object.assign(new Error('queryA ETIMEOUT'), { code: 'ETIMEOUT' })
      },
      async () => [] as string[],
    ]) {
      const c = new HostClassifier(new Set(), new Set(), resolve, 50)
      expect(await c.classify('static.licdn.com')).toBe('public')
      expect(await c.isLoopback('static.licdn.com')).toBe(false)
    }
  })

  test('real office answers stay private: RFC 1918, CGNAT/Tailscale, IPv6 ULA, link-local, NAT64 of a private IPv4, mixed', async () => {
    for (const addrs of [['192.168.1.20'], ['100.101.102.103'], ['fd7a:115c:a1e0::1'], ['fe80::1'], ['64:ff9b::c0a8:114'], ['::ffff:10.0.0.5'], ['8.8.8.8', '10.0.0.1']]) {
      const c = new HostClassifier(new Set(), new Set(), async () => addrs)
      expect({ addrs, cls: await c.classify('router.example.com') }).toEqual({ addrs, cls: 'private' })
    }
    const lo = new HostClassifier(new Set(), new Set(), async () => ['127.0.0.1'])
    expect(await lo.isLoopback('evil.example.com')).toBe(true)
  })

  test('one lookup per name at a time (a page asks for the same CDN dozens of times)', async () => {
    let calls = 0
    const c = new HostClassifier(new Set(), new Set(), async () => {
      calls++
      await new Promise((r) => setTimeout(r, 20))
      return LICDN
    })
    const all = await Promise.all(Array.from({ length: 40 }, () => c.classify('static.licdn.com')))
    expect(new Set(all)).toEqual(new Set(['public']))
    expect(calls).toBe(1)
  })

  test('a lookup without an answer is retried soon; a failing first try does not stick', async () => {
    let n = 0
    const c = new HostClassifier(new Set(), new Set(), async () => {
      n++
      if (n === 1) throw new Error('EAI_AGAIN')
      return ['192.168.0.9']
    })
    expect(await c.classify('nas.example.com')).toBe('public')
    // cached briefly (5 s): pretend the time passed
    ;(c as unknown as { cache: Map<string, { at: number }> }).cache.get('nas.example.com')!.at -= 6000
    expect(await c.classify('nas.example.com')).toBe('private')
  })

  test('IP literals and local names never need DNS', async () => {
    const c = new HostClassifier(new Set(), new Set(), async () => {
      throw new Error('must not be called')
    })
    expect(await c.classify('172.64.154.50')).toBe('public')
    expect(await c.classify('192.168.1.1')).toBe('private')
    expect(await c.classify('[fd7a:115c:a1e0::53]')).toBe('private')
    expect(await c.classify('nas.local')).toBe('private')
  })
})

describe('the address a response came from', () => {
  const base: ResponseSource = { ip: '172.64.154.50', proxied: false, loopback: false, privateIp: false, testMapped: false, resolvedPublic: true, privateAllowed: false }
  test('public answers and unknown addresses are fine', () => {
    expect(responseSourceVerdict(base)).toBe('ok')
    expect(responseSourceVerdict({ ...base, ip: undefined })).toBe('ok')
  })
  test('a name let through as public that answers from the office network or this computer stops the tab', () => {
    expect(responseSourceVerdict({ ...base, ip: '192.168.1.1', privateIp: true })).toBe('blocked')
    expect(responseSourceVerdict({ ...base, ip: 'fd00::1', privateIp: true })).toBe('blocked')
    expect(responseSourceVerdict({ ...base, ip: '127.0.0.1', privateIp: true, loopback: true })).toBe('forbidden')
  })
  test('allowed office hosts, names that were private all along, and test names are not stopped', () => {
    expect(responseSourceVerdict({ ...base, ip: '192.168.1.1', privateIp: true, privateAllowed: true })).toBe('ok')
    expect(responseSourceVerdict({ ...base, ip: '192.168.1.1', privateIp: true, resolvedPublic: false })).toBe('ok')
    expect(responseSourceVerdict({ ...base, ip: '127.0.0.1', privateIp: true, loopback: true, testMapped: true })).toBe('ok')
  })
  test('through a proxy the address is the proxy (127.0.0.1 or an office host): nothing is stopped', () => {
    expect(responseSourceVerdict({ ...base, ip: '127.0.0.1', loopback: true, privateIp: true, proxied: true })).toBe('ok')
    expect(responseSourceVerdict({ ...base, ip: '10.0.0.8', privateIp: true, proxied: true })).toBe('ok')
  })
  test('documents and what scripts can read back are checked; images and scripts are not', () => {
    for (const t of ['Document', 'XHR', 'Fetch', 'EventSource']) expect(REBIND_CHECKED_TYPES.has(t)).toBe(true)
    for (const t of ['Image', 'Script', 'Stylesheet', 'Font']) expect(REBIND_CHECKED_TYPES.has(t)).toBe(false)
  })
})

describe('quiet browsing: log, one notice at most', () => {
  test('routine events never interrupt; stopped page loads to the office / this computer and password refusals do', () => {
    for (const k of ['script', 'network', 'offsite', 'denied'] as ActivityKind[]) {
      expect(isNotice(k, false)).toBe(false)
      expect(isNotice(k, true)).toBe(false)
    }
    expect(isNotice('blocked', false)).toBe(false) // a page's sub-request (static.licdn.com style)
    expect(isNotice('forbidden', false)).toBe(false)
    expect(isNotice('blocked', true)).toBe(true)
    expect(isNotice('forbidden', true)).toBe(true)
    expect(isNotice('password', false)).toBe(true)
  })

  const ev = (id: number, kind: ActivityKind, notice = isNotice(kind, true)): PaneActivity => ({ id, kind, host: `h${id}`, at: id, notice })

  test('the LinkedIn sequence: script runs and held-back requests only reach the log, nothing over the page', () => {
    let v = emptyActivity()
    v = addActivity(v, ev(1, 'script'), false)
    v = addActivity(v, { id: 2, kind: 'offsite', host: 'static.licdn.com', at: 2, notice: isNotice('offsite', false) }, false)
    v = addActivity(v, ev(3, 'script'), false)
    expect(v.notice).toBeNull()
    expect(v.log.map((a) => a.id)).toEqual([3, 2, 1])
    expect(v.unseen).toBe(3)
    expect(markSeen(v).unseen).toBe(0)
  })

  test('never more than one notice: a newer one replaces it; dismissing an old id keeps the newer', () => {
    let v = emptyActivity()
    v = addActivity(v, ev(1, 'forbidden'), false)
    v = addActivity(v, ev(2, 'password'), false)
    expect(v.notice?.id).toBe(2)
    v = addActivity(v, ev(3, 'script'), false)
    expect(v.notice?.id).toBe(2)
    expect(dismissNotice(v, 1).notice?.id).toBe(2)
    expect(dismissNotice(v, 2).notice).toBeNull()
    expect(dismissNotice(v).notice).toBeNull()
  })

  test('the log is bounded and an open log has nothing unseen', () => {
    let v = emptyActivity()
    for (let i = 0; i < MAX_ACTIVITY_LOG + 30; i++) v = addActivity(v, ev(i, 'script'), true)
    expect(v.log).toHaveLength(MAX_ACTIVITY_LOG)
    expect(v.log[0].id).toBe(MAX_ACTIVITY_LOG + 29)
    expect(v.unseen).toBe(0)
  })
})

describe('site access setting', () => {
  test('default asks; "all" allows every public site but never the office-network scope', () => {
    const p = new SitePermissions()
    expect(p.siteAccess).toBe('ask')
    expect(p.isAllowed('site', 'www-new.example', 't1')).toBe(false)
    expect(p.setSiteAccess('all')).toBe(true)
    expect(p.setSiteAccess('all')).toBe(false)
    expect(p.isAllowed('site', 'anything.example', 't1')).toBe(true)
    expect(p.isAllowed('site', 'anything.example')).toBe(true)
    expect(p.isAllowed('site', '')).toBe(false)
    expect(p.isAllowed('private', 'nas.lan:5000', 't1')).toBe(false)
    expect(p.isAllowed('private', '192.168.1.1')).toBe(false)
  })

  test('saved with the allowed sites; old files and junk mean "ask"; the always list is kept separately', () => {
    const p = new SitePermissions({ always: ['shop.test'] })
    p.setSiteAccess('all')
    const saved = JSON.parse(JSON.stringify(p))
    expect(saved).toEqual({ always: ['shop.test'], privateAlways: [], siteAccess: 'all' })
    const back = new SitePermissions(saved)
    expect(back.siteAccess).toBe('all')
    expect(back.list()).toEqual({ always: ['shop.test'], privateAlways: [] })
    back.setSiteAccess('ask')
    expect(back.isAllowed('site', 'other.example')).toBe(false)
    expect(back.isAllowed('site', 'shop.test')).toBe(true)
    for (const junk of ['ALL', 1, true, null, { x: 1 }]) expect(new SitePermissions({ siteAccess: junk as never }).siteAccess).toBe('ask')
    expect(new SitePermissions({ always: [] }).siteAccess).toBe('ask')
  })

  test('with "all", a page the AI ran script in reaches other public sites (the person chose it); without, held back', () => {
    const scriptedSub = { mainFrame: false, hasOwner: true, driving: false, anyScripted: true, scripted: true, sameSiteAsTop: false }
    const p = new SitePermissions()
    expect(publicRequestVerdict({ ...scriptedSub, siteAllowed: p.isAllowed('site', 'static.licdn.com') })).toBe('block')
    p.setSiteAccess('all')
    expect(publicRequestVerdict({ ...scriptedSub, siteAllowed: p.isAllowed('site', 'static.licdn.com') })).toBe('allow')
    expect(publicRequestVerdict({ ...scriptedSub, mainFrame: true, driving: true, siteAllowed: p.isAllowed('site', 'new.example') })).toBe('allow')
  })
})
