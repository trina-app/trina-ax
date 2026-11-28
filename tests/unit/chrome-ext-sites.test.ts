/// <reference path="../../chrome-extension/src/chrome.d.ts" />
// The person's Chrome: which sites the AI may use (chrome-extension/src/sites.ts) and the guard's request verdicts
// (chrome-extension/src/guard.ts): what the call allowed, the hard blocks no server value lifts, banking sites that
// "all websites" never covers, office addresses that need the office card.
import { describe, expect, test } from 'bun:test'
import { allowed, BLOCK, checkUrl, hardBlock, keyMatches, office, sensitive, splitHost } from '../../chrome-extension/src/sites'
import { documentSourceVerdict, requestVerdict, teamPatterns } from '../../chrome-extension/src/guard'

const TEAM = ['acme.trina.app', 'acme-office.local']

describe('site keys', () => {
  test('a key covers the host and its subdomains', () => {
    expect(keyMatches('naver.com', 'naver.com')).toBe(true)
    expect(keyMatches('naver.com', 'news.naver.com')).toBe(true)
    expect(keyMatches('naver.com', 'evilnaver.com')).toBe(false)
    expect(keyMatches('news.naver.com', 'naver.com')).toBe(false)
  })
  test('ports: a key without one covers every port, a key with one only that port', () => {
    expect(keyMatches('example.com', 'example.com:8443')).toBe(true)
    expect(keyMatches('example.com:8443', 'example.com:8443')).toBe(true)
    expect(keyMatches('example.com:8443', 'example.com')).toBe(false)
    expect(keyMatches('example.com:8443', 'example.com:9000')).toBe(false)
  })
  test('split host and port, IPv6 in brackets', () => {
    expect(splitHost('www.example.com:80')).toEqual({ name: 'example.com', port: '80' })
    expect(splitHost('[fe80::1]:8080')).toEqual({ name: 'fe80::1', port: '8080' })
    expect(splitHost('fe80::1')).toEqual({ name: 'fe80::1', port: '' })
  })
})

describe('allowed', () => {
  test('sites the call lists', () => {
    expect(allowed('shop.example.com', { sites: ['example.com'] })).toBe(true)
    expect(allowed('other.com', { sites: ['example.com'] })).toBe(false)
  })
  test('"all websites" covers public sites but not banking, payment or crypto ones', () => {
    expect(allowed('news.example.com', { anySite: true })).toBe(true)
    for (const h of ['paypal.com', 'www.wise.com', 'upbit.com', 'toss.im', 'kbstar.com', 'obank.kbstar.com', 'chase.com', 'mybank.com', 'online.kbbank.co.kr']) {
      expect(sensitive(h)).toBe(true)
      expect(allowed(h, { anySite: true })).toBe(false)
    }
    expect(allowed('paypal.com', { sites: ['paypal.com'] })).toBe(true)
  })
  test('ordinary sites are not sensitive', () => {
    for (const h of ['example.com', 'naver.com', 'github.com', '8.8.8.8']) expect(sensitive(h)).toBe(false)
  })
  test('office addresses need the office list, also under "all websites"', () => {
    for (const h of ['10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.0.10', '169.254.1.1', '100.64.3.4', '[fc00::1]', '[fe80::1]', 'nas.local', 'wiki.internal', 'printer.lan', 'nas.home.arpa', 'erp.corp', 'intranet', 'intranet:8080']) {
      expect(office(h)).toBe(true)
      expect(allowed(h, { anySite: true, sites: [h] })).toBe(false)
    }
    expect(allowed('192.168.0.10', { office: ['192.168.0.10'] })).toBe(true)
    expect(allowed('nas.local:5000', { office: ['nas.local'] })).toBe(true)
    for (const h of ['8.8.8.8', '172.32.0.1', 'example.com']) expect(office(h)).toBe(false)
  })
})

