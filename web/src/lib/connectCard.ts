// connect_service cards (components/chat/ConnectCard.tsx, docs/INTEGRATIONS.md "Connecting from a chat"): which case a
// card is, and what its buttons send to POST /api/turns/:id/connect. A key leaves the card only one way: sealed in
// this browser for 'integration.secret' (lib/seal.ts) with the team server's sealing key. The plain key is never in a
// request, the store, a log or an address, and never goes through /answer, whose answers reach the AI.
import { officialService, posesAsListed, trustedServiceName, type CatalogService } from '@mycel/shared'
import type { TurnConnectResult, TurnRequest } from '@mycel/shared/api'
import { api, API } from './api'
import { sealSecret } from './seal'
import { useChats } from '../store/chats'

export type ConnectServiceRequest = Extract<TurnRequest, { kind: 'connect_service' }>
/** key: paste an API key (bearer / header). sign_in: sign in at the service (MCP OAuth). none: nothing to give.
 * google_drive: the person's own Google account. */
export type ConnectCase = 'key' | 'sign_in' | 'none' | 'google_drive'
/** who may use a team connection: the admin who adds it, or everyone on the team */
export type ConnectAccess = 'me' | 'everyone'

export function connectCase(r: ConnectServiceRequest): ConnectCase {
  if (r.target === 'google_drive') return 'google_drive'
  const auth = r.service?.auth
  return auth === 'bearer' || auth === 'header' ? 'key' : auth === 'oauth' ? 'sign_in' : 'none'
}

/** The words of a service's name that can name its site: letters and digits, 3+ characters, in lower case. */
const nameWords = (name: string) => (name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => [...w].length >= 3)

/** Whether the address is not on the service's own site: no word of its name is in the host ("GitHub" at
 * github-mcp.evil.example is on it, at mcp.example.org it is not). The AI chose both, so the card asks the person to
 * check the address; a nudge, not a proof (a name with no such word always gets it). */
export function hostOffName(name: string, host: string): boolean {
  const h = host.toLowerCase()
  return !nameWords(name).some((w) => h.includes(w))
}

/**
 * How far the card can vouch for where it connects (shared/src/service-catalog.ts, the app's list of services):
 * - official: exactly a listed service's official address (https, host and path).
 * - template: an admin's template (the team chose the address and name), or a connection the person already has
 *   (reconnect; named by its host when its name poses as a listed service's).
 * - unlisted: any other address. `display` is the name the card uses: the AI's, or the host when the AI's name is (or
 *   looks like) a listed service's or mixes alphabets in a word, so a self-hosted or made-up address never reads as
 *   that service.
 */
export type CardTrust =
  | { kind: 'official'; service: CatalogService }
  | { kind: 'template'; display: string }
  | { kind: 'unlisted'; display: string }
  | { kind: 'none' }
export function cardTrust(r: ConnectServiceRequest): CardTrust {
  if (r.target !== 'service' || !r.service) return { kind: 'none' }
  const at = officialService(r.service.url)
  if (at) return { kind: 'official', service: at }
  // an admin's template keeps the admin's name; anything else that is (or looks like) a listed service's name, or mixes
  // alphabets in a word, at an address that is not the official one is named by its host: a new card, and a reconnect
  // card for a connection saved under such a name before the list's rule (#582)
  const display = !r.template && posesAsListed(r.name, r.service.url) ? r.service.host : r.name
  if (r.template || r.reconnect) return { kind: 'template', display }
  return { kind: 'unlisted', display }
}

/** The listed service a card's name claims at an address that is not that service's official one, and its official host:
 * from the server (`notOfficial`), or worked out here for an older server's card (never for an admin's template, whose
 * name is the admin's, nor for the official address itself). */
export function notOfficialOf(r: ConnectServiceRequest, trust: CardTrust): { name: string; host: string } | null {
  if (trust.kind === 'official' || trust.kind === 'none' || r.template || !r.service) return null
  const claim = r.notOfficial ?? trustedServiceName(r.name, r.service.url).claimed
  if (!claim) return null
  try { return { name: claim.name, host: new URL(claim.url).host } } catch { return null }
}

/** a personal connection sends no access; a team one says who may use it */
const accessOf = (r: ConnectServiceRequest, access: ConnectAccess) => (r.scope === 'team' ? { access } : {})

/** Add the connection with the key the person pasted: sealed here first, then posted with the card's id. */
export async function connectWithKey(r: ConnectServiceRequest, key: string, access: ConnectAccess): Promise<TurnConnectResult | null> {
  const sealed = await sealSecret(await api.call(API.sealingKey), key.trim(), 'integration.secret')
  return useChats.getState().connect(r.requestId, { action: 'connect', sealed, ...accessOf(r, access) })
}

/** Add a connection that needs no key (none), or one to sign in to next (sign_in: the answer says so). */
export const connectWithoutKey = (r: ConnectServiceRequest, access: ConnectAccess) => useChats.getState().connect(r.requestId, { action: 'connect', ...accessOf(r, access) })

/** After signing in at the service or connecting Google Drive: the server checks it and tells the AI. */
export const finishConnect = (r: ConnectServiceRequest) => useChats.getState().connect(r.requestId, { action: 'done' })

/** "Not now": the AI goes on without it. */
export const skipConnect = (r: ConnectServiceRequest) => useChats.getState().connect(r.requestId, { action: 'skip' })
