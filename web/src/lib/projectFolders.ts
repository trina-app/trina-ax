// A project is a folder of the team folder with instructions (docs/DECISIONS.md "Projects: a folder with
// instructions"): one project per folder. What the Files page and the project dialog need to know about that.
import type { FileEntry, Project } from '@mycel/shared/api'

/** The last name of a folder path ('' for the team root). */
export const folderName = (p: string) => p.split('/').filter(Boolean).pop() ?? ''

/** A project's name as saved: what was typed, or the chosen folder's own name when nothing was (at most 100 characters,
 * the server's limit). */
export function projectName(typed: string, folder: string): string {
  return Array.from(typed.trim() || folderName(folder)).slice(0, 100).join('').trim()
}

/** The projects the person can see, by their folder (the server names folders as they are on disk). */
export function projectsByFolder(items: readonly Project[]): Map<string, Project> {
  const out = new Map<string, Project>()
  for (const p of items) if (!out.has(p.folderPath.normalize('NFC'))) out.set(p.folderPath.normalize('NFC'), p)
  return out
}

export type FolderProjectAction = { kind: 'open'; project: Project } | { kind: 'make' } | null

/**
 * What a row of the Files page offers about projects: a folder that already is a project the person can see opens it;
 * a folder they can write can become one; anything else offers nothing. (A folder they can write is one they can read,
 * so its project, if any, is always among the ones they see.)
 */
export function folderProjectAction(e: Pick<FileEntry, 'type' | 'path' | 'access'>, byFolder: ReadonlyMap<string, Project>): FolderProjectAction {
  if (e.type !== 'folder') return null
  const project = byFolder.get(e.path.normalize('NFC'))
  if (project) return { kind: 'open', project }
  return e.access === 'write' ? { kind: 'make' } : null
}
