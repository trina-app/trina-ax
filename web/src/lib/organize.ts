// The setup's folder plan as the person edits it (docs/DECISIONS.md "Setup 팀 파일: the AI proposes folders";
// components/onboarding/OrganizeFiles.tsx): the rows the plan moves, grouped by folder; a row's folder changed or the
// row taken out (the file stays where it was uploaded); a new folder named inline; at most ORGANIZE_LIMITS.folders
// folders. Pure, so the rules are tested without a screen.
import type { z } from 'zod'
import { ORGANIZE_LIMITS, cleanFolderName, type CreateProjectBody, type OrganizeApplied, type OrganizePlan, type TeamFileReason } from '@mycel/shared/api'

export interface OrgRow { path: string; name: string; folder: string; reason: TeamFileReason | null; form: boolean }
export interface OrgEdit {
  /** the rows the plan moves (taken-out rows are in `removed`) */
  rows: OrgRow[]
  removed: string[]
  /** the folders in the order the list shows them (the plan's, then those the person made) */
  folders: string[]
  /** the folders in shared/ now: everything else is made at apply */
  existing: string[]
}

const fold = (s: string) => s.normalize('NFC').toLowerCase()
const same = (a: string, b: string) => fold(a) === fold(b)
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)

/** The list a plan opens with: the rows that move, in the plan's folder order. */
export function editFromPlan(plan: Pick<OrganizePlan, 'rows' | 'folders' | 'existing'>): OrgEdit {
  const rows = plan.rows.filter((r): r is typeof r & { folder: string } => !!r.folder).map((r) => ({ path: r.path, name: baseOf(r.path), folder: r.folder, reason: r.reason, form: r.form }))
  return { rows, removed: [], folders: [...plan.folders], existing: [...plan.existing] }
}

/** The rows still in the list. */
export const kept = (e: OrgEdit) => e.rows.filter((r) => !e.removed.includes(r.path))

/** The folders with their rows, in list order; a folder with no row left is not shown. `isNew`: made at apply. */
export function groupsOf(e: OrgEdit): { folder: string; isNew: boolean; rows: OrgRow[] }[] {
  const rows = kept(e)
  return e.folders.map((folder) => ({ folder, isNew: isNew(e, folder), rows: rows.filter((r) => same(r.folder, folder)) })).filter((g) => g.rows.length > 0)
}

export const isNew = (e: OrgEdit, folder: string) => !e.existing.some((x) => same(x, folder))

/** The folders a row can go to: the list's folders that have rows, then the other existing ones. */
export function choicesOf(e: OrgEdit): string[] {
  const used = groupsOf(e).map((g) => g.folder)
  return [...used, ...e.existing.filter((x) => !used.some((u) => same(u, x)))]
}

/** How many folders the plan uses now (the cap counts these). */
export const folderCount = (e: OrgEdit) => groupsOf(e).length

/** A row into another folder (one the list has, an existing one, or a name the person typed). */
export function setFolder(e: OrgEdit, path: string, folder: string): OrgEdit {
  const name = cleanFolderName(folder)
  if (!name) return e
  const target = e.folders.find((f) => same(f, name)) ?? e.existing.find((f) => same(f, name)) ?? name
  const known = e.folders.some((f) => same(f, target))
  if (!known && folderCount(e) >= ORGANIZE_LIMITS.folders && !groupsOf(e).some((g) => g.rows.length === 1 && g.rows[0]!.path === path)) return e
  return { ...e, folders: known ? e.folders : [...e.folders, target], rows: e.rows.map((r) => (r.path === path ? { ...r, folder: target } : r)) }
}

/** A free name for a new folder ("새 폴더", "새 폴더 2", …). */
export function freeFolderName(e: OrgEdit, base: string): string {
  const taken = (n: string) => [...e.folders, ...e.existing].some((f) => same(f, n))
  if (!taken(base)) return base
  for (let i = 2; ; i++) if (!taken(`${base} ${i}`)) return `${base} ${i}`
}

/** A row into a new folder of its own; null when the plan has its most folders already. */
export function newFolderFor(e: OrgEdit, path: string, base: string): OrgEdit | null {
  const alone = groupsOf(e).some((g) => g.rows.length === 1 && g.rows[0]!.path === path)
  if (folderCount(e) >= ORGANIZE_LIMITS.folders && !alone) return null
  return setFolder(e, path, freeFolderName(e, base))
}

/** A new folder's name typed inline: every row of it follows; a name of another folder merges them. Only a folder the
 * plan makes can be renamed (an existing one is there already). */
export function renameFolder(e: OrgEdit, from: string, to: string): OrgEdit {
  const name = cleanFolderName(to)
  if (!name || !isNew(e, from) || same(from, name) && from === name) return e
  const target = e.folders.find((f) => !same(f, from) && same(f, name)) ?? e.existing.find((f) => same(f, name)) ?? name
  const folders = e.folders.flatMap((f) => (same(f, from) ? (e.folders.some((x) => !same(x, from) && same(x, target)) ? [] : [target]) : [f]))
  return { ...e, folders, rows: e.rows.map((r) => (same(r.folder, from) ? { ...r, folder: target } : r)) }
}

/** A row taken out: the file stays where it was uploaded. */
export const removeRow = (e: OrgEdit, path: string): OrgEdit => ({ ...e, removed: [...new Set([...e.removed, path])] })

/** What [이대로 정리] sends. */
export const movesOf = (e: OrgEdit) => kept(e).map((r) => ({ from: r.path, folder: r.folder }))

/** The files a project question names, where they are after the moves (a file that did not move is where it was; one
 * the person took out of the list is still asked about: it is the same group of files). */
export function projectPaths(paths: readonly string[], applied: OrganizeApplied): string[] {
  const to = new Map(applied.moved.map((m) => [m.from, m.to]))
  return paths.map((p) => to.get(p) ?? p)
}

/** The project the question makes: a team project named as the AI said, with the setup's team group as participant (a
 * project's contents are its members'; without the group, people who join later would not see it). */
export function projectBody(name: string, teamGroupId: string | null): z.input<typeof CreateProjectBody> {
  return { name, scope: 'team', participants: teamGroupId ? [{ subjectType: 'group', subjectId: teamGroupId }] : [], instructions: '' }
}
