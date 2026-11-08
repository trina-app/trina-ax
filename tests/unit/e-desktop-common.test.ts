// Pure parts of the desktop app: team addresses, the team list, site permissions (with site access "all", the team's
// policy over it and the repeated-question hint), result shaping, key input, bridge sender checks, the bridge's store
// flag, the Settings > Browser channels, the team page's file chooser in the store build, quitting and the UI strings
// (desktop/src/common/*).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { asksOutside, firstRunLinks, healthVerdict, linkFromArgv, LINK_SCHEME, readDesktopLink, hostOf, INSTALL_DOCS, isGatewayDown, isLoopbackHost, isSignInPath, originOf, parseTeamAddress, teamLabel, TEAM_DOMAIN } from '../../desktop/src/common/address'
import { errorResult, MAX_ITEMS, toBrowserResult } from '../../desktop/src/common/browser-result'
import { asUiLocale, DEFAULT_UI_LOCALE, STRINGS, t, UI_LOCALES, type UiKey, type UiLocale } from '../../desktop/src/common/i18n'
import { parseKeyCombo, redactUrl } from '../../desktop/src/common/input'
import { NO_KIT, parseKit } from '../../desktop/src/common/kit'
import { RepeatPromptHint, REPEAT_HINT_WINDOW_MS, siteKey, SitePermissions } from '../../desktop/src/common/site-permissions'
import { blockedUrl } from '../../desktop/src/common/browser-block'
import { acceptFilter, answersFileChoosers, openDialogChoice } from '../../desktop/src/common/file-chooser'
import { browserOwnerChange } from '../../desktop/src/common/browser-owner'
import { publicRequestVerdict, responseSourceVerdict } from '../../desktop/src/common/net-policy'
import { addTeam, compareVersions, emptyTeams, normalizeFingerprint, partitionFor, readTeams, removeTeam, sortedTeams, touchTeam, updateTeam } from '../../desktop/src/common/teams'
import { isOwnUiUrl, isTrustedAppSender, UI_ORIGIN } from '../../desktop/src/common/trust'
import { BrowserResult } from '../../shared/src/api/browser'
import { PRODUCT } from '@mycel/shared'
import { SERVICE_HOSTS } from '@mycel/shared/service-hosts'
import { PLURAL_PATTERN, pluralNames } from '@mycel/shared/plural'
import { browserAction } from '../../desktop/src/common/browser-action'

