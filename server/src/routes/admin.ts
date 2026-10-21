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
import { EngineStatusCache, addAccount, deleteAccount, engineEnv, listAccounts } from '../admin/engines'
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

async function enginesResponse(ctx: AppContext, cache: EngineStatusCache, locale: Locale) {
  const enabled = enginesEnabled(ctx.db)
  const s = getTeamSettings(ctx.db)
  const engines = await Promise.all(EngineId.options.map((id) => cache.get(id, enabled[id], locale)))
  return { engines, defaultEngine: s.defaultEngine, defaultModel: s.defaultModel, concurrency: s.concurrency, accounts: listAccounts(ctx) }
}

export const adminRoutes: RouteModule = {
  name: 'admin',
  owner: 'A',
  register(kit, ctx) {
    const engineCache = new EngineStatusCache(() => engineEnv(ctx))

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

    // ---------------- engines ----------------
    kit.handle(API.engines, ({ c }) => enginesResponse(ctx, engineCache, c.get('locale')))

    kit.handle(API.updateEngines, async ({ c, body, auth }) => {
      const locale = c.get('locale')
      if (body.enabled) setEnginesEnabled(ctx.db, body.enabled)
      const enabled = enginesEnabled(ctx.db)
      const s = getTeamSettings(ctx.db)
      const def = body.defaultEngine ?? s.defaultEngine
      if (!enabled[def]) fail('conflict', msg('engineDisabled', locale))
      if (body.defaultEngine === 'codex' && codexIsBeta(ctx)) fail('conflict', msg('codexBetaDefault', locale))
      updateTeamSettings(ctx.db, {
        ...(body.defaultEngine !== undefined ? { defaultEngine: body.defaultEngine } : {}),
        ...(body.defaultModel !== undefined ? { defaultModel: body.defaultModel } : body.defaultEngine !== undefined && body.defaultEngine !== s.defaultEngine ? { defaultModel: null } : {}),
        ...(body.concurrency !== undefined ? { concurrency: body.concurrency } : {}),
      })
      audit(ctx.db, { actor: auth.user.id, action: 'engines.update', target: null, detail: body as Record<string, unknown> })
      return enginesResponse(ctx, engineCache, locale)
    })

    kit.handle(API.checkEngine, ({ c, params }) => {
      const id = EngineId.safeParse(params.id)
      if (!id.success) fail('not_found')
      return engineCache.get(id.data as EngineIdT, enginesEnabled(ctx.db)[id.data as EngineIdT], c.get('locale'), true)
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
      if (body.defaultEngine !== undefined && !enginesEnabled(ctx.db)[body.defaultEngine]) fail('conflict', msg('engineDisabled', c.get('locale')))
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
