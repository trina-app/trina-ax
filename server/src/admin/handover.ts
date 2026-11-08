// 팀장 넘기기 (onboarding v6 §12; docs/DECISIONS.md "W6 — Onboarding v6: easy owner handover"; contract
// shared/src/api/handover.ts, admin.ts createInvite.leadFor and transferOwnership).
//
// The first account stays the owner. The handover is made easy instead, and it must leave whoever set the team up (our
// own staff, often) no hidden access:
//   - the lead flag ("이 사람이 팀장이에요") is the owner's only (checked here, not by a hidden checkbox), on a single-use
//     invite that always makes a member in the team's group and is open 3 days; one is open at a time (a new one
//     revokes the open one and clears older hints in the same write); it is a hint only: nothing about a join, the link
//     or a forward changes a role;
//   - the card and its Inbox notice show facts the joiner cannot set (the owner's own words for whom the link is, the
//     account's username and join time beside its display name), and only while they hold: the flagging owner is still
//     the owner and the joiner is active;
//   - the role moves only with the owner's [넘기기] and password (admin/users.ts transferOwnership: one locked write);
//     after it, the connections made with the old owner's own accounts that they left ticked are ended here, after the
//     commit (a failure never undoes the transfer), and both people, the other admins and their open windows are told;
//   - a hosted team gets no flag and no card until its control plane refuses owner and admin reset links
//     (server.json handoverSafe); with it on, a transfer sets the recovery lock that `mycel-ctl reset-link` keeps
//     (system/cli.ts) until the control plane says the new owner claimed recovery.
import type { Database } from 'bun:sqlite'
import type { Context } from 'hono'
import {
  LEAD_INVITE_HOURS, type EndedConnection, type HandoverConnection, type HandoverConnectionRef,
  type HandoverRecovery, type HandoverState, type LeadCard, type Locale,
} from '@mycel/shared/api'
import type { AppConfig } from '../app-config'
import type { AppContext } from '../context'
import type { AppEnv } from '../http/env'
import { fail } from '../http/errors'
import { audit } from './audit'
import { getSetting, setSetting, teamDefaultLocale } from './settings'
import { readWelcome } from '../onboarding/welcome'
import { existingGroups, getUser } from '../auth/users'
import { authOf } from '../auth/service'
import { isHosted, runKindOf } from '../system/deployment'
import { notificationsOf } from '../notifications/service'
import { credentialsOf, getRow as getCredential, metaOf, SUBSCRIPTION } from '../credentials/store'
import { deleteCredential } from '../credentials/service'
import { engineStatusCache } from './engines'
import { maskEmail } from '../credentials/openai-oauth'
import { currentOwnerId, leadHolds, shownName } from './handover-notices'
import { signInOf } from '../auth/team-sign-ins'

