// Pure parts of the desktop app: team addresses, the team list, site permissions (with site access "all", the team's
// policy over it and the repeated-question hint), result shaping, key input, bridge sender checks, the bridge's store
// flag, the Settings > Browser channels, quitting and the UI strings (desktop/src/common/*).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { isGatewayDown, isLoopbackHost, originOf, parseTeamAddress, teamLabel, TEAM_DOMAIN } from '../../desktop/src/common/address'
import { errorResult, MAX_ITEMS, toBrowserResult } from '../../desktop/src/common/browser-result'
import { asUiLocale, DEFAULT_UI_LOCALE, STRINGS, t, UI_LOCALES, type UiKey, type UiLocale } from '../../desktop/src/common/i18n'
import { parseKeyCombo, redactUrl } from '../../desktop/src/common/input'
import { NO_KIT, parseKit } from '../../desktop/src/common/kit'
import { RepeatPromptHint, REPEAT_HINT_WINDOW_MS, siteKey, SitePermissions } from '../../desktop/src/common/site-permissions'
import { blockedUrl } from '../../desktop/src/common/browser-block'
import { browserOwnerChange } from '../../desktop/src/common/browser-owner'
import { publicRequestVerdict, responseSourceVerdict } from '../../desktop/src/common/net-policy'
import { addTeam, compareVersions, emptyTeams, normalizeFingerprint, partitionFor, readTeams, removeTeam, sortedTeams, touchTeam, updateTeam } from '../../desktop/src/common/teams'
import { isOwnUiUrl, isTrustedAppSender, UI_ORIGIN } from '../../desktop/src/common/trust'
import { BrowserResult } from '../../shared/src/api/browser'
import { PRODUCT } from '@mycel/shared'
import { SERVICE_HOSTS } from '@mycel/shared/service-hosts'

describe('team addresses', () => {
  test('a bare team name becomes <name>.treesoop.com over https', () => {
    expect(parseTeamAddress('acme')).toEqual({ ok: true, origin: `https://acme.${TEAM_DOMAIN}`, host: `acme.${TEAM_DOMAIN}`, dev: false })
    expect(parseTeamAddress('  ACME  ')).toMatchObject({ ok: true, origin: `https://acme.${TEAM_DOMAIN}` })
  })

  test('hosts without a scheme get https, loopback dev hosts get http; paths are dropped', () => {
    expect(parseTeamAddress('acme.treesoop.com/chats/1')).toMatchObject({ ok: true, origin: 'https://acme.treesoop.com' })
    expect(parseTeamAddress('myteam.localhost:19161')).toMatchObject({ ok: true, origin: 'http://myteam.localhost:19161', dev: true })
    expect(parseTeamAddress('localhost:19100')).toMatchObject({ ok: true, origin: 'http://localhost:19100' })
    expect(parseTeamAddress('127.0.0.1:19100')).toMatchObject({ ok: true, origin: 'http://127.0.0.1:19100' })
    expect(parseTeamAddress('https://acme.treesoop.com:443/')).toMatchObject({ ok: true, origin: 'https://acme.treesoop.com' })
  })

  test('plain http to a real host, credentials, other schemes and junk are refused', () => {
    expect(parseTeamAddress('')).toEqual({ ok: false, error: 'empty' })
    expect(parseTeamAddress('http://acme.treesoop.com')).toEqual({ ok: false, error: 'insecure' })
    expect(parseTeamAddress('http://192.168.0.10:8443')).toEqual({ ok: false, error: 'insecure' })
    expect(parseTeamAddress('https://user:pw@acme.treesoop.com')).toEqual({ ok: false, error: 'credentials' })
    expect(parseTeamAddress('ftp://acme.treesoop.com')).toEqual({ ok: false, error: 'unsupported_scheme' })
    expect(parseTeamAddress('file:///etc/passwd')).toEqual({ ok: false, error: 'unsupported_scheme' })
    expect(parseTeamAddress('acme team')).toEqual({ ok: false, error: 'invalid' })
    expect(parseTeamAddress('https://')).toEqual({ ok: false, error: 'invalid' })
  })

  test('an office internet address works typed as is or with https://', () => {
    const want = { ok: true as const, origin: 'https://team.example.com', host: 'team.example.com', dev: false }
    for (const typed of ['team.example.com', 'https://team.example.com', ' https://Team.Example.com/ ', 'team.example.com/invite/abc']) expect(parseTeamAddress(typed)).toEqual(want)
    expect(parseTeamAddress('http://team.example.com')).toEqual({ ok: false, error: 'insecure' })
    // the office's Mac off: Cloudflare answers 530 (error 1033); the address is right, the server is just not reachable
    for (const s of [502, 503, 504, 520, 522, 524, 530]) expect(isGatewayDown(s)).toBe(true)
    for (const s of [200, 401, 404, 500, 501, 505, 519, 531]) expect(isGatewayDown(s)).toBe(false)
  })

  test('a kit build suggests one real team address and a language; anything else is dropped', () => {
    expect(parseKit({ team: 'team.example.com', locale: 'ko' })).toEqual({ team: 'team.example.com', locale: 'ko' })
    expect(parseKit({ team: 'https://Team.Example.com/x' })).toEqual({ team: 'team.example.com', locale: null })
    expect(parseKit({ team: 'acme' }).team).toBe(`acme.${TEAM_DOMAIN}`)
    expect(parseKit({ locale: 'ko-KR' })).toEqual({ team: null, locale: 'ko' })
    for (const team of ['http://team.example.com', 'localhost:19100', 'acme.localhost:19151', 'a b', 'https://u:p@x.com', 'x'.repeat(300), 42]) expect(parseKit({ team }).team).toBeNull()
    expect(parseKit({ locale: 'fr' }).locale).toBeNull()
    for (const v of [null, 'team.example.com', [], 1]) expect(parseKit(v)).toEqual(NO_KIT)
  })

  test('helpers', () => {
    expect(isLoopbackHost('a.b.localhost')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('localhost.evil.com')).toBe(false)
    expect(originOf('https://a.b/c?d')).toBe('https://a.b')
    expect(originOf('about:blank')).toBe('')
    expect(originOf('nonsense')).toBe('')
    expect(teamLabel(`https://acme.${TEAM_DOMAIN}`)).toBe('acme')
    expect(teamLabel('http://myteam.localhost:19161')).toBe('myteam')
    expect(teamLabel('https://team.example.com')).toBe('team.example.com')
  })
})

