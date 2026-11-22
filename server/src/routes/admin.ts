// Route module "admin" — owner: component A (docs/WORKPLAN.md).
// Implements: ADMIN (users, invites, groups, folders + rules + preview, engines, budgets, settings, usage, audit) and
// CREDENTIALS (AI connections, registered from ./credentials.ts, the same owner)
// Contract: shared/src/api/admin.ts, shared/src/api/credentials.ts
// Nothing here returns chat or memory contents: admins manage people, folders and engines, not conversations.
import { hostedTeamName, reportTeamName } from '../system/cloud-team-name'
import { linkPeopleIn } from '../files/shares'
import { editableRow as editableRowOf, onlyGrants as onlyGrantsOf, saveFolderAccess } from '../admin/folder-save'
import { API, EngineId, OWNER_ONLY_SETTINGS, type EngineId as EngineIdT } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId } from '../db'
import { fail } from '../http/errors'
import { createGuestInviteFor, createInvite, guestInviteLimit, createResetLink, linkBase, listInvites, revokeInvite } from '../auth/accounts'
import { convertGuest, disablePlacelessGuests, updateGuestAi } from '../admin/guests'
import { msg } from '../auth/messages'
import { audit, listAudit } from '../admin/audit'
import { createBudget, deleteBudget, listBudgets, updateBudget, usage } from '../admin/budgets'
import { EngineStatusCache, engineStatusCache } from '../admin/engines'
import {
  afterAccessChange, assertNotInProject, captureState, dropFolderRow, keepOfRow, listFolders, originKeepers, folderAccessNotice, FOLDER_ACCESS_NOTICE_DISMISSED,
  previewRules, rulesOf, toFolder, type FolderRow,
} from '../admin/folders'
import { createGroup, deleteGroup, listGroups, updateGroup } from '../admin/groups'
import { explainEdit, explainFolder, explainNewPerson, explainPerson, explainTree } from '../admin/access-explain'
import { oftenAskedSwitched } from '../chat/often-asked'
import { isGuestUser } from '../credentials/guest-ai'
import { BROWSER_POLICY_CHANGED, GUEST_FILE_LIMIT_CHANGED, enginesEnabled, getTeamSettings, LOCALE_CHANGED, setEnginesEnabled, SPEECH_CHANGED, updateTeamSettings, WEB_ACCESS_CHANGED } from '../admin/settings'
import { teamPolicyOff } from '../tools/web-allow-all'
import { ROOM_ALERTS_CHANGED } from '../rooms/alerts'
import { credentialsOf, noticeOwners } from '../credentials/store'
import { unsealOrFail } from '../credentials/service'
import { speechKeyStatus, writeSpeechKey } from '../credentials/speech-key'
import { createUser, deleteUser, disconnectUserGoogle, guardResetLink, listUsers, resetPassword, transferOwnership, updateUser } from '../admin/users'
import { googleConnectedUsers } from '../auth/login-identities'
import { googleSignInAdminStatus } from '../auth/google-login-admin'
import { dismissLead, endPending, handoverState, noteReauthLocked, retryPendingEnds } from '../admin/handover'
import { setHandoverPushConfig } from '../admin/handover-notices'
import { authOf } from '../auth/service'
import { openDeletionRequests } from '../auth/deletion-requests'
import { withoutAi } from '../credentials/access'
import type { Locale } from '@mycel/shared/api'
import type { RouteModule } from './module'
import { codexIsBeta } from '../chat/engines'
import { ENGINE_CHOICE_CHANGED, codexOffHere, engineOn, limitFallbackAvailable, limitFallbackOn, memberChoice, setLimitFallback, setMemberChoice } from '../admin/engine-choice'
import { connectedFolders, ConnectedError, type ConnectedRow } from '../team-files/connected'
import { listSkillManagers, setSkillManager } from '../skills/managers'
import { auditSight } from '../admin/audit-sight'
import { listSkillChanges } from '../skills/changes'
import { addressOf, hasStoredApiKey, readApiEngine, writeApiEngine } from '../engine/api-agent'
import { apiVisionOf } from '../engine/api-vision'
import { getChatRuntime } from '../chat/runtime'
import { registerCredentialRoutes } from './credentials'
import { registerTeamLinkRoutes } from './team-links'
import { assertConcurrencyAllowed, concurrencyMax } from '../system/limits'
import { checkApiEngineUrl, checkApiEngineUrlForAdmin } from '../system/egress'
import { feature } from '../system/deployment'
import { readTeamIcon, removeTeamIcon, saveTeamIcon, TEAM_ICON_CHANGED, teamIconInfo } from '../admin/team-icon'

