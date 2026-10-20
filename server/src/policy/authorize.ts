// THE permission function. Every tool and every human file API goes through authorize().
import fs from 'node:fs'
import path from 'node:path'
import { atLeast, type Principal, type RuleSet } from './access'
import { Denied, ToolError } from './errors'
import { badSegment, foldKey, hiddenEntry } from './names'
import { parseInput, realpathCheck, walk } from './resolve'

export type Op = 'read' | 'write' | 'list'

export interface FsCtx { root: string; caseInsensitive: boolean }

export interface Authorized {
  /** actual on-disk names (existing part + new names to create) */
  segs: string[]
  rel: string
  abs: string
  exists: boolean
  /** number of leading segments that exist */
  existing: number
  st?: fs.Stats
}

const hidden = (input: unknown) => `not found or no access: '${typeof input === 'string' ? input : ''}'`

export function authorize(fx: FsCtx, rules: RuleSet, user: Principal, input: unknown, op: Op,
  opts: { mustExist?: boolean; createDirs?: boolean } = {}): Authorized {
  const mustExist = opts.mustExist ?? op !== 'write'
  const segs = parseInput(input)
  const w = walk(fx.root, segs, fx.caseInsensitive)
  const full = [...w.actual, ...w.missing]

  // permission is decided on the actual names (plus not-yet-existing names as typed)
  const acc = rules.access(user, full)
  if (op === 'list') { if (!rules.canList(user, full)) throw new Denied(hidden(input)) }
  else if (op === 'read' && !atLeast(acc, 'read')) throw new Denied(hidden(input))
  else if (op === 'write' && !atLeast(acc, 'write')) {
    if (atLeast(acc, 'read') && w.missing.length === 0) throw new Denied(`read-only: you cannot change '${full.join('/')}'`)
    throw new Denied(atLeast(acc, 'read') ? `read-only folder: you cannot create files in '${full.slice(0, -1).join('/')}'` : hidden(input))
  }
  if (w.problem) throw new Denied(w.problem)

  const exists = w.missing.length === 0
  if (!exists) {
    if (mustExist) throw new ToolError(`not found: '${full.join('/')}'`, 'not_found')
    if (w.missing.length > 1 && !opts.createDirs) throw new ToolError(`folder does not exist: '${full.slice(0, -1).join('/')}'`, 'not_found')
    if (!w.st.isDirectory()) throw new Denied(`not a folder: '${w.actual.join('/')}'`)
    // refuse creating a sibling that differs from an existing entry only by case / Unicode form / width
    const parent = path.join(fx.root, ...w.actual)
    const k = foldKey(w.missing[0])
    const clash = fs.readdirSync(parent).find((n) => n !== w.missing[0] && foldKey(n) === k)
    if (clash) throw new Denied(`'${clash}' already exists with almost the same name; use that name or pick a clearly different one`)
  }
  realpathCheck(fx.root, w.actual)
  return { segs: full, rel: full.join('/'), abs: path.join(fx.root, ...full), exists, existing: w.actual.length, st: exists ? w.st : undefined }
}

/** Check a path produced by the server itself (e.g. a ripgrep result, already actual names) without the walk. */
export function visiblePath(fx: FsCtx, rules: RuleSet, user: Principal, rel: string): fs.Stats | null {
  const segs = rel.split('/')
  if (segs.some((s, i) => badSegment(s) !== null || hiddenEntry(s, i))) return null
  if (!atLeast(rules.access(user, segs), 'read')) return null
  try {
    const st = fs.lstatSync(path.join(fx.root, ...segs))
    if (!st.isFile() || st.nlink > 1) return null
    return st
  } catch { return null }
}
