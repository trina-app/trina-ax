// The team invite link (onboarding stream E, docs/DECISIONS.md "E — 팀 초대 링크"; contract shared/src/api/team-links.ts).
//
// One link a leader pastes into KakaoTalk or Slack, beside the single-use invites of accounts.ts. What keeps it safe
// to post in a group chat:
//   - it only ever makes members (the table has no role column), in the groups the owner/admin chose;
//   - it has a number of uses (default: the plan's seats left, never above the plan's member limit) and an expiry
//     (7, 14 or 30 days); every join still takes a seat (system/limits.ts), checked inside the write;
//   - join attempts through one link are rate-limited from anywhere (rate-limit.ts perLink), on top of the per-IP limit
//     on unknown tokens;
//   - each join is audited and told to the owners (and the link's maker) in their inbox;
//   - it works only while its maker could still make it (an active owner or admin), like an invite;
//   - only one link is open: making a new one, or revoking, ends the old token for good (a new link = a new token);
//   - the token is in the address's #fragment and reaches the server only in a POST body.
// The token is kept sealed at rest (token_enc, credentials/vault.ts AES-256-GCM with a key file in
// <secrets>/team-links/) beside its sha256 (token_hash, the lookup), so the admin can copy the same link again later:
// a link already posted in a chat must keep working when the leader comes back for it.
import path from 'node:path'
import type { Context } from 'hono'
import type { Database } from 'bun:sqlite'
import {
  TEAM_LINK_DEFAULT_USES, TEAM_LINK_FRAGMENT_KEY,
  type CreateTeamLinkBody, type JoinTeamLinkBody, type JoinTeamLinkResponse, type Locale, type TeamLink, type TeamLinkInfo,
  type TeamLinkProblem, type TeamLinkResponse, type TeamLinkState,
} from '@mycel/shared/api'
import type { z } from 'zod'
import type { AppContext } from '../context'
import { newId } from '../db'
import type { AppEnv } from '../http/env'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { getTeamSettings } from '../admin/settings'
import { readSkill } from '../chat/skills'
import { Vault } from '../credentials/vault'
import { notifyTeamJoined } from '../notifications/service'
import type { Principal } from '../policy/access'
import { assertSeatFree, seatLimit, seatsUsed } from '../system/limits'
import { resolveLayout } from '../system/layout'
import { linkBase, viaOf } from './accounts'
import { msg, weakPasswordMessage, type MessageKey } from './messages'
import { hashPassword, hashToken, newToken, passwordProblem } from './passwords'
import { linkKey, tokenIpKeys } from './rate-limit'
import { authOf } from './service'
import { deriveUserId, ensurePersonalFolder, existingGroups, getUser, insertUser, userRef, usernameTaken } from './users'

const DAY_MS = 86_400_000
const SEAL_KIND = 'team-link'
const aadOf = (id: string) => `team-link:${id}`

const KEYS = { expired: 'teamLinkExpired', used_up: 'teamLinkUsedUp', revoked: 'teamLinkRevoked', full: 'teamLinkFull', tooMany: 'teamLinkTooMany', overPlan: 'teamLinkOverPlan', skillNotForNew: 'teamLinkSkillNotForNew', noKey: 'teamLinkNoKey' } as const satisfies Record<string, MessageKey>
const say = (k: keyof typeof KEYS, locale: Locale, n?: number) => msg(KEYS[k], locale).replace('{n}', String(n ?? ''))
const problemText = (p: TeamLinkProblem, locale: Locale) => say(p === 'stopped' ? 'revoked' : p, locale)

interface Row {
  id: string; token_hash: string; token_enc: string | null; key_version: number; group_ids: string; skill_path: string | null
  max_uses: number; uses: number; created_by: string | null; created_at: string; expires_at: string; revoked_at: string | null
}
const COLS = 'id, token_hash, token_enc, key_version, group_ids, skill_path, max_uses, uses, created_by, created_at, expires_at, revoked_at'

