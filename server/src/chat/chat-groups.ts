// The Trina list's groups in one read (GET /api/chats/groups; docs/DECISIONS.md "The Trina list: pinned, folders,
// projects, other chats"; the navigation plan docs/AGENTS/plan/20261112-1839-nav-rail.md §4.7). The list's heads come
// from here, never from the chat pages a window happens to have loaded: each group's count, its first rows and the
// chats in it that show a marker now.
//
// What it holds is my chat list (GET /api/chats without filters) and nothing more: my own chats and the shared project
// chats I wrote in, never a room's AI session or one of the server's own drafts, a shared chat only while I see its
// project. Each chat is in exactly one place: pinned › one of my folders › its project's group › other. A project I
// cannot see now is never named (my chats in it are with the other chats, as the chat page shows no project for them);
// a folder is mine alone (chat/nav-folders.ts, by its one visibility check).
import { CHAT_GROUPS_FOLD_DAYS, CHAT_GROUPS_PROJECTS_MAX, CHAT_GROUPS_RECENT_DAYS, CHAT_GROUPS_TOP, markerOf, type Chat, type ChatGroups, type ChatMark } from '@mycel/shared/api'
import { redactorFor } from '../integrations/connections/redact'
import type { Principal } from '../policy/access'
import { notInternalChat } from './internal-chats'
import { visibleChatItems } from './nav-folders'
import { pinsOf } from './pins'
import { canSeeProject } from './projects'
import type { ChatRuntime } from './runtime'
import { Audiences, chatPeople, chatView, isSharedRow, type ChatPeople } from './shared'
import { CHAT_COLS, PROJECT_COLS, decodeCursor, encodeCursor, type ChatRow, type ProjectRow } from './store'
import { fail } from '../http/errors'

const DAY = 86_400_000
/** page 1 of the other chats, as GET /api/chats pages them */
const OTHER_PAGE = 50

const newestFirst = (a: ChatRow, b: ChatRow) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id)
/** a chat made only to hold attachments (nothing sent yet): not a conversation yet, the list leaves it out (the page's
 * isUnused, components/chat/ChatState.tsx) */
const unused = (rt: ChatRuntime, r: ChatRow) => !r.title && r.created_at === r.updated_at && rt.runState(r.id) === 'idle'

/** The chats of my list I can open now and the projects I can see, read once for one request. */
function myList(rt: ChatRuntime, me: string, who: Principal | null) {
  const db = rt.db
  const rows = db.query(`SELECT ${CHAT_COLS} FROM chats WHERE room_id IS NULL AND ${notInternalChat(db)} AND deleted_at IS NULL
      AND (user_id = ?1 OR (shared_at IS NOT NULL AND id IN (SELECT chat_id FROM messages WHERE role = 'user' AND author_id = ?1)))`).all(me) as ChatRow[]
  const projects = new Map<string, ProjectRow>()
  for (const p of db.query(`SELECT ${PROJECT_COLS} FROM projects`).all() as ProjectRow[]) if (who && canSeeProject(rt.files, who, p)) projects.set(p.id, p)
  // a shared chat only while I see its project now (GET /api/chats does the same)
  const chats = rows.filter((r) => (!isSharedRow(r) || projects.has(r.project_id!)) && !unused(rt, r)).sort(newestFirst)
  return { chats, projects }
}

/** where a chat of my list goes: pinned › folder › project › other */
function place(r: ChatRow, pins: Map<string, string>, folderOf: Map<string, string>, projects: Map<string, ProjectRow>): { kind: 'pinned' | 'folder' | 'project' | 'other'; key: string } {
  if (pins.has(r.id)) return { kind: 'pinned', key: '' }
  const f = folderOf.get(r.id)
  if (f) return { kind: 'folder', key: f }
  if (r.project_id && projects.has(r.project_id)) return { kind: 'project', key: r.project_id }
  return { kind: 'other', key: '' }
}

