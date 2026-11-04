// Route module "demo" (docs/DECISIONS.md "Demo company: a new hire at 트리나"). Exists only on a development server
// started with MYCEL_DEMO (`bun run demo:trina`); every endpoint answers 404 otherwise, like a route that is not there.
// app-config.ts refuses the flag in production, on the hosted service and in office mode; the mode is checked here again.
//
// Switching to another demo person is not an impersonation shortcut: the server signs in that seeded account through
// the normal sign-in (accounts.ts login: password check, rate limits, audit "auth.login") with the demo's public
// password, sets the session cookie, and ends the caller's previous session. An account whose password was changed
// cannot be entered this way.
import { API, type DemoFile, type DemoInfo, type DemoPersonaKey } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { login } from '../auth/accounts'
import { authOf } from '../auth/service'
import { getUserByUsername } from '../auth/users'
import type { RouteModule } from './module'

/** the demo file, only on a development server that was started with it */
export function demoOf(ctx: AppContext): DemoFile | null {
  const d = ctx.config.demo
  return d && ctx.config.mode === 'dev' && ctx.config.deployment !== 'hosted' && !ctx.config.office ? d : null
}

function info(ctx: AppContext, demo: DemoFile, username: string | null): DemoInfo {
  const firstGroup = (userId: string) =>
    (ctx.db.query('SELECT g.name FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY g.name LIMIT 1').get(userId) as { name: string } | null)?.name ?? null
  let current: DemoPersonaKey | null = null
  const personas = demo.personas.map((p) => {
    const u = getUserByUsername(ctx.db, p.username)
    if (u && username && u.username.toLowerCase() === username.toLowerCase()) current = p.key
    return { key: p.key, name: u?.name ?? null, team: u ? firstGroup(u.id) : null, intro: p.intro, questions: p.questions }
  })
  return { company: demo.company, sameQuestion: demo.sameQuestion ?? null, current, personas }
}

export const demoRoutes: RouteModule = {
  name: 'demo',
  owner: 'A',
  register(kit, ctx) {
    kit.handle(API.demoInfo, ({ auth }) => {
      const demo = demoOf(ctx)
      if (!demo) return fail('not_found')
      return info(ctx, demo, auth?.user.username ?? null)
    })

    kit.handle(API.demoSwitch, async ({ c, body, auth }) => {
      const demo = demoOf(ctx)
      if (!demo) return fail('not_found')
      const persona = demo.personas.find((p) => p.key === body.key)
      if (!persona) return fail('not_found')
      // the same sign-in as the sign-in page, as if the viewer typed the public demo password
      const r = await login(c, ctx, { username: persona.username, password: demo.password, client: 'web', tokenMode: 'cookie' })
      if (auth && auth.session.id !== r.me.session.id) authOf(ctx).revokeSession(auth.session.id, 'logout')
      return { ok: true as const }
    })
  },
}
