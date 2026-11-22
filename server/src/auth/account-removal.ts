// What goes with a deleted account, area by area (docs/DECISIONS.md "Self-service account deletion"). The users row
// stays as a tombstone (id, name, deleted_at), so ON DELETE CASCADE never runs: every area registers here, in its
// route module's init, the rows it keeps per person and an optional step outside the database (a sign-in revoked at
// Google). removeAccount (admin/users.ts) runs them after the account is gone; the auth sweeper runs them once after
// each start for accounts deleted earlier (idempotent: a delete by user id).
//
// tests/unit/a-account-removal-coverage.test.ts reads every column that points at users(id), and those that hold a
// person's id without a foreign key (USER_COLUMNS_WITHOUT_FK): each is removed by
// removeAccount itself, by a hook here, or named in KEPT_WITH_ACCOUNT with the reason it stays.
import type { AppContext } from '../context'
import { hashToken } from './passwords'
import { authOf, readToken } from './service'
import { getTeamSettings } from '../admin/settings'
import { isFreeRoam } from '../app-config'

export interface AccountCleanup {
  /** the area's name, for the log */
  name: string
  /** `table.column` rows deleted for the person (`DELETE FROM table WHERE column = ?`) */
  rows: readonly string[]
  /** `table.column` the `after` step removes itself (it needs the row first: a token to revoke) */
  covers?: readonly string[]
  /** a step outside the database (revoke a sign-in), after the rows; its failure is logged, never thrown */
  after?: (ctx: AppContext, userId: string) => Promise<void> | void
}

const registry = new WeakMap<AppContext, Map<string, AccountCleanup>>()

/** An area's hook (route module init). Registering the same name again replaces it. */
export function registerAccountCleanup(ctx: AppContext, c: AccountCleanup): void {
  let m = registry.get(ctx)
  if (!m) { m = new Map(); registry.set(ctx, m) }
  m.set(c.name, c)
}

export function accountCleanups(ctx: AppContext): AccountCleanup[] {
  return [...(registry.get(ctx)?.values() ?? [])]
}

const IDENT = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/

/** Run every hook for one deleted account: the rows in one transaction, then the steps outside. Returns the number of
 * rows removed (the audit keeps counts only). */
export async function runAccountCleanups(ctx: AppContext, userId: string): Promise<number> {
  const hooks = accountCleanups(ctx)
  let n = 0
  ctx.db.transaction(() => {
    for (const h of hooks) for (const tc of h.rows) {
      if (!IDENT.test(tc)) throw new Error(`account cleanup ${h.name}: not a table.column: ${tc}`)
      const [t, col] = tc.split('.') as [string, string]
      n += ctx.db.query(`DELETE FROM ${t} WHERE ${col} = ?`).run(userId).changes
    }
  })()
  for (const h of hooks) {
    if (!h.after) continue
    try { await h.after(ctx, userId) } catch (err) { ctx.log.warn('account cleanup step failed', { err, area: h.name }) }
  }
  return n
}

/** Once after a start: accounts deleted before this build (or while a hook failed) lose what the hooks remove now. */
export async function cleanUpDeletedAccounts(ctx: AppContext): Promise<number> {
  const gone = ctx.db.query('SELECT id FROM users WHERE deleted_at IS NOT NULL').all() as { id: string }[]
  let n = 0
  for (const u of gone) n += await runAccountCleanups(ctx, u.id)
  return n
}

/** Columns that removeAccount (admin/users.ts) removes itself, in its own write (the coverage test reads this list). */
export const REMOVED_BY_REMOVE_ACCOUNT: readonly string[] = [
  'group_members.user_id', 'password_resets.user_id', 'integrations.owner_user_id', 'integration_user_allow.user_id',
  'engine_credentials.owner_user_id', 'user_profiles.user_id', 'user_status_messages.user_id', 'chat_pins.user_id',
  'room_pins.user_id', 'nav_folders.user_id',
]

/** Columns that hold a person's id without a foreign key to users(id) (the coverage test reads them with the ones that
 * have one, so they are decided too). */
export const USER_COLUMNS_WITHOUT_FK: readonly string[] = ['room_app_viewers.user_id', 'chat_thread_replies.author_id', 'chat_thread_notices.by_user', 'chat_message_notices.by_user', 'access_requests.owner_id', 'access_requests.decided_by', 'storage_notices.by_user', 'room_message_mentions.user_id', 'room_file_moves.actor', 'room_file_moves.sender']

/**
 * Columns that point at users(id) and stay after the account is deleted, with the reason (the coverage test checks
 * this list against the schema). Anything not here and not removed is a leak.
 */
