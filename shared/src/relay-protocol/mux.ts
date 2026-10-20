// Stream multiplexer over one control connection, used by both the relay and the team server's relay client.
//
// Flow control: every stream has a window per direction (default 256 KB). A sender never puts more DATA on the wire
// than the peer's window allows; the receiver returns window (WINDOW frame) only once the bytes reached their final
// consumer (the client socket accepted them, the app read the request body). So a slow reader stops its producer
// after about one window, and one slow stream never blocks the others.
// Scheduling: control frames first (RESPONSE, END, RST, WINDOW, PING, ...), then DATA round-robin across streams
// that have bytes and window, at most `quantum` bytes per turn.
import {
  DataFlag, FrameError, FrameType, MAX_PAYLOAD, RstCode, decodeFrames, encodeFrame, jsonPayload, parseClose,
  parseJsonPayload, parseRst, pingPayload, readPing, readU32, rstPayload, u32, closePayload,
} from './frames.ts'
import {
  parseGoaway, parseOpenMeta, parseRelayEvent, parseResponseHead,
  type Goaway, type OpenMeta, type RelayEvent, type ResponseHead,
} from './messages.ts'

export interface MuxTransport {
  send(b: Uint8Array): void
  /** bytes the transport has accepted but not yet written to the network (0 when unknown) */
  buffered(): number
}

export interface MuxOptions {
  /** the relay opens streams (odd ids); the team server accepts them */
  role: 'relay' | 'team'
  initialWindow: number
  /** stop pumping while the transport reports this much buffered */
  highWater: number
  /** team side: OPENs beyond this many live streams are refused */
  maxStreams: number
  onOpen?: (s: Stream) => void
  onGoaway?: (g: Goaway) => void
  onEvent?: (e: RelayEvent) => void
  onPong?: (rttMs: number) => void
  /** default MAX_CTRL_QUEUE_BYTES */
  maxCtrlQueue?: number
}

const now = () => performance.now()

/**
 * Control frames the peer can make us queue (PONGs, RSTs, WINDOWs) while it does not read: past this many queued
 * bytes the connection is dropped (FrameError from onMessage -> close 4004). OPEN frames (<= 32 KB each, at most
 * maxStreams of them) fit below it.
 */
export const MAX_CTRL_QUEUE_BYTES = 24 * 1024 * 1024

