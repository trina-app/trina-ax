// QA TC-199: the relay's per-visitor stream cap and stall cut (the behaviour itself is tested against a real Node
// relay in tests/relay/f-slow-visitors.test.ts). Here: what counts as one visitor, the defaults, and the metrics.
import { describe, expect, test } from 'bun:test'
import { loadRelayConfig } from '../../relay/src/config.ts'
import { renderMetrics } from '../../relay/src/metrics.ts'
import { visitorKey } from '../../relay/src/proxies.ts'

describe('relay visitor cap', () => {
  test('one visitor: an IPv4 address, an IPv6 /64 (one home or office line)', () => {
    expect(visitorKey('198.51.100.7')).toBe('198.51.100.7')
    expect(visitorKey('::ffff:198.51.100.7')).toBe('198.51.100.7')
    expect(visitorKey('2001:db8:1:2::1')).toBe(visitorKey('2001:db8:1:2:ffff:ffff:ffff:ffff'))
    expect(visitorKey('2001:db8:1:2::1')).not.toBe(visitorKey('2001:db8:1:3::1'))
    expect(visitorKey('2001:DB8:1:2::1')).toBe('20010db800010002::/64')
    expect(visitorKey('unknown')).toBe('unknown')
  })

  test('defaults: half of one control connection per visitor, 30 s stall; both can be changed or turned off', () => {
    const d = loadRelayConfig(['--dev'], {})
    expect(d.maxStreamsPerIp).toBe(256)
    expect(d.clientStallMs).toBe(30_000)
    expect(loadRelayConfig(['--dev'], { RELAY_MAX_STREAMS: '100' }).maxStreamsPerIp).toBe(50)
    const off = loadRelayConfig(['--dev'], { RELAY_MAX_STREAMS_PER_IP: '0', RELAY_CLIENT_STALL_MS: '0' })
    expect(off.maxStreamsPerIp).toBe(0)
    expect(off.clientStallMs).toBe(0)
    expect(() => loadRelayConfig(['--dev'], { RELAY_MAX_STREAMS_PER_IP: 'many' })).toThrow()
  })

  test('metrics count refusals and cuts (no team or address labels)', () => {
    const text = renderMetrics({
      teams: { active: 1, suspended: 0 }, teamsOnline: 1, ctlConnections: 2, openStreams: 0, clientWebsockets: 0,
      counters: { httpVisitorLimit: 844, clientStalls: 256 },
    })
    expect(text).toContain('relay_http_requests_total{outcome="capped"} 844')
    expect(text).toContain('relay_client_stalls_total 256')
  })
})