/** the chat's marker parts when it shows one now (no window's view: a card open in one window is the page's to add) */
const markOf = (c: Chat): ChatMark[] =>
  markerOf(c) ? [{ id: c.id, runState: c.runState, ...(c.waiting ? { waiting: c.waiting } : {}), ...(c.unseen ? { unseen: c.unseen } : {}), ...(c.lastOutcome ? { lastOutcome: c.lastOutcome } : {}) }] : []

function principalOf(rt: ChatRuntime, me: string): Principal | null {
  try { return rt.files.principal(me) } catch { return null }
}

/** GET /api/chats/groups */
export function chatGroups(rt: ChatRuntime, me: string, now = Date.now()): ChatGroups {
  const db = rt.db
  const { chats, projects } = myList(rt, me, principalOf(rt, me))
  const pins = pinsOf(db, me)
  // my folders' rows by their one check (my own chats, no project, not in the trash, not shared, not a draft)
  const folderOf = new Map<string, string>()
  for (const r of db.query(`SELECT i.chat_id c, i.folder_id f FROM ${visibleChatItems(db)}`).all(me) as { c: string; f: string }[]) folderOf.set(r.c, r.f)
  const aud = new Audiences(db, rt.files)
  const hide = redactorFor(rt.ctx, me).hide
  // the other people who wrote in each shared chat this answer returns (the rows' faces; docs/DECISIONS.md "Faces in
  // every chat list"): one query, made below once the returned rows are known (a row viewed only for its marker needs
  // none)
  let people = new Map<string, ChatPeople>()
  const view = (r: ChatRow): Chat => chatView(rt, me, r, { aud, people, ...(r.user_id === me ? { hide } : {}) })
  // each group's first rows, and the marks of all its rows (a row past `top` is read only for its marker)
  const head = (rows: ChatRow[]) => {
    const top = rows.slice(0, CHAT_GROUPS_TOP).map(view)
    // a row can mark only while it runs, waits, or has an answer newer than when it was last seen: the cheap checks
    // first, the full view (whose answers count for me) only for those
    const maybe = (r: ChatRow) => rt.runState(r.id) !== 'idle' || rt.waitsForPerson(r.id) || !!rt.store.answerState(r).unseen
    const marked = [...top, ...rows.slice(CHAT_GROUPS_TOP).filter(maybe).map(view)].flatMap((c) => markOf(c))
    return { count: rows.length, top, marked }
  }

  const pinned: ChatRow[] = []
  const byFolder = new Map<string, ChatRow[]>()
  const byProject = new Map<string, ChatRow[]>()
  const other: ChatRow[] = []
  for (const r of chats) {
    const p = place(r, pins, folderOf, projects)
    if (p.kind === 'pinned') pinned.push(r)
    else if (p.kind === 'folder') (byFolder.get(p.key) ?? byFolder.set(p.key, []).get(p.key)!).push(r)
    else if (p.kind === 'project') (byProject.get(p.key) ?? byProject.set(p.key, []).get(p.key)!).push(r)
    else other.push(r)
  }
  pinned.sort((a, b) => pins.get(b.id)!.localeCompare(pins.get(a.id)!) || b.id.localeCompare(a.id))

  const folderRows = db.query("SELECT id, name, position FROM nav_folders WHERE user_id = ? AND kind = 'chats' ORDER BY position, created_at, id").all(me) as { id: string; name: string; position: number }[]

  // the projects with my activity in the last 14 days, the most recent first, at most 8 (rows are newest first)
  const since = new Date(now - CHAT_GROUPS_RECENT_DAYS * DAY).toISOString()
  const foldBefore = new Date(now - CHAT_GROUPS_FOLD_DAYS * DAY).toISOString()
  const recent = [...byProject.entries()]
    .map(([id, rows]) => ({ id, rows, at: rows[0]!.updated_at }))
    .filter((g) => g.at >= since)
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
    .slice(0, CHAT_GROUPS_PROJECTS_MAX)
  const otherRows = pageOf(other, undefined, OTHER_PAGE)
  // the rows returned as chats: pinned, each folder's and shown project's first rows, the other chats' first page
  const returned = [...pinned, ...folderRows.flatMap((f) => (byFolder.get(f.id) ?? []).slice(0, CHAT_GROUPS_TOP)), ...recent.flatMap((g) => g.rows.slice(0, CHAT_GROUPS_TOP)), ...otherRows.items]
  people = chatPeople(db, returned.filter(isSharedRow).map((r) => r.id), me)
  const folders = folderRows.map((f) => ({ id: f.id, name: f.name, position: f.position, ...head(byFolder.get(f.id) ?? []) }))
  const shown = recent.map((g) => ({ projectId: g.id, name: projects.get(g.id)!.name, lastActivityAt: view(g.rows[0]!).updatedAt, folded: g.at < foldBefore, ...head(g.rows) }))

  // every project I can see with chats I can open there (the 프로젝트 panel's meta line): mine, and every shared chat of
  // it, also one I never wrote in (a member who never asked there saw "No chats yet" while the project had shared
  // chats); never another person's private chat (chatFor 'view': a chat of one person is theirs alone). Pinned ones too
  const activity = new Map<string, { count: number; at: ChatRow }>()
  const inProjects = projects.size ? db.query(`SELECT ${CHAT_COLS} FROM chats WHERE project_id IS NOT NULL AND room_id IS NULL AND ${notInternalChat(db)}
      AND deleted_at IS NULL AND (user_id = ? OR shared_at IS NOT NULL)`).all(me) as ChatRow[] : []
  for (const r of inProjects.sort(newestFirst)) {
    if (!projects.has(r.project_id!) || unused(rt, r)) continue
    const a = activity.get(r.project_id!)
    if (a) a.count++
    else activity.set(r.project_id!, { count: 1, at: r })
  }
  const projectActivity = [...activity.entries()].map(([projectId, a]) => ({ projectId, count: a.count, lastActivityAt: view(a.at).updatedAt }))

  return {
    pinned: pinned.map(view),
    folders,
    projects: shown,
    projectsMore: Math.max(0, projects.size - shown.length),
    other: { items: otherRows.items.map(view), nextCursor: otherRows.nextCursor },
    projectActivity,
  }
}

