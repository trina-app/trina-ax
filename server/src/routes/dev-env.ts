// Dev environment EXPERIMENT (docs/DECISIONS.md "Dev environment (experiment)"): per-project setting, box state,
// stop / restart, preview links, activity. Every endpoint answers 404 while the server runs without MYCEL_DEV_ENV=1,
// so the feature does not exist for clients of a normal install.
import fs from 'node:fs'
import path from 'node:path'
import { API, DEV_ENV_SRT_WARNING_VERSION, type DevEnvMySites, type DevEnvAvailability, type DevEnvBox, type DevEnvProjectResponse, type DevEnvActivity, type DevEnvProjectSetting } from '@mycel/shared/api'
import type { BoxdBoxInfo } from '@mycel/shared'
import type { AppContext } from '../context'
import type { RouteModule } from './module'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { ensureFolderRow } from '../admin/folders'
import { assertFolderFree, canRead, canSeeProject, ensureProjectFolderEx, projectFolderName, projectPaths } from '../chat/projects'
import type { Locale } from '@mycel/shared/api'
import type { Principal } from '../policy/access'
import { boxd } from '../devenv/boxd'
import { devEnvFlag, devEnvInForce, devEnvRunner, devEnvSetting, mayUseBox, mayUseDevEnv, newConsent, requiredWarningVersion, saveDevEnvSetting, saveTeamSetting, teamInForce, teamSetting } from '../devenv/setting'
import { DEV_ENV_DEFAULT_DOMAINS, DEV_ENV_FULL_WARNING_VERSION, DEV_ENV_MAX_EXTRA_DOMAINS, DEV_ENV_MAX_USER_SITES, cleanExtraDomains, extraDomainProblem } from '@mycel/shared'
import { fullInternet, removeUserSite, setFullInternet, userSites } from '../devenv/sites'
import { findRun, fullAvailable, networkNow, planState, runsOf, srtProblem, stopAll, stopRun, stopWhere, teamHosts } from '../devenv/srt/runner'
import { issuePreview, startPreviewGateway } from '../devenv/preview'
import { pollSrt, runningJobs, startJobTracker } from '../devenv/jobs'

const isAdmin = (p: Principal) => p.role === 'owner' || p.role === 'admin'

async function availability(): Promise<DevEnvAvailability> {
  if (!devEnvFlag()) return { available: false, reason: 'flag' }
  if (devEnvRunner() === 'srt') {
    const why = await srtProblem().catch((e) => String(e))
    return why ? { available: false, reason: 'platform', detail: why.slice(0, 500) } : { available: true }
  }
  const c = boxd()
  if (!c) return { available: false, reason: 'boxd', detail: 'MYCEL_BOXD_SOCK is not set' }
  const st = await c.status()
  if (!st.ok) return { available: false, reason: 'boxd', detail: st.message.slice(0, 500) }
  return st.value.available ? { available: true } : { available: false, reason: 'platform', ...(st.value.reason ? { detail: st.value.reason.slice(0, 500) } : {}) }
}

/** Why this box does not run, when boxd stopped it. boxd keeps its last stop after the next start: a stop from before the
 * last start is not why the box is stopped now (a person stopped it). startedAt null: boxd has no later start. */
const stopOfThisStart = (b: BoxdBoxInfo) =>
  b.state !== 'running' && b.stopCode && b.stoppedAt && (!b.startedAt || Date.parse(b.stoppedAt) >= Date.parse(b.startedAt)) ? b.stopCode : null

async function boxState(projectId: string, withPs: boolean): Promise<DevEnvBox | null> {
  if (devEnvRunner() === 'srt') return null // no box: runs has what runs
  const c = boxd()
  if (!c) return null
  const st = await c.status()
  if (!st.ok) return null
  const b = st.value.boxes.find((x) => x.box === projectId)
  if (!b) return { state: 'none', startedAt: null, lastActiveAt: null, memoryMiB: null, processes: [] }
  const ps = withPs && b.state === 'running' ? await c.ps(projectId) : null
  return { state: b.state, startedAt: b.startedAt, lastActiveAt: b.lastActiveAt, memoryMiB: b.memoryMiB, processes: ps?.ok ? ps.value.processes : [], stopCode: stopOfThisStart(b) }
}

