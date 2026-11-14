// Apps posting in rooms, the parts the app's screens share (docs/DECISIONS.md "Apps posting in rooms";
// components/rooms/apps/*): an app message's plain words, the guide's status line, the side chat's chips.
import type { RoomApp, RoomAppKind, RoomMessage } from '@mycel/shared/api'

/** The server's body escapes Markdown marks (and "@", and "://") so older apps show it as text; the other way. */
export const unescapeAppBody = (s: string) => s.replace(/\\([\\`*_[\]<>#|~@&\-+=.)/:])/g, '$1')

/** An app message's words as plain text (Copy, "Ask Trina about this"): the card's lines, then its link. */
export function appPlainText(m: Pick<RoomMessage, 'app' | 'appCard' | 'body'>): string {
  const c = m.appCard
  if (!c) return unescapeAppBody(m.body)
  const head = [c.kind, c.title].filter(Boolean).join(' · ')
  return [head, ...c.details, ...(c.status ? [c.status] : []), ...(c.link ? [c.link.url] : [])].join('\n')
}

/** What the guide's (and the settings') status line says about an app, newest first: a refusal newer than the last
 * message shown, else connected (the first message shown), else nothing yet. */
export type AppStatus = { kind: 'refused'; at: string; reason: NonNullable<RoomApp['lastRefusal']>['reason'] } | { kind: 'paused'; until: string } | { kind: 'ok'; first: string; last: string } | { kind: 'none' }
export function appStatus(a: Pick<RoomApp, 'lastRefusal' | 'firstOkAt' | 'lastOkAt' | 'pausedUntil'>): AppStatus {
  if (a.pausedUntil) return { kind: 'paused', until: a.pausedUntil }
  const r = a.lastRefusal
  if (r && (!a.lastOkAt || Date.parse(r.at) > Date.parse(a.lastOkAt))) return { kind: 'refused', at: r.at, reason: r.reason }
  if (a.firstOkAt && a.lastOkAt) return { kind: 'ok', first: a.firstOkAt, last: a.lastOkAt }
  return { kind: 'none' }
}

/** GitHub and Other can be tested at once, so their guides say "Nothing yet?" after this long; Sentry and Forms post
 * only when something happens there. */
export const NOTHING_YET_MS = 120_000
export const waitsForEvent = (kind: RoomAppKind) => kind === 'sentry' || kind === 'google_forms'

/** The side chat's chip in a room with apps (owner decision: one chip chosen by the apps there): "Summarise today's
 * responses" when the room's apps are forms only, else "What happened today?". Null: no app has posted here. Read from
 * the messages on screen, so a member (who cannot list the apps) gets it too. */
export function appChip(messages: readonly Pick<RoomMessage, 'app'>[]): 'today' | 'forms' | null {
  const kinds = new Set<RoomAppKind>()
  for (const m of messages) if (m.app && !m.app.example) kinds.add(m.app.kind)
  if (!kinds.size) return null
  return [...kinds].every((k) => k === 'google_forms') ? 'forms' : 'today'
}