describe('hard blocks', () => {
  const blocked = (url: string) => hardBlock(new URL(url), TEAM)
  test('the team\'s own addresses and their subdomains', () => {
    expect(blocked('https://acme.trina.app/chat')).toBe(BLOCK.team('acme.trina.app'))
    expect(blocked('https://api.acme.trina.app/')).toContain("team's own address")
    expect(blocked('http://acme-office.local:8080/')).toContain("team's own address")
    expect(blocked('https://trina.app/')).toBeNull()
  })
  test('this computer', () => {
    for (const u of ['http://localhost:3000/', 'http://app.localhost/', 'http://127.0.0.1/', 'http://127.9.9.9/', 'http://[::1]/', 'http://0.0.0.0/']) expect(blocked(u)).toContain("user's computer")
  })
  test('non-web schemes', () => {
    for (const u of ['chrome://settings', 'chrome-extension://abc/popup.html', 'file:///etc/passwd', 'data:text/html,hi', 'javascript:alert(1)', 'view-source:https://example.com', 'ftp://example.com/']) expect(blocked(u)).toBe(BLOCK.scheme)
  })
  test('extension stores', () => {
    for (const u of ['https://chromewebstore.google.com/detail/x', 'https://chrome.google.com/webstore/category', 'https://microsoftedge.microsoft.com/addons/x']) expect(blocked(u)).toBe(BLOCK.store)
    expect(blocked('https://chrome.google.com/other')).toBeNull()
  })
  test('account-security and password pages', () => {
    for (const u of [
      'https://accounts.google.com/signin', 'https://myaccount.google.com/', 'https://passwords.google.com/', 'https://login.microsoftonline.com/x',
      'https://login.live.com/', 'https://account.live.com/', 'https://account.microsoft.com/', 'https://mysignins.microsoft.com/', 'https://appleid.apple.com/',
      'https://account.apple.com/', 'https://iforgot.apple.com/', 'https://github.com/settings/tokens', 'https://github.com/settings', 'https://github.com/login/oauth/authorize',
      'https://github.com/sessions/two-factor', 'https://nid.naver.com/nidlogin.login', 'https://accounts.kakao.com/login', 'https://my.1password.com/', 'https://vault.bitwarden.com/',
      'https://lastpass.com/', 'https://www.dashlane.com/', 'https://keepersecurity.com/vault',
    ]) expect(blocked(u)).toContain('account-security or password page')
    for (const u of ['https://github.com/trina-app/trina-ax', 'https://www.google.com/search?q=x', 'https://naver.com/']) expect(blocked(u)).toBeNull()
  })
})

describe('checkUrl', () => {
  test('blank tab, blocked, allowed, needs a site', () => {
    expect(checkUrl('about:blank', {}, TEAM)).toEqual({ kind: 'blank' })
    expect(checkUrl('https://acme.trina.app/', { sites: ['trina.app'], anySite: true }, TEAM).kind).toBe('blocked')
    expect(checkUrl('https://www.example.com/a', { sites: ['example.com'] }, TEAM)).toEqual({ kind: 'ok', host: 'example.com' })
    expect(checkUrl('https://shop.example.com:8443/', {}, TEAM)).toEqual({ kind: 'need', host: 'shop.example.com:8443' })
    expect(checkUrl('http://192.168.0.5/', { sites: ['192.168.0.5'] }, TEAM)).toEqual({ kind: 'need', host: '192.168.0.5', office: true })
    expect(checkUrl('not a url', {}, TEAM).kind).toBe('blocked')
  })
  test('no value from the server lifts a hard block', () => {
    const rules = { sites: ['google.com', 'localhost', 'acme.trina.app'], office: ['localhost', 'acme.trina.app'], anySite: true }
    for (const u of ['https://accounts.google.com/', 'http://localhost/', 'https://acme.trina.app/']) expect(checkUrl(u, rules, TEAM).kind).toBe('blocked')
  })
})

describe('guard', () => {
  const page = { scripted: false, rules: { sites: ['example.com'] }, host: 'example.com' }
  test('requests to the team and this computer always fail', () => {
    expect(requestVerdict('https://acme.trina.app/api/me', page, TEAM)).toBe('fail')
    expect(requestVerdict('wss://acme.trina.app/api/ws', page, TEAM)).toBe('fail')
    expect(requestVerdict('http://127.0.0.1:8080/', page, TEAM)).toBe('fail')
    expect(requestVerdict('https://cdn.other.com/a.js', page, TEAM)).toBe('go')
    expect(requestVerdict('data:text/plain,x', page, TEAM)).toBe('go')
  })
  test('a scripted document reaches only its own site and the allowed ones', () => {
    const s = { ...page, scripted: true }
    expect(requestVerdict('https://static.example.com/x', s, TEAM)).toBe('go')
    expect(requestVerdict('https://attacker.test/?d=secret', s, TEAM)).toBe('fail')
    expect(requestVerdict('https://shop.example.com/', s, TEAM)).toBe('go')
  })
  test('team patterns cover subdomains and ports', () => {
    expect(teamPatterns(['acme.trina.app']).map((p) => p.urlPattern)).toEqual(['*://acme.trina.app/*', '*://acme.trina.app:*', '*://*.acme.trina.app/*', '*://*.acme.trina.app:*'])
    expect(teamPatterns(['bad*host'])).toEqual([])
  })
  test('a public name served from this computer or the office network is stopped', () => {
    expect(documentSourceVerdict('example.com', '127.0.0.1', {})).toBe('loopback')
    expect(documentSourceVerdict('example.com', '192.168.1.2', {})).toBe('office')
    expect(documentSourceVerdict('example.com', '192.168.1.2', { office: ['example.com'] })).toBeNull()
    expect(documentSourceVerdict('nas.local', '192.168.1.2', {})).toBeNull()
    expect(documentSourceVerdict('example.com', '93.184.216.34', {})).toBeNull()
  })
})
