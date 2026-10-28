// In-app browser after the owner's LinkedIn test (2026-10-21): "사내망 요청을 막았어요: static.licdn.com" and "AI가
// linkedin.com에서 스크립트를 실행했어요" stacked over the page.
//  - the host classifier never calls a public name "office network" because DNS was slow, failed or empty (split DNS
//    such as Tailscale MagicDNS); real office answers (private, IPv6 ULA, NAT64-mapped private, mixed) stay private
//  - security review of the branch: a LATE private answer is still private (no 3 s cut-off), a lookup without an
//    answer lets only a page load through (sub-requests and WebSockets are cancelled), the after-the-fact check
//    decides from facts about the name (a flood of names cannot empty it), and a proxy only excuses a response that
//    came from the proxy's own address
//  - routine events go to the activity log; at most one notice over the page (common/pane-activity.ts)
//  - site access "all": every public site allowed, office addresses still need their own grant
import { describe, expect, test } from 'bun:test'
import { HostClassifier } from '../../desktop/src/main/pane/classify'
import { connectedThroughProxy, proxiesIn, publicRequestVerdict, responseSourceVerdict, unresolvedVerdict, type DnsOutcome, type ResponseSource } from '../../desktop/src/common/net-policy'
import { addActivity, dismissNotice, drivingLine, emptyActivity, isNotice, markSeen, MAX_ACTIVITY_LOG, type ActivityKind, type PaneActivity } from '../../desktop/src/common/pane-activity'
import { registrableDomain, sameSite, SitePermissions, siteOf } from '../../desktop/src/common/site-permissions'
import { classifyIp, isLoopbackIp } from '../../desktop/src/common/netaddr'

const LICDN = ['172.64.154.50', '104.18.33.206', '2606:4700:440c::ac40:9a32', '2606:4700:4406::6812:21ce']
const never = () => new Promise<string[]>(() => {})
const later = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms))

describe('host classifier under slow or failing DNS', () => {
  test('static.licdn.com with its real answers is public', async () => {
    const c = new HostClassifier(new Set(), new Set(), async () => LICDN)
    expect(await c.lookup('static.licdn.com')).toEqual({ cls: 'public', loopback: false, dns: 'answered' })
  })

  test('security r1: a private answer that comes late (3.5 s) is still private, not let through as public', async () => {
    const c = new HostClassifier(new Set(), new Set(), () => later(3500, ['192.168.1.1']))
    expect(await c.lookup('x.attacker.example')).toEqual({ cls: 'private', loopback: false, dns: 'answered' })
  }, 10_000)

  test('a failing lookup (ENOTFOUND / SERVFAIL / ETIMEOUT) or an empty answer is "failed", never office network', async () => {
    for (const resolve of [
      async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND static.licdn.com'), { code: 'ENOTFOUND' })
      },
      async () => {
        throw Object.assign(new Error('net::ERR_NAME_NOT_RESOLVED'), { code: 'SERVFAIL' })
      },
      async () => [] as string[],
    ]) {
      const c = new HostClassifier(new Set(), new Set(), resolve)
      expect(await c.lookup('static.licdn.com')).toEqual({ cls: 'public', loopback: false, dns: 'failed' })
      expect(await c.isLoopback('static.licdn.com')).toBe(false)
    }
  })

  test('a lookup that never settles ends as "timeout" (everything for it is cancelled), not as public-and-go', async () => {
    const c = new HostClassifier(new Set(), new Set(), never, 50)
    expect((await c.lookup('static.licdn.com')).dns).toBe('timeout')
  })

  test('real office answers stay private: RFC 1918, CGNAT/Tailscale, IPv6 ULA, link-local, NAT64 of a private IPv4, mixed', async () => {
    for (const addrs of [['192.168.1.20'], ['100.101.102.103'], ['fd7a:115c:a1e0::1'], ['fe80::1'], ['64:ff9b::c0a8:114'], ['::ffff:10.0.0.5'], ['8.8.8.8', '10.0.0.1']]) {
      const c = new HostClassifier(new Set(), new Set(), async () => addrs)
      expect({ addrs, cls: await c.classify('router.example.com') }).toEqual({ addrs, cls: 'private' })
    }
    const lo = new HostClassifier(new Set(), new Set(), async () => ['127.0.0.1'])
    expect(await lo.isLoopback('evil.example.com')).toBe(true)
  })

  test('one lookup per name at a time (a page asks for the same CDN dozens of times), and no stale cache after it', async () => {
    let calls = 0
    let answer = LICDN
    const c = new HostClassifier(new Set(), new Set(), async () => {
      calls++
      await later(20, null)
      return answer
    })
    const all = await Promise.all(Array.from({ length: 40 }, () => c.classify('static.licdn.com')))
    expect(new Set(all)).toEqual(new Set(['public']))
    expect(calls).toBe(1)
    // the next lookup asks the (session's) resolver again: its answer, not a remembered "public", decides
    answer = ['192.168.0.9']
    expect(await c.classify('static.licdn.com')).toBe('private')
    expect(calls).toBe(2)
  })

  test('IP literals and local names never need DNS', async () => {
    const c = new HostClassifier(new Set(), new Set(), async () => {
      throw new Error('must not be called')
    })
    expect(await c.lookup('172.64.154.50')).toEqual({ cls: 'public', loopback: false, dns: 'static' })
    expect(await c.classify('192.168.1.1')).toBe('private')
    expect(await c.classify('[fd7a:115c:a1e0::53]')).toBe('private')
    expect(await c.classify('nas.local')).toBe('private')
    expect(c.isDnsName('192.168.1.1')).toBe(false)
    expect(c.isDnsName('nas.local')).toBe(false)
    expect(c.isDnsName('static.licdn.com')).toBe(true)
  })
})

