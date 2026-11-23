// What the gateway (gateway.ts) and the team API (api.ts) share: the store, the cryptography, the clock, the mail
// domain, the hosting service's registry of teams, and the held polls to wake when mail comes.
import type { MailCrypto } from './crypto.ts'
import type { MailStore } from './store.ts'

/** The hosting service's registry: the team a relay team key belongs to, when the mailbox serves it now. */
export type TeamLookup = (publicKeySpkiB64: string) => Promise<string | null>

export interface MailboxDeps {
  store: MailStore
  crypto: MailCrypto
  /** the mail domain (lowercase), e.g. the separate mail-in domain; null: not configured (503 not_configured) */
  domain: string | null
  teams: TeamLookup
  now: () => number
  waiters: WaitersLike
  /** the authserv-id whose Authentication-Results header is the receiving service's own (Cloudflare Email Routing) */
  authServId?: string
  /** never given an address or a mail: only a hash prefix and a reason */
  log?: (event: string, fields: Record<string, string | number>) => void
}

/** What a held poll waits on: `wait` ends after `ms`, or earlier when `wake` is called for the team (or, in a store
 * shared by many processes, when the waiter sees an item come). */
export interface WaitersLike {
  wait(teamId: string, ms: number): { done: Promise<void>; cancel: () => void }
  wake(teamId: string): void
}

/** Held polls, per team: a new item (or a newer poll of the same team) wakes them. One process (one Durable Object). */
export class Waiters implements WaitersLike {
  private m = new Map<string, Set<() => void>>()
  wait(teamId: string, ms: number): { done: Promise<void>; cancel: () => void } {
    let wake!: () => void
    const done = new Promise<void>((resolve) => { wake = resolve })
    const set = this.m.get(teamId) ?? new Set<() => void>()
    this.m.set(teamId, set)
    const t = setTimeout(() => finish(), ms)
    const finish = () => { clearTimeout(t); set.delete(finish); if (!set.size) this.m.delete(teamId); wake() }
    set.add(finish)
    return { done, cancel: finish }
  }
  wake(teamId: string) { for (const f of [...(this.m.get(teamId) ?? [])]) f() }
  held(teamId: string): number { return this.m.get(teamId)?.size ?? 0 }
}
