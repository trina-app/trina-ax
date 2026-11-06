// Route module "demo" (docs/DECISIONS.md "Demo company: a new hire at 트리나"). Exists only on a development server
// started with MYCEL_DEMO (`bun run demo:company`); every endpoint answers 404 otherwise, like a route that is not there.
// app-config.ts refuses the flag in production, on the hosted service and in office mode; the mode is checked here again.
//
// Switching to another demo person is not an impersonation shortcut: the server checks the seeded account's password
// (the demo's public password) like a sign-in, writes the same audit row ("auth.login", detail demo: true), makes a
// normal session with its cookie and ends the caller's previous session. An account whose password was changed cannot
// be entered this way, and neither can the owner or an admin (the demo people are members; the owner has a password of
// its own, scripts/demo/company/start.ts). The sign-in page's failure counters are not used: the switch takes no password
// from the caller, so there is nothing to guess, and a stranger's wrong guesses there must not lock the demo.
import { API, type DemoFile, type DemoInfo, type DemoPersonaKey } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { isLoopback } from '../http/tunnel'
import { audit } from '../admin/audit'
import { viaOf } from '../auth/accounts'
import { msg } from '../auth/messages'
import { verifyPassword } from '../auth/passwords'
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
  const host = ctx.config.listen.host
  const network = !(host === 'localhost' || isLoopback(host)) || !!ctx.config.tls
  return { company: demo.company, sameQuestion: demo.sameQuestion ?? null, current, network, personas }
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
      const u = getUserByUsername(ctx.db, persona.username)
      const ok = !!u && u.status === 'active' && u.role === 'member' && !u.must_change_password && (await verifyPassword(demo.password, u.password_hash))
      if (!ok) return fail('unauthorized', msg('badLogin', c.get('locale')))
      const info = c.get('info')
      audit(ctx.db, { actor: u!.id, action: 'auth.login', target: u!.id, detail: { ip: info.ip, via: viaOf(info), client: 'web', demo: true } })
      const r = authOf(ctx).signIn(c, u!.id, 'web', 'cookie')
      if (auth && auth.session.id !== r.me.session.id) authOf(ctx).revokeSession(auth.session.id, 'logout')
      return { ok: true as const }
    })
  },
}