describe('team list', () => {
  test('add (deduplicated by origin), touch, rename, remove, sort, partitions', () => {
    let f = emptyTeams()
    const a = addTeam(f, 'https://a.treesoop.com', 'a', 'aaaaaaaaaaaaaaaa', '2026-10-01T00:00:00Z')
    f = a.file
    const again = addTeam(f, 'https://a.treesoop.com', 'a2', 'bbbbbbbbbbbbbbbb', '2026-10-02T00:00:00Z')
    expect(again.existed).toBe(true)
    expect(again.team.id).toBe('aaaaaaaaaaaaaaaa')
    f = addTeam(f, 'https://b.treesoop.com', 'b', 'cccccccccccccccc', '2026-10-02T00:00:00Z').file
    f = touchTeam(f, 'cccccccccccccccc', '2026-10-03T00:00:00Z')
    expect(f.lastTeamId).toBe('cccccccccccccccc')
    expect(sortedTeams(f).map((x) => x.label)).toEqual(['b', 'a'])
    f = updateTeam(f, 'aaaaaaaaaaaaaaaa', { label: 'Acme' })
    expect(f.teams[0].label).toBe('Acme')
    f = removeTeam(f, 'cccccccccccccccc')
    expect(f.lastTeamId).toBeNull()
    expect(f.teams).toHaveLength(1)
    expect(partitionFor('aaaaaaaaaaaaaaaa', 'app')).toBe('persist:team-aaaaaaaaaaaaaaaa')
    expect(partitionFor('aaaaaaaaaaaaaaaa', 'browser')).toBe('persist:team-aaaaaaaaaaaaaaaa-browser')
  })

  test('a broken file starts empty instead of crashing', () => {
    expect(readTeams(null)).toEqual(emptyTeams())
    expect(readTeams('{nope')).toEqual(emptyTeams())
    expect(readTeams(JSON.stringify({ version: 2, teams: [] }))).toEqual(emptyTeams())
    const ok = JSON.stringify({ version: 1, teams: [{ id: 'aaaaaaaaaaaa', origin: 'https://a.b', label: 'a', addedAt: 'x', lastOpenedAt: null }], lastTeamId: null })
    expect(readTeams(ok).teams[0].direct).toBeNull()
  })

  test('fingerprints and versions', () => {
    expect(normalizeFingerprint('ab:cd:ef')).toBe('AB:CD:EF')
    expect(normalizeFingerprint('abcdef')).toBe('AB:CD:EF')
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1)
    expect(compareVersions('1.0.0', '0.99.9')).toBe(1)
  })
})

