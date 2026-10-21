// Route module "auth" — owner: component A (docs/WORKPLAN.md).
// Implements: AUTH (setup, login, logout, password, me, sessions, invite info/accept, password reset links)
// Contract: shared/src/api/auth.ts
import { API } from '@mycel/shared/api'
import { LOCALE_CHANGED } from '../admin/settings'
import { fail } from '../http/errors'
import { acceptInvite, changePassword, completeReset, inviteInfo, login, resetInfo, setup, setupStatus } from '../auth/accounts'
import { authOf, installAuth } from '../auth/service'
import { startSweeper } from '../auth/sweeper'
import { getUser, setUserLocale } from '../auth/users'
import type { RouteModule } from './module'

export const authRoutes: RouteModule = {
  name: 'auth',
  owner: 'A',
  init(ctx) {
    installAuth(ctx)
    startSweeper(ctx)
  },
  register(kit, ctx) {
    const a = () => authOf(ctx)

    // the office internet address never offers the first-run setup (it is refused there anyway, accounts.ts setup): it
    // shows the sign-in page and does not tell the internet whether the team is set up yet (attack review finding 2)
    kit.handle(API.setupStatus, ({ c }) => {
      const s = setupStatus(ctx)
      return c.get('info').tunnel ? { ...s, needed: false } : s
    })
    kit.handle(API.setup, ({ c, body }) => setup(c, ctx, body))
    kit.handle(API.login, ({ c, body }) => login(c, ctx, body))

    kit.handle(API.logout, ({ c, auth }) => {
      a().revokeSession(auth.session.id, 'logout')
      if (auth.via === 'cookie') a().clearCookie(c)
    })

    kit.handle(API.changePassword, async ({ c, body }) => {
      await changePassword(c, ctx, body)
      return { ok: true as const }
    })

    kit.handle(API.me, ({ auth }) => a().me(auth.user.id, auth.session.id))

    kit.handle(API.updateMe, ({ auth, body }) => {
      const u = getUser(ctx.db, auth.user.id)
      if (!u) fail('unauthorized')
      const sets: string[] = []
      const args: (string | null)[] = []
      if (body.name !== undefined) { sets.push('name = ?'); args.push(body.name) }
      if (body.email !== undefined) { sets.push('email = ?'); args.push(body.email) }
      if (body.prefs !== undefined) {
        // merge: a PATCH carrying only { theme } keeps the other preferences
        let cur: Record<string, unknown> = {}
        try { cur = JSON.parse(u!.prefs || '{}') } catch {}
        const next: Record<string, unknown> = { ...cur, ...body.prefs }
        for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k]
        sets.push('prefs = ?'); args.push(JSON.stringify(next))
      }
      ctx.db.transaction(() => {
        if (sets.length) ctx.db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, auth.user.id)
        // null = follow the team default again
        if (body.locale !== undefined) setUserLocale(ctx.db, auth.user.id, body.locale)
      })()
      // the person's other windows and devices switch too
      if (body.locale !== undefined) ctx.services.realtime.publish(auth.user.id, LOCALE_CHANGED)
      return a().me(auth.user.id, auth.session.id)
    })

    kit.handle(API.mySessions, ({ auth }) => ({
      items: a().listSessions(auth.user.id).map((s) => ({
        id: s.id, client: s.client, userAgent: s.user_agent, createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: s.expires_at,
        current: s.id === auth.session.id,
      })),
    }))

    kit.handle(API.revokeMySession, ({ c, params, auth }) => {
      const row = ctx.db.query('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(params.id, auth.user.id)
      if (!row) fail('not_found')
      a().revokeSession(params.id, 'revoked')
      if (params.id === auth.session.id && auth.via === 'cookie') a().clearCookie(c)
    })

    kit.handle(API.inviteInfo, ({ c, params }) => inviteInfo(c, ctx, params.token))
    kit.handle(API.acceptInvite, ({ c, params, body }) => acceptInvite(c, ctx, params.token, body))
    kit.handle(API.passwordResetInfo, ({ c, params }) => resetInfo(c, ctx, params.token))
    kit.handle(API.completePasswordReset, ({ c, params, body }) => completeReset(c, ctx, params.token, body))
  },
}
