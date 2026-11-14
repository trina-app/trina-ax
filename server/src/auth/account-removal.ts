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
export const USER_COLUMNS_WITHOUT_FK: readonly string[] = ['room_app_viewers.user_id']

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
  'room_messages.author_id': 'messages they sent in shared rooms stay, under the tombstone name (the delete page says so)',
  'room_messages.asked_by': 'as author_id',
  'room_messages.visible_to': 'a room AI answer only they could see: shown to nobody else, goes with the room (room messages are never deleted one by one)',
  'room_members.user_id': 'a direct conversation keeps its member row so the other person still sees who it was with',
  'room_reactions.user_id': 'reactions in shared rooms, as messages',
  'room_ai_turns.user_id': 'usage of the room AI, as turns',
  'rooms.created_by': 'SET NULL; the room stays for its members',
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
      'remote_mcp_grants.user_id', 'remote_mcp_requests.user_id', 'remote_mcp_upload_links.user_id',
      'sessions.user_id', 'login_nets.user_id', 'card_always_allow.user_id', 'user_web_access.user_id',
      'member_welcome.user_id', 'group_member_since.user_id',
      'account_deletion_notices.user_id', 'account_deletion_due_notices.user_id', 'reset_link_notices.user_id', 'handover_notices.user_id',
      'hosting_notices.user_id', 'credential_change_notices.user_id', 'team_join_notices.user_id',
      // a deleted guest's place and AI choice (docs/DECISIONS.md "Guests: only what they were invited to")
      'guests.user_id',
    ],
  })
}
