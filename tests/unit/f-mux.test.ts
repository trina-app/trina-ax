// Stream multiplexer: two Mux instances joined in memory (relay side opens streams, team side serves them).
import { describe, expect, test } from 'bun:test'
import { DataFlag, FrameError, FrameType, Mux, RstCode, closePayload, decodeFrames, encodeFrame, parseRst, readWsClose, streamBody, type OpenMeta, type Stream } from '@mycel/shared/relay-protocol'

const meta = (kind: 'http' | 'ws' = 'http'): OpenMeta => ({ kind, method: 'GET', path: '/x', host: 'a.localhost', proto: 'http', headers: [], clientIp: '127.0.0.1' })
const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await tick() }

/** relay <-> team over an in-memory link; `hold` queues frames toward the team until released */
function pair(o: { win?: number; maxStreams?: number; highWater?: number; onOpen?: (s: Stream) => void } = {}) {
  const win = o.win ?? 64 * 1024
  const toTeam: Uint8Array[] = []
  const toRelay: Uint8Array[] = []
  const wire = { toTeam: 0, toRelay: 0, hold: false, frames: [] as number[] }
  let team!: Mux
  let relay!: Mux
  const flush = () => {
    if (!wire.hold) while (toTeam.length) team.onMessage(toTeam.shift()!)
    while (toRelay.length) relay.onMessage(toRelay.shift()!)
  }
  relay = new Mux({ send: (b) => { wire.toTeam += b.byteLength; wire.frames.push(b[0]); toTeam.push(b); queueMicrotask(flush) }, buffered: () => 0 }, { role: 'relay', initialWindow: win, highWater: 1 << 30, maxStreams: 100 })
  // the team side sees its unsent bytes as transport backlog (like a socket buffer)
  const backlog = () => toRelay.reduce((n, b) => n + b.byteLength, 0)
  team = new Mux({ send: (b) => { wire.toRelay += b.byteLength; toRelay.push(b); queueMicrotask(flush) }, buffered: backlog }, { role: 'team', initialWindow: win, highWater: o.highWater ?? 1 << 30, maxStreams: o.maxStreams ?? 100, onOpen: (s) => {
    // the team side answers every stream first (the relay resets a stream whose DATA comes before RESPONSE)
    s.respond({ status: s.isWs ? 101 : 200, headers: [] })
    o.onOpen?.(s)
  } })
  return { relay, team, wire, flush }
}

