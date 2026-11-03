// connect_service (docs/INTEGRATIONS.md "Connecting from a chat"): the AI fills in a connection to a service (an MCP
// server or an HTTP API), or the person's Google Drive, and the person finishes it on a card in the chat. The tool only
// opens the card: nothing is connected until the person presses the card's button, so an instruction planted in a page
// can make the AI open a card but never complete one. A key goes from the card, sealed in the browser for
// 'integration.secret', to POST /api/turns/:id/connect (finishCard below), never through /answer or the AI: the tool
// learns only the outcome. The connection is made through the same path as in Settings (service.ts create): the same
// checks, limits, sealing and audit. Not offered in confidential chats (not a local tool) or to sub-agents
// (PARENT_ONLY_TOOLS); a scheduled run has nobody to finish a card and gets "skipped".
import { z } from 'zod'
import { addressHasSecret, ConnectServiceInput, hasSecret, uuidv7 } from '@mycel/shared'
import { IntegrationInput, type Integration, type IntegrationAccess, type IntegrationPatch, type Locale, type TurnConnectBody, type TurnConnectResult, type TurnRequest } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { AuthInfo } from '../services'
import type { McpContent } from '../turns'
import { fail } from '../http/errors'
import { getTeamSettings } from '../admin/settings'
import { unsealOrFail } from '../credentials/service'
import { credentialsOf } from '../credentials/store'
import { cleanNotes, hiddenText, integrationsOf, MAX_PERSONAL, MAX_TEAM, normUrl, obviouslyPrivate, oneLine } from '../integrations/connections/service'
import { activeUser, disabledTools, getRow, isAdmin, mayUse, savedTools, selectRows, view, type Row, type Viewer } from '../integrations/connections/store'
import { say } from '../integrations/connections/text'
import { googleDriveOf } from '../integrations/google-drive/oauth'
import { DRIVE_TOOL_NAMES } from '../tools/drive'
import { tr } from './i18n'
import type { TurnExec } from './turn'

export const CONNECT_TOOL = 'connect_service'
/** tool names the result lists at most (the AI gets them all as tools from the next message), and each one's length */
const TOOLS_LISTED = 30
const TOOL_NAME_MAX = 64
/** the longest key the card takes (as IntegrationInput.secret) */
const KEY_MAX = 8000

/** How a connect_service card ended, from the card's route only (TurnExec.answer refuses anything else). */
export const ConnectOutcome = z.union([
  z.strictObject({ outcome: z.literal('connected'), integrationId: z.string().min(1) }),
  z.strictObject({ outcome: z.literal('connected'), drive: z.literal(true) }),
  z.strictObject({ outcome: z.literal('skipped') }),
])
export type ConnectOutcome = z.infer<typeof ConnectOutcome>

/** Kept on the turn beside an open card (TurnExec.connectCards). */
export interface ConnectCard {
  /** the connection this card made (another key after a failed check goes to it, never to a second one) */
  integrationId: string | null
  /** a connect or done of this card that is running: a second one meanwhile is refused, and the tool waits for it after
   * the card closed (its time ran out, Not now, the answer was stopped) before it says what the card made */
  running: Promise<unknown> | null
  /** the connection this card made was changed or removed in Settings meanwhile: nothing more goes through this card */
  changed: boolean
  /** that connection's version after this card's own last write: a later one is a change made in Settings (a new key,
   * say), which "Not now" must not undo */
  version: number | null
}

type ToolOut = { content: McpContent[]; isError?: boolean; summary: string }
const json = (v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v) }]
const zodText = (e: z.ZodError) => 'Invalid input: ' + e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
/** the same service: the stored address and the AI's, without a trailing slash */
const sameAddress = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')
/** a connection's state for the AI, as words and the stored reason code (never the service's own words) */
const stateOf = (r: Row) => r.status === 'connected' ? 'connected' : r.status === 'needs_auth' ? `needs a sign-in or a new key${r.last_error ? ` (${r.last_error})` : ''}` : `not working${r.last_error ? ` (${r.last_error})` : ''}`
const accessFor = (a: 'me' | 'everyone', me: string): IntegrationAccess => a === 'everyone' ? { everyone: true, groups: [], users: [] } : { everyone: false, groups: [], users: [me] }

