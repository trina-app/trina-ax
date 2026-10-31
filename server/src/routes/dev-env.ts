// Dev environment EXPERIMENT (docs/DECISIONS.md "Dev environment (experiment)"): per-project setting, box state,
// stop / restart, preview links, activity. Every endpoint answers 404 while the server runs without MYCEL_DEV_ENV=1,
// so the feature does not exist for clients of a normal install.
import { API, DEV_ENV_WARNING_VERSION, type DevEnvAvailability, type DevEnvBox, type DevEnvProjectResponse, type DevEnvActivity } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { RouteModule } from './module'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { canRead } from '../chat/projects'
import type { Principal } from '../policy/access'
import { boxd } from '../devenv/boxd'
import { devEnvFlag, devEnvInForce, devEnvSetting, mayUseBox, newConsent, saveDevEnvSetting } from '../devenv/setting'
import { issuePreview, startPreviewGateway } from '../devenv/preview'

const isAdmin = (p: Principal) => p.role === 'owner' || p.role === 'admin'

async function availability(): Promise<DevEnvAvailability> {
  if (!devEnvFlag()) return { available: false, reason: 'flag' }
  const c = boxd()
  if (!c) return { available: false, reason: 'boxd', detail: 'MYCEL_BOXD_SOCK is not set' }
  const st = await c.status()
  if (!st.ok) return { available: false, reason: 'boxd', detail: st.message.slice(0, 500) }
  return st.value.available ? { available: true } : { available: false, reason: 'platform', ...(st.value.reason ? { detail: st.value.reason.slice(0, 500) } : {}) }
}

async function boxState(projectId: string, withPs: boolean): Promise<DevEnvBox | null> {
  const c = boxd()
  if (!c) return null
  const st = await c.status()
  if (!st.ok) return null
  const b = st.value.boxes.find((x) => x.box === projectId)
  if (!b) return { state: 'none', startedAt: null, lastActiveAt: null, memoryMiB: null, processes: [] }
  const ps = withPs && b.state === 'running' ? await c.ps(projectId) : null
  return { state: b.state, startedAt: b.startedAt, lastActiveAt: b.lastActiveAt, memoryMiB: b.memoryMiB, processes: ps?.ok ? ps.value.processes : [] }
}

