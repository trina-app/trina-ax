import { base64Size, MAX_FILE_BYTES, parseMessage, sameTeam, TRANSFER_IDLE_MS, type FileMessage, type MobileConfig, type MobileReply } from './protocol'
export interface TransferIO {
  create(id: string, name: string, mime: string): Promise<void>
  append(id: string, b64: string): Promise<void>
  inspect(id: string): Promise<{ size: number; sha256: string }>
  share(id: string): Promise<void>
  remove(id: string): Promise<void>
}
interface Transfer { id: string; generation: number; nonce: string; size: number; hash: string; bytes: number; seq: number; queued: number; ended: boolean; cancelled: boolean; queue: Promise<void>; timer: ReturnType<typeof setTimeout> | null }
/** One transfer, bounded reservations and a queue that awaits every native write. Cancellation fences pending work
 * immediately; deletion runs after the in-flight write settles, so a late write cannot recreate a removed cache. */
export class FileTransfers {
  private active: Transfer | null = null
  private used = new Set<string>()
  constructor(private io: TransferIO, private timeout = TRANSFER_IDLE_MS) {}
  private touch(t: Transfer) {
    if (t.timer) clearTimeout(t.timer)
    t.timer = setTimeout(() => { void this.cancel(t) }, this.timeout)
  }
  private async cancel(t: Transfer) {
    t.cancelled = true
    if (t.timer) clearTimeout(t.timer)
    if (this.active === t) this.active = null
    await t.queue.catch(() => {})
    await this.io.remove(t.id).catch(() => {})
  }
  private enqueue(t: Transfer, action: () => Promise<void>): Promise<void> {
    t.queued++
    const pending = t.queue.then(async () => {
      if (t.cancelled || this.active !== t) throw new Error('transfer_cancelled')
      await action()
      if (t.cancelled) throw new Error('transfer_cancelled')
    }).catch(async () => {
      t.cancelled = true
      if (t.timer) clearTimeout(t.timer)
      if (this.active === t) this.active = null
      await this.io.remove(t.id).catch(() => {})
      throw new Error('transfer_failed')
    }).finally(() => { t.queued-- })
    t.queue = pending.catch(() => {})
    return pending
  }
  async receive(m: FileMessage): Promise<void> {
    // Also validate direct callers, not only the WebView controller.
    if (!parseMessage(JSON.stringify(m))) throw new Error('invalid_message')
    if (m.type === 'file-begin') {
      if (this.active || this.used.has(m.id) || this.used.size >= 200) throw new Error('transfer_busy')
      this.used.add(m.id)
      const t: Transfer = { id: m.id, generation: m.generation, nonce: m.nonce, size: m.size, hash: m.sha256, bytes: 0, seq: 0, queued: 0, ended: false, cancelled: false, queue: Promise.resolve(), timer: null }
      this.active = t; this.touch(t)
      return this.enqueue(t, () => this.io.create(m.id, m.name, m.mime))
    }
    const t = this.active
    if (!t || m.id !== t.id || m.generation !== t.generation || m.nonce !== t.nonce) throw new Error('transfer_missing')
    if (m.type === 'file-abort') { await this.cancel(t); return }
    if (t.ended || t.queued >= 4 || m.seq !== t.seq) { await this.cancel(t); throw new Error('transfer_sequence') }
    this.touch(t)
    if (m.type === 'file-chunk') {
      const bytes = base64Size(m.b64)!
      if (t.bytes + bytes > t.size || t.bytes + bytes > MAX_FILE_BYTES) { await this.cancel(t); throw new Error('transfer_size') }
      t.seq++; t.bytes += bytes
      return this.enqueue(t, () => this.io.append(t.id, m.b64))
    }
    t.ended = true
    return this.enqueue(t, async () => {
      if (t.bytes !== t.size) throw new Error('transfer_size')
      const actual = await this.io.inspect(t.id)
      if (t.cancelled || this.active !== t || actual.size !== t.size || actual.sha256 !== t.hash) throw new Error('transfer_integrity')
      if (t.timer) clearTimeout(t.timer)
      await this.io.share(t.id)
      await this.io.remove(t.id)
      if (this.active === t) this.active = null
    })
  }
  async clear(): Promise<void> {
    const t = this.active
    if (t) await this.cancel(t)
    this.used.clear()
  }
}

/** Native side: source URL plus a top-frame-only capability nonce bind requests to this WebView document. */
export class MobileReceiver {
  private enabled = true
  constructor(readonly origin: string, public config: MobileConfig, private files: FileTransfers, private external: (url: string) => Promise<void>) {}
  async disable() { this.enabled = false; this.config = { ...this.config, generation: this.config.generation + 1 }; await this.files.clear() }
  activate(config: MobileConfig) { this.config = config; this.enabled = true }
  async receive(raw: string, sourceUrl: string): Promise<MobileReply | null> {
    if (!this.enabled || !sameTeam(this.origin, sourceUrl)) return null
    const m = parseMessage(raw), current = this.config
    if (!m || m.generation !== current.generation || m.nonce !== current.nonce) return null
    const reply: MobileReply = { v: 1, type: 'mobile-result', id: m.id, nonce: m.nonce, generation: m.generation, for: m.type, ok: true, ...('seq' in m ? { seq: m.seq } : {}) }
    if (m.type === 'session-reset') {
      // Fence old work synchronously, before the first await.
      this.config = { ...current, generation: current.generation + 1 }
      await this.files.clear()
      return this.enabled && this.config.nonce === current.nonce ? { ...reply, nextGeneration: this.config.generation } : null
    }
    try {
      if (m.type === 'external-open') await this.external(m.url)
      else await this.files.receive(m)
    } catch { reply.ok = false; reply.error = 'mobile_operation_failed' }
    return this.enabled && this.config === current ? reply : null
  }
}
