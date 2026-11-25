// "항상 허용" on a connector tool's read card, for good (docs/decisions/20261122-connector-always-allow.md, migration 441).
// The owner, 2026-11-22: "이 세션에서만 항상 허용이니깐 이걸 매 세션마다 봐야하는거잖아". One row per person, connection and
// tool: that tool's read card (read-mark.ts 'unsure', tools.ts unsureGate) is not raised for them again, in any chat, until
// they delete it in Settings › Allowed for Trina (GET /api/ai-allowances). Like Claude Code's "don't ask again", it is
// per tool. It counts only while the connection points at the address it had when chosen, while the team's "Always
// allow" switch is on (teamAllowsAlways; rows are then ignored, not deleted) and while the person's account is active.
// The same table keeps two more of the person's Always choices for a connection, each until they remove it: the write
// card's Always for one tool in a shared chat (a tool acting on the person's own things, tools.ts gate), and the shared
// connection card's Always (no tool, SHARED_TOOL: what the connection returns may show to the people in a shared chat),
// and "<connector> 전체 항상 허용" (ALL_TOOLS, docs/decisions/20261123-one-always-allow.md): every tool of that connection
// for this person, in every chat and their scheduled runs (each of the above at once), bound and ended the same way.
import type { Database } from 'bun:sqlite'
import type { ConnectorSendAllowance, ConnectorToolAllowance } from '@mycel/shared/api'
import { audit } from '../../admin/audit'
import { teamAllowsAlways } from '../../chat/always-allow'
import { toolTitle } from './card-lines'
import { accountKey, savedTools, UNKNOWN_ACCOUNT, type Row } from './store'

/** The tool name of "<connector> 전체 항상 허용": every tool of the connection (a NUL is never in an MCP tool's name) */
export const ALL_TOOLS = '\u0000all'

/** One of these rows of the person for this connection counts as things are now (the team's switch on, the account
 * active, the same address and account: `bind`); a row bound to another address or account is removed, so it never
 * comes back on its own */
function boundRow(db: Database, integrationId: string, userId: string, tools: readonly string[], bind: string): boolean {
  if (!teamAllowsAlways(db)) return false
  // the account is not known yet: ask, and keep every choice until it is (store.ts UNKNOWN_ACCOUNT)
  if (unknownBind(bind)) return false
  const rows = db.query(`SELECT a.tool, a.url FROM connector_tool_allow a JOIN users u ON u.id = a.user_id WHERE a.user_id = ? AND a.integration_id = ? AND a.tool IN (${tools.map(() => '?').join(', ')}) AND u.status = 'active' AND u.deleted_at IS NULL`)
    .all(userId, integrationId, ...tools) as { tool: string; url: string }[]
  let ok = false
  for (const r of rows) {
    if (r.url === bind) ok = true
    else db.query('DELETE FROM connector_tool_allow WHERE user_id = ? AND integration_id = ? AND tool = ?').run(userId, integrationId, r.tool)
  }
  return ok
}

/** Is this tool of this connection allowed for good by this person, as things are now: the tool's own Always, or the
 * whole connection's ("<connector> 전체 항상 허용")? */
export function toolAllowed(db: Database, row: Pick<Row, 'id' | 'url' | 'account'>, userId: string, tool: string): boolean {
  return boundRow(db, row.id, userId, tool === ALL_TOOLS ? [ALL_TOOLS] : [tool, ALL_TOOLS], sharedBind(row))
}

/** "<connector> 전체 항상 허용" is on for this person and connection, as things are now */
export const connectorAllowed = (db: Database, row: Pick<Row, 'id' | 'url' | 'account'>, userId: string): boolean => toolAllowed(db, row, userId, ALL_TOOLS)

/** Keep "<connector> 전체 항상 허용" (the person's own answer on a connector card), bound to the address and account. Audited. */
export function keepConnectorAllow(db: Database, integrationId: string, userId: string, bind: string, turnId: string | null): void {
  db.query('INSERT INTO connector_tool_allow (user_id, integration_id, tool, url, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, integration_id, tool) DO UPDATE SET url = excluded.url, created_at = excluded.created_at')
    .run(userId, integrationId, ALL_TOOLS, bind, new Date().toISOString())
  audit(db, { actor: userId, action: 'ai.always_allow', target: userId, detail: { kind: 'connector_all', integration: integrationId, on: true, via: 'card', turnId } })
}