describe('Mux', () => {
  test('stream ids are odd and increase; the team side refuses OPEN beyond maxStreams', async () => {
    const opened: Stream[] = []
    const { relay } = pair({ maxStreams: 2, onOpen: (s) => opened.push(s) })
    const a = relay.open(meta())
    const b = relay.open(meta())
    const c = relay.open(meta())
    let refused = 0
    c.onRst = (code) => { if (code === RstCode.REFUSED) refused++ }
    await settle()
    expect([a.id, b.id, c.id]).toEqual([1, 3, 5])
    expect(opened.map((s) => s.id)).toEqual([1, 3])
    expect(refused).toBe(1)
  })

  test('flow control: the sender stops after one window until the receiver consumes', async () => {
    const win = 32 * 1024
    let server!: Stream
    const { relay, wire } = pair({ win, onOpen: (s) => { server = s } })
    const s = relay.open(meta())
    await settle()
    // team writes 200 KB nobody reads
    const p = server.write(new Uint8Array(200 * 1024))
    expect(p).toBeInstanceOf(Promise)
    let got = 0
    s.onData = (b) => { got += b.byteLength } // no consumed(): window is never returned
    await settle()
    expect(got).toBe(win)
    expect(server.outBytes).toBe(200 * 1024 - win)
    // consuming returns window in quarter-window steps
    s.consumed(got)
    await settle()
    expect(got).toBe(2 * win)
    expect(wire.frames.filter((t) => t === FrameType.WINDOW).length).toBeGreaterThan(0)
  })

  test('DATA beyond the window resets only that stream (FLOW_CONTROL)', async () => {
    const served = new Map<number, Stream>()
    const { relay } = pair({ win: 16 * 1024, onOpen: (s) => { served.set(s.id, s) } })
    const s = relay.open(meta())
    const other = relay.open(meta())
    await settle()
    const server = served.get(s.id)!
    let code = 0
    s.onRst = (c) => { code = c }
    // cheat: a sender that ignores its window
    server.sendWin = 1 << 20
    void server.write(new Uint8Array(64 * 1024))
    await settle()
    expect(code).toBe(RstCode.FLOW_CONTROL)
    expect(other.reset).toBeNull()
  })

  test('round robin: a bulk stream does not starve a small one', async () => {
    const served: Stream[] = []
    const { relay } = pair({ win: 1 << 20, highWater: 64 * 1024, onOpen: (s) => served.push(s) })
    const bulk = relay.open(meta())
    const chat = relay.open(meta())
    await settle()
    const order: string[] = []
    bulk.onData = (b) => { order.push('bulk'); bulk.consumed(b.byteLength) }
    chat.onData = (b) => { order.push('chat'); chat.consumed(b.byteLength) }
    void served[0].write(new Uint8Array(512 * 1024))
    void served[1].write(new Uint8Array(100))
    await settle(50)
    expect(order.indexOf('chat')).toBeGreaterThan(-1)
    expect(order.indexOf('chat')).toBeLessThan(6)
  })

  test('HTTP request body as a pull ReadableStream returns window only as it is read', async () => {
    let body!: ReadableStream<Uint8Array>
    const { relay } = pair({ win: 16 * 1024, onOpen: (s) => { body = streamBody(s) } })
    const s = relay.open({ ...meta(), method: 'POST' })
    const total = 100 * 1024
    const chunk = new Uint8Array(total).map((_, i) => i % 251)
    const w = s.write(chunk)
    s.end()
    await settle()
    expect(s.outBytes).toBeGreaterThan(total - 16 * 1024 - 1) // nothing read yet: one window in flight
    const parts: Uint8Array[] = []
    for await (const p of body as unknown as AsyncIterable<Uint8Array>) parts.push(p)
    await w
    const got = Buffer.concat(parts)
    expect(got.byteLength).toBe(total)
    expect(got.equals(Buffer.from(chunk))).toBe(true)
  })

  test('WebSocket messages: pieces with WS_CONT, binary flag, close code, END', async () => {
    let server!: Stream
    const { relay } = pair({ win: 64 * 1024, onOpen: (s) => { server = s } })
    const s = relay.open(meta('ws'))
    await settle()
    const msgs: { flags: number; len: number }[] = []
    let frag = 0
    s.onData = (b, flags) => {
      if (flags & DataFlag.WS_CLOSE) { msgs.push({ flags, len: readWsClose(b).code }); return }
      if (flags & DataFlag.WS_CONT) { frag += b.byteLength; s.consumed(b.byteLength); return }
      msgs.push({ flags, len: frag + b.byteLength })
      frag = 0
      s.consumed(b.byteLength)
    }
    let ended = false
    s.onEnd = () => { ended = true }
    void server.write(new TextEncoder().encode('hello'), 0)
    void server.write(new Uint8Array(100_000), DataFlag.WS_BINARY) // > 16 KB pieces (quarter window)
    void server.write(new Uint8Array(0), 0)
    server.wsClose(4401, 'sign in')
    await settle(50)
    expect(msgs).toEqual([{ flags: 0, len: 5 }, { flags: DataFlag.WS_BINARY, len: 100_000 }, { flags: 0, len: 0 }, { flags: DataFlag.WS_CLOSE, len: 4401 }])
    expect(ended).toBe(true)
  })

  test('the close piece goes out even with no window left', async () => {
    let server!: Stream
    const { relay } = pair({ win: 16 * 1024, onOpen: (s) => { server = s } })
    const s = relay.open(meta('ws'))
    await settle()
    let closed = 0
    s.onData = (b, flags) => { if (flags & DataFlag.WS_CLOSE) closed = readWsClose(b).code } // never consumes
    for (let i = 0; i < 4; i++) void server.write(new Uint8Array(4096), DataFlag.WS_BINARY)
    await settle()
    expect(server.sendWin).toBe(0)
    server.wsClose(1000)
    await settle()
    expect(closed).toBe(1000)
  })

  test('RST cancels both directions and wakes a blocked producer', async () => {
    let server!: Stream
    const { relay } = pair({ win: 16 * 1024, onOpen: (s) => { server = s } })
    const s = relay.open(meta())
    await settle()
    const rst: number[] = []
    server.onRst = (c) => { rst.push(c) }
    const p = server.write(new Uint8Array(100 * 1024))!
    s.rst(RstCode.CANCEL, 'client went away')
    await p // resolves instead of hanging
    await settle()
    expect(rst).toEqual([RstCode.CANCEL])
    expect(server.reset?.code).toBe(RstCode.CANCEL)
    expect(server.outBytes).toBe(0)
  })

  test('closing a mux resets its streams with CONN_LOST', () => {
    const { relay } = pair()
    const s = relay.open(meta())
    let code = 0
    s.onRst = (c) => { code = c }
    relay.close()
    expect(code).toBe(RstCode.CONN_LOST)
    expect(relay.streams.size).toBe(0)
  })

  test('PING is answered with the same bytes; RTT reported', async () => {
    let rtt = -1
    const { relay, team } = pair()
    ;(relay.opt as { onPong?: (ms: number) => void }).onPong = (ms) => { rtt = ms }
    relay.ping()
    await settle()
    expect(rtt).toBeGreaterThanOrEqual(0)
    expect(team.stats.framesIn).toBe(1)
  })

  test('protocol violations on one stream reset that stream', async () => {
    let server!: Stream
    const { relay } = pair({ onOpen: (s) => { server = s } })
    const s = relay.open(meta())
    await settle()
    s.end()
    await settle()
    let code = 0
    server.onRst = (c) => { code = c }
    // DATA after END from the relay side
    server.recv(new Uint8Array(1), 0)
    expect(code).toBe(RstCode.PROTOCOL)
    // a WS flag on an HTTP stream
    const t = relay.open(meta())
    await settle()
    expect(decodeFrames).toBeDefined()
    let code2 = 0
    t.onRst = (c) => { code2 = c }
    t.recv(new Uint8Array(1), DataFlag.WS_BINARY)
    expect(code2).toBe(RstCode.PROTOCOL)
  })
})