describe('a request whose name DNS gave no answer', () => {
  const v = (dns: DnsOutcome, mainFrame: boolean, hasOwner = true) => unresolvedVerdict({ dns, mainFrame, hasOwner })
  test('answered or static names are decided by their address class', () => {
    for (const dns of ['answered', 'static'] as DnsOutcome[]) {
      expect(v(dns, true)).toBe('check')
      expect(v(dns, false)).toBe('check')
      expect(v(dns, false, false)).toBe('check')
    }
  })
  test('security r1 (SERVFAIL): only a tab\'s page load goes on; sub-requests, WebSockets and tab-less requests are cancelled', () => {
    expect(v('failed', true)).toBe('check')
    expect(v('failed', false)).toBe('cancel') // <img>, <script>, fetch, WebSocket, iframe
    expect(v('failed', true, false)).toBe('cancel') // service worker
  })
  test('a lookup that never settled cancels everything (a late answer still reaches Chromium through the shared resolver)', () => {
    expect(v('timeout', true)).toBe('cancel')
    expect(v('timeout', false)).toBe('cancel')
  })
})

describe('the address a response came from', () => {
  const base: ResponseSource = { ip: '172.64.154.50', proxied: false, loopback: false, privateIp: false, testMapped: false, dnsName: true, privateAllowed: false }
  const from = (ip: string): Partial<ResponseSource> => ({ ip, loopback: isLoopbackIp(ip), privateIp: classifyIp(ip) === 'private' })
  test('public answers and unknown addresses are fine', () => {
    expect(responseSourceVerdict(base)).toBe('ok')
    expect(responseSourceVerdict({ ...base, ip: undefined })).toBe('ok')
  })
  test('a DNS name that answers from the office network or this computer stops the tab', () => {
    expect(responseSourceVerdict({ ...base, ...from('192.168.1.1') })).toBe('blocked')
    expect(responseSourceVerdict({ ...base, ...from('fd00::1') })).toBe('blocked')
    expect(responseSourceVerdict({ ...base, ...from('127.0.0.1') })).toBe('forbidden')
  })
  test('allowed office hosts, IP literals and local names (decided before the request) and test names are not stopped', () => {
    expect(responseSourceVerdict({ ...base, ...from('192.168.1.1'), privateAllowed: true })).toBe('ok')
    expect(responseSourceVerdict({ ...base, ...from('192.168.1.1'), dnsName: false })).toBe('ok')
    expect(responseSourceVerdict({ ...base, ...from('127.0.0.1'), testMapped: true })).toBe('ok')
  })

  test('security r2: a flood of 1001 other names cannot empty the check (it decides from the name, not a cache)', async () => {
    const c = new HostClassifier(new Set(), new Set(), async (h) => (h === 'rebind.attacker.example' ? ['93.184.216.34'] : ['1.1.1.1']))
    expect(await c.classify('rebind.attacker.example')).toBe('public')
    for (let i = 0; i < 1001; i++) await c.classify(`n${i}.attacker.example`)
    expect(responseSourceVerdict({ ...base, ...from('192.168.1.1'), dnsName: c.isDnsName('rebind.attacker.example') })).toBe('blocked')
  })

  test('security r3: a proxy only excuses a response from the proxy\'s own address', () => {
    // a local proxy with a DIRECT fallback: a direct answer from the router is the site's own address
    expect(connectedThroughProxy('PROXY 127.0.0.1:7890; DIRECT', '192.168.1.1', ['127.0.0.1'])).toBe(false)
    expect(responseSourceVerdict({ ...base, ...from('192.168.1.1'), proxied: connectedThroughProxy('PROXY 127.0.0.1:7890; DIRECT', '192.168.1.1', ['127.0.0.1']) })).toBe('blocked')
    // the same proxy answering: its address says nothing about the site
    expect(connectedThroughProxy('PROXY 127.0.0.1:7890; DIRECT', '127.0.0.1', ['127.0.0.1'])).toBe(true)
    expect(connectedThroughProxy('SOCKS5 [::1]:1080', '::1', ['::1'])).toBe(true)
    expect(connectedThroughProxy('HTTPS proxy.corp.example:443', '10.0.0.8', ['proxy.corp.example', '10.0.0.8'])).toBe(true)
    // no proxy at all: the team server on this computer is never excused
    expect(connectedThroughProxy('DIRECT', '127.0.0.1', [])).toBe(false)
    expect(responseSourceVerdict({ ...base, ...from('127.0.0.1'), proxied: connectedThroughProxy('DIRECT', '127.0.0.1', []) })).toBe('forbidden')
    expect(proxiesIn('PROXY a.example:8080; SOCKS5 [fd00::2]:1080; DIRECT')).toEqual(['a.example', 'fd00::2'])
  })
})