export const KEPT_WITH_ACCOUNT: Record<string, string> = {
  'account_deletion_requests.user_id': 'the handled request (dates only) stays with the tombstone; the audit log has the history',
  'account_deletion_notices.source_id': 'the owners\' and admins\' inbox entry about the person: settled (read) at the deletion, ages out with the inbox',
  'chats.user_id': 'private chats go at removal for a self-requested deletion, else after the chat retention days (auth/sweeper.ts); shared project chats stay for the project',
  'memories.user_id': 'as private chats',
  'turns.user_id': 'usage history of the team (who used how much), kept until the chats it belongs to go',
  'attachments.user_id': 'chat attachments go with their chats',
  'invites.created_by': 'who made an invite (revoked at the deletion); team history',
  'team_links.created_by': 'who made a team link (revoked at the deletion); team history',
  'member_welcome.added_by': 'SET NULL; the other person\'s welcome card says who added them',
  'member_welcome.invited_by': 'SET NULL; as added_by',
  'plugin_installs.approved_by': 'who approved a team plugin; team history',
  'plugin_packages.installed_by': 'who installed a team plugin; team history',
  'projects.created_by': 'cleared when private chats go (auth/sweeper.ts); a team project stays for its people',
  'room_files.user_id': 'files they sent in shared rooms stay for the room, under the tombstone name',
  'room_file_moves.actor': 'who made a conversation a project: the record of each file it moved to the project (never shown or sent; rooms/file-moves.ts), kept with the moved file as the room\'s file row is',
  'room_file_moves.sender': 'as room_files.user_id: who sent a file that moved to the project (its uploader in the file history); never shown or sent',
  'room_messages.author_id': 'messages they sent in shared rooms stay, under the tombstone name (the delete page says so)',
  'room_messages.asked_by': 'as author_id',
  'room_message_mentions.user_id': 'where a message mentions them, kept by triggers from room_messages.mentions (which keeps their id like author_id): goes when the message is deleted, its mentions cleared or the room goes',
  'chat_thread_notices.by_user': 'other people\'s Inbox notices name the newest replier only while that account is active (chat/threads.ts chatThreadNoticeOut); the id alone stays until the notice is read or ages out',
  'chat_message_notices.by_user': 'who wrote the message of another person\'s notice in a shared chat: a phone\'s notification names them only while that account is active (chat/message-notices.ts chatMessageLabel); the id alone stays until the notice ages out',
  'access_requests.owner_id': 'whose chat or project another person asked to open: the key of the per-owner daily limit (chat/access-requests.ts), never shown; the request goes with the asker\'s account or ages with its target',
  'access_requests.decided_by': 'who answered another person\'s request (Share or Decline), never shown to anyone; the audit log has the history',
  'storage_notices.by_user': 'the admin who asked people to clean up (the next step of docs/decisions/20261116-storage-full-notices.md), named only while that account is active; the id alone stays until the notice ages out',
  'chat_thread_replies.author_id': 'replies they wrote under answers of shared chats stay, under the tombstone name, as room messages (the delete page says so); also on a self-requested deletion',
  'room_messages.visible_to': 'a room AI answer only they could see: shown to nobody else, goes with the room (room messages are never deleted one by one)',
  'room_members.user_id': 'a direct conversation keeps its member row so the other person still sees who it was with',
  'room_reactions.user_id': 'reactions in shared rooms, as messages',
  'room_ai_turns.user_id': 'usage of the room AI, as turns',
  'rooms.created_by': 'SET NULL; the room stays for its members',
  'room_categories.created_by': 'who made a team category: never shown or sent; SET NULL when the user row goes, and the category stays for the team (rooms/categories.ts)',
  'room_project_links.linked_by': 'who linked a channel to a project: never shown or sent; SET NULL when the user row goes, and the row goes with the channel or the project (rooms/project-link.ts)',
  'room_apps.created_by': 'SET NULL; an app belongs to its room and goes on ("Set up by someone who left")',
  'room_app_viewers.user_id': 'ids kept on purpose so people who left stay flagged as knowing an app\'s address until it gets a new one (goes with the app, or at "Get a new address")',
  'skill_shares.created_by': 'a team skill they shared stays for the team',
  'skill_share_merges.user_id': 'team skill history',
  'skill_suggestions.suggester_id': 'team skill history',
  'skill_suggestions.reviewer_id': 'team skill history',
  'slack_config.updated_by': 'SET NULL; who changed the team\'s Slack settings',
  'slack_user_tokens.user_id': 'revoked at Slack and removed at the next start (integrations/slack/service.ts retire)',
  'integration_requests.user_id': 'a request to the admins to add an app: the team\'s record',
  'service_requests.user_id': 'as integration_requests',
  'team_file_refs.user_id': 'a team file attached in a chat: goes with that chat',
  'chat_connection_urls.user_id': 'an address used in a chat: goes with that chat',
  'project_leavers.user_id': 'that they left a project: keeps them from being added back by an old rule',
  'guests.invited_by': 'who invited a guest: the guest\'s row must not go with the inviter\'s account (the id then names the deleted account)',
}

