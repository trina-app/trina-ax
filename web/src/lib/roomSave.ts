// "Save to team folder" on a room file (components/rooms/SaveToTeamSheet.tsx, docs/decisions/20261117-room-file-save-btn.md):
// what the sheet starts with and what a refusal says, pure and unit-tested (test/unit/room-save.test.ts).
import type { RoomSavePlan } from '@mycel/shared/api'
import { ApiError } from './api'

/** The folder the sheet starts with: the server's suggestion (by name, or a recent folder), none for a file that looks
 * personal. */
export function startFolder(plan: Pick<RoomSavePlan, 'suggestion' | 'sensitive'>): { path: string; why: 'suggested' | 'recent'; outside: number } | null {
  if (plan.sensitive || !plan.suggestion) return null
  return plan.suggestion
}

/** The files the save is for: those of the message not in the team folder yet. */
export const filesToSave = (plan: Pick<RoomSavePlan, 'files'>) => plan.files.filter((f) => !f.savedPath)

/** The last part of a team path, for the chip's "In team folder · <folder>" (the whole path in its tooltip). */
export function folderOfPath(path: string, words: { path: (p: string, sep?: string) => string }): { short: string; full: string } {
  const dir = path.slice(0, Math.max(0, path.lastIndexOf('/')))
  const full = words.path(dir, ' › ')
  const parts = full.split(' › ')
  return { short: parts[parts.length - 1] || full, full }
}

/** The message key for a save the server refused for a reason the sheet can explain; null: the server's own words. */
export function saveRefusalKey(e: unknown): 'rooms.save.skillsFolder' | 'rooms.save.badName' | 'rooms.save.tooLarge' | null {
  if (!(e instanceof ApiError)) return null
  const reason = e.body.params?.reason
  if (reason === 'skills_folder') return 'rooms.save.skillsFolder'
  if (reason === 'instruction_file') return 'rooms.save.badName'
  if (reason === 'too_large' || e.status === 413) return 'rooms.save.tooLarge'
  return null
}