/** Keep the person's "Always allow" for this tool (their own answer on the card). Audited. */
export function keepToolAllow(db: Database, row: Pick<Row, 'id' | 'url' | 'account'>, userId: string, tool: string, turnId: string | null): void {
  db.query('INSERT INTO connector_tool_allow (user_id, integration_id, tool, url, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, integration_id, tool) DO UPDATE SET url = excluded.url, created_at = excluded.created_at')
    .run(userId, row.id, tool, sharedBind(row), new Date().toISOString())
  audit(db, { actor: userId, action: 'ai.always_allow', target: userId, detail: { kind: 'connector_tool', integration: row.id, tool, on: true, via: 'card', turnId } })
}

/** A Microsoft 365 connection signed in before its account was named, named now for the tokens it already had
 * (service.ts nameMicrosoftAccount, the check path only, never a new sign-in): every person's choices bound to it while
 * its account was unknown follow it, so none is dropped (Always allow is final,
 * docs/decisions/20261122-connector-always-allow.md). A sign-in to another account never moves them (they ask again). */
export function rebindAccount(db: Database, integrationId: string, from: string, to: string): void {
  if (from !== to && !unknownBind(to)) db.query('UPDATE connector_tool_allow SET url = ? WHERE integration_id = ? AND url = ?').run(to, integrationId, from)
}

/** The tool name a row has for the shared connection card's Always (no tool: the whole connection's answers) */
export const SHARED_TOOL = ''

/** What the shared connection card's Always is bound to: the connection's address and the account it is signed in to
 * (a reconnect to another account asks again), never its version (a changed setting does not end a person's choice) */
export const sharedBind = (row: Pick<Row, 'url' | 'account'>) => `${row.url}#${accountKey(row.account)}`
const unknownBind = (bind: string) => bind.endsWith(`#${UNKNOWN_ACCOUNT}`)

/** The shared connection card's Always (chat/turn.ts confirmSharedConnection), or the whole connection's: this person
 * lets what this connection returns show to the people in any shared chat they ask in, without the card, as things are
 * now. */
export function sharedAllowed(db: Database, integrationId: string, userId: string, bind: string): boolean {
  return boundRow(db, integrationId, userId, [SHARED_TOOL, ALL_TOOLS], bind)
}

/** Keep the shared connection card's Always for good. Audited. */
export function keepSharedAllow(db: Database, integrationId: string, userId: string, bind: string, turnId: string | null): void {
  db.query('INSERT INTO connector_tool_allow (user_id, integration_id, tool, url, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, integration_id, tool) DO UPDATE SET url = excluded.url, created_at = excluded.created_at')
    .run(userId, integrationId, SHARED_TOOL, bind, new Date().toISOString())
  audit(db, { actor: userId, action: 'ai.always_allow', target: userId, detail: { kind: 'connector_shared', integration: integrationId, on: true, via: 'card', turnId } })
}

/** The one notice before the person's first use of a connection in a shared project or shared chat
 * (docs/decisions/20261123-shared-connector-warning-once.md; the owner: "공유 프로젝트에서 처음 쓰기전에 노출될 수 있습니다.
 * 경고 한번만 주고 시작하면 되지 않을까?"): a row per person, connection and place, whose tool is this prefix and the place
 * (`p:<project id>` or `c:<chat id>`). Kept in the same table so Settings › Allowed for Trina lists it and the person can
 * reset it (the notice then shows again). Bound like the Always rows (address and account): a reconnect to another account
 * shows it again. Not an Always: the team's "Always allow" switch does not end it (it lets nothing more through than the
 * notice said). */
export const WARNED_PREFIX = '\u0000seen:'
export const warnPlace = (shared: { kind: 'project'; projectId: string } | { kind: 'people'; chatId: string }) => shared.kind === 'project' ? `p:${shared.projectId}` : `c:${shared.chatId}`

