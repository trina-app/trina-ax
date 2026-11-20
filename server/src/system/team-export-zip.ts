// The team export as a plain ZIP that opens with a double-click on any computer (docs/decisions/20261120-team-export-zip.md):
// the team's folders with people's names instead of account ids, every channel, direct message and AI chat as a text
// file (and as JSON for another app), the files sent in channels next to their text, and a README.txt that says what
// is where. Built from the same database copy and team folder as the encrypted archive (cloud-admin.ts archiveUpload),
// so both hold the same moment. Left out: the trash, older versions, backups (.system) and folders a tool makes again
// (node_modules …), deleted messages and deleted chats.
//
// Names are made safe for Windows and macOS (no \ / : * ? " < > |, no trailing dot or space, no reserved device
// names), and two names in one folder never differ only in case (both systems ignore case).
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import { walkTree } from './manifest'
import { backupWalk } from './regenerable'
import { type Bytes } from './streams'
import type { ZipOutEntry } from './zip-out'

/** already-compressed types: deflate at level 1 (files/make-zip.ts keeps the same list stored) */
const COMPRESSED = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst', 'age', 'docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm', 'hwpx', 'odt', 'ods', 'odp', 'epub', 'pdf'])
const isCompressed = (name: string) => COMPRESSED.has(path.extname(name).slice(1).toLowerCase())

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i
/** one path segment that Windows and macOS both accept */
export function safeSegment(s: string, max = 120): string {
  // eslint-disable-next-line no-control-regex
  let v = s.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/[‎‏‪-‮⁦-⁩]/g, '').replace(/[. ]+$/, '').trim()
  if (!v || v === '.' || v === '..') v = '_'
  if (RESERVED.test(v)) v = `_${v}`
  if ([...v].length > max) {
    const ext = path.extname(v)
    const keep = ext && ext.length <= 12 ? ext : ''
    v = [...v].slice(0, max - [...keep].length).join('').replace(/[. ]+$/, '') + keep
  }
  return v
}

/** names given out per folder of the zip: the same name twice (or differing only in case) gets " (2)", " (3)" … */
export class Names {
  private used = new Map<string, Set<string>>()
  take(dir: string, want: string): string {
    let set = this.used.get(dir)
    if (!set) { set = new Set(); this.used.set(dir, set) }
    const ext = path.extname(want)
    const stem = ext && ext !== want ? want.slice(0, -ext.length) : want
    let v = want
    for (let i = 2; set.has(v.toLowerCase()); i++) v = `${stem} (${i})${ext && ext !== want ? ext : ''}`
    set.add(v.toLowerCase())
    return v
  }
}

interface Person { id: string; username: string; name: string; email: string | null; role: string; status: string; deleted_at: string | null }
interface RoomRow { id: string; kind: 'team' | 'all' | 'dm' | 'group'; name: string | null; group_id: string | null; dm_key: string | null; created_at: string; archived_at: string | null }
interface RoomMsg { id: string; seq: number; author_kind: 'user' | 'ai'; author_id: string | null; asked_by: string | null; visibility: 'room' | 'private'; visible_to: string | null; body: string; created_at: string; edited_at: string | null; event: string | null; thread_root_id: string | null }
interface RoomFile { id: string; message_id: string | null; name: string; size: number; user_id: string | null; created_at: string }
interface ChatRow { id: string; user_id: string; title: string; project_id: string | null; room_id: string | null; created_at: string; updated_at: string; active_leaf_id: string | null }
interface ChatMsg { id: string; parent_id: string | null; role: 'user' | 'assistant'; content: string; attachments: string; created_at: string; author_id: string | null; status: string }

/**
 * A file of the team folder, read without following a link: the walk skipped symlinks, but a file can be swapped for
 * one while a long export runs. O_NOFOLLOW refuses a link in the last place, and the opened file must still be a
 * regular file inside the team folder (a folder above it swapped for a link fails that check).
 */
async function* readInside(root: string, abs: string, chunk = 1 << 20): AsyncGenerator<Uint8Array> {
  const fh = await fsp.open(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const st = await fh.stat()
    const real = await fsp.realpath(abs)
    const base = await fsp.realpath(root)
    if (!st.isFile() || !real.startsWith(base + path.sep)) throw new Error(`${path.relative(root, abs)} is not a file of the team folder any more`)
    const buf = Buffer.alloc(chunk)
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, chunk, null)
      if (!bytesRead) break
      yield Buffer.from(buf.subarray(0, bytesRead))
    }
  } finally { await fh.close() }
}