/**
 * A project on the team root (folder_path '') has no folder for a box: boxd refuses the whole team root. Turning on
 * gives the project projects/<name>, made like a new project folder and named like one (a name clash takes the next
 * name). The new folder has no rules of its own, so it inherits the access the project had on the team root. Files on
 * the team root stay there. Refuses when the folder cannot be made.
 */
function giveProjectFolder(ctx: AppContext, p: Principal, project: { id: string; name: string }, locale: Locale): string {
  const root = ctx.files.fx.root
  let top: string | null = null
  try {
    fs.mkdirSync(path.join(root, 'projects'), { recursive: true, mode: 0o700 })
    // never a name kept in folders or still named by another project (one project per folder)
    const taken = [...(ctx.db.query('SELECT path FROM folders').all() as { path: string }[]).map((f) => f.path), ...projectPaths(ctx.db)]
    const f = ensureProjectFolderEx(ctx.files, p, `projects/${projectFolderName(path.join(root, 'projects'), 'projects', taken, project.name, project.id)}`, locale)
    top = f.createdTop
    ctx.db.transaction(() => {
      assertFolderFree(ctx.db, ctx.files.fx.caseInsensitive, f.path, locale, { except: project.id, mayName: (x) => canRead(ctx.files, p, x) })
      ensureFolderRow(ctx.db, f.path)
      ctx.db.query('UPDATE projects SET folder_path = ? WHERE id = ?').run(f.path, project.id)
      audit(ctx.db, { actor: p.id, action: 'dev_env.folder', target: project.id, detail: { before: '', after: f.path } })
    })()
    return f.path
  } catch (e) {
    if (top) try { fs.rmSync(top, { recursive: true, force: true }) } catch {}
    ctx.log.warn('dev env project folder failed', { err: e })
    return fail('conflict', 'This project has no folder of its own and the server could not create one under projects/. Choose a folder for the project, then try again.', { params: { reason: 'dev_env_folder' } })
  }
}