/** The person saw (and went on from) the notice for this connection in this place, as the connection is now */
export function warnSeen(db: Database, integrationId: string, userId: string, place: string, bind: string): boolean {
  const r = db.query("SELECT a.url FROM connector_tool_allow a JOIN users u ON u.id = a.user_id WHERE a.user_id = ? AND a.integration_id = ? AND a.tool = ? AND u.status = 'active' AND u.deleted_at IS NULL")
    .get(userId, integrationId, WARNED_PREFIX + place) as { url: string } | null
  return !!r && r.url === bind && !unknownBind(bind)
}

/** Keep that the person went on from the notice (their own press). Audited. */
export function keepWarnSeen(db: Database, integrationId: string, userId: string, place: string, bind: string, turnId: string | null): void {
  db.query('INSERT INTO connector_tool_allow (user_id, integration_id, tool, url, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, integration_id, tool) DO UPDATE SET url = excluded.url, created_at = excluded.created_at')
    .run(userId, integrationId, WARNED_PREFIX + place, bind, new Date().toISOString())
  audit(db, { actor: userId, action: 'ai.always_allow', target: userId, detail: { kind: 'connector_warned', integration: integrationId, place, on: true, via: 'card', turnId } })
}

/** The place's name for Settings: the project's name, or the chat's title */
function placeName(db: Database, place: string): string {
  const id = place.slice(2)
  const r = place.startsWith('p:') ? db.query('SELECT name FROM projects WHERE id = ?').get(id) as { name: string } | null
    : db.query('SELECT title AS name FROM chats WHERE id = ?').get(id) as { name: string } | null
  return (r?.name ?? '').trim().slice(0, 500)
}

/** The allowance's id: `tool:` and the connection and tool, so a tool name with any character round-trips. */
const idOf = (integrationId: string, tool: string) => `tool:${Buffer.from(JSON.stringify([integrationId, tool])).toString('base64url')}`
function parseId(id: string): [string, string] | null {
  if (!id.startsWith('tool:')) return null
  try {
    const v = JSON.parse(Buffer.from(id.slice(5), 'base64url').toString('utf8')) as unknown
    return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' ? [v[0], v[1]] : null
  } catch { return null }
}

/** The person's own tool allowances that still count (the same address), newest first, named as the card named them. */
export function listToolAllows(db: Database, userId: string): ConnectorToolAllowance[] {
  const rows = db.query(`SELECT a.integration_id, a.tool, a.url AS bound, a.created_at, i.name, i.tools_rev, i.url, i.account FROM connector_tool_allow a JOIN integrations i ON i.id = a.integration_id
    WHERE a.user_id = ? ORDER BY a.created_at DESC`).all(userId) as { integration_id: string; tool: string; bound: string; created_at: string; name: string; tools_rev: number; url: string; account: string | null }[]
  // a row whose connection moved or signed in to another account no longer counts: removed here, so it never comes back
  // on its own if the address returns (code review)
  // (a connection whose account is not known yet keeps them, unlisted until it is: store.ts UNKNOWN_ACCOUNT)
  const stale = rows.filter((r) => r.bound !== sharedBind(r) && !unknownBind(sharedBind(r)))
  for (const r of stale) db.query('DELETE FROM connector_tool_allow WHERE user_id = ? AND integration_id = ? AND tool = ?').run(userId, r.integration_id, r.tool)
  return rows.filter((r) => r.bound === sharedBind(r)).map((r) => {
    if (r.tool === ALL_TOOLS) return { kind: 'connector_tool' as const, id: idOf(r.integration_id, r.tool), connection: r.name, tool: 'All tools', all: true, createdAt: r.created_at }
    if (r.tool.startsWith(WARNED_PREFIX)) return { kind: 'connector_tool' as const, id: idOf(r.integration_id, r.tool), connection: r.name, tool: '', shared: true, warned: placeName(db, r.tool.slice(WARNED_PREFIX.length)), createdAt: r.created_at }
    if (r.tool === SHARED_TOOL) return { kind: 'connector_tool' as const, id: idOf(r.integration_id, r.tool), connection: r.name, tool: '', shared: true, createdAt: r.created_at }
    const saved = savedTools(db, { id: r.integration_id, tools_rev: r.tools_rev }).find((t) => t.name === r.tool)
    return { kind: 'connector_tool' as const, id: idOf(r.integration_id, r.tool), connection: r.name, tool: toolTitle(saved ?? { name: r.tool }), createdAt: r.created_at }
  })
}