function has(db: Database, table: string, column?: string): boolean {
  const cols = db.query(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]
  return column ? cols.some((c) => c.name === column) : cols.length > 0
}

export function textBytes(s: string): () => Bytes {
  const b = Buffer.from(s, 'utf8')
  return () => (async function* () { yield b })()
}

/** "2026-11-20" and "14:03" in the team's time zone */
function clock(tz: string) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return { day: (iso: string) => day.format(new Date(iso)), time: (iso: string) => time.format(new Date(iso)) }
}

const indent = (s: string, pad: string) => s.replace(/\r\n?/g, '\n').split('\n').map((l, i) => (i === 0 ? l : pad + l)).join('\n')

export interface TeamExportZipInput {
  /** a consistent copy of the database (VACUUM INTO), opened read-only here */
  dbFile: string
  teamRoot: string
  now?: Date
}

/**
 * The entries of the plain ZIP, in order: README.txt, files/, chats/, data/. Pass them to zipOut (system/zip-out.ts).
 * Team files are read when the zip reaches them, so a big team folder never sits in memory.
 */
export async function* teamExportEntries(o: TeamExportZipInput): AsyncGenerator<ZipOutEntry> {
  const now = o.now ?? new Date()
  const db = new Database(o.dbFile, { readonly: true })
  try {
    const setting = (key: string): unknown => {
      const r = db.query('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | null
      if (!r) return null
      try { return JSON.parse(r.value) } catch { return r.value }
    }
    const teamName = String(setting('teamName') ?? 'Team')
    let tz = String(setting('timeZone') ?? 'UTC')
    try { new Intl.DateTimeFormat('en', { timeZone: tz }) } catch { tz = 'UTC' }
    const t = clock(tz)
    const names = new Names()

    // a database from before guests has no guest column (an archive of a server that was not started since)
    const people = (has(db, 'users', 'guest')
      ? db.query("SELECT id, username, name, email, CASE WHEN guest = 1 THEN 'guest' ELSE role END AS role, status, deleted_at FROM users ORDER BY created_at, id")
      : db.query("SELECT id, username, name, email, CASE WHEN role = 'owner' THEN 'owner' WHEN role = 'admin' THEN 'admin' ELSE 'member' END AS role, status, deleted_at FROM users ORDER BY created_at, id")).all() as Person[]
    const byId = new Map(people.map((p) => [p.id, p]))
    const who = (id: string | null) => {
      if (!id) return 'Someone'
      const p = byId.get(id)
      if (!p) return 'Someone'
      return (p.name || p.username) + (p.deleted_at ? ' (removed)' : '')
    }
    // a person's folder name: the name people know, unique in files/people/ and chats/AI chats/
    const personFolder = new Map<string, string>()
    const folderOf = (id: string) => {
      let v = personFolder.get(id)
      if (!v) { v = names.take('files/people', safeSegment(who(id))); personFolder.set(id, v) }
      return v
    }
    for (const p of people) folderOf(p.id)

    yield { name: 'README.txt', mtime: now, data: textBytes(readme(teamName, tz, `${t.day(now.toISOString())} ${t.time(now.toISOString())}`)) }

    // ---- files/: the team folder as people see it, personal folders by name
    yield { name: 'files', dir: true, mtime: now }
    const tree = await walkTree(o.teamRoot, { exclude: [PRODUCT.systemDir], skipDir: backupWalk.skipDir })
    const mapped = new Map<string, string>() // team rel dir -> zip dir
    mapped.set('', 'files')
    // personal folders always go to files/people/ (data/people.json points there); a top-level "people" folder of the
    // team gets "people (2)"
    names.take('files', 'people')
    mapped.set('users', 'files/people')
    const zipDirOf = (rel: string): string => {
      const hit = mapped.get(rel)
      if (hit !== undefined) return hit
      const parent = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel)
      const base = path.posix.basename(rel)
      const pz = zipDirOf(parent)
      const isPerson = parent === 'users' && byId.has(base)
      const v = `${pz}/${isPerson ? folderOf(base) : names.take(pz, safeSegment(base))}`
      mapped.set(rel, v)
      return v
    }
    // the team folder's own dot folders and files at its top (.system is already out)
    const hidden = (rel: string) => rel.startsWith('.')
    for (const d of tree.dirs) {
      if (hidden(d.rel)) continue
      yield { name: zipDirOf(d.rel), dir: true, mtime: new Date(d.mtimeMs) }
    }
    for (const f of tree.files) {
      if (hidden(f.rel)) continue
      const dir = path.posix.dirname(f.rel) === '.' ? '' : path.posix.dirname(f.rel)
      const zd = zipDirOf(dir)
      const abs = f.abs
      yield { name: `${zd}/${names.take(zd, safeSegment(path.posix.basename(f.rel)))}`, mtime: new Date(f.mtimeMs), size: f.size, compressed: isCompressed(f.rel), data: () => readInside(o.teamRoot, abs) }
    }

    // ---- chats/: channels and direct messages, then each person's AI chats
    const conversations: Record<string, unknown>[] = []
    const messagesOut: { file: string; json: unknown }[] = []
    yield { name: 'chats', dir: true, mtime: now }
    if (has(db, 'rooms')) {
      const rooms = db.query('SELECT id, kind, name, group_id, dm_key, created_at, archived_at FROM rooms ORDER BY created_at, id').all() as RoomRow[]
      const groupName = new Map((db.query('SELECT id, name FROM groups').all() as { id: string; name: string }[]).map((g) => [g.id, g.name]))
      const membersOf = db.query('SELECT user_id FROM room_members WHERE room_id = ? ORDER BY joined_at, user_id')
      const msgsOf = db.query(`SELECT id, seq, author_kind, author_id, asked_by, visibility, visible_to, body, created_at, edited_at, event, thread_root_id
        FROM room_messages WHERE room_id = ? AND deleted_at IS NULL ORDER BY seq`)
      const filesOf = has(db, 'room_files') ? db.query(`SELECT f.id, f.message_id, f.name, f.size, f.user_id, f.created_at FROM room_files f
        JOIN room_messages m ON m.id = f.message_id AND m.deleted_at IS NULL WHERE f.room_id = ? ORDER BY f.created_at, f.id`) : null
      let madeChannels = false
      let madeDms = false
      for (const r of rooms) {
        const members = (membersOf.all(r.id) as { user_id: string }[]).map((m) => m.user_id)
        const msgs = msgsOf.all(r.id) as RoomMsg[]
        const files = (filesOf?.all(r.id) ?? []) as RoomFile[]
        if (r.kind === 'dm' && !msgs.length && !files.length) continue
        const dm = r.kind === 'dm'
        const title = dm ? (r.dm_key ?? members.join('|')).split('|').map((id) => who(id)).join(', ')
          : r.kind === 'all' ? 'Everyone' : r.kind === 'team' ? (r.group_id ? groupName.get(r.group_id) ?? r.name ?? 'Channel' : r.name ?? 'Channel') : r.name || 'Group chat'
        const folder = dm ? 'chats/Direct messages' : 'chats/Channels'
        if (dm && !madeDms) { yield { name: folder, dir: true, mtime: now }; madeDms = true }
        if (!dm && !madeChannels) { yield { name: folder, dir: true, mtime: now }; madeChannels = true }
        const stem = names.take(folder, safeSegment(title, 100))
        const file = `${folder}/${stem}.txt`
        // files sent here, in a folder next to the text
        const fileNames = new Map<string, string[]>()
        const fileEntries: ZipOutEntry[] = []
        if (files.length) {
          const fdir = `${folder}/${names.take(folder, `${stem} - files`)}`
          fileEntries.push({ name: fdir, dir: true, mtime: now })
          for (const f of files) {
            const abs = path.join(o.teamRoot, PRODUCT.systemDir, 'rooms', r.id, f.id)
            if (!(await Bun.file(abs).exists())) continue
            const n = names.take(fdir, safeSegment(f.name))
            fileEntries.push({ name: `${fdir}/${n}`, mtime: new Date(f.created_at), size: f.size, compressed: isCompressed(f.name), data: () => readInside(o.teamRoot, abs) })
            if (f.message_id) fileNames.set(f.message_id, [...(fileNames.get(f.message_id) ?? []), n])
          }
        }
        yield { name: file, mtime: now, data: textBytes(roomText(r, title, members.map(who), msgs, fileNames, who, t, tz)) }
        yield* fileEntries
        const jsonFile = `data/messages/${r.id}.json`
        conversations.push({ id: r.id, kind: dm ? 'direct_message' : r.kind === 'group' ? 'group_chat' : 'channel', name: title, members, createdAt: r.created_at, archived: !!r.archived_at, text: file, json: jsonFile })
        messagesOut.push({ file: jsonFile, json: msgs.filter((m) => !m.event).map((m) => ({
          id: m.id, at: m.created_at, editedAt: m.edited_at, from: m.author_kind === 'ai' ? 'ai' : m.author_id, askedBy: m.asked_by,
          onlyFor: m.visibility === 'private' ? m.visible_to : null, threadOf: m.thread_root_id, text: m.body, files: fileNames.get(m.id) ?? [],
        })) })
      }
    }
    if (has(db, 'chats')) {
      const projectName = new Map((has(db, 'projects') ? db.query('SELECT id, name FROM projects').all() as { id: string; name: string }[] : []).map((p) => [p.id, p.name]))
      const chats = db.query(`SELECT id, user_id, title, project_id, ${has(db, 'chats', 'room_id') ? 'room_id' : 'NULL AS room_id'}, created_at, updated_at, active_leaf_id
        FROM chats WHERE deleted_at IS NULL ORDER BY user_id, created_at, id`).all() as ChatRow[]
      const msgsOf = db.query('SELECT id, parent_id, role, content, attachments, created_at, author_id, status FROM messages WHERE chat_id = ? ORDER BY created_at, rowid')
      if (chats.length) yield { name: 'chats/AI chats', dir: true, mtime: now }
      const madePerson = new Set<string>()
      for (const c of chats) {
        const msgs = activePath(msgsOf.all(c.id) as ChatMsg[], c.active_leaf_id)
        if (!msgs.length) continue
        const pdir = `chats/AI chats/${folderOf(c.user_id)}`
        if (!madePerson.has(c.user_id)) { yield { name: pdir, dir: true, mtime: now }; madePerson.add(c.user_id) }
        const title = c.title.trim() || 'Untitled chat'
        const file = `${pdir}/${names.take(pdir, safeSegment(`${t.day(c.created_at)} ${title}`, 100))}.txt`
        yield { name: file, mtime: new Date(c.updated_at), data: textBytes(chatText(c, title, c.project_id ? projectName.get(c.project_id) ?? null : null, msgs, who, t, tz)) }
        const jsonFile = `data/messages/${c.id}.json`
        conversations.push({ id: c.id, kind: 'ai_chat', name: title, person: c.user_id, project: c.project_id ? projectName.get(c.project_id) ?? null : null, createdAt: c.created_at, updatedAt: c.updated_at, text: file, json: jsonFile })
        messagesOut.push({ file: jsonFile, json: msgs.map((m) => ({ id: m.id, at: m.created_at, from: m.role === 'assistant' ? 'ai' : m.author_id ?? c.user_id, text: m.content, attachments: attachmentNames(m.attachments) })) })
      }
    }

    // ---- data/: the same as JSON, for another app
    yield { name: 'data', dir: true, mtime: now }
    yield { name: 'data/people.json', mtime: now, data: textBytes(JSON.stringify(people.map((p) => ({
      id: p.id, username: p.username, name: p.name, email: p.deleted_at ? null : p.email, role: p.role, status: p.deleted_at ? 'removed' : p.status, folder: `files/people/${folderOf(p.id)}`,
    })), null, 2)) }
    yield { name: 'data/conversations.json', mtime: now, data: textBytes(JSON.stringify(conversations, null, 2)) }
    if (messagesOut.length) yield { name: 'data/messages', dir: true, mtime: now }
    for (const m of messagesOut) yield { name: m.file, mtime: now, data: textBytes(JSON.stringify(m.json, null, 2)) }
  } finally {
    db.close()
  }
}

