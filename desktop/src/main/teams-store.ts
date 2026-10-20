// teams.json and per-team files in the app's user data folder:
//   <userData>/teams.json                       remembered teams (common/teams.ts)
//   <userData>/teams/<teamId>/permissions.json  the team's in-app browser "allowed sites"
//   <userData>/window.json                      window size and browser pane width
// Writes go to a temp file first, then rename (no half-written file after a crash).
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readTeams, type TeamsFile } from '../common/teams'
import type { SavedPermissions } from '../common/site-permissions'

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function writeAtomic(path: string, text: string) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
}

export class TeamsStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  load(): TeamsFile {
    return readTeams(readText(join(this.dir, 'teams.json')))
  }

  save(f: TeamsFile) {
    writeAtomic(join(this.dir, 'teams.json'), JSON.stringify(f, null, 2))
  }

  newTeamId(): string {
    return randomBytes(8).toString('hex')
  }

  private teamDir(id: string) {
    const d = join(this.dir, 'teams', id.replace(/[^a-f0-9]/g, ''))
    mkdirSync(d, { recursive: true })
    return d
  }

  loadPermissions(id: string): Partial<SavedPermissions> {
    try {
      return JSON.parse(readText(join(this.teamDir(id), 'permissions.json')) ?? '{}')
    } catch {
      return {}
    }
  }

  savePermissions(id: string, p: SavedPermissions) {
    writeAtomic(join(this.teamDir(id), 'permissions.json'), JSON.stringify(p, null, 2))
  }

  removeTeamFiles(id: string) {
    rmSync(join(this.dir, 'teams', id.replace(/[^a-f0-9]/g, '')), { recursive: true, force: true })
  }

  loadWindow(): { width?: number; height?: number; paneFraction?: number } {
    try {
      const v = JSON.parse(readText(join(this.dir, 'window.json')) ?? '{}')
      return typeof v === 'object' && v ? v : {}
    } catch {
      return {}
    }
  }

  saveWindow(v: { width: number; height: number; paneFraction: number }) {
    writeAtomic(join(this.dir, 'window.json'), JSON.stringify(v))
  }
}
