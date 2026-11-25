// Turn the pane's internal tool result into the wire shape (shared/src/api/browser.ts BrowserResult):
// at most 20 content items, text <= 2 MB, images <= 20 MB base64, error <= 4000 characters.
// Pure: unit-tested in tests/unit/e-desktop-common.test.ts.
import { BrowserSiteKey, type BrowserResult } from '@mycel/shared/api'

export type PaneContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; share?: boolean }

export interface PaneResult {
  content: PaneContent[]
  isError: boolean
}

export const MAX_ITEMS = 20
export const MAX_TEXT = 2_000_000
export const MAX_IMAGE = 20_000_000
export const MAX_ERROR = 4000
const MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 40)}\n… (truncated, ${s.length} characters)` : s)

export function toBrowserResult(callId: string, r: PaneResult): BrowserResult {
  const texts: string[] = []
  const images: { type: 'image'; mime: 'image/png' | 'image/jpeg' | 'image/webp'; data: string; shareToChat?: boolean }[] = []
  let dropped = 0
  for (const c of r.content) {
    if (c.type === 'text') texts.push(c.text)
    else if (!MIMES.has(c.mimeType) || c.data.length > MAX_IMAGE) dropped++
    else images.push({ type: 'image', mime: c.mimeType as 'image/png', data: c.data, ...(c.share ? { shareToChat: true } : {}) })
  }
  // one text item first (batches interleave many short texts), then the newest images that fit
  const keepImages = images.slice(-(MAX_ITEMS - 1))
  dropped += images.length - keepImages.length
  if (dropped) texts.push(`(${dropped} image${dropped === 1 ? '' : 's'} left out: too many or too large; take a new screenshot if you need one.)`)
  const text = cut(texts.join('\n'), MAX_TEXT)
  const content: BrowserResult['content'] = [{ type: 'text', text }, ...keepImages]
  return r.isError ? { callId, ok: false, content, error: cut(text || 'Browser tool failed.', MAX_ERROR) } : { callId, ok: true, content }
}

export function errorResult(callId: string, message: string): BrowserResult {
  return { callId, ok: false, content: [{ type: 'text', text: message }], error: cut(message, MAX_ERROR) }
}

/** Approximate memory a result holds (text characters + base64 image characters). */
export function resultBytes(r: BrowserResult): number {
  let n = r.error?.length ?? 0
  for (const c of r.content) n += c.type === 'text' ? c.text.length : c.data.length
  return n
}

/** At most this many hosts of each kind go back with one result (BrowserResult.always). */
export const ALWAYS_BACK_MAX = 50

/**
 * The result with the hosts the person answered "Always allow" to during the call (BrowserResult.always), so the team
 * server keeps them as the person's own allowance on every computer (docs/decisions/20261125-one-site-always-desktop-
 * browser.md). Unchanged when there were none.
 */
export function withAlways(r: BrowserResult, always: { site: ReadonlySet<string>; private: ReadonlySet<string> } | undefined): BrowserResult {
  const sites = [...(always?.site ?? [])].filter(okKey).slice(0, ALWAYS_BACK_MAX)
  const office = [...(always?.private ?? [])].filter(okKey).slice(0, ALWAYS_BACK_MAX)
  if (!sites.length && !office.length) return r
  return { ...r, always: { ...(sites.length ? { sites } : {}), ...(office.length ? { office } : {}) } }
}
const okKey = (k: string) => BrowserSiteKey.safeParse(k).success

/**
 * "Always allow" answers on this computer's site cards that have not gone to the team server yet. Each entry belongs to
 * the person signed in when it was pressed and goes only with that person's results (never the next person's after a
 * sign-out). An entry rides exactly one result (take), then it is gone: a site the person removes in Settings afterwards
 * is never sent again. The caller takes only for a result that goes out (not for a call that was stopped or ran out of
 * time), so an Always answered then waits for the next result.
 */
export class PendingAlways {
  private items = new Map<string, { scope: 'site' | 'private'; host: string; owner: string | null }>()

  add(scope: 'site' | 'private', host: string, owner: string | null) {
    this.items.set(`${scope}\u0000${host}`, { scope, host, owner })
    while (this.items.size > ALWAYS_BACK_MAX * 2) this.items.delete(this.items.keys().next().value as string)
  }

  /** What goes with this result for `owner` (signed in now), taken out; entries of anyone else are dropped. */
  take(owner: string | null): { site: Set<string>; private: Set<string> } {
    const out = { site: new Set<string>(), private: new Set<string>() }
    for (const [k, e] of this.items) {
      this.items.delete(k)
      if (owner !== null && e.owner === owner) out[e.scope].add(e.host)
    }
    return out
  }

  clear() {
    this.items.clear()
  }

  get size() {
    return this.items.size
  }
}