/** the tool result when the card connected it */
function connectedResult(exec: TurnExec, out: { name: string; status: string; tools?: string[] }): ToolOut {
  exec.patchToolStep(CONNECT_TOOL, () => ({ detail: tr('connectConnected', exec.spec.locale) }))
  return { content: json({ connected: true, ...out }), summary: `${CONNECT_TOOL} -> connected` }
}
/** a tool name as the service wrote it, for the AI to read: no control, format or line-separator characters (no hidden
 * text, no direction overrides), at most TOOL_NAME_MAX characters */
const toolName = (name: string) => [...name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')].slice(0, TOOL_NAME_MAX).join('').trim()
const toolNames = (exec: TurnExec, row: Row) => {
  if (row.kind !== 'mcp') return undefined
  const off = disabledTools(row)
  return savedTools(exec.rt.db, row).filter((t) => !off.has(t.name)).map((t) => toolName(t.name)).filter(Boolean).slice(0, TOOLS_LISTED)
}

/** The tool: early answers without a card, else the card and the wait for the person. */
export async function connectService(exec: TurnExec, args: unknown): Promise<ToolOut> {
  const { rt, spec } = exec
  const db = rt.db, L = spec.locale
  /** no card: the AI is told why, in words it can act on; `error`: a refusal, not information */
  const early = (text: string, code: string, error = true): ToolOut => {
    exec.patchToolStep(CONNECT_TOOL, () => ({ detail: tr(error ? 'connectNotConnected' : 'connectConnected', L) }))
    return { content: [{ type: 'text', text }], ...(error ? { isError: true } : {}), summary: `${CONNECT_TOOL} -> no card (${code})` }
  }
  const a = ConnectServiceInput.safeParse(args)
  if (!a.success) return early(zodText(a.error), 'invalid input')
  const viewer = activeUser(db, spec.userId)
  if (!viewer) return early('Access denied: this account is disabled.', 'account disabled')
  const target = a.data.target ?? 'service'
  // the person approves what the card shows, and the name and notes reach the AI in later chats: no character they
  // cannot see or that turns the text around (hiddenText)
  for (const [field, v] of [['name', a.data.name], ['notes', a.data.notes], ['why', a.data.why]] as const) {
    if (v && hiddenText(v)) return early(`No card: the ${field} contains invisible or direction-changing characters (zero-width, bidi, tag or private-use characters, or variation selectors). The ${field} must be plain, visible text: call connect_service again without them.`, 'hidden text')
  }
  // the fields are shown on the card and saved with the connection: a key in one of them would end up there. The
  // address gets the stricter check (a known key prefix, a key-named query value): MCP addresses often carry a
  // generated instance id, which is no key.
  for (const [field, v] of [['name', a.data.name], ['url', a.data.url], ['authHeader', a.data.authHeader], ['notes', a.data.notes], ['why', a.data.why]] as const) {
    if (v && ((field === 'url' ? addressHasSecret(v) : hasSecret(v)) || exec.redact(v) !== v)) return early(`No card: the ${field} looks like it contains a key, token or password. Never put one in connect_service: the person pastes the key into the card, which keeps it from you. Call connect_service again without it.`, 'secret in input')
  }
  const why = a.data.why?.trim() ? oneLine(a.data.why) : undefined
  const expiresAt = () => new Date(Date.now() + rt.askUserTimeoutMs()).toISOString()
  let card: Extract<TurnRequest, { kind: 'connect_service' }>

  if (target === 'google_drive') {
    let d: ReturnType<ReturnType<typeof googleDriveOf>['status']>
    try { d = googleDriveOf(rt.ctx).status(spec.userId) } catch { return early('Google Drive cannot be connected for this account now.', 'drive unavailable') }
    if (!d.configured) return early('Google Drive is not set up on this team server: an admin or the server\'s operator has to set it up first (docs/INTEGRATIONS.md). Tell the person; no card was shown.', 'drive not configured')
    if (d.status === 'connected') return early(`Google Drive is already connected for this person. Its tools (${DRIVE_TOOL_NAMES.join(', ')}) are yours in this chat; if you do not have them now, from the person's next message.`, 'drive connected', false)
    card = { kind: 'connect_service', requestId: uuidv7(), target, name: 'Google Drive', scope: 'personal', ...(why ? { why } : {}), expiresAt: expiresAt() }
  } else {
    const { kind, url, auth } = a.data
    const missing = [!kind && 'kind', !url && 'url', !auth && 'auth'].filter(Boolean)
    if (missing.length) return early(`Invalid input: a service needs ${missing.join(', ')}. Find them in the service's documentation (its MCP endpoint or API base, and how it signs in).`, 'invalid input')
    const scope = a.data.scope ?? 'personal'
    // the same field checks as a connection added in Settings (https only, no user name or password, the header's name)
    const input = IntegrationInput.safeParse({ kind, name: a.data.name, url, auth, authHeader: auth === 'header' ? a.data.authHeader ?? null : null, notes: kind === 'http' ? a.data.notes ?? null : null, writePolicy: 'ask' })
    if (!input.success) return early(zodText(input.error), 'invalid input')
    const svc = integrationsOf(rt.ctx)
    let authHeader: string | null = null
    if (auth === 'header') {
      try { authHeader = svc.headerName(input.data.authHeader ?? null, L) } catch { return early('Invalid input: authHeader cannot carry a key (a reserved header such as Authorization, Cookie or Content-Type). Use auth bearer for "Authorization: Bearer", or the header the service\'s documentation names.', 'invalid input') }
    }
    const address = normUrl(input.data.url)
    if (obviouslyPrivate(address)) return early('That address names this computer or a private or office network, which connections may not use. Use the service\'s public https address from its documentation.', 'private address')
    if (scope === 'team' && !isAdmin(viewer.role)) return early('Only an admin can add a team connection, and this person is not one. Offer a personal connection instead (scope personal), or tell them an admin can add it for the team.', 'team needs an admin')
    if (scope === 'personal' && !getTeamSettings(db).personalIntegrations) {
      return early(`This team does not allow personal connections now (an admin turned them off). ${isAdmin(viewer.role) ? 'This person is an admin and can add it for the team instead (scope team).' : 'Tell the person to ask an admin.'}`, 'personal connections off')
    }
    const rows = scope === 'personal'
      ? [...db.query(`${selectRows(db)} WHERE scope = 'personal' AND owner_user_id = ?`).all(viewer.id) as Row[], ...(db.query(`${selectRows(db)} WHERE scope = 'team'`).all() as Row[]).filter((r) => mayUse(db, r, viewer.id))]
      : db.query(`${selectRows(db)} WHERE scope = 'team'`).all() as Row[]
    const max = scope === 'personal' ? MAX_PERSONAL : MAX_TEAM
    if (rows.filter((r) => r.scope === scope).length >= max) return early(`There are already ${max} ${scope} connections, the most there can be. One can be removed in ${scope === 'personal' ? 'Settings' : 'Admin'} > External services first.`, 'limit')
    const dup = rows.find((r) => sameAddress(r.url, address))
    if (dup) {
      const fix = dup.status === 'connected'
        ? 'Its tools are yours in this chat; if you do not have them now, from the person\'s next message.'
        : `It needs attention: ${dup.scope === 'team' ? 'an admin can fix it in Admin' : 'the person can fix its key or sign-in in Settings'} > External services.`
      return early(`${dup.scope === 'team' ? 'A team connection' : 'A connection of this person'} to this address already exists: "${dup.name}", ${stateOf(dup)}. ${fix} No card was shown.`, 'already exists', dup.status !== 'connected')
    }
    // an HTTP API's usage notes go into api_request's description in later chats: the card shows them, and the
    // connection is saved with exactly what it showed (cleaned as the store cleans them, so nothing changes on the way)
    const notes = input.data.kind === 'http' ? cleanNotes(input.data.notes) : null
    card = {
      kind: 'connect_service', requestId: uuidv7(), target: 'service', name: oneLine(input.data.name), scope,
      service: { kind: input.data.kind, url: address, host: new URL(address).host, auth: input.data.auth, authHeader }, ...(why ? { why } : {}), ...(notes ? { notes } : {}), expiresAt: expiresAt(),
    }
  }

  // a scheduled run: nobody is there to finish a card (waitForPerson would answer at once)
  if (spec.clientKind === 'schedule') {
    exec.patchToolStep(CONNECT_TOOL, () => ({ detail: tr('connectNotConnected', L) }))
    return { content: json({ skipped: true, reason: 'a scheduled run: nobody is there to finish a card. Say in the result that the person can ask you to connect it in a chat.' }), summary: `${CONNECT_TOOL} -> skipped (scheduled run)` }
  }
  const kept: ConnectCard = { integrationId: null, running: null, changed: false, version: null }
  exec.connectCards.set(card.requestId, kept)
  let answer: unknown
  try { answer = await exec.waitForPerson(card, { timeoutMs: rt.askUserTimeoutMs() }) } finally { exec.connectCards.delete(card.requestId) }
  // a connect still running when the card closed: what it makes is the answer (connected, or added but not working),
  // never "skipped" for a connection that then appears
  if (kept.running) await kept.running.catch(() => {})
  const o = ConnectOutcome.safeParse(answer)
  if (o.success && o.data.outcome === 'connected' && 'drive' in o.data) return connectedResult(exec, { name: 'Google Drive', status: 'connected', tools: [...DRIVE_TOOL_NAMES] })
  // the connection the card made, as it is now (the card's own id, not one the outcome names)
  let made = kept.integrationId ? getRow(db, kept.integrationId) : null
  // changed or removed in Settings while the card was open: not the connection the card showed, so not "connected"
  // through it
  if (kept.integrationId && (!made || (card.target === 'service' && !asShown(made, card)))) { made = null; kept.changed = true }
  if (made?.status === 'connected') { const tools = toolNames(exec, made); return connectedResult(exec, { name: made.name, status: made.status, ...(tools ? { tools } : {}) }) }
  exec.patchToolStep(CONNECT_TOOL, () => ({ detail: tr('connectNotConnected', L) }))
  const reason = made ? `"${made.name}" was added but is not working yet (${stateOf(made)}); ${made.scope === 'team' ? 'an admin can fix it in Admin' : 'the person can fix it in Settings'} > External services`
    : kept.changed ? 'the connection this card made was changed or removed in Settings while the card was open, so the card connected nothing; ask the person whether to connect it again' : undefined
  return { content: json({ skipped: true, ...(reason ? { reason } : {}) }), summary: `${CONNECT_TOOL} -> skipped` }
}

/** POST /api/turns/:id/connect for the turn's owner (the route checked that): connect, done or skip on an open card. */
export async function finishCard(ctx: AppContext, exec: TurnExec | undefined, auth: AuthInfo, body: TurnConnectBody, L: Locale): Promise<TurnConnectResult> {
  const card = exec?.openRequest(body.requestId)
  const kept = exec?.connectCards.get(body.requestId)
  if (!exec || !card || card.kind !== 'connect_service' || !kept) return fail('conflict', tr('connectClosed', L))
  // the person as they are now: the endpoint is for any signed-in person, a team connection needs an admin
  const viewer = activeUser(ctx.db, auth.user.id) ?? fail('forbidden')
  // "not now" closes the card at any time. After a key that did not work, the connection this card made never worked,
  // so it goes again (the same removal as in Settings, audited). A connected one stays, so does one that a connect still
  // running is making, one holding a finished sign-in that was not checked yet (the person signed in), and a card whose
  // time ran out leaves its connection in Settings for the person to finish.
  if (body.action === 'skip') {
    const made = !kept.running && kept.integrationId ? getRow(ctx.db, kept.integrationId) : null
    // one the person changed in Settings meanwhile (another address, or only a new key) is theirs now: never removed
    // here, and the AI is told it changed
    if (made && (!asShown(made, card) || made.version !== kept.version)) { kept.integrationId = null; kept.changed = true }
    else if (made && made.status !== 'connected' && !(made.auth === 'oauth' && made.secret_enc)) {
      try { await integrationsOf(ctx).remove(viewer, made.id); kept.integrationId = null } catch { /* left in Settings; the AI is told so */ }
    }
    exec.answer(body.requestId, CONNECT_TOOL, { outcome: 'skipped' } satisfies ConnectOutcome)
    return { state: 'skipped' }
  }
  if (kept.running) return fail('conflict', tr('connectBusy', L))
  if (card.scope === 'team' && !isAdmin(viewer.role)) return fail('forbidden', tr('connectTeamAdmin', L))
  // set before the first await, so a second button meanwhile sees it; the tool waits for it after the card closed
  const run = body.action === 'done' ? done(ctx, exec, viewer, body.requestId, card, kept, L) : connect(ctx, exec, viewer, body, card, kept, L)
  kept.running = run
  try { return await run } finally { kept.running = null }
}

type Card = Extract<TurnRequest, { kind: 'connect_service' }>

/** the row still is what the card showed (address, kind, sign-in, key header): not moved or changed in Settings */
const asShown = (row: Row, card: Card) => {
  const s = card.service
  return !!s && row.url === s.url && row.kind === s.kind && row.auth === s.auth && row.auth_header === s.authHeader
}

/**
 * Before each connect or done of a service card, the rules as they are now: personal connections still allowed (an
 * admin can turn them off while a card waits), and the connection this card made still the one it showed (address,
 * kind, how it signs in and the key's header). One changed or removed in Settings meanwhile is not this card's any
 * more: refused, nothing is sent to it, "Not now" leaves it alone and the person starts again. Returns the card's
 * connection, or null before it made one.
 */
function current(ctx: AppContext, card: Card, kept: ConnectCard, L: Locale): Row | null {
  if (card.scope === 'personal' && !getTeamSettings(ctx.db).personalIntegrations) return fail('forbidden', say('personalOff', L))
  if (kept.changed) return fail('conflict', tr('connectChanged', L))
  if (!kept.integrationId) return null
  const row = getRow(ctx.db, kept.integrationId)
  if (!row || !asShown(row, card)) {
    kept.integrationId = null
    kept.changed = true
    return fail('conflict', tr('connectChanged', L))
  }
  return row
}
/** the card closes and the waiting tool learns it is connected (a card that closed meanwhile changes nothing) */
const closeConnected = (exec: TurnExec, requestId: string, outcome: ConnectOutcome) => { exec.answer(requestId, CONNECT_TOOL, outcome) }
const stateOfView = (v: Integration, requestId: string, exec: TurnExec, oauth: boolean): TurnConnectResult => {
  if (v.status === 'connected') {
    closeConnected(exec, requestId, { outcome: 'connected', integrationId: v.id })
    return { state: 'connected', integrationId: v.id, status: v.status }
  }
  // a sign-in service is added first and signed in to next; a failed check keeps the card for another key
  return oauth ? { state: 'sign_in', integrationId: v.id, status: v.status } : { state: 'retry', integrationId: v.id, status: v.status, lastError: v.lastError }
}

async function connect(ctx: AppContext, exec: TurnExec, viewer: Viewer, body: Extract<TurnConnectBody, { action: 'connect' }>, card: Card, kept: ConnectCard, L: Locale): Promise<TurnConnectResult> {
  const s = card.service
  if (card.target !== 'service' || !s) return fail('validation', undefined, { fields: { 'body.action': 'Google Drive is connected with its own sign-in, then done' } })
  const keyed = s.auth === 'bearer' || s.auth === 'header'
  if (keyed && !body.sealed) return fail('validation', tr('connectNeedsKey', L), { fields: { 'body.sealed': 'the key, sealed for integration.secret' } })
  if (!keyed && body.sealed) return fail('validation', undefined, { fields: { 'body.sealed': 'this service takes no key' } })
  if (card.scope === 'personal' && body.access) return fail('validation', undefined, { fields: { 'body.access': 'only for a team connection' } })
  // what is saved is what the card showed (the tool refused hidden characters; checked again where it is saved)
  if ([card.name, card.notes, card.why].some((v) => v && hiddenText(v))) return fail('validation', tr('connectHidden', L))
  // the rules as they are now, before the key is even opened (another key after a failed check too)
  current(ctx, card, kept, L)
  // opened only here and handed straight to the store, which seals it for this connection (nothing keeps or logs it)
  const secret = keyed ? (await unsealOrFail(credentialsOf(ctx), body.sealed!, 'integration.secret', L)).trim() : undefined
  if (keyed && !secret) return fail('validation', tr('connectNeedsKey', L), { fields: { 'body.sealed': 'empty' } })
  if (secret && secret.length > KEY_MAX) return fail('validation', tr('connectKeyTooLong', L, { n: String(KEY_MAX) }), { fields: { 'body.sealed': `longer than ${KEY_MAX} characters` } })
  const svc = integrationsOf(ctx)
  // and again as it is now, after opening the key: nothing waits between this and the store's write
  const mine = current(ctx, card, kept, L)
  const access = card.scope === 'team' ? accessFor(body.access ?? 'me', viewer.id) : undefined
  let v: Integration
  if (mine) {
    // again after a failed check: the same connection gets the new key (no second one), and a team card's "who may use
    // it" as it is now goes the way Settings changes it (update: an admin, checked and audited)
    const patch: IntegrationPatch = { ...(secret !== undefined ? { secret } : {}), ...(access && body.access ? { access } : {}) }
    if (secret !== undefined) v = await svc.update(viewer, mine.id, patch, L)
    else {
      if (patch.access) await svc.update(viewer, mine.id, patch, L)
      v = s.auth === 'oauth' ? view(ctx.db, getRow(ctx.db, mine.id) ?? mine, viewer, L) : await svc.refresh(viewer, mine.id, L)
    }
  } else {
    v = await svc.create(viewer, {
      kind: s.kind, name: card.name, url: s.url, auth: s.auth, authHeader: s.authHeader, notes: card.notes ?? null, writePolicy: 'ask',
      ...(secret !== undefined ? { secret } : {}), ...(access ? { access } : {}),
    }, card.scope, L)
    kept.integrationId = v.id
  }
  kept.version = getRow(ctx.db, v.id)?.version ?? null
  return stateOfView(v, card.requestId, exec, s.auth === 'oauth')
}

async function done(ctx: AppContext, exec: TurnExec, viewer: Viewer, requestId: string, card: Card, kept: ConnectCard, L: Locale): Promise<TurnConnectResult> {
  if (card.target === 'google_drive') {
    let connected = false
    try { connected = googleDriveOf(ctx).status(viewer.id).status === 'connected' } catch {}
    if (!connected) return { state: 'retry', lastError: tr('connectNotYet', L) }
    closeConnected(exec, requestId, { outcome: 'connected', drive: true })
    return { state: 'connected' }
  }
  const row = current(ctx, card, kept, L)
  if (!row) return { state: 'retry', lastError: tr('connectNotStarted', L) }
  // the sign-in's callback checks the connection after it says "completed": a stored sign-in not yet checked is checked
  // now (refresh also checks again that this person manages it)
  const v = row.status === 'connected' || !row.secret_enc ? view(ctx.db, row, viewer, L) : await integrationsOf(ctx).refresh(viewer, row.id, L)
  if (v.status !== 'connected') return { state: 'retry', integrationId: v.id, status: v.status, lastError: v.lastError ?? tr('connectNotYet', L) }
  return stateOfView(v, requestId, exec, row.auth === 'oauth')
}