export class Mux {
  readonly streams = new Map<number, Stream>()
  readonly opt: MuxOptions
  lastRecv = Date.now()
  closed = false
  quantum = 16 * 1024
  readonly stats = { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, streamsOpened: 0 }
  private io: MuxTransport
  private ctrl: Uint8Array[] = []
  private ctrlBytes = 0
  /** a PONG is queued and not sent yet: further PINGs are not answered twice (a flood can't grow the queue) */
  private pongQueued = false
  private ready: Stream[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private nextId = 1
  private highestPeerId = 0
  /** set by onPong / any traffic: used by stall probes */
  lastPongAt = 0
  pingOutstanding = false

  constructor(io: MuxTransport, opt: MuxOptions) {
    this.io = io
    this.opt = opt
  }

  /** relay: open a new stream to the team server */
  open(meta: OpenMeta): Stream {
    if (this.opt.role !== 'relay') throw new Error('only the relay opens streams')
    if (this.closed) throw new Error('mux closed')
    // encode first: an OPEN that can't be encoded (FrameError) must not leave a stream behind
    const payload = jsonPayload(meta)
    const id = this.nextId
    this.nextId += 2
    const s = new Stream(this, id, meta)
    this.streams.set(id, s)
    this.stats.streamsOpened++
    this.ctrlFrame(encodeFrame(FrameType.OPEN, id, 0, payload))
    return s
  }

  ping(): void {
    this.pingOutstanding = true
    this.ctrlFrame(encodeFrame(FrameType.PING, 0, 0, pingPayload(now())))
  }
  goaway(g: Goaway): void { this.ctrlFrame(encodeFrame(FrameType.GOAWAY, 0, 0, jsonPayload(g))) }
  event(e: RelayEvent): void { this.ctrlFrame(encodeFrame(FrameType.EVENT, 0, 0, jsonPayload(e))) }

  /** queue a control frame (sent before any DATA) */
  ctrlFrame(f: Uint8Array): void {
    if (this.closed) return
    this.ctrl.push(f)
    this.ctrlBytes += f.byteLength
    this.pump()
  }

  markReady(s: Stream): void {
    if (this.closed || s.inReady || !s.canSend()) return
    s.inReady = true
    this.ready.push(s)
    this.pump()
  }

  /** Send queued frames while the transport has room. Call again when the transport drains. */
  pump(): void {
    if (this.closed) return
    let n = 0
    while (this.io.buffered() < this.opt.highWater) {
      let f = this.ctrl.shift()
      if (f) {
        this.ctrlBytes -= f.byteLength
        if (f[0] === FrameType.PONG) this.pongQueued = false
      } else {
        const s = this.ready.shift()
        if (!s) break
        s.inReady = false
        f = s.takeFrame(this.quantum)
        if (s.canSend()) { s.inReady = true; this.ready.push(s) }
        if (!f) continue
      }
      try {
        this.io.send(f)
      } catch {
        this.close('transport send failed')
        return
      }
      this.stats.framesOut++
      this.stats.bytesOut += f.byteLength
      if (++n >= 256) { this.later(0); return } // let reads run
    }
    if (this.ctrl.length || this.ready.length) this.later(5)
  }
  private later(ms: number): void {
    if (this.timer || this.closed) return
    this.timer = setTimeout(() => { this.timer = null; this.pump() }, ms)
  }

  /** Feed one WebSocket message. Throws FrameError on a malformed frame: the caller closes the connection (4004). */
  onMessage(buf: Uint8Array): void {
    if (this.closed) return
    this.lastRecv = Date.now()
    this.pingOutstanding = false
    this.stats.bytesIn += buf.byteLength
    for (const fr of decodeFrames(buf)) {
      this.stats.framesIn++
      const s = this.streams.get(fr.id)
      switch (fr.type) {
        case FrameType.OPEN: {
          if (this.opt.role === 'relay') throw new FrameError('the relay accepts no streams')
          if (fr.id % 2 !== 1 || fr.id <= this.highestPeerId) throw new FrameError(`bad stream id ${fr.id}`)
          this.highestPeerId = fr.id
          let meta: OpenMeta
          try {
            meta = parseOpenMeta(parseJsonPayload(fr.payload))
          } catch (e) {
            // one bad request head resets its own stream only, never the whole connection (and everyone's streams)
            this.ctrlFrame(encodeFrame(FrameType.RST, fr.id, 0, rstPayload(RstCode.PROTOCOL, e instanceof Error ? e.message : 'bad OPEN')))
            break
          }
          if (this.streams.size >= this.opt.maxStreams) {
            this.ctrlFrame(encodeFrame(FrameType.RST, fr.id, 0, rstPayload(RstCode.REFUSED, 'too many streams')))
            break
          }
          const ns = new Stream(this, fr.id, meta)
          this.streams.set(fr.id, ns)
          this.stats.streamsOpened++
          this.opt.onOpen?.(ns)
          break
        }
        case FrameType.RESPONSE:
          if (this.opt.role !== 'relay') throw new FrameError('RESPONSE sent to the team side')
          s?.recvResponse(parseResponseHead(parseJsonPayload(fr.payload)))
          break
        case FrameType.DATA:
          s?.recv(fr.payload, fr.flags)
          break
        case FrameType.END:
          s?.recvEnd()
          break
        case FrameType.RST:
          if (s) { const r = parseRst(fr.payload); s.recvRst(r.code, r.reason) }
          break
        case FrameType.WINDOW:
          if (s) s.grant(readU32(fr.payload))
          break
        case FrameType.PING:
          if (this.pongQueued) break
          this.pongQueued = true
          this.ctrlFrame(encodeFrame(FrameType.PONG, 0, 0, fr.payload.slice()))
          break
        case FrameType.PONG:
          this.lastPongAt = Date.now()
          this.opt.onPong?.(now() - readPing(fr.payload))
          break
        case FrameType.GOAWAY:
          this.opt.onGoaway?.(parseGoaway(parseJsonPayload(fr.payload)))
          break
        case FrameType.EVENT:
          this.opt.onEvent?.(parseRelayEvent(parseJsonPayload(fr.payload)))
          break
      }
    }
    if (this.ctrlBytes > (this.opt.maxCtrlQueue ?? MAX_CTRL_QUEUE_BYTES)) throw new FrameError('peer is not reading its connection')
  }

  /** The transport died: reset every stream on it locally (only the streams of this connection are affected). */
  close(reason = 'connection lost'): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    const all = [...this.streams.values()]
    this.streams.clear()
    this.ctrl = []
    this.ctrlBytes = 0
    this.ready = []
    for (const s of all) s.recvRst(RstCode.CONN_LOST, reason)
  }
}

