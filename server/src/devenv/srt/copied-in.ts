// What the server copied into a shared chat's work folder, per chat and workspace key (docs/AGENTS/plan/
// 20261121-0615-chat-places-as-paths.md, review must-fix 5). A copy (devenv/work-write.ts writeIntoWork) brings what
// it copied from (team folders, a person's folder, a chat's files) into a folder that every later run of the same
// people reads. So the copy's read group {c: who saw the chat, s: its sources} is kept here, in a server-only file next
// to the work folders (<base>/devenv/copied-in/<chat>/<key>.json; the whole base folder is hidden from every run), and
// every later run or read on that key records the same groups again into its own answer (runner.ts noteSharedRun,
// noteCopiedIn), so an answer made from the copy a day later still carries them. A new key (the people changed) has no
// record: its folder is new and empty.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ReadSource } from '../../chat/read-scope'
import { SAFE_ID_RE, devenvPaths } from './config'

/** One copy's read group: the people who saw the chat when it was copied in, and what it was copied from. */
export interface CopiedGroup { c: string[]; s: ReadSource[] }

/** groups (distinct audiences) kept for one key at most (a copy past it is refused: never a record that forgets) */
export const COPIED_GROUPS_MAX = 500

const isSource = (v: unknown): v is ReadSource => !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string'
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** The record file of a shared chat's work folder (`workRoot`, as sharedWork names it: work-shared/<chat>/<key>), or
 * null when the path is not one. */
export function copiedInFile(base: string, chatId: string, workRoot: string): string | null {
  const key = path.basename(workRoot)
  if (!SAFE_ID_RE.test(chatId) || !SAFE_ID_RE.test(key) || path.dirname(workRoot) !== path.join(devenvPaths(base).workShared, chatId)) return null
  return path.join(devenvPaths(base).copiedIn, chatId, `${key}.json`)
}

/** The groups copied into this work folder. Throws when a record is there but cannot be read (the caller fails
 * closed: a run that cannot re-record them does not start). */
export function readCopiedIn(base: string, chatId: string, workRoot: string): CopiedGroup[] {
  const file = copiedInFile(base, chatId, workRoot)
  if (!file) return []
  let text: string
  try { text = fs.readFileSync(file, 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('the record of what was copied into the work folder cannot be read')
  }
  const v = JSON.parse(text) as unknown
  if (!Array.isArray(v)) throw new Error('the record of what was copied into the work folder is damaged')
  return v.map((g) => {
    const { c, s } = (g ?? {}) as { c?: unknown; s?: unknown }
    if (!isStrings(c) || !Array.isArray(s) || !s.every(isSource)) throw new Error('the record of what was copied into the work folder is damaged')
    return { c, s }
  })
}

const peopleKey = (c: readonly string[]) => JSON.stringify([...new Set(c)].sort())
const sourceKey = (x: ReadSource) => JSON.stringify(x)

/** Add a copy's group to the record (atomically). Copies for the same people share one group, its sources joined: an
 * answer records groups of one audience as one anyway (chat/turn.ts noteSharedReads), so nothing is lost, and a chat
 * that copies often never meets the cap (it counts distinct audiences). Throws when it cannot be written. */
export function addCopiedIn(base: string, chatId: string, workRoot: string, group: CopiedGroup): void {
  const file = copiedInFile(base, chatId, workRoot)
  if (!file) throw new Error('not a shared chat\'s work folder')
  const now = readCopiedIn(base, chatId, workRoot)
  const c = [...new Set(group.c)].sort()
  const at = now.findIndex((x) => peopleKey(x.c) === peopleKey(c))
  let next: CopiedGroup[]
  if (at >= 0) {
    const have = new Set(now[at]!.s.map(sourceKey))
    const add = group.s.filter((x) => { const k = sourceKey(x); if (have.has(k)) return false; have.add(k); return true })
    if (!add.length) return
    next = now.map((x, i) => (i === at ? { c: x.c, s: [...x.s, ...add] } : x))
  } else {
    if (now.length >= COPIED_GROUPS_MAX) throw new Error('too many copies into this work folder are recorded')
    next = [...now, { c, s: [...new Map(group.s.map((x) => [sourceKey(x), x])).values()] }]
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
  fs.renameSync(tmp, file)
}

/** A chat is purged: its records go (runner.ts forgetChatWork). */
export function forgetCopiedIn(base: string, chatId: string): void {
  if (!SAFE_ID_RE.test(chatId)) return
  try { fs.rmSync(path.join(devenvPaths(base).copiedIn, chatId), { recursive: true, force: true }) } catch {}
}