/** the messages of the chat's current branch (an edited question starts a new one), oldest first */
function activePath(all: ChatMsg[], leaf: string | null): ChatMsg[] {
  if (!leaf || !all.some((m) => m.parent_id)) return all
  const byId = new Map(all.map((m) => [m.id, m]))
  const out: ChatMsg[] = []
  const seen = new Set<string>()
  for (let m = byId.get(leaf); m && !seen.has(m.id); m = m.parent_id ? byId.get(m.parent_id) : undefined) { out.push(m); seen.add(m.id) }
  return out.length ? out.reverse() : all
}

function attachmentNames(json: string): string[] {
  try {
    const a = JSON.parse(json) as unknown
    return Array.isArray(a) ? a.map((x) => (x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string' ? (x as { name: string }).name : null)).filter((x): x is string => !!x) : []
  } catch { return [] }
}

type Clock = ReturnType<typeof clock>

function roomText(r: RoomRow, title: string, members: string[], msgs: RoomMsg[], files: Map<string, string[]>, who: (id: string | null) => string, t: Clock, tz: string): string {
  const kind = r.kind === 'dm' ? 'Direct message' : r.kind === 'group' ? 'Group chat' : 'Channel'
  const lines = [title, `${kind}${r.archived_at ? ' (archived)' : ''} · ${members.length} ${members.length === 1 ? 'person' : 'people'}: ${members.join(', ')}`, `Times are in ${tz}.`, '']
  const roots = msgs.filter((m) => !m.event && !m.thread_root_id)
  const replies = new Map<string, RoomMsg[]>()
  for (const m of msgs) if (!m.event && m.thread_root_id) replies.set(m.thread_root_id, [...(replies.get(m.thread_root_id) ?? []), m])
  const line = (m: RoomMsg, pad: string) => {
    const from = m.author_kind === 'ai' ? (m.asked_by ? `AI (asked by ${who(m.asked_by)})` : 'AI') : who(m.author_id)
    const only = m.visibility === 'private' ? ` [only ${who(m.visible_to)} saw this]` : ''
    const edited = m.edited_at ? ' (edited)' : ''
    const f = files.get(m.id)
    const att = f?.length ? `\n${pad}  [files: ${f.join(', ')}]` : ''
    return `${pad}[${t.time(m.created_at)}] ${from}${only}${edited}: ${indent(m.body, pad + '  ')}${att}`
  }
  let day = ''
  for (const m of roots) {
    const d = t.day(m.created_at)
    if (d !== day) { lines.push('', `---- ${d} ----`); day = d }
    lines.push(line(m, ''))
    for (const rep of replies.get(m.id) ?? []) lines.push(line(rep, '    ↳ '))
  }
  // replies whose first message was deleted
  const rootIds = new Set(roots.map((m) => m.id))
  const orphans = [...replies.entries()].filter(([id]) => !rootIds.has(id)).flatMap(([, v]) => v)
  if (orphans.length) { lines.push('', '---- Replies to deleted messages ----'); for (const m of orphans) lines.push(line(m, '')) }
  if (!roots.length && !orphans.length) lines.push('(No messages.)')
  return lines.join('\n') + '\n'
}

function chatText(c: ChatRow, title: string, project: string | null, msgs: ChatMsg[], who: (id: string | null) => string, t: Clock, tz: string): string {
  const lines = [title, `AI chat of ${who(c.user_id)}${project ? ` · project ${project}` : ''}`, `Started ${t.day(c.created_at)} ${t.time(c.created_at)}. Times are in ${tz}.`, '']
  let day = ''
  for (const m of msgs) {
    const d = t.day(m.created_at)
    if (d !== day) { lines.push('', `---- ${d} ----`); day = d }
    const from = m.role === 'assistant' ? 'AI' : who(m.author_id ?? c.user_id)
    const att = attachmentNames(m.attachments)
    lines.push(`[${t.time(m.created_at)}] ${from}: ${indent(m.content, '  ')}${att.length ? `\n  [attached: ${att.join(', ')}]` : ''}`, '')
  }
  return lines.join('\n') + '\n'
}

function readme(team: string, tz: string, made: string): string {
  return `${team}: export of the whole team
Made ${made} (${tz}).

WHAT IS IN THIS ZIP

files/            Every folder of the team, as people see them in ${PRODUCT.displayName}:
  shared/           the team's shared folders
  groups/           each group's folder
  projects/         each project's folder
  people/           each person's own folder, by their name
  skills/           the team's skills

chats/
  Channels/         every channel and group chat: one text file each
  Direct messages/  every direct message: one text file each
  AI chats/         each person's chats with the AI, one folder per person
  Files sent in a channel or message are in the folder "<name> - files" next to its text file.

data/             The same chats as JSON, for another app or a developer:
  people.json         everyone in the team
  conversations.json  every channel, direct message and AI chat, with the file of its messages
  messages/           one file per conversation

Times are in the team's time zone (${tz}).
Not included: files in the trash, older versions of files, and deleted messages and chats.

This ZIP holds everyone's chats and personal folders. Keep it somewhere safe, and delete it when you no longer need it.
To move the team to another ${PRODUCT.displayName} server, use the encrypted backup: it brings back everything,
settings and sign-ins included.
`
}