export const devEnvRoutes: RouteModule = {
  name: 'dev-env',
  owner: 'B',
  init(ctx) {
    if (!devEnvFlag()) return
    const g = startPreviewGateway(ctx)
    if (g) ctx.onClose(() => g.stop())
    const jobs = startJobTracker(ctx)
    ctx.onClose(() => jobs.stop())
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
    /** srt: the team setting, in the shape of a project setting (the project page shows it read-only) */
    const teamAsProject = (): DevEnvProjectSetting => { const t = teamSetting(ctx.db); return { enabled: t.enabled, scope: t.scope, network: t.network, limits: t.limits, consent: t.consent } }
    const response = async (id: string, folderPath: string, p: Principal): Promise<DevEnvProjectResponse> => {
      if (devEnvRunner() === 'srt') {
        // a person in scope can run commands in this project's chats when they can open its folder
        const mayUse = mayUseDevEnv(ctx.db, ctx.files, p.id) && canRead(ctx.files, p, folderPath)
        return {
          availability: await availability(), setting: teamAsProject(), warningVersion: requiredWarningVersion(),
          mayUse, mayManage: isAdmin(p), needsFolder: false, box: null, jobs: [],
          runs: mayUse || isAdmin(p) ? await runsOf(ctx, { projectId: id }) : { running: [], waiting: [] }, runner: 'srt',
        }
      }
      const mayUse = mayUseBox(ctx.db, ctx.files, { id, folderPath }, p.id)
      return {
        availability: await availability(), setting: devEnvSetting(ctx.db, id), warningVersion: requiredWarningVersion(),
        mayUse, mayManage: isAdmin(p), needsFolder: folderPath === '', box: await boxState(id, mayUse || isAdmin(p)),
        jobs: mayUse || isAdmin(p) ? runningJobs(ctx.db, id) : [], runs: { running: [], waiting: [] }, runner: 'box',
      }
    }

    kit.handle(API.devEnv, async ({ params, auth }) => {
      const { p, ref } = project(params.id, auth.user.id)
      return response(ref.id, ref.folderPath, p)
    })

    kit.handle(API.updateDevEnv, async ({ c, params, body, auth }) => {
      const { p, r, ref } = project(params.id, auth.user.id)
      if (devEnvRunner() === 'srt') fail('conflict', 'On this server the dev environment is turned on for the whole team, in Admin settings, not per project.', { params: { reason: 'dev_env_team_setting' } })
      if (r.folder_path === 'users' || r.folder_path.startsWith('users/')) fail('validation', 'The dev environment is for team folders only, not personal projects.')
      const groups = new Set((ctx.db.query('SELECT id FROM groups').all() as { id: string }[]).map((g) => g.id))
      if (body.scope.groupIds.some((g) => !groups.has(g))) fail('validation', 'Unknown group.', { fields: { 'body.scope.groupIds': 'unknown group' } })
      const people = new Set((ctx.db.query('SELECT id FROM users WHERE deleted_at IS NULL').all() as { id: string }[]).map((u) => u.id))
      if (body.scope.userIds.some((u) => !people.has(u))) fail('validation', 'Unknown person.', { fields: { 'body.scope.userIds': 'unknown person' } })
      const before = devEnvSetting(ctx.db, ref.id)
      let consent = before.consent
      let folderPath = ref.folderPath
      if (body.enabled) {
        const a = await availability()
        if (!a.available) fail('conflict', 'This server cannot run dev environments.', { params: { reason: 'dev_env_unavailable', why: a.reason ?? 'boxd' } })
        const need = requiredWarningVersion()
        if (consent?.warningVersion !== need) {
          if (body.acceptWarning !== need) fail('conflict', 'Accept the dev environment warning first.', { params: { reason: 'dev_env_warning', warningVersion: need } })
        }
        // read again: an earlier save of this project may have ended while this one waited above
        folderPath = (ctx.db.query('SELECT folder_path FROM projects WHERE id = ?').get(ref.id) as { folder_path: string } | null)?.folder_path ?? fail('not_found')
        if (folderPath === '') folderPath = giveProjectFolder(ctx, p, r, c.get('locale'))
        if (consent?.warningVersion !== requiredWarningVersion()) {
          consent = newConsent({ id: auth.user.id, name: auth.user.name })
          audit(ctx.db, { actor: auth.user.id, action: 'dev_env.consent', target: ref.id, detail: { warningVersion: requiredWarningVersion() } })
        }
      }
      const after = { enabled: body.enabled, scope: body.scope, network: body.network ?? before.network, limits: { ...before.limits, ...(body.limits ?? {}) }, consent }
      saveDevEnvSetting(ctx.db, ref.id, after)
      audit(ctx.db, { actor: auth.user.id, action: 'dev_env.setting', target: ref.id, detail: { before: { enabled: before.enabled, scope: before.scope, network: before.network, limits: before.limits }, after: { enabled: after.enabled, scope: after.scope, network: after.network, limits: after.limits } } })
      // off, or a change the box must start again for (network, limits): stop it; the next command starts it again
      const changed = before.network !== after.network || JSON.stringify(before.limits) !== JSON.stringify(after.limits)
      if (!devEnvInForce(after) || changed) await boxd()?.stop(ref.id).catch(() => null)
      return response(ref.id, folderPath, p)
    })

    kit.handle(API.devEnvBox, async ({ params, body, auth }) => {
      const { p, ref } = project(params.id, auth.user.id)
      if (devEnvRunner() === 'srt') {
        if (!mayUseDevEnv(ctx.db, ctx.files, p.id) && !isAdmin(p)) fail('forbidden')
        // no box to start again: both stop every run of the project's chats
        await stopWhere(ctx, (s) => s.projectId === ref.id, 'stopped')
        audit(ctx.db, { actor: p.id, action: 'dev_env.stop', target: ref.id, detail: { runner: 'srt' } })
        return response(ref.id, ref.folderPath, p)
      }
      if (!mayUseBox(ctx.db, ctx.files, ref, p.id) && !isAdmin(p)) fail('forbidden')
      const c = boxd()
      if (!c) fail('conflict', 'The dev environment helper is not set up on this server.')
      const r = await c!.stop(ref.id)
      audit(ctx.db, { actor: p.id, action: body.action === 'stop' ? 'dev_env.stop' : 'dev_env.restart', target: ref.id, detail: r.ok ? null : { error: r.message.slice(0, 300) } })
      if (body.action === 'restart' && devEnvInForce(devEnvSetting(ctx.db, ref.id))) {
        const s = devEnvSetting(ctx.db, ref.id)
        const up = await c!.ensure({ box: ref.id, folder: ref.folderPath, network: s.network, limits: s.limits, denyAddrs: (process.env.MYCEL_DEV_ENV_DENY_ADDRS ?? '').split(',').map((x) => x.trim()).filter(Boolean) })
        // the box stopped and did not start: the person must see why (a nearly full disk, another box that runs)
        if (!up.ok) fail('conflict', up.message.slice(0, 500), { params: { reason: 'dev_env_start' } })
      }
      return response(ref.id, ref.folderPath, p)
    })

    kit.handle(API.devEnvPreview, async ({ c, params, body, auth }) => {
      const { p, ref } = project(params.id, auth.user.id)
      if (devEnvRunner() === 'srt') fail('conflict', 'Preview is not available yet on this server. Ask the AI to test the dev server with curl in one command.', { params: { reason: 'dev_env_preview_not_configured' } })
      if (!devEnvInForce(devEnvSetting(ctx.db, ref.id))) fail('conflict', 'The dev environment of this project is off.')
      const r = issuePreview(ctx, { projectId: ref.id, folderPath: ref.folderPath, port: body.port, userId: p.id, appHost: c.req.header('host') ?? null })
      if ('error' in r) fail('conflict', r.error === 'same_site' ? 'The preview origin must be on another domain than the app.' : 'The preview origin is not set up on this server.', { params: { reason: `dev_env_preview_${r.error}` } })
      return r as { url: string; expiresAt: string }
    })

    kit.handle(API.devEnvRunStop, async ({ params, auth }) => {
      const { p, ref } = project(params.id, auth.user.id)
      if (devEnvRunner() !== 'srt') fail('not_found')
      const f = findRun(ctx, params.runId)
      const owner = !f ? null : 'row' in f ? { userId: f.row.user_id, projectId: f.row.project_id } : { userId: f.command.space.userId, projectId: f.command.space.projectId }
      if (!owner || owner.projectId !== ref.id) fail('not_found')
      const own = owner!.userId === p.id
      if (!own && !(mayUseDevEnv(ctx.db, ctx.files, p.id) && canRead(ctx.files, p, ref.folderPath)) && !isAdmin(p)) fail('forbidden')
      if (!await stopRun(ctx, params.runId, 'stopped')) fail('not_found')
      audit(ctx.db, { actor: p.id, action: 'dev_env.stop', target: ref.id, detail: { run: params.runId, runner: 'srt' } })
      return response(ref.id, ref.folderPath, p)
    })

    // srt: the runs of one person, from every chat (a chat with no project has no project page)
    const mine = (userId: string) => {
      if (!devEnvFlag() || devEnvRunner() !== 'srt') fail('not_found')
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

    // srt: the sites one person allowed and her Full internet switch (docs/DECISIONS.md "Dev environment: sites a
    // person allows"). Only her own: no admin sees or changes them here, and nobody else's runs get them.
    const mySites = (userId: string): DevEnvMySites => {
      if (!devEnvFlag() || devEnvRunner() !== 'srt') fail('not_found')
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
    kit.handle(API.setMyDevEnvFullInternet, async ({ body, auth }) => {
      const now = mySites(auth.user.id)
      if (body.on) {
        // the person turns it on for herself: no admin step, but the warning first; never with No network
        if (now.state !== 'on') fail('conflict', 'The dev environment has no network for you now.', { params: { reason: 'dev_env_no_network' } })
        if (!fullAvailable()) fail('conflict', 'This server cannot run Full internet.', { params: { reason: 'dev_env_full_unavailable' } })
        if (body.acceptWarning !== DEV_ENV_FULL_WARNING_VERSION) fail('conflict', 'Accept the Full internet warning first.', { params: { reason: 'dev_env_full_warning', warningVersion: DEV_ENV_FULL_WARNING_VERSION } })
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
        runner: devEnvRunner(), warningVersion: DEV_ENV_SRT_WARNING_VERSION, availability: await availability(),
      }
    }
    kit.handle(API.devEnvTeam, () => {
      if (!devEnvFlag()) fail('not_found')
      return teamView()
    })
    kit.handle(API.updateDevEnvTeam, async ({ body, auth }) => {
      if (!devEnvFlag()) fail('not_found')
      const before = teamSetting(ctx.db)
      const after = { ...before, limits: { ...before.limits, ...(body.limits ?? {}) } }
      if (body.extraDomains) {
        const list = cleanExtraDomains(body.extraDomains)
        if (list.length > DEV_ENV_MAX_EXTRA_DOMAINS) fail('validation', `At most ${DEV_ENV_MAX_EXTRA_DOMAINS} sites.`)
        const hosts = teamHosts(ctx)
        for (const d of list) {
          const why = extraDomainProblem(d, hosts)
          if (why) fail('validation', `${d}: ${why}.`, { fields: { 'body.extraDomains': `${d}: ${why}` } })
        }
        after.extraDomains = list
      }
      if (body.scope) {
        const groups = new Set((ctx.db.query('SELECT id FROM groups').all() as { id: string }[]).map((g) => g.id))
        if (body.scope.groupIds.some((g) => !groups.has(g))) fail('validation', 'Unknown group.', { fields: { 'body.scope.groupIds': 'unknown group' } })
        const people = new Set((ctx.db.query('SELECT id FROM users WHERE deleted_at IS NULL').all() as { id: string }[]).map((u) => u.id))
        if (body.scope.userIds.some((u) => !people.has(u))) fail('validation', 'Unknown person.', { fields: { 'body.scope.userIds': 'unknown person' } })
        after.scope = body.scope
      }
      if (body.network) after.network = body.network
      if (body.enabled !== undefined) after.enabled = body.enabled
      // turning on (srt): the server must run srt, and the current warning must be accepted
      if (devEnvRunner() === 'srt' && after.enabled && !teamInForce(before)) {
        const a = await availability()
        if (!a.available) fail('conflict', 'This server cannot run the dev environment.', { params: { reason: 'dev_env_unavailable', why: a.reason ?? 'platform' } })
        if (after.consent?.warningVersion !== DEV_ENV_SRT_WARNING_VERSION) {
          if (body.acceptWarning !== DEV_ENV_SRT_WARNING_VERSION) fail('conflict', 'Accept the dev environment warning first.', { params: { reason: 'dev_env_warning', warningVersion: DEV_ENV_SRT_WARNING_VERSION } })
          after.consent = { by: { id: auth.user.id, name: auth.user.name }, at: new Date().toISOString(), warningVersion: DEV_ENV_SRT_WARNING_VERSION }
          audit(ctx.db, { actor: auth.user.id, action: 'dev_env.consent', target: null, detail: { warningVersion: DEV_ENV_SRT_WARNING_VERSION, team: true } })
        }
      }
      saveTeamSetting(ctx.db, after)
      const pick = (t: typeof after) => ({ enabled: t.enabled, scope: t.scope, network: t.network, limits: t.limits, extraDomains: t.extraDomains })
      audit(ctx.db, { actor: auth.user.id, action: 'dev_env.team', target: null, detail: { before: pick(before), after: pick(after) } })
      // off, or a change that every run must start again for (network, limits): stop them; a change of who may use
      // it is checked by the tracker per person
      const changed = before.network !== after.network || JSON.stringify(before.limits) !== JSON.stringify(after.limits)
      if (devEnvRunner() === 'srt' && (changed || (teamInForce(before) && !teamInForce(after)))) await stopAll(ctx, 'setting')
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
          const kind: DevEnvActivity['kind'] = a.action === 'dev_env.command' ? 'command' : a.action === 'dev_env.preview' ? 'preview' : 'box'
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