describe('site permissions', () => {
  test('keys drop www. and keep ports; non-http has no key', () => {
    expect(siteKey('https://www.Example.com/a')).toBe('example.com')
    expect(siteKey('http://127.0.0.1:19153/x')).toBe('127.0.0.1:19153')
    expect(siteKey('about:blank')).toBe('')
    expect(siteKey('javascript:alert(1)')).toBe('')
  })

  test('once is per turn, always is saved, deny saves nothing, scopes are separate', () => {
    const p = new SitePermissions()
    expect(p.grant('site', 'shop.test', 'once', 'turn-1')).toBe(false)
    expect(p.isAllowed('site', 'shop.test', 'turn-1')).toBe(true)
    expect(p.isAllowed('site', 'shop.test', 'turn-2')).toBe(false)
    expect(p.isAllowed('private', 'shop.test', 'turn-1')).toBe(false)
    expect(p.grant('site', 'shop.test', 'deny', 'turn-1')).toBe(false)
    expect(p.grant('site', 'news.test', 'always')).toBe(true)
    expect(p.grant('site', 'news.test', 'always')).toBe(false)
    expect(p.isAllowed('site', 'news.test', 'any')).toBe(true)
    p.forgetTurn('turn-1')
    expect(p.isAllowed('site', 'shop.test', 'turn-1')).toBe(false)
    p.grant('private', '192.168.0.10', 'always')
    expect(p.toJSON()).toEqual({ always: ['news.test'], privateAlways: ['192.168.0.10'], siteAccess: 'ask', teamAllowsAll: true })
    expect(p.revoke('192.168.0.10')).toBe(true)
    expect(new SitePermissions(p.toJSON()).list()).toEqual({ always: ['news.test'], privateAlways: [] })
  })

  test('only the newest turns keep their once grants; junk in the saved file is ignored', () => {
    const p = new SitePermissions({ always: ['ok.test', 3 as unknown as string, ''], privateAlways: 'x' as unknown as string[] })
    expect(p.list()).toEqual({ always: ['ok.test'], privateAlways: [] })
    for (let i = 0; i < 40; i++) p.grant('site', 'h', 'once', `t${i}`)
    expect(p.isAllowed('site', 'h', 't0')).toBe(false)
    expect(p.isAllowed('site', 'h', 't39')).toBe(true)
  })
})

