// F2 sleep: the relay asks the control plane to wake a hosted team whose VM sleeps (shared/src/cloud-protocol/relay-ops.ts
// "wake requests"). POST <RELAY_WAKE_URL>/relay/v1/wake { teamId, reason }, Authorization: MycelRelayWake key=…, ts=…,
// sig=… (Ed25519 over wakeSigningString by the relay's wake key; the control plane pins its public key).
// Limits: one call per team per TEAM_GAP_MS (callers in that time share the answer), GLOBAL_PER_MIN calls per minute in
// all, 5 s timeout. A failed call is "unknown" for this request; the next request after the gap asks again.
// The log holds the team id and the answer state only.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { WAKE_API_PATH, wakeAuthorizationHeader, wakeSigningString, type OpsWakeResponse } from '@mycel/shared/cloud-protocol/relay-ops'
import type { RelayLog } from './log.ts'

export const TEAM_GAP_MS = 10_000
export const GLOBAL_PER_MIN = 30
const TIMEOUT_MS = 5_000

export type WakeAnswer = OpsWakeResponse | { state: 'error'; retryAfterSec: number }
export type WakeFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface WakeClientOptions { url: string; keyFile: string; keyId: string; log: RelayLog; fetch?: WakeFetch; now?: () => number }

export class WakeClient {
  private key: crypto.KeyObject
  private lastTs = 0
  private perTeam = new Map<string, { at: number; answer: Promise<WakeAnswer> }>()
  private recent: number[] = []
  readonly counters = { wakeRequests: 0, wakeErrors: 0, wakeLimited: 0 }
  private o: WakeClientOptions

  // no parameter properties: the relay runs as strip-only TypeScript on Node
  constructor(o: WakeClientOptions) {
    this.o = o
    const pem = fs.readFileSync(o.keyFile, 'utf8')
    this.key = crypto.createPrivateKey(pem)
    if (this.key.asymmetricKeyType !== 'ed25519') throw new Error('RELAY_WAKE_KEY_FILE must hold an Ed25519 private key')
  }

  private now(): number { return (this.o.now ?? Date.now)() }

  /** Ask for a wake (or share the answer of a call made in the last TEAM_GAP_MS). */
  wake(teamId: string, reason: 'http' | 'ws'): Promise<WakeAnswer> {
    const now = this.now()
    const hit = this.perTeam.get(teamId)
    if (hit && now - hit.at < TEAM_GAP_MS) return hit.answer
    for (const [k, v] of this.perTeam) if (now - v.at >= TEAM_GAP_MS) this.perTeam.delete(k)
    this.recent = this.recent.filter((t) => now - t < 60_000)
    if (this.recent.length >= GLOBAL_PER_MIN) {
      this.counters.wakeLimited++
      return Promise.resolve({ state: 'error', retryAfterSec: 10 })
    }
    this.recent.push(now)
    const answer = this.call(teamId, reason)
    this.perTeam.set(teamId, { at: now, answer })
    return answer
  }

  private async call(teamId: string, reason: 'http' | 'ws'): Promise<WakeAnswer> {
    this.counters.wakeRequests++
    const body = JSON.stringify({ teamId, reason })
    // Ed25519 is deterministic: the control plane refuses a signature again, so timestamps strictly increase
    const ts = Math.max(this.now(), this.lastTs + 1)
    this.lastTs = ts
    const sig = crypto.sign(null, Buffer.from(wakeSigningString(WAKE_API_PATH, ts, body)), this.key).toString('base64')
    try {
      const f: WakeFetch = this.o.fetch ?? ((u, i) => fetch(u, i))
      const r = await f(this.o.url + WAKE_API_PATH, {
        method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'content-type': 'application/json', authorization: wakeAuthorizationHeader(this.o.keyId, ts, sig) },
      })
      const j = (await r.json().catch(() => null)) as Partial<OpsWakeResponse> | null
      const states = ['waking', 'awake', 'busy', 'unknown']
      if (!r.ok || !j || !states.includes(j.state as string)) {
        this.counters.wakeErrors++
        this.o.log.warn('wake_failed', { team: teamId, status: r.status })
        return { state: 'error', retryAfterSec: 10 }
      }
      const retryAfterSec = Number.isInteger(j.retryAfterSec) && j.retryAfterSec! >= 0 ? Math.min(j.retryAfterSec!, 3600) : 5
      this.o.log.info('wake', { team: teamId, state: j.state })
      return { state: j.state as OpsWakeResponse['state'], retryAfterSec }
    } catch (e) {
      this.counters.wakeErrors++
      this.o.log.warn('wake_failed', { team: teamId, error: (e as Error).name })
      return { state: 'error', retryAfterSec: 10 }
    }
  }
}
