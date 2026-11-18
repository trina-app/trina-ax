// A card's long text (docs/decisions/20261118-api-images-connector-cap-delete-cards.md): a write through a connected
// service may hold up to MAX_CARD_PAYLOAD (10,000,000) characters, more than an event or a card should carry. The card
// carries the start of such a text with its full size (`fullChars`); the whole text stays with the open card on the
// server and is read on request (GET /api/turns/:id/requests/:requestId/details/:index), only by the turn's own person,
// only while the card is open. So the person can still check every character before anything goes out.
import type { TurnRequest } from '@mycel/shared/api'

/** characters of one detail's text a card carries (the largest a card showed whole before) */
export const CARD_TEXT_INLINE = 100_000
/** a folded detail shows this much before "Show all" when it does not name its own fold */
export const CARD_TEXT_PREVIEW = 2_000

/** The start of `s` of at most `n` characters, never ending inside a surrogate pair. */
const head = (s: string, n: number) => s.slice(0, n).replace(/[\uD800-\uDBFF]$/, '')

/** The request as the card carries it, and the full texts it left out (by detail index), or null when nothing was long. */
export function foldCardDetails(request: TurnRequest): { request: TurnRequest; full: Map<number, string> | null } {
  const details = (request as { details?: { text: string; collapsedAt?: number; fullChars?: number }[] }).details
  if (!details?.some((d) => typeof d.text === 'string' && d.text.length > CARD_TEXT_INLINE)) return { request, full: null }
  const full = new Map<number, string>()
  const folded = details.map((d, i) => {
    if (typeof d.text !== 'string' || d.text.length <= CARD_TEXT_INLINE) return d
    full.set(i, d.text)
    // `exact` puts the text behind "show it as it is" because the fields show every value: a folded text cannot say
    // that of itself, so it is shown as a text
    const { exact: _exact, ...rest } = d as typeof d & { exact?: true }
    return { ...rest, text: head(d.text, CARD_TEXT_INLINE), fullChars: d.text.length, collapsedAt: Math.min(d.collapsedAt ?? CARD_TEXT_PREVIEW, CARD_TEXT_INLINE) }
  })
  return { request: { ...request, details: folded } as TurnRequest, full }
}
