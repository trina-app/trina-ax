// What the gate keeps across a restart (stateDir/state.json): the start times per visitor address (for the hourly and
// daily start limits) and the UTC day's weighted tokens (the global daily cap). Addresses are stored as a keyed hash
// (the key lives beside the file, 0600), never in the clear.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const HOUR = 3600_000
const DAY = 24 * HOUR

interface Saved { day: string; tokens: number; starts: Record<string, number[]> }

export const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10)

export class GateState {
  private file: string
  private key: Buffer
  private day: string
  private tokens = 0
  private starts = new Map<string, number[]>()
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.file = path.join(dir, 'state.json')
    const keyFile = path.join(dir, 'ip-key')
    try { this.key = fs.readFileSync(keyFile) } catch { this.key = crypto.randomBytes(32); fs.writeFileSync(keyFile, this.key, { mode: 0o600 }) }
    this.day = utcDay()
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Saved
      if (s.day === this.day && typeof s.tokens === 'number') this.tokens = s.tokens
      for (const [k, v] of Object.entries(s.starts ?? {})) if (Array.isArray(v)) this.starts.set(k, v.filter((x) => typeof x === 'number'))
    } catch {}
  }
  /** the keyed hash an address is stored under (and listed under in limits.exemptIpHashes) */
  hash(ip: string): string { return crypto.createHmac('sha256', this.key).update(ip).digest('hex').slice(0, 32) }
  private h(ip: string) { return this.hash(ip) }

  /** is this address in limits.exemptIpHashes (a full hash or a prefix of one, lower case)? */
  isExempt(ip: string, exempt: readonly string[]): boolean {
    if (!exempt.length) return false
    const k = this.hash(ip)
    return exempt.some((x) => x.length >= 8 && k.startsWith(x))
  }

  /** null = may start now; else which limit says no. A listed address (`exempt`) is never refused here */
  startRefusal(ip: string, perHour: number, perDay: number, now = Date.now(), exempt: readonly string[] = []): 'hour' | 'day' | null {
    if (this.isExempt(ip, exempt)) return null
    const list = (this.starts.get(this.h(ip)) ?? []).filter((t) => now - t < DAY)
    if (list.length >= perDay) return 'day'
    if (list.filter((t) => now - t < HOUR).length >= perHour) return 'hour'
    return null
  }
  noteStart(ip: string, now = Date.now()): void {
    const k = this.h(ip)
    this.starts.set(k, [...(this.starts.get(k) ?? []).filter((t) => now - t < DAY), now])
    this.save()
  }

  /** how many distinct addresses started in the last 24 hours (the count of keyed hashes; nothing else is read) */
  distinctStarters(now = Date.now()): number {
    let n = 0
    for (const v of this.starts.values()) if (v.some((t) => now - t < DAY)) n++
    return n
  }

  dailyTokens(now = Date.now()): number { this.roll(now); return this.tokens }
  addTokens(n: number, now = Date.now()): void { if (n > 0) { this.roll(now); this.tokens += n; this.save() } }
  private roll(now: number) { const d = utcDay(now); if (d !== this.day) { this.day = d; this.tokens = 0 } }

  private save() {
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, 500)
    this.timer.unref?.()
  }
  flush(): void {
    const now = Date.now()
    const starts: Record<string, number[]> = {}
    for (const [k, v] of this.starts) { const kept = v.filter((t) => now - t < DAY); if (kept.length) starts[k] = kept }
    const tmp = this.file + '.tmp'
    try { fs.writeFileSync(tmp, JSON.stringify({ day: this.day, tokens: this.tokens, starts } satisfies Saved), { mode: 0o600 }); fs.renameSync(tmp, this.file) } catch {}
  }
}
