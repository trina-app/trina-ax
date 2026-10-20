// Path parsing and the actual-name walk (design tab 2, rules 1-4).
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import { badSegment, hiddenEntry, MAX_DEPTH, MAX_PATH_CHARS } from './names'
import { Denied } from './errors'

/** Split a tool-supplied path into segments, rejecting anything that is not a plain relative path. */
export function parseInput(input: unknown): string[] {
  if (input === undefined || input === null) return []
  if (typeof input !== 'string') throw new Denied('path must be a string')
  if (input.length > MAX_PATH_CHARS) throw new Denied('path too long')
  if (input.includes('\0')) throw new Denied('NUL character in path')
  if (input.includes('\\')) throw new Denied('backslashes are not allowed in paths; use "/"')
  if (/^\s*[\/~]/.test(input) || /^[a-zA-Z]:/.test(input) || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input))
    throw new Denied('only paths relative to the team folder are allowed (no absolute paths, ~ or URLs)')
  const segs = input.split('/').filter((s) => s !== '' && s !== '.')
  if (segs.length > MAX_DEPTH) throw new Denied('path is too deep')
  for (const s of segs) {
    if (s === '..') throw new Denied("'..' is not allowed")
    const bad = badSegment(s)
    if (bad) throw new Denied(bad)
  }
  if (segs[0] === PRODUCT.systemDir) throw new Denied('not found or no access')
  return segs
}

export interface Walk {
  /** actual on-disk names of the existing prefix */
  actual: string[]
  /** input segments that do not exist yet (after `actual`) */
  missing: string[]
  /** lstat of the deepest existing entry (the root when actual is empty) */
  st: fs.Stats
  /** policy problem found on the way (symlink, ambiguity, not a folder) — reported only if the user may see the area */
  problem?: string
}

const nfc = (s: string) => s.normalize('NFC')

/** Walk the input segments one by one, matching each to the entry that actually exists in that folder.
 * Exact name first; then the same name in another Unicode normalization form; on case-insensitive file
 * systems also a case-only difference. More than one candidate = ambiguous = refused. Every step is lstat'ed
 * and symbolic links are refused. */
export function walk(root: string, segs: string[], caseInsensitive: boolean): Walk {
  const actual: string[] = []
  let cur = root
  let st = fs.lstatSync(root)
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    let names: string[]
    try { names = fs.readdirSync(cur) } catch (e: any) { return { actual, missing: segs.slice(i), st, problem: `cannot open folder (${e.code})` } }
    let match: string | undefined
    if (names.includes(seg)) match = seg
    else {
      let c = names.filter((n) => nfc(n) === nfc(seg))
      if (c.length === 0 && caseInsensitive) c = names.filter((n) => nfc(n).toLowerCase() === nfc(seg).toLowerCase())
      if (c.length > 1) return { actual, missing: segs.slice(i), st, problem: `ambiguous name '${seg}': several entries differ only by case or Unicode form` }
      match = c[0]
    }
    if (match === undefined || hiddenEntry(match, i)) return { actual, missing: segs.slice(i), st }
    if (badSegment(match)) return { actual, missing: segs.slice(i), st, problem: 'name not allowed' }
    const next = path.join(cur, match)
    st = fs.lstatSync(next)
    if (st.isSymbolicLink()) return { actual: [...actual, match], missing: segs.slice(i + 1), st, problem: `symbolic links are not followed: ${[...actual, match].join('/')}` }
    actual.push(match)
    cur = next
    if (i < segs.length - 1 && !st.isDirectory()) return { actual, missing: segs.slice(i + 1), st, problem: `not a folder: ${actual.join('/')}` }
  }
  return { actual, missing: [], st }
}

/** realpath of the existing prefix must be exactly root + actual names (catches anything lstat missed). */
export function realpathCheck(root: string, actual: string[]) {
  const expected = path.join(root, ...actual)
  let real: string
  try { real = fs.realpathSync(expected) } catch { throw new Denied('path changed while checking it') }
  if (real !== expected) throw new Denied('path resolves outside the expected location')
}

/** lstat every component again (used right before rename/unlink). */
export function verifyChain(root: string, actual: string[], lastMayBeMissing = false) {
  let cur = root
  for (let i = 0; i < actual.length; i++) {
    cur = path.join(cur, actual[i])
    let st: fs.Stats
    try { st = fs.lstatSync(cur) } catch (e: any) {
      if (lastMayBeMissing && i === actual.length - 1 && e.code === 'ENOENT') return
      throw new Denied('path changed while writing')
    }
    if (st.isSymbolicLink()) throw new Denied('path changed while writing (symbolic link)')
    if (i < actual.length - 1 && !st.isDirectory()) throw new Denied('path changed while writing')
  }
}

/** Probe whether the file system under `dir` folds case (macOS/Windows default) */
export function detectCaseInsensitive(dir: string): boolean {
  const name = `${PRODUCT.tmpPrefix}CaseProbe-${process.pid}-${Date.now()}`
  const p = path.join(dir, name)
  fs.writeFileSync(p, '')
  try { return fs.existsSync(path.join(dir, name.toLowerCase())) } finally { fs.rmSync(p, { force: true }) }
}
