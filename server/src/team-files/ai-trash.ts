// The AI's delete_files (chat/delete-files.ts, docs/DECISIONS.md "AI가 휴지통으로 옮기기"): the walk that counts what one
// call would put in the trash (it stops at the cap, never at a silent limit like treeSize), and the manifest the
// person's yes on the card is bound to. TeamFiles.planAiTrash builds the plan before the card; TeamFiles.remove checks
// each item against it around moveIntoTrash, in one synchronous block.
import fs from 'node:fs'
import path from 'node:path'
import { DELETE_FILES_MAX } from '@mycel/shared'
import { inSkills } from '../skills/guard'

/** At most this many entries per call: the listed items and everything inside them, folders included. */
export const AI_TRASH_MAX_ENTRIES = DELETE_FILES_MAX

/**
 * One entry the card counted: its path below the listed item ('' for the item itself), what it is, and who it is on
 * disk. A folder keeps no size or time: moving a folder into the trash rewrites its '..' entry, which some file systems
 * count as a change of the folder; its entries are compared one by one instead, so an entry added, removed, renamed or
 * replaced inside it still shows.
 */
export interface Stamp { rel: string; kind: 'file' | 'dir' | 'link' | 'other'; dev: number; ino: number; size: number; mtimeMs: number }

const stampOf = (rel: string, st: fs.Stats): Stamp => {
  const kind = st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : 'other'
  return { rel, kind, dev: st.dev, ino: st.ino, size: kind === 'dir' ? 0 : st.size, mtimeMs: kind === 'dir' ? 0 : st.mtimeMs }
}

/**
 * Every entry of `abs` and below (the item itself first), hidden ones included (they go to the trash too), without
 * following links, sorted by path. null when there are more than `max` entries: the walk stops there.
 */
export function stampTree(abs: string, max: number): Stamp[] | null {
  const out: Stamp[] = [stampOf('', fs.lstatSync(abs))]
  if (out.length > max) return null
  if (out[0]!.kind !== 'dir') return out
  const todo: string[] = ['']
  while (todo.length) {
    const rel = todo.pop()!
    const dir = rel ? path.join(abs, ...rel.split('/')) : abs
    // read entry by entry: a folder of a million names is not listed whole before the cap stops the walk
    const d = fs.opendirSync(dir)
    try {
      for (let e = d.readSync(); e !== null; e = d.readSync()) {
        const r = rel ? `${rel}/${e.name}` : e.name
        const s = stampOf(r, fs.lstatSync(path.join(dir, e.name)))
        out.push(s)
        if (out.length > max) return null
        if (s.kind === 'dir') todo.push(r)
      }
    } finally { d.closeSync() }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/** The same entries, each the same on disk (a file: same size and modification time too). */
export function sameStamps(a: readonly Stamp[] | null, b: readonly Stamp[]): boolean {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!
    if (x.rel !== y.rel || x.kind !== y.kind || x.dev !== y.dev || x.ino !== y.ino || x.size !== y.size || x.mtimeMs !== y.mtimeMs) return false
  }
  return true
}

const fold = (s: string) => s.normalize('NFC').toLowerCase()

/**
 * A skill root or anything in one, by the path alone, letter case and Unicode form folded: skills/, groups/<g>/skills/,
 * projects/<p>/skills/ (skills/guard.ts inSkills) and a person's own users/<id>/skills/. What people's AI follows
 * changes only with the skill cards; skill deletes come in a later change (docs/DECISIONS.md "AI가 휴지통으로 옮기기").
 */
export function aiSkillPath(rel: string): boolean {
  if (inSkills(rel)) return true
  const segs = rel.split('/')
  return segs.length >= 3 && fold(segs[0]!) === 'users' && fold(segs[2]!) === 'skills'
}

/** A folder that holds a skill root by its path: the team root, groups/, projects/, users/ and each groups/<g>/,
 * projects/<p>/ and users/<id>/ (their skills/ folder is a skill root whether or not it is there now). */
export function holdsSkillRoot(segs: readonly string[]): boolean {
  if (segs.length === 0) return true
  const top = fold(segs[0]!)
  if (top !== 'groups' && top !== 'projects' && top !== 'users') return false
  return segs.length <= 2
}

/** CLAUDE.md, AGENTS.md, GEMINI.md, SKILL.md anywhere: instructions an AI follows (chat/turn.ts instructionLike). */
export const instructionFile = (rel: string) => /^(CLAUDE|AGENTS|GEMINI|SKILL)\.md$/i.test(rel.split('/').at(-1) ?? '')

/** An item moved out of its place into the trash storage that could neither go back nor get a trash row (a double fault:
 * TeamFiles.remove). Not lost: the server log has `storage`, where an admin finds it. */
export class TrashStranded extends Error {
  constructor(readonly rel: string, readonly storage: string) { super(`'${rel}' left its place but could not be recorded in the trash`) }
}

/** An exact refusal for the AI (English: the AI reads it, then tells the person in their language). */
export class AiTrashChanged extends Error {
  constructor(readonly rel: string) { super(`'${rel}' changed after the card was shown`) }
}
