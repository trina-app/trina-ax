// Folders a tool makes again by itself (docs/DECISIONS.md "Disk: what is kept and what goes"). One rule for two jobs:
// the team backups leave them out (system/backup.ts: a project's node_modules was most of a 1.8 GB daily archive), and
// the dev environment's clean-up removes them from the work folder of a chat that has been idle (system/devenv-clean.ts).
//
// Only names that no person writes into on purpose: node_modules, .next, .turbo, .svelte-kit, .parcel-cache,
// __pycache__, and a virtual environment (.venv / venv, recognised by the pyvenv.cfg inside it). NOT dist, build, out,
// .cache or .git: those can be the result a person asked for, or history. A person's own folder with one of these names
// still goes by the name; the cost of a restore is `npm install` again, never a lost file of theirs.
import fs from 'node:fs'
import path from 'node:path'

export const REGENERABLE_NAMES: ReadonlySet<string> = new Set(['node_modules', '.next', '.turbo', '.svelte-kit', '.parcel-cache', '__pycache__'])
const VENV_NAMES: ReadonlySet<string> = new Set(['.venv', 'venv'])

/** Is the folder `abs` (named `name`) one that its tool makes again? */
export function isRegenerableDir(name: string, abs: string): boolean {
  if (REGENERABLE_NAMES.has(name)) return true
  if (VENV_NAMES.has(name)) { try { return fs.statSync(path.join(abs, 'pyvenv.cfg')).isFile() } catch { return false } }
  return false
}

/** The folders a team backup (and an archive of the team) leaves out, as walkTree options. */
export const backupWalk = { exclude: ['.system/backups'], skipDir: isRegenerableDir }