function parseIds(s: string): string[] { try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [] } catch { return [] } }

const vaults = new WeakMap<AppContext, Vault>()
/** The key of the sealed tokens: its own folder under the secrets (left out of backups and exports with them). */
function vaultOf(ctx: AppContext): Vault {
  let v = vaults.get(ctx)
  if (!v) { v = new Vault(path.join(resolveLayout(ctx.config).secretsDir, 'team-links')); vaults.set(ctx, v) }
  return v
}

/** The address to share: the token after #, so it never reaches a server, a proxy or a Referer. Office mode: the
 * office address, also when the admin works on the server Mac itself (a GET carries no Origin). */
export function teamLinkUrl(c: Context<AppEnv>, ctx: AppContext, token: string): string {
  let base = linkBase(c, ctx)
  if (ctx.config.office && ctx.config.publicOrigins[0] && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(base)) base = ctx.config.publicOrigins[0]
  return `${base}/join#${TEAM_LINK_FRAGMENT_KEY}=${token}`
}

/** Someone about to join with these groups (the same stand-in as Admin › "who will see what", access-explain.ts). */
const newMember = (groups: string[]): Principal => ({ id: '\u0000new-person', name: '', role: 'member', groups })

/** A team skill (skills/…, never a personal one) this person can open, or null. */
function teamSkill(ctx: AppContext, who: Principal, p: string): { path: string; name: string } | null {
  const s = readSkill(ctx.files, who, p)
  return s && s.path.split('/')[0] === 'skills' ? { path: s.path, name: s.name } : null
}

/** The link's maker can still make it now: an active owner or admin (a team link only makes members). */
function makerOk(db: Database, r: Row): boolean {
  if (!r.created_by) return false
  const by = getUser(db, r.created_by)
  return !!by && by.status === 'active' && !by.deleted_at && (by.role === 'owner' || by.role === 'admin')
}

function stateOf(db: Database, r: Row, now: number): TeamLinkState {
  if (!makerOk(db, r)) return 'stopped'
  if (Date.parse(r.expires_at) <= now) return 'expired'
  if (r.uses >= r.max_uses) return 'used_up'
  return 'active'
}

/** Why nobody can join with it now, or null. */
function problemOf(db: Database, r: Row, now: number): TeamLinkProblem | null {
  if (r.revoked_at) return 'revoked'
  const s = stateOf(db, r, now)
  if (s !== 'active') return s
  const max = seatLimit()
  return max !== null && seatsUsed(db) >= max ? 'full' : null
}

const openRow = (db: Database) => db.query(`SELECT ${COLS} FROM team_links WHERE revoked_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`).get() as Row | null
const rowByToken = (db: Database, token: string) => db.query(`SELECT ${COLS} FROM team_links WHERE token_hash = ?`).get(hashToken(token)) as Row | null

function seats(db: Database) { return { used: seatsUsed(db), limit: seatLimit() } }

function toTeamLink(c: Context<AppEnv>, ctx: AppContext, r: Row, viewer: Principal | null): TeamLink {
  let url: string | null = null
  if (r.token_enc) {
    try {
      const token = vaultOf(ctx).decrypt(aadOf(r.id), SEAL_KIND, r.token_enc, r.key_version)
      // the sealed copy must still be this row's token (a row's ciphertext moved onto another row does not decrypt,
      // and the hash keeps it honest)
      if (typeof token === 'string' && hashToken(token) === r.token_hash) url = teamLinkUrl(c, ctx, token)
    } catch { /* key file gone or changed: the admin makes a new link */ }
  }
  return {
    id: r.id, url, groupIds: parseIds(r.group_ids),
    skill: r.skill_path ? { path: r.skill_path, name: (viewer && teamSkill(ctx, viewer, r.skill_path)?.name) ?? null } : null,
    maxUses: r.max_uses, uses: r.uses, createdBy: userRef(ctx.db, r.created_by), createdAt: r.created_at, expiresAt: r.expires_at,
    state: stateOf(ctx.db, r, authOf(ctx).now()),
    limitedUntil: limitedUntil(ctx, r.id),
  }
}