/** one page of the other chats' rows (newest first) after `cursor` */
function pageOf(rows: ChatRow[], cursor: string | undefined, limit: number): { items: ChatRow[]; nextCursor: string | null } {
  const cur = decodeCursor(cursor, ['u', 'id'])
  if (cursor && !cur) fail('validation', undefined, { fields: { 'query.cursor': 'bad cursor' } })
  const after = cur ? rows.filter((r) => r.updated_at < cur.u || (r.updated_at === cur.u && r.id < cur.id)) : rows
  const items = after.slice(0, limit)
  const last = items[items.length - 1]
  return { items, nextCursor: after.length > limit && last ? encodeCursor({ u: last.updated_at, id: last.id }) : null }
}

/** GET /api/chats?other=1: the next pages of the other chats (in no project I can see, in no folder of mine, not pinned). */
export function otherChats(rt: ChatRuntime, me: string, cursor: string | undefined, limit: number): { items: Chat[]; nextCursor: string | null } {
  const db = rt.db
  const { chats, projects } = myList(rt, me, principalOf(rt, me))
  const pins = pinsOf(db, me)
  const folderOf = new Map<string, string>()
  for (const r of db.query(`SELECT i.chat_id c, i.folder_id f FROM ${visibleChatItems(db)}`).all(me) as { c: string; f: string }[]) folderOf.set(r.c, r.f)
  const aud = new Audiences(db, rt.files)
  const hide = redactorFor(rt.ctx, me).hide
  const rows = chats.filter((r) => place(r, pins, folderOf, projects).kind === 'other')
  // the page first, then the faces of its shared chats (one query)
  const page = pageOf(rows, cursor, limit)
  const people = chatPeople(db, page.items.filter(isSharedRow).map((r) => r.id), me)
  return { items: page.items.map((r) => chatView(rt, me, r, { aud, people, ...(r.user_id === me ? { hide } : {}) })), nextCursor: page.nextCursor }
}