describe('site access "all", the team policy and Settings > Browser', () => {
  test('the value survives a save and a restart; older files (no siteAccess / no policy) read as ask / allowed', () => {
    const p = new SitePermissions()
    expect(p.setSiteAccess('all')).toBe(true)
    expect(p.setSiteAccess('all')).toBe(false) // unchanged: nothing to save
    p.grant('site', 'naver.com', 'always')
    const saved = JSON.parse(JSON.stringify(p.toJSON()))
    expect(saved).toEqual({ always: ['naver.com'], privateAlways: [], siteAccess: 'all', teamAllowsAll: true })
    const back = new SitePermissions(saved)
    expect(back.settings()).toEqual({ always: ['naver.com'], privateAlways: [], siteAccess: 'all', teamAllowsAll: true })
    expect(new SitePermissions({ always: ['a.test'], privateAlways: [] }).settings()).toEqual({ always: ['a.test'], privateAlways: [], siteAccess: 'ask', teamAllowsAll: true })
    // junk is "ask", never "all"
    expect(new SitePermissions({ siteAccess: 'ALL' as never }).siteAccess).toBe('ask')
    expect(new SitePermissions({ siteAccess: 'all', teamAllowsAll: 'no' as never }).siteAccess).toBe('all') // only false switches it off
  })

  test('team policy off: "all" goes back to "ask" at once, cannot be chosen, and stays off after a restart', () => {
    const p = new SitePermissions({ always: ['naver.com'], siteAccess: 'all' })
    expect(p.setTeamPolicy(false)).toBe(true) // caller saves and tells both screens
    expect(p.siteAccess).toBe('ask')
    expect(p.teamAllowsAll).toBe(false)
    expect(p.isAllowed('site', 'shop.test')).toBe(false)
    expect(p.isAllowed('site', 'naver.com')).toBe(true) // the always list is untouched
    expect(p.setSiteAccess('all')).toBe(false)
    expect(p.siteAccess).toBe('ask')
    expect(p.setTeamPolicy(false)).toBe(false) // same policy again: nothing to save
    const restarted = new SitePermissions(JSON.parse(JSON.stringify(p.toJSON())))
    expect(restarted.settings()).toMatchObject({ siteAccess: 'ask', teamAllowsAll: false })
    expect(restarted.setSiteAccess('all')).toBe(false)
    // a file that says "all" while the team said no (written by hand): ask
    expect(new SitePermissions({ siteAccess: 'all', teamAllowsAll: false }).siteAccess).toBe('ask')
    // policy back on: the choice is possible again, but nothing turns "all" back on by itself
    expect(restarted.setTeamPolicy(true)).toBe(true)
    expect(restarted.siteAccess).toBe('ask')
    expect(restarted.setSiteAccess('all')).toBe(true)
    expect(restarted.siteAccess).toBe('all')
  })

  test('"all" covers public sites only: office-network, this computer and the team address still ask or stay blocked', () => {
    const p = new SitePermissions({ siteAccess: 'all' })
    expect(p.isAllowed('site', 'any-site.example')).toBe(true)
    expect(p.isAllowed('site', '')).toBe(false)
    // office network keeps its own grant (permit() asks with scope 'private'; net-guard blocks sub-requests)
    expect(p.isAllowed('private', '192.168.0.10')).toBe(false)
    expect(p.isAllowed('private', 'nas.lan:5000')).toBe(false)
    // this computer and team addresses: refused before any question, whatever the setting
    const teams = new Set(['acme.treesoop.com'])
    for (const u of ['http://127.0.0.1:19100/api/me', 'http://localhost/', 'http://[::1]/', 'http://x.localhost/']) expect({ u, r: blockedUrl(u, teams) }).toEqual({ u, r: 'loopback' })
    expect(blockedUrl('https://acme.treesoop.com/api/me', teams)).toBe('team')
    // a public site allowed by "all" whose answer came from this computer or the office (DNS rebinding): still stopped
    const src = { ip: '127.0.0.1', proxied: false, loopback: true, privateIp: false, testMapped: false, dnsName: true, privateAllowed: p.isAllowed('private', 'evil.example') }
    expect(responseSourceVerdict(src)).toBe('forbidden')
    expect(responseSourceVerdict({ ...src, ip: '192.168.0.5', loopback: false, privateIp: true })).toBe('blocked')
    // the public-site verdict with "all": allowed (siteAllowed comes from isAllowed('site'))
    expect(publicRequestVerdict({ mainFrame: true, hasOwner: true, driving: true, anyScripted: true, scripted: true, sameSiteAsTop: false, siteAllowed: p.isAllowed('site', 'other.example') })).toBe('allow')
    expect(publicRequestVerdict({ mainFrame: true, hasOwner: true, driving: true, anyScripted: false, scripted: false, sameSiteAsTop: false, siteAllowed: new SitePermissions().isAllowed('site', 'other.example') })).toBe('ask')
  })

  test('hint after the third site question in a row: within one turn or a short window, once', () => {
    const t0 = 1_000_000
    const h = new RepeatPromptHint()
    expect(h.record('turn-1', t0)).toBe(false)
    expect(h.record('turn-1', t0 + 1000)).toBe(false)
    expect(h.record('turn-1', t0 + 2000)).toBe(true)
    // once: never again for this pane
    for (let i = 0; i < 10; i++) expect(h.record('turn-1', t0 + 3000 + i)).toBe(false)

    // across turns, close together
    const w = new RepeatPromptHint()
    expect(w.record('a', t0)).toBe(false)
    expect(w.record('b', t0 + 60_000)).toBe(false)
    expect(w.record('c', t0 + 120_000)).toBe(true)

    // across turns, spread out: no hint
    const spread = new RepeatPromptHint()
    expect(spread.record('a', t0)).toBe(false)
    expect(spread.record('b', t0 + REPEAT_HINT_WINDOW_MS + 1)).toBe(false)
    expect(spread.record('c', t0 + 2 * REPEAT_HINT_WINDOW_MS + 2)).toBe(false)

    // one long turn: questions far apart still count
    const long = new RepeatPromptHint()
    expect(long.record('t', t0)).toBe(false)
    expect(long.record('other', t0 + 1000)).toBe(false)
    expect(long.record('t', t0 + 3 * REPEAT_HINT_WINDOW_MS)).toBe(false)
    expect(long.record('t', t0 + 4 * REPEAT_HINT_WINDOW_MS)).toBe(true)

    // no turn (the person's own navigation has none): only the window counts
    const none = new RepeatPromptHint()
    expect(none.record(undefined, t0)).toBe(false)
    expect(none.record(undefined, t0 + REPEAT_HINT_WINDOW_MS + 1)).toBe(false)
    expect(none.record(undefined, t0 + REPEAT_HINT_WINDOW_MS + 2)).toBe(false)
    expect(none.record(undefined, t0 + REPEAT_HINT_WINDOW_MS + 3)).toBe(true)
  })

  test('the team page channels: sender checked, arguments checked, "all" only through the app\'s own dialog', () => {
    const main = readFileSync(join(import.meta.dir, '../../desktop/src/main/main.ts'), 'utf8')
    // each registration runs from its "  ipcMain." line to the next one
    const chunks = main.slice(main.indexOf('function registerIpc'), main.indexOf('// ------------------------------------------------------------------ menu')).split(/\n(?=  ipcMain\.)/)
    const byName = new Map(chunks.map((c) => [/^  ipcMain\.(?:handle|on)\('(bridge:browser-[a-z-]+)'/.exec(c)?.[1], c] as const).filter((x): x is [string, string] => Boolean(x[0])))
    expect([...byName.keys()].sort()).toEqual(['bridge:browser-access', 'bridge:browser-cancel', 'bridge:browser-run', 'bridge:browser-settings', 'bridge:browser-site-remove', 'bridge:browser-sites-clear'])
    for (const [name, body] of byName) expect({ name, checked: body.includes('fromApp(e)') }).toEqual({ name, checked: true })
    const access = byName.get('bridge:browser-access')!
    expect(access).not.toContain("setSiteAccess('all')")
    expect(access).toContain('requestAllowAll()')
    const win = readFileSync(join(import.meta.dir, '../../desktop/src/main/app-window.ts'), 'utf8')
    const request = win.slice(win.indexOf('async requestAllowAll()'), win.indexOf('private sendSiteSettings'))
    // the setting changes only after the person picked button 1 ("Allow all websites") of the app's own dialog
    expect(request.indexOf('dialog.showMessageBox(')).toBeGreaterThan(0)
    expect(request.indexOf('r.response !== 1')).toBeGreaterThan(request.indexOf('dialog.showMessageBox('))
    expect(request.indexOf("setSiteAccess('all')")).toBeGreaterThan(request.indexOf('r.response !== 1'))
    expect(request).toContain('cancelId: 0')
    expect(request).toContain('defaultId: 0')
    // the site removal accepts only a host that is in the list
    expect(byName.get('bridge:browser-site-remove')).toContain("typeof host === 'string'")
    // the preload offers exactly these five, nothing else
    const preload = readFileSync(join(import.meta.dir, '../../desktop/src/preload/app.ts'), 'utf8')
    const block = preload.slice(preload.indexOf('browserSettings: {'), preload.indexOf('},', preload.indexOf('browserSettings: {')))
    expect([...block.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1])).toEqual(['get', 'onChange', 'setAccess', 'removeSite', 'clearSites'])
  })
})

