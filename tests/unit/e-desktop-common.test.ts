// Pure parts of the desktop app: team addresses, the team list, site permissions (with site access "all", the team's
// policy over it and the repeated-question hint), result shaping, key input, bridge sender checks, the bridge's store
// flag, the Settings > Browser channels, the team page's file chooser in the store build, the right-click menu,
// quitting and the UI strings (desktop/src/common/*).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { answersAgain, asksOutside, certTrouble, desktopPagePath, googleSignInCode, healthVerdict, officeCertPage, offlineRetryDelay, OFFLINE_RETRY_MS, linkFromArgv, LINK_SCHEME, readDesktopLink, retypablePath, startupLinkTarget, hostOf, isGatewayDown, isLoopbackHost, isSignInPath, onThisComputer, originOf, parseTeamAddress, teamLabel, TEAM_DOMAIN } from '../../desktop/src/common/address'
import { resumePage } from '../../desktop/src/common/update-guard'
import { claimPage, consoleOrigin, createLinks, DEMO_URL, freePlanLines, noticeAction, noticeForError, offerFromProbe, oldSetupPage, PRICING_URL, startSteps, teamHost, CREATE_NOTICES } from '../../desktop/src/common/create-team'
import { errorResult, MAX_ITEMS, toBrowserResult } from '../../desktop/src/common/browser-result'
import { asUiLocale, DEFAULT_UI_LOCALE, STRINGS, t, UI_LOCALES, type UiKey, type UiLocale } from '../../desktop/src/common/i18n'
import { parseKeyCombo, redactUrl } from '../../desktop/src/common/input'
import { NO_KIT, parseKit } from '../../desktop/src/common/kit'
import { RepeatPromptHint, REPEAT_HINT_WINDOW_MS, siteKey, SitePermissions } from '../../desktop/src/common/site-permissions'
import { applyMePolicy } from '../../desktop/src/common/me-policy'
import { blockedUrl } from '../../desktop/src/common/browser-block'
import { acceptFilter, answersFileChoosers, openDialogChoice } from '../../desktop/src/common/file-chooser'
import { browserOwnerChange } from '../../desktop/src/common/browser-owner'
import { publicRequestVerdict, responseSourceVerdict } from '../../desktop/src/common/net-policy'
import { addTeam, compareVersions, dataDirName, emptyTeams, normalizeFingerprint, partitionFor, readTeams, removeTeam, sortedTeams, touchTeam, updateTeam } from '../../desktop/src/common/teams'
import { isOwnUiUrl, isTrustedAppSender, UI_ORIGIN } from '../../desktop/src/common/trust'
import { BrowserResult } from '../../shared/src/api/browser'
import { PRODUCT } from '@mycel/shared'
import { SERVICE_HOSTS } from '@mycel/shared/service-hosts'
import { PLURAL_PATTERN, pluralNames } from '@mycel/shared/plural'
import { browserAction } from '../../desktop/src/common/browser-action'
import { CLIPBOARD_PNG_MAX, CLIPBOARD_PNG_SIDE, clipboardPng, contextMenuItems, isTeamPage, saveableImage, type ContextFacts, type ContextItem } from '../../desktop/src/common/context-menu'

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
    for (const h of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '::ffff:7f00:1', '[::7f00:1]', '[::]', '0.0.0.0', '0', '0.1.2.3', '127.255.0.1', '[::ffff:0:0]', 'LOCALHOST.'])
      expect({ h, loopback: isLoopbackHost(h) }).toEqual({ h, loopback: true })
    for (const h of ['[::ffff:c0a8:1]', '[::ffff:192.168.0.1]', '8.8.8.8', '[2001:db8::1]', '[fe80::1]', '00', '1.0.0.0', 'evil.0'])
      expect({ h, loopback: isLoopbackHost(h) }).toEqual({ h, loopback: false })
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
    expect(t('ko', 'err.short_name')).toContain('macmini.local:8443')
    expect(t('ko', 'err.teamUnknown', { name: 'acme' })).toBe("'acme' 팀을 찾지 못했어요. 철자를 확인하거나 초대 링크를 붙여 넣어 주세요.")
  })
  test('TC-3452: an office certificate that is not installed here is said as that, with where to get it; the check stays strict', () => {
    // what Electron's net.request gives when no authority this computer trusts signed the certificate
    expect(certTrouble(new Error('net::ERR_CERT_AUTHORITY_INVALID'))).toBe('untrusted')
    for (const code of ['ERR_CERT_COMMON_NAME_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_CERT_REVOKED', 'ERR_CERT_WEAK_KEY', 'ERR_CERT_INVALID'])
      expect(certTrouble(new Error(`net::${code}`))).toBe('invalid')
    // not the certificate: "cannot reach" as before
    for (const e of [new Error('net::ERR_CONNECTION_REFUSED'), new Error('net::ERR_NAME_NOT_RESOLVED'), new Error('net::ERR_INTERNET_DISCONNECTED'), new Error('net::ERR_SSL_PROTOCOL_ERROR'), new Error('timeout'), new Error(''), null, undefined, 7, { message: 'net::ERR_CERT_AUTHORITY_INVALID' }, 'XERR_CERT_AUTHORITY_INVALID'])
      expect(certTrouble(e)).toBeNull()
    // the certificate page: plain http one port below, only for an office address with a port
    expect(officeCertPage('https://192.168.0.10:8443')).toBe('http://192.168.0.10:8442')
    expect(officeCertPage('https://10.0.0.5:9443')).toBe('http://10.0.0.5:9442')
    expect(officeCertPage('https://macmini.local:8443')).toBe('http://macmini.local:8442')
    expect(officeCertPage('https://[fd00::1]:8443')).toBe('http://[fd00::1]:8442')
    for (const o of ['https://192.168.0.10', 'https://team.example.com:8443', `https://acme.${TEAM_DOMAIN}`, 'https://8.8.8.8:8443', 'http://192.168.0.10:8443', 'https://192.168.0.10:1', 'garbage', ''])
      expect(officeCertPage(o)).toBeNull()
    for (const l of Object.keys(STRINGS) as UiLocale[]) {
      const withPage = t(l, 'err.certUntrusted', { page: 'http://192.168.0.10:8442' })
      expect(withPage).toContain('http://192.168.0.10:8442')
      expect(withPage).not.toContain('{page}')
      for (const k of ['err.certUntrusted', 'err.certUntrustedNoPage', 'err.certInvalid'] as const) expect(STRINGS[l][k]).not.toBe(STRINGS[l]['err.unreachable'])
      expect(STRINGS[l]['err.certUntrustedNoPage']).not.toContain('{')
    }
    expect(t('en', 'err.certUntrusted', { page: 'http://192.168.0.10:8442' })).toBe('This computer does not have the office certificate yet, so the app cannot check the team server. Open http://192.168.0.10:8442 in a web browser, or follow the desk card, install the certificate, then try again.')
    expect(t('en', 'err.certUntrusted', { page: 'x' })).not.toMatch(/internet/i)
    // nothing here lets a connection past a certificate error: the app's one certificate rule is the pinned office
    // certificate of a team already joined (main/direct.ts, its probe and its verify proc), and the add-team check
    // only reads the error
    const main = ['app-window.ts', 'main.ts', 'security.ts', 'direct.ts'].map((f) => readFileSync(join(import.meta.dir, '../../desktop/src/main', f), 'utf8'))
    expect(main.slice(0, 3).join('\n')).not.toMatch(/certificate-error|ignore-certificate-errors|allow-insecure-localhost|rejectUnauthorized|setCertificateVerifyProc\(/)
    expect(main[3]!.match(/setCertificateVerifyProc\(/g)?.length).toBe(1)
    expect(main[3]!.match(/rejectUnauthorized/g)?.length).toBe(1)
    const win = main[0]!
    expect(win).toMatch(/const trouble = certTrouble\(e\)\n\s+return trouble \? failCert\(trouble\) : fail\('unreachable'\)/)
  })
  test('TC-3453: the cannot-reach card looks again by itself after 5, 10, 20 and then every 30 s; only the team server\'s own answer opens the team', () => {
    expect([0, 1, 2, 3, 4, 50].map(offlineRetryDelay)).toEqual([5_000, 10_000, 20_000, 30_000, 30_000, 30_000])
    expect([-1, NaN, Infinity].map(offlineRetryDelay)).toEqual([5_000, 30_000, 30_000])
    expect(Math.max(...OFFLINE_RETRY_MS)).toBeLessThanOrEqual(30_000)
    expect(answersAgain(o, { status: 200, location: null, relayError: null, bodyOk: true })).toBe(true)
    // the relay's or a tunnel's page while the server is off: not back
    expect(answersAgain(o, { status: 503, location: null, relayError: 'team_offline', bodyOk: false })).toBe(false)
    expect(answersAgain(o, { status: 530, location: null, relayError: null, bodyOk: false })).toBe(false)
    for (const status of [502, 503, 504]) expect(answersAgain(o, { status, location: null, relayError: null, bodyOk: false })).toBe(false)
    // anything else is not the team server back: another page, a paused or renamed team, and a sleeping trial team
    // (the app's own look never wakes it)
    expect(answersAgain(o, { status: 404, location: null, relayError: null, bodyOk: false })).toBe(false)
    expect(answersAgain(o, { status: 200, location: null, relayError: null, bodyOk: false })).toBe(false)
    expect(answersAgain(o, { status: 403, location: null, relayError: 'team_suspended', bodyOk: false })).toBe(false)
    expect(answersAgain(o, { status: 308, location: `https://acme-corp.${TEAM_DOMAIN}/api/health`, relayError: null, bodyOk: false })).toBe(false)
    expect(answersAgain(o, { status: 503, location: null, relayError: 'team_waking', bodyOk: false })).toBe(false)
    for (const l of Object.keys(STRINGS) as UiLocale[]) expect(STRINGS[l]['offline.auto'].length).toBeGreaterThan(5)
    // it stops when the card is left, and the person's own Try again takes over
    const win = readFileSync(join(import.meta.dir, '../../desktop/src/main/app-window.ts'), 'utf8')
    expect(win).toMatch(/showWelcome\(\) \{\n\s+this\.stopOfflineWatch\(\)/)
    expect(win).toMatch(/private disposeTeam\(\) \{\n\s+clearInterval\(this\.recheckTimer\)\n\s+this\.stopOfflineWatch\(\)/)
    expect(win).toMatch(/leftOffline\(\) \{\n\s+this\.stopOfflineWatch\(\)/)
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
    const check = readFileSync(join(import.meta.dir, '../../desktop/src/common/address.ts'), 'utf8')
    expect(check).toMatch(/if \(!v\.ok && 'rename' in v\) return \{ ok: false, error: 'notTeamServer' \}/)
    expect(win).toMatch(/if \(origin !== p\.origin && !known\) return \{ ok: false, error: 'renamed'/)
    expect(t('ko', 'err.renamed', { host: 'acme-corp.trina.app' })).toBe('팀 주소가 acme-corp.trina.app(으)로 바뀌었어요. 새 주소로 연결할까요?')
  })
  test('the host strip: the sign-in pages, and every page until /api/me answers for a signed-in person; in punycode', () => {
    for (const p of ['/login', '/join', '/setup', '/invite/abc', '/reset-password/abc']) expect(isSignInPath(p)).toBe(true)
    for (const p of ['/', '/chats/1', '/invite', '/joined', '/settings/apps']) expect(isSignInPath(p)).toBe(false)
    const win = readFileSync(join(import.meta.dir, '../../desktop/src/main/app-window.ts'), 'utf8')
    expect(win).toContain('return !pageLine && hostLineNow({ path: this.pagePath, signedIn: this.signedIn, answered: this.meAnswered, waited: this.stripWaited })')
    // the same strip says "Trina is reading N files" while Find work files reads added files (never over the host line)
    expect(win).toContain('const top = this.hostLine() || this.reading ? HOSTBAR_HEIGHT : 0')
    // a team whose sign-in pages draw the address under the card (DesktopBridge.hostLine) gets no strip, only on the
    // sign-in paths, until another team is opened (owner 2026-11-15)
    expect(win).toContain('const pageLine = this.pageHostLine && isSignInPath(this.pagePath)')
    expect(win).toMatch(/this\.stripTimer = undefined\n\s*this\.pageHostLine = false/)
    // no jump on a signed-in open: the strip waits up to 300 ms for /api/me (a sign-in page shows it at once); a new
    // team page starts the wait again, and an answer (signed in or not) ends it
    expect(win).toContain('const HOSTBAR_WAIT_MS = 300')
    expect(win).toMatch(/if \(originOf\(url\) && !this\.meAnswered && !this\.stripWaited && !this\.stripTimer\) \{\n\s*this\.stripTimer = setTimeout\(\(\) => \{/)
    expect(win).toMatch(/this\.signedIn = false\n\s*this\.meAnswered = false\n\s*this\.stripWaited = false\n\s*clearTimeout\(this\.stripTimer\)/)
    expect(win).toMatch(/if \(signedIn === this\.signedIn && this\.meAnswered\) return\n\s*this\.signedIn = signedIn\n\s*this\.meAnswered = true/)
    // signed in only when /api/me answered with a person; a 401, another answer or a new team page start without
    expect(win).toMatch(/if \(res\.status === 401\) \{\n\s*if \(this\.team\?\.id === team\.id\) \{\n\s*this\.setSignedIn\(false\)/)
    expect(win).toContain('if (this.team?.id === team.id) this.setSignedIn(me.success)')
    expect(win).toMatch(/this\.pagePath = ''\n\s*this\.signedIn = false/)
    expect(hostOf('https://xn--bcher-kva.de')).toBe('xn--bcher-kva.de')
    expect(hostOf('http://acme.localhost:19883')).toBe('acme.localhost:19883')
    expect(parseTeamAddress('https://bücher.de')).toMatchObject({ ok: true, host: 'xn--bcher-kva.de' })
  })
  test('first-run links: the demo in every build; no plans in the Mac App Store build (App Review 3.1.1)', () => {
    const console = `https://${SERVICE_HOSTS.accountHost}`
    expect(createLinks({ macAppStore: false, console })).toEqual({ demo: 'https://demo.trina.app', pricing: 'https://ax.trina.app/pricing', console })
    expect(createLinks({ macAppStore: true, console })).toEqual({ demo: DEMO_URL, pricing: null, console })
    expect(PRICING_URL).toBe('https://ax.trina.app/pricing')
    // the store build's notices offer nothing that makes, starts or buys a team: no plans, no console, no resume, retry
    // or waiting list; opening an owned team stays
    for (const n of CREATE_NOTICES) {
      const a = noticeAction(n, true)
      expect(['plans', 'console', 'resume', 'retry', 'waitlist']).not.toContain(a as string)
    }
    expect(noticeAction('freeUsed', false)).toBe('plans')
    expect(noticeAction('freeUsed', true)).toBeNull()
    expect(noticeAction('hasTeam', true)).toBe('open')
    // the main process hides the create row, the console and the pricing link in the store build
    const main = readFileSync(join(import.meta.dir, '../../desktop/src/main/main.ts'), 'utf8')
    expect(main).toContain("ipcMain.on('ui:create-start', (e) => fromShell(e) && !storeScreens && createTeam?.start())")
    expect(main).toContain("kind === 'console' && !storeScreens ? links.console")
    expect(main).toContain('const storeScreens = process.mas === true || (dev && process.env.MYCEL_DESKTOP_TEST_STORE')
    const welcomeUi = readFileSync(join(import.meta.dir, '../../desktop/src/ui/welcome.ts'), 'utf8')
    expect(welcomeUi).toContain("const rows = () => state.offer === 'yes' && !state.store")
    // the create flow never sends a store sign-in's token to create, resume, retry or the waiting list
    const flow = readFileSync(join(import.meta.dir, '../../desktop/src/main/create-team.ts'), 'utf8')
    expect(flow).toContain("if (v.screen !== 'name' || v.busy || this.o.store) return")
    expect(flow).toContain('if (!team || this.o.store) return')
    expect(flow).toContain('if (this.o.store) return\n')
  })
  test('the console: the account host; a development run may name 127.0.0.1 over http or another https host', () => {
    const fallback = `https://${SERVICE_HOSTS.accountHost}`
    expect(consoleOrigin({ packaged: false, env: {} })).toBe(fallback)
    expect(consoleOrigin({ packaged: false, env: { MYCEL_CONSOLE_ORIGIN: 'http://127.0.0.1:19140' } })).toBe('http://127.0.0.1:19140')
    expect(consoleOrigin({ packaged: false, env: { MYCEL_CONSOLE_ORIGIN: 'https://console.example.test' } })).toBe('https://console.example.test')
    for (const bad of ['http://localhost:1', 'http://example.com', 'https://u:p@example.com', 'https://example.com/path', 'javascript:alert(1)', 'nope'])
      expect(consoleOrigin({ packaged: false, env: { MYCEL_CONSOLE_ORIGIN: bad } })).toBe(fallback)
    // a packaged app never takes it
    expect(consoleOrigin({ packaged: true, env: { MYCEL_CONSOLE_ORIGIN: 'http://127.0.0.1:19140' } })).toBe(fallback)
    // the console without the flow (404) keeps the first screen as it was; 401 offers it; anything else is not known
    expect(offerFromProbe(401)).toBe('yes')
    expect(offerFromProbe(404)).toBe('no')
    for (const s of [null, 200, 500, 502, 302]) expect(offerFromProbe(s)).toBe('unknown')
  })
  test('the owner claim address: the team own origin, exactly /app-setup#c=<43>, else nothing is opened', () => {
    const claim = 'Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWo'
    const team = 'https://acme.trina.app'
    expect(claimPage(`${team}/app-setup#c=${claim}`, team)).toBe(`/app-setup#c=${claim}`)
    for (const bad of [`https://evil.example/app-setup#c=${claim}`, `${team}/app-setup?x=1#c=${claim}`, `${team}/app-setup#c=${claim}&x=1`, `${team}/app-setup#c=${claim.slice(1)}`, `${team}/setup#c=${claim}`, `https://u:p@acme.trina.app/app-setup#c=${claim}`, 'garbage', ''])
      expect(claimPage(bad, team)).toBeNull()
    // an older team server's setup link: on the team's own origin only
    expect(oldSetupPage(`${team}/setup#t=abc`, team)).toBe('/setup#t=abc')
    expect(oldSetupPage('https://evil.example/setup#t=abc', team)).toBeNull()
    expect(oldSetupPage(undefined, team)).toBeNull()
  })
  test('the create screens: the plan lines, the steps, the address and each refusal its own line', () => {
    expect(freePlanLines({ maxActiveMembers: 3, maxConcurrency: 1, diskGB: 5, termsUrl: 'https://x.test/t', privacyUrl: 'https://x.test/p', termsVersion: '1' }).map((l) => l.key))
      .toEqual(['create.planMembers', 'create.planAnswers', 'create.planDisk', 'create.planSleeps'])
    expect(freePlanLines({ maxActiveMembers: null, maxConcurrency: 1, diskGB: 5, termsUrl: 'https://x.test/t', privacyUrl: 'https://x.test/p', termsVersion: '1' })[0]).toEqual({ key: 'create.planMembersAny' })
    expect(startSteps(0)).toEqual(['later', 'later', 'later'])
    expect(startSteps(2)).toEqual(['done', 'now', 'later'])
    expect(startSteps(4)).toEqual(['done', 'done', 'done'])
    expect(teamHost('acme')).toBe(`acme.${SERVICE_HOSTS.teamDomain}`)
    const lines = ['free_not_allowed', 'capacity_full', 'free_awake_limit', 'waitlist', 'network_limit', 'email_unverified', 'no_free_region'].map(noticeForError)
    expect(new Set(lines).size).toBe(lines.length)
    expect(lines).not.toContain('failed')
    expect(noticeForError('slug_unavailable')).toBeNull()
    expect(noticeForError('something_new')).toBe('failed')
    for (const l of Object.keys(STRINGS) as UiLocale[]) for (const n of ['notice.awakeLimit', 'notice.capacityFull'] as const) expect(STRINGS[l][n]).not.toMatch(/mail/i)
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
    // a link from outside never points the app at this machine, http or https (typed addresses still may: development)
    for (const inner of ['http://127.0.0.1:19100/invite/K-PTTVic_Q_pfdW4-06s4zsJJlKEInlO2rHLV9HryGk', 'https://127.0.0.1:19100/', 'http://localhost:19100/', 'https://localhost/', 'http://acme.localhost:19883/', 'https://[::1]:8443/', 'https://127.1/',
      // an IPv4-mapped or IPv4-compatible loopback, the unspecified addresses (they reach this machine too)
      'https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]:8443/', 'https://[::127.0.0.1]/', 'https://[::]/', 'https://0.0.0.0/', 'https://0/', 'https://[::ffff:0.0.0.0]/'])
      expect(readDesktopLink(link(inner))).toEqual({ ok: false, error: 'insecure' })
    expect(parseTeamAddress('http://127.0.0.1:19100')).toMatchObject({ ok: true, dev: true })
  })
  test('a crafted link cannot load http to another machine, javascript:, file:, data:, user:password, or hide its host', () => {
    expect(readDesktopLink(link('http://evil.example'))).toEqual({ ok: false, error: 'insecure' })
    expect(readDesktopLink(link(`https://${TEAM_DOMAIN}@evil.example`))).toEqual({ ok: false, error: 'credentials' })
    expect(readDesktopLink(link(`https://acme.${TEAM_DOMAIN}:x@evil.example`))).toEqual({ ok: false, error: 'credentials' })
    for (const inner of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<script>x</script>', 'acme', `acme.${TEAM_DOMAIN}`, 'https://a b'])
      expect(readDesktopLink(link(inner))).toBeNull()
    // the host ④ shows is the URL parser's: a numeric trick for this machine is refused, a backslash ends the host,
    // another numeric address is shown as numbers and never counts as hosted
    expect(readDesktopLink(link('https://0x7f.1/'))).toEqual({ ok: false, error: 'insecure' })
    expect(readDesktopLink(link('https://2130706433/'))).toEqual({ ok: false, error: 'insecure' })
    expect(readDesktopLink(link('https://0xc0a8000a/'))).toMatchObject({ ok: true, host: '192.168.0.10', hosted: false })
    expect(readDesktopLink(link(`https://evil.example\\@acme.${TEAM_DOMAIN}`))).toMatchObject({ ok: true, host: 'evil.example', hosted: false })
    expect(readDesktopLink(link(`https://acme.${TEAM_DOMAIN}.evil.example/join#t=0INpvAqjFG3OhdmwH4CfCuxr-mz7rx3dLOr1tEwbB7E`))).toMatchObject({ ok: true, host: `acme.${TEAM_DOMAIN}.evil.example`, hosted: false })
    expect(readDesktopLink(link('https://xn--bcher-kva.de'))).toMatchObject({ host: 'xn--bcher-kva.de' })
    // the link itself: only open?url=<one address>
    for (const raw of [`${LINK_SCHEME}://evil?url=${enc('https://acme.trina.app')}`, `${LINK_SCHEME}://open?url=a&url=b`, `${LINK_SCHEME}://open?url=${enc('https://acme.trina.app')}&next=/x`,
      `${LINK_SCHEME}://open?url=${enc('https://acme.trina.app')}#x`, `${LINK_SCHEME}://u:p@open?url=${enc('https://acme.trina.app')}`, `${LINK_SCHEME}://open:99?url=${enc('https://acme.trina.app')}`,
      `${LINK_SCHEME}://open/x?url=${enc('https://acme.trina.app')}`, `other://open?url=${enc('https://acme.trina.app')}`, `https://acme.${TEAM_DOMAIN}/join#t=0INpvAqjFG3OhdmwH4CfCuxr-mz7rx3dLOr1tEwbB7E`, 'x'.repeat(5000)])
      expect(readDesktopLink(raw)).toBeNull()
  })
  test('a link that starts the closed app opens its page on a known team, else it is left to screen 4', () => {
    const team = `https://acme.${TEAM_DOMAIN}`
    const id = '019a5c3e-7b2d-7c11-9f00-3a1b2c3d4e5f'
    const teams = [{ id: 't1', origin: `https://other.${TEAM_DOMAIN}` }, { id: 't2', origin: team }]
    const raw = (inner: string) => `${LINK_SCHEME}://open?url=${encodeURIComponent(inner)}`
    expect(startupLinkTarget(raw(`${team}/c/${id}`), teams)).toEqual({ id: 't2', path: `/c/${id}` })
    expect(startupLinkTarget(raw(`${team}/rooms/${id}?m=${id}`), teams)).toEqual({ id: 't2', path: `/rooms/${id}?m=${id}` })
    expect(startupLinkTarget(raw(`https://new.${TEAM_DOMAIN}/c/${id}`), teams)).toBeNull()
    expect(startupLinkTarget(raw(team), teams)).toBeNull()
    expect(startupLinkTarget(raw(`${team}/settings`), teams)).toBeNull()
    expect(startupLinkTarget(null, teams)).toBeNull()
    expect(startupLinkTarget(raw(`${team}/c/${id}`), [])).toBeNull()
    // the link as it comes on a command line
    expect(startupLinkTarget(linkFromArgv(['/opt/app', '--no-sandbox', raw(`${team}/c/${id}`)]), teams)?.id).toBe('t2')
  })
  test('a chat, room or project page inside the link (QA TC-2266): fixed routes with id-shaped parts only', () => {
    const team = `https://acme.${TEAM_DOMAIN}`
    const id = '019a5c3e-7b2d-7c11-9f00-3a1b2c3d4e5f'
    const page = (inner: string) => desktopPagePath(link(inner))
    expect(page(`${team}/c/${id}`)).toEqual({ origin: team, path: `/c/${id}` })
    expect(page(`${team}/c/${id}/`)).toEqual({ origin: team, path: `/c/${id}` })
    expect(page(`${team}/rooms/${id}`)).toEqual({ origin: team, path: `/rooms/${id}` })
    expect(page(`${team}/rooms/${id}/t/${id}?m=${id}`)).toEqual({ origin: team, path: `/rooms/${id}/t/${id}?m=${id}` })
    expect(page(`${team}/projects/${id}`)).toEqual({ origin: team, path: `/projects/${id}` })
    expect(page(`https://team.example.com/c/${id}`)).toEqual({ origin: 'https://team.example.com', path: `/c/${id}` })
    // the host part is the URL parser's (lower case, no default port)
    expect(page(`https://ACME.${TEAM_DOMAIN}:443/c/${id}`)).toEqual({ origin: team, path: `/c/${id}` })
    // a query and fragment are dropped, except a room's one ?m=<id>
    expect(page(`${team}/c/${id}?next=https://evil.example#x`)).toEqual({ origin: team, path: `/c/${id}` })
    expect(page(`${team}/c/${id}?m=${id}`)).toEqual({ origin: team, path: `/c/${id}` })
    expect(page(`${team}/rooms/${id}?m=${id}&x=1`)).toEqual({ origin: team, path: `/rooms/${id}` })
    expect(page(`${team}/rooms/${id}?m=..%2Fadmin`)).toEqual({ origin: team, path: `/rooms/${id}` })
    // the join pages keep their own path (④ asks first); a page that is not one of these opens the team's start
    expect(page(`${team}/join#t=0INpvAqjFG3OhdmwH4CfCuxr-mz7rx3dLOr1tEwbB7E`)).toBeNull()
    for (const path of ['/', '', '/settings', '/admin/people', '/files', '/files/view?path=a', '/c', '/c/', '/rooms', '/projects/x/files', '/skills', '/login', '/c/a/b', `/c/${'a'.repeat(65)}`,
      // encoded and normalized tricks: the path must be written as the parser reads it, ids are [A-Za-z0-9_-]
      '//evil.example/c/x', '//c/x', '/c//x', '/c/x/../../admin', `/c/../c/${id}`, `/c/./${id}`, '/c/%2e%2e', '/c/%2Fevil.example', '/c/x%00', '/c/x%0a', '/c/a.b', '/c/a@evil.example',
      '/c/x\\..\\admin', '\\evil.example/c/x', '/c/\u0000x', '/c/x\ty', '/c/x\ny', '/c/ｘ', '/c/x;y', '/c/x:y', '/C/x', '/rooms/x/t/', '/rooms/x/t/y/z'])
      expect(page(team + path)).toBeNull()
    // nothing that readDesktopLink refuses: another scheme, http, user:password, this machine, a host hidden by a backslash
    for (const inner of [`http://acme.${TEAM_DOMAIN}/c/${id}`, `https://u:p@acme.${TEAM_DOMAIN}/c/${id}`, `https://${TEAM_DOMAIN}@evil.example/c/${id}`, `https://127.0.0.1/c/${id}`, `https://localhost/c/${id}`,
      `javascript:alert(1)//acme.${TEAM_DOMAIN}/c/${id}`, `file:///c/${id}`, `data:text/html,/c/${id}`, `//evil.example/c/${id}`])
      expect(page(inner)).toBeNull()
    // a backslash ends the host (evil.example), and that page path is then not written as the parser reads it
    expect(page(`https://evil.example\\@acme.${TEAM_DOMAIN}/c/${id}`)).toBeNull()
    expect(desktopPagePath(`${LINK_SCHEME}://open?url=${enc(`${team}/c/${id}`)}&next=/x`)).toBeNull()
    expect(desktopPagePath(`other://open?url=${enc(`${team}/c/${id}`)}`)).toBeNull()
    expect(desktopPagePath(`${team}/c/${id}`)).toBeNull()
  })
  test('the page opens only on a team the app already has, by exact origin; any other link goes to ④', () => {
    const win = readFileSync(join(import.meta.dir, '../../desktop/src/main/app-window.ts'), 'utf8')
    const opener = win.slice(win.indexOf('  private openLinkedPage(raw: string): boolean {'), win.indexOf('  /** The create screens changed'))
    expect(opener).toContain('const page = desktopPagePath(raw)')
    expect(opener).toContain('this.teams.teams.find((x) => x.origin === page.origin)')
    expect(opener).toContain('if (!page || !known) return false')
    expect(opener).not.toMatch(/addTeam|fetch|loadURL/)
    // (then a Google sign-in's code for the team on screen, which loads only that window: docs/decisions/20261122-google-login-apps.md)
    expect(win).toMatch(/offerLink\(raw: string\) \{\n\s*if \(this\.openLinkedPage\(raw\)\) return\n(?:\s*\/\/.*\n)*\s*const google = this\.app \? googleSignInCode\(raw, \[this\.team\?\.origin, this\.currentOrigin\]\) : null\n\s*if \(google\) return void this\.openGoogleReturn\(google\)\n\s*const p = readDesktopLink\(raw\)/)
  })
  test('the one-time sign-in link (web "Continue in the Mac app") opens its page; only in a link from outside', () => {
    const code = 'Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWo'
    expect(code).toHaveLength(43)
    const team = `https://acme.${TEAM_DOMAIN}`
    expect(readDesktopLink(link(`${team}/app-signin#c=${code}`))).toMatchObject({ ok: true, host: `acme.${TEAM_DOMAIN}`, hosted: true, entryPath: `/app-signin#c=${code}` })
    // the code's shape: newToken exactly, the code alone in the fragment, no query
    for (const inner of [`${team}/app-signin#c=${code}x`, `${team}/app-signin#c=${code.slice(1)}`, `${team}/app-signin#c=${code}&x=1`, `${team}/app-signin?c=${code}`, `${team}/app-signin?x=1#c=${code}`, `${team}/app-signin`])
      expect(readDesktopLink(link(inner))).toEqual({ ok: false, error: 'link' })
    // the outer link with a fragment of its own is no link (the code must be inside url=)
    expect(readDesktopLink(`${link(`${team}/app-signin`)}#c=${code}`)).toBeNull()
    // never this machine, never http
    expect(readDesktopLink(link(`https://127.0.0.1/app-signin#c=${code}`))).toEqual({ ok: false, error: 'insecure' })
    expect(readDesktopLink(link(`http://acme.${TEAM_DOMAIN}/app-signin#c=${code}`))).toEqual({ ok: false, error: 'insecure' })
    // the first-run box refuses it (typed or pasted), so a code never opens the team's start in its place
    expect(parseTeamAddress(`${team}/app-signin#c=${code}`)).toEqual({ ok: false, error: 'invalid' })
    // it is never a page link (opened at once without ④): it always goes through ④
    expect(desktopPagePath(link(`${team}/app-signin#c=${code}`))).toBeNull()
    // the "renamed" answer's next address goes back through the box: the team's start then
    expect(retypablePath(`/app-signin#c=${code}`)).toBe('/')
    expect(retypablePath('/invite/abc')).toBe('/invite/abc')
    // an update restart never opens it again
    expect(resumePage('t1', `${team}/app-signin#c=${code}`, [team])).toBeNull()
    expect(resumePage('t1', `${team}/app-signin`, [team])).toBeNull()
    // the address shows on that page in the app
    expect(isSignInPath('/app-signin')).toBe(true)
    // a page that failed to load is logged without its fragment
    const win = readFileSync(join(import.meta.dir, '../../desktop/src/main/app-window.ts'), 'utf8')
    expect(win).toContain("debug('team page failed to load', code, url.split('#')[0])")
  })
  test('a new team owner setup page (/app-setup#c=<claim>) is never read from a link: only the create flow opens it', () => {
    const claim = 'Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWo'
    const team = `https://acme.${TEAM_DOMAIN}`
    // a claim in a link would make whoever opens it the owner of the sender's team, signed in as them
    expect(readDesktopLink(link(`${team}/app-setup#c=${claim}`))).toEqual({ ok: false, error: 'invalid' })
    for (const inner of [`${team}/app-setup#c=${claim}x`, `${team}/app-setup#c=${claim.slice(1)}`, `${team}/app-setup#c=${claim}&x=1`, `${team}/app-setup?c=${claim}`, `${team}/app-setup?x=1#c=${claim}`, `${team}/app-setup`, `${team}/APP-SETUP/#c=${claim}`])
      expect(readDesktopLink(link(inner))).toEqual({ ok: false, error: 'invalid' })
    // the sign-in link still works from outside
    expect(readDesktopLink(link(`${team}/app-signin#c=${claim}`))).toMatchObject({ ok: true, entryPath: `/app-signin#c=${claim}` })
    expect(readDesktopLink(`${link(`${team}/app-setup`)}#c=${claim}`)).toBeNull()
    expect(readDesktopLink(link(`http://acme.${TEAM_DOMAIN}/app-setup#c=${claim}`))).toEqual({ ok: false, error: 'insecure' })
    // the first-run box refuses it, typed or pasted
    expect(parseTeamAddress(`${team}/app-setup#c=${claim}`)).toEqual({ ok: false, error: 'invalid' })
    expect(desktopPagePath(link(`${team}/app-setup#c=${claim}`))).toBeNull()
    expect(retypablePath(`/app-setup#c=${claim}`)).toBe('/')
    // an update restart never opens it again; the address shows on it
    expect(resumePage('t1', `${team}/app-setup#c=${claim}`, [team])).toBeNull()
    expect(resumePage('t1', `${team}/APP-SETUP`, [team])).toBeNull()
    expect(isSignInPath('/app-setup')).toBe(true)
    // the create flow never logs the claim address: only the team origin
    const flow = readFileSync(join(import.meta.dir, '../../desktop/src/main/create-team.ts'), 'utf8')
    expect(flow).toContain("debug('create: opening the new team', origin)")
    expect(flow.match(/debug\(/g)?.length).toBe(1)
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
    expect(main).toMatch(/app\.on\('open-url', \(e, url\) => \{\n\s*e\.preventDefault\(\)\n\s*linkLog\('open-url', url\)\n\s*onLink\(url\)/)
    expect(main).toMatch(/const link = linkFromArgv\(argv\)\n\s*linkLog\('second-instance', link\)\n\s*if \(link\) onLink\(link\)/)
    // onLink and the launch link reach the window only through offerLink
    const onLink = main.slice(main.indexOf('function onLink('), main.indexOf("if (primary) app.on('open-url'"))
    expect(onLink).toContain('win.offerLink(url)')
    expect(onLink).not.toMatch(/addTeam|openTeam|loadURL/)
    // offerLink fetches nothing; answerLink connects only with the gate's offer
    const offer = win.slice(win.indexOf('  offerLink(raw: string) {'), win.indexOf('  async answerLink('))
    expect(offer).not.toMatch(/fetch|addTeam|openTeam|loadURL/)
    // a link to the start of the team on screen (a Google sign-in's "Back to the app") only brings the window forward
    expect(offer).toMatch(/if \(this\.app && this\.mode !== 'offline' && isShownTeamStart\(raw, this\.team\?\.origin\)\) return\n/)
    expect(win).toMatch(/const offer = this\.linkGate\.answer\(yes, host, Date\.now\(\)\)[\s\S]{0,200}if \(!offer\) return null[\s\S]{0,300}return this\.addTeam\(offer\.origin, true, offer\.entryPath\)/)
    // ④ counts from when the screen says it is up, and a team view taking over drops a waiting link
    expect(win).toContain('this.linkGate.shown(id, Date.now())')
    expect(win).toMatch(/async openTeam\(id: string, entryPath = '\/', o: \{ startup\?: boolean \} = \{\}\) \{[\s\S]{0,300}this\.linkGate\.clear\(\)/)
    const welcome = readFileSync(join(import.meta.dir, '../../desktop/src/ui/welcome.ts'), 'utf8')
    expect(welcome).toContain('ui.welcome.linkShown(link.id)')
    // [연결] is off until ④ has been on screen as long as the gate wants (no click that silently does nothing)
    expect(welcome).toContain('const LINK_READY_MS = 650')
    expect(welcome).toContain('disabled: busy || !linkReady,')
    // a development run never takes the scheme over by itself
    // (and on Linux only the .deb: common/linux.ts registersLinkHandler, tests/unit/e-desktop-linux.test.ts)
    expect(main).toContain("if (primary && registersLinkHandler(linuxStart)) app.setAsDefaultProtocolClient(LINK_SCHEME)")
    expect(main).toContain("const linuxStart = { platform: process.platform, packaged: app.isPackaged, env: process.env }")
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
  test('the Windows uninstaller removes the link handler the app wrote, only when it points into the install folder (QA TC-383)', async () => {
    const base = (await import('../../desktop/electron-builder.config')).default as { directories: { buildResources: string }; nsis: { include?: string; perMachine?: boolean } }
    // named, so a missing file fails the build; per-user install stays (the app writes the handler under HKCU)
    expect(base.nsis.include).toBe('installer.nsh')
    expect(base.nsis.perMachine).toBe(false)
    const nsh = readFileSync(join(import.meta.dir, '../../desktop', base.directories.buildResources, base.nsis.include!), 'utf8')
    const code = nsh.split('\n').filter((l) => !l.trimStart().startsWith(';')).join('\n')
    // the one scheme the app registers (every setAsDefaultProtocolClient call in the main process uses LINK_SCHEME)
    expect(LINK_SCHEME).toBe(PRODUCT.linkScheme)
    expect(code).toContain(`!define MYCEL_LINK_SCHEME "${PRODUCT.linkScheme}"`)
    const main = readFileSync(join(import.meta.dir, '../../desktop/src/main/main.ts'), 'utf8')
    const calls = main.match(/setAsDefaultProtocolClient\([^,)]+/g) ?? []
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c).toBe('setAsDefaultProtocolClient(LINK_SCHEME')
    // electron-builder inserts customUnInstall into the uninstall section; an update (old uninstaller, --updated) keeps the key
    const macro = code.match(/!macro customUnInstall\n([\s\S]*?)!macroend/)?.[1] ?? ''
    expect(macro).toMatch(/^\s*\$\{ifNot\} \$\{isUpdated\}\n/)
    expect(macro).toContain('ReadRegStr $0 HKCU "Software\\Classes\\${MYCEL_LINK_SCHEME}\\shell\\open\\command" ""')
    // the command must start with "<install dir>\ (Electron writes "<exe>" "%1"), or the key is someone else's and stays
    expect(macro).toContain('StrCpy $1 "$\\"$INSTDIR\\"')
    expect(macro).toMatch(/StrLen \$2 \$1\n\s*StrCpy \$3 \$0 \$2\n\s*\$\{if\} \$3 == \$1\n\s*DeleteRegKey HKCU "Software\\Classes\\\$\{MYCEL_LINK_SCHEME\}"\n\s*\$\{endIf\}/)
    // exactly one delete, of that key only; registers the uninstaller still uses come back as they were
    expect(code.match(/DeleteRegKey|DeleteRegValue/g)).toEqual(['DeleteRegKey'])
    for (const r of ['$0', '$1', '$2', '$3']) expect(macro.indexOf(`Push ${r}`)).toBeLessThan(macro.indexOf(`Pop ${r}`))
  })
  test('④ strings name the host and never the page', () => {
    expect(t('ko', 'link.title', { host: 'acme.trina.app' })).toBe('acme.trina.app에 연결할까요?')
    expect(t('ko', 'link.body')).toBe('직접 받은 링크가 맞을 때만 연결하세요.')
  })
})

describe('Sign in with Google: the code comes back for the team on screen (docs/decisions/20261122-google-login-apps.md)', () => {
  const code = 'Abc_def-0123456789abcdefghijklmnopqrstuvwxy'
  const team = `https://acme.${TEAM_DOMAIN}`
  const lan = 'https://192.168.1.20:8443'
  const link = (inner: string, fragment = `#code=${code}`) => `${LINK_SCHEME}://open?${new URLSearchParams({ url: inner })}${fragment}`
  test('the team page /login/google with the code only in the fragment, for the team on screen', () => {
    expect(code).toHaveLength(43)
    expect(googleSignInCode(link(`${team}/login/google`), [team, team])).toBe(code)
    // the window shows the office address: the link still names the team address Google returned to
    expect(googleSignInCode(link(`${team}/login/google`), [team, lan])).toBe(code)
    // another team, or no team on screen
    expect(googleSignInCode(link(`https://other.${TEAM_DOMAIN}/login/google`), [team, team])).toBeNull()
    expect(googleSignInCode(link(`${team}/login/google`), [null, undefined])).toBeNull()
  })
  test('nothing else: another page, a query, the code in the query, a short code, a second key, plain http', () => {
    for (const raw of [
      link(`${team}/`), link(`${team}/login`), link(`${team}/login/google/`), link(`${team}/login/google?x=1`),
      link(`${team}/login/google#code=${code}`, ''), link(`${team}/login/google`, '#code=short'),
      link(`${team}/login/google`, `#code=${code}&next=/x`), link(`${team}/LOGIN/GOOGLE`),
      link(`http://acme.${TEAM_DOMAIN}/login/google`), link('https://127.0.0.1:8443/login/google'),
      `${LINK_SCHEME}://open?url=${encodeURIComponent(`${team}/login/google`)}&x=1#code=${code}`,
      `other://open?${new URLSearchParams({ url: `${team}/login/google` })}#code=${code}`,
    ]) expect(googleSignInCode(raw, [team, team])).toBeNull()
  })
  test('the link goes the usual way otherwise; an update restart never reopens the page; the bridge says it can', () => {
    // read as a link it is a bad one (a fragment on the app link): never a team load through screen ④
    expect(readDesktopLink(link(`${team}/login/google`))).toBeNull()
    expect(resumePage('t1', `${team}/login/google`, [team])).toBeNull()
    expect(resumePage('t1', `${team}/login`, [team])).toEqual({ teamId: 't1', path: '/login' })
    const main = readFileSync(join(import.meta.dir, '../../desktop/src/main/main.ts'), 'utf8')
    expect(main.slice(main.indexOf("ipcMain.on('bridge:info'"), main.indexOf("ipcMain.handle('bridge:browser-run'"))).toContain('googleSignIn: GOOGLE_SIGNIN_BRIDGE_VERSION')
    const preload = readFileSync(join(import.meta.dir, '../../desktop/src/preload/app.ts'), 'utf8')
    expect(preload).toContain('...(info?.googleSignIn ? { googleSignIn: info.googleSignIn } : {})')
    // the window opens the page itself, at the address it shows, before any other reading of the link; never logs the code
    const win = readFileSync(join(import.meta.dir, '../../desktop/src/main/app-window.ts'), 'utf8')
    const offer = win.slice(win.indexOf('  offerLink(raw: string) {'), win.indexOf('  /** ④ is on screen for this offer'))
    expect(offer.indexOf('googleSignInCode(raw, [this.team?.origin, this.currentOrigin])')).toBeGreaterThan(0)
    expect(offer.indexOf('googleSignInCode(')).toBeLessThan(offer.indexOf('readDesktopLink(raw)'))
    const open = win.slice(win.indexOf('  private openGoogleReturn(code: string) {'), win.indexOf("  /** The host strip's state:"))
    expect(open).toContain('const app = this.app, origin = this.currentOrigin || this.team?.origin')
    expect(open).toContain('loadURL(`${origin}${GOOGLE_APP_RETURN_PATH}#code=${code}`)')
    expect(open).not.toMatch(/handoffLog\([^)]*\$\{code\}/)
    expect(open).not.toMatch(/fetch|addTeam|openTeam/)
  })
})

describe('a first start on a Mac that ran a dev build (0.5.7 DMG opened on localhost:19100)', () => {
  test('a development run keeps its own settings folder; the installed app keeps the old name', () => {
    expect(dataDirName(PRODUCT.desktopDataDir, true)).toBe(PRODUCT.desktopDataDir)
    expect(dataDirName(PRODUCT.desktopDataDir, false)).not.toBe(PRODUCT.desktopDataDir)
    expect(dataDirName('Team AX', false)).toBe('Team AX (dev)')
  })
  test('a team on this computer falls back to the team list at start; a real team does not', () => {
    for (const o of ['http://localhost:19100', 'http://acme.localhost:19161', 'http://LOCALHOST:19100', 'https://localhost']) expect({ o, r: onThisComputer(o) }).toEqual({ o, r: true })
    // the Office Mac's own server (scripts/install-macos.sh, 127.0.0.1:47820) is a real team that may still be starting
    for (const o of ['http://127.0.0.1:47820', 'http://127.0.0.1:19100', 'http://[::1]:19100', 'https://acme.trina.app', 'https://qa.trina.app', 'https://192.168.1.5:8443', 'https://mini.local:8443', 'not a url', '']) expect({ o, r: onThisComputer(o) }).toEqual({ o, r: false })
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

  test('the person\'s "Allow all websites" on the team server (Me.user.webAllowAll): followed both ways', () => {
    // on from the server opens every public site in this browser too, while the team allows it (docs/DECISIONS.md
    // "Always allow on every card")
    const p = new SitePermissions()
    expect(p.setPersonPolicy(true)).toBe(true)
    expect(p.siteAccess).toBe('all')
    expect(p.isAllowed('site', 'shop.test')).toBe(true)
    expect(p.isAllowed('private', 'nas.local')).toBe(false) // office-network addresses still ask
    expect(p.setPersonPolicy(true)).toBe(false) // the same value again: nothing to save
    expect(p.toJSON()).toEqual({ always: [], privateAlways: [], siteAccess: 'all', teamAllowsAll: true, personAllowsAll: true })
    // the team does not allow "all": on from the server leaves it asking
    const off = new SitePermissions()
    off.setTeamPolicy(false)
    expect(off.setPersonPolicy(true)).toBe(true)
    expect(off.siteAccess).toBe('ask')
    // turned off elsewhere (Settings on the web, the team): back to ask
    expect(p.setPersonPolicy(false)).toBe(true)
    expect(p.siteAccess).toBe('ask')
    expect(p.toJSON()).toEqual({ always: [], privateAlways: [], siteAccess: 'ask', teamAllowsAll: true })
    // an "all" saved before the server value existed (or never seen on): an absent or false value does not narrow it
    const legacy = new SitePermissions({ always: [], privateAlways: [], siteAccess: 'all' })
    expect(legacy.setPersonPolicy(false)).toBe(false)
    expect(legacy.siteAccess).toBe('all')
    // the last value survives a restart: an off that comes after it still narrows
    const seen = new SitePermissions({ siteAccess: 'all', personAllowsAll: true })
    const restarted = new SitePermissions(JSON.parse(JSON.stringify(seen.toJSON())))
    expect(restarted.toJSON()).toMatchObject({ siteAccess: 'all', personAllowsAll: true })
    expect(restarted.setPersonPolicy(false)).toBe(true)
    expect(restarted.siteAccess).toBe('ask')
    // junk in the file is "not seen on"
    expect(new SitePermissions({ siteAccess: 'all', personAllowsAll: 'yes' as never }).setPersonPolicy(false)).toBe(false)
    // another person signing in forgets it
    const other = new SitePermissions({ siteAccess: 'all', personAllowsAll: true })
    other.resetForNewPerson()
    expect(other.toJSON()).not.toHaveProperty('personAllowsAll')
  })

  test('the window applies GET /api/me (common/me-policy.ts, AppWindow.fetchTeamInfo): an off narrows, an on widens, an older server changes nothing', () => {
    const p = new SitePermissions({ always: [], privateAlways: [] })
    const pane = { setTeamPolicy: (v: boolean) => { p.setTeamPolicy(v) }, setPersonPolicy: (v: boolean) => { p.setPersonPolicy(v) } }
    // the person turned it on here (the app's window) and on the server
    expect(p.setSiteAccess('all')).toBe(true)
    applyMePolicy(pane, { team: { browserAllowAll: true }, user: { webAllowAll: true } })
    expect(p.siteAccess).toBe('all')
    // switched off elsewhere: this browser asks again
    applyMePolicy(pane, { team: { browserAllowAll: true }, user: {} })
    expect(p.siteAccess).toBe('ask')
    // on again on the server: this browser opens every site again
    applyMePolicy(pane, { team: { browserAllowAll: true }, user: { webAllowAll: true } })
    expect(p.siteAccess).toBe('all')
    // a browser set to "all" here with the server value never on (older server, or before this release): left as it is
    const q = new SitePermissions({ always: [], privateAlways: [], siteAccess: 'all' })
    applyMePolicy({ setTeamPolicy: (v) => { q.setTeamPolicy(v) }, setPersonPolicy: (v) => { q.setPersonPolicy(v) } }, { team: {}, user: {} })
    expect(q.siteAccess).toBe('all')
    // the team's policy off still turns it back
    applyMePolicy({ setTeamPolicy: (v) => { q.setTeamPolicy(v) }, setPersonPolicy: (v) => { q.setPersonPolicy(v) } }, { team: { browserAllowAll: false }, user: {} })
    expect(q.siteAccess).toBe('ask')
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
    const acme = 'https://acme.treesoop.com'
    expect(isTrustedAppSender({ url: 'https://acme.treesoop.com/chats/1', origin: acme, isTop: true, isAppView: true }, origins)).toBe(true)
    expect(isTrustedAppSender({ url: 'https://127.0.0.1:8443/', origin: 'https://127.0.0.1:8443', isTop: true, isAppView: true }, origins)).toBe(true)
    expect(isTrustedAppSender({ url: 'https://acme.treesoop.com/', origin: acme, isTop: false, isAppView: true }, origins)).toBe(false)
    expect(isTrustedAppSender({ url: 'https://acme.treesoop.com/', origin: acme, isTop: true, isAppView: false }, origins)).toBe(false)
    expect(isTrustedAppSender({ url: 'https://evil.treesoop.com/', origin: 'https://evil.treesoop.com', isTop: true, isAppView: true }, origins)).toBe(false)
    expect(isTrustedAppSender({ url: 'about:srcdoc', origin: acme, isTop: true, isAppView: true }, origins)).toBe(false)
    expect(isTrustedAppSender(null, origins)).toBe(false)
  })

  test('a page at the team address whose document has an opaque origin (a sandbox CSP: /sandbox/frame as the whole page) is not trusted (QA TC-220)', () => {
    expect(isTrustedAppSender({ url: 'https://acme.treesoop.com/sandbox/frame', origin: 'null', isTop: true, isAppView: true }, origins)).toBe(false)
    // the URL and the document must agree; an unknown or empty document origin fails closed
    expect(isTrustedAppSender({ url: 'https://acme.treesoop.com/', origin: 'https://127.0.0.1:8443', isTop: true, isAppView: true }, origins)).toBe(false)
    expect(isTrustedAppSender({ url: 'https://acme.treesoop.com/', origin: '', isTop: true, isAppView: true }, origins)).toBe(false)
    expect(isTrustedAppSender({ url: 'https://acme.treesoop.com/', origin: '://', isTop: true, isAppView: true }, origins)).toBe(false)
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
    for (const l of ['en', 'id', 'ja', 'es', 'zh'] as const) expect(Object.keys(STRINGS[l]).sort()).toEqual(keys)
    for (const l of ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const) for (const k of keys) expect((STRINGS[l] as Record<string, string>)[k].length).toBeGreaterThan(0)
  })

  test('placeholders are the same in every language', () => {
    // a count's name too ("{n, plural, one {# more question} other {# more questions}}" next to Korean "{n}개")
    const ph = (s: string) => [...pluralNames(s).map((n) => `{${n}}`), ...(s.replace(PLURAL_PATTERN, '').match(/\{\w+\}/g) ?? [])].sort().join(',')
    for (const k of Object.keys(STRINGS.ko) as (keyof typeof STRINGS.ko)[]) {
      expect(ph(STRINGS.en[k])).toBe(ph(STRINGS.ko[k]))
      expect(ph(STRINGS.id[k])).toBe(ph(STRINGS.ko[k]))
      expect(ph(STRINGS.ja[k])).toBe(ph(STRINGS.en[k]))
      expect(ph(STRINGS.es[k])).toBe(ph(STRINGS.en[k]))
      expect(ph(STRINGS.zh[k])).toBe(ph(STRINGS.en[k]))
    }
  })

  test('locale choice and formatting: English unless the team page or the person said otherwise', () => {
    expect(DEFAULT_UI_LOCALE).toBe('en')
    expect(asUiLocale('ko-KR')).toBe('ko')
    expect(asUiLocale('in')).toBe('id')
    expect(asUiLocale('ja-JP')).toBe('ja')
    expect(asUiLocale('es-MX')).toBe('es')
    for (const tag of ['zh', 'zh-CN', 'zh-Hans', 'zh-SG', 'zh-TW', 'zh-HK', 'zh_Hans_CN']) expect(asUiLocale(tag)).toBe('zh')
    expect(asUiLocale('fr-FR')).toBeNull()
    expect(asUiLocale({ locale: 'ko' })).toBeNull()
    expect(asUiLocale('ko'.padEnd(40, 'x'))).toBeNull()
    expect(UI_LOCALES.map((l) => l.label)).toEqual(['English', '한국어', 'Bahasa Indonesia', '日本語', 'Español', '简体中文'])
    for (const l of ['en', 'id', 'ja', 'es', 'zh'] as const) for (const [k, v] of Object.entries(STRINGS[l])) expect({ l, k, korean: /[\uAC00-\uD7A3]/.test(v) }).toEqual({ l, k, korean: false })
    expect(t('en', 'perm.site.title', { host: 'shop.test' })).toBe('The AI wants to use shop.test')
    expect(t('zh', 'perm.site.title', { host: 'shop.test' })).toBe('AI 想要使用shop.test')
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
    // the in-app browser pane does not get this answer: there file choosers are intercepted only while the AI drives
    // (file_upload takes the one its click opens, any other is closed: docs/decisions/20261126-browser-file-upload.md)
    // and the person's own clicks open the system's picker as before
    const pane = readFileSync(join(import.meta.dir, '../../desktop/src/main/pane/pane.ts'), 'utf8')
    expect(pane).not.toContain('showOpenDialog')
    // on: intercept() and a frame of another site attached while it is on; off: stopIntercepting(). Never answered with
    // a dialog of the app's own
    const turns = [...pane.matchAll(/'Page\.setInterceptFileChooserDialog', \{ enabled: (\w+)[^}]*\}/g)].map((m) => m[1])
    expect(turns.filter((x) => x === 'false').length).toBe(2)
    expect(turns.length).toBe(5)
    expect(pane).toContain('if (this.driving === 0) this.stopIntercepting()')
  })
})

describe('the right-click menu (team page and own screens)', () => {
  const TEAM = 'https://acme.example.com'
  const none = { canCut: false, canCopy: false, canPaste: false, canSelectAll: false }
  const at = (o: Partial<ContextFacts> = {}): ContextFacts => ({ mediaType: 'none', srcURL: '', hasImageContents: false, linkURL: '', selectionText: '', isEditable: false, editFlags: none, ...o })
  /** on the team page itself, unless `where` says otherwise */
  const items = (o: Partial<ContextFacts>, locale: UiLocale = 'ko', where: { teamPage: boolean; allowedOrigins: string[] } = { teamPage: true, allowedOrigins: [TEAM] }) => contextMenuItems(at(o), locale, where)
  /** each item as one word: its action (with "-" when greyed out) or "|" for a line */
  const shape = (list: ContextItem[]) => list.map((it) => ('id' in it ? `${it.id}${it.enabled ? '' : '-'}` : '|'))
  const labels = (list: ContextItem[]) => list.map((it) => ('label' in it ? it.label : '|'))

  test('a photo: 이미지 복사 and 이미지 저장…; a link: 링크 복사; selected text: 복사; a text field: the four edit items', () => {
    const photo = items({ mediaType: 'image', hasImageContents: true, srcURL: `${TEAM}/api/rooms/r1/files/f1?thumb=1` })
    expect(labels(photo)).toEqual(['이미지 복사', '이미지 저장…'])
    expect(shape(items({ linkURL: 'https://example.org/a' }))).toEqual(['copyLink'])
    expect(labels(items({ linkURL: 'https://example.org/a' }))).toEqual(['링크 복사'])
    expect(shape(items({ selectionText: 'hello', editFlags: { ...none, canCopy: true } }))).toEqual(['copy'])
    expect(labels(items({ selectionText: 'hello', editFlags: { ...none, canCopy: true } }))).toEqual(['복사'])
    const field = items({ isEditable: true, editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } })
    expect(shape(field)).toEqual(['cut', 'copy', 'paste', '|', 'selectAll'])
    expect(labels(field)).toEqual(['잘라내기', '복사', '붙여넣기', '|', '모두 선택'])
    // an empty field: nothing to cut or copy, greyed out rather than gone
    expect(shape(items({ isEditable: true, editFlags: { ...none, canPaste: true } }))).toEqual(['cut-', 'copy-', 'paste', '|', 'selectAll-'])
    // in the language of the app's own screens
    expect(labels(items({ mediaType: 'image', hasImageContents: true, srcURL: `${TEAM}/a.png` }, 'en'))).toEqual(['Copy Image', 'Save Image As…'])
    for (const { id: locale } of UI_LOCALES) for (const it of items({ mediaType: 'image', hasImageContents: true, srcURL: `${TEAM}/a.png`, linkURL: `${TEAM}/x` }, locale)) if ('label' in it) expect(it.label.length).toBeGreaterThan(0)
  })

  test('only what applies: a linked photo has both groups; a text field leaves out photo and link; empty space has no menu', () => {
    expect(shape(items({ mediaType: 'image', hasImageContents: true, srcURL: `${TEAM}/a.png`, linkURL: `${TEAM}/files/view?path=a.png` }))).toEqual(['copyLink', '|', 'copyImage', 'saveImage'])
    expect(shape(items({ mediaType: 'image', hasImageContents: true, srcURL: `${TEAM}/a.png`, selectionText: 'caption', editFlags: { ...none, canCopy: true } }))).toEqual(['copyImage', 'saveImage', '|', 'copy'])
    expect(shape(items({ isEditable: true, linkURL: 'https://example.org', selectionText: 'x', editFlags: { ...none, canCopy: true } }))).toEqual(['cut-', 'copy', 'paste-', '|', 'selectAll-'])
    expect(items({})).toEqual([])
    // whitespace only, or a selection the page does not let be copied: no 복사
    expect(items({ selectionText: '  \n', editFlags: { ...none, canCopy: true } })).toEqual([])
    expect(items({ selectionText: 'secret' })).toEqual([])
    // a photo still loading (no pixels yet) can be saved, not copied; a video or a canvas gets nothing
    expect(shape(items({ mediaType: 'image', hasImageContents: false, srcURL: `${TEAM}/a.png` }))).toEqual(['saveImage'])
    expect(items({ mediaType: 'video', srcURL: `${TEAM}/a.mp4` })).toEqual([])
    expect(items({ mediaType: 'canvas', hasImageContents: true })).toEqual([])
    // no Inspect, nothing that opens a link
    const all = [...items({ mediaType: 'image', hasImageContents: true, srcURL: `${TEAM}/a.png`, linkURL: `${TEAM}/x`, selectionText: 'x', editFlags: { ...none, canCopy: true } }), ...items({ isEditable: true })]
    for (const s of shape(all)) expect(['copyImage', 'saveImage', 'copyLink', 'cut', 'copy', 'paste', 'selectAll', '|']).toContain(s.replace(/-$/, ''))
  })

  test("이미지 저장… only for the team page's own images: its address, its office address, its blob: pictures", () => {
    const LAN = 'https://192.168.0.10:8443'
    expect(saveableImage(`${TEAM}/api/rooms/r1/files/f1?thumb=1`, [TEAM])).toBe(true)
    expect(saveableImage(`${LAN}/api/rooms/r1/files/f1`, [TEAM, LAN])).toBe(true)
    // the preview panel draws the original from the page's own bytes
    expect(saveableImage(`blob:${TEAM}/1b0e5c1e-8f0a-4c43-9d55-2b8f3f1d2a10`, [TEAM])).toBe(true)
    expect(saveableImage(`blob:${LAN}/1b0e5c1e-8f0a-4c43-9d55-2b8f3f1d2a10`, [TEAM])).toBe(false)
    // another site, an artifact's picture, an opaque blob, junk
    for (const src of ['https://example.org/a.png', 'http://acme.example.com/a.png', 'https://acme.example.com.evil.test/a.png', 'data:image/png;base64,iVBORw0KGgo=', 'blob:null/1b0e5c1e-8f0a-4c43-9d55-2b8f3f1d2a10', 'file:///etc/hosts', 'javascript:alert(1)', 'not a url', ''])
      expect({ src, ok: saveableImage(src, [TEAM]) }).toEqual({ src, ok: false })
    // no team open: nothing is saved
    expect(saveableImage(`${TEAM}/a.png`, [])).toBe(false)
    // an image from elsewhere on the team page is still copied
    expect(shape(items({ mediaType: 'image', hasImageContents: true, srcURL: 'https://example.org/a.png' }))).toEqual(['copyImage'])
  })

  test('the photo items only on the team page itself: not in a frame inside it (an artifact), not on the own screens', () => {
    const LAN = 'https://192.168.0.10:8443'
    expect(isTeamPage({ url: `${TEAM}/rooms/r1`, top: true }, [TEAM])).toBe(true)
    expect(isTeamPage({ url: `${LAN}/rooms/r1`, top: true }, [TEAM, LAN])).toBe(true)
    // an artifact's or a preview's frame, even one at the team address (/sandbox/frame) or about:srcdoc
    for (const url of [`${TEAM}/sandbox/frame?x=1`, 'about:srcdoc', 'about:blank', `${TEAM}/rooms/r1`]) expect(isTeamPage({ url, top: false }, [TEAM])).toBe(false)
    // another address in the top frame (a page still loading, the app's own screens), a frame that is gone, no team
    for (const url of ['https://example.org/', 'about:blank', 'mycel-ui://app/welcome.html', 'not a url']) expect(isTeamPage({ url, top: true }, [TEAM])).toBe(false)
    expect(isTeamPage(null, [TEAM])).toBe(false)
    expect(isTeamPage({ url: `${TEAM}/`, top: true }, [])).toBe(false)
    // an artifact's picture pointing at a team address it could not load: no 이미지 저장… (it would fetch it with the
    // team's session), no 이미지 복사; its link and text items stay
    const frame = { teamPage: false, allowedOrigins: [TEAM] }
    expect(items({ mediaType: 'image', hasImageContents: false, srcURL: `${TEAM}/api/files/download?path=users%2Folga%2Fpay.pdf` }, 'ko', frame)).toEqual([])
    expect(items({ mediaType: 'image', hasImageContents: true, srcURL: `blob:${TEAM}/1b0e5c1e-8f0a-4c43-9d55-2b8f3f1d2a10` }, 'ko', frame)).toEqual([])
    expect(shape(items({ mediaType: 'image', hasImageContents: true, srcURL: `${TEAM}/a.png`, linkURL: 'https://example.org/x', selectionText: 'caption', editFlags: { ...none, canCopy: true } }, 'ko', frame))).toEqual(['copyLink', '|', 'copy'])
    // the app's own screens (no team address): their text fields and links
    const own = { teamPage: false, allowedOrigins: [] }
    expect(shape(items({ isEditable: true, editFlags: { ...none, canPaste: true } }, 'ko', own))).toEqual(['cut-', 'copy-', 'paste', '|', 'selectAll-'])
    expect(shape(items({ linkURL: 'https://acme.example.com/join' }, 'ko', own))).toEqual(['copyLink'])
  })

  test('wired to the team page (its addresses) and the own screens (none), with no item that opens or navigates', () => {
    const win = readFileSync(join(import.meta.dir, '../../desktop/src/main/app-window.ts'), 'utf8')
    const open = win.slice(win.indexOf('async openTeam('), win.indexOf('async reload()'))
    expect(open).toContain('attachContextMenu(app.webContents, { window: this.win, locale: this.o.locale, allowedOrigins: () => this.allowedOrigins() })')
    expect(win).toContain('attachContextMenu(v.webContents, { window: this.win, locale: o.locale, allowedOrigins: () => [] })')
    expect(win.match(/attachContextMenu\(/g)).toHaveLength(2)
    const menu = readFileSync(join(import.meta.dir, '../../desktop/src/main/context-menu.ts'), 'utf8')
    for (const word of [/openExternal/, /\.loadURL\(/, /inspectElement/, /DevTools/, /\bshell\b/, /\bnavigate/]) expect(menu).not.toMatch(word)
    // the frame that was right-clicked decides, checked again at the click
    expect(menu).toContain('const teamPage = () => isTeamPage(clickedFrame(p.frame), o.allowedOrigins())')
    expect(menu).toContain('copyImage: () => teamPage() && wc.copyImageAt(p.x, p.y)')
    expect(menu).toContain('saveImage: () => teamPage() && saveableImage(p.srcURL, o.allowedOrigins()) && wc.downloadURL(p.srcURL)')
    expect(readFileSync(join(import.meta.dir, '../../desktop/src/main/pane/pane.ts'), 'utf8')).not.toContain('context-menu')
  })
  // 이미지 복사 through the app (DesktopBridge.copyImage, web/src/lib/copyImage.ts): the PNG bytes the team page read
  // itself, nothing fetched by the app; anything else refused
  test('the clipboard takes only PNG bytes of a sane size from the team page', () => {
    const header = (w: number, h: number) => {
      const b = new Uint8Array(64)
      b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
      new DataView(b.buffer).setUint32(16, w)
      new DataView(b.buffer).setUint32(20, h)
      return b
    }
    const png = header(40, 30)
    expect(clipboardPng(png)).toBe(png)
    // a small file that claims a huge picture is not decoded
    expect(clipboardPng(header(CLIPBOARD_PNG_SIDE + 1, 10))).toBeNull()
    expect(clipboardPng(header(10, 0))).toBeNull()
    expect(clipboardPng(png.slice(0, 20))).toBeNull()
    const jpeg = png.slice()
    jpeg.set([0xff, 0xd8, 0xff])
    expect(clipboardPng(jpeg)).toBeNull()
    for (const x of ['iVBORw0KGgo=', [0x89, 0x50], null, undefined, new ArrayBuffer(64), { length: 64 }]) expect(clipboardPng(x)).toBeNull()
    const big = new Uint8Array(CLIPBOARD_PNG_MAX + 1)
    big.set(png.subarray(0, 24))
    expect(clipboardPng(big)).toBeNull()
    const main = readFileSync(join(import.meta.dir, '../../desktop/src/main/main.ts'), 'utf8')
    const handler = main.slice(main.indexOf("ipcMain.handle('bridge:copy-image'"), main.indexOf("ipcMain.handle('bridge:folder-problem'"))
    expect(handler).toContain('fromApp(e) ? clipboardPng(bytes) : null')
    for (const word of [/fetch\(/, /net\.request/, /downloadURL/, /loadURL/]) expect(handler).not.toMatch(word)
    expect(readFileSync(join(import.meta.dir, '../../desktop/src/preload/app.ts'), 'utf8')).toContain("copyImage: (png) => ipcRenderer.invoke('bridge:copy-image'")
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

describe('the Mac dmg window', () => {
  test('opens on the Trina background with the two icons over its spots', async () => {
    type Dmg = { background: string; window?: unknown; iconSize: number; contents: { x: number; y: number; type: string; path?: string }[] }
    const base = (await import('../../desktop/electron-builder.config')).default as { dmg: Dmg }
    const dmg = base.dmg
    const size = (f: string) => {
      const b = readFileSync(join(import.meta.dir, '../../desktop', f))
      return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
    }
    // electron-builder joins background.png with background@2x.png (same name + @2x) into one retina TIFF
    expect(dmg.background).toBe('build-resources/background.png')
    const one = size(dmg.background), two = size(dmg.background.replace('.png', '@2x.png'))
    expect(two).toEqual({ w: one.w * 2, h: one.h * 2 })
    // electron-builder makes the window the picture's size, title bar (32 points on macOS 26) included: no `window`, and
    // the picture is the 420 points of art plus 32
    expect(dmg.window).toBeUndefined()
    expect(one).toEqual({ w: 660, h: 420 + 32 })
    // the app on the left, Applications on the right, on the art's two spots (scripts/dmg-background.svg), icons 144 points
    expect(dmg.contents).toEqual([
      { x: 170, y: 210, type: 'file' },
      { x: 490, y: 210, type: 'link', path: '/Applications' },
    ])
    expect(dmg.iconSize).toBe(144)
    expect((base.dmg as Dmg & { iconTextSize?: number }).iconTextSize).toBe(13)
    const svg = readFileSync(join(import.meta.dir, '../../desktop/scripts/dmg-background.svg'), 'utf8')
    expect(svg).toContain(`viewBox="0 0 ${one.w} ${one.h}"`)
    // the SVG's notes name the same two spots (keeps its comment true)
    for (const c of dmg.contents) expect(svg).toContain(`(${c.x},${c.y})`)
    // the drawn chevron: three marks at the icons' height, all between the two icons (144 points wide)
    const [app, apps] = dmg.contents
    const marks = [...svg.matchAll(/<path d="M(\d+) (\d+) L(\d+) (\d+) L\d+ \d+"/g)].map((m) => ({ x0: +m[1], tip: +m[3], y: +m[4] }))
    expect(marks).toHaveLength(3)
    for (const m of marks) {
      expect(m.y).toBe(app.y)
      expect(m.x0).toBeGreaterThan(app.x + 72)
      expect(m.tip).toBeLessThan(apps.x - 72)
    }
  })
})