/** Take one back by its id; false when it is not this person's or not there. Audited. */
export function dropToolAllow(db: Database, userId: string, id: string): boolean {
  const p = parseId(id)
  if (!p) return false
  const n = db.query('DELETE FROM connector_tool_allow WHERE user_id = ? AND integration_id = ? AND tool = ?').run(userId, p[0], p[1]).changes
  if (n) audit(db, { actor: userId, action: 'ai.always_allow', target: userId, detail: { kind: p[1] === ALL_TOOLS ? 'connector_all' : p[1].startsWith(WARNED_PREFIX) ? 'connector_warned' : 'connector_tool', integration: p[0], tool: p[1], on: false, via: 'settings' } })
  return n > 0
}

/** The person's "Always allow" on connection send cards (tools.ts keepAlwaysAllow), as Settings › Allowed for Trina lists
 * them (decision 6 of docs/decisions/20261123-ask-registry-findings.md): their own connections set to send without
 * asking, and their own rows on team connections that still count (the same address). Never the team's rule (an
 * admin's). Id `send:<connection id>`. */
export function listSendAllows(db: Database, userId: string): ConnectorSendAllowance[] {
  const own = db.query("SELECT id, name, updated_at FROM integrations WHERE scope = 'personal' AND owner_user_id = ? AND write_policy = 'allow'").all(userId) as { id: string; name: string; updated_at: string }[]
  const team = db.query("SELECT i.id, i.name, a.created_at FROM integration_user_allow a JOIN integrations i ON i.id = a.integration_id WHERE a.user_id = ? AND i.scope = 'team' AND a.url = i.url").all(userId) as { id: string; name: string; created_at: string }[]
  return [
    ...own.map((r) => ({ kind: 'connector_send' as const, id: `send:${r.id}`, connection: r.name, scope: 'personal' as const, createdAt: r.updated_at })),
    ...team.map((r) => ({ kind: 'connector_send' as const, id: `send:${r.id}`, connection: r.name, scope: 'team' as const, createdAt: r.created_at })),
  ]
}

/** Take a send Always back: the person's own connection asks again (its write rule back to "ask"), or their row on a
 * team connection goes (the team's rule stays). False when it is not this person's or not there. Audited. */
export function dropSendAllow(db: Database, userId: string, id: string): boolean {
  if (!id.startsWith('send:')) return false
  const integrationId = id.slice(5)
  const row = db.query('SELECT id, scope, owner_user_id, google_app, kind, write_policy FROM integrations WHERE id = ?').get(integrationId) as { id: string; scope: string; owner_user_id: string | null; google_app: string | null; kind: string; write_policy: string } | null
  if (!row) return false
  if (row.scope === 'personal') {
    if (row.owner_user_id !== userId || row.write_policy !== 'allow') return false
    db.query("UPDATE integrations SET write_policy = 'ask', version = version + 1, updated_at = ? WHERE id = ? AND write_policy = 'allow'").run(new Date().toISOString(), row.id)
    if (row.google_app) audit(db, { actor: userId, action: 'google_app.write_policy', target: row.id, detail: { app: row.google_app, writePolicy: 'ask', via: 'settings' } })
    else audit(db, { actor: userId, action: 'integration.update', target: row.id, detail: { scope: row.scope, kind: row.kind, changed: ['writePolicy'], writePolicy: 'ask', via: 'allowances' } })
    return true
  }
  const n = db.query('DELETE FROM integration_user_allow WHERE integration_id = ? AND user_id = ?').run(row.id, userId).changes
  if (n) audit(db, { actor: userId, action: 'integration.always_allow', target: row.id, detail: { allow: false, via: 'allowances' } })
  return n > 0
}
