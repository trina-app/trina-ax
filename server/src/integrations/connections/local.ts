// Apps on the person's own computer as connectors (docs/decisions/20261118-local-app-connectors.md). Such a connection
// is an ordinary personal MCP connection (store.ts Row) with `local_app` set (migration 364): what the desktop app runs
// there. Its calls never reach the network: McpClient's transport (`send`) hands each JSON-RPC message to the local
// relay (realtime/local-relay.ts), which sends it to the one desktop window of the turn (or of the Settings check); the
// desktop app passes it to the program and sends the program's answer back. The server keeps the command's shape only,
// never a setting's value; the desktop app asks once on the computer before it runs a command, and again when the
// command changes.
import type { Database } from 'bun:sqlite'
import { LocalAppSpec, presetOf, windowsShare, type IntegrationKind, type LocalFailure, type LocalResult } from '@mycel/shared/api'
import { PRODUCT } from '@mycel/shared'
import { getTeamSettings } from '../../admin/settings'
import { NetError, TIMEOUT_MS, type NetRequest, type NetResponse } from './net'
import { MCP_LIST_TIMEOUT_MS } from './mcp'
import { reasonText } from './text'
import type { LocalRelay } from '../../realtime/local-relay'
import type { Row } from './store'

/** how long a turn's first message (initialize) waits: the desktop app may be asking the person first, who may be away
 * from the screen for a while. A check from Settings keeps its own 90 s: the confirm stays open after it, and a Connect
 * pressed later checks again by itself (the desktop app tells the page). */
export const CONFIRM_WAIT_MS = 5 * 60_000

/** a Settings check's initialize (no turn): the check's own deadline (mcp.ts MCP_LIST_TIMEOUT_MS), less a moment so
 * the desktop app's 'late' answer (unconfirmed) reaches the check before it stops waiting */
export const CHECK_CONFIRM_WAIT_MS = MCP_LIST_TIMEOUT_MS - 2000

/** a local connection's `url`: a placeholder under the reserved .invalid name (RFC 6761), never used to connect */
export const LOCAL_URL_ORIGIN = 'https://local-app.invalid'
export const localUrl = (id: string) => `${LOCAL_URL_ORIGIN}/${id}`

/** The spec a row holds (null: not a local connection, or a value that is not one: the column is ours alone). */
export function localSpecOf(row: Pick<Row, 'local_app'>): LocalAppSpec | null {
  if (!row.local_app) return null
  try { const r = LocalAppSpec.safeParse(JSON.parse(row.local_app)); return r.success ? r.data : null } catch { return null }
}
export const isLocal = (row: Pick<Row, 'local_app'>) => !!row.local_app

/** The kind the API shows: a local connection is 'local', whatever its stored `kind`. */
export const kindOf = (row: Pick<Row, 'kind' | 'local_app'>): IntegrationKind => (row.local_app ? 'local' : row.kind)

/** the team's "Apps on your computer" switch (TeamSettings.localApps; on unless an admin turned it off) */
export const localOn = (db: Database) => getTeamSettings(db).localApps !== false

/** Where a local call goes: the desktop window of the turn or of the Settings check, and its turn (null: a check). */
export interface LocalVia { windowId: string; turnId: string | null }

/** The desktop window a turn was sent from, when it was the desktop app (turns.window_id, client_kind). */
export function turnWindow(db: Database, turnId: string): string | null {
  const t = db.query('SELECT window_id, client_kind FROM turns WHERE id = ?').get(turnId) as { window_id: string | null; client_kind: string | null } | null
  return t && t.client_kind === 'desktop' && t.window_id ? t.window_id : null
}

/** Why an app on the computer cannot run for this turn, as one known fact (never a guess): where the message came from,
 * or that the desktop window that sent it is not connected. */
export type LocalAway = 'web' | 'mobile' | 'window' | 'schedule' | 'no_local_apps' | 'other'
export function turnAway(db: Database, turnId: string): LocalAway {
  const t = db.query('SELECT window_id, client_kind FROM turns WHERE id = ?').get(turnId) as { window_id: string | null; client_kind: string | null } | null
  const k = t?.client_kind
  return k === 'web' ? 'web' : k === 'mobile' ? 'mobile' : k === 'schedule' ? 'schedule' : k === 'desktop' && t?.window_id ? 'window' : 'other'
}

/** Why a program did not start, more exactly than LocalResult's cause: `share` is an `unsupported` whose command is a
 * network share or device path (the desktop app refuses those: programs.ts), told from the command the server keeps, so
 * no new value goes over the wire (an older server would refuse the whole answer). */
export type LocalCause = NonNullable<LocalResult['cause']> | 'share'
export type LocalReason = 'local_offline' | 'local_declined' | 'local_confirm' | 'local_failed' | 'local_missing' | 'local_share' | 'local_unsupported' | 'local_unsafe'
/** the start_failed causes that have words of their own (text.ts); any other start failure is local_failed */
const CAUSE_REASON: Record<LocalCause, LocalReason> = { not_found: 'local_missing', share: 'local_share', unsupported: 'local_unsupported', unsafe_arg: 'local_unsafe' }