/** While the per-link limit refuses every join (someone holding the link kept failing), until when; else null. The
 * card says so: the link looks active but lets nobody in, and a new link is not limited. */
function limitedUntil(ctx: AppContext, id: string): string | null {
  const a = authOf(ctx)
  const wait = a.limiter.retryAfter([linkKey(id)])
  return wait > 0 ? new Date(a.now() + wait * 1000).toISOString() : null
}

const viewerOf = (ctx: AppContext, userId: string): Principal | null => { try { return ctx.files.principal(userId) } catch { return null } }

/** GET /api/admin/team-link */
export function getTeamLink(c: Context<AppEnv>, ctx: AppContext): TeamLinkResponse {
  const r = openRow(ctx.db)
  return { link: r ? toTeamLink(c, ctx, r, viewerOf(ctx, c.get('auth')!.user.id)) : null, seats: seats(ctx.db) }
}

/** POST /api/admin/team-link: a new link with a new token; the open one stops working in the same write. */
export function createTeamLink(c: Context<AppEnv>, ctx: AppContext, b: z.output<typeof CreateTeamLinkBody>): TeamLinkResponse {
  const auth = c.get('auth')!
  const locale = c.get('locale')
  const groups = existingGroups(ctx.db, b.groupIds)
  if (groups.length !== new Set(b.groupIds).size) fail('validation', msg('unknownGroups', locale), { fields: { 'body.groupIds': 'unknown group' } })
  // the plan's seats (system/limits.ts): no new link while every seat is taken; each join checks again
  assertSeatFree(ctx.db, locale)
  const limit = seatLimit()
  const used = seatsUsed(ctx.db)
  const maxUses = b.maxUses ?? (limit !== null ? Math.max(1, limit - used) : TEAM_LINK_DEFAULT_USES)
  if (limit !== null && maxUses > limit) fail('plan_limit', say('overPlan', locale, limit), { fields: { 'body.maxUses': 'over_plan' }, params: { reason: 'max_uses_over_plan', limit } })
  let skillPath: string | null = null
  if (b.skillPath) {
    // someone joining with these groups must be able to open it (they land on it); the join checks again with the
    // real account, since the folder rules can change in between
    const s = teamSkill(ctx, newMember(groups), b.skillPath)
    if (!s) fail('validation', say('skillNotForNew', locale), { fields: { 'body.skillPath': 'not readable for a new member' } })
    skillPath = s!.path
  }
  const now = authOf(ctx).now()
  const id = newId()
  const token = newToken()
  let sealed: { enc: string; keyVersion: number }
  try { sealed = vaultOf(ctx).encrypt(aadOf(id), SEAL_KIND, token) } catch (e) {
    c.get('log').warn('team link key unavailable', { err: String(e).slice(0, 200) })
    return fail('internal', say('noKey', locale))
  }
  const at = new Date(now).toISOString()
  const expiresAt = new Date(now + b.expiresInDays * DAY_MS).toISOString()
  ctx.db.transaction(() => {
    // one open link at a time: the one before stops working (its sealed token is wiped, its hash stays for "revoked")
    const replaced = ctx.db.query('UPDATE team_links SET revoked_at = ?, revoked_by = ?, token_enc = NULL WHERE revoked_at IS NULL').run(at, auth.user.id).changes
    ctx.db.query('INSERT INTO team_links (id, token_hash, token_enc, key_version, group_ids, skill_path, max_uses, uses, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)')
      .run(id, hashToken(token), sealed.enc, sealed.keyVersion, JSON.stringify(groups), skillPath, maxUses, auth.user.id, at, expiresAt)
    audit(ctx.db, { actor: auth.user.id, action: 'team_link.create', target: id, detail: { role: 'member', groupIds: groups, maxUses, expiresAt, ...(skillPath ? { skillPath } : {}), ...(replaced ? { replaced } : {}) } })
  }).immediate()
  return getTeamLink(c, ctx)
}