export const devEnvRoutes: RouteModule = {
  name: 'dev-env',
  owner: 'B',
  init(ctx) {
    if (!devEnvFlag()) return
    const g = startPreviewGateway(ctx)
    if (g) ctx.onClose(() => g.stop())
  },
  register(kit, ctx: AppContext) {
    const project = (id: string, userId: string) => {
      if (!devEnvFlag()) fail('not_found')
      let p: Principal
      try { p = ctx.files.principal(userId) } catch { return fail('forbidden') }
      const r = ctx.db.query('SELECT id, name, folder_path FROM projects WHERE id = ?').get(id) as { id: string; name: string; folder_path: string } | null
      if (!r || !canRead(ctx.files, p, r.folder_path)) fail('not_found')
      return { p, r: r!, ref: { id: r!.id, folderPath: r!.folder_path } }
    }
    const response = async (id: string, folderPath: string, p: Principal): Promise<DevEnvProjectResponse> => {
      const mayUse = mayUseBox(ctx.db, ctx.files, { id, folderPath }, p.id)
      return {
        availability: await availability(), setting: devEnvSetting(ctx.db, id), warningVersion: DEV_ENV_WARNING_VERSION,
        mayUse, mayManage: isAdmin(p), box: await boxState(id, mayUse || isAdmin(p)),
      }
    }

    kit.handle(API.devEnv, async ({ params, auth }) => {
      const { p, ref } = project(params.id, auth.user.id)
      return response(ref.id, ref.folderPath, p)
    })

    kit.handle(API.updateDevEnv, async ({ params, body, auth }) => {
      const { p, r, ref } = project(params.id, auth.user.id)
      if (r.folder_path === 'users' || r.folder_path.startsWith('users/')) fail('validation', 'The dev environment is for team folders only, not personal projects.')
      const groups = new Set((ctx.db.query('SELECT id FROM groups').all() as { id: string }[]).map((g) => g.id))
      if (body.scope.groupIds.some((g) => !groups.has(g))) fail('validation', 'Unknown group.', { fields: { 'body.scope.groupIds': 'unknown group' } })
      const people = new Set((ctx.db.query('SELECT id FROM users WHERE deleted_at IS NULL').all() as { id: string }[]).map((u) => u.id))
      if (body.scope.userIds.some((u) => !people.has(u))) fail('validation', 'Unknown person.', { fields: { 'body.scope.userIds': 'unknown person' } })
      const before = devEnvSetting(ctx.db, ref.id)
      let consent = before.consent
      if (body.enabled) {
        const a = await availability()
        if (!a.available) fail('conflict', 'This server cannot run dev environments.', { params: { reason: 'dev_env_unavailable', why: a.reason ?? 'boxd' } })
        if (consent?.warningVersion !== DEV_ENV_WARNING_VERSION) {
          if (body.acceptWarning !== DEV_ENV_WARNING_VERSION) fail('conflict', 'Accept the dev environment warning first.', { params: { reason: 'dev_env_warning', warningVersion: DEV_ENV_WARNING_VERSION } })
          consent = newConsent({ id: auth.user.id, name: auth.user.name })
          audit(ctx.db, { actor: auth.user.id, action: 'dev_env.consent', target: ref.id, detail: { warningVersion: DEV_ENV_WARNING_VERSION } })
        }
      }
      const after = { enabled: body.enabled, scope: body.scope, network: body.network ?? before.network, limits: { ...before.limits, ...(body.limits ?? {}) }, consent }
      saveDevEnvSetting(ctx.db, ref.id, after)
      audit(ctx.db, { actor: auth.user.id, action: 'dev_env.setting', target: ref.id, detail: { before: { enabled: before.enabled, scope: before.scope, network: before.network, limits: before.limits }, after: { enabled: after.enabled, scope: after.scope, network: after.network, limits: after.limits } } })
      // off, or a change the box must start again for (network, limits): stop it; the next command starts it again
      const changed = before.network !== after.network || JSON.stringify(before.limits) !== JSON.stringify(after.limits)
      if (!devEnvInForce(after) || changed) await boxd()?.stop(ref.id).catch(() => null)
      return response(ref.id, ref.folderPath, p)
    })

    kit.handle(API.devEnvBox, async ({ params, body, auth }) => {
      const { p, ref } = project(params.id, auth.user.id)
      if (!mayUseBox(ctx.db, ctx.files, ref, p.id) && !isAdmin(p)) fail('forbidden')
      const c = boxd()
      if (!c) fail('conflict', 'The dev environment helper is not set up on this server.')
      const r = await c!.stop(ref.id)
      audit(ctx.db, { actor: p.id, action: body.action === 'stop' ? 'dev_env.stop' : 'dev_env.restart', target: ref.id, detail: r.ok ? null : { error: r.message.slice(0, 300) } })
      if (body.action === 'restart' && devEnvInForce(devEnvSetting(ctx.db, ref.id))) {
        const s = devEnvSetting(ctx.db, ref.id)
        await c!.ensure({ box: ref.id, folder: ref.folderPath, network: s.network, limits: s.limits, denyAddrs: (process.env.MYCEL_DEV_ENV_DENY_ADDRS ?? '').split(',').map((x) => x.trim()).filter(Boolean) })
      }
      return response(ref.id, ref.folderPath, p)
    })

    kit.handle(API.devEnvPreview, async ({ c, params, body, auth }) => {
      const { p, ref } = project(params.id, auth.user.id)
      if (!devEnvInForce(devEnvSetting(ctx.db, ref.id))) fail('conflict', 'The dev environment of this project is off.')
      const r = issuePreview(ctx, { projectId: ref.id, folderPath: ref.folderPath, port: body.port, userId: p.id, appHost: c.req.header('host') ?? null })
      if ('error' in r) fail('conflict', r.error === 'same_site' ? 'The preview origin must be on another domain than the app.' : 'The preview origin is not set up on this server.', { params: { reason: `dev_env_preview_${r.error}` } })
      return r as { url: string; expiresAt: string }
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
          const text = kind === 'command' ? String(d?.command ?? '') : a.action.slice('dev_env.'.length)
          return { at: new Date(a.at).toISOString(), by: a.actor_id ? { id: a.actor_id, name: a.name ?? a.actor_id } : null, kind, text, detail: d }
        }),
        ...files.map((f) => ({ at: new Date(f.at.includes('T') ? f.at : f.at.replace(' ', 'T') + 'Z').toISOString(), by: { id: f.user_id, name: f.name ?? f.user_id }, kind: 'files' as const, text: `${f.action} ${f.path}`, detail: parse(f.detail) })),
      ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200)
      return { items }
    })
  },
}
