// Projects that builds before 2026-11-09 made on an existing team folder (docs/DECISIONS.md "Projects live only in
// projects/"): they keep working, unchanged, but no route makes one any more (a team project is always a new
// projects/<name>). Suites about what a project does (shared chats, the dev environment, the trash, the AI's context)
// make theirs this way, on the fixture's folders and their rules, as those builds did.
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { API, uuidv7, type Project } from '@mycel/shared/api'
import { isZoneTop } from '../../server/src/policy/access'
import { setFolderAccess } from './folder-access'

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
    // a project's folder in projects/ is limited since folder access adds up (the conversion limits every one)
    const row = db.query('SELECT id, limited FROM folders WHERE path = ?').get(o.folderPath) as { id: string; limited: number } | null
    if (row && !row.limited && isZoneTop(o.folderPath)) setFolderAccess(db, row.id, (db.query('SELECT subject_type AS subjectType, subject_id AS subjectId, access FROM folder_rules WHERE folder_id = ?').all(row.id) as OldFolderRule[]).filter((r) => r.access !== 'none'), by, { limited: true })
  })()
  return id
}

/** legacyProject() in a running test server, answered as its creator sees it (GET /api/projects/:id). */
export async function oldProject(h: { ctx: { db: Database }; team: string; api(user: string): { call: (e: typeof API.getProject, a: { params: { id: string } }) => Promise<Project> } }, by: string, o: OldProjectInput): Promise<Project> {
  const id = legacyProject(h.ctx.db, h.team, by, o)
  return h.api(by).call(API.getProject, { params: { id } })
}

export interface OldFolderRule { subjectType: 'everyone' | 'role' | 'group' | 'user'; subjectId: string | null; access: 'none' | 'read' | 'write' }

/**
 * A folder at or inside projects/<name> with its rules, as builds before "Project contents only for members" let an
 * admin make one in Admin › Folder permissions (that screen refuses it now: a project's members change on its page).
 * The folder is made on disk when missing; the rules replace the folder's own. Returns the folders row id.
 */
export function legacyProjectFolder(db: Database, team: string, folderPath: string, rules: readonly OldFolderRule[], by: string | null = null): string {
  fs.mkdirSync(path.join(team, ...folderPath.split('/')), { recursive: true, mode: 0o700 })
  const now = new Date().toISOString()
  let row = db.query('SELECT id FROM folders WHERE path = ?').get(folderPath) as { id: string } | null
  db.transaction(() => {
    if (!row) { row = { id: uuidv7() }; db.query('INSERT INTO folders (id, path, created_at) VALUES (?,?,?)').run(row.id, folderPath, now) }
    // (the rules as tests wrote them before folder access added up: tests/lib/folder-access.ts says what they mean now)
    setFolderAccess(db, row.id, rules, by)
  })()
  return row!.id
}