type OutItem = { b: Uint8Array; f: number } | { close: Uint8Array }

export class Stream {
  readonly mux: Mux
  readonly id: number
  readonly meta: OpenMeta
  readonly openedAt = Date.now()
  sendWin: number
  recvWin: number
  private unacked = 0
  private out: OutItem[] = []
  /** queued, not yet sent DATA bytes (producer backpressure, slow-client checks) */
  outBytes = 0
  endQueued = false
  endSent = false
  endRecv = false
  /** WebSocket: the peer's close piece arrived (nothing but END may follow) */
  wsCloseRecv = false
  reset: { code: number; reason: string } | null = null
  head: ResponseHead | null = null
  inReady = false
  bytesSent = 0
  bytesRecv = 0
  private waiters: (() => void)[] = []

  onData?: (b: Uint8Array, flags: number) => void
  onEnd?: () => void
  onRst?: (code: number, reason: string) => void
  onResponse?: (head: ResponseHead) => void

  constructor(mux: Mux, id: number, meta: OpenMeta) {
    this.mux = mux
    this.id = id
    this.meta = meta
    this.sendWin = mux.opt.initialWindow
    this.recvWin = mux.opt.initialWindow
  }

  get isWs(): boolean { return this.meta.kind === 'ws' }
  get done(): boolean { return this.reset !== null || (this.endSent && this.endRecv) }
  /** largest WebSocket piece: never more than a quarter window, so a window update always fits one */
  private get wsPiece(): number { return Math.min(MAX_PAYLOAD, Math.max(1024, Math.floor(this.mux.opt.initialWindow / 4))) }

  canSend(): boolean {
    if (this.reset) return false
    const head = this.out[0]
    if (head) {
      if ('close' in head) return true
      return this.isWs ? this.sendWin >= head.b.byteLength : this.sendWin > 0
    }
    return this.endQueued && !this.endSent
  }

  /** team side: send the response head (before any DATA) */
  respond(head: ResponseHead): void {
    if (this.reset || this.head) return
    this.head = head
    this.mux.ctrlFrame(encodeFrame(FrameType.RESPONSE, this.id, 0, jsonPayload(head)))
  }

