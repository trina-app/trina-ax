// A project is a folder of the team folder with instructions (docs/DECISIONS.md "Projects: a folder with
// instructions"): one project per folder. What the Files page and the project dialog need to know about that.
import type { FileEntry, Project } from '@mycel/shared/api'

/** The last name of a folder path ('' for the team root). */
export const folderName = (p: string) => p.split('/').filter(Boolean).pop() ?? ''

/** The server's limit on a project's name, counted as JavaScript counts a string's length (UTF-16 units, as zod's
 * max(100) and the input's maxLength do). */
export const PROJECT_NAME_MAX = 100

/** A project's name as saved: what was typed, or the chosen folder's own name when nothing was, cut to the server's
 * limit without splitting a character that takes two units. */
export function projectName(typed: string, folder: string): string {
  let out = ''
  for (const ch of typed.trim() || folderName(folder)) {
    if (out.length + ch.length > PROJECT_NAME_MAX) break
    out += ch
  }
  return out.trim()
}

/** The projects the person can see, by their folder (the server names folders as they are on disk). */
export function projectsByFolder(items: readonly Project[]): Map<string, Project> {
  const out = new Map<string, Project>()
  for (const p of items) if (!out.has(p.folderPath.normalize('NFC'))) out.set(p.folderPath.normalize('NFC'), p)
  return out
}

export type FolderProjectAction = { kind: 'open'; project: Project } | null

/**
 * What a row of the Files page offers about projects: a folder that is a project the person can see opens it. Nothing
 * else: new projects are made on the Projects page, always in a new projects/<name> (docs/DECISIONS.md "Projects live
 * only in projects/"), never on an existing folder.
 */
export function folderProjectAction(e: Pick<FileEntry, 'type' | 'path'>, byFolder: ReadonlyMap<string, Project>): FolderProjectAction {
  if (e.type !== 'folder') return null
  const project = byFolder.get(e.path.normalize('NFC'))
  return project ? { kind: 'open', project } : null
}
