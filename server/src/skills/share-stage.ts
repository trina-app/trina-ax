// Where a share proposal's kept files wait until [팀에 공유] (docs/DECISIONS.md "K — 내 스킬 가져오기"): the server's
// data folder, <data>/skill-shares/<share id>/, OUTSIDE the team files, so nothing shows in Files, reaches a search or
// a chat, or is read by anyone's AI before the person applies it. Folders 0700, files 0600. Layout:
//   skills/<candidate name>/<path inside the skill folder>   the kept files (never a script's content, never a skill
//                                                            with a secret: share-check.ts drops those first)
//   rule.md                                                 CLAUDE.md with the lines that carry a secret left out
// Removed on apply (once everything went through), dismiss and expiry; folders without an open share are swept.
import fs from 'node:fs'
import path from 'node:path'
import { SKILL_SHARE_LIMITS } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { RuleInput, StagedFile } from './share-check'

type Ctx = Pick<AppContext, 'config'>
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RULE = 'rule.md'

export const stageRoot = (ctx: Ctx) => path.join(ctx.config.dataDir, 'skill-shares')
export function stageDir(ctx: Ctx, id: string): string {
  if (!ID.test(id)) throw new Error('not a share id')
  return path.join(stageRoot(ctx), id)
}

/** `rel` inside `dir`, or an error when it would leave it (the paths were checked before; this holds whatever comes). */
function inside(dir: string, ...rel: string[]): string {
  const abs = path.resolve(dir, ...rel)
  if (!abs.startsWith(dir + path.sep)) throw new Error('outside the staging folder')
  return abs
}

/** Write a share's kept files and its CLAUDE.md; a share id is written once (`wx`: nothing replaced). */
export function writeStage(ctx: Ctx, id: string, files: ReadonlyMap<string, readonly StagedFile[]>, rule: RuleInput | null): void {
  const dir = stageDir(ctx, id)
  fs.mkdirSync(stageRoot(ctx), { recursive: true, mode: 0o700 })
  fs.mkdirSync(dir, { mode: 0o700 })
  for (const [name, list] of files) {
    for (const f of list) {
      const abs = inside(dir, 'skills', name, ...f.path.split('/'))
      fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 })
      fs.writeFileSync(abs, f.data, { mode: 0o600, flag: 'wx' })
    }
  }
  if (rule) fs.writeFileSync(inside(dir, RULE), rule.text, { mode: 0o600, flag: 'wx' })
}

function readCapped(abs: string, max: number): Buffer | null {
  try {
    const st = fs.lstatSync(abs)
    if (!st.isFile() || st.size > max) return null
    return fs.readFileSync(abs)
  } catch { return null }
}

/** One kept file of a candidate, or null (gone, or not a plain file). */
export function readStaged(ctx: Ctx, id: string, name: string, rel: string): Buffer | null {
  return readCapped(inside(stageDir(ctx, id), 'skills', name, ...rel.split('/')), SKILL_SHARE_LIMITS.fileBytes * 4)
}

/** Every kept file of a candidate in the listed order, or null when one of them is gone. */
export function readStagedFiles(ctx: Ctx, id: string, name: string, files: readonly { path: string }[]): StagedFile[] | null {
  const out: StagedFile[] = []
  for (const f of files) {
    const data = readStaged(ctx, id, name, f.path)
    if (!data) return null
    out.push({ path: f.path, data })
  }
  return out
}

/** The CLAUDE.md the AI reads, or null. */
export function readStagedRule(ctx: Ctx, id: string): string | null {
  return readCapped(inside(stageDir(ctx, id), RULE), SKILL_SHARE_LIMITS.ruleInBytes * 4)?.toString('utf8') ?? null
}

export function removeStage(ctx: Ctx, id: string): void {
  try { fs.rmSync(stageDir(ctx, id), { recursive: true, force: true }) } catch { /* gone */ }
}

/** The share ids that have a staging folder. */
export function stagedIds(ctx: Ctx): string[] {
  try { return fs.readdirSync(stageRoot(ctx)).filter((n) => ID.test(n)) } catch { return [] }
}