const hostOf = (u: string) => { try { return new URL(u).host } catch { return '' } }

async function enginesResponse(ctx: AppContext, cache: EngineStatusCache, locale: Locale) {
  const enabled = enginesEnabled(ctx.db)
  const s = getTeamSettings(ctx.db)
  const engines = await Promise.all(EngineId.options.map((id) => cache.get(id, enabled[id], locale)))
  return {
    // company keys are AI connections now (Admin > AI connections); the field stays empty until the next release
    engines, defaultEngine: s.defaultEngine, defaultModel: s.defaultModel, concurrency: s.concurrency, concurrencyMax: concurrencyMax(), accounts: [],
    memberChoice: memberChoice(ctx), limitFallback: limitFallbackOn(ctx), limitFallbackAvailable: limitFallbackAvailable(ctx),
  }
}


export const adminRoutes: RouteModule = {
  name: 'admin',
  owner: 'A',
  register(kit, ctx) {
    // at start: a guest whose one place went away without an access change (a backup restored, a folder removed on
    // disk) is switched off (admin/guests.ts)
    try { disablePlacelessGuests(ctx, null) } catch (e) { ctx.log.warn('placeless guests check failed at start', { err: e }) }
    const engineCache = engineStatusCache(ctx)

    // ---------------- users ----------------
    kit.handle(API.listUsers, ({ query, auth }) => {
      // "No AI" only for the screens that show it (Admin › Members, the owner's checklist)
      let problems = {}
      if (query.noAi) try { problems = getChatRuntime(ctx).engines.get().problems } catch { /* no chat runtime: none known */ }
      const noAi = query.noAi ? withoutAi(ctx, { problems }) : null
      // who asked for their account to be deleted: for the owner and the admins, who delete accounts (an admin sees
      // the members' requests only: an admin's own is the owner's to handle)
      const open = openDeletionRequests(ctx, auth.user.role === 'owner' ? undefined : 'member')
      const deletionDue = Object.fromEntries(open.flatMap((r) => (r.dueAt ? [[r.userId, r.dueAt]] : [])))
      // who connected a Google account to sign in with: "Google" beside them (ids only, never the account)
      return { items: listUsers(ctx), ...(noAi ? { noAi: noAi.ids, noAiUntil: noAi.until } : {}), deletionRequested: open.map((r) => r.userId), deletionDue, google: googleConnectedUsers(ctx.db) }
    })
    kit.handle(API.createUser, ({ c, body }) => createUser(c, ctx, body))
    kit.handle(API.updateUser, ({ c, params, body }) => updateUser(c, ctx, params.id, body))
    kit.handle(API.deleteUser, ({ c, params, query, body }) => deleteUser(c, ctx, params.id, query.personalFolder, body.password))
    kit.handle(API.resetPassword, ({ c, params, body }) => resetPassword(c, ctx, params.id, body))
    kit.handle(API.createResetLink, ({ c, params, auth }) => {
      guardResetLink(c, ctx, params.id)
      return createResetLink(ctx, params.id, auth.user.id, linkBase(c, ctx))
    })
    // Sign in with Google (admin/users.ts disconnectUserGoogle): the people rules of the other actions here
    kit.handle(API.disconnectUserGoogle, ({ c, params }) => disconnectUserGoogle(c, ctx, params.id))
    kit.handle(API.transferOwnership, ({ c, body }) => transferOwnership(c, ctx, body))
    // 팀장 넘기기 (admin/handover.ts): the owner's state and the card's ✕; a wrong password that locks the owner's
    // re-check (any of them: the transfer's, updates, restore, the current password) tells the owner
    kit.handle(API.handoverState, ({ auth }) => handoverState(ctx, auth.user.id))
    kit.handle(API.dismissLeadCard, ({ c, body }) => { dismissLead(c, ctx, body.inviteId); return { ok: true as const } })
    kit.handle(API.endPendingConnections, ({ c, body }) => endPending(c, ctx, body.transferId))
    // what a transfer planned to end and did not (the server stopped right after it, a service failed): tried again now
    { const t = setTimeout(() => void retryPendingEnds(ctx), 5_000); t.unref?.(); ctx.onClose(() => clearTimeout(t)) }
    authOf(ctx).onReauthLocked = (userId) => noteReauthLocked(ctx, userId)
    setHandoverPushConfig(ctx.db, ctx.config)

    // ---------------- invites ----------------
    kit.handle(API.listInvites, () => ({ items: listInvites(ctx) }))
    kit.handle(API.createInvite, ({ c, body }) => createInvite(c, ctx, body))
    kit.handle(API.createGuestInvite, ({ c, body }) => createGuestInviteFor(c, ctx, body))
    kit.handle(API.guestInviteLimit, ({ c }) => guestInviteLimit(c, ctx))
    kit.handle(API.convertGuest, ({ c, params }) => convertGuest(c, ctx, params.id))
    kit.handle(API.updateGuestAi, ({ c, params, body }) => updateGuestAi(c, ctx, params.id, body))
    kit.handle(API.revokeInvite, ({ c, params }) => revokeInvite(c, ctx, params.id))

    // ---------------- groups ----------------
    kit.handle(API.listGroups, () => ({ items: listGroups(ctx) }))
    kit.handle(API.createGroup, ({ c, body }) => createGroup(c, ctx, body))
    kit.handle(API.updateGroup, ({ c, params, body }) => updateGroup(c, ctx, params.id, body))
    kit.handle(API.deleteGroup, ({ c, params }) => deleteGroup(c, ctx, params.id))
    kit.handle(API.folderAccessNotice, () => ({ notice: folderAccessNotice(ctx.db) }))
    kit.handle(API.dismissFolderAccessNotice, ({ auth }) => {
      ctx.db.query('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(FOLDER_ACCESS_NOTICE_DISMISSED, JSON.stringify({ by: auth.user.id, at: new Date().toISOString() }))
      audit(ctx.db, { actor: auth.user.id, action: 'folders.notice_dismissed', target: null, detail: null })
    })
    kit.handle(API.originCheck, ({ body }) => ({ kept: originKeepers(ctx.db, body.changes).map((k) => ({ user: { id: k.userId, name: k.name }, path: k.path, access: k.access, groupId: k.groupId })) }))

    // ---------------- folders and rules ----------------
    // What the admin API refuses here, and only here: replaceRules / dropFolderRow also serve deleting a group, deleting
    // a person, turning a skills manager off and dropping a project's marker row, which must keep working whatever
    // rules are left. shared/ and skills/ keep at least one rule (with none, everyone but the owner and admins falls back
    // to the team root's rules, and the root has none by default: "Everyone: No access" is the way to keep them to
    // admins); a group's folder row stays while the group does (removing it cuts the group's link and the folder's
    // protection for good); a row parked with a trashed folder is not there (404). Which row is which: folder-keep.ts,
    // also sent as Folder.keep.
    const editableRow = (id: string): FolderRow => editableRowOf(ctx, id)
    const onlyGrants = onlyGrantsOf
    // shared/ and skills/ keep at least one rule, rules give view or edit, and a save names the rules it started from:
    // admin/folder-save.ts (the one save of Admin › Folder permissions and the AI's change_folder_access)
    kit.handle(API.listFolders, () => ({ items: listFolders(ctx) }))

    kit.handle(API.createFolder, ({ c, body, auth }) => {
      // admin/folder-save.ts: the same checks and save as the AI's change_folder_access
      const f = saveFolderAccess(ctx, auth.user.id, { path: body.path, create: body.create }, { rules: body.rules, limited: body.limited, expectedHash: body.expectedHash, removeFileLinks: body.removeFileLinks }, c.get('locale'))
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
    // the hosted cloud has no connected folders (system/deployment.ts): the list says so, adding or syncing one is refused
    const connectedOn = () => feature(ctx.config, 'connectedFolders')
    kit.handle(API.listConnected, ({ c }) => {
      if (!connectedOn()) return { items: [], available: false }
      const cf = connectedFolders(ctx)
      return { items: cf.list().map((r) => ({ ...connectedOut(r, cf.isSyncing(r.id)), lastError: r.last_error ? msg(`connected_${r.last_error}` as never, c.get('locale')) : null })), available: true }
    })
    kit.handle(API.addConnected, ({ c, body, auth }) => {
      if (!connectedOn()) fail('conflict', msg('connected_unavailable' as never, c.get('locale')))
      const cf = connectedFolders(ctx)
      let row: ConnectedRow
      try { row = cf.add({ name: body.name, source: body.source, actor: auth.user.id }) } catch (e) { return connectedFail(e, c.get('locale')) }
      void cf.sync(row.id).catch(() => {})
      return connectedOut(row, true)
    })
    kit.handle(API.syncConnected, ({ c, params }) => {
      if (!connectedOn()) fail('conflict', msg('connected_unavailable' as never, c.get('locale')))
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
      // admin/folder-save.ts: the same checks and save as the AI's change_folder_access
      const f = saveFolderAccess(ctx, auth.user.id, { folderId: params.id }, { rules: body.rules, limited: body.limited, expectedHash: body.expectedHash, removeFileLinks: body.removeFileLinks }, c.get('locale'))
      return toFolder(ctx, f)
    })

    kit.handle(API.deleteFolder, ({ c, params, auth }) => {
      const f = editableRow(params.id)
      assertNotInProject(f.path, c.get('locale'), 'params.id')
      const keep = keepOfRow(ctx, f)
      if (keep === 'team') fail('conflict', msg('teamFolderKeepsRules', c.get('locale')))
      if (keep === 'group') fail('conflict', msg('groupFolderKeepsRow', c.get('locale')))
      const before = captureState(ctx.db)
      const old = rulesOf(ctx.db, f.id)
      ctx.db.transaction(() => {
        dropFolderRow(ctx.db, f.id)
        audit(ctx.db, { actor: auth.user.id, action: 'folder.delete', target: f.path, detail: { before: old, limited: f.limited === 1 } })
      })()
      afterAccessChange(ctx, before, { actor: auth.user.id, target: f.path })
    })

    kit.handle(API.previewRules, ({ c, body }) => {
      for (const [i, x] of body.changes.entries()) { assertNotInProject(x.path, c.get('locale'), `body.changes.${i}.path`); onlyGrants(x.rules, c.get('locale'), `body.changes.${i}.rules`) }
      return previewRules(ctx, body.changes, c.get('locale'))
    })
    // who sees a folder and why, what one person sees and why (admin/access-explain.ts; read only)
    kit.handle(API.explainFolderAccess, ({ c, query }) => explainFolder(ctx, query, c.get('locale')))
    kit.handle(API.explainPersonAccess, ({ params, query }) => explainPerson(ctx, params.id, query))
    kit.handle(API.explainNewPersonAccess, ({ c, body }) => explainNewPerson(ctx, body, c.get('locale')))
    kit.handle(API.explainAccessTree, ({ c, query }) => explainTree(ctx, query, c.get('locale')))
    // the edit panel: what saving these rules would change (admin/access-edit.ts; nothing is saved)
    kit.handle(API.previewFolderEdit, ({ c, body }) => {
      assertNotInProject(body.path, c.get('locale'))
      onlyGrants(body.rules, c.get('locale'))
      const r = explainEdit(ctx, body, c.get('locale'))
      // files at or under it shared one by one: how many people keep them by their links when someone loses access here
      // (files/shares.ts; the dialog offers "Remove those links too")
      const n = r.less > 0 && r.exists ? linkPeopleIn(ctx.db, r.path) : 0
      return n > 0 ? { ...r, linkPeople: n } : r
    })

    // ---------------- team skills: who manages them, what changed (skills/managers.ts, skills/changes.ts) ----------------
    kit.handle(API.listSkillManagers, () => listSkillManagers(ctx))
    kit.handle(API.setSkillManager, ({ c, body, auth }) => setSkillManager(ctx, auth.user.id, body, c.get('locale')))
    kit.handle(API.listSkillChanges, ({ query, auth }) => listSkillChanges(ctx.db, auth.user.id, query, auditSight(ctx, auth.user.id)))

    // ---------------- engines ----------------
    kit.handle(API.engines, ({ c }) => enginesResponse(ctx, engineCache, c.get('locale')))

    // ---------------- the team's API engine (engine/api-agent.ts) ----------------
    const apiConfigOut = async () => {
      const conf = readApiEngine(ctx.config.dataDir)
      // whether the model takes pictures, as its server says (engine/api-vision.ts; cached), and the admin's choice
      const detected = conf ? (await apiVisionOf(conf).catch(() => ({ images: null }))).images : null
      return { baseUrl: conf?.baseUrl ?? null, model: conf?.model ?? null, label: conf?.label ?? null, hasKey: !!conf?.key, vision: { detected, choice: conf?.vision ?? null } }
    }
    kit.handle(API.getApiEngine, () => apiConfigOut())
    kit.handle(API.putApiEngine, async ({ c, body, auth }) => {
      const locale = c.get('locale')
      await checkApiEngineUrl(ctx.config, body.baseUrl, locale) // the hosted cloud: https to public addresses only
      // who is asking, read again every time it matters (the checks below wait for DNS): an owner demoted, or an admin
      // disabled or deleted, meanwhile is who they are now
      const actorNow = (): 'owner' | 'admin' => {
        const u = ctx.db.query(`SELECT CASE WHEN guest = 1 THEN 'guest' ELSE role END AS role, status, deleted_at FROM users WHERE id = ?`).get(auth.user.id) as { role: string; status: string; deleted_at: string | null } | null
        if (!u || u.deleted_at || u.status !== 'active' || (u.role !== 'owner' && u.role !== 'admin')) fail('forbidden')
        return u!.role as 'owner' | 'admin'
      }
      const wanted = addressOf(body.baseUrl)
      // An admin (not the owner) does not set an address on a private network, on this server or link-local, nor an http
      // one; an address that is already set stays as it is (a model change). The check waits for DNS, so what is "already
      // set" and who asks are read again after every wait, and the decisions below (the key rule) are made from a read with
      // no wait before the write.
      let validated: string | null = null
      let role = actorNow()
      for (;;) {
        const now = readApiEngine(ctx.config.dataDir)
        if (role !== 'owner' && !(now && addressOf(now.baseUrl) === wanted) && validated !== wanted) {
          await checkApiEngineUrlForAdmin(body.baseUrl, { owner: msg('apiAddressOwnerOnly', locale), https: msg('apiAddressNeedsHttps', locale) })
          validated = wanted
          role = actorNow()
          continue
        }
        break
      }
      role = actorNow()
      // from here to the write nothing waits: the stored key belongs to the whole address it was made for (it is stored
      // with it, and read back only for it: not for another host, port or path), and a new address never inherits it: the
      // caller sends a key for the new address, or null. (An admin could otherwise point the engine at their own server, or
      // at another tenant's path on the same gateway, and collect it.)
      const old = readApiEngine(ctx.config.dataDir)
      const sameAddress = !!old && addressOf(old.baseUrl) === wanted
      if (!sameAddress && body.key === undefined && hasStoredApiKey(ctx.config.dataDir)) {
        fail('validation', msg('apiKeyForNewAddress', locale), { fields: { 'body.key': 'a key for the new address is required' } })
      }
      // who set the address: an address an admin set stays checked to be a public https one before every call, whoever
      // saves it next; only an owner who sets a NEW address makes it theirs
      const setBy: 'owner' | 'admin' = sameAddress ? (old!.setBy === 'admin' ? 'admin' : 'owner') : role === 'owner' ? 'owner' : 'admin'
      const nothingChanged = sameAddress && old!.model === body.model && (body.label === undefined || (body.label.trim() || body.model) === old!.label) && setBy === (old!.setBy ?? 'owner')
        && (body.vision === undefined || body.vision === (old!.vision ?? null))
        && (body.key === undefined || (body.key === null && !hasStoredApiKey(ctx.config.dataDir)))
      writeApiEngine(ctx.config.dataDir, { baseUrl: body.baseUrl, model: body.model, label: body.label, setBy, ...(body.key !== undefined ? { key: body.key } : {}), ...(body.vision !== undefined ? { vision: body.vision } : {}) })
      audit(ctx.db, { actor: auth.user.id, action: 'engines.api', target: 'api', detail: { baseUrl: body.baseUrl, model: body.model, key: body.key === undefined ? 'kept' : body.key ? 'set' : 'removed', ...(body.vision !== undefined ? { vision: body.vision } : {}) } })
      engineCache.forget('api')
      // an admin's change is told to the owner(s): who and the model, never the key (credentials/store.ts noticeOwners)
      if (!nothingChanged) noticeOwners(credentialsOf(ctx), auth.user.id, 'engine', `${hostOf(body.baseUrl)}, ${body.model}`, { model: body.model, host: hostOf(body.baseUrl) })
      try { (getChatRuntime(ctx).engines as { reset?: () => void }).reset?.() } catch {}
      return apiConfigOut()
    })

    kit.handle(API.updateEngines, async ({ c, body, auth }) => {
      const locale = c.get('locale')
      assertConcurrencyAllowed(body.concurrency, locale) // plan (system/limits.ts)
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
      // "다른 AI로 대신 답하기" decides who has AI too (credentials/access.ts): a change of it is told like the others
      const before = { enabled: enginesEnabled(ctx.db), memberChoice: memberChoice(ctx), defaultEngine: s.defaultEngine, defaultModel: s.defaultModel, limitFallback: limitFallbackOn(ctx) }
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
      if (JSON.stringify(before) !== JSON.stringify({ enabled: enginesEnabled(ctx.db), memberChoice: memberChoice(ctx), defaultEngine: after.defaultEngine, defaultModel: after.defaultModel, limitFallback: limitFallbackOn(ctx) }))
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

    // ---------------- AI connections (server/src/credentials, routes/credentials.ts) ----------------
    registerCredentialRoutes(kit, ctx)
    registerTeamLinkRoutes(kit, ctx)

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
    // whether Team settings shows "Sign in with Google" (auth/google-login-admin.ts): never the client
    kit.handle(API.googleSignInAdminStatus, () => googleSignInAdminStatus(ctx))
    kit.handle(API.updateSettings, ({ c, body, auth }) => {
      assertConcurrencyAllowed(body.concurrency, c.get('locale')) // plan (system/limits.ts)
      const cur = getTeamSettings(ctx.db)
      if (body.teamName !== undefined && body.teamName !== cur.teamName && auth.user.role !== 'owner') fail('forbidden', msg('ownerTeamName', c.get('locale')))
      // a hosted team's new name must be one the hosting service takes (system/cloud-team-name.ts): an error now, not a
      // name that never reaches the console and mails
      if (body.teamName !== undefined && body.teamName !== cur.teamName) {
        const n = hostedTeamName(ctx, body.teamName)
        body.teamName = 'name' in n ? n.name : fail('validation', msg('teamNameInvalid', c.get('locale')), { fields: { 'body.teamName': n.problem } })
      }
      // how long the audit log, file history and both trashes keep things, and the update channel, are the owner's: an
      // admin who shortens them could have the nightly sweep erase the audit trail and old file versions
      // (docs/DECISIONS.md "Retention and the update channel are owner-only"). Saving the same value again is fine.
      if (auth.user.role !== 'owner') {
        const owned = OWNER_ONLY_SETTINGS.filter((k) => body[k] !== undefined && body[k] !== cur[k])
        if (owned.length) fail('forbidden', msg('ownerOnlySetting', c.get('locale')), { fields: Object.fromEntries(owned.map((k) => [`body.${k}`, 'owner only'])) })
      }
      if (body.defaultEngine !== undefined && !engineOn(ctx, body.defaultEngine)) fail('conflict', msg('engineDisabled', c.get('locale')))
      if (body.defaultEngine === 'codex' && codexIsBeta(ctx)) fail('conflict', msg('codexBetaDefault', c.get('locale')))
      // the settings and, when "Allow all websites" for web reads stops being allowed, everyone's switch off with the
      // policy epoch raised (tools/web-allow-all.ts): one transaction, so a crash between them leaves no row on
      let turnedOff: string[] = []
      const next = ctx.db.transaction(() => {
        const n = updateTeamSettings(ctx.db, body)
        if ((cur.browserAllowAll && cur.webAllowAll) && !(n.browserAllowAll && n.webAllowAll)) turnedOff = teamPolicyOff(ctx.db, auth.user.id)
        // "Show what the team often asks": off, every list goes at once; on, counting starts again from now
        if (n.oftenAsked !== cur.oftenAsked) oftenAskedSwitched(ctx.db, n.oftenAsked)
        return n
      })()
      // by value, as stored (a list compared by its items; team picks as cleaned): saving the same again changes nothing
      const changed = Object.fromEntries(Object.entries(body).filter(([k, v]) => v !== undefined && JSON.stringify((cur as Record<string, unknown>)[k]) !== JSON.stringify((next as Record<string, unknown>)[k]))
        .map(([k]) => [k, (next as Record<string, unknown>)[k]]))
      if (Object.keys(changed).length) audit(ctx.db, { actor: auth.user.id, action: 'settings.update', target: null, detail: changed })
      // the people whose switch went off (audited above) are told
      for (const id of turnedOff) ctx.services.realtime.publish(id, WEB_ACCESS_CHANGED)
      // everyone's screen shows "Team default (…)", and people without their own language switch with it
      if ('defaultLocale' in changed) ctx.services.realtime.publishEach(() => LOCALE_CHANGED)
      // a hosted team: the hosting service's console, billing pages and mails show the new name (system/cloud-team-name.ts)
      if ('teamName' in changed) void reportTeamName(ctx, next.teamName)
      // a new team time zone: the enabled schedules run at their times in it (chat/schedules.ts)
      if ('timeZone' in changed) { try { getChatRuntime(ctx).schedules.recomputeAll() } catch {} }
      // ...and everyone's quiet hours are read in it: the web app's sound takes the zone from the rooms list again
      if ('timeZone' in changed) ctx.services.realtime.publishEach(() => ROOM_ALERTS_CHANGED)
      if ('concurrency' in changed) getChatRuntime(ctx).schedule()
      // desktop apps re-read the browser policy from GET /api/me (off: "Allow all websites" goes back to asking)
      if ('browserAllowAll' in changed || 'webAllowAll' in changed) ctx.services.realtime.publishEach(() => BROWSER_POLICY_CHANGED)
      // composers show or hide the mic (Me.team.voiceInput)
      if ('speechProvider' in changed) ctx.services.realtime.publishEach(() => SPEECH_CHANGED)
      // guests' room boxes read their file limit again (Me.team.uploadMaxBytes); nobody else is told
      if ('guestFileMax' in changed) ctx.services.realtime.publishEach((id) => (isGuestUser(ctx.db, id) ? GUEST_FILE_LIMIT_CHANGED : null))
      return next
    })

    // ---------------- the team logo: the top of the rail; tab and app icons stay the product's (admin/team-icon.ts, /team-icon) ----------------
    kit.handle(API.putTeamIcon, async ({ c, query, body, auth }) => {
      const before = readTeamIcon(ctx.config.dataDir)?.version ?? null
      const icon = await saveTeamIcon(ctx.config.dataDir, body, query.type, c.get('locale'))
      const info = teamIconInfo(icon)
      audit(ctx.db, { actor: auth.user.id, action: 'team_icon.set', target: null, detail: { ...info, before } })
      ctx.services.realtime.publishEach(() => TEAM_ICON_CHANGED)
      return info
    })
    kit.handle(API.deleteTeamIcon, ({ auth }) => {
      const before = readTeamIcon(ctx.config.dataDir)?.version ?? null
      if (!removeTeamIcon(ctx.config.dataDir)) return
      audit(ctx.db, { actor: auth.user.id, action: 'team_icon.remove', target: null, detail: { before } })
      ctx.services.realtime.publishEach(() => TEAM_ICON_CHANGED)
    })

    // ---------------- voice input: the OpenRouter key (credentials/speech-key.ts) ----------------
    kit.handle(API.speechKey, () => speechKeyStatus(ctx.db))
    // the "Turn video sound into text" switch: this server's cores (its default), piece length and measured speed
    kit.handle(API.speechHost, () => ctx.files.speechHost())
    kit.handle(API.setSpeechKey, async ({ c, body, auth }) => {
      const locale = c.get('locale')
      // the password again (route.ts reauth), admins may do it too: audio goes to a third party
      if (!(await ctx.services.sessions.verifyPassword(auth.user.id, body.password, c.get('info')))) {
        fail('forbidden', msg('wrongPassword', locale), { fields: { 'body.password': 'wrong password' } })
      }
      const cc = credentialsOf(ctx)
      let key: string | null = null
      if (body.sealed) {
        key = (await unsealOrFail(cc, body.sealed, 'speech.key', locale)).trim()
        if (!/^[\x21-\x7e]{16,300}$/.test(key)) fail('validation', undefined, { fields: { 'body.sealed': 'not an API key' } })
      }
      const before = speechKeyStatus(ctx.db).set
      const out = writeSpeechKey(cc, key)
      audit(ctx.db, { actor: auth.user.id, action: 'speech.key', target: null, detail: key ? { key: 'set', hint: out.hint } : { key: 'removed' } })
      if (before !== out.set) ctx.services.realtime.publishEach(() => SPEECH_CHANGED)
      return out
    })

    kit.handle(API.usage, ({ query }) => usage(ctx.db, query))
    // nothing inside a team project the viewer does not read (admin/audit-sight.ts)
    kit.handle(API.audit, ({ query, auth }) => listAudit(ctx.db, query, auth.user.id, auditSight(ctx, auth.user.id)))
  },
}