  /**
   * Queue bytes. HTTP: any size (split as the window allows). WebSocket: one whole message, split into pieces with
   * WS_CONT. Returns a promise while the local queue is above one window (await it to apply backpressure).
   */
  write(b: Uint8Array, flags = 0): Promise<void> | undefined {
    if (this.reset || this.endQueued) return undefined
    if (this.isWs) {
      const piece = this.wsPiece
      if (b.byteLength === 0) this.out.push({ b, f: flags & DataFlag.WS_BINARY })
      for (let o = 0; o < b.byteLength; o += piece) {
        const part = b.subarray(o, Math.min(b.byteLength, o + piece))
        const last = o + piece >= b.byteLength
        this.out.push({ b: part, f: (flags & DataFlag.WS_BINARY) | (last ? 0 : DataFlag.WS_CONT) })
      }
    } else {
      if (b.byteLength === 0) return undefined
      this.out.push({ b, f: 0 })
    }
    this.outBytes += b.byteLength
    this.mux.markReady(this)
    if (this.outBytes > this.mux.opt.initialWindow) return new Promise<void>((r) => this.waiters.push(r))
    return undefined
  }

  /** WebSocket close (after the queued messages), then END. The close piece needs no window. */
  wsClose(code: number, reason = ''): void {
    if (this.reset || this.endQueued) return
    this.out.push({ close: closePayload(code, reason) })
    this.endQueued = true
    this.mux.markReady(this)
  }

  /**
   * Half-close. `cancelUnread`: once END is on the wire, reset the stream if the peer is still sending (an HTTP
   * answer is complete but the app did not want the rest of the request body: stop the upload instead of carrying it).
   */
  end(o: { cancelUnread?: boolean } = {}): void {
    if (this.reset || this.endQueued) return
    this.endQueued = true
    this.cancelUnread = !!o.cancelUnread
    this.mux.markReady(this)
  }
  private cancelUnread = false

  rst(code: number, reason = ''): void {
    if (this.reset) return
    this.reset = { code, reason }
    this.mux.ctrlFrame(encodeFrame(FrameType.RST, this.id, 0, rstPayload(code, reason)))
    this.out = []
    this.outBytes = 0
    this.wake()
    this.mux.streams.delete(this.id)
  }

  /** Receiver: bytes reached their final consumer; return window to the sender. */
  consumed(n: number): void {
    if (this.reset || n <= 0) return
    this.unacked += n
    if (this.unacked >= this.mux.opt.initialWindow / 4) {
      this.recvWin += this.unacked
      this.mux.ctrlFrame(encodeFrame(FrameType.WINDOW, this.id, 0, u32(this.unacked)))
      this.unacked = 0
    }
  }

  /** resolves when the local queue is at most one window (or the stream ended / was reset) */
  drained(): Promise<void> {
    if (this.reset || this.outBytes <= this.mux.opt.initialWindow) return Promise.resolve()
    return new Promise<void>((r) => this.waiters.push(r))
  }

  takeFrame(quantum: number): Uint8Array | undefined {
    if (this.reset) return undefined
    const head = this.out[0]
    if (!head) {
      if (this.endQueued && !this.endSent) {
        this.endSent = true
        this.maybeDone()
        // after the END frame this returns has been sent (pump sends it right away)
        if (this.cancelUnread && !this.endRecv) queueMicrotask(() => { if (!this.endRecv) this.rst(RstCode.CANCEL, 'request body not read') })
        return encodeFrame(FrameType.END, this.id)
      }
      return undefined
    }
    if ('close' in head) {
      this.out.shift()
      return encodeFrame(FrameType.DATA, this.id, DataFlag.WS_CLOSE, head.close)
    }
    // WebSocket pieces are never split further; HTTP bytes are cut to the quantum and the window
    const n = this.isWs ? head.b.byteLength : Math.min(head.b.byteLength, quantum, this.sendWin)
    if (n > this.sendWin || (n === 0 && head.b.byteLength > 0)) return undefined
    const piece = head.b.subarray(0, n)
    if (n < head.b.byteLength) head.b = head.b.subarray(n)
    else this.out.shift()
    this.sendWin -= n
    this.outBytes -= n
    this.bytesSent += n
    if (this.outBytes <= this.mux.opt.initialWindow) this.wake()
    return encodeFrame(FrameType.DATA, this.id, head.f, piece)
  }

