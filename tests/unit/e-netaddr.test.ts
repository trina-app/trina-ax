// Office-network classification of the in-app browser (desktop/src/common/netaddr.ts).
import { describe, expect, test } from 'bun:test'
import { classifyHostStatic, classifyIp, classifyResolved, isLocalName, parseV6 } from '../../desktop/src/common/netaddr'

describe('classifyIp', () => {
  test.each([
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.8.8.8',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1', '192.168.0.10', '198.18.0.1',
    '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
  ])('IPv4 %s is private', (ip) => expect(classifyIp(ip)).toBe('private'))

  test.each(['1.1.1.1', '8.8.8.8', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.169.0.1', '11.0.0.1', '223.255.255.254'])(
    'IPv4 %s is public',
    (ip) => expect(classifyIp(ip)).toBe('public'),
  )

  test.each([
    '::', '::1', '[::1]', 'fe80::1', 'fe80::1%en0', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', '100::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:192.168.1.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '64:ff9b::10.0.0.1',
    '64:ff9b:1::1', '2002:c0a8:0101::1', '2002:7f00:1::', '::127.0.0.1',
    // Teredo whose obfuscated client is 192.168.1.1 (~c0a8 0101 = 3f57 fefe)
    '2001:0:4136:e378:8000:63bf:3f57:fefe',
  ])('IPv6 %s is private', (ip) => expect(classifyIp(ip)).toBe('private'))

  test.each(['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:0808:0808::1'])(
    'IPv6 %s is public',
    (ip) => expect(classifyIp(ip)).toBe('public'),
  )

  test('garbage fails closed', () => {
    for (const s of ['', 'not-an-ip', '1.2.3', '256.1.1.1', '1::2::3', '12345::', 'g::1']) expect(classifyIp(s)).toBe('private')
  })
})

describe('parseV6', () => {
  test('expands :: and embedded IPv4', () => {
    expect(parseV6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(parseV6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(parseV6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304])
    expect(parseV6('1:2:3:4:5:6:1.2.3.4')).toEqual([1, 2, 3, 4, 5, 6, 0x0102, 0x0304])
    expect(parseV6('1:2:3:4:5:6:7:8:9')).toBeNull()
    expect(parseV6('1:2:3:4:5:6:7')).toBeNull()
  })
})

describe('host names', () => {
  test('local names need no DNS to be private', () => {
    for (const h of ['localhost', 'acme.localhost', 'nas.local', 'router.home.arpa', 'intranet', 'wiki.corp', 'printer.lan', 'db.internal']) {
      expect(isLocalName(h)).toBe(true)
      expect(classifyHostStatic(h)).toBe('private')
    }
    for (const h of ['example.com', 'acme.treesoop.com', 'local.example.com']) expect(isLocalName(h)).toBe(false)
  })

  test('IP literals decide alone, other names need DNS', () => {
    expect(classifyHostStatic('192.168.0.1')).toBe('private')
    expect(classifyHostStatic('[::1]')).toBe('private')
    expect(classifyHostStatic('8.8.8.8')).toBe('public')
    expect(classifyHostStatic('example.com')).toBe('resolve')
  })

  test('a name is private when any of its addresses is', () => {
    expect(classifyResolved(['93.184.216.34'])).toBe('public')
    expect(classifyResolved(['93.184.216.34', '10.0.0.5'])).toBe('private')
    expect(classifyResolved([])).toBe('private')
  })
})