// ---------------- words ----------------
const TEXT = {
  ownerChanged: { ko: '이미 팀장이 바뀌었어요. 화면을 새로 고쳐 주세요.', en: 'The owner has already changed. Please reload the page.', id: 'Pemilik tim sudah berganti. Muat ulang halaman ini.', ja: 'オーナーはすでに変わっています。画面を再読み込みしてください。', es: 'El propietario ya cambió. Vuelva a cargar la página.' },
  targetNotReady: { ko: '임시 비밀번호를 바꾸고 한 번 이상 들어온 사람에게만 팀장을 넘길 수 있어요.', en: 'You can hand the team only to someone who has changed their temporary password and signed in at least once.', id: 'Tim hanya bisa diserahkan kepada orang yang sudah mengganti kata sandi sementara dan pernah masuk.', ja: '仮パスワードを変更し、一度以上サインインした人にだけオーナーを引き継げます。', es: 'Solo puede entregar el equipo a alguien que ya cambió su contraseña temporal y entró al menos una vez.' },
  leadOwnerOnly: { ko: '팀장 링크는 팀장만 만들 수 있어요.', en: 'Only the owner can make a link for the team lead.', id: 'Hanya pemilik tim yang bisa membuat tautan untuk ketua tim.', ja: 'リーダー用のリンクを作れるのはオーナーだけです。', es: 'Solo el propietario puede crear el enlace para el responsable del equipo.' },
  leadNotOffered: { ko: '이 팀에서는 아직 팀장 링크를 쓸 수 없어요. 멤버 › ··· › 팀장 넘기기를 써 주세요.', en: 'Lead links are not available on this team yet. Use Members › ··· › Hand over the team.', id: 'Tautan ketua tim belum tersedia di tim ini. Gunakan Anggota › ··· › Serahkan tim.', ja: 'このチームではまだリーダー用リンクを使えません。メンバー › ··· › オーナーを引き継ぐ を使ってください。', es: 'Los enlaces para el responsable aún no están disponibles en este equipo. Use Miembros › ··· › Entregar el equipo.' },
  leadOwnerRevoke: { ko: '팀장 링크는 팀장만 멈출 수 있어요.', en: 'Only the owner can stop a link for the team lead.', id: 'Hanya pemilik tim yang bisa menghentikan tautan ketua tim.', ja: 'リーダー用のリンクを止められるのはオーナーだけです。', es: 'Solo el propietario puede detener el enlace para el responsable.' },
  leadMemberOnly: { ko: '팀장 링크로는 팀원으로만 들어와요. 관리자와 팀장 권한은 넘길 때 생겨요.', en: 'A lead link always makes a member. Admin and owner rights come only with the handover.', id: 'Tautan ketua tim selalu membuat anggota. Hak admin dan pemilik baru diberikan saat penyerahan.', ja: 'リーダー用リンクで参加するのは常にメンバーです。管理者とオーナーの権限は引き継ぎのときに付きます。', es: 'Un enlace para el responsable siempre crea un miembro. Los permisos de administrador y propietario llegan solo con la entrega.' },
  // realtime, to every open window of the two people (the web refreshes its role and shows this line)
  toOld: { ko: '팀장이 바뀌었어요 · 이제 {name}님이 이어서 해요', en: 'The owner changed · {name} takes it from here', id: 'Pemilik tim berganti · sekarang {name} yang melanjutkan', ja: 'オーナーが変わりました · ここからは{name}さんが進めます', es: 'Cambió el propietario · ahora sigue {name}' },
  toNew: { ko: '이제 내가 팀장이에요 · {name}님은 관리자로 남아 있어요', en: 'You are the owner now · {name} stays an admin', id: 'Sekarang Anda pemilik tim · {name} tetap admin', ja: 'あなたがオーナーになりました · {name}さんは管理者のままです', es: 'Ahora usted es el propietario · {name} sigue como administrador' },
  // the desktop notification of a lead join: generic, no name the joiner chose
  leadJoined: { ko: '팀장 링크로 누군가 들어왔어요 · 팀장을 넘길지 확인해 주세요', en: 'Someone joined with your team lead link · check whether to hand over the team', id: 'Seseorang bergabung lewat tautan ketua tim · periksa apakah tim akan diserahkan', ja: 'リーダー用リンクで誰かが参加しました · オーナーを引き継ぐか確認してください', es: 'Alguien entró con su enlace para el responsable · revise si entrega el equipo' },
} satisfies Record<string, Record<Locale, string>>
type TextKey = keyof typeof TEXT
export const handoverText = (k: TextKey, locale: Locale, vars: Record<string, string> = {}) =>
  TEXT[k][locale].replace(/\{(\w+)\}/g, (m, v: string) => vars[v] ?? m)

// ---------------- where it is offered ----------------
/** The lead flag and the card: everywhere but a hosted team whose control plane does not yet refuse owner and admin
 * reset links (server.json handoverSafe). */
export function flagOffered(config: AppConfig): boolean {
  return !isHosted(config) || config.handoverSafe === true
}

/** Who can still set an owner's or admin's password outside the app, for the dialog and the notices. */
export function recoveryOf(config: AppConfig): HandoverRecovery | null {
  const kind = runKindOf(config)
  if (kind === 'hosted') return config.handoverSafe ? null : 'hosted'
  if (kind === 'office') return 'server_mac'
  if (kind === 'selfhost') return 'server'
  return null
}

// ---------------- the hosted recovery lock (system/cli.ts reset-link) ----------------
/** set by a transfer on a hosted team with handoverSafe on; cleared when the control plane reports the claim */
export const RECOVERY_LOCK_KEY = 'handover.recoveryLock'
export interface RecoveryLock { since: string; transferId: string }
export const recoveryLock = (db: Database) => getSetting<RecoveryLock>(db, RECOVERY_LOCK_KEY) ?? null
/** While the lock is set, `reset-link` (both forms) refuses an owner or an admin target: whoever holds the hosting
 * account cannot mint a link for the people who run the team after a handover. A member stays reachable. */
