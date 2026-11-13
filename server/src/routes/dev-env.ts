// The dev environment's routes (docs/DECISIONS.md "Dev environment on srt, behind a flag", "Dev environment: box runner
// removed, srt only"): the team setting, a project's runs, stops, the sites a person allows, activity. Every endpoint
// answers 404 while the server runs without MYCEL_DEV_ENV=1, so the feature does not exist for clients of a normal
// install.
import { API, DEV_ENV_SRT_WARNING_VERSION, type DevEnvMySites, type DevEnvAvailability, type DevEnvProjectResponse, type DevEnvActivity, type DevEnvProjectSetting } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { RouteModule } from './module'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { canRead, canSeeProject } from '../chat/projects'
import type { Principal } from '../policy/access'
import { ticketIds } from '../devenv/srt/queue'
import { devEnvFlag, mayUseDevEnv, newConsent, saveTeamSetting, teamInForce, teamSetting } from '../devenv/setting'
import { DEV_ENV_DEFAULT_DOMAINS, DEV_ENV_FULL_WARNING_VERSION, DEV_ENV_MAX_EXTRA_DOMAINS, DEV_ENV_MAX_USER_SITES, cleanExtraDomains, extraDomainProblem } from '@mycel/shared'
import { fullInternet, removeUserSite, setFullInternet, userSites } from '../devenv/sites'
import { findRun, fullAvailable, networkNow, planState, previewPortProblem, previewRow, previewSupported, runsOf, srtProblem, stopAll, stopRun, stopWhere, teamHosts } from '../devenv/srt/runner'
import { pollSrt, startJobTracker } from '../devenv/jobs'
import { issuePreview, startPreviewGateway } from '../devenv/preview'
import { devEnvMsg, siteProblemMessage } from '../devenv/messages'

const isAdmin = (p: Principal) => p.role === 'owner' || p.role === 'admin'

async function availability(): Promise<DevEnvAvailability> {
  if (!devEnvFlag()) return { available: false, reason: 'flag' }
  const why = await srtProblem().catch((e) => String(e))
  return why ? { available: false, reason: 'platform', detail: why.slice(0, 500) } : { available: true }
}