describe('team addresses', () => {
  test('a bare team name becomes <name>.treesoop.com over https', () => {
    expect(parseTeamAddress('acme')).toEqual({ ok: true, origin: `https://acme.${TEAM_DOMAIN}`, host: `acme.${TEAM_DOMAIN}`, dev: false, entryPath: '/', name: 'acme', hosted: true })
    expect(parseTeamAddress('  ACME  ')).toMatchObject({ ok: true, origin: `https://acme.${TEAM_DOMAIN}` })
  })

  test('hosts without a scheme get https, loopback dev hosts get http; other pages than a link are dropped', () => {
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

  test('an office internet address works typed as is or with https://; a pasted invite or team link keeps its page', () => {
    const want = { ok: true as const, origin: 'https://team.example.com', host: 'team.example.com', dev: false, entryPath: '/', name: null, hosted: false }
    for (const typed of ['team.example.com', 'https://team.example.com', ' https://Team.Example.com/ ', 'team.example.com/chats/1']) expect(parseTeamAddress(typed)).toEqual(want)
    // the invite or team link opens its own join page in the app (it used to lose its token here)
    expect(parseTeamAddress('team.example.com/invite/K-PTTVic_Q_pfdW4-06s4zsJJlKEInlO2rHLV9HryGk')).toEqual({ ...want, entryPath: '/invite/K-PTTVic_Q_pfdW4-06s4zsJJlKEInlO2rHLV9HryGk' })
    expect(parseTeamAddress('https://team.example.com/join#t=0INpvAqjFG3OhdmwH4CfCuxr-mz7rx3dLOr1tEwbB7E')).toEqual({ ...want, entryPath: '/join#t=0INpvAqjFG3OhdmwH4CfCuxr-mz7rx3dLOr1tEwbB7E' })
    expect(parseTeamAddress('team.example.com/invite/abc')).toEqual({ ok: false, error: 'link' })
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

describe('first run: what the team address answered, the help screens, the host strip', () => {
  const o = `https://acme.${TEAM_DOMAIN}`
  const health = (status: number, relayError: string | null = null, bodyOk = true, location: string | null = null) => healthVerdict(o, { status, location, relayError, bodyOk })
  test('the relay\'s own answers are told apart from "not a team server"', () => {
    expect(health(200)).toEqual({ ok: true })
    expect(health(404, 'team_unknown', false)).toEqual({ ok: false, error: 'teamUnknown' })
    expect(health(403, 'team_suspended', false)).toEqual({ ok: false, error: 'suspended' })
    expect(health(403, 'team_suspended_billing', false)).toEqual({ ok: false, error: 'suspended' })
    expect(health(503, 'team_offline', false)).toEqual({ ok: false, error: 'unreachable' })
    expect(health(530, null, false)).toEqual({ ok: false, error: 'unreachable' })
    // a 404 from something that is not the relay, or a page that is not the health answer
    expect(health(404, null, false)).toEqual({ ok: false, error: 'notTeamServer' })
    expect(health(200, null, false)).toEqual({ ok: false, error: 'notTeamServer' })
    expect(t('ko', 'err.teamUnknown', { name: 'acme' })).toBe("'acme' 팀을 찾지 못했어요. 철자를 확인하거나 초대 링크를 붙여 넣어 주세요.")
  })
  test('a redirect is never followed by the network stack: only a relay rename to another name under the team domain', () => {
    // the health check reads the 3xx itself (app-window.ts fetchHealth: net.request with redirect 'manual')
    const win = readFileSync(join(import.meta.dir, '../../desktop/src/main/app-window.ts'), 'utf8')
    expect(win).toContain("redirect: 'manual'")
    expect(win).not.toMatch(/\.fetch\(`\$\{p\.origin\}\/api\/health`/)
    expect(health(308, null, false, `https://acme-corp.${TEAM_DOMAIN}/api/health`)).toEqual({ ok: false, rename: `https://acme-corp.${TEAM_DOMAIN}` })
    for (const away of ['https://evil.example/api/health', `http://acme-corp.${TEAM_DOMAIN}/api/health`, `https://acme-corp.${TEAM_DOMAIN}:8443/api/health`, `https://a.b.${TEAM_DOMAIN}/api/health`, `https://acme-corp.${TEAM_DOMAIN}./api/health`, 'http://192.168.0.10/api/health', null])
      expect(health(302, null, false, away)).toEqual({ ok: false, error: 'notTeamServer' })
    expect(healthVerdict('http://acme.localhost:19883', { status: 308, location: 'http://acme-co.localhost:19883/api/health', relayError: null, bodyOk: false })).toEqual({ ok: false, rename: 'http://acme-co.localhost:19883' })
    // a rename is asked before the new address is remembered, and followed once only
    expect(win).toMatch(/if \(!v\.ok && 'rename' in v\) return fail\('notTeamServer'\)/)
    expect(win).toMatch(/if \(origin !== p\.origin && !known\) return \{ ok: false, error: 'renamed'/)
    expect(t('ko', 'err.renamed', { host: 'acme-corp.trina.app' })).toBe('팀 주소가 acme-corp.trina.app(으)로 바뀌었어요. 새 주소로 연결할까요?')
  })
  test('the host strip shows on the team\'s sign-in pages only, in punycode', () => {
    for (const p of ['/login', '/join', '/setup', '/invite/abc', '/reset-password/abc']) expect(isSignInPath(p)).toBe(true)
    for (const p of ['/', '/chats/1', '/invite', '/joined', '/settings/apps']) expect(isSignInPath(p)).toBe(false)
    expect(hostOf('https://xn--bcher-kva.de')).toBe('xn--bcher-kva.de')
    expect(hostOf('http://acme.localhost:19883')).toBe('acme.localhost:19883')
    expect(parseTeamAddress('https://bücher.de')).toMatchObject({ ok: true, host: 'xn--bcher-kva.de' })
  })
  test('"no team yet" links: no signup in the Mac App Store build, and its docs link has no pricing', () => {
    expect(firstRunLinks({ macAppStore: false, korean: true })).toEqual({ signup: `https://${SERVICE_HOSTS.accountHost}/`, docs: INSTALL_DOCS })
    const mas = firstRunLinks({ macAppStore: true, korean: true })
    expect(mas.signup).toBeNull()
    expect(mas.docs).toBe('https://github.com/trina-app/trina-ax/blob/main/docs/INSTALL-LINUX.md')
    expect(firstRunLinks({ macAppStore: true, korean: false }).docs).toEndWith('/docs/INSTALL-LINUX.en.md')
    // the store build's page links no plans, no signup and not the product site (which has both)
    for (const f of ['docs/INSTALL-LINUX.md', 'docs/INSTALL-LINUX.en.md']) expect(readFileSync(join(import.meta.dir, '../..', f), 'utf8')).not.toMatch(/#pricing|\/signup|account\.trina\.app|https:\/\/ax\.trina\.app/i)
  })
  test('the first connect to an address the hosted service does not run asks once', () => {
    const ask = (typed: string, known = false, confirmed = false) => { const p = parseTeamAddress(typed); if (!p.ok) throw new Error(p.error); return asksOutside({ hosted: p.hosted, dev: p.dev, known, confirmed }) }
    expect(ask('acme')).toBe(false)
    expect(ask(`https://acme.${TEAM_DOMAIN}/join#t=0INpvAqjFG3OhdmwH4CfCuxr-mz7rx3dLOr1tEwbB7E`)).toBe(false)
    expect(ask('team.example.com')).toBe(true)
    expect(ask(`https://acme.${TEAM_DOMAIN}.evil.example`)).toBe(true)
    expect(ask('https://1.2.3.4')).toBe(true)
    expect(ask('team.example.com', true)).toBe(false)
    expect(ask('team.example.com', false, true)).toBe(false)
    expect(ask('acme.localhost:19151')).toBe(false)
    expect(t('ko', 'outside.body')).toBe('트리나가 운영하는 주소가 아니에요. 회사에서 직접 설치한 서버인지 확인하세요.')
  })
  test('the 팀 menu has one item for the list and adding a team', () => {
    const main = readFileSync(join(import.meta.dir, '../../desktop/src/main/main.ts'), 'utf8')
    expect(main).not.toContain("menu.addTeam")
    expect(STRINGS.ko['menu.teams']).toBe('팀 목록·추가…')
  })
})

describe('links from outside (trina-ax://open?url=…) and screen ④', () => {
  const enc = encodeURIComponent
  const link = (inner: string) => `${LINK_SCHEME}://open?url=${enc(inner)}`
  test('the scheme is the product\'s and the phone app\'s', () => {
    expect(LINK_SCHEME).toBe(PRODUCT.linkScheme)
    expect(LINK_SCHEME).toBe(JSON.parse(readFileSync(join(import.meta.dir, '../../editions/trina/branding/mobile.json'), 'utf8')).scheme)
  })
  test('a team link or invite link inside opens its page; the host shown is the one connected to', () => {
    expect(readDesktopLink(link(`https://acme.${TEAM_DOMAIN}/join#t=0INpvAqjFG3OhdmwH4CfCuxr-mz7rx3dLOr1tEwbB7E`))).toMatchObject({ ok: true, host: `acme.${TEAM_DOMAIN}`, hosted: true, entryPath: '/join#t=0INpvAqjFG3OhdmwH4CfCuxr-mz7rx3dLOr1tEwbB7E' })
    expect(readDesktopLink(link('https://team.example.com/invite/K-PTTVic_Q_pfdW4-06s4zsJJlKEInlO2rHLV9HryGk'))).toMatchObject({ ok: true, host: 'team.example.com', hosted: false, entryPath: '/invite/K-PTTVic_Q_pfdW4-06s4zsJJlKEInlO2rHLV9HryGk' })
    // http only to this machine, as typed addresses
    expect(readDesktopLink(link('http://127.0.0.1:19100/invite/K-PTTVic_Q_pfdW4-06s4zsJJlKEInlO2rHLV9HryGk'))).toMatchObject({ ok: true, host: '127.0.0.1:19100' })
  })
  test('a crafted link cannot load http to another machine, javascript:, file:, data:, user:password, or hide its host', () => {
    expect(readDesktopLink(link('http://evil.example'))).toEqual({ ok: false, error: 'insecure' })
    expect(readDesktopLink(link(`https://${TEAM_DOMAIN}@evil.example`))).toEqual({ ok: false, error: 'credentials' })
    expect(readDesktopLink(link(`https://acme.${TEAM_DOMAIN}:x@evil.example`))).toEqual({ ok: false, error: 'credentials' })
    for (const inner of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<script>x</script>', 'acme', `acme.${TEAM_DOMAIN}`, 'https://a b'])
      expect(readDesktopLink(link(inner))).toBeNull()
    // the host ④ shows is the URL parser's: a numeric trick is 127.0.0.1, a backslash ends the host, never hosted
    expect(readDesktopLink(link('https://0x7f.1/'))).toMatchObject({ ok: true, host: '127.0.0.1', hosted: false })
    expect(readDesktopLink(link('https://2130706433/'))).toMatchObject({ ok: true, host: '127.0.0.1', hosted: false })
    expect(readDesktopLink(link(`https://evil.example\\@acme.${TEAM_DOMAIN}`))).toMatchObject({ ok: true, host: 'evil.example', hosted: false })
    expect(readDesktopLink(link(`https://acme.${TEAM_DOMAIN}.evil.example/join#t=0INpvAqjFG3OhdmwH4CfCuxr-mz7rx3dLOr1tEwbB7E`))).toMatchObject({ ok: true, host: `acme.${TEAM_DOMAIN}.evil.example`, hosted: false })
    expect(readDesktopLink(link('https://xn--bcher-kva.de'))).toMatchObject({ host: 'xn--bcher-kva.de' })
    // the link itself: only open?url=<one address>
    for (const raw of [`${LINK_SCHEME}://evil?url=${enc('https://acme.trina.app')}`, `${LINK_SCHEME}://open?url=a&url=b`, `${LINK_SCHEME}://open?url=${enc('https://acme.trina.app')}&next=/x`,
      `${LINK_SCHEME}://open?url=${enc('https://acme.trina.app')}#x`, `${LINK_SCHEME}://u:p@open?url=${enc('https://acme.trina.app')}`, `${LINK_SCHEME}://open:99?url=${enc('https://acme.trina.app')}`,
      `${LINK_SCHEME}://open/x?url=${enc('https://acme.trina.app')}`, `other://open?url=${enc('https://acme.trina.app')}`, `https://acme.${TEAM_DOMAIN}/join#t=0INpvAqjFG3OhdmwH4CfCuxr-mz7rx3dLOr1tEwbB7E`, 'x'.repeat(5000)])
      expect(readDesktopLink(raw)).toBeNull()
  })
  test('the link in a command line (Windows, Linux; a second instance)', () => {
    const l = link('https://acme.trina.app/invite/K-PTTVic_Q_pfdW4-06s4zsJJlKEInlO2rHLV9HryGk')
    expect(linkFromArgv(['/Applications/X.app/Contents/MacOS/X', '--allow-file-access-from-files', l])).toBe(l)
    expect(linkFromArgv(['C:\\x\\app.exe', l.toUpperCase().replace('OPEN?URL', 'open?url')])).not.toBeNull()
    expect(linkFromArgv(['app', '--flag', 'https://acme.trina.app'])).toBeNull()
    expect(linkFromArgv(['app', `${LINK_SCHEME}:${'x'.repeat(5000)}`])).toBeNull()
  })
  test('every link goes through ④: the handlers only offer it, and only the answer connects', () => {
    const main = readFileSync(join(import.meta.dir, '../../desktop/src/main/main.ts'), 'utf8')
    const win = readFileSync(join(import.meta.dir, '../../desktop/src/main/app-window.ts'), 'utf8')
    expect(main).toMatch(/app\.on\('open-url', \(e, url\) => \{\n\s*e\.preventDefault\(\)\n\s*onLink\(url\)/)
    expect(main).toMatch(/const link = linkFromArgv\(argv\)\n\s*if \(link\) onLink\(link\)/)
    // onLink and the launch link reach the window only through offerLink
    const onLink = main.slice(main.indexOf('function onLink('), main.indexOf("app.on('open-url'"))
    expect(onLink).toContain('win.offerLink(url)')
    expect(onLink).not.toMatch(/addTeam|openTeam|loadURL/)
    // offerLink fetches nothing; answerLink connects only with the gate's offer
    const offer = win.slice(win.indexOf('  offerLink(raw: string) {'), win.indexOf('  async answerLink('))
    expect(offer).not.toMatch(/fetch|addTeam|openTeam|loadURL/)
    expect(win).toMatch(/const offer = this\.linkGate\.answer\(yes, host, Date\.now\(\)\)[\s\S]{0,200}if \(!offer\) return null[\s\S]{0,80}return this\.addTeam\(offer\.origin \+ offer\.entryPath, true\)/)
    // ④ counts from when the screen says it is up, and a team view taking over drops a waiting link
    expect(win).toContain('this.linkGate.shown(id, Date.now())')
    expect(win).toMatch(/async openTeam\(id: string, entryPath = '\/'\) \{[\s\S]{0,200}this\.linkGate\.clear\(\)/)
    expect(readFileSync(join(import.meta.dir, '../../desktop/src/ui/welcome.ts'), 'utf8')).toContain('ui.welcome.linkShown(link.id)')
    // a development run never takes the scheme over by itself
    expect(main).toContain("if (app.isPackaged) app.setAsDefaultProtocolClient(LINK_SCHEME)")
  })
  test('the dmg, Mac App Store and Microsoft Store builds declare the scheme', async () => {
    const base = (await import('../../desktop/electron-builder.config')).default as { protocols?: { name: string; schemes: string[] }[] }
    expect(base.protocols).toEqual([{ name: PRODUCT.displayName, schemes: [PRODUCT.linkScheme] }])
    // the store configs build on the base config and leave its protocols as they are
    for (const f of ['editions/trina/mac-app-store/electron-builder.mas.config.ts', 'editions/trina/microsoft-store/electron-builder.msix.config.ts']) {
      const src = readFileSync(join(import.meta.dir, '../..', f), 'utf8')
      expect(src).toContain('...base,')
      expect(src).not.toContain('protocols')
    }
    expect(readFileSync(join(import.meta.dir, '../../editions/trina/microsoft-store/build-resources/appxmanifest.xml'), 'utf8')).toContain('${extensions}')
  })
  test('④ strings name the host and never the page', () => {
    expect(t('ko', 'link.title', { host: 'acme.trina.app' })).toBe('acme.trina.app에 연결할까요?')
    expect(t('ko', 'link.body')).toBe('직접 받은 링크가 맞을 때만 연결하세요.')
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

  // App review 2026-11-01: the question said "preview_start · https://…". It names the action in the step's words.
  test('the question names what the AI does in plain words, never the tool', () => {
    expect(browserAction('preview_start', 'ko')).toBe('브라우저 열기')
    expect(browserAction('preview_start', 'en')).toBe('Open browser')
    expect(browserAction('navigate', 'ja')).toBe('ページを開く')
    expect(browserAction('computer', 'es')).toBe('Usar navegador')
    expect(browserAction('form_input', 'id')).toBe('Isi formulir')
    // a tool this build does not know, or a name that is not a tool: the general word
    expect(browserAction('mystery_tool', 'en')).toBe('Browser')
    expect(browserAction('constructor', 'ko')).toBe('브라우저')
    const tools = ['preview_start', 'navigate', 'read_page', 'get_page_text', 'find', 'computer', 'form_input', 'javascript_tool', 'browser_batch', 'tabs_context', 'tabs_create', 'tabs_select', 'tabs_close', 'resize_window', 'read_console_messages', 'read_network_requests']
    for (const l of UI_LOCALES.map((x) => x.id)) for (const tool of tools) {
      const words = browserAction(tool, l)
      expect({ tool, l, raw: words === tool || words.includes('_') }).toEqual({ tool, l, raw: false })
    }
    // the pane's question shows it, not the tool's name
    const pane = readFileSync(join(import.meta.dir, '../../desktop/src/ui/pane.ts'), 'utf8')
    expect(pane).toContain('${browserAction(p.tool, locale)} · ${p.url}')
    expect(pane).not.toContain('${p.tool} · ')
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
    expect(info).toContain('store: storeBuild(process)')
    // always a boolean on the page; a team page from before the flag ignores it, a newer page reads a missing one as false
    const preload = readFileSync(join(import.meta.dir, '../../desktop/src/preload/app.ts'), 'utf8')
    expect(preload).toContain('store: info?.store === true')
  })
})

describe('UI strings', () => {
  test('the first-run example is the bare name (acme, not a whole address) in every language; formatting preserves reserved and missing parameters', () => {
    for (const { id: locale } of UI_LOCALES) {
      // "팀 주소(예: acme)를 알면…": the box takes the bare name; the whole address works too
      expect(t(locale, 'welcome.subtitle')).toContain('acme')
      expect(t(locale, 'welcome.subtitle')).not.toContain('{domain}')
      expect(t(locale, 'welcome.placeholder', { domain: 'ignored.test' })).toBe(STRINGS[locale]['welcome.label'])
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
      // a count takes the same form in the pane's toolbar as in the main process
      for (const n of ['1', '2']) expect(tr('pane.promptsMore', { n })).toBe(t(locale, 'pane.promptsMore', { n }))
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
    // a count's name too ("{n, plural, one {# more question} other {# more questions}}" next to Korean "{n}개")
    const ph = (s: string) => [...pluralNames(s).map((n) => `{${n}}`), ...(s.replace(PLURAL_PATTERN, '').match(/\{\w+\}/g) ?? [])].sort().join(',')
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

describe("the team page's file chooser (Mac App Store build)", () => {
  test('only the store build answers it; tests can turn it on in an unpacked app, never in a packaged one', () => {
    expect(answersFileChoosers(true, true)).toBe(true)
    expect(answersFileChoosers(false, true)).toBe(false) // the direct-download Mac app and Windows: Electron's own dialog
    expect(answersFileChoosers(false, true, '1')).toBe(false)
    expect(answersFileChoosers(false, false)).toBe(false)
    expect(answersFileChoosers(false, false, '1')).toBe(true)
    expect(answersFileChoosers(false, false, 'yes')).toBe(false)
    const main = readFileSync(join(import.meta.dir, '../../desktop/src/main/main.ts'), 'utf8')
    expect(main).toContain('answerFileChoosers: answersFileChoosers(process.mas === true, app.isPackaged, process.env.MYCEL_DESKTOP_TEST_FILE_CHOOSER)')
  })

  test('the open dialog asks for what the input says: several files, a folder, the accept filter', () => {
    expect(openDialogChoice({ multiple: false })).toEqual({ properties: ['openFile'] })
    expect(openDialogChoice({ multiple: true, attributes: ['type', 'file', 'multiple', ''] })).toEqual({ properties: ['openFile', 'multiSelections'] })
    expect(openDialogChoice({ multiple: true, attributes: ['webkitdirectory', '', 'accept', '.png'] })).toEqual({ properties: ['openDirectory'] })
    // 내 스킬 가져오기 (docs/DECISIONS.md "SK"): the Claude folder, hidden folders shown, the panel's own line and button
    const claude = { message: 'Reads only the skills and CLAUDE.md', button: 'Find in this folder' }
    expect(openDialogChoice({ multiple: true, attributes: ['webkitdirectory', '', 'data-open-at', 'claude'], home: '/Users/alex/', claude }))
      .toEqual({ properties: ['openDirectory', 'showHiddenFiles'], defaultPath: '/Users/alex/.claude', message: claude.message, buttonLabel: claude.button })
    // only a folder input asks for it; any other value is an ordinary folder upload
    expect(openDialogChoice({ multiple: false, attributes: ['data-open-at', 'claude'], home: '/Users/alex', claude })).toEqual({ properties: ['openFile'] })
    expect(openDialogChoice({ multiple: true, attributes: ['webkitdirectory', '', 'data-open-at', 'home'], home: '/Users/alex', claude })).toEqual({ properties: ['openDirectory'] })
    expect(openDialogChoice({ multiple: false, attributes: ['accept', '.trinaplugin'] })).toEqual({ properties: ['openFile'], filters: [{ name: 'trinaplugin', extensions: ['trinaplugin'] }] })
    // the team icon's types, and image/* (the camera button)
    expect(acceptFilter('image/png,image/jpeg,image/webp')).toEqual([{ name: 'png, jpg, jpeg, webp', extensions: ['png', 'jpg', 'jpeg', 'webp'] }])
    expect(acceptFilter(' .PNG , image/png ')?.[0]!.extensions).toEqual(['png'])
    expect(acceptFilter('image/*')?.[0]!.extensions).toEqual(expect.arrayContaining(['heic', 'jfif', 'ico', 'jxl']))
    // anything not understood: no filter at all
    for (const a of ['', ',', 'audio/*', '.png,video/mp4', '.tar.gz', '*/*', 'image/png;q=1']) expect(acceptFilter(a)).toBeUndefined()
  })

  test("answered for the team page's top frame only, over the debugger the guards attached, never into another document", () => {
    const win = readFileSync(join(import.meta.dir, '../../desktop/src/main/app-window.ts'), 'utf8')
    const open = win.slice(win.indexOf('async openTeam('), win.indexOf('async reload()'))
    expect(open.indexOf('if (this.o.answerFileChoosers) await this.answerFileChoosers(app)')).toBeGreaterThan(open.indexOf('await guardAppView(app.webContents'))
    expect(open.indexOf('answerFileChoosers(app)')).toBeLessThan(open.indexOf('await this.loadOrigin(origin'))
    const answer = win.slice(win.indexOf('private async answerFileChoosers('), win.indexOf('private disposeTeam()'))
    // frames attached through auto-attach (they carry a sessionId) are not answered
    expect(answer.indexOf('if (sessionId) return')).toBeLessThan(answer.indexOf("method !== 'Page.fileChooserOpened'"))
    expect(answer).toContain("'Page.setInterceptFileChooserDialog', { enabled: true }")
    // the top frame at an allowed origin (as the bridge), one dialog at a time, nothing set when cancelled
    expect(answer).toContain('top.id !== frameId || !isTrustedAppSender(')
    expect(answer).toContain('this.allowedOrigins()')
    expect(answer).toContain('if (this.choosingFiles')
    expect(answer.indexOf('r.canceled')).toBeLessThan(answer.indexOf("'DOM.setFileInputFiles'"))
    // a main-frame navigation while the dialog is open (office address switch, reload): nothing is set
    expect(answer).toContain("if (method === 'Page.frameNavigated' && !params?.frame?.parentId) documents++")
    expect(answer).toContain('const opened = documents')
    expect(answer.indexOf('if (!sameDocument()) return')).toBeGreaterThan(answer.indexOf('r.canceled'))
    expect(answer.indexOf('if (!sameDocument()) return')).toBeLessThan(answer.indexOf("'DOM.setFileInputFiles'"))
    // the in-app browser pane does not get it
    expect(readFileSync(join(import.meta.dir, '../../desktop/src/main/pane/pane.ts'), 'utf8')).not.toContain('setInterceptFileChooserDialog')
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