export function resetLinkRefused(db: Database, target: { role: string }): boolean {
  return !!recoveryLock(db) && (target.role === 'owner' || target.role === 'admin')
}
export function clearRecoveryLock(db: Database): boolean {
  const had = !!recoveryLock(db)
  db.query('DELETE FROM settings WHERE key = ?').run(RECOVERY_LOCK_KEY)
  if (had) audit(db, { actor: null, action: 'owner.recovery_claimed', detail: null })
  return had
}

// ---------------- the lead invite (auth/accounts.ts createInvite / acceptInvite) ----------------
/** What a lead invite carries, decided here, never by the request: a member, the team's own group (when the welcome
 * steps made it and it is still there), 3 days. Refuses anyone but the owner, a hosted team without handoverSafe, and
 * an admin role asked for with the flag. */
export function leadInviteShape(c: Context<AppEnv>, ctx: AppContext, b: { role: string }): { groupIds: string[]; hours: number } {
  const locale = c.get('locale')
  if (c.get('auth')!.user.role !== 'owner') fail('forbidden', handoverText('leadOwnerOnly', locale))
  if (!flagOffered(ctx.config)) fail('conflict', handoverText('leadNotOffered', locale), { params: { reason: 'lead_not_offered' } })
  if (b.role !== 'member') fail('validation', handoverText('leadMemberOnly', locale), { fields: { 'body.role': 'lead invites are members' } })
  const g = readWelcome(ctx)?.teamGroup?.id
  return { groupIds: g ? existingGroups(ctx.db, [g]) : [], hours: LEAD_INVITE_HOURS }
}

/** Inside createInvite's write, before the insert: the caller is still the active owner (read again: the session's
 * copy may be older), and the lead invite before stops: an open one is revoked (its link stops working), a used one
 * loses its hint (one card at most). Returns how many open ones were revoked. */
export function leadInviteBeforeInsert(c: Context<AppEnv>, ctx: AppContext, at: string): number {
  const me = c.get('auth')!.user.id
  if (currentOwnerId(ctx.db) !== me) fail('forbidden', handoverText('leadOwnerOnly', c.get('locale')))
  const revoked = ctx.db.query('UPDATE invites SET revoked_at = ? WHERE lead_hint = 1 AND used_at IS NULL AND revoked_at IS NULL').run(at).changes
  ctx.db.query('UPDATE invites SET lead_hint = 0 WHERE lead_hint = 1').run()
  return revoked
}

/** After someone joined with a lead invite (acceptInvite, after its write): the flagging owner's Inbox notice (also
 * pushed: push-service.ts SOURCES) and a desktop notification in their open windows, while the hint holds. */
export function afterLeadJoin(ctx: AppContext, inviteId: string): void {
  if (!flagOffered(ctx.config)) return
  try {
    const i = ctx.db.query('SELECT lead_hint_by, used_at FROM invites WHERE id = ? AND lead_hint = 1').get(inviteId) as { lead_hint_by: string | null; used_at: string | null } | null
    if (!i?.lead_hint_by || !i.used_at || !leadHolds(ctx.db, inviteId, i.lead_hint_by)) return
    notificationsOf(ctx).handoverNotice(i.lead_hint_by, 'owner.lead_joined', inviteId, i.used_at)
    ctx.services.realtime.publish(i.lead_hint_by, { type: 'notice', data: { level: 'info', code: 'owner_lead_joined', message: handoverText('leadJoined', localeOf(ctx.db, i.lead_hint_by)) } })
  } catch (e) { ctx.log.warn('the lead join was not told', { err: e }) }
}

const localeOf = (db: Database, id: string): Locale => getUser(db, id)?.locale ?? teamDefaultLocale(db)

// ---------------- the owner's state, the card ----------------
export function leadCardOf(ctx: AppContext, ownerId: string): LeadCard | null {
  const r = ctx.db.query(`SELECT i.id, i.lead_for, i.used_at, i.lead_dismissed_at, u.id AS uid, u.name, u.username FROM invites i JOIN users u ON u.id = i.used_by
    WHERE i.lead_hint = 1 AND i.lead_hint_by = ? AND i.used_at IS NOT NULL ORDER BY i.used_at DESC LIMIT 1`).get(ownerId) as
    { id: string; lead_for: string | null; used_at: string; lead_dismissed_at: string | null; uid: string; name: string; username: string } | null
  if (!r || !leadHolds(ctx.db, r.id, ownerId)) return null
  return { inviteId: r.id, leadFor: r.lead_for ?? '', user: { id: r.uid, name: shownName(r.name, r.username), username: r.username }, joinedAt: r.used_at, dismissed: !!r.lead_dismissed_at }
}