describe('browser results on the wire', () => {
  test('texts are merged into one item, images follow, shared screenshots are flagged', () => {
    const r = toBrowserResult('c', { isError: false, content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg', share: true }, { type: 'text', text: 'b' }] })
    expect(r).toEqual({ callId: 'c', ok: true, content: [{ type: 'text', text: 'a\nb' }, { type: 'image', mime: 'image/jpeg', data: 'AAAA', shareToChat: true }] })
    expect(BrowserResult.safeParse(r).success).toBe(true)
  })

  test('at most 20 items: the newest images stay and the model is told', () => {
    const imgs = Array.from({ length: 30 }, (_, i) => ({ type: 'image' as const, data: `D${i}`, mimeType: 'image/png' }))
    const r = toBrowserResult('c', { isError: false, content: imgs })
    expect(r.content).toHaveLength(MAX_ITEMS)
    expect((r.content[1] as { data: string }).data).toBe('D11')
    expect((r.content[0] as { text: string }).text).toContain('11 images left out')
    expect(BrowserResult.safeParse(r).success).toBe(true)
  })

  test('errors carry an error string; huge texts are cut; unknown image types are dropped', () => {
    const r = toBrowserResult('c', { isError: true, content: [{ type: 'text', text: 'x'.repeat(3_000_000) }, { type: 'image', data: 'A', mimeType: 'image/gif' }] })
    expect(r.ok).toBe(false)
    expect(r.error!.length).toBeLessThanOrEqual(4000)
    expect((r.content[0] as { text: string }).text.length).toBeLessThanOrEqual(2_000_000)
    expect(r.content).toHaveLength(1)
    expect(BrowserResult.safeParse(r).success).toBe(true)
    expect(errorResult('c', 'nope')).toEqual({ callId: 'c', ok: false, content: [{ type: 'text', text: 'nope' }], error: 'nope' })
  })
})

describe('key input and URL redaction', () => {
  test('combos map to CDP key events', () => {
    expect(parseKeyCombo('Enter').def.key).toBe('Enter')
    const sel = parseKeyCombo('cmd+a')
    expect(sel.modifiers).toBe(4)
    expect(sel.command).toBe('selectAll')
    expect(sel.def.text).toBeUndefined()
    expect(parseKeyCombo('shift+Tab').modifiers).toBe(8)
    expect(parseKeyCombo('F5').def.keyCode).toBe(116)
    expect(() => parseKeyCombo('Hyper')).toThrow('Unknown key')
  })

  test('secrets in URLs are redacted', () => {
    expect(redactUrl('https://a.b/cb?code=123&state=x&token=t')).toBe('https://a.b/cb?code=REDACTED&state=x&token=REDACTED')
    expect(redactUrl('https://u:p@a.b/')).toBe('https://u:REDACTED@a.b/')
    expect(redactUrl('not a url')).toBe('not a url')
  })
})

describe('bridge senders', () => {
  const origins = ['https://acme.treesoop.com', 'https://127.0.0.1:8443']
  test('only the top frame of the app view at a team origin is trusted', () => {
    expect(isTrustedAppSender({ url: 'https://acme.treesoop.com/chats/1', isTop: true, isAppView: true }, origins)).toBe(true)
    expect(isTrustedAppSender({ url: 'https://127.0.0.1:8443/', isTop: true, isAppView: true }, origins)).toBe(true)
    expect(isTrustedAppSender({ url: 'https://acme.treesoop.com/', isTop: false, isAppView: true }, origins)).toBe(false)
    expect(isTrustedAppSender({ url: 'https://acme.treesoop.com/', isTop: true, isAppView: false }, origins)).toBe(false)
    expect(isTrustedAppSender({ url: 'https://evil.treesoop.com/', isTop: true, isAppView: true }, origins)).toBe(false)
    expect(isTrustedAppSender({ url: 'about:srcdoc', isTop: true, isAppView: true }, origins)).toBe(false)
    expect(isTrustedAppSender(null, origins)).toBe(false)
  })

  test('own screens are recognised by scheme and host', () => {
    expect(isOwnUiUrl(`${UI_ORIGIN}/welcome.html`)).toBe(true)
    expect(isOwnUiUrl('https://app/welcome.html')).toBe(false)
    expect(isOwnUiUrl(`${UI_ORIGIN.replace('app', 'evil')}/x`)).toBe(false)
  })

  test('the team page hears whether this is a Mac App Store build (store: Settings > Apps then offers no installer)', () => {
    const main = readFileSync(join(import.meta.dir, '../../desktop/src/main/main.ts'), 'utf8')
    const info = main.slice(main.indexOf("ipcMain.on('bridge:info'"), main.indexOf("ipcMain.handle('bridge:browser-run'"))
    expect(info).toContain('fromApp(e) ?')
    expect(info).toContain('store: process.mas === true')
    // always a boolean on the page; a team page from before the flag ignores it, a newer page reads a missing one as false
    const preload = readFileSync(join(import.meta.dir, '../../desktop/src/preload/app.ts'), 'utf8')
    expect(preload).toContain('store: info?.store === true')
  })
})

describe('UI strings', () => {
  test('welcome examples use the edition domain in every language; formatting preserves reserved and missing parameters', () => {
    for (const { id: locale } of UI_LOCALES) {
      expect(t(locale, 'welcome.subtitle')).toContain(`acme.${SERVICE_HOSTS.teamDomain}`)
      expect(t(locale, 'welcome.subtitle')).not.toContain('{domain}')
      expect(t(locale, 'welcome.placeholder', { domain: 'ignored.test' })).toBe(`acme.${SERVICE_HOSTS.teamDomain}`)
      expect(t(locale, 'err.notTeamServer', { app: 'ignored' })).toContain(PRODUCT.displayName)
      expect(t(locale, 'perm.site.title', { host: 'shop.test' })).toContain('shop.test')
      expect(t(locale, 'perm.site.title')).toContain('{host}')
      expect(t(locale, 'perm.site.title', { host: '' })).not.toContain('{host}')
    }
  })

  test('renderer formatting matches common translations and preserves its preload app name and fallbacks', async () => {
    const build = await Bun.build({ entrypoints: [join(import.meta.dir, '../../desktop/src/ui/dom.ts')], target: 'browser', format: 'cjs' })
    expect(build.success).toBe(true)
    const source = await build.outputs[0].text()
    const renderer = (loaded: { locale: UiLocale; strings: Partial<Record<UiKey, string>> } | null) => {
      const module = { exports: {} as typeof import('../../desktop/src/ui/dom') }
      runInNewContext(source, { module, window: { mycelUi: { strings: () => loaded } }, document: { documentElement: {} } })
      return module.exports.tr
    }
    for (const { id: locale } of UI_LOCALES) {
      const tr = renderer({ locale, strings: STRINGS[locale] })
      const cases: Record<string, string>[] = [{}, { app: 'ignored', domain: 'ignored.test', host: 'shop.test' }, { host: '' }]
      for (const key of ['welcome.subtitle', 'welcome.placeholder', 'err.notTeamServer', 'perm.site.title'] as const) {
        for (const params of cases) {
          expect(tr(key, params)).toBe(t(locale, key, params))
        }
      }
    }
    const template = '{app} {domain} {host} {unknown}'
    expect(renderer({ locale: 'en', strings: { 'app.name': 'Edition App', 'welcome.subtitle': template } })('welcome.subtitle', { app: 'ignored', domain: 'ignored.test', host: 'shop.test' }))
      .toBe(`Edition App ${SERVICE_HOSTS.teamDomain} shop.test {unknown}`)
    expect(renderer({ locale: 'en', strings: { 'welcome.subtitle': template } })('welcome.subtitle'))
      .toBe(`${PRODUCT.displayName} ${SERVICE_HOSTS.teamDomain} {host} {unknown}`)
    expect(renderer(null)('welcome.subtitle')).toBe('welcome.subtitle')
  })

  test('ko, en and id have exactly the same keys and no empty strings', () => {
    const keys = Object.keys(STRINGS.ko).sort()
    for (const l of ['en', 'id', 'ja', 'es'] as const) expect(Object.keys(STRINGS[l]).sort()).toEqual(keys)
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) for (const k of keys) expect((STRINGS[l] as Record<string, string>)[k].length).toBeGreaterThan(0)
  })

  test('placeholders are the same in every language', () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',')
    for (const k of Object.keys(STRINGS.ko) as (keyof typeof STRINGS.ko)[]) {
      expect(ph(STRINGS.en[k])).toBe(ph(STRINGS.ko[k]))
      expect(ph(STRINGS.id[k])).toBe(ph(STRINGS.ko[k]))
      expect(ph(STRINGS.ja[k])).toBe(ph(STRINGS.en[k]))
      expect(ph(STRINGS.es[k])).toBe(ph(STRINGS.en[k]))
    }
  })

  test('locale choice and formatting: English unless the team page or the person said otherwise', () => {
    expect(DEFAULT_UI_LOCALE).toBe('en')
    expect(asUiLocale('ko-KR')).toBe('ko')
    expect(asUiLocale('in')).toBe('id')
    expect(asUiLocale('ja-JP')).toBe('ja')
    expect(asUiLocale('es-MX')).toBe('es')
    expect(asUiLocale('fr-FR')).toBeNull()
    expect(asUiLocale({ locale: 'ko' })).toBeNull()
    expect(asUiLocale('ko'.padEnd(40, 'x'))).toBeNull()
    expect(UI_LOCALES.map((l) => l.label)).toEqual(['English', '한국어', 'Bahasa Indonesia', '日本語', 'Español'])
    for (const l of ['en', 'id', 'ja', 'es'] as const) for (const [k, v] of Object.entries(STRINGS[l])) expect({ l, k, korean: /[\uAC00-\uD7A3]/.test(v) }).toEqual({ l, k, korean: false })
    expect(t('en', 'perm.site.title', { host: 'shop.test' })).toBe('The AI wants to use shop.test')
    expect(t('ko', 'err.notTeamServer')).toBe(`이 주소는 ${PRODUCT.displayName} 팀 서버가 아니에요.`)
  })
})

