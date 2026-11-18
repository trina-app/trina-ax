// "Save to team folder" on a room file (components/rooms/SaveToTeamSheet.tsx, docs/decisions/20261117-room-file-save-btn.md):
// what the sheet starts with and what a refusal says, pure and unit-tested (test/unit/room-save.test.ts).
import type { RoomSavePlan, RoomSaveResult } from '@mycel/shared/api'
import { ApiError } from './api'

type PlanFiles = Pick<RoomSavePlan, 'files'>

/** The files the save is for: those of the message not in the team folder yet. */
export const filesToSave = (plan: PlanFiles) => plan.files.filter((f) => !f.savedPath)

/** Every file still to save looks personal (an ID, a bank book, a named person's contract …). */
const allPersonal = (plan: PlanFiles) => { const todo = filesToSave(plan); return todo.length > 0 && todo.every((f) => f.sensitive) }
/** Some files still to save look personal and some do not: the personal ones start unticked. */
export const somePersonal = (plan: PlanFiles) => { const todo = filesToSave(plan); return todo.some((f) => f.sensitive) && !allPersonal(plan) }

/** The folder the sheet starts with: the server's suggestion (by name, or a recent folder) for the ordinary files; none
 * when every file to save looks personal. */
export function startFolder(plan: Pick<RoomSavePlan, 'files' | 'suggestion' | 'sensitive'>): { path: string; why: 'suggested' | 'recent'; outside: number } | null {
  if (!plan.suggestion || allPersonal(plan)) return null
  return plan.suggestion
}

/** The files ticked when the sheet opens: every file to save, except that among ordinary ones a personal-looking file
 * starts unticked (QA 11-17: one bank book no longer takes the suggestion from the others, so it must not ride along
 * into the suggested folder unasked). A copy of another file (`sameAs`) has no tick of its own: it follows that file. */
export function startTicks(plan: Pick<RoomSavePlan, 'files' | 'sensitive'>): Set<string> {
  const mixed = somePersonal(plan)
  return new Set(filesToSave(plan).filter((f) => leaderOf(plan, f) === f.id && !(mixed && f.sensitive)).map((f) => f.id))
}

/** The file whose tick a file follows: the earlier file it is a copy of, when that one is still to save; else itself. */
export function leaderOf(plan: PlanFiles, f: RoomSavePlan['files'][number]): string {
  return f.sameAs && filesToSave(plan).some((x) => x.id === f.sameAs) ? f.sameAs : f.id
}

/** The ids sent for `ticked`: each ticked file and the copies of it. */
export const idsToSend = (plan: PlanFiles, ticked: ReadonlySet<string>) => filesToSave(plan).filter((f) => ticked.has(leaderOf(plan, f))).map((f) => f.id)

/** What a save did, for an honest toast: `same` files were the same bytes as another of this save (one copy for them). */
export function saveSummary(saved: RoomSaveResult['saved']): { same: number } {
  return { same: saved.length - new Set(saved.map((s) => s.path)).size }
}

/** The last part of a team path, for the chip's "In team folder · <folder>" (the whole path in its tooltip). */
export function folderOfPath(path: string, words: { path: (p: string, sep?: string) => string }): { short: string; full: string } {
  const dir = path.slice(0, Math.max(0, path.lastIndexOf('/')))
  const full = words.path(dir, ' › ')
  const parts = full.split(' › ')
  return { short: parts[parts.length - 1] || full, full }
}

/** The message key for a save the server refused for a reason the sheet can explain; null: the server's own words. */
export function saveRefusalKey(e: unknown): 'rooms.save.skillsFolder' | 'rooms.save.badName' | 'rooms.save.tooLarge' | 'rooms.save.held' | null {
  if (!(e instanceof ApiError)) return null
  const reason = e.body.params?.reason
  if (reason === 'skills_folder') return 'rooms.save.skillsFolder'
  if (reason === 'instruction_file') return 'rooms.save.badName'
  if (reason === 'too_large' || e.status === 413) return 'rooms.save.tooLarge'
  if (reason === 'quarantined') return 'rooms.save.held'
  return null
}