export function handoverState(ctx: AppContext, ownerId: string): HandoverState {
  const flag = flagOffered(ctx.config)
  const now = new Date(authOf(ctx).now()).toISOString()
  const open = flag ? ctx.db.query(`SELECT id, lead_for, expires_at FROM invites WHERE lead_hint = 1 AND lead_hint_by = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC LIMIT 1`).get(ownerId, now) as { id: string; lead_for: string | null; expires_at: string } | null : null
  return {
    flag, recovery: recoveryOf(ctx.config),
    openLead: open ? { inviteId: open.id, leadFor: open.lead_for ?? '', expiresAt: open.expires_at } : null,
    card: flag ? leadCardOf(ctx, ownerId) : null,
    connections: ownConnections(ctx, ownerId),
  }
}

/** ✕ on Home's card: the card goes, the Inbox notice stays. */
export function dismissLead(c: Context<AppEnv>, ctx: AppContext, inviteId: string): void {
  const me = c.get('auth')!.user.id
  const n = ctx.db.query('UPDATE invites SET lead_dismissed_at = COALESCE(lead_dismissed_at, ?) WHERE id = ? AND lead_hint = 1 AND lead_hint_by = ? AND used_at IS NOT NULL').run(new Date(authOf(ctx).now()).toISOString(), inviteId, me).changes
  if (!n) fail('not_found')
  audit(ctx.db, { actor: me, action: 'lead_hint.dismiss', target: inviteId })
}

// ---------------- the owner's own connections ----------------
/** What keeps serving the team on this person's own accounts: team AI sign-ins they made (a Claude or ChatGPT
 * subscription; the team's API keys are the team's), Drive shares signed in with their Google account, and team
 * connections to services (an MCP server such as Higgsfield) whose OAuth sign-in was theirs last (a key typed into a
 * connection is the team's). */
export function ownConnections(ctx: AppContext, userId: string): HandoverConnection[] {
  const out: HandoverConnection[] = []
  // whose token a team AI connection runs on: team_sign_ins alone (set when it is made or its token replaced or signed in
  // again, auth/team-sign-ins.ts); created_by says only who made the row, and an admin may have put their token in since
  const creds = ctx.db.query(`SELECT c.id, c.kind, c.label, c.meta FROM engine_credentials c JOIN team_sign_ins s ON s.kind = 'team_ai' AND s.target_id = c.id
    WHERE c.owner_user_id IS NULL AND s.user_id = ? ORDER BY c.created_at, c.id`).all(userId) as { id: string; kind: string; label: string; meta: string }[]
  for (const r of creds) {
    if (!SUBSCRIPTION.has(r.kind as never)) continue
    out.push({ kind: 'team_ai', id: r.id, label: r.label, provider: r.kind === 'chatgpt' ? 'chatgpt' : 'claude', account: metaOf(r).emailMasked ?? null })
  }
  try {
    const shares = ctx.db.query('SELECT id, name, account FROM drive_team_shares WHERE owner_user_id = ? AND secret_enc IS NOT NULL ORDER BY lower(name), id').all(userId) as { id: string; name: string; account: string }[]
    for (const s of shares) {
      let email: string | null = null
      try { email = (JSON.parse(s.account) as { email?: string | null }).email ?? null } catch { /* none */ }
      out.push({ kind: 'drive_share', id: s.id, label: s.name, provider: 'google', account: maskEmail(email) })
    }
  } catch { /* an older database without Drive shares */ }
  try {
    // whose sign-in each team connection serves on: team_sign_ins alone (set by the sign-in; a connection signed in
    // before that record existed is unknown and not listed: fail closed)
    const conns = ctx.db.query(`SELECT i.id, i.name FROM integrations i JOIN team_sign_ins s ON s.kind = 'team_connection' AND s.target_id = i.id
      WHERE i.scope = 'team' AND i.auth = 'oauth' AND i.secret_enc IS NOT NULL AND s.user_id = ? ORDER BY lower(i.name), i.id`).all(userId) as { id: string; name: string }[]
    for (const c of conns) out.push({ kind: 'team_connection', id: c.id, label: c.name, provider: 'service', account: null })
  } catch { /* an older database without connections */ }
  return out
}

