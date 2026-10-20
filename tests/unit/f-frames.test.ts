// Relay protocol v2: frame encoding test vectors, decoder validation, JSON payloads, names, keys, proof of work.
// Both implementations (relay on Node, client on Bun) use this one codec; these vectors pin the wire format.
import { describe, expect, test } from 'bun:test'
import {
  DataFlag, FrameError, FrameType, HDR, MAX_JSON_PAYLOAD, MAX_PAYLOAD, RstCode, SUPPORTED_VERSIONS, apiSigningString,
  authSigningString, checkTeamName, closePayload, decodeFrames, encodeFrame, forwardRequestHeaders, forwardResponseHeaders,
  generateTeamKey, jsonPayload, loadPrivateKey, parseAuth, parseAuthorizationHeader, parseAuthReply, parseClose,
  parseGoaway, parseOpenMeta, parseRelayEvent, parseResponseHead, parseRst, pickVersion, pingPayload, powOk, powSolve,
  publicKeyOf, readPing, reconnectDelay, rstPayload, signB64, teamFromHost, truncateUtf8, u32, verifyB64,
  authorizationHeader, parsePublicKey,
} from '@mycel/shared/relay-protocol'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const unhex = (s: string) => new Uint8Array(Buffer.from(s.replace(/\s+/g, ''), 'hex'))

describe('wire format vectors', () => {
  const vectors: [string, Uint8Array, string][] = [
    ['END stream 1', encodeFrame(FrameType.END, 1), '03 00000001 00 00000000'],
    ['DATA stream 3 "hi"', encodeFrame(FrameType.DATA, 3, 0, new TextEncoder().encode('hi')), '02 00000003 00 00000002 6869'],
    ['DATA ws binary+cont', encodeFrame(FrameType.DATA, 5, DataFlag.WS_BINARY | DataFlag.WS_CONT, new Uint8Array([1])), '02 00000005 03 00000001 01'],
    ['RST cancel', encodeFrame(FrameType.RST, 7, 0, rstPayload(RstCode.CANCEL, 'x')), '04 00000007 00 00000005 00000001 78'],
    ['WINDOW +65536', encodeFrame(FrameType.WINDOW, 9, 0, u32(65536)), '05 00000009 00 00000004 00010000'],
    ['PING', encodeFrame(FrameType.PING, 0, 0, pingPayload(1.5)), '06 00000000 00 00000008 3ff8000000000000'],
    ['WS close 4401', encodeFrame(FrameType.DATA, 11, DataFlag.WS_CLOSE, closePayload(4401, 'no')), '02 0000000b 04 00000004 1131 6e6f'],
    ['big stream id', encodeFrame(FrameType.END, 0xfffffffd), '03 fffffffd 00 00000000'],
  ]
  for (const [name, bytes, want] of vectors) {
    test(name, () => {
      expect(hex(bytes)).toBe(want.replace(/\s+/g, ''))
      const [f] = decodeFrames(unhex(want))
      expect(f.type).toBe(bytes[0])
      expect(hex(encodeFrame(f.type, f.id, f.flags, f.payload))).toBe(hex(bytes))
    })
  }

  test('several frames in one message', () => {
    const a = encodeFrame(FrameType.END, 1)
    const b = encodeFrame(FrameType.DATA, 1, 0, new Uint8Array(3))
    const both = new Uint8Array(a.byteLength + b.byteLength)
    both.set(a)
    both.set(b, a.byteLength)
    expect(decodeFrames(both).map((f) => f.type)).toEqual([FrameType.END, FrameType.DATA])
  })

  test('payload helpers round-trip', () => {
    expect(parseRst(rstPayload(RstCode.TIMEOUT, '시간 초과'))).toEqual({ code: RstCode.TIMEOUT, reason: '시간 초과' })
    expect(parseClose(closePayload(4409, 'replaced'))).toEqual({ code: 4409, reason: 'replaced' })
    expect(readPing(pingPayload(12345.25))).toBe(12345.25)
    // close reasons are cut at a character boundary to 123 bytes
    const long = '가'.repeat(100)
    const p = closePayload(1000, long)
    expect(p.byteLength).toBeLessThanOrEqual(125)
    expect(parseClose(p).reason).toBe(truncateUtf8(long, 123))
  })
})

