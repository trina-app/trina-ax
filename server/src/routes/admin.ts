// Route module "admin" — owner: component A (docs/WORKPLAN.md).
// Implements: ADMIN (users, invites, groups, folders + rules + preview, engines, budgets, settings, usage, audit)
// Contract: shared/src/api/admin.ts
// Nothing here returns chat or memory contents: admins manage people, folders and engines, not conversations.
import { API, EngineId, type EngineId as EngineIdT } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId } from '../db'
import { fail } from '../http/errors'
import { createInvite, createResetLink, linkBase, listInvites, revokeInvite } from '../auth/accounts'
import { msg } from '../auth/messages'
import { audit, listAudit } from '../admin/audit'
import { createBudget, deleteBudget, listBudgets, updateBudget, usage } from '../admin/budgets'
import { EngineStatusCache, addAccount, deleteAccount, engineStatusCache, listAccounts } from '../admin/engines'
import {
  afterAccessChange, captureState, dropFolderRow, ensureFolderRow, getFolder, getFolderByPath, listFolders, previewRules, replaceRules,
  resolveFolderPath, rulesOf, toFolder, validateRules,
} from '../admin/folders'
import { createGroup, deleteGroup, listGroups, updateGroup } from '../admin/groups'
import { enginesEnabled, getTeamSettings, LOCALE_CHANGED, setEnginesEnabled, updateTeamSettings } from '../admin/settings'
import { createUser, deleteUser, guardResetLink, listUsers, resetPassword, transferOwnership, updateUser } from '../admin/users'
import type { Locale } from '@mycel/shared/api'
import type { RouteModule } from './module'
import { codexIsBeta } from '../chat/engines'
import { ENGINE_CHOICE_CHANGED, codexOffHere, engineOn, limitFallbackAvailable, limitFallbackOn, memberChoice, setLimitFallback, setMemberChoice } from '../admin/engine-choice'
import { connectedFolders, ConnectedError, type ConnectedRow } from '../team-files/connected'
import { listSkillManagers, setSkillManager } from '../skills/managers'
import { listSkillChanges } from '../skills/changes'
import { readApiEngine, writeApiEngine } from '../engine/api-agent'
import { getChatRuntime } from '../chat/runtime'

async function enginesResponse(ctx: AppContext, cache: EngineStatusCache, locale: Locale) {
  const enabled = enginesEnabled(ctx.db)
  const s = getTeamSettings(ctx.db)
  const engines = await Promise.all(EngineId.options.map((id) => cache.get(id, enabled[id], locale)))
  return {
    engines, defaultEngine: s.defaultEngine, defaultModel: s.defaultModel, concurrency: s.concurrency, accounts: listAccounts(ctx),
    memberChoice: memberChoice(ctx), limitFallback: limitFallbackOn(ctx), limitFallbackAvailable: limitFallbackAvailable(ctx),
  }
}


