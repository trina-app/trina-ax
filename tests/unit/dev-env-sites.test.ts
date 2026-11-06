// Sites a person allows for the dev environment (docs/DECISIONS.md "Dev environment: sites a person allows"): the host
// that the AI asks for, the checks of a host, the merge of the lists, and when a running job's network got narrower.
// The runner, the card and the routes are tested in dev-env-srt.test.ts; the sandbox in tests/linux/srt-attack.ts.
import { describe, expect, test } from 'bun:test'
import { DEV_ENV_DEFAULT_DOMAINS, extraDomainProblem, mergeSites, siteCovers, siteFromInput, userSiteProblem } from '@mycel/shared'
import { netNarrowed, netSnapshot, parseOnce, parseSnapshot, siteAllowed } from '../../server/src/devenv/sites'

const TEAM = ['team.trina.app', 'relay.trina.app']

describe('the host the AI asks for', () => {
  test('a URL, a port, a user, a trailing dot and capitals come down to the host name', () => {
    expect(siteFromInput('https://API.Example.com:443/v1/x?y=1#z')).toBe('api.example.com')
    expect(siteFromInput('git@github.com:org/repo.git')).toBe('github.com')
    expect(siteFromInput('example.com.')).toBe('example.com')
    expect(siteFromInput('  cdn.example.org  ')).toBe('cdn.example.org')
    expect(siteFromInput('*.example.com')).toBe('*.example.com')
    expect(siteFromInput('')).toBeNull()
    expect(siteFromInput('https://')).toBeNull()
  })
})

describe('the checks of a site a person allows', () => {
  test('host names and *.domain are allowed', () => {
    for (const ok of ['api.example.com', '*.example.com', 'files.pythonhosted.org', 'a-b.example.co.uk', 'xn--9n2bp8q.example.kr']) expect(userSiteProblem(ok, TEAM)).toBeNull()
  })
  test('IP addresses in every spelling are refused', () => {
    for (const ip of ['169.254.169.254', '10.0.0.1', '127.0.0.1', '0x7f.1', '0x7f.0x0.0x0.0x1', '2852039166', '1.2.3.4', '[::1]', '::1', 'fd00::1', '100.64.0.1']) {
      expect(userSiteProblem(siteFromInput(ip) ?? ip, TEAM)).not.toBeNull()
    }
  })
  test('local, internal and metadata names are refused', () => {
    for (const n of ['localhost', 'x.localhost', 'metadata.google.internal', 'db.internal', 'printer.local', 'nas.lan', 'intranet.corp', 'router.home.arpa', 'svc.test', '*.internal'])
      expect(userSiteProblem(n, TEAM)).not.toBeNull()
  })
  test('the team server and a pattern that covers it are refused', () => {
    expect(userSiteProblem('team.trina.app', TEAM)).toContain('Trina server')
    expect(userSiteProblem('trina.app', TEAM)).toContain('Trina server')
    expect(userSiteProblem('*.trina.app', TEAM)).toContain('Trina server')
    expect(userSiteProblem('other.trina.app', TEAM)).toBeNull()
  })
  test('patterns that are too wide, and capitals, are refused', () => {
    for (const w of ['*', '*.com', 'com', '*.co.uk', 'a.*.example.com', 'API.example.com']) expect(userSiteProblem(w, TEAM)).not.toBeNull()
  })
  test('an admin\'s site gets the stricter address check too', () => {
    expect(extraDomainProblem('0x7f.1')).toContain('IP address')
    expect(extraDomainProblem('api.example.com')).toBeNull()
  })
})

describe('the sites of one run', () => {
  test('the lists merge: lowercase, no duplicates, the defaults first', () => {
    const m = mergeSites(DEV_ENV_DEFAULT_DOMAINS, ['api.example.net'], ['API.example.net', 'mine.example.com'], ['once.example.com'])
    expect(m).toEqual([...DEV_ENV_DEFAULT_DOMAINS, 'api.example.net', 'mine.example.com', 'once.example.com'])
  })
  test('a pattern covers its subdomains, not the domain itself or a look-alike', () => {
    expect(siteCovers('*.example.com', 'a.example.com')).toBe(true)
    expect(siteCovers('*.example.com', 'example.com')).toBe(false)
    expect(siteCovers('*.example.com', 'badexample.com')).toBe(false)
    expect(siteCovers('example.com', 'example.com')).toBe(true)
    expect(siteCovers('example.com', 'a.example.com')).toBe(false)
  })
  test('allowed: a default site, the team\'s, her own, a once site, or anything with Full internet', () => {
    const person = { sites: ['mine.example.com'], full: false }
    const o = { teamSites: ['*.team-api.example.net'], person, once: ['once.example.com'] }
    for (const h of ['registry.npmjs.org', 'x.team-api.example.net', 'mine.example.com', 'once.example.com']) expect(siteAllowed(h, o)).toBe(true)
    expect(siteAllowed('other.example.com', o)).toBe(false)
    expect(siteAllowed('other.example.com', { ...o, person: { ...person, full: true } })).toBe(true)
  })
  test('the once list of a row is checked again when the job starts', () => {
    expect(parseOnce('ok.example.com,169.254.169.254,localhost,team.trina.app,,x.example.org', TEAM)).toEqual(['ok.example.com', 'x.example.org'])
  })
})

describe('a running job whose network got narrower stops', () => {
  const snap = (sites: string[], full = false) => netSnapshot(['team.example.net'], { sites, full })
  test('a removed site or Full internet turned off: narrower', () => {
    expect(netNarrowed(snap(['a.example.com', 'b.example.com']), snap(['a.example.com']))).toBe(true)
    expect(netNarrowed(snap([], true), snap([]))).toBe(true)
    expect(netNarrowed(snap(['a.example.com']), netSnapshot([], { sites: ['a.example.com'], full: false }))).toBe(true)
  })
  test('a new site, or Full internet turned on: not narrower (saying yes does not stop the run)', () => {
    expect(netNarrowed(snap(['a.example.com']), snap(['a.example.com', 'c.example.com']))).toBe(false)
    expect(netNarrowed(snap(['a.example.com']), snap([], true))).toBe(false)
    expect(netNarrowed(snap([], true), snap(['x.example.com'], true))).toBe(false)
  })
  test('a row from an older build has no snapshot', () => {
    expect(parseSnapshot('')).toBeNull()
    expect(parseSnapshot('{bad')).toBeNull()
    expect(parseSnapshot(JSON.stringify(snap(['a.example.com'])))).toEqual(snap(['a.example.com']))
  })
})