describe('decoder rejects malformed frames (FrameError only)', () => {
  const bad: [string, Uint8Array][] = [
    ['empty message', new Uint8Array(0)],
    ['truncated header', new Uint8Array([2, 0, 0])],
    ['truncated payload', unhex('02 00000001 00 00000005 6869')],
    ['trailing bytes', unhex('03 00000001 00 00000000 ff')],
    ['unknown type 0', unhex('00 00000001 00 00000000')],
    ['unknown type 11', unhex('0b 00000001 00 00000000')],
    ['oversized length', unhex('02 00000001 00 00010001')],
    ['DATA on stream 0', unhex('02 00000000 00 00000000')],
    ['PING on a stream', unhex('06 00000001 00 00000008 0000000000000000')],
    ['PING wrong size', unhex('06 00000000 00 00000004 00000000')],
    ['END with payload', unhex('03 00000001 00 00000001 00')],
    ['END with flags', unhex('03 00000001 01 00000000')],
    ['unknown DATA flag', unhex('02 00000001 08 00000000')],
    ['WS_CLOSE + CONT', unhex('02 00000001 06 00000002 03e8')],
    ['WS_CLOSE too short', unhex('02 00000001 04 00000001 03')],
    ['RST too short', unhex('04 00000001 00 00000002 0000')],
    ['WINDOW zero', unhex('05 00000001 00 00000004 00000000')],
    ['WINDOW on stream 0', unhex('05 00000000 00 00000004 00000001')],
    ['OPEN without JSON', unhex('01 00000001 00 00000000')],
    ['GOAWAY on a stream', unhex('08 00000001 00 00000002 7b7d')],
  ]
  for (const [name, b] of bad) {
    test(name, () => {
      let err: unknown = null
      try { decodeFrames(b) } catch (e) { err = e }
      expect(err).toBeInstanceOf(FrameError)
    })
  }
  test('encoder refuses oversized payloads', () => {
    expect(() => encodeFrame(FrameType.DATA, 1, 0, new Uint8Array(MAX_PAYLOAD + 1))).toThrow(FrameError)
    expect(encodeFrame(FrameType.DATA, 1, 0, new Uint8Array(MAX_PAYLOAD)).byteLength).toBe(HDR + MAX_PAYLOAD)
    expect(() => jsonPayload({ x: 'a'.repeat(MAX_JSON_PAYLOAD) })).toThrow(FrameError)
  })
})