export const adminRoutes: RouteModule = {
  name: 'admin',
  owner: 'A',
  register(kit, ctx) {
    const engineCache = engineStatusCache(ctx)

    // ---------------- users ----------------
    kit.handle(API.listUsers, () => ({ items: listUsers(ctx) }))
    kit.handle(API.createUser, ({ c, body }) => createUser(c, ctx, body))
    kit.handle(API.updateUser, ({ c, params, body }) => updateUser(c, ctx, params.id, body))
    kit.handle(API.deleteUser, ({ c, params, query }) => deleteUser(c, ctx, params.id, query.personalFolder))
    kit.handle(API.resetPassword, ({ c, params, body }) => resetPassword(c, ctx, params.id, body))
    kit.handle(API.createResetLink, ({ c, params, auth }) => {
      guardResetLink(c, ctx, params.id)
      return createResetLink(ctx, params.id, auth.user.id, linkBase(c, ctx))
    })
    kit.handle(API.transferOwnership, ({ c, body }) => { transferOwnership(c, ctx, body.userId); return { ok: true as const } })

    // ---------------- invites ----------------
    kit.handle(API.listInvites, () => ({ items: listInvites(ctx) }))
    kit.handle(API.createInvite, ({ c, body }) => createInvite(c, ctx, body))
    kit.handle(API.revokeInvite, ({ c, params }) => revokeInvite(c, ctx, params.id))

    // ---------------- groups ----------------
    kit.handle(API.listGroups, () => ({ items: listGroups(ctx) }))
    kit.handle(API.createGroup, ({ c, body }) => createGroup(c, ctx, body))
    kit.handle(API.updateGroup, ({ c, params, body }) => updateGroup(c, ctx, params.id, body))
    kit.handle(API.deleteGroup, ({ c, params }) => deleteGroup(c, ctx, params.id))

    // ---------------- folders and rules ----------------
    kit.handle(API.listFolders, () => ({ items: listFolders(ctx) }))

    kit.handle(API.createFolder, ({ c, body, auth }) => {
      const locale = c.get('locale')
      validateRules(ctx.db, body.rules, locale)
      const { path: p, created } = resolveFolderPath(ctx, body.path, { create: body.create, locale })
      const existing = getFolderByPath(ctx.db, p)
      if (existing && rulesOf(ctx.db, existing.id).length) fail('conflict', msg('folderExists', locale))
      const before = captureState(ctx.db)
      const f = ctx.db.transaction(() => {
        const row = ensureFolderRow(ctx.db, p)
        replaceRules(ctx.db, row.id, body.rules, auth.user.id)
        audit(ctx.db, { actor: auth.user.id, action: 'folder.create', target: p, detail: { created, rules: body.rules } })
        return row
      })()
      afterAccessChange(ctx, before, { actor: auth.user.id, target: p, created: created ? [p] : [] })
      return toFolder(ctx, f)
    })

    // ---------------- connected folders (team-files/connected.ts) ----------------
    const connectedOut = (r: ConnectedRow, syncing = false) => ({ id: r.id, name: r.name, path: `connected/${r.name}`, source: r.source, lastSyncAt: r.last_sync_at,
      lastStatus: r.last_status, lastError: r.last_error ? msg(`connected_${r.last_error}` as never, 'en') : null, files: r.files, bytes: r.bytes, syncing })
    const connectedFail = (e: unknown, locale: Locale): never => {
      if (e instanceof ConnectedError) {
        const key = `connected_${e.message}`
        return fail(e.message === 'name_taken' ? 'conflict' : 'validation', msg(key as never, locale) ?? e.message)
      }
      throw e
    }
    kit.handle(API.listConnected, ({ c }) => {
      const cf = connectedFolders(ctx)
      return { items: cf.list().map((r) => ({ ...connectedOut(r, cf.isSyncing(r.id)), lastError: r.last_error ? msg(`connected_${r.last_error}` as never, c.get('locale')) : null })) }
    })
    kit.handle(API.addConnected, ({ c, body, auth }) => {
      const cf = connectedFolders(ctx)
      let row: ConnectedRow
      try { row = cf.add({ name: body.name, source: body.source, actor: auth.user.id }) } catch (e) { return connectedFail(e, c.get('locale')) }
      void cf.sync(row.id).catch(() => {})
      return connectedOut(row, true)
    })
    kit.handle(API.syncConnected, ({ params }) => {
      const cf = connectedFolders(ctx)
      const row = cf.get(params.id)
      if (!row) return fail('not_found')
      void cf.sync(row.id).catch(() => {})
      return connectedOut(row, true)
    })
    kit.handle(API.removeConnected, ({ params, auth }) => {
      if (!connectedFolders(ctx).remove(params.id, auth.user.id)) fail('not_found')
    })

    kit.handle(API.putFolderRules, ({ c, params, body, auth }) => {
      const f = getFolder(ctx.db, params.id)
      if (!f) fail('not_found')
      // a folder moved into users/ keeps its row; rules there are ignored, so refuse to edit them as if they worked
      if (f!.path === 'users' || f!.path.startsWith('users/')) fail('validation', msg('rulesInUsers', c.get('locale')), { fields: { 'params.id': 'users/ cannot carry rules' } })
      validateRules(ctx.db, body.rules, c.get('locale'))
      const before = captureState(ctx.db)
      const old = rulesOf(ctx.db, f!.id)
      ctx.db.transaction(() => {
        replaceRules(ctx.db, f!.id, body.rules, auth.user.id)
        audit(ctx.db, { actor: auth.user.id, action: 'folder.rules', target: f!.path, detail: { before: old, after: body.rules } })
      })()
      afterAccessChange(ctx, before, { actor: auth.user.id, target: f!.path })
      return toFolder(ctx, f!)
    })

    kit.handle(API.deleteFolder, ({ params, auth }) => {
      const f = getFolder(ctx.db, params.id)
      if (!f) fail('not_found')
      const before = captureState(ctx.db)
      const old = rulesOf(ctx.db, f!.id)
      ctx.db.transaction(() => {
        dropFolderRow(ctx.db, f!.id)
        audit(ctx.db, { actor: auth.user.id, action: 'folder.delete', target: f!.path, detail: { before: old } })
      })()
      afterAccessChange(ctx, before, { actor: auth.user.id, target: f!.path })
    })

    kit.handle(API.previewRules, ({ c, body }) => previewRules(ctx, body.changes, c.get('locale')))

    // ---------------- team skills: who manages them, what changed (skills/managers.ts, skills/changes.ts) ----------------
    kit.handle(API.listSkillManagers, () => listSkillManagers(ctx))
    kit.handle(API.setSkillManager, ({ c, body, auth }) => setSkillManager(ctx, auth.user.id, body, c.get('locale')))
    kit.handle(API.listSkillChanges, ({ query, auth }) => listSkillChanges(ctx.db, auth.user.id, query))

    // ---------------- engines ----------------
    kit.handle(API.engines, ({ c }) => enginesResponse(ctx, engineCache, c.get('locale')))

    // ---------------- the team's API engine (engine/api-agent.ts) ----------------
    const apiConfigOut = () => {
      const conf = readApiEngine(ctx.config.dataDir)
      return { baseUrl: conf?.baseUrl ?? null, model: conf?.model ?? null, label: conf?.label ?? null, hasKey: !!conf?.key }
    }
    kit.handle(API.getApiEngine, () => apiConfigOut())
    kit.handle(API.putApiEngine, ({ body, auth }) => {
      writeApiEngine(ctx.config.dataDir, { baseUrl: body.baseUrl, model: body.model, label: body.label, ...(body.key !== undefined ? { key: body.key } : {}) })
      audit(ctx.db, { actor: auth.user.id, action: 'engines.api', target: 'api', detail: { baseUrl: body.baseUrl, model: body.model, key: body.key === undefined ? 'kept' : body.key ? 'set' : 'removed' } })
      engineCache.forget('api')
      try { (getChatRuntime(ctx).engines as { reset?: () => void }).reset?.() } catch {}
      return apiConfigOut()
    })

    kit.handle(API.updateEngines, async ({ c, body, auth }) => {
      const locale = c.get('locale')
      const s = getTeamSettings(ctx.db)
      const enabled = { ...enginesEnabled(ctx.db), ...body.enabled }
      const def = body.defaultEngine ?? s.defaultEngine
      if (!enabled[def] || (def === 'codex' && codexOffHere(ctx))) fail('conflict', msg('engineDisabled', locale))
      if (body.defaultEngine === 'codex' && codexIsBeta(ctx)) fail('conflict', msg('codexBetaDefault', locale))
      if (body.memberChoice) {
        const groups = new Set(listGroups(ctx).map((g) => g.id))
        if (body.memberChoice.groupIds.some((g) => !groups.has(g))) fail('validation', msg('unknownGroups', locale), { fields: { 'body.memberChoice.groupIds': 'unknown group' } })
        const people = new Set((ctx.db.query('SELECT id FROM users WHERE deleted_at IS NULL').all() as { id: string }[]).map((u) => u.id))
        if (body.memberChoice.userIds.some((u) => !people.has(u))) fail('validation', msg('unknownUsers', locale), { fields: { 'body.memberChoice.userIds': 'unknown person' } })
      }
      // the fallback sends conversations to OpenAI: never while Codex is off (switched off here or by office mode)
      const codexOn = enabled.codex && !codexOffHere(ctx)
      if (body.limitFallback === true && !codexOn) fail('conflict', msg('limitFallbackNeedsCodex', locale))
      const before = { enabled: enginesEnabled(ctx.db), memberChoice: memberChoice(ctx), defaultEngine: s.defaultEngine, defaultModel: s.defaultModel }
      ctx.db.transaction(() => {
        if (body.enabled) setEnginesEnabled(ctx.db, body.enabled)
        if (body.memberChoice) setMemberChoice(ctx, body.memberChoice)
        if (body.limitFallback !== undefined) setLimitFallback(ctx, body.limitFallback)
        // switching Codex off also turns the fallback off: switching Codex back on must not quietly resume it
        if (!codexOn) setLimitFallback(ctx, false)
      })()
      updateTeamSettings(ctx.db, {
        ...(body.defaultEngine !== undefined ? { defaultEngine: body.defaultEngine } : {}),
        ...(body.defaultModel !== undefined ? { defaultModel: body.defaultModel } : body.defaultEngine !== undefined && body.defaultEngine !== s.defaultEngine ? { defaultModel: null } : {}),
        ...(body.concurrency !== undefined ? { concurrency: body.concurrency } : {}),
      })
      audit(ctx.db, { actor: auth.user.id, action: 'engines.update', target: null, detail: body as Record<string, unknown> })
      const after = getTeamSettings(ctx.db)
      if (JSON.stringify(before) !== JSON.stringify({ enabled: enginesEnabled(ctx.db), memberChoice: memberChoice(ctx), defaultEngine: after.defaultEngine, defaultModel: after.defaultModel }))
        ctx.services.realtime.publishEach(() => ENGINE_CHOICE_CHANGED)
      return enginesResponse(ctx, engineCache, locale)
    })

    kit.handle(API.checkEngine, async ({ c, params }) => {
      const id = EngineId.safeParse(params.id)
      if (!id.success) fail('not_found')
      const before = engineCache.peek(id.data as EngineIdT)
      const s = await engineCache.get(id.data as EngineIdT, enginesEnabled(ctx.db)[id.data as EngineIdT], c.get('locale'), true)
      // signed in or out since the last check: open composers ask GET /api/engines again (it leaves signed-out engines out)
      if (before !== s.status) ctx.services.realtime.publishEach(() => ENGINE_CHOICE_CHANGED)
      return s
    })

    kit.handle(API.addEngineAccount, ({ body, auth }) => {
      const id = newId()
      const a = addAccount(ctx, id, body.engine, body.label ?? null, body.secret)
      audit(ctx.db, { actor: auth.user.id, action: 'engines.account_add', target: id, detail: { engine: body.engine, hint: a.hint } })
      return a
    })
    kit.handle(API.deleteEngineAccount, ({ params, auth }) => {
      if (!deleteAccount(ctx, params.id)) fail('not_found')
      audit(ctx.db, { actor: auth.user.id, action: 'engines.account_delete', target: params.id })
    })

    // ---------------- budgets, settings, usage, audit ----------------
    kit.handle(API.listBudgets, () => ({ items: listBudgets(ctx.db) }))
    kit.handle(API.createBudget, ({ c, body, auth }) => {
      const b = createBudget(ctx.db, body, c.get('locale'))
      audit(ctx.db, { actor: auth.user.id, action: 'budget.create', target: b.id, detail: body as Record<string, unknown> })
      return b
    })
    kit.handle(API.updateBudget, ({ c, params, body, auth }) => {
      const b = updateBudget(ctx.db, params.id, body, c.get('locale'))
      audit(ctx.db, { actor: auth.user.id, action: 'budget.update', target: b.id, detail: body as Record<string, unknown> })
      return b
    })
    kit.handle(API.deleteBudget, ({ params, auth }) => {
      deleteBudget(ctx.db, params.id)
      audit(ctx.db, { actor: auth.user.id, action: 'budget.delete', target: params.id })
    })

    kit.handle(API.settings, () => getTeamSettings(ctx.db))
    kit.handle(API.updateSettings, ({ c, body, auth }) => {
      const cur = getTeamSettings(ctx.db)
      if (body.teamName !== undefined && body.teamName !== cur.teamName && auth.user.role !== 'owner') fail('forbidden', msg('ownerTeamName', c.get('locale')))
      if (body.defaultEngine !== undefined && !engineOn(ctx, body.defaultEngine)) fail('conflict', msg('engineDisabled', c.get('locale')))
      if (body.defaultEngine === 'codex' && codexIsBeta(ctx)) fail('conflict', msg('codexBetaDefault', c.get('locale')))
      const next = updateTeamSettings(ctx.db, body)
      const changed = Object.fromEntries(Object.entries(body).filter(([k, v]) => v !== undefined && (cur as Record<string, unknown>)[k] !== v))
      if (Object.keys(changed).length) audit(ctx.db, { actor: auth.user.id, action: 'settings.update', target: null, detail: changed })
      // everyone's screen shows "Team default (…)", and people without their own language switch with it
      if ('defaultLocale' in changed) ctx.services.realtime.publishEach(() => LOCALE_CHANGED)
      return next
    })

    kit.handle(API.usage, ({ query }) => usage(ctx.db, query))
    kit.handle(API.audit, ({ query, auth }) => listAudit(ctx.db, query, auth.user.id))
  },
}
