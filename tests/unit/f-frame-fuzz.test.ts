// Frame-decoder fuzzer (spike REPORT: "keep these tests as conformance tests and add a frame-decoder fuzzer").
// Random bytes and mutations of valid frames go through decodeFrames and through both sides' Mux.onMessage.
// Property: the only failure is FrameError (the connection is then closed with 4004); anything decoded re-encodes
// to the same bytes; a Mux never grows past its stream limit and never throws anything else.
// Deterministic (seeded) so a failure is reproducible: FUZZ_SEED=<n> FUZZ_N=<count> bun test tests/unit/f-frame-fuzz.test.ts
import { expect, test } from 'bun:test'
import {
  DataFlag, FrameError, FrameType, Mux, RstCode, closePayload, decodeFrames, encodeFrame, jsonPayload, pingPayload, rstPayload, u32,
} from '@mycel/shared/relay-protocol'

const SEED = Number(process.env.FUZZ_SEED ?? 20261021)
const N = Number(process.env.FUZZ_N ?? 30_000)

function rng(seed: number) {
  let x = seed >>> 0 || 1
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x100000000 }
}

const OPEN = { kind: 'http', method: 'GET', path: '/x', host: 'a.localhost', proto: 'http', headers: [['a', 'b']], clientIp: '127.0.0.1' }
function seeds(): Uint8Array[] {
  return [
    encodeFrame(FrameType.OPEN, 1, 0, jsonPayload(OPEN)),
    encodeFrame(FrameType.OPEN, 3, 0, jsonPayload({ ...OPEN, kind: 'ws' })),
    encodeFrame(FrameType.DATA, 1, 0, new Uint8Array(100).fill(7)),
    encodeFrame(FrameType.DATA, 3, DataFlag.WS_BINARY | DataFlag.WS_CONT, new Uint8Array(10)),
    encodeFrame(FrameType.DATA, 3, DataFlag.WS_CLOSE, closePayload(4401, 'x')),
    encodeFrame(FrameType.END, 1),
    encodeFrame(FrameType.RST, 1, 0, rstPayload(RstCode.CANCEL, 'bye')),
    encodeFrame(FrameType.WINDOW, 1, 0, u32(1000)),
    encodeFrame(FrameType.PING, 0, 0, pingPayload(1)),
    encodeFrame(FrameType.PONG, 0, 0, pingPayload(1)),
    encodeFrame(FrameType.GOAWAY, 0, 0, jsonPayload({ reason: 'restart' })),
    encodeFrame(FrameType.EVENT, 0, 0, jsonPayload({ type: 'key_rejected', at: 1, count: 1 })),
    encodeFrame(FrameType.RESPONSE, 1, 0, jsonPayload({ status: 200, headers: [] })),
  ]
}

function mutate(r: () => number, base: Uint8Array): Uint8Array {
  const b = new Uint8Array(base)
  const k = Math.floor(r() * 7)
  switch (k) {
    case 0: { // flip random bits
      const n = 1 + Math.floor(r() * 4)
      for (let i = 0; i < n; i++) b[Math.floor(r() * b.length)] ^= 1 << Math.floor(r() * 8)
      return b
    }
    case 1: return b.subarray(0, Math.floor(r() * b.length)) // truncate
    case 2: { // rewrite the length field
      const dv = new DataView(b.buffer)
      if (b.length >= 10) dv.setUint32(6, [0, 1, 7, 8, 65535, 65536, 65537, 0xffffffff, b.length][Math.floor(r() * 9)])
      return b
    }
    case 3: { b[0] = Math.floor(r() * 256); return b } // random type
    case 4: { b[5] = Math.floor(r() * 256); return b } // random flags
    case 5: { // random stream id
      if (b.length >= 5) new DataView(b.buffer).setUint32(1, [0, 1, 2, 3, 0xffffffff, Math.floor(r() * 0xffffffff)][Math.floor(r() * 6)])
      return b
    }
    default: { // append junk
      const extra = new Uint8Array(Math.floor(r() * 20))
      for (let i = 0; i < extra.length; i++) extra[i] = Math.floor(r() * 256)
      const out = new Uint8Array(b.length + extra.length)
      out.set(b)
      out.set(extra, b.length)
      return out
    }
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

test(`decodeFrames: ${N} fuzzed inputs, only FrameError, decoded frames re-encode exactly (seed ${SEED})`, () => {
  const r = rng(SEED)
  const base = seeds()
  let decoded = 0
  let rejected = 0
  for (let i = 0; i < N; i++) {
    let input: Uint8Array
    const mode = r()
    if (mode < 0.15) { input = new Uint8Array(Math.floor(r() * 64)); for (let j = 0; j < input.length; j++) input[j] = Math.floor(r() * 256) }
    else if (mode < 0.3) input = concat([base[Math.floor(r() * base.length)], mutate(r, base[Math.floor(r() * base.length)])])
    else input = mutate(r, base[Math.floor(r() * base.length)])
    try {
      const frames = decodeFrames(input)
      decoded++
      expect(concat(frames.map((f) => encodeFrame(f.type, f.id, f.flags, f.payload)))).toEqual(input)
    } catch (e) {
      if (!(e instanceof FrameError)) throw new Error(`non-FrameError on input ${Buffer.from(input).toString('hex')}: ${e}`)
      rejected++
    }
  }
  expect(decoded).toBeGreaterThan(N / 20)
  expect(rejected).toBeGreaterThan(N / 20)
})

test(`Mux.onMessage on both sides: ${Math.floor(N / 3)} fuzzed messages, only FrameError, bounded state`, () => {
  const r = rng(SEED + 1)
  const base = seeds()
  for (const role of ['team', 'relay'] as const) {
    let sent = 0
    const mux = new Mux({ send: () => { sent++ }, buffered: () => 0 }, {
      role, initialWindow: 64 * 1024, highWater: 1 << 20, maxStreams: 8,
      onOpen: (s) => { s.onData = (b) => s.consumed(b.byteLength); if (r() < 0.5) s.respond({ status: 200, headers: [] }) },
    })
    for (let i = 0; i < N / 3; i++) {
      const input = r() < 0.5 ? base[Math.floor(r() * base.length)] : mutate(r, base[Math.floor(r() * base.length)])
      try {
        mux.onMessage(input)
      } catch (e) {
        if (!(e instanceof FrameError)) throw new Error(`${role}: non-FrameError on ${Buffer.from(input).toString('hex')}: ${e}`)
      }
      expect(mux.streams.size).toBeLessThanOrEqual(8)
    }
    expect(sent).toBeGreaterThan(0)
    mux.close()
  }
})