describe('in-app browser data belongs to one person (QA finding 4)', () => {
  test('another person, a sign-out, or data from before the check clears it; the same person keeps it', () => {
    expect(browserOwnerChange('u-raka', { signedIn: true, userId: 'u-raka' })).toEqual({ clear: false, owner: 'u-raka' })
    expect(browserOwnerChange('u-raka', { signedIn: true, userId: 'u-seungju' })).toEqual({ clear: true, owner: 'u-seungju' })
    expect(browserOwnerChange('u-raka', { signedIn: false })).toEqual({ clear: true, owner: null })
    expect(browserOwnerChange(null, { signedIn: false })).toEqual({ clear: false, owner: null })
    expect(browserOwnerChange(null, { signedIn: true, userId: 'u-raka' })).toEqual({ clear: false, owner: 'u-raka' })
    expect(browserOwnerChange(undefined, { signedIn: true, userId: 'u-raka' })).toEqual({ clear: true, owner: 'u-raka' })
    expect(browserOwnerChange(undefined, { signedIn: false })).toEqual({ clear: true, owner: null })
  })
  test('resetForNewPerson forgets saved and per-turn sites and "all", and keeps the team policy', () => {
    const p = new SitePermissions({ always: ['httpbin.org'], privateAlways: ['192.168.1.1'], siteAccess: 'all', teamAllowsAll: true })
    p.grant('site', 'example.com', 'once', 't1')
    expect(p.isAllowed('site', 'example.com', 't1')).toBe(true)
    expect(p.resetForNewPerson()).toBe(true)
    expect(p.toJSON()).toEqual({ always: [], privateAlways: [], siteAccess: 'ask', teamAllowsAll: true })
    expect(p.isAllowed('site', 'example.com', 't1')).toBe(false)
    expect(p.resetForNewPerson()).toBe(false)
    const off = new SitePermissions({ always: ['a.com'], teamAllowsAll: false })
    off.resetForNewPerson()
    expect(off.teamAllowsAll).toBe(false)
  })
})

describe('quitting', () => {
  test("one quit ends the app, after the open team's cookies are written (the window is closed by will-quit)", () => {
    const main = readFileSync(join(import.meta.dir, '../../desktop/src/main/main.ts'), 'utf8')
    // the window closes (and win is cleared) before will-quit: the team it showed is kept when it closes
    const closed = main.slice(main.indexOf("win.win.on('closed'"), main.indexOf('buildMenu()', main.indexOf("win.win.on('closed'")))
    expect(closed.indexOf('lastTeam = win?.team?.id ?? lastTeam')).toBeLessThan(closed.indexOf('win = undefined'))
    const willQuit = main.slice(main.indexOf("app.on('will-quit'"), main.indexOf("app.on('window-all-closed'"))
    expect(willQuit).toContain('const id = win?.team?.id ?? lastTeam')
    expect(willQuit).toContain('cookies.flushStore()')
    // asked again from a new task: a quit asked while Electron still handles the held-back one is ignored
    expect(willQuit).toContain('setTimeout(() => app.quit(), 0)')
    expect(willQuit.match(/app\.quit\(\)/g)).toHaveLength(1)
  })
})
