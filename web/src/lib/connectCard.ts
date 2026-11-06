// connect_service cards (components/chat/ConnectCard.tsx, docs/INTEGRATIONS.md "Connecting from a chat"): which case a
// card is, and what its buttons send to POST /api/turns/:id/connect. A key leaves the card only one way: sealed in
// this browser for 'integration.secret' (lib/seal.ts) with the team server's sealing key. The plain key is never in a
// request, the store, a log or an address, and never goes through /answer, whose answers reach the AI.
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
