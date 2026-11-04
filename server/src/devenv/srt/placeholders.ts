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

/** Make the absent names in cwd; returns the release function. Call release once, when the run has ended. */
export function holdPlaceholders(cwd: string): () => void {
  const key = path.resolve(cwd)
  let h = held.get(key)
  if (!h) {
    const made: string[] = []
    const make = (rel: string, dir: boolean) => {
      const p = path.join(key, rel)
      try {
        if (dir) fs.mkdirSync(p)
        else fs.closeSync(fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644))
        made.push(p)
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
      try {
        const st = fs.lstatSync(p)
        if (st.isFile() && st.size === 0) fs.unlinkSync(p)
        else if (st.isDirectory() && fs.readdirSync(p).length === 0) fs.rmdirSync(p)
      } catch {}
    }
  }
}

/** for tests */
export const _held = () => held
