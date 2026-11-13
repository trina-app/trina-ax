// Files › Trash as people read it (docs/AGENTS/plan/20261113-1557-trash-ui-tc1040.md, QA TC-1040): each item by its
// name and the place it was in, in the Files sidebar's words (never users/<id>/, groups/, projects/ or shared/); the
// same original path deleted more than once is one row with its copies; one line on how long items stay. What the
// list holds is the server's (GET /api/files/trash: what the person could restore); this only shapes it.
import type { Locale, TrashItem } from '@mycel/shared/api'
import type { FolderWords } from './folderLabels'
import { intlTag } from './format'
import { baseName, parentPath } from './paths'

const DAY = 86_400_000

export interface PlaceWords {
  words: FolderWords
  /** the person's id (their own folder is users/<it>) */
  me: string | null
  /** the projects they can see: a project's folder is named by the project's name */
  projects: readonly { name: string; folderPath: string }[]
  /** "Team folder": an item at the top of the team folder */
  root: string
  /** "My projects": users/<me>/projects, where the person's own projects keep their folders */
  myProjects: string
  /** "Personal": a safe fallback for someone else's users/<id>, which the server never lists (trashVisible: nobody,
   * the owner included, restores into another person's folder); should one come, the id is never shown */
  personal: string
}

const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`)
const rest = (p: string, dir: string) => (p === dir ? [] : p.slice(dir.length + 1).split('/'))

/** A folder (the place an item was in) in the sidebar's words, its parts joined with `sep`: a project's folder by the
 * project's name, the person's own projects as "My projects", their own folder as "My files", the team's top folders
 * by their words; '' is the team folder. */
export function placeWords(dir: string, w: PlaceWords, sep = ' › '): string {
  if (!dir) return w.root
  const project = w.projects
    .filter((p) => under(dir.normalize('NFC'), p.folderPath.normalize('NFC')))
    .sort((a, b) => b.folderPath.length - a.folderPath.length)[0]
  if (project) return [project.name, ...rest(dir.normalize('NFC'), project.folderPath.normalize('NFC'))].join(sep)
  const own = w.me ? `users/${w.me}` : null
  if (own && under(dir, `${own}/projects`)) return [w.myProjects, ...rest(dir, `${own}/projects`)].join(sep)
  const segs = dir.split('/')
  // another person's folder: not listed by the server; a fallback that never shows the id
  if (segs[0] === 'users' && segs.length >= 2 && segs[1] !== w.me) return [w.personal, ...segs.slice(2)].join(sep)
  return w.words.crumbs(dir).map((c) => c.name).join(sep)
}

export type TrashKind = 'file' | 'folder' | 'project'

/** An item's name and where it was: "Hello" · "My projects", "price-sheet.xlsx" · "Company-wide › Sales". */
export function trashPlace(it: Pick<TrashItem, 'originalPath' | 'type'>, w: PlaceWords): { name: string; where: string; kind: TrashKind } {
  const path = it.originalPath
  const folder = it.type === 'folder'
  const project = folder ? w.projects.find((p) => p.folderPath.normalize('NFC') === path.normalize('NFC')) : undefined
  return { name: project?.name ?? baseName(path), where: placeWords(parentPath(path), w), kind: project ? 'project' : folder ? 'folder' : 'file' }
}

export interface TrashGroup {
  /** the original path and kind: one row */
  key: string
  /** its copies, the most recently deleted first; [0] is the one the row shows and its Restore restores */
  items: TrashItem[]
}

const newestFirst = (a: TrashItem, b: TrashItem) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/** The loaded items (every page so far, in the server's order: newest first) as rows: one per original path, in the
 * order of each one's latest delete. A copy on a later page joins the row an earlier page made; an item listed twice
 * (pages that overlap) counts once. */
export function groupTrash(items: readonly TrashItem[]): TrashGroup[] {
  const seen = new Set<string>()
  const groups = new Map<string, TrashItem[]>()
  for (const it of items) {
    if (seen.has(it.id)) continue
    seen.add(it.id)
    const key = `${it.type === 'folder' ? 'd' : 'f'}:${it.originalPath.normalize('NFC')}`
    const list = groups.get(key)
    if (list) list.push(it)
    else groups.set(key, [it])
  }
  return [...groups].map(([key, list]) => ({ key, items: list.sort(newestFirst) })).sort((a, b) => newestFirst(a.items[0]!, b.items[0]!))
}

/** One page more: the items after the ones already loaded (an item already there is not added again). */
export function mergePage(cur: readonly TrashItem[], page: readonly TrashItem[]): TrashItem[] {
  const have = new Set(cur.map((x) => x.id))
  return [...cur, ...page.filter((x) => !have.has(x.id))]
}

/** "Deleted by me / Everyone" is offered only to someone whose list (Everyone) has items another person (or the AI)
 * deleted: an owner or admin, or a member who shares a folder with others. */
export const showWhoSwitch = (everyone: readonly TrashItem[], me: string | null | undefined) => everyone.some((it) => !me || it.deletedBy?.id !== me)

/** The team's retention as the latest delete was given it (deleted at → removed for good), in whole days; null with
 * no items. Each item keeps the date it was given when deleted (docs/DECISIONS.md B-W25-2), so this is what a delete
 * now gets unless the setting changed since. */
export function retentionDays(items: readonly TrashItem[]): number | null {
  const latest = [...items].sort(newestFirst)[0]
  if (!latest) return null
  const d = Math.round((Date.parse(latest.purgeAt) - Date.parse(latest.deletedAt)) / DAY)
  return d >= 1 ? d : null
}

/** When an item is removed for good, short and relative: "in 18 days", "in 5 hours" (always a number, never
 * "tomorrow"); the full date goes in the tooltip. */
export function purgeIn(purgeAt: string, locale: Locale, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(intlTag(locale), { numeric: 'always' })
  const ms = Math.max(0, Date.parse(purgeAt) - now)
  if (ms >= DAY) return rtf.format(Math.round(ms / DAY), 'day')
  if (ms >= 3_600_000) return rtf.format(Math.round(ms / 3_600_000), 'hour')
  return rtf.format(Math.max(1, Math.round(ms / 60_000)), 'minute')
}