type Planned = { kind: HandoverConnectionRef['kind']; id: string; label: string }
/** Of what the caller asked to end, what is theirs now (inside the transfer's write: kept on the transfer). */
export function toEndOf(ctx: AppContext, owner: string, refs: readonly HandoverConnectionRef[]): Planned[] {
  const mine = new Map(ownConnections(ctx, owner).map((x) => [`${x.kind}:${x.id}`, x]))
  const out = new Map<string, Planned>()
  for (const r of refs) { const c = mine.get(`${r.kind}:${r.id}`); if (c) out.set(`${r.kind}:${r.id}`, { kind: c.kind, id: c.id, label: c.label }) }
  return [...out.values()]
}

/** End what `owner` asked to end, of what is still theirs (the old owner's connections; `actor`: who does it now, the
 * old owner at the transfer, the new owner from the Inbox). Each one on its own (one failing never stops the next),
 * audited; the service is told (Google, the connection's OAuth server) after the tokens are gone here. */
/** A sign-in made after `since` (the transfer): a new decision, never ended by a retry or the new owner's [끊기]. A
 * team AI connection made after it, a share or a connection signed in again after it. Unknown times are not newer. */
function signedInAfter(ctx: AppContext, ref: HandoverConnectionRef, since: string): boolean {
  const at = signInOf(ctx.db, ref.kind, ref.id)?.at
  return !!at && at > since
}