/** The cause a result names, with a refused share told apart (LocalCause). */
export const causeOf = (r: Pick<LocalResult, 'cause'>, spec: Pick<LocalAppSpec, 'command'>): LocalCause | undefined =>
  r.cause === 'unsupported' && windowsShare(spec.command) ? 'share' : r.cause

/** Why a local call did not run, with words for the AI (never a setting's value) and the reason stored on the
 * connection (text.ts: local_offline, local_declined, local_failed, and for a program that did not start the one known
 * cause: local_missing, local_share, local_unsupported, local_unsafe). */
export class LocalError extends Error {
  name = 'LocalError'
  constructor(readonly failure: LocalFailure | 'offline', message: string, readonly cause?: LocalCause) { super(message) }
  get reason(): LocalReason {
    return this.failure === 'offline' || this.failure === 'not_desktop' ? 'local_offline' : this.failure === 'declined' ? 'local_declined' : this.failure === 'unconfirmed' ? 'local_confirm'
      // the program did not start for a known cause: the connection "needs attention" with that cause in words (text.ts)
      : this.failure === 'start_failed' && this.cause ? CAUSE_REASON[this.cause] : 'local_failed'
  }
}

const desktop = `the ${PRODUCT.displayName} desktop app`
const AWAY: Record<LocalAway, string> = {
  web: `this message was sent from the web page, not from ${desktop}`,
  mobile: `this message was sent from the phone app, not from ${desktop}`,
  window: `this message was sent from ${desktop}, but that window was not connected to the team server when it was needed`,
  schedule: 'this is a scheduled run, and an app on the computer never runs in one',
  no_local_apps: 'the window that sent this message answered that it cannot run apps on the computer now (it has no team open, or it is not the desktop app)',
  other: `this message was not sent from ${desktop}`,
}
const SAY_ONLY = `Tell them exactly that in one or two plain sentences, and that it works when they send the message from ${desktop} on that computer. Do not guess at other causes (another computer, the app's version or where it was installed).`
/** For the AI, in words it can pass on: the app runs only from the desktop app on the person's computer, and the one
 * known reason it did not run now. No guessing: the AI once told the owner it might be the Mac App Store or another
 * computer when the real cause was the server's (a shared chat, 2026-11-20). */
export const offlineWords = (name: string, away: LocalAway = 'other') =>
  `${name} is an app on the user's own computer, and it runs only when they write from ${desktop} on the computer where they added it. Nothing ran, because ${AWAY[away]}. ${SAY_ONLY}`
/** The same for the AI's instructions, before anyone asks: why it is not usable in this answer. */
export const awayWords = (away: LocalAway) =>
  `it runs only when the user writes from ${desktop} on the computer where they added it, and ${AWAY[away]}. When they ask for it, ${SAY_ONLY.charAt(0).toLowerCase()}${SAY_ONLY.slice(1)}`

/** A program's file name without its folder (C:\\Users\\…\\tool.exe → tool.exe): the AI's words never carry the saved path. */
export const programName = (command: string) => (command.split(/[\\/]/).filter(Boolean).pop() ?? command).slice(0, 100)

/** Where the person fixes it, for the AI: the connection's page, which has a Check again button by the problem. */
const page = (name: string) => `Settings › Connectors › ${name}`

/** For the AI: a program that is not on the computer, and for a listed app (Aside, ego lite) its own download page. One
 * place for a call that failed and for the instructions before anyone asks (tools.ts), so both give the link (QA
 * TC-9006). */
export function missingWords(name: string, spec: LocalAppSpec | null, where = page(name)): string {
  const download = spec ? presetOf(spec)?.download : undefined
  const program = spec ? ` (the program "${programName(spec.command)}" was not found there)` : ''
  return `${name} is not installed on the user's computer${program}. Tell them in plain words that ${name} is not installed on this computer and that they ${download ? `can download it at ${download} (give them this link)` : 'need to install it or fix the command'}, then press Check again on ${where}.`
}

/** For the AI's instructions: an app on the computer whose tools are not known yet, in the words of its last check
 * (the same words its page shows, text.ts), never a vague "not set up" (QA TC-9006). `where`: its page, as the AI
 * names it to this reader (policy/refusal.ts SCREEN.connectors). */
export function notReadyWords(row: Pick<Row, 'name' | 'last_error'>, spec: LocalAppSpec | null, where = page(row.name)): string {
  const reason = row.last_error?.split(':')[0]
  if (reason === 'local_missing') return `not usable yet: ${missingWords(row.name, spec, where)}`
  const said = reason?.startsWith('local_') && reason !== 'local_offline' ? reasonText(row.last_error, 'en', undefined, row.name) : null
  return said
    ? `not usable yet; its last check on the computer said: "${said}" When they ask for it, tell them that in plain words; the fix is on ${where} in the desktop app on that computer`
    : `not set up on the computer yet. When they ask for it, tell them to open ${where} in the desktop app on that computer and press Check again`
}

