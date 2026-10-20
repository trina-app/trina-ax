// Addresses the desktop app's in-app browser never opens (desktop/src/common/browser-block.ts, netaddr.ts
// loopback helpers): every known team address, this computer, non-web schemes.
import { describe, expect, test } from 'bun:test'
import { blockedMessage, blockedUrl, teamHostnames } from '../../desktop/src/common/browser-block'
import { isLoopbackIp, isLoopbackName } from '../../desktop/src/common/netaddr'
import { resultBytes } from '../../desktop/src/common/browser-result'
import { SitePermissions } from '../../desktop/src/common/site-permissions'

describe('loopback', () => {
  test.each(['127.0.0.1', '127.1.2.3', '0.0.0.0', '0.1.2.3', '::1', '[::1]', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::127.0.0.1', '::ffff:0.0.0.0'])(
    '%s is this computer',
    (ip) => expect(isLoopbackIp(ip)).toBe(true),
  )
  test.each(['10.0.0.1', '192.168.1.10', '8.8.8.8', 'fe80::1', '::ffff:192.168.0.1', '2001:db8::1', 'not-an-ip'])('%s is not', (ip) =>
    expect(isLoopbackIp(ip)).toBe(false),
  )
  test('names', () => {
    for (const n of ['localhost', 'LOCALHOST', 'localhost.', 'acme.localhost', 'a.b.localhost', '127.0.0.1', '[::1]']) expect(isLoopbackName(n)).toBe(true)
    for (const n of ['localhost.example.com', 'mylocalhost', 'nas.lan', 'example.com']) expect(isLoopbackName(n)).toBe(false)
  })
})

describe('blocked addresses of the in-app browser', () => {
  const teams = teamHostnames([
    { origin: 'https://acme.treesoop.com', direct: { hosts: ['Acme-Mac.local', '192.168.0.20', 'fd00::20'] } },
    { origin: 'http://beta.localhost:19152', direct: null },
    { origin: 'garbage' },
  ])

  test('team hostnames: the team address and the office addresses it announced, lower-case', () => {
    expect([...teams].sort()).toEqual(['192.168.0.20', 'acme-mac.local', 'acme.treesoop.com', 'beta.localhost', 'fd00::20'])
  })

  test.each([
    ['https://acme.treesoop.com/api/me', 'team'],
    ['https://ACME.treesoop.com./', 'team'],
    ['https://acme.treesoop.com:8443/', 'team'],
    ['wss://acme.treesoop.com/api/ws', 'team'],
    ['https://acme-mac.local:8443/api/health', 'team'],
    ['http://192.168.0.20:8443/', 'team'],
    ['http://[fd00::20]:8443/', 'team'],
    ['http://localhost:3000/', 'loopback'],
    ['http://127.0.0.1:19151/', 'loopback'],
    ['http://0.0.0.0:8080/', 'loopback'],
    ['http://[::1]/', 'loopback'],
    ['http://[::ffff:127.0.0.1]/', 'loopback'],
    ['http://anything.localhost/', 'loopback'],
    ['file:///etc/passwd', 'scheme'],
    ['chrome://settings', 'scheme'],
    ['devtools://devtools/bundled/inspector.html', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['not a url', 'scheme'],
  ] as const)('%s is blocked (%s)', (url, reason) => expect(blockedUrl(url, teams)).toBe(reason))

  test.each(['https://example.com/', 'https://treesoop.com/', 'https://other.treesoop.com/', 'http://192.168.0.21/', 'http://nas.lan/'])('%s is not blocked here', (url) =>
    expect(blockedUrl(url, teams)).toBeNull(),
  )

  test('messages tell the AI what happened', () => {
    expect(blockedMessage('team', 'acme.treesoop.com')).toContain("team's own address")
    expect(blockedMessage('loopback', 'localhost:3000')).toContain('this computer')
    expect(blockedMessage('scheme', '')).toContain('http(s)')
  })
})

describe('pane bookkeeping', () => {
  test('result sizes count texts and images', () => {
    expect(resultBytes({ callId: 'c', ok: true, content: [{ type: 'text', text: 'abcd' }, { type: 'image', mime: 'image/png', data: 'xyz' }] })).toBe(7)
  })
  test('"clear all" removes every saved site and office address', () => {
    const p = new SitePermissions({ always: ['a.com', 'b.com'], privateAlways: ['nas.lan'] })
    expect(p.revokeAll()).toBe(true)
    expect(p.list()).toEqual({ always: [], privateAlways: [] })
    expect(p.revokeAll()).toBe(false)
  })
})