  grant(n: number): void {
    if (this.reset) return
    this.sendWin += n
    if (this.sendWin > 0x7fffffff) { this.rst(RstCode.FLOW_CONTROL, 'window overflow'); this.onRst?.(RstCode.FLOW_CONTROL, 'window overflow'); return }
    this.mux.markReady(this)
  }

  recv(b: Uint8Array, flags: number): void {
    if (this.reset) return
    if (this.endRecv) { this.protocolReset('DATA after END'); return }
    // the relay's streams answer with RESPONSE before any DATA (the scheduler sends control frames first)
    if (this.mux.opt.role === 'relay' && !this.head) { this.protocolReset('DATA before RESPONSE'); return }
    if (this.wsCloseRecv) { this.protocolReset('DATA after WebSocket close'); return }
    if (flags & DataFlag.WS_CLOSE) {
      if (!this.isWs) { this.protocolReset('WS_CLOSE on an HTTP stream'); return }
      this.wsCloseRecv = true
      this.onData?.(b.slice(), flags)
      return
    }
    if (!this.isWs && flags !== 0) { this.protocolReset('WebSocket flags on an HTTP stream'); return }
    this.recvWin -= b.byteLength
    this.bytesRecv += b.byteLength
    if (this.recvWin < 0) {
      this.rst(RstCode.FLOW_CONTROL, 'window exceeded')
      this.onRst?.(RstCode.FLOW_CONTROL, 'window exceeded')
      return
    }
    this.onData?.(b.slice(), flags) // copy: the transport may reuse its buffer
  }

  recvResponse(h: ResponseHead): void {
    if (this.reset) return
    if (this.head) { this.protocolReset('second RESPONSE'); return }
    this.head = h
    this.onResponse?.(h)
  }

  recvEnd(): void {
    if (this.reset || this.endRecv) return
    this.endRecv = true
    this.onEnd?.()
    this.maybeDone()
  }

  recvRst(code: number, reason: string): void {
    if (this.reset) return
    this.reset = { code, reason }
    this.out = []
    this.outBytes = 0
    this.wake()
    this.mux.streams.delete(this.id)
    this.onRst?.(code, reason)
  }

  private protocolReset(why: string): void {
    this.rst(RstCode.PROTOCOL, why)
    this.onRst?.(RstCode.PROTOCOL, why)
  }
  private wake(): void {
    const w = this.waiters
    this.waiters = []
    for (const f of w) f()
  }
  private maybeDone(): void {
    if (this.endSent && this.endRecv) {
      this.mux.streams.delete(this.id)
      this.wake()
    }
  }
}

/** WebSocket close piece of a DATA frame */
export function readWsClose(b: Uint8Array): { code: number; reason: string } { return parseClose(b) }

/**
 * Pull-based ReadableStream over a stream's incoming DATA (HTTP request or response body). Window is returned only
 * as the consumer reads, so a slow reader stops the sender after one window.
 */
export function streamBody(s: Stream): ReadableStream<Uint8Array> {
  const q: Uint8Array[] = []
  let ended = false
  let err: Error | null = null
  let notify: (() => void) | null = null
  const wake = () => { const n = notify; notify = null; n?.() }
  s.onData = (b) => { q.push(b); wake() }
  s.onEnd = () => { ended = true; wake() }
  s.onRst = (c, r) => { err = new Error(`stream reset (${c}${r ? ` ${r}` : ''})`); wake() }
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      while (!q.length && !ended && !err) await new Promise<void>((r) => { notify = r })
      if (q.length) {
        const b = q.shift()!
        ctrl.enqueue(b)
        s.consumed(b.byteLength)
        return
      }
      if (err) { ctrl.error(err); return }
      ctrl.close()
    },
    cancel() { s.rst(RstCode.CANCEL, 'body not read') },
  }, { highWaterMark: 0 })
}
