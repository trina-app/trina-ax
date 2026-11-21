// Saving a team folder's access (docs/AGENTS/plan/20261116-1147-folder-sharing.md "change_folder_access"): the ONE
// function behind Admin › Folder permissions' saves (routes/admin.ts POST /api/admin/folders and PUT
// /api/admin/folders/:id/rules) and the AI's change_folder_access (chat/folder-access-tool.ts, after the admin's yes on
// its card). Moved here from the two route handlers without a change of behaviour, so the dialog and the AI are
// refused by the very same checks:
// - never a project's folder or anything in it (assertNotInProject, before anything is looked up);
// - never users/ (rules there never apply);
// - rules give view or edit only (onlyGrants: no "no access" rule, no role rule), name subjects that exist, once each
//   (validateRules); shared/ and skills/ keep at least one rule or a limit (keepsRules);
// - a guest only in their one project (writeFolderAccess → guestRulesInPlace: 409 guest_one_place);
// - `expectedHash`: the rules the editor (or the AI's card) started from, checked inside the save's transaction;
// - files there shared one by one and someone loses the folder: the save must say what happens to them
//   (`removeFileLinks`, 409 file_links_decide otherwise);
// - audited (folder.create / folder.rules), and afterAccessChange for whoever gains or loses access.
// Callers check the role first (the admin API's own auth; the AI tool re-reads the person's role at the card and again
// right before this call).
import type { FolderRuleInput, Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { msg } from '../auth/messages'
import { audit } from './audit'
import {
  actualFolderPath, afterAccessChange, assertNotInProject, captureState, ensureFolderRow, getFolder, getFolderByPath, isLimited,
  resolveFolderPath, rulesHashAt, rulesHashV1At, rulesOf, validateRules, writeFolderAccess, type FolderRow,
} from './folders'
import { isParkedRow, isTeamDefaultFolder } from './folder-keep'
import { raiseToAbove } from './access-edit'
import { linkPeopleIn, narrowsWithLinks, removeLinksIn } from '../files/shares'
import { FILE_LINKS_DECIDE } from '../files/share-text'

/** The folder row the admin API may change: not a row parked with a trashed folder (404). */
export function editableRow(ctx: AppContext, id: string): FolderRow {
  const f = getFolder(ctx.db, id)
  if (!f || isParkedRow(f.path)) return fail('not_found')
  return f
}

/** shared/ and skills/ keep at least one rule or a limit (with neither, everyone but the owner and admins gets what
 * the team root gives) */
export function keepsRules(ctx: AppContext, p: string, rules: readonly unknown[], limited: boolean, locale: Locale): void {
  if (!rules.length && !limited && isTeamDefaultFolder(p, ctx.files.fx.caseInsensitive)) fail('validation', msg('teamFolderKeepsRules', locale), { fields: { 'body.rules': 'shared/ and skills/ keep at least one rule' } })
}

/** rules give view or edit (docs/DECISIONS.md "Folder access adds up like Google Drive (P2)"): a "no access" rule or a
 * role rule is refused, said per rule */
export function onlyGrants(rules: readonly { subjectType: string; access: string }[], locale: Locale, field = 'body.rules'): void {
  for (const [i, r] of rules.entries()) {
    if (r.subjectType === 'role') fail('validation', msg('noRoleRules', locale), { fields: { [`${field}.${i}.subjectType`]: 'no_role_rules' }, params: { reason: 'no_role_rules' } })
    if (r.access === 'none') fail('validation', msg('noDenyRules', locale), { fields: { [`${field}.${i}.access`]: 'no_deny_rules' }, params: { reason: 'no_deny_rules' } })
  }
}

/** A save that names the rules it started from (`expectedHash`, Folder.rulesHash) is refused when the folder's rules are
 * not those any more: another admin, or the Members screen's skill manager switch, changed them in between, and saving
 * would undo that unseen. Checked inside the save's transaction. Without the field: replaced as before. */
export function sameRules(now: string, expected: string | undefined, locale: Locale): void {
  if (expected !== undefined && expected !== now) fail('conflict', msg('rulesChanged', locale), { params: { reason: 'rules_changed' } })
}

/** Which folder: an existing row by its id (PUT /api/admin/folders/:id/rules), or a path that may have no row yet (POST
 * /api/admin/folders; `create`: make it on disk when missing). */
export type FolderSaveTarget = { folderId: string } | { path: string; create?: boolean }
export interface FolderSave {
  rules: FolderRuleInput[]
  /** Limit access: missing keeps the folder's current value */
  limited?: boolean
  expectedHash?: string
  /** files here shared one by one when someone loses the folder: true removes those shares, false keeps them */
  removeFileLinks?: boolean
}
/** Who saved it: the dialog (nothing), or the AI after the person's yes on its card (the audit row says so). */
export interface FolderSaveBy { via?: 'ai'; turnId?: string; chatId?: string }

/**
 * Save a team folder's rules (see the top of this file). Returns the folder's row; throws the API's errors (400, 404,
 * 409) with nothing saved.
 */
export function saveFolderAccess(ctx: AppContext, actor: string, target: FolderSaveTarget, body0: FolderSave, locale: Locale, by: FolderSaveBy = {}): FolderRow {
  const body: FolderSave = { ...body0, rules: [...body0.rules] }
  const via = by.via ? { via: by.via, ...(by.turnId ? { turnId: by.turnId } : {}), ...(by.chatId ? { chatId: by.chatId } : {}) } : {}
  if ('folderId' in target) return saveRow(ctx, actor, target.folderId, body, locale, via)
  return saveAt(ctx, actor, target.path, target.create ?? true, body, locale, via)
}

/** POST /api/admin/folders: rules on a folder by its path (made on disk if asked). */
function saveAt(ctx: AppContext, actor: string, path: string, create: boolean, body: FolderSave, locale: Locale, via: Record<string, string>): FolderRow {
  // a project's folder and anything in it: its members are changed on its page (before anything else is looked at)
  assertNotInProject(path, locale)
  onlyGrants(body.rules, locale)
  validateRules(ctx.db, body.rules, locale)
  // judged before anything is made on disk (create: true)
  const typed = actualFolderPath(ctx, path)
  if (typed !== null) keepsRules(ctx, typed, body.rules, body.limited ?? (getFolderByPath(ctx.db, typed)?.limited === 1), locale)
  // another admin's rules made meanwhile: said as such, before anything is made on disk
  if (body.expectedHash !== undefined && typed !== null) sameRules(rulesHashAt(ctx.db, typed), body.expectedHash, locale)
  const { path: p, created } = resolveFolderPath(ctx, path, { create, locale })
  const existing = getFolderByPath(ctx.db, p)
  if (body.expectedHash !== undefined) sameRules(rulesHashAt(ctx.db, p), body.expectedHash, locale)
  // a row with rules made meanwhile (a screen that read the folder list before it): told apart from a bare conflict
  if (existing && (rulesOf(ctx.db, existing.id).length || existing.limited === 1)) fail('conflict', msg('folderExists', locale), { params: { reason: 'folder_exists' } })
  const before = captureState(ctx.db)
  const rulesBefore = ctx.files.rules()
  const f = ctx.db.transaction(() => {
    const row = ensureFolderRow(ctx.db, p)
    if (!(body.limited ?? row.limited === 1)) body.rules = raiseToAbove(ctx.files.rules(), p, body.rules)
    writeFolderAccess(ctx.db, row.id, { rules: body.rules, limited: body.limited }, actor)
    // files here shared by link and someone loses the folder: the save must say what happens to those links
    if (body.removeFileLinks === undefined && narrowsWithLinks(ctx.db, rulesBefore, p)) fail('conflict', FILE_LINKS_DECIDE[locale] ?? FILE_LINKS_DECIDE.en, { params: { reason: 'file_links_decide', linkPeople: linkPeopleIn(ctx.db, p) } })
    if (body.removeFileLinks) removeLinksIn(ctx.db, actor, p)
    audit(ctx.db, { actor, action: 'folder.create', target: p, detail: { created, rules: body.rules, ...(body.limited !== undefined ? { limited: body.limited } : {}), ...via } })
    return row
  })()
  afterAccessChange(ctx, before, { actor, target: p, created: created ? [p] : [] })
  return f
}

/** PUT /api/admin/folders/:id/rules: replace the rules of a folder row. */
function saveRow(ctx: AppContext, actor: string, id: string, body: FolderSave, locale: Locale, via: Record<string, string>): FolderRow {
  const f = editableRow(ctx, id)
  assertNotInProject(f.path, locale, 'params.id')
  // a folder moved into users/ keeps its row; rules there are ignored, so refuse to edit them as if they worked
  if (f.path === 'users' || f.path.startsWith('users/')) fail('validation', msg('rulesInUsers', locale), { fields: { 'params.id': 'users/ cannot carry rules' } })
  onlyGrants(body.rules, locale)
  keepsRules(ctx, f.path, body.rules, body.limited ?? f.limited === 1, locale)
  validateRules(ctx.db, body.rules, locale)
  const before = captureState(ctx.db)
  const rulesBefore = ctx.files.rules()
  const old = rulesOf(ctx.db, f.id)
  const wasLimited = f.limited === 1
  ctx.db.transaction(() => {
    const now = getFolder(ctx.db, f.id)!
    // a page from before Limit access (a rules-v1 hash, or a script without a hash) saving a limited folder without
    // `limited`: it never showed the limit, so it is told to reload instead of saving over it (missing keeps the
    // limit anyway: this is the second guard)
    if (now.limited === 1 && body.limited === undefined && (body.expectedHash === undefined || body.expectedHash === rulesHashV1At(ctx.db, f.path)))
      fail('conflict', msg('clientOutdated', locale), { params: { reason: 'client_outdated' } })
    sameRules(rulesHashAt(ctx.db, f.path), body.expectedHash, locale)
    // not limited: a rule lower than the folders above give is stored at that level (12-A at save time)
    if (!(body.limited ?? now.limited === 1)) body.rules = raiseToAbove(ctx.files.rules(), f.path, body.rules)
    writeFolderAccess(ctx.db, f.id, { rules: body.rules, limited: body.limited }, actor)
    // "Remove those links too": in the save's own step (files/shares.ts)
    // files here shared by link and someone loses the folder: the save must say what happens to those links
    if (body.removeFileLinks === undefined && narrowsWithLinks(ctx.db, rulesBefore, f.path)) fail('conflict', FILE_LINKS_DECIDE[locale] ?? FILE_LINKS_DECIDE.en, { params: { reason: 'file_links_decide', linkPeople: linkPeopleIn(ctx.db, f.path) } })
    if (body.removeFileLinks) removeLinksIn(ctx.db, actor, f.path)
    const limitedNow = isLimited(ctx.db, f.id)
    audit(ctx.db, { actor, action: 'folder.rules', target: f.path, detail: { before: old, after: body.rules, ...(limitedNow !== wasLimited ? { limited: { before: wasLimited, after: limitedNow } } : { limited: limitedNow }), ...via } })
  })()
  afterAccessChange(ctx, before, { actor, target: f.path })
  return f
}
