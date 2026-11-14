// An app's card as stored and shown (docs/DECISIONS.md "Apps posting in rooms"): every field plain text, one line,
// bounded, without control, bidi or zero-width characters; at most one link, https only and without a user name or
// password, shown with its host. room_messages.body holds the card's plain text with Markdown marks escaped, so the
// readers that render a person's message as Markdown (the web app, older phone apps, export) show it as text and
// nothing in it can mention, link or format.
import { ROOM_APP_LINE_MAX, ROOM_APP_TEXT_MAX, ROOM_APP_TITLE_MAX, type RoomAppCard } from '@mycel/shared/api'

/** One line of text from outside: no control or format characters (bidi overrides, zero-width), spaces made single,
 * at most `max` characters (then "…"). */
export function line(s: unknown, max = ROOM_APP_LINE_MAX): string {
  if (typeof s !== 'string' && typeof s !== 'number') return ''
  const one = String(s).replace(/[\p{Cf}]/gu, '').replace(/[\p{Cc}\u2028\u2029]/gu, ' ').replace(/\s+/g, ' ').trim()
  return cut(one, max)
}

/** At most `max` characters and at most `max` UTF-16 units (the contracts' limits count those), then "…". */
function cut(s: string, max: number): string {
  const chars = [...s]
  if (chars.length <= max && s.length <= max) return s
  let out = chars.slice(0, max - 1)
  while (out.join('').length > max - 1) out = out.slice(0, -1)
  return out.join('').trimEnd() + '…'
}

/** Text from outside that may keep its line breaks (an "Other" app's text): the same cleaning per line, at most `max`. */
export function lines(s: unknown, max = ROOM_APP_TEXT_MAX): string {
  if (typeof s !== 'string') return ''
  const out = s.replace(/\r\n?/g, '\n').split('\n').map((l) => line(l, max)).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return cut(out, max)
}

/** The one link a card may carry: https, a host, no user name or password, at most 2048 characters. Else none. */
export function safeLink(u: unknown): { url: string; host: string } | undefined {
  if (typeof u !== 'string' || u.length > 2048) return undefined
  let x: URL
  try { x = new URL(u.trim()) } catch { return undefined }
  if (x.protocol !== 'https:' || !x.hostname || x.username || x.password || x.href.length > 2048) return undefined
  return { url: x.href, host: x.hostname }
}

/** Markdown's marks escaped (and "@" so no mention is read from it): the body readers that render Markdown show the
 * characters as typed. Only what makes Markdown (emphasis, code, links and pictures, HTML, headings, tables, quotes,
 * entities; list and heading marks at a line's start), so search still finds "checkout-web" or "app.ts". */
export const escapeMarkdown = (s: string) => s
  .replace(/[\\`*_[\]<>#|~@&]/g, (c) => `\\${c}`)
  .replace(/^(\s*)([-+=])/gm, '$1\\$2')
  .replace(/^(\s*\d+)([.)])/gm, '$1\\$2')
/** The other way (a push's line, the rooms list's excerpt, search): the plain text again. */
export const unescapeMarkdown = (s: string) => s.replace(/^<(https:\/\/[^\s<>]+)>$/gm, '$1').replace(/\\([\\`*_[\]<>#|~@&\-+=.)/])/g, '$1')
/** Addresses in text from outside are never links (only the card's one checked link is): "://" and "www." escaped, so
 * no renderer's autolinking takes them. */
const unlink = (escaped: string) => escaped.replace(/:\/\//g, ':\\/\\/').replace(/\bwww\./gi, (w) => `${w.slice(0, 3)}\\.`)

/** A card with every field cleaned and bounded. */
export function cleanCard(c: { kind?: string; title: string; details?: string[]; status?: string; link?: unknown; unverified?: boolean }): RoomAppCard {
  const kind = line(c.kind ?? '')
  const status = line(c.status ?? '')
  const link = safeLink(c.link)
  return {
    ...(kind ? { kind } : {}),
    title: line(c.title, ROOM_APP_TITLE_MAX) || '…',
    details: (c.details ?? []).map((d) => line(d)).filter(Boolean).slice(0, 3),
    ...(status ? { status } : {}),
    ...(link ? { link } : {}),
    ...(c.unverified ? { unverified: true as const } : {}),
  }
}

/** The card as one plain text (the app's name first): what search, push, export and the AI read. `extra`: more of it
 * than the card shows (an Other app's whole text, all of a form's answers), already cleaned. */
export function plainText(app: string, card: RoomAppCard, extra?: string): string {
  const words = textPart(app, card, extra)
  return card.link ? `${words}\n${card.link.url}` : words
}
function textPart(app: string, card: RoomAppCard, extra?: string): string {
  const head = [card.kind, card.title].filter(Boolean).join(' · ')
  const parts = [`${app}: ${head}`, ...card.details, ...(extra ? [extra] : []), ...(card.status ? [card.status] : [])]
  const text = parts.join('\n')
  const chars = [...text]
  return chars.length > ROOM_APP_TEXT_MAX + 600 ? chars.slice(0, ROOM_APP_TEXT_MAX + 599).join('') + '…' : text
}

/** The stored body: the plain text with Markdown marks escaped and its addresses unlinked; the card's one checked https
 * link on the last line as an autolink `<url>` (a parsed URL has no spaces, "<" or ">"; its "[", "]", "(" and ")" can
 * then make no second link). */
export const bodyOf = (app: string, card: RoomAppCard, extra?: string) => {
  const words = unlink(escapeMarkdown(textPart(app, card, extra)))
  return card.link ? `${words}\n<${card.link.url}>` : words
}

/** A stored card, or null when it is not one this build reads. */
export function parseCard(s: string | null): RoomAppCard | null {
  if (!s) return null
  try {
    const v = JSON.parse(s) as Partial<RoomAppCard> & { app?: unknown }
    if (typeof v?.title !== 'string') return null
    return cleanCard({ kind: v.kind, title: v.title, details: Array.isArray(v.details) ? v.details.filter((d): d is string => typeof d === 'string') : [], status: v.status, link: v.link?.url, unverified: !!v.unverified })
  } catch { return null }
}

/** What room_messages.app_card holds: the card and the app as it was (name, kind; example). */
export interface StoredCard extends RoomAppCard { app: { name: string; kind: string; preset?: string }; example?: true }
export function parseStored(s: string | null): { card: RoomAppCard; app: { name: string; kind: string; preset?: string }; example: boolean } | null {
  const card = parseCard(s)
  if (!card) return null
  try {
    const v = JSON.parse(s!) as Partial<StoredCard>
    const name = typeof v.app?.name === 'string' ? line(v.app.name, 40) : ''
    const kind = typeof v.app?.kind === 'string' ? v.app.kind : 'other'
    const preset = typeof v.app?.preset === 'string' ? v.app.preset : undefined
    return { card, app: { name: name || 'App', kind, ...(preset ? { preset } : {}) }, example: !!v.example }
  } catch { return null }
}