export async function endConnections(ctx: AppContext, owner: string, refs: readonly HandoverConnectionRef[], actor: string | null = owner, o: { since?: string; retry?: boolean } = {}): Promise<EndedConnection[]> {
  const seen = new Set<string>()
  const out: EndedConnection[] = []
  let mine: Map<string, HandoverConnection>
  try { mine = new Map(ownConnections(ctx, owner).map((x) => [`${x.kind}:${x.id}`, x])) } catch (err) {
    ctx.log.warn('the connections to end at the handover could not be read', { err })
    return refs.map((r) => ({ kind: r.kind, id: r.id, label: '', result: 'failed' as const }))
  }
  let aiChanged = false
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.id}`
    if (seen.has(key)) continue
    seen.add(key)
    const conn = mine.get(key)
    let e: EndedConnection
    if (!conn || (o.since && signedInAfter(ctx, ref, o.since))) e = { kind: ref.kind, id: ref.id, label: conn?.label ?? (ref as { label?: string }).label ?? '', result: 'gone' }
    else if (ref.kind === 'team_ai') {
      try {
        const row = getCredential(ctx.db, ref.id)
        if (!row || row.owner_user_id || signInOf(ctx.db, 'team_ai', ref.id)?.userId !== owner) e = { kind: ref.kind, id: ref.id, label: conn.label, result: 'gone' }
        else { deleteCredential(credentialsOf(ctx), ref.id, actor ?? owner); aiChanged = true; e = { kind: ref.kind, id: ref.id, label: conn.label, result: 'ended' } }
      } catch (err) { ctx.log.warn('a team AI sign-in was not ended at the handover', { err }); e = { kind: ref.kind, id: ref.id, label: conn.label, result: 'failed' } }
    } else if (ref.kind === 'drive_share') {
      try {
        const { endShareSignIn } = await import('../integrations/google-drive/share-admin')
        const revoke = await withTimeout(endShareSignIn(ctx, owner, ref.id), 8_000)
        e = revoke === null ? { kind: ref.kind, id: ref.id, label: conn.label, result: 'gone' } : { kind: ref.kind, id: ref.id, label: conn.label, result: 'ended', revoke: revoke === 'timeout' ? 'unavailable' : revoke }
      } catch (err) { ctx.log.warn('a Drive share was not ended at the handover', { err }); e = { kind: ref.kind, id: ref.id, label: conn.label, result: 'failed' } }
    } else {
      try {
        const { integrationsOf } = await import('../integrations/connections/service')
        const revoke = await withTimeout(integrationsOf(ctx).endTeamSignIn(ref.id, owner, actor), 8_000)
        e = revoke === null ? { kind: ref.kind, id: ref.id, label: conn.label, result: 'gone' } : { kind: ref.kind, id: ref.id, label: conn.label, result: 'ended', revoke: revoke === 'timeout' ? 'unavailable' : revoke }
      } catch (err) { ctx.log.warn('a team connection was not ended at the handover', { err }); e = { kind: ref.kind, id: ref.id, label: conn.label, result: 'failed' } }
    }
    try { audit(ctx.db, { actor, action: 'owner.transfer.disconnect', target: ref.id, detail: { kind: e.kind, result: e.result, ...(e.revoke ? { revoke: e.revoke } : {}), ...(actor !== owner ? { of: owner } : {}), ...(o.retry ? { retry: true } : {}) } }) } catch (err) { ctx.log.warn('a handover disconnect was not audited', { err }) }
    out.push(e)
  }
  if (aiChanged) {
    try {
      const cache = engineStatusCache(ctx)
      cache.forget('claude-code'); cache.forget('codex')
      ctx.services.realtime.publishEach(() => ({ type: 'notice', data: { level: 'info', code: 'engine_choice_changed', message: '' } }))
    } catch { /* the engines' status refreshes on its own */ }
  }
  return out
}

// ---------------- what is still to end (a failure, or a stop right after the commit) ----------------
type TransferRow = { id: string; from_user: string; to_user: string; at: string; to_end: string; ended: string }
const parseList = <T>(json: string | null | undefined): T[] => { try { const v = JSON.parse(json ?? '[]'); return Array.isArray(v) ? v as T[] : [] } catch { return [] } }
/** What the transfer planned to end and is not ended (or gone) yet. */
export function pendingOf(t: Pick<TransferRow, 'to_end' | 'ended'>): Planned[] {
  const done = new Set(parseList<EndedConnection>(t.ended).filter((e) => e.result === 'ended' || e.result === 'gone').map((e) => `${e.kind}:${e.id}`))
  return parseList<Planned>(t.to_end).filter((p) => !done.has(`${p.kind}:${p.id}`))
}

/** The results go on the transfer's record (merged with earlier ones), and both people's Inboxes read again. */
export function recordEnded(ctx: AppContext, t: { id: string; from: string; to: string }, ended: EndedConnection[]): void {
  if (!ended.length) return
  try {
    const row = ctx.db.query('SELECT ended FROM owner_transfers WHERE id = ?').get(t.id) as { ended: string } | null
    const all = new Map(parseList<EndedConnection>(row?.ended).map((e) => [`${e.kind}:${e.id}`, e]))
    // an ended one stays ended: a later try that finds nothing (gone) or fails never hides that it was ended
    for (const e of ended) if (all.get(`${e.kind}:${e.id}`)?.result !== 'ended') all.set(`${e.kind}:${e.id}`, { kind: e.kind, id: e.id, label: e.label, result: e.result, ...(e.revoke ? { revoke: e.revoke } : {}) })
    ctx.db.query('UPDATE owner_transfers SET ended = ? WHERE id = ?').run(JSON.stringify([...all.values()]), t.id)
    for (const id of [t.from, t.to]) ctx.services.realtime.publish(id, { type: 'notice', data: { level: 'info', code: 'notifications.changed', message: '' } })
  } catch (err) { ctx.log.warn('the handover record was not completed', { err }) }
}

/** At the server's start: what transfers of the last 30 days planned to end and did not (the server stopped right after
 * a commit, or a service failed) is tried again, as the old owner asked. Never throws. */
export async function retryPendingEnds(ctx: AppContext): Promise<number> {
  let n = 0
  try {
    const rows = ctx.db.query("SELECT id, from_user, to_user, at, to_end, ended FROM owner_transfers WHERE to_end != '[]' AND at > ? ORDER BY at").all(new Date(Date.now() - 30 * 86_400_000).toISOString()) as TransferRow[]
    const owner = currentOwnerId(ctx.db)
    for (const t of rows) {
      // the old owner is the owner again (the role came back): their connections are theirs to keep
      if (t.from_user === owner) continue
      const left = pendingOf(t)
      if (!left.length) continue
      const ended = await endConnections(ctx, t.from_user, left, null, { since: t.at, retry: true })
      recordEnded(ctx, { id: t.id, from: t.from_user, to: t.to_user }, ended)
      n += ended.filter((e) => e.result === 'ended').length
    }
  } catch (err) { ctx.log.warn('the handover connections were not tried again', { err }) }
  return n
}

/** POST /api/admin/handover/end-pending: the owner ends what is still to end of a transfer (the Inbox's [끊기]). */
export async function endPending(c: Context<AppEnv>, ctx: AppContext, transferId: string): Promise<{ ended: EndedConnection[]; pending: number }> {
  const me = c.get('auth')!.user.id
  const t = ctx.db.query('SELECT id, from_user, to_user, at, to_end, ended FROM owner_transfers WHERE id = ?').get(transferId) as TransferRow | null
  // the current owner only, and never on their own connections (the old owner who is the owner again keeps theirs)
  if (!t || currentOwnerId(ctx.db) !== me || t.from_user === me) return fail('not_found')
  const ended = await endConnections(ctx, t.from_user, pendingOf(t), me, { since: t.at })
  recordEnded(ctx, { id: t.id, from: t.from_user, to: t.to_user }, ended)
  const after = ctx.db.query('SELECT to_end, ended FROM owner_transfers WHERE id = ?').get(t.id) as Pick<TransferRow, 'to_end' | 'ended'>
  return { ended, pending: pendingOf(after).length }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([p, new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), ms); timer.unref?.() })]).finally(() => clearTimeout(timer))
}

// ---------------- after the transfer ----------------
/** Right after the commit: every window of the two people refreshes its role now (the role is read on every request;
 * this is for the screens already open), and the notices go to the new owner, the old owner and every other admin.
 * Never throws: the transfer is done whatever happens here. */
export function tellTransfer(ctx: AppContext, t: { id: string; from: string; to: string }): void {
  const db = ctx.db
  const name = (id: string) => { const u = getUser(db, id); return u ? shownName(u.name, u.username) : '' }
  try {
    ctx.services.realtime.publish(t.from, { type: 'notice', data: { level: 'info', code: 'owner_changed', message: handoverText('toOld', localeOf(db, t.from), { name: name(t.to) }) } })
    ctx.services.realtime.publish(t.to, { type: 'notice', data: { level: 'info', code: 'owner_changed', message: handoverText('toNew', localeOf(db, t.to), { name: name(t.from) }) } })
  } catch (err) { ctx.log.warn('the role refresh was not sent', { err }) }
  try {
    const at = (db.query('SELECT at FROM owner_transfers WHERE id = ?').get(t.id) as { at: string } | null)?.at ?? new Date().toISOString()
    const n = notificationsOf(ctx)
    const admins = (db.query("SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL").all() as { id: string }[]).map((u) => u.id)
    for (const id of new Set([t.to, t.from, ...admins])) {
      try { n.handoverNotice(id, 'owner.transferred', t.id, at) } catch (err) { ctx.log.warn('a handover notice was not recorded', { err }) }
    }
    // the old owner's lead notices are settled: the card and its [넘기기] are gone with the flags
    try { n.settleLeadNotices(t.from) } catch { /* their rows say "not open" anyway */ }
  } catch (err) { ctx.log.warn('the handover notices were not recorded', { err }) }
}

// ---------------- the password check's lockout (auth/service.ts onReauthLocked) ----------------
const WINDOW_MS = 15 * 60_000
/** A wrong password that locked the owner's re-check (5 in 15 minutes, shared by every re-check: 팀장 넘기기, updates,
 * restore, the API engine, the current password): the owner gets one Inbox note per window, also pushed to their
 * devices, since a stolen session is what the check guards against (on the session alone it could be marked read). */
export function noteReauthLocked(ctx: AppContext, userId: string): void {
  try {
    if (currentOwnerId(ctx.db) !== userId) return
    const now = authOf(ctx).now()
    notificationsOf(ctx).handoverNotice(userId, 'owner.reauth_locked', `reauth-${Math.floor(now / WINDOW_MS)}`, new Date(now).toISOString())
  } catch (err) { ctx.log.warn('the lockout notice was not recorded', { err }) }
}

/** The recovery lock, inside the transfer's write (hosted with handoverSafe on). */
export function setRecoveryLockIn(ctx: AppContext, transferId: string, at: string): boolean {
  if (!isHosted(ctx.config) || !ctx.config.handoverSafe) return false
  setSetting(ctx.db, RECOVERY_LOCK_KEY, { since: at, transferId } satisfies RecoveryLock)
  return true
}
