// The Connectors page (pages/Connectors.tsx): what each built-in Google card says and does, kept out of the components so
// it can be tested. Google Drive is Trina's own connector (DriveConnector.tsx); Gmail, Google Calendar, Google Docs and
// Google Sheets come from the server's Google apps (shared/src/api/google-apps.ts). Words only through message keys:
// people see "Connect", the app's name and what the AI can do, never how it is wired.
import type { DriveConnection, GoogleAppId, GoogleAppView } from '@mycel/shared/api'
import { DICTS, type MessageKey } from '../i18n'
import { SERVICE_CATALOG } from '@mycel/shared'
import { APP_CONNECTORS, appConnectorLogo } from './connectors'

export const GOOGLE_APP_ORDER: GoogleAppId[] = ['gmail', 'calendar', 'docs', 'sheets']
/** the built-in cards, in the order Popular shows them */
export const BUILT_IN_ORDER = ['google-drive', ...GOOGLE_APP_ORDER] as const
export type BuiltInId = (typeof BUILT_IN_ORDER)[number]

export const isGoogleApp = (id: string): id is GoogleAppId => (GOOGLE_APP_ORDER as string[]).includes(id)
export const isBuiltIn = (id: string): id is BuiltInId => (BUILT_IN_ORDER as readonly string[]).includes(id)

export const builtInName = (id: BuiltInId) => APP_CONNECTORS.find((a) => a.id === id)!.name
/** The name of anything a member may ask an admin to add: a built-in, or a service of the app's list (QA TC-133). */
export const requestableName = (id: string) => (isBuiltIn(id) ? builtInName(id) : SERVICE_CATALOG.find((c) => c.id === id)?.name ?? id)
export const builtInLogo = (id: BuiltInId) => appConnectorLogo(APP_CONNECTORS.find((a) => a.id === id)!)

/** The one line under a built-in card's name (what the AI does with it). */
export const lineKey = (id: BuiltInId): MessageKey => `gapps.${id === 'google-drive' ? 'drive' : id}.line` as MessageKey
/** A connector page's About (what it lets the AI do, and that only the person uses it); what the AI may change is the
 * page's own line under it, so the text does not say it again. */
export const aboutKey = (id: BuiltInId): MessageKey => `gapps.${id === 'google-drive' ? 'drive' : id}.about` as MessageKey
export const categoryKey = (id: BuiltInId): MessageKey => `gapps.${id === 'google-drive' ? 'drive' : id}.category` as MessageKey

/** A Google app's tools as people read them in their language (the server sends English): the title and the line of
 * what it does from `gapps.tool.<name>` and `gapps.toolDesc.<name>`; one the app does not know yet keeps the server's
 * words. */
export function toolWords<T extends { name: string; title: string; description?: string }>(t: (k: MessageKey) => string, tools: readonly T[]): T[] {
  const known = DICTS.en as Record<string, string>
  return tools.map((x) => {
    const title = `gapps.tool.${x.name}`, desc = `gapps.toolDesc.${x.name}`
    return { ...x, title: title in known ? t(title as MessageKey) : x.title, description: desc in known ? t(desc as MessageKey) : x.description }
  })
}

/** A card's state in Popular: connected (✓), needs a new sign-in, can be connected (+), or not now (with why). */
export type CardState = 'added' | 'reconnect' | 'available' | 'off'

export function googleAppCardState(v: GoogleAppView): CardState {
  if (v.status === 'connected') return 'added'
  if (v.status === 'needs_reconnect') return v.available ? 'reconnect' : 'off'
  return v.available ? 'available' : 'off'
}

/** Why a Google app cannot be connected now, in plain words: the short form on its card, the sentence on its page.
 * `not_set_up` reads differently for an admin, who can set it up (Admin › Connectors). */
export function unavailableKeys(reason: GoogleAppView['reason'], admin: boolean): { short: MessageKey; long: MessageKey } | null {
  switch (reason) {
    case 'not_set_up': return { short: 'gapps.off.notSetUp', long: admin ? 'gapps.off.notSetUpAdmin' : 'gapps.off.notSetUpMember' }
    case 'unsupported': return { short: 'gapps.off.unsupported', long: 'gapps.off.unsupportedLong' }
    case 'service_limited': return { short: 'gapps.off.serviceLimited', long: 'gapps.off.serviceLimitedLong' }
    default: return null
  }
}

/** Google Drive's card state, from its connection (DriveConnector.tsx keeps the details of its own flow). Once it is
 * set up everyone may connect their own (docs/DECISIONS.md "No members' switch for connectors"). */
export function driveCardState(c: DriveConnection | null): CardState {
  if (!c) return 'available'
  const linked = c.configured && (c.status === 'connected' || c.status === 'needs_reconnect')
  if (linked) return c.status === 'needs_reconnect' ? 'reconnect' : 'added'
  if ((c.teamShares?.length ?? 0) > 0) return 'added'
  if (!c.configured) return 'off'
  return 'available'
}

/** The search box: a card fits by its name or its line (every card without a search). */
export function fits(query: string, ...texts: string[]) {
  const q = query.trim().toLocaleLowerCase()
  return !q || texts.join(' ').toLocaleLowerCase().includes(q)
}

/** Who made the tools the AI gets from a built-in card, for the page's details ("Made by"). */
export const developerKey = (id: BuiltInId): MessageKey => (id === 'google-drive' ? 'gapps.dev.trina' : 'gapps.dev.google')

/** Who the person signs in with, and Google's privacy policy and terms, for a connector page's details (what the
 * person agrees to at Google's sign-in). A name, never translated. */
export const GOOGLE = 'Google'
export const GOOGLE_PRIVACY = 'https://policies.google.com/privacy'
export const GOOGLE_TERMS = 'https://policies.google.com/terms'

/** The tools the AI gets from Google Drive here (server/src/tools/drive.ts): read only. */
export const DRIVE_TOOL_LIST = [
  { name: 'drive_search', title: 'Search Drive', changes: false },
  { name: 'drive_list', title: 'List a folder', changes: false },
  { name: 'drive_read', title: 'Read a file', changes: false },
] as const

/** Whether any tool of the app changes or sends something: "Read and change", else "Read only". */
export const canChange = (tools: { changes: boolean }[]) => tools.some((x) => x.changes)
