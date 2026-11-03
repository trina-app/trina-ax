// Which folders rows the admin API keeps, and why (routes/admin.ts refuses to remove them; Folder.keep tells the screen,
// so it never guesses from names). No imports beyond the product name: the screen's mock server uses it too.
import { PRODUCT } from '@mycel/shared'

/** 'team': shared/ or skills/, whose rules may change but never all go. 'group': a group's folder (groups.folder_id). */
export type FolderKeep = 'team' | 'group'

/**
 * shared/ and skills/, the team's default folders (createDefaultFolders), compared the way the volume compares names.
 * On a case-insensitive volume (macOS) `Shared` is the same folder, and a move that changes only the case keeps the
 * folders row: compare the NFC lower-case form there. On a case-sensitive volume (Linux) `Shared` can be another folder
 * (a team folder set on an existing share, MYCEL_TEAM_ROOT, or a folder made on disk); the app refuses a move or a new
 * folder that differs from a sibling only in case, but such a folder may be there already, so compare exactly (NFC).
 */
export function isTeamDefaultFolder(p: string, caseInsensitive: boolean): boolean {
  const n = p.normalize('NFC')
  const k = caseInsensitive ? n.toLowerCase() : n
  return k === 'shared' || k === 'skills'
}

export function folderKeep(p: string, groupId: string | null, caseInsensitive: boolean): FolderKeep | null {
  if (isTeamDefaultFolder(p, caseInsensitive)) return 'team'
  return groupId ? 'group' : null
}

/**
 * A row parked with a trashed folder (.system/trash/<month>/<id>/…): not a folder anyone can open. The admin API does
 * not list, edit or remove it (404); it comes back with the folder when the trash item is restored.
 */
export const isParkedRow = (p: string) => p === PRODUCT.systemDir || p.startsWith(PRODUCT.systemDir + '/')