describe('sites are registrable domains', () => {
  test('subdomains of one site, country registries, shared hosting', () => {
    expect(registrableDomain('news.naver.com')).toBe('naver.com')
    expect(registrableDomain('media.cnn.com')).toBe('cnn.com')
    expect(registrableDomain('static.licdn.com')).toBe('licdn.com')
    expect(registrableDomain('a.b.example.co.kr')).toBe('example.co.kr')
    expect(registrableDomain('shop.example.co.id')).toBe('example.co.id')
    expect(registrableDomain('alice.github.io')).toBe('alice.github.io')
    expect(registrableDomain('x.alice.github.io')).toBe('alice.github.io')
    expect(registrableDomain('192.168.1.1')).toBe('192.168.1.1')
    expect(siteOf('news.naver.com:8443')).toBe('naver.com:8443')
    expect(sameSite('edition.cnn.com', 'media.cnn.com')).toBe(true)
    expect(sameSite('linkedin.com', 'static.licdn.com')).toBe(false)
    expect(sameSite('alice.github.io', 'bob.github.io')).toBe(false)
    expect(sameSite('cnn.com', 'cnn.com:8080')).toBe(false)
  })

  test('a page the AI scripted reaches its own site\'s hosts; other sites stay held back', () => {
    const scriptedSub = { mainFrame: false, hasOwner: true, driving: false, anyScripted: true, scripted: true, siteAllowed: false }
    expect(publicRequestVerdict({ ...scriptedSub, sameSiteAsTop: sameSite('edition.cnn.com', 'media.cnn.com') })).toBe('allow')
    expect(publicRequestVerdict({ ...scriptedSub, sameSiteAsTop: sameSite('linkedin.com', 'static.licdn.com') })).toBe('block')
  })

  test('allowing naver.com covers news.naver.com; allowing a subdomain covers only itself; office grants are exact', () => {
    const p = new SitePermissions({ always: ['naver.com', 'blog.example.com'], privateAlways: ['corp.example'] })
    expect(p.isAllowed('site', 'news.naver.com')).toBe(true)
    expect(p.isAllowed('site', 'naver.com')).toBe(true)
    expect(p.isAllowed('site', 'naver.com:8080')).toBe(false)
    expect(p.isAllowed('site', 'shop.example.com')).toBe(false)
    expect(p.isAllowed('site', 'example.com')).toBe(false)
    expect(p.isAllowed('private', 'nas.corp.example')).toBe(false)
    p.grant('site', 'cnn.com', 'once', 't1')
    expect(p.isAllowed('site', 'edition.cnn.com', 't1')).toBe(true)
    expect(p.isAllowed('site', 'edition.cnn.com', 't2')).toBe(false)
    const gh = new SitePermissions({ always: ['alice.github.io'] })
    expect(gh.isAllowed('site', 'bob.github.io')).toBe(false)
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
    expect(isNotice('payment', false)).toBe(true)
  })

  const ev = (id: number, kind: ActivityKind, notice = isNotice(kind, true)): PaneActivity => ({ id, kind, host: `h${id}`, at: id, notice })

  test('the LinkedIn sequence: script runs and held-back requests only reach the log, nothing over the page', () => {
    let v = emptyActivity()
    v = addActivity(v, ev(1, 'script'), false)
    v = addActivity(v, { id: 2, kind: 'offsite', host: 'static.licdn.com', at: 2, notice: isNotice('offsite', false) }, false)
    v = addActivity(v, ev(3, 'script'), false)
    expect(v.notice).toBeNull()
    expect(v.log.map((a) => a.id)).toEqual([3, 2, 1])
    // only the held-back request counts as unseen: the AI's own script runs show in the "AI is using" bar instead
    expect(v.unseen).toBe(1)
    expect(markSeen(v).unseen).toBe(0)
  })

  test('the same event right after itself is one row "×N"; another host or kind is a new row', () => {
    let v = emptyActivity()
    for (let i = 1; i <= 7; i++) v = addActivity(v, { id: i, kind: 'script', host: 'news.naver.com', at: i, notice: false }, false)
    expect(v.log).toHaveLength(1)
    expect(v.log[0]).toMatchObject({ id: 7, count: 7, at: 7 })
    v = addActivity(v, { id: 8, kind: 'script', host: 'naver.com', at: 8, notice: false }, false)
    v = addActivity(v, { id: 9, kind: 'offsite', host: 'naver.com', at: 9, notice: false }, false)
    expect(v.log.map((a) => a.count ?? 1)).toEqual([1, 1, 7])
    expect(v.unseen).toBe(1)
  })

  test('the "AI is using" bar: only the AI\'s own action in this call, never a refusal or an earlier call\'s entry', () => {
    let v = emptyActivity()
    v = addActivity(v, { id: 1, kind: 'script', host: 'news.naver.com', at: 100, notice: false }, false)
    v = addActivity(v, { id: 2, kind: 'offsite', host: 'static.licdn.com', at: 200, notice: false }, false)
    // a new call on edition.cnn.com started at 150: the naver script run is older, the licdn hold is no action
    expect(drivingLine(v, 150)).toBeNull()
    v = addActivity(v, { id: 3, kind: 'script', host: 'edition.cnn.com', at: 300, notice: false }, false)
    v = addActivity(v, { id: 4, kind: 'offsite', host: 'cdn.example', at: 310, notice: false }, false)
    expect(drivingLine(v, 150)?.host).toBe('edition.cnn.com')
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
    expect(saved).toEqual({ always: ['shop.test'], privateAlways: [], siteAccess: 'all', teamAllowsAll: true })
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