/** DELETE /api/admin/team-link: the open link, whatever its state, stops working for good; its sealed token is wiped
 * (a new link gets a new one). Read and changed in one write: a link another admin makes at the same moment stays. */
export function revokeTeamLink(c: Context<AppEnv>, ctx: AppContext): void {
  const auth = c.get('auth')!
  const at = new Date(authOf(ctx).now()).toISOString()
  const done = ctx.db.transaction(() => {
    const r = openRow(ctx.db)
    if (!r) return false
    ctx.db.query('UPDATE team_links SET revoked_at = ?, revoked_by = ?, token_enc = NULL WHERE id = ? AND revoked_at IS NULL').run(at, auth.user.id, r.id)
    audit(ctx.db, { actor: auth.user.id, action: 'team_link.revoke', target: r.id, detail: { uses: r.uses, maxUses: r.max_uses } })
    return true
  }).immediate()
  if (!done) fail('not_found')
}

/**
 * The open link made by someone who can no longer invite (disabled, deleted, no longer an admin) stops for good, like
 * their invites (admin/users.ts revokeInvitesBy). The check at every use is the second line: without this, enabling
 * the person again would bring back a link they had posted in a chat.
 */
export function revokeTeamLinksBy(ctx: AppContext, userId: string): number {
  return ctx.db.query('UPDATE team_links SET revoked_at = ?, token_enc = NULL WHERE created_by = ? AND revoked_at IS NULL').run(new Date(authOf(ctx).now()).toISOString(), userId).changes
}

/** Unknown tokens count against the caller's IP, like invite and reset tokens (accounts.ts). */
function tokenGuard(ctx: AppContext, ip: string | null): { fail(): void } {
  const a = authOf(ctx)
  const keys = tokenIpKeys(ip)
  const wait = a.limiter.retryAfter(keys)
  if (wait > 0) fail('rate_limited', undefined, { retryAfter: wait })
  return { fail: () => a.limiter.fail(keys) }
}

/** POST /api/team-link/info (public) */
export function teamLinkInfo(c: Context<AppEnv>, ctx: AppContext, token: string): TeamLinkInfo {
  const guard = tokenGuard(ctx, c.get('info').ip)
  const r = rowByToken(ctx.db, token)
  if (!r) { guard.fail(); return fail('not_found') }
  const problem = problemOf(ctx.db, r, authOf(ctx).now())
  const skillName = !problem && r.skill_path ? teamSkill(ctx, newMember(existingGroups(ctx.db, parseIds(r.group_ids))), r.skill_path)?.name ?? null : null
  return { teamName: getTeamSettings(ctx.db).teamName, valid: problem === null, problem, expiresAt: r.expires_at, skillName }
}

class UsernameTaken extends Error {}