describe('JSON payloads', () => {
  const open = { kind: 'http', method: 'POST', path: '/api/x?y=1', host: 'acme.treesoop.com', proto: 'https', headers: [['cookie', 'a=b'], ['content-type', 'text/plain']], clientIp: '203.0.113.9' }
  test('OPEN', () => {
    expect(parseOpenMeta(open)).toEqual(open as never)
    expect(parseOpenMeta({ ...open, clientIp: null }).clientIp).toBeNull()
    for (const patch of [{ kind: 'tcp' }, { method: 'GE T' }, { path: 'x' }, { path: '/a b' }, { host: 'a/b' }, { proto: 'ftp' }, { headers: [['bad header', 'x']] }, { headers: [['x', 'a\r\nb']] }, { clientIp: 'evil;' }]) {
      expect(() => parseOpenMeta({ ...open, ...patch })).toThrow(FrameError)
    }
  })
  test('RESPONSE / GOAWAY / EVENT', () => {
    expect(parseResponseHead({ status: 200, headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2']] }).headers).toHaveLength(2)
    expect(() => parseResponseHead({ status: 99, headers: [] })).toThrow(FrameError)
    expect(() => parseResponseHead({ status: 200 })).toThrow(FrameError)
    expect(parseGoaway({ reason: 'replaced', by: 'abc' })).toEqual({ reason: 'replaced', by: 'abc' })
    expect(() => parseGoaway({ reason: 'bye' })).toThrow(FrameError)
    expect(parseRelayEvent({ type: 'key_rejected', at: 5, count: 2 })).toEqual({ type: 'key_rejected', at: 5, count: 2 })
    expect(parseRelayEvent({ type: 'instance_replaced', by: 'b', previous: 'a', at: 1 }).type).toBe('instance_replaced')
    expect(() => parseRelayEvent({ type: 'other' })).toThrow(FrameError)
  })
  test('handshake', () => {
    expect(pickVersion([1, 2, 3])).toBe(2)
    expect(pickVersion([1])).toBeNull()
    expect(SUPPORTED_VERSIONS).toContain(2)
    const auth = { t: 'auth', v: 2, team: 't1', instance: 'inst0001', conn: 1, ts: 1, sig: 'AAAA' }
    expect(parseAuth(auth)).toEqual(auth as never)
    expect(() => parseAuth({ ...auth, instance: 'x' })).toThrow(FrameError)
    expect(() => parseAuth({ ...auth, conn: 99 })).toThrow(FrameError)
    expect(parseAuthReply({ t: 'error', code: 'auth_failed', message: 'no' })).toEqual({ t: 'error', code: 'auth_failed', message: 'no' })
    const ok = { t: 'ok', v: 2, initialWindow: 262144, maxStreams: 512, pingMs: 20000, silenceMs: 45000, address: 'https://a.example', name: 'a', conns: 1 }
    expect(parseAuthReply(ok)).toEqual(ok as never)
    expect(() => parseAuthReply({ ...ok, initialWindow: 10 })).toThrow(FrameError)
    // the relay-seen address is optional; anything that is not an IP address is dropped, not passed on
    expect(parseAuthReply({ ...ok, seenIp: '2001:db8::7' })).toEqual({ ...ok, seenIp: '2001:db8::7' } as never)
    expect(parseAuthReply({ ...ok, seenIp: '1.2.3.4; evil' })).toEqual(ok as never)
    expect(authSigningString('t', 'i', 'n', 5)).toBe('mycel-relay-v2\nt\ni\nn\n5')
  })
  test('header forwarding strips hop-by-hop and spoofable headers', () => {
    const raw = ['Host', 'acme.x', 'Cookie', 'a=b', 'X-Forwarded-For', '1.2.3.4', 'CF-Connecting-IP', '6.6.6.6', 'X-Real-IP', '7.7.7.7', 'Forwarded', 'for=1', 'Connection', 'keep-alive', 'Transfer-Encoding', 'chunked', 'Sec-WebSocket-Key', 'k', 'Sec-WebSocket-Protocol', 'mycel.v1', 'Origin', 'https://acme.x']
    expect(forwardRequestHeaders(raw, 'http')).toEqual([['cookie', 'a=b'], ['origin', 'https://acme.x']])
    expect(forwardRequestHeaders(raw, 'ws')).toEqual([['cookie', 'a=b'], ['sec-websocket-protocol', 'mycel.v1'], ['origin', 'https://acme.x']])
    expect(forwardResponseHeaders([['Connection', 'close'], ['set-cookie', 'a'], ['Transfer-Encoding', 'chunked'], ['sec-websocket-accept', 'x'], ['content-type', 'x']])).toEqual([['set-cookie', 'a'], ['content-type', 'x']])
  })
})

describe('team names', () => {
  test('rules', () => {
    for (const ok of ['acme', 'team-7', 'a1b', 'abc-def-ghi', 'x'.repeat(40)]) expect(checkTeamName(ok)).toBeNull()
    expect(checkTeamName('ab')).toBe('too_short')
    expect(checkTeamName('x'.repeat(41))).toBe('too_long')
    for (const bad of ['Acme', '-acme', 'acme-', 'ac_me', 'ac.me', '한글팀', 'xn--abc', 'ab--c', 'acme ']) expect(checkTeamName(bad)).toBe('invalid')
    for (const r of ['www', 'relay', 'releases', 'api', 'mail', 'admin', 'treesoop']) expect(checkTeamName(r)).toBe('reserved')
    expect(checkTeamName('blocked', ['blocked'])).toBe('reserved')
  })
  test('host routing', () => {
    expect(teamFromHost('acme.treesoop.com', 'treesoop.com')).toBe('acme')
    expect(teamFromHost('ACME.treesoop.com:443', 'treesoop.com')).toBe('acme')
    expect(teamFromHost('acme.localhost:19161', 'localhost')).toBe('acme')
    expect(teamFromHost('treesoop.com', 'treesoop.com')).toBeNull()
    expect(teamFromHost('a.b.treesoop.com', 'treesoop.com')).toBeNull()
    expect(teamFromHost('acme.evil.com', 'treesoop.com')).toBeNull()
    expect(teamFromHost('acmetreesoop.com', 'treesoop.com')).toBeNull()
  })
})

describe('keys, signatures, proof of work, backoff', () => {
  test('Ed25519 sign / verify', () => {
    const kp = generateTeamKey()
    const k = loadPrivateKey(kp.privatePem)
    expect(publicKeyOf(k)).toBe(kp.publicKey)
    const sig = signB64(k, 'hello')
    expect(verifyB64(kp.publicKey, 'hello', sig)).toBe(true)
    expect(verifyB64(kp.publicKey, 'hellO', sig)).toBe(false)
    expect(verifyB64(generateTeamKey().publicKey, 'hello', sig)).toBe(false)
    expect(verifyB64(kp.publicKey, 'hello', 'not-base64!')).toBe(false)
    expect(parsePublicKey('AAAA')).toBeNull()
  })
  test('API signing header', () => {
    expect(apiSigningString('post', '/teams/x', 5, '')).toBe('mycel-relay-api-v1\nPOST\n/teams/x\n5\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(parseAuthorizationHeader(authorizationHeader('t-1', 123, 'AB/+=='))).toEqual({ team: 't-1', ts: 123, sig: 'AB/+==' })
    expect(parseAuthorizationHeader('Bearer x')).toBeNull()
  })
  test('proof of work', () => {
    const r = { name: 'acme', publicKey: 'pk', ts: 1 }
    const nonce = powSolve(r, 10)
    expect(powOk({ ...r, nonce }, 10)).toBe(true)
    expect(powOk({ ...r, nonce, name: 'acmf' }, 10)).toBe(false)
    expect(powOk({ ...r, nonce: '' }, 0)).toBe(false)
  })
  test('reconnect backoff: full jitter, 0.5 s * 2^n, cap 30 s', () => {
    expect(reconnectDelay(0, () => 1)).toBe(500)
    expect(reconnectDelay(3, () => 1)).toBe(4000)
    expect(reconnectDelay(10, () => 1)).toBe(30_000)
    expect(reconnectDelay(100, () => 1)).toBe(30_000)
    expect(reconnectDelay(5, () => 0)).toBe(0)
  })
})
