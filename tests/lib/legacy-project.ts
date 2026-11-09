// Projects that builds before 2026-11-09 made on an existing team folder (docs/DECISIONS.md "Projects live only in
// projects/"): they keep working, unchanged, but no route makes one any more (a team project is always a new
// projects/<name>). Suites about what a project does (shared chats, the dev environment, the trash, the AI's context)
// make theirs this way, on the fixture's folders and their rules, as those builds did.
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { API, uuidv7, type Project } from '@mycel/shared/api'

export interface OldProjectInput { name: string; folderPath: string; instructions?: string; id?: string }

/**
 * The projects row as createProject wrote it on an existing folder the creator could write (the folder made on disk
 * when missing), with the rule-less folders row that marked a team folder as a project folder (none under users/).
 * The creator wrote the first instructions. Returns its id.
 */
export function legacyProject(db: Database, team: string, by: string, o: OldProjectInput): string {
  const id = o.id ?? uuidv7()
  const instructions = o.instructions ?? ''
  if (o.folderPath) fs.mkdirSync(path.join(team, ...o.folderPath.split('/')), { recursive: true, mode: 0o700 })
  const personal = o.folderPath === 'users' || o.folderPath.startsWith('users/')
  db.transaction(() => {
    db.query('INSERT INTO projects (id, name, folder_path, instructions, created_by, created_at, instructions_author, instructions_authored) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, o.name, o.folderPath, instructions, by, new Date().toISOString(), by, instructions)
    if (o.folderPath !== '' && !personal && !db.query('SELECT 1 FROM folders WHERE path = ?').get(o.folderPath))
      db.query('INSERT INTO folders (id, path, created_at) VALUES (?,?,?)').run(uuidv7(), o.folderPath, new Date().toISOString())
  })()
  return id
}

/** legacyProject() in a running test server, answered as its creator sees it (GET /api/projects/:id). */
export async function oldProject(h: { ctx: { db: Database }; team: string; api(user: string): { call: (e: typeof API.getProject, a: { params: { id: string } }) => Promise<Project> } }, by: string, o: OldProjectInput): Promise<Project> {
  const id = legacyProject(h.ctx.db, h.team, by, o)
  return h.api(by).call(API.getProject, { params: { id } })
}
