// Replay cache for signed HTTP calls (operator API and team-signed registry calls), memory only (one relay process; a
// restart forgets it, which the ±60 s clock window bounds).
//
// The key is who signed (operator key id / team id) plus the SHA-256 of the signed message, not the signature text:
// base64 has more than one spelling of the same bytes (padding dropped, unused low bits of the last character set), so
// keying on the text let the same signed request through again with a re-spelled signature. The message is what the
// signature vouches for; one signed message is accepted once within the window, whatever bytes or spelling carry it.
//
// Room is kept per signer: a signer that sends many calls only pushes out its own oldest entries, never another
// signer's (else one team could flood the cache and then replay a captured call of another team). When the whole cache
// is full of live entries the call is refused ('full') rather than forgetting anyone.
import { createHash } from 'node:crypto'

export type ReplayVerdict = 'ok' | 'replayed' | 'full'

export class ReplayCache {
  /** signer -> (message key -> time it may be used again); insertion order = expiry order (fixed window) */
  private bySigner = new Map<string, Map<string, number>>()
  private total = 0
  private windowMs: number
  private perSignerMax: number
  private totalMax: number

  /** windowMs: how long a signed message is remembered; it must cover the whole clock window (2 × skew + 1 ms) */
  constructor(windowMs: number, perSignerMax: number, totalMax: number) {
    this.windowMs = windowMs
    this.perSignerMax = perSignerMax
    this.totalMax = totalMax
  }

  /** Call only after the signature checked out, so only real signatures take room. 'ok' remembers the call now. */
  check(signer: string, signedMessage: string, now: number): ReplayVerdict {
    let seen = this.bySigner.get(signer)
    if (seen) this.purge(signer, seen, now)
    const key = createHash('sha256').update(signedMessage).digest('hex')
    if (seen?.has(key)) return 'replayed'
    if (this.total >= this.totalMax) {
      for (const [s, m] of this.bySigner) this.purge(s, m, now)
      if (this.total >= this.totalMax) return 'full'
    }
    if (!seen) { seen = new Map(); this.bySigner.set(signer, seen) }
    if (seen.size >= this.perSignerMax) {
      // this signer's own oldest entry goes: a signer that floods past its room loses only its own entries
      const first = seen.keys().next().value
      if (first !== undefined) { seen.delete(first); this.total-- }
    }
    seen.set(key, now + this.windowMs)
    this.total++
    return 'ok'
  }

  private purge(signer: string, seen: Map<string, number>, now: number): void {
    for (const [k, until] of seen) { if (until > now) break; seen.delete(k); this.total-- }
    if (!seen.size) this.bySigner.delete(signer)
  }
}
