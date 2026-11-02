// PC runner (docs/DECISIONS.md "PC runner"): the per-project setting and what the AI did on people's computers. Every
// endpoint answers 404 while the server runs without MYCEL_PC_RUNNER=1, so the feature does not exist for clients of a
// normal install.
import { API, PC_RUNNER_WARNING_VERSION, type PcRunnerActivity, type PcRunnerProjectResponse } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { RouteModule } from './module'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { canRead } from '../chat/projects'
import type { Principal } from '../policy/access'
import { mayUsePc, newPcConsent, pcRunnerFlag, pcSetting, savePcSetting } from '../pc/setting'

const isAdmin = (p: Principal) => p.role === 'owner' || p.role === 'admin'
const ACTIVITY_MAX = 50

export const pcRunnerRoutes: RouteModule = {
  name: 'pc-runner',
  owner: 'B',
  register(kit, ctx: AppContext) {
    const project = (id: string, userId: string) => {
      if (!pcRunnerFlag()) fail('not_found')
      let p: Principal
      try { p = ctx.files.principal(userId) } catch { return fail('forbidden') }
      const r = ctx.db.query('SELECT id, name, folder_path FROM projects WHERE id = ?').get(id) as { id: string; name: string; folder_path: string } | null
      if (!r || !canRead(ctx.files, p, r.folder_path)) fail('not_found')
      return { p, r: r!, ref: { id: r!.id, folderPath: r!.folder_path } }
    }
    const response = (ref: { id: string; folderPath: string }, p: Principal): PcRunnerProjectResponse => ({
      setting: pcSetting(ctx.db, ref.id), warningVersion: PC_RUNNER_WARNING_VERSION,
      mayUse: mayUsePc(ctx.db, ctx.files, ref, p.id), mayManage: isAdmin(p),
    })

    kit.handle(API.pcRunner, ({ params, auth }) => {
      const { p, ref } = project(params.id, auth.user.id)
      return response(ref, p)
    })

    kit.handle(API.updatePcRunner, ({ params, body, auth }) => {
      const { p, r, ref } = project(params.id, auth.user.id)
      if (r.folder_path === 'users' || r.folder_path.startsWith('users/')) fail('validation', 'The PC runner is for team folders only, not personal projects.')
      const groups = new Set((ctx.db.query('SELECT id FROM groups').all() as { id: string }[]).map((g) => g.id))
      if (body.scope.groupIds.some((g) => !groups.has(g))) fail('validation', 'Unknown group.', { fields: { 'body.scope.groupIds': 'unknown group' } })
      const people = new Set((ctx.db.query('SELECT id FROM users WHERE deleted_at IS NULL').all() as { id: string }[]).map((u) => u.id))
      if (body.scope.userIds.some((u) => !people.has(u))) fail('validation', 'Unknown person.', { fields: { 'body.scope.userIds': 'unknown person' } })
      const before = pcSetting(ctx.db, ref.id)
      let consent = before.consent
      if (body.enabled && consent?.warningVersion !== PC_RUNNER_WARNING_VERSION) {
        if (body.acceptWarning !== PC_RUNNER_WARNING_VERSION) fail('conflict', 'Accept the PC runner warning first.', { params: { reason: 'pc_runner_warning', warningVersion: PC_RUNNER_WARNING_VERSION } })
        consent = newPcConsent({ id: auth.user.id, name: auth.user.name })
        audit(ctx.db, { actor: auth.user.id, action: 'pc_runner.consent', target: ref.id, detail: { warningVersion: PC_RUNNER_WARNING_VERSION } })
      }
      savePcSetting(ctx.db, ref.id, { enabled: body.enabled, scope: body.scope, consent })
      audit(ctx.db, { actor: auth.user.id, action: 'pc_runner.setting', target: ref.id, detail: { before: { enabled: before.enabled, scope: before.scope }, after: { enabled: body.enabled, scope: body.scope } } })
      return response(ref, p)
    })

    kit.handle(API.pcRunnerActivity, ({ params, auth }) => {
      const { ref } = project(params.id, auth.user.id)
      const rows = ctx.db.query(`SELECT a.actor_id, u.name, a.detail, a.at FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.action = 'pc_runner.call' AND a.target = ? ORDER BY a.id DESC LIMIT ?`).all(ref.id, ACTIVITY_MAX) as { actor_id: string | null; name: string | null; detail: string | null; at: string }[]
      const items: PcRunnerActivity[] = rows.map((r) => {
        let d: { tool?: unknown; text?: unknown; ok?: unknown; approval?: unknown } = {}
        try { d = JSON.parse(r.detail ?? '{}') } catch {}
        return { at: new Date(r.at).toISOString(), by: r.actor_id ? { id: r.actor_id, name: r.name ?? r.actor_id } : null, tool: String(d.tool ?? ''), text: String(d.text ?? ''), ok: d.ok === true, approval: typeof d.approval === 'string' ? d.approval : null }
      })
      return { items }
    })
  },
}