function errorOf(name: string, r: LocalResult, spec: LocalAppSpec): LocalError {
  const detail = (r.error ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 300)
  const cause = r.failure === 'start_failed' ? causeOf(r, spec) : undefined
  if (cause === 'not_found') return new LocalError('start_failed', `Nothing ran: ${missingWords(name, spec)}`, cause)
  // a program that did not start for a known cause: the same words its page shows (text.ts), passed on by the AI
  if (cause) return new LocalError('start_failed', `Nothing ran: ${reasonText(CAUSE_REASON[cause], 'en', undefined, name)} Tell them that in plain words; the fix is on ${page(name)}.`, cause)
  switch (r.failure) {
    case 'not_desktop': return new LocalError('not_desktop', offlineWords(name, 'no_local_apps'))
    case 'declined': return new LocalError('declined', `The user chose Cancel when ${desktop} asked whether to connect ${name} on their computer, so nothing ran. Do not try again unless they ask; they can connect it in Settings › Connectors › ${name}.`)
    case 'unconfirmed': return new LocalError('unconfirmed', `${desktop} on the user's computer is asking them whether to connect ${name} ("Connect this program?"), and they have not pressed Connect yet, so nothing ran. Tell them to press Connect in that window on their computer, then ask again.`)
    case 'root': return new LocalError('root', `${desktop} on the user's computer runs with administrator (root) rights, and it never starts ${name} then. Nothing ran.`)
    case 'too_old': return new LocalError('too_old', `${desktop} on the user's computer is too old for apps on the computer. Ask them to update it; nothing ran.`)
    case 'start_failed': return new LocalError('start_failed', `${name} could not start on the user's computer${detail ? `: ${detail}` : ''}. The user can check it in Settings › Connectors › ${name}.`)
    default: return new LocalError('failed', `${name} on the user's computer did not answer${detail ? `: ${detail}` : ''}.`)
  }
}

/** McpClient's `send` for a local connection: one JSON-RPC message per request through the local relay, the program's
 * answer as an HTTP-like answer McpClient reads (JSON, or 202 for a notification). A check's or a call's deadline (the
 * request's `long`) is the relay's limit; Stop (the request's signal) ends it there and tells the desktop app. */
export function localTransport(o: { relay: LocalRelay; userId: string; via: LocalVia; row: Pick<Row, 'id' | 'name'>; spec: LocalAppSpec }) {
  return async (_url: string, r: NetRequest): Promise<NetResponse> => {
    let message: Record<string, unknown>
    try { message = JSON.parse(r.body?.toString('utf8') ?? '') } catch { throw new LocalError('failed', `${o.row.name}: the message could not be read`) }
    // the first message of a client (initialize) is the one the desktop app may hold while it asks the person on the
    // computer (the one-time confirm): a turn's waits as long as a person reads that window, not a network's 30 s. A
    // Settings check (no turn) stops at its own deadline (MCP_LIST_TIMEOUT_MS), so its initialize ends there too: the
    // desktop app then hears that the confirm came late, and a Connect pressed after it makes the page check again
    // (DesktopBridge.localApps.onConfirmed). With five minutes here, a Connect between 90 s and five minutes left the
    // check at list_timeout and the page never checked again (QA 2026-11-24, Aside on Windows).
    const confirmWait = o.via.turnId === null ? CHECK_CONFIRM_WAIT_MS : CONFIRM_WAIT_MS
    const deadline = r.long?.deadline ?? Date.now() + (message.method === 'initialize' ? confirmWait : TIMEOUT_MS)
    const timeoutMs = Math.max(1000, deadline - Date.now())
    if (!o.relay.windowAlive(o.userId, o.via.windowId)) throw new LocalError('offline', offlineWords(o.row.name, 'window'))
    const res = await o.relay.call({ userId: o.userId, windowId: o.via.windowId, turnId: o.via.turnId, connectionId: o.row.id, name: o.row.name, spec: o.spec, message, timeoutMs, signal: r.signal })
    if (!res.ok) {
      if (r.signal?.aborted) throw new NetError('timeout')
      if (!res.failure && /did not answer in time$/.test(res.error ?? '')) throw new NetError(r.long?.reason ?? 'timeout')
      if (!res.failure && /^local_unavailable/.test(res.error ?? '')) throw new LocalError('offline', offlineWords(o.row.name, 'window'))
      throw errorOf(o.row.name, res, o.spec)
    }
    const body = res.message ? Buffer.from(JSON.stringify(res.message)) : Buffer.alloc(0)
    if (r.maxBytes && body.length > r.maxBytes) return { status: 200, headers: { 'content-type': 'application/json' }, body: body.subarray(0, r.maxBytes), truncated: true }
    return { status: res.message ? 200 : 202, headers: { 'content-type': 'application/json' }, body, truncated: false }
  }
}
