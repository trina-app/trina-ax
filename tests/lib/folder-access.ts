// Folder access for test fixtures (docs/DECISIONS.md "Folder access adds up like Google Drive (P2)"). Tests write
// folder rules through writeFolderAccess, as the server does, never raw rows (the triggers of migration 121 refuse
// "no access" and role rows). setFolderAccess takes a rule list in the form tests used before P2 and says what it meant:
// - "everyone: none" = Limit access (the folder is limited; nothing from above reaches it);
// - a person's own "none" on projects/<name> = the project exception;
// - "role admin: write" = the managed marker; "role member: X" = "everyone: X";
// - any other "none" or role rule has no meaning any more: it throws, so the test says what it wants instead.
// A projects/<name> folder is always limited.
import type { Database } from 'bun:sqlite'
import type { FolderRuleInput } from '@mycel/shared/api'
import { getFolder, getFolderByPath, ensureFolderRow, setProjectException, writeFolderAccess } from '../../server/src/admin/folders'
import { isZoneTop } from '../../server/src/policy/access'

type LegacyRule = { subjectType: string; subjectId: string | null; access: string }

export function setFolderAccess(db: Database, folder: string, rules: readonly LegacyRule[], actor: string | null = null, o: { limited?: boolean } = {}): void {
  const row = getFolder(db, folder) ?? ensureFolderRow(db, folder)
  const zoneTop = isZoneTop(row.path)
  let limited = o.limited ?? (zoneTop || rules.some((r) => r.subjectType === 'everyone' && r.access === 'none'))
  const grants: FolderRuleInput[] = []
  const exceptions: string[] = []
  let managed = false
  for (const r of rules) {
    if (r.subjectType === 'everyone' && r.access === 'none') { limited = true; continue }
    if (r.subjectType === 'role' && r.subjectId === 'admin' && r.access === 'write') { managed = true; continue }
    if (r.subjectType === 'role' && r.subjectId === 'member') { if (r.access !== 'none') grants.push({ subjectType: 'everyone', subjectId: null, access: r.access as 'read' | 'write' }); continue }
    if (r.subjectType === 'user' && r.access === 'none' && zoneTop && r.subjectId) { exceptions.push(r.subjectId); continue }
    if (r.access === 'none' || r.subjectType === 'role') throw new Error(`setFolderAccess(${row.path}): ${r.subjectType} ${r.subjectId ?? ''} ${r.access} means nothing since access adds up; say what the test wants (a limit, a narrower rule)`)
    grants.push(r as FolderRuleInput)
  }
  const run = () => {
    writeFolderAccess(db, row.id, { rules: grants, limited, managed }, actor)
    for (const id of exceptions) setProjectException(db, row.id, id, true, actor)
  }
  if (db.inTransaction) run()
  else db.transaction(run)()
}

/** setFolderAccess by path (the row is made when missing). */
export const setFolderAccessAt = (db: Database, p: string, rules: readonly LegacyRule[], actor: string | null = null, o: { limited?: boolean } = {}) =>
  setFolderAccess(db, (getFolderByPath(db, p) ?? ensureFolderRow(db, p)).id, rules, actor, o)
