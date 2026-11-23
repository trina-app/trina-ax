// Route module "demo" (docs/DECISIONS.md "Demo company: a new hire at 트리나"). Exists only on a development server
// started with MYCEL_DEMO (`bun run demo:company`); every endpoint answers 404 otherwise, like a route that is not there.
// app-config.ts refuses the flag in production, on the hosted service and in office mode; the mode is checked here again.
// A free-roam demo (DemoFile.kind "freeRoam", docs/decisions/20261119-demo-free-roam-a.md) has one person, whom
// demo-gate signs the visitor in as through the switch below; GET /api/demo also says the demo limit and its use.
//
// Switching to another demo person is not an impersonation shortcut: the server checks the seeded account's password
// (the demo's public password) like a sign-in, writes the same audit row ("auth.login", detail demo: true), makes a
// normal session with its cookie and ends the caller's previous session. An account whose password was changed cannot
// be entered this way, and neither can the owner or an admin (the demo people are members; the owner has a password of
// its own, scripts/demo/company/start.ts). The sign-in page's failure counters are not used: the switch takes no password
// from the caller, so there is nothing to guess, and a stranger's wrong guesses there must not lock the demo.
import crypto from 'node:crypto'
import { API, DEMO_GATE_KEY_HEADER, type DemoFile, type DemoInfo, type DemoPersonaKey } from '@mycel/shared/api'
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
import { demoLimitState } from '../admin/budgets'
import { getTeamSettings } from '../admin/settings'
import { demoLimitOf, startFreeRoam } from '../demo/free-roam'
import { registerDemoBuilder } from './demo-builder'

/** the demo file, only on a development server that was started with it */
export function demoOf(ctx: AppContext): DemoFile | null {
  const d = ctx.config.demo
  return d && ctx.config.mode === 'dev' && ctx.config.deployment !== 'hosted' && !ctx.config.office ? d : null
}

/** A free-roam instance signs in only its gate: its demo file holds the hash of a key per instance, and the caller must
 * show that key. Every instance listens on loopback, so without this any code running as the instance user could sign
 * in to another visitor's instance. Fails closed: a free-roam demo without a hash signs nobody in. Only the guided demo
 * and the snapshot builder's own server (demo file `builder: true`) have no key. */
export function gateKeyOk(demo: Pick<DemoFile, 'kind' | 'builder' | 'gateKeySha256'>, key: string | undefined): boolean {
  if (demo.kind !== 'freeRoam' || demo.builder === true) return true
  if (!demo.gateKeySha256 || !key) return false
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(key).digest(), Buffer.from(demo.gateKeySha256, 'hex'))
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
  // the team default language: the sign-in page's language on a free-roam instance, whose gate denies GET /api/setup
  // (QA TC-6790: a ja instance's sign-in page offered English only)
  const base = { company: demo.company, sameQuestion: demo.sameQuestion ?? null, current, network, personas, locale: getTeamSettings(ctx.db).defaultLocale,
    ...(demo.freeRoam ? { freeRoam: { suggestions: demo.freeRoam.suggestions } } : {}), ...(demo.builder ? { builder: true as const } : {}) }
  if (demo.kind !== 'freeRoam') return { ...base, kind: 'scripted' }
  // a free-roam demo: what the visitor's answers used of the demo limit (admin/budgets.ts demoLimitState), for the
  // meter and the limit screen
  const s = demoLimitState(ctx.db)
  return { ...base, kind: 'freeRoam', used: s?.used ?? 0, cap: s?.cap ?? demoLimitOf(demo), signupUrl: demo.signupUrl ?? null }
}

export const demoRoutes: RouteModule = {
  name: 'demo',
  owner: 'A',
  register(kit, ctx) {
    // a free-roam demo's start: its demo limit and its one AI connection (demo/free-roam.ts)
    startFreeRoam(ctx)
    kit.handle(API.demoInfo, ({ auth }) => {
      const demo = demoOf(ctx)
      if (!demo) return fail('not_found')
      return info(ctx, demo, auth?.user.username ?? null)
    })

    kit.handle(API.demoSwitch, async ({ c, body, auth }) => {
      const demo = demoOf(ctx)
      if (!demo) return fail('not_found')
      if (!gateKeyOk(demo, c.req.header(DEMO_GATE_KEY_HEADER))) return fail('unauthorized', msg('badLogin', c.get('locale')))
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

    // the free-roam snapshot builder's routes (demo file `builder: true`, the owner only; 404 otherwise)
    registerDemoBuilder(kit, ctx)
  },
}
