// Which folders rows the admin API keeps, and why (routes/admin.ts refuses to remove them; Folder.keep tells the screen,
// so it never guesses from names). No imports beyond the product name: the screen's mock server uses it too.
import { PRODUCT } from '@mycel/shared'

/** 'team': shared/ or skills/, whose rules may change but never all go. 'group': a group's folder (groups.folder_id). */
export type FolderKeep = 'team' | 'group'

/**
 * shared/ and skills/, the team's default folders (createDefaultFolders), compared by their NFC lower-case form. On a
 * case-insensitive volume (macOS) a move that changes only the case is taken and keeps the folders row (`Shared`, the
 * same folder); elsewhere the app refuses that move. The app never makes a second folder that differs only in case
 * (near-duplicate names are refused), so no other folder is caught.
 */
export function isTeamDefaultFolder(p: string): boolean {
  const k = p.normalize('NFC').toLowerCase()
  return k === 'shared' || k === 'skills'
}

export function folderKeep(p: string, groupId: string | null): FolderKeep | null {
  if (isTeamDefaultFolder(p)) return 'team'
  return groupId ? 'group' : null
}

/**
 * A row parked with a trashed folder (.system/trash/<month>/<id>/…): not a folder anyone can open. The admin API does
 * not list, edit or remove it (404); it comes back with the folder when the trash item is restored.
 */
export const isParkedRow = (p: string) => p === PRODUCT.systemDir || p.startsWith(PRODUCT.systemDir + '/')