export const devEnvRoutes: RouteModule = {
  name: 'dev-env',
  owner: 'B',
  init(ctx) {
    if (!devEnvFlag()) return
    const jobs = startJobTracker(ctx)
    ctx.onClose(() => jobs.stop())
    // the preview gateway: its own listener for the separate preview origin (devenv/preview.ts)
    const g = startPreviewGateway(ctx)
    if (g) ctx.onClose(() => g.stop())
  },
  register(kit, ctx: AppContext) {
    const project = (id: string, userId: string) => {
      if (!devEnvFlag()) fail('not_found')
      let p: Principal
      try { p = ctx.files.principal(userId) } catch { return fail('forbidden') }
      const r = ctx.db.query('SELECT id, name, folder_path, trashed_with FROM projects WHERE id = ?').get(id) as { id: string; name: string; folder_path: string; trashed_with: string | null } | null
      // the project page's dev environment: seen like the project (a team project whose folder is in the trash: admins)
      if (!r || !canSeeProject(ctx.files, p, r)) fail('not_found')
      return { p, r: r!, ref: { id: r!.id, folderPath: r!.folder_path } }
    }
    /** the team setting, in the shape of a project setting (read-only here) */
    const teamAsProject = (): DevEnvProjectSetting => { const t = teamSetting(ctx.db); return { enabled: t.enabled, scope: t.scope, network: t.network, limits: t.limits, consent: t.consent } }
    const response = async (id: string, folderPath: string, p: Principal): Promise<DevEnvProjectResponse> => {
      // a person in scope can run commands in this project's chats when they can open its folder
      const mayUse = mayUseDevEnv(ctx.db, ctx.files, p.id) && canRead(ctx.files, p, folderPath)
      return {
        availability: await availability(), setting: teamAsProject(), warningVersion: DEV_ENV_SRT_WARNING_VERSION,
        mayUse, mayManage: isAdmin(p),
        runs: mayUse || isAdmin(p) ? await runsOf(ctx, { projectId: id }) : { running: [], waiting: [] },
      }
    }

    kit.handle(API.devEnv, async ({ params, auth }) => {
      const { p, ref } = project(params.id, auth.user.id)
      return response(ref.id, ref.folderPath, p)
    })

    kit.handle(API.devEnvStop, async ({ params, auth }) => {
      const { p, ref } = project(params.id, auth.user.id)
      if (!mayUseDevEnv(ctx.db, ctx.files, p.id) && !isAdmin(p)) fail('forbidden')
      // every run of the project's chats stops. A command that waits in the queue (a ticket,
      // srt/queue.ts) is cancelled only by its owner, as with the stop of one run: its AI is told "the person cancelled
      // this command"
      const tickets = ticketIds(ctx.db)
      await stopWhere(ctx, (s) => s.projectId === ref.id && (s.userId === p.id || !tickets.has(s.id)), 'stopped')
      audit(ctx.db, { actor: p.id, action: 'dev_env.stop', target: ref.id, detail: { runner: 'srt' } })
      return response(ref.id, ref.folderPath, p)
    })

    kit.handle(API.devEnvRunStop, async ({ params, auth }) => {
      const { p, ref } = project(params.id, auth.user.id)
      const f = findRun(ctx, params.runId)
      const owner = !f ? null : 'row' in f ? { userId: f.row.user_id, projectId: f.row.project_id } : { userId: f.command.space.userId, projectId: f.command.space.projectId }
      if (!owner || owner.projectId !== ref.id) fail('not_found')
      const own = owner!.userId === p.id
      // a command that waits in the queue (a ticket, srt/queue.ts): only the person whose chat waits for it cancels it
      if (!own && f && 'row' in f && ticketIds(ctx.db).has(f.row.id)) fail('forbidden')
      if (!own && !(mayUseDevEnv(ctx.db, ctx.files, p.id) && canRead(ctx.files, p, ref.folderPath)) && !isAdmin(p)) fail('forbidden')
      if (!await stopRun(ctx, params.runId, 'stopped')) fail('not_found')
      audit(ctx.db, { actor: p.id, action: 'dev_env.stop', target: ref.id, detail: { run: params.runId, runner: 'srt' } })
      return response(ref.id, ref.folderPath, p)
    })

    // the runs of one person, from every chat (a chat with no project has no project page)
    const mine = (userId: string) => {
      if (!devEnvFlag()) fail('not_found')
      try { ctx.files.principal(userId) } catch { fail('forbidden') }
      return runsOf(ctx, { userId })
    }
    kit.handle(API.myDevEnvRuns, ({ auth }) => mine(auth.user.id))
    kit.handle(API.stopMyDevEnvRun, async ({ params, auth }) => {
      await mine(auth.user.id)
      const f = findRun(ctx, params.runId)
      const userId = !f ? null : 'row' in f ? f.row.user_id : f.command.space.userId
      if (userId !== auth.user.id) fail('not_found')
      if (!await stopRun(ctx, params.runId, 'stopped')) fail('not_found')
      audit(ctx.db, { actor: auth.user.id, action: 'dev_env.stop', target: null, detail: { run: params.runId, runner: 'srt' } })
      return mine(auth.user.id)
    })
    // a preview link to a port of the caller's own running dev server (devenv/preview.ts). Only the person who started
    // it: the run has that person's folder access, so nobody else may see what it serves
    kit.handle(API.previewMyDevEnvRun, async ({ c, params, body, auth }) => {
      await mine(auth.user.id)
      if (!mayUseDevEnv(ctx.db, ctx.files, auth.user.id)) fail('forbidden')
      const row = previewRow(ctx, { rowId: params.runId, userId: auth.user.id })
      if (!row) fail('not_found', 'The dev server is not running. Ask the AI to start it again.', { params: { reason: 'dev_env_preview_not_running' } })
      const why = previewPortProblem(body.port)
      if (why) fail('validation', `Port ${body.port}: ${why}.`, { params: { reason: 'dev_env_preview_port' } })
      if (!previewSupported()) fail('conflict', 'Preview is not available on this server. Ask the AI to test the dev server with curl in one command.', { params: { reason: 'dev_env_preview_not_configured' } })
      const runId = row!.unit.slice('trina-dev-'.length, -'.scope'.length)
      const r = issuePreview(ctx, { rowId: row!.id, runId, port: body.port, userId: auth.user.id, projectId: row!.project_id, appHost: c.req.header('host') ?? null })
      if ('error' in r) fail('conflict', r.error === 'same_site' ? 'The preview origin must be on another domain than the app.' : 'Preview is not set up on this server (no preview origin). Ask the AI to test the dev server with curl in one command.', { params: { reason: `dev_env_preview_${r.error}` } })
      return r as { url: string; expiresAt: string }
    })

    // the sites one person allowed and her Full internet switch (docs/DECISIONS.md "Dev environment: sites a
    // person allows"). Only her own: no admin sees or changes them here, and nobody else's runs get them.
    const mySites = (userId: string): DevEnvMySites => {
      if (!devEnvFlag()) fail('not_found')
      const base = { sites: [], fullInternet: false, fullAvailable: false, fullWarningVersion: DEV_ENV_FULL_WARNING_VERSION, teamSites: [], maxSites: DEV_ENV_MAX_USER_SITES }
      if (!mayUseDevEnv(ctx.db, ctx.files, userId)) return { state: 'off', ...base }
      if (networkNow(ctx) === 'offline') return { state: 'no_network', ...base }
      return {
        ...base, state: 'on', sites: userSites(ctx.db, userId), fullInternet: fullInternet(ctx.db, userId), fullAvailable: fullAvailable(),
        teamSites: [...DEV_ENV_DEFAULT_DOMAINS, ...teamSetting(ctx.db).extraDomains],
      }
    }
    /** the person's jobs and dev servers whose network got narrower stop now, not at the next tracker poll */
    const narrowNow = (userId: string) => pollSrt(ctx, { userId }).catch(() => {})
    kit.handle(API.myDevEnvSites, ({ auth }) => mySites(auth.user.id))
    kit.handle(API.removeMyDevEnvSite, async ({ body, auth }) => {
      mySites(auth.user.id)
      const host = body.host.trim().toLowerCase()
      if (!removeUserSite(ctx.db, auth.user.id, host)) fail('not_found')
      audit(ctx.db, { actor: auth.user.id, action: 'dev_env.site_removed', target: null, detail: { host } })
      await narrowNow(auth.user.id)
      return mySites(auth.user.id)
    })
    kit.handle(API.setMyDevEnvFullInternet, async ({ c, body, auth }) => {
      const locale = c.get('locale')
      const now = mySites(auth.user.id)
      if (body.on) {
        // the person turns it on for herself: no admin step, but the warning first; never with No network
        if (now.state !== 'on') fail('conflict', devEnvMsg('noNetwork', locale), { params: { reason: 'dev_env_no_network' } })
        if (!fullAvailable()) fail('conflict', devEnvMsg('fullUnavailable', locale), { params: { reason: 'dev_env_full_unavailable' } })
        if (body.acceptWarning !== DEV_ENV_FULL_WARNING_VERSION) fail('conflict', devEnvMsg('fullWarning', locale), { params: { reason: 'dev_env_full_warning', warningVersion: DEV_ENV_FULL_WARNING_VERSION } })
      }
      const before = fullInternet(ctx.db, auth.user.id)
      setFullInternet(ctx.db, auth.user.id, body.on)
      if (before !== body.on) audit(ctx.db, { actor: auth.user.id, action: body.on ? 'dev_env.full_on' : 'dev_env.full_off', target: null, detail: body.on ? { warningVersion: DEV_ENV_FULL_WARNING_VERSION } : null })
      if (!body.on) await narrowNow(auth.user.id)
      return mySites(auth.user.id)
    })

    const teamView = async () => {
      const plan = planState()
      return {
        setting: teamSetting(ctx.db), defaultDomains: [...DEV_ENV_DEFAULT_DOMAINS],
        plan: plan.ok && plan.plan ? { plan: plan.plan.plan, maxRunning: plan.plan.maxRunning, cpus: plan.plan.cpus, memoryMiB: plan.plan.memoryMiB, pids: plan.plan.pids, network: plan.plan.network || 'offline' } : null,
        warningVersion: DEV_ENV_SRT_WARNING_VERSION, availability: await availability(),
      }
    }
    kit.handle(API.devEnvTeam, () => {
      if (!devEnvFlag()) fail('not_found')
      return teamView()
    })
    kit.handle(API.updateDevEnvTeam, async ({ c, body, auth }) => {
      const locale = c.get('locale')
      if (!devEnvFlag()) fail('not_found')
      const before = teamSetting(ctx.db)
      const after = { ...before, limits: { ...before.limits, ...(body.limits ?? {}) } }
      if (body.extraDomains) {
        const list = cleanExtraDomains(body.extraDomains)
        if (list.length > DEV_ENV_MAX_EXTRA_DOMAINS) fail('validation', devEnvMsg('maxSites', locale, { n: DEV_ENV_MAX_EXTRA_DOMAINS }))
        const hosts = teamHosts(ctx)
        for (const d of list) {
          const why = extraDomainProblem(d, hosts)
          if (why) fail('validation', siteProblemMessage(d, why, locale), { fields: { 'body.extraDomains': `${d}: ${why}` } })
        }
        after.extraDomains = list
      }
      if (body.scope) {
        const groups = new Set((ctx.db.query('SELECT id FROM groups').all() as { id: string }[]).map((g) => g.id))
        if (body.scope.groupIds.some((g) => !groups.has(g))) fail('validation', devEnvMsg('unknownGroup', locale), { fields: { 'body.scope.groupIds': 'unknown group' } })
        const people = new Set((ctx.db.query('SELECT id FROM users WHERE deleted_at IS NULL').all() as { id: string }[]).map((u) => u.id))
        if (body.scope.userIds.some((u) => !people.has(u))) fail('validation', devEnvMsg('unknownPerson', locale), { fields: { 'body.scope.userIds': 'unknown person' } })
        after.scope = body.scope
      }
      if (body.network) after.network = body.network
      if (body.enabled !== undefined) after.enabled = body.enabled
      // turning on: the server must run srt, and the current warning must be accepted
      if (after.enabled && !teamInForce(before)) {
        const a = await availability()
        if (!a.available) fail('conflict', devEnvMsg('unavailable', locale), { params: { reason: 'dev_env_unavailable', why: a.reason ?? 'platform' } })
        if (after.consent?.warningVersion !== DEV_ENV_SRT_WARNING_VERSION) {
          if (body.acceptWarning !== DEV_ENV_SRT_WARNING_VERSION) fail('conflict', devEnvMsg('warning', locale), { params: { reason: 'dev_env_warning', warningVersion: DEV_ENV_SRT_WARNING_VERSION } })
          after.consent = newConsent({ id: auth.user.id, name: auth.user.name })
          audit(ctx.db, { actor: auth.user.id, action: 'dev_env.consent', target: null, detail: { warningVersion: DEV_ENV_SRT_WARNING_VERSION, team: true } })
        }
      }
      saveTeamSetting(ctx.db, after)
      const pick = (t: typeof after) => ({ enabled: t.enabled, scope: t.scope, network: t.network, limits: t.limits, extraDomains: t.extraDomains })
      audit(ctx.db, { actor: auth.user.id, action: 'dev_env.team', target: null, detail: { before: pick(before), after: pick(after) } })
      // off, or a change that every run must start again for (network, limits): stop them; a change of who may use
      // it is checked by the tracker per person
      const changed = before.network !== after.network || JSON.stringify(before.limits) !== JSON.stringify(after.limits)
      if (changed || (teamInForce(before) && !teamInForce(after))) await stopAll(ctx, 'setting')
      return teamView()
    })

    kit.handle(API.devEnvActivity, ({ params, auth }) => {
      const { ref } = project(params.id, auth.user.id)
      const audits = ctx.db.query(`SELECT a.actor_id, u.name, a.action, a.detail, a.at FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.action LIKE 'dev_env.%' AND a.target = ? ORDER BY a.id DESC LIMIT 200`).all(ref.id) as { actor_id: string | null; name: string | null; action: string; detail: string | null; at: string }[]
      const like = ref.folderPath.replace(/[\\%_]/g, (m) => '\\' + m) + '/%'
      const files = ctx.db.query(`SELECT e.user_id, u.name, e.path, e.action, e.detail, e.at FROM file_events e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.path LIKE ? ESCAPE '\\' AND e.detail LIKE '%"via":"dev_env"%' ORDER BY e.id DESC LIMIT 200`).all(like) as { user_id: string; name: string | null; path: string; action: string; detail: string | null; at: string }[]
      const parse = (d: string | null) => { try { return d ? JSON.parse(d) as Record<string, unknown> : null } catch { return null } }
      const items: DevEnvActivity[] = [
        ...audits.map((a) => {
          const d = parse(a.detail)
          const kind: DevEnvActivity['kind'] = a.action === 'dev_env.command' ? 'command' : 'event'
          const text = kind === 'command' ? String(d?.command ?? '')
            : a.action === 'dev_env.job' ? `job ${String(d?.name ?? '')}: ${d?.code === null || d?.code === undefined ? 'no exit code' : `exit ${String(d.code)}`}`
            : a.action.slice('dev_env.'.length)
          return { at: new Date(a.at).toISOString(), by: a.actor_id ? { id: a.actor_id, name: a.name ?? a.actor_id } : null, kind, text, detail: d }
        }),
        ...files.map((f) => ({ at: new Date(f.at.includes('T') ? f.at : f.at.replace(' ', 'T') + 'Z').toISOString(), by: { id: f.user_id, name: f.name ?? f.user_id }, kind: 'files' as const, text: `${f.action} ${f.path}`, detail: parse(f.detail) })),
      ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200)
      return { items }
    })
  },
}
