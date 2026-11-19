// srt protects some names in the cwd of a run from writes (.bashrc, .mcp.json, .gitconfig, .vscode, ...). When such a
// name is absent, srt makes an empty file or folder there as a mount point and removes it when the command ends.
// Two problems with one srt process for each run (found on the spike VM and in Docker, 2026-11-04):
//   - a run that is killed (time limit, stop, out of memory) leaves the empty files in the folder;
//   - when two runs share a cwd, the run that ends first removes the mount points, and the deny stops applying in the
//     other run: it can then write .bashrc or .mcp.json in the project (srt's own comment says so too).
// So the runner makes the absent names itself before the first run in a cwd, and removes the ones that are still
// empty when the last run in that cwd ends. srt then sees them as present and never removes them.
import fs from 'node:fs'
import path from 'node:path'

/** srt 0.0.81 DANGEROUS_FILES and getDangerousDirectories() (sandbox-utils.js). Check them at each srt update. */
export const SRT_DENY_FILES = ['.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json']
export const SRT_DENY_DIRS = ['.vscode', '.idea', '.claude/commands', '.claude/agents']

const held = new Map<string, { count: number; made: string[] }>()
/** every path made now for a run (the names of both holders below): what isRunPlaceholder answers for */
const madeNow = new Map<string, number>()
const markMade = (p: string) => madeNow.set(p, (madeNow.get(p) ?? 0) + 1)
const unmark = (p: string) => { const n = (madeNow.get(p) ?? 0) - 1; if (n > 0) madeNow.set(p, n); else madeNow.delete(p) }

/**
 * Is `abs` an empty name this server made for a run that is still going (a protected name srt needs as a mount point,
 * or an empty skills folder), and not something a person has put there? Such a name is on the disk of the team folder
 * while a run lives (a background command or a dev server, for hours): bwrap binds over a path that exists, and a name
 * taken away at once would let the command make it (see the top). It is never shown: not in a folder listing, a search,
 * a "files changed" list or a change notice to the other people of the folder (QA TC-5349). A folder counts only while
 * it holds nothing but such names (.claude with its commands/ and agents/); anything written into it makes it, and
 * what is in it, real.
 */
export function isRunPlaceholder(abs: string): boolean {
  const p = path.resolve(abs)
  if (!madeNow.has(p)) return false
  try {
    const st = fs.lstatSync(p)
    if (st.isFile()) return st.size === 0
    if (!st.isDirectory()) return false
    return fs.readdirSync(p).every((n) => isRunPlaceholder(path.join(p, n)))
  } catch { return false }
}

/** Make the absent names in cwd; returns the release function. Call release once, when the run has ended. */
export function holdPlaceholders(cwd: string): () => void {
  const key = path.resolve(cwd)
  let h = held.get(key)
  if (!h) {
    const made: string[] = []
    const make = (rel: string, dir: boolean) => {
      const p = path.join(key, rel)
      try {
        // never through a link: a run can make .claude a link to a server folder, and mkdir follows a link in the
        // middle of a path
        if (path.dirname(p) !== key && !fs.lstatSync(path.dirname(p)).isDirectory()) return
        if (dir) fs.mkdirSync(p)
        else fs.closeSync(fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644))
        made.push(p)
        markMade(p)
      } catch { /* present already (it is then the person's), or the folder is not writable */ }
    }
    for (const f of SRT_DENY_FILES) make(f, false)
    for (const d of SRT_DENY_DIRS) {
      const parts = d.split('/')
      for (let i = 1; i <= parts.length; i++) make(parts.slice(0, i).join('/'), true)
    }
    h = { count: 0, made }
    held.set(key, h)
  }
  h.count++
  let done = false
  return () => {
    if (done) return
    done = true
    h!.count--
    if (h!.count > 0) return
    held.delete(key)
    // deepest first; only what is still empty (a person may have put content there through the file tools)
    for (const p of [...h!.made].sort((a, b) => b.length - a.length)) {
      unmark(p)
      try {
        const st = fs.lstatSync(p)
        if (st.isFile() && st.size === 0) fs.unlinkSync(p)
        else if (st.isDirectory() && fs.readdirSync(p).length === 0) fs.rmdirSync(p)
      } catch {}
    }
  }
}

const heldSkills = new Map<string, { count: number; made: boolean }>()

/**
 * The skill folders a run must not write (access.ts runSkillFolders, team-relative under `teamRoot`): an absent one is
 * made empty for the run's life, so srt mounts it read-only and a command cannot make it and write a skill there; it
 * goes again when the last run that held it ends, if still empty. Never through a link (the folder above must be a real
 * folder). Returns the release function; call it once, when the run has ended.
 */
export function holdSkillFolders(teamRoot: string, rels: readonly string[]): () => void {
  const keys: string[] = []
  for (const rel of rels) {
    const abs = path.join(teamRoot, ...rel.split('/'))
    let h = heldSkills.get(abs)
    if (!h) {
      let made = false
      try {
        if (fs.lstatSync(path.dirname(abs)).isDirectory()) { fs.mkdirSync(abs, { mode: 0o700 }); made = true; markMade(abs) }
      } catch { /* there already (it is then someone's), or nothing above it to write in */ }
      h = { count: 0, made }
      heldSkills.set(abs, h)
    }
    h.count++
    keys.push(abs)
  }
  let done = false
  return () => {
    if (done) return
    done = true
    for (const k of keys) {
      const h = heldSkills.get(k)
      if (!h || --h.count > 0) continue
      heldSkills.delete(k)
      if (!h.made) continue
      unmark(k)
      try { const st = fs.lstatSync(k); if (st.isDirectory() && fs.readdirSync(k).length === 0) fs.rmdirSync(k) } catch {}
    }
  }
}

/** An empty skills folder this server made for a run (holdSkillFolders), not one a person made: not a group's or a
 * project's skills (runner.ts othersSkillRoots leaves it out). */
export function isSkillPlaceholder(abs: string): boolean {
  if (!heldSkills.get(path.resolve(abs))?.made) return false
  try { return fs.lstatSync(abs).isDirectory() && fs.readdirSync(abs).length === 0 } catch { return false }
}

/** for tests */
export const _held = () => held
export const _heldSkills = () => heldSkills
