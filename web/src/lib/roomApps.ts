// Apps posting in rooms, the parts the app's screens share (docs/DECISIONS.md "Apps posting in rooms";
// components/rooms/apps/*): an app message's plain words, the guide's status line, the side chat's chips.
import { ROOM_APP_PRESET_NEEDS, ROOM_APP_PRESET_SIGNING, ROOM_APP_PRESET_SWITCHES, ROOM_APP_SWITCHES, RoomAppPreset, type RoomApp, type RoomAppKind, type RoomMessage } from '@mycel/shared/api'

/** The server's body escapes Markdown marks (and "@", and "://") so older apps show it as text; the other way. */
export const unescapeAppBody = (s: string) => s.replace(/\\([\\`*_[\]<>#|~@&\-+=.)/:])/g, '$1').replace(/<(https:\/\/[^>\s]+)>/g, '$1')

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

/** GitHub and Other can be tested at once, so their guides say "Nothing yet?" after this long; Sentry, the forms and the
 * presets post only when something happens there. */
export const NOTHING_YET_MS = 120_000
export const waitsForEvent = (s: AppService) => s !== 'github' && s !== 'other'

/** The side chat's chip in a room with apps (owner decision: one chip chosen by the apps there): "Summarise today's
 * responses" when the room's apps are forms only, else "What happened today?". Null: no app has posted here. Read from
 * the messages on screen, so a member (who cannot list the apps) gets it too. */
export function appChip(messages: readonly Pick<RoomMessage, 'app'>[]): 'today' | 'forms' | null {
  const services = new Set<AppService>()
  for (const m of messages) if (m.app && !m.app.example) services.add(serviceOf(m.app))
  if (!services.size) return null
  return [...services].every((s) => FORM_SERVICES.includes(s)) ? 'forms' : 'today'
}

// ---------------- presets (plan docs/AGENTS/plan/20261114-1522-room-apps-presets-email.md, P1) ----------------
// A preset is a named service set up as an Other app (kind 'other' + preset), so an older build still reads it as Other.
// The screens speak of a "service": a kind, or the preset of an Other app.

/** The presets this build knows (shared RoomAppPreset). */
export type RoomAppPresetId = RoomAppPreset
export const isPreset = (s: unknown): s is RoomAppPresetId => RoomAppPreset.safeParse(s).success
/** What the screens show an app as: Sentry, GitHub, Google Forms, a preset, or a plain Other app. */
export type AppService = Exclude<RoomAppKind, 'other'> | RoomAppPresetId | 'other'
/** An app's (or an app message's) service: its preset when this build knows it (a newer build's preset shows as Other). */
export const serviceOf = (a: { kind: RoomAppKind; preset?: string | null }): AppService => (a.kind === 'other' && isPreset(a.preset) ? a.preset : a.kind)
/** The kind a service is created with (a preset is an Other app). */
export const kindOf = (s: AppService): RoomAppKind => (isPreset(s) ? 'other' : s)

/** The picker: groups as headings in one list, then a divider and "Any other way" (Other app, last; owner decision 5). */
export const PICKER_GROUPS: readonly { key: 'forms' | 'payments' | 'work' | 'developers'; items: readonly AppService[] }[] = [
  { key: 'forms', items: ['google_forms', 'typeform', 'tally', 'jotform'] },
  { key: 'payments', items: ['stripe', 'shopify'] },
  { key: 'work', items: ['notion', 'zendesk'] },
  { key: 'developers', items: ['github', 'sentry'] },
]
/** Form services: the side chat offers "Summarize today's responses" when only these posted. */
export const FORM_SERVICES: readonly AppService[] = ['google_forms', 'typeform', 'tally', 'jotform']

/** The events the guide marks as optional to set up in the service (Shopify makes one webhook per event; Zendesk's
 * second trigger): until one arrives, its switch says "Not set up in {app}". */
const OPTIONAL_EVENTS: Partial<Record<RoomAppPresetId, readonly string[]>> = { shopify: ['paid', 'cancelled', 'refund', 'fulfilled'], zendesk: ['updated'] }
/** A service's switches: a kind's (shared ROOM_APP_SWITCHES) or a preset's (ROOM_APP_PRESET_SWITCHES). */
export const switchesOf = (s: AppService): readonly { key: string; on: boolean; optional?: boolean }[] =>
  isPreset(s) ? ROOM_APP_PRESET_SWITCHES[s].map((w) => ({ ...w, optional: !!OPTIONAL_EVENTS[s]?.includes(w.key) })) : ROOM_APP_SWITCHES[s]

/** How a service can be made safer: GitHub and the trina_makes presets get a secret Trina makes, Sentry and the paste
 * presets a field for the service's own; none: no signing (Google Forms, Other, Notion, Jotform). */
export function signingOf(s: AppService): 'none' | 'trina_makes' | 'paste' {
  if (s === 'github') return 'trina_makes'
  if (s === 'sentry') return 'paste'
  return isPreset(s) ? ROOM_APP_PRESET_SIGNING[s].signing : 'none'
}

/** What a service needs on its side ("Needs: …" on the picker row and the guide's header; shared ROOM_APP_PRESET_NEEDS). */
export type AppNeeds = NonNullable<(typeof ROOM_APP_PRESET_NEEDS)[RoomAppPresetId]>
export const needsOf = (s: AppService): AppNeeds | null => (isPreset(s) ? ROOM_APP_PRESET_NEEDS[s] ?? null : null)

/** Stripe's events behind each switch: the guide's chips in the step where they are ticked. */
export const STRIPE_EVENTS: Record<string, readonly string[]> = {
  payment: ['checkout.session.completed', 'payment_intent.succeeded'],
  refund: ['charge.refunded'],
  failed: ['invoice.payment_failed', 'payment_intent.payment_failed'],
  dispute: ['charge.dispute.created'],
  subscription_ended: ['customer.subscription.deleted'],
  subscription_new: ['customer.subscription.created'],
}

/** Make's request content for the "Don't see your app?" example (Google Calendar › Watch Events, module 1): Make turns
 * the {{1.…}} parts into the event's fields when it is pasted. Other reads title, text, link and thread. */
export const MAKE_BODY = `{"title":"{{1.summary}}","text":"{{1.start}} {{1.location}}","link":"{{1.htmlLink}}","thread":"{{1.id}}"}`

/** The switches of an optional event that never arrived ("Not set up in Shopify"): read from the app's `eventsSeen` when
 * the server sends it; without it nothing is marked. */
export function notSetUp(s: AppService, app: { eventsSeen?: readonly string[] | null }): Set<string> {
  const seen = app.eventsSeen
  if (!seen) return new Set()
  return new Set(switchesOf(s).filter((w) => w.optional && !seen.includes(w.key)).map((w) => w.key))
}