// ------------------------------------------------------------------ review fixes: a peer must not be able to break
// the connection for everyone or grow the other side's memory

describe('Mux hardening', () => {
  const noop = { send: () => {}, buffered: () => 0 }
  const hdr = (type: number, id: number, payload: Uint8Array = new Uint8Array(0), flags = 0) => encodeFrame(type, id, flags, payload)
  const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))

  test('the relay side treats an OPEN from the team server as a connection error (no RST queued per OPEN)', () => {
    const sent: Uint8Array[] = []
    const relay = new Mux({ send: (b) => sent.push(b), buffered: () => 0 }, { role: 'relay', initialWindow: 65536, highWater: 1 << 20, maxStreams: 10 })
    expect(() => relay.onMessage(hdr(FrameType.OPEN, 1, json(meta())))).toThrow(FrameError)
    expect(sent.length).toBe(0)
  })

  test('a malformed OPEN resets only its own stream; the connection and later streams keep working', () => {
    const sent: Uint8Array[] = []
    const opened: Stream[] = []
    const team = new Mux({ send: (b) => sent.push(b), buffered: () => 0 }, { role: 'team', initialWindow: 65536, highWater: 1 << 20, maxStreams: 10, onOpen: (s) => opened.push(s) })
    // absolute-form target, too many headers, not JSON: each would have dropped every stream on the connection
    team.onMessage(hdr(FrameType.OPEN, 1, json({ ...meta(), path: 'http://evil.example/x' })))
    team.onMessage(hdr(FrameType.OPEN, 3, json({ ...meta(), headers: Array.from({ length: 300 }, (_, i) => [`x-h${i}`, 'v']) })))
    team.onMessage(hdr(FrameType.OPEN, 5, new TextEncoder().encode('{nope')))
    team.onMessage(hdr(FrameType.OPEN, 7, json(meta())))
    const rsts = sent.flatMap((b) => decodeFrames(b)).filter((f) => f.type === FrameType.RST)
    expect(rsts.map((f) => [f.id, parseRst(f.payload).code])).toEqual([[1, RstCode.PROTOCOL], [3, RstCode.PROTOCOL], [5, RstCode.PROTOCOL]])
    expect(opened.map((s) => s.id)).toEqual([7])
    expect(team.closed).toBe(false)
  })

  test('a PING flood while the transport is backed up queues one PONG, not one per PING', () => {
    const sent: Uint8Array[] = []
    let backed = true
    const team = new Mux({ send: (b) => sent.push(b), buffered: () => (backed ? 1 << 30 : 0) }, { role: 'relay', initialWindow: 65536, highWater: 1 << 20, maxStreams: 10 })
    const ping = hdr(FrameType.PING, 0, new Uint8Array(8))
    const batch = new Uint8Array(ping.byteLength * 5000)
    for (let i = 0; i < 5000; i++) batch.set(ping, i * ping.byteLength)
    for (let i = 0; i < 100; i++) team.onMessage(batch) // 500,000 PINGs
    backed = false
    team.pump()
    const pongs = sent.flatMap((b) => decodeFrames(b)).filter((f) => f.type === FrameType.PONG)
    expect(pongs.length).toBe(1)
    // once sent, the next PING is answered again
    team.onMessage(ping)
    expect(sent.flatMap((b) => decodeFrames(b)).filter((f) => f.type === FrameType.PONG).length).toBe(2)
  })

  test('a peer that makes us queue control frames without reading is cut off (FrameError)', () => {
    const team = new Mux({ send: () => {}, buffered: () => 1 << 30 }, { role: 'team', initialWindow: 65536, highWater: 1 << 20, maxStreams: 10, maxCtrlQueue: 64 * 1024 })
    let id = 1
    const bad = () => hdr(FrameType.OPEN, id += 2, new TextEncoder().encode('{bad'))
    expect(() => { for (let i = 0; i < 10_000; i++) team.onMessage(bad()) }).toThrow('not reading')
  })

  test('the relay side resets a stream whose DATA comes before its RESPONSE', () => {
    const relay = new Mux(noop, { role: 'relay', initialWindow: 65536, highWater: 1 << 20, maxStreams: 10 })
    const s = relay.open(meta())
    let code = 0
    s.onRst = (c) => { code = c }
    relay.onMessage(hdr(FrameType.DATA, s.id, new Uint8Array(10)))
    expect(code).toBe(RstCode.PROTOCOL)
  })

  test('DATA after a WebSocket close piece resets the stream (a close-piece flood can not pile up)', () => {
    const relay = new Mux(noop, { role: 'relay', initialWindow: 65536, highWater: 1 << 20, maxStreams: 10 })
    const s = relay.open(meta('ws'))
    let closes = 0
    let code = 0
    s.onData = (_b, f) => { if (f & DataFlag.WS_CLOSE) closes++ }
    s.onRst = (c) => { code = c }
    relay.onMessage(hdr(FrameType.RESPONSE, s.id, json({ status: 101, headers: [] })))
    const close = closePayload(1000, '')
    for (let i = 0; i < 1000; i++) relay.onMessage(hdr(FrameType.DATA, s.id, close, DataFlag.WS_CLOSE))
    expect(closes).toBe(1)
    expect(code).toBe(RstCode.PROTOCOL)
  })

  test('no END goes out after a stream was reset', async () => {
    const sent: Uint8Array[] = []
    let backed = true
    const relay = new Mux({ send: (b) => sent.push(b), buffered: () => (backed ? 1 << 30 : 0) }, { role: 'relay', initialWindow: 65536, highWater: 1 << 20, maxStreams: 10 })
    const s = relay.open(meta())
    s.end()
    s.rst(RstCode.CANCEL)
    backed = false
    relay.pump()
    const types = sent.flatMap((b) => decodeFrames(b)).map((f) => f.type)
    expect(types).toEqual([FrameType.OPEN, FrameType.RST])
  })

  test('end({ cancelUnread }) sends END, then RST only if the peer is still sending', async () => {
    const answered: Stream[] = []
    const { relay } = pair({ onOpen: (s) => answered.push(s) })
    const upload = relay.open({ ...meta(), method: 'POST' })
    const done = relay.open(meta())
    done.end()
    await settle()
    let rst = 0
    let ended = false
    upload.onRst = (c) => { rst = c }
    upload.onEnd = () => { ended = true }
    void upload.write(new Uint8Array(1000)) // request body still open
    answered[0].end({ cancelUnread: true })
    answered[1].end({ cancelUnread: true })
    await settle()
    expect(ended).toBe(true) // END first: the answer is complete
    expect(rst).toBe(RstCode.CANCEL) // then the unread upload is stopped
    expect(done.reset).toBeNull() // the other request had ended: no RST
  })

  test('an OPEN that cannot be encoded leaves no stream behind', () => {
    const relay = new Mux(noop, { role: 'relay', initialWindow: 65536, highWater: 1 << 20, maxStreams: 10 })
    expect(() => relay.open({ ...meta(), headers: [['x-big', 'x'.repeat(40_000)]] })).toThrow(FrameError)
    expect(relay.streams.size).toBe(0)
  })
})