/** Component A's rows (auth module init): sign-ins, sign-in networks, the person's own notices and settings. Their
 * sessions are ended first (removeAccount), then removed here: that also removes their external apps' grants and
 * their open sign-in flows (ON DELETE CASCADE from sessions). */
export function registerAccountsCleanup(ctx: AppContext): void {
  registerAccountCleanup(ctx, {
    name: 'accounts',
    rows: [
      'remote_mcp_grants.user_id', 'remote_mcp_requests.user_id', 'remote_mcp_upload_links.user_id', 'remote_mcp_download_links.user_id',
      'sessions.user_id', 'app_signin_codes.user_id', 'login_nets.user_id', 'card_always_allow.user_id', 'user_web_access.user_id',
      'member_welcome.user_id', 'group_member_since.user_id',
      'account_deletion_notices.user_id', 'account_deletion_due_notices.user_id', 'reset_link_notices.user_id', 'handover_notices.user_id',
      'hosting_notices.user_id', 'engine_start_notices.user_id', 'storage_notices.user_id', 'credential_change_notices.user_id', 'team_join_notices.user_id',
      // a deleted guest's place and AI choice (docs/DECISIONS.md "Guests: only what they were invited to")
      'guests.user_id',
    ],
  })
}

// ---------------- the sign-ins of a removed account (TC-1974) ----------------
// A removed person's open window is sent to the sign-in page, where "you signed out elsewhere or your password changed"
// would be untrue. The sessions rows go with the account, so removeAccount leaves a short-lived note here: the hashes
// of the session tokens that ended with the removal. A request that still carries one of those tokens is refused with
// reason 'account_removed'. Only the holder of that token can present it, so nobody else learns that the account was
// removed (a wrong or unknown token gets the plain 401). Kept in memory: after a restart the plain line comes back.
const REMOVED_SIGN_IN_TTL_MS = 24 * 60 * 60 * 1000
// a guest switched off keeps the note for a week: an app opened days later still says why before any password (guest
// walkthrough S6), as long as they are still off
const GUEST_SIGN_IN_TTL_MS = 7 * REMOVED_SIGN_IN_TTL_MS
const REMOVED_SIGN_IN_MAX = 5000
/** `guest`: a guest's account switched off or deleted, 'left' when they left their one place themselves */
interface RemovedNote { until: number; userId: string; guest?: 'left' | 'removed'; team?: string }
const removedSignIns = new WeakMap<AppContext, Map<string, RemovedNote>>()

/** Before the sessions of a removed account are ended: remember their token hashes for a day. `guest`: the account is
 * a guest's, switched off (guest walkthrough S5/S6: 'left' when they left their place themselves); the note then lasts
 * a week and the 401 names the team, so their window shows the guest's own screen before any password. */
export function noteRemovedSignIns(ctx: AppContext, userId: string, guest?: 'left' | 'removed'): void {
  const rows = ctx.db.query('SELECT token_hash FROM sessions WHERE user_id = ?').all(userId) as { token_hash: string }[]
  if (!rows.length) return
  let m = removedSignIns.get(ctx)
  if (!m) { m = new Map(); removedSignIns.set(ctx, m) }
  const now = authOf(ctx).now()
  for (const [k, n] of m) if (n.until <= now) m.delete(k)
  const until = now + (guest ? GUEST_SIGN_IN_TTL_MS : REMOVED_SIGN_IN_TTL_MS)
  const team = guest ? getTeamSettings(ctx.db).teamName : undefined
  for (const r of rows) m.set(r.token_hash, { until, userId, ...(guest ? { guest, team } : {}) })
  // bounded: the oldest notes go first (Map keeps insertion order)
  while (m.size > REMOVED_SIGN_IN_MAX) m.delete(m.keys().next().value as string)
}

/** When the request carries a sign-in that ended because its account was removed: that, and for a guest how (left or
 * removed), else null. A guest's account that is on again (switched back on, made a member) is not removed any more. */
export function removedSignIn(ctx: AppContext, req: Request): { guest?: 'left' | 'removed'; team?: string } | null {
  const m = removedSignIns.get(ctx)
  if (!m?.size) return null
  const t = readToken(req, isFreeRoam(ctx.config))
  if (!t) return null
  const key = hashToken(t.token)
  const n = m.get(key)
  if (n === undefined) return null
  if (n.until <= authOf(ctx).now()) { m.delete(key); return null }
  if (n.guest && ctx.db.query("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(n.userId)) { m.delete(key); return null }
  return n.guest ? { guest: n.guest, ...(n.team ? { team: n.team } : {}) } : {}
}
