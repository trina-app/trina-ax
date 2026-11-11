// Replay cache for signed HTTP calls (operator API and team-signed registry calls), memory only.
//
// The key is who signed (operator key id / team id) plus the SHA-256 of the signed message, not the signature text:
// base64 has more than one spelling of the same bytes (padding dropped, unused low bits of the last character set), so
// keying on the text let the same signed request through again with a re-spelled signature. The message is what the
// signature vouches for; one signed message is accepted once within the window, whatever bytes or spelling carry it.
import { createHash } from 'node:crypto'

export class ReplayCache {
  /** key -> time it may be used again; insertion order = expiry order (fixed window) */
  private seen = new Map<string, number>()
  private windowMs: number
  private max: number

  constructor(windowMs: number, max: number) {
    this.windowMs = windowMs
    this.max = max
  }

  /** true when this signer's signed message was not seen within the window (and remembers it now); false = a replay.
   * Call only after the signature checked out, so only real signatures take room. */
  firstUse(signer: string, signedMessage: string, now: number): boolean {
    for (const [k, until] of this.seen) { if (until > now) break; this.seen.delete(k) }
    const key = `${signer}\n${createHash('sha256').update(signedMessage).digest('hex')}`
    if (this.seen.has(key)) return false
    if (this.seen.size >= this.max) { const first = this.seen.keys().next().value; if (first !== undefined) this.seen.delete(first) }
    this.seen.set(key, now + this.windowMs)
    return true
  }
}
