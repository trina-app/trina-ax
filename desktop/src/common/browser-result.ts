// Turn the pane's internal tool result into the wire shape (shared/src/api/browser.ts BrowserResult):
// at most 20 content items, text <= 2 MB, images <= 20 MB base64, error <= 4000 characters.
// Pure: unit-tested in tests/unit/e-desktop-common.test.ts.
import type { BrowserResult } from '@mycel/shared/api'

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