/** POST /api/team-link/join (public): a member account in the link's groups, signed in. */
export async function joinTeamLink(c: Context<AppEnv>, ctx: AppContext, b: z.output<typeof JoinTeamLinkBody>): Promise<JoinTeamLinkResponse> {
  const a = authOf(ctx)
  const locale = c.get('locale')
  const info = c.get('info')
  const guard = tokenGuard(ctx, info.ip)
  const r = rowByToken(ctx.db, b.token)
  if (!r) { guard.fail(); return fail('not_found') }
  // every attempt through this link counts from anywhere, before the slow password hash, so a link posted in a big
  // chat cannot be used to hammer the server or to try usernames; only a join that worked is taken back below
  const hold = a.limiter.hold([linkKey(r.id)])
  if (hold.wait > 0) {
    if (a.firstInMinute(`rl-link:${r.id}`)) audit(ctx.db, { actor: null, action: 'team_link.rate_limited', target: r.id, detail: { ip: info.ip, via: viaOf(info) } })
    fail('rate_limited', say('tooMany', locale), { retryAfter: hold.wait })
  }
  const before = problemOf(ctx.db, r, a.now())
  if (before === 'full') fail('plan_limit', say('full', locale), { params: { reason: 'seat_limit', limit: seatLimit() ?? 0 } })
  if (before) fail('gone', problemText(before, locale), { params: { reason: before } })
  if (usernameTaken(ctx.db, b.username)) fail('conflict', msg('usernameTaken', locale), { fields: { 'body.username': 'taken' } })
  const weak = passwordProblem(b.password, { username: b.username })
  if (weak) fail('validation', weakPasswordMessage(weak, locale), { fields: { 'body.password': weak } })
  const passwordHash = await hashPassword(b.password)
  const groups = existingGroups(ctx.db, parseIds(r.group_ids))
  let id = ''
  const tx = ctx.db.transaction((): TeamLinkProblem | 'ok' => {
    const now = a.now()
    const at = new Date(now).toISOString()
    if (usernameTaken(ctx.db, b.username)) throw new UsernameTaken()
    // checked again inside the write: the link may have been revoked, replaced, used up or its maker demoted during
    // the (slow) hash, and two joins at once must not both take the last use or the last seat
    const fresh = ctx.db.query(`SELECT ${COLS} FROM team_links WHERE id = ?`).get(r.id) as Row | null
    if (!fresh) return 'revoked'
    const why = problemOf(ctx.db, fresh, now)
    if (why) return why
    if (ctx.db.query('UPDATE team_links SET uses = uses + 1 WHERE id = ? AND revoked_at IS NULL AND uses < max_uses AND expires_at > ?').run(r.id, at).changes !== 1) return 'used_up'
    id = deriveUserId(ctx.db, b.username, ctx.files.fx.root)
    // always a member: a team link has no role of its own
    insertUser(ctx.db, { id, username: b.username, name: b.name, passwordHash, role: 'member', locale: b.locale ?? null, mustChangePassword: false, groupIds: groups })
    audit(ctx.db, { actor: id, action: 'team_link.join', target: r.id, detail: { userId: id, role: 'member', groupIds: groups, uses: fresh.uses + 1, maxUses: fresh.max_uses, ip: info.ip, via: viaOf(info) } })
    return 'ok'
  })
  let result: TeamLinkProblem | 'ok'
  try { result = tx.immediate() } catch (e) {
    if (e instanceof UsernameTaken) fail('conflict', msg('usernameTaken', locale), { fields: { 'body.username': 'taken' } })
    throw e
  }
  if (result! === 'full') fail('plan_limit', say('full', locale), { params: { reason: 'seat_limit', limit: seatLimit() ?? 0 } })
  if (result! !== 'ok') fail('gone', problemText(result!, locale), { params: { reason: result! } })
  // a join that worked does not count toward the link's limit (its uses cap those): a big team joining at once is not
  // turned away, only failed and refused attempts add up
  hold.release()
  ensurePersonalFolder(ctx.files.fx.root, id)
  // the owners hear about every join, and so does the admin who made the link
  const owners = (ctx.db.query("SELECT id FROM users WHERE role = 'owner' AND status = 'active' AND deleted_at IS NULL").all() as { id: string }[]).map((u) => u.id)
  notifyTeamJoined(ctx, r.created_by ? [...owners, r.created_by] : owners, id)
  // the skill the link names, only when the new member can open it now (the folder rules decide, not the link)
  const me = viewerOf(ctx, id)
  const skill = r.skill_path && me ? teamSkill(ctx, me, r.skill_path) : null
  const signed = a.signIn(c, id, b.client, b.tokenMode)
  return { ...signed, next: skill ? `/skills?run=${encodeURIComponent(skill.path)}` : null }
}
