// Settings › Export (QA AP-038, docs/decisions/20261120-export-my-chats.md): every member downloads a ZIP of their own
// AI chats. One Markdown file and one JSON file per chat; attachments are links back to the team, never copies.
//
// Privacy: the chats are the ones the owner's export takes for the owner (system/export.ts ownChats): only chats the
// person made, never a chat of somebody else, also not one shared with them. Stored secrets are hidden in the titles,
// the file names, the headings and the JSON (QA SEC-16). A team-file attachment gets its link only while the person
// can still read the file; else neither its name nor its path goes in.
//
// The ZIP is written outside the team folder (<data>/my-exports/<person>/<job>.zip, mode 600): the AI, the Files
// tree, backups and the team export never see it. Only its maker downloads it (routes/system.ts), for 24 hours; the
// next export of the same person replaces it.
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { UserId } from '@mycel/shared'
import { DEFAULT_LOCALE, type Locale } from '@mycel/shared/api'
import { chatMarkdown, MD_WORDS, ownChats, type ChatRow, type MsgRow, type OwnChatsRequest } from './export'
import { writeAtomic } from './streams'
import { Names, safeSegment, textBytes } from './team-export-zip'
import { zipOut, type ZipOutEntry } from './zip-out'

/** how long a finished export can be downloaded */
export const MY_EXPORT_KEEP_MS = 24 * 3600_000

export interface MyExportRequest extends OwnChatsRequest {
  locale?: Locale
  /** the team's address (https://team.example), for the links in the files: a relative link does not work from an
   * unzipped file */
  base: string
  /** can the person read this team path now (the Files tree's check); without it, no attachment gets a link */
  readable?: (rel: string) => boolean
}

export interface MyExportFile {
  name: string
  size: number
  mime: string
  /** null: the file is not available to the person now (a team file they can no longer read, or one deleted) */
  url: string | null
}

const FILE_WORDS: Record<Locale, { file: string; gone: string }> = {
  ko: { file: '파일', gone: '(더 이상 열 수 없는 파일)' },
  en: { file: 'File', gone: '(a file you can no longer open)' },
  id: { file: 'Berkas', gone: '(berkas yang tidak bisa Anda buka lagi)' },
  ja: { file: 'ファイル', gone: '（開けなくなったファイル）' },
  es: { file: 'Archivo', gone: '(un archivo que ya no puede abrir)' },
  zh: { file: '文件', gone: '（你已无法打开的文件）' },
}

export const myExportDir = (dataDir: string, userId: string) => path.join(dataDir, 'my-exports', userId)
export const myExportFile = (dataDir: string, userId: string, jobId: string) => path.join(myExportDir(dataDir, userId), `${jobId}.zip`)

/** The attachments of one message as the person may see them now. */
export function messageFiles(m: Pick<MsgRow, 'attachments'>, chatId: string, base: string, readable: (rel: string) => boolean = () => false): MyExportFile[] {
  let list: unknown
  try { list = JSON.parse(m.attachments || '[]') } catch { return [] }
  if (!Array.isArray(list)) return []
  const out: MyExportFile[] = []
  for (const x of list as Record<string, unknown>[]) {
    if (!x || typeof x !== 'object') continue
    const id = typeof x.id === 'string' ? x.id : ''
    const name = typeof x.name === 'string' ? x.name : ''
    const rel = typeof x.path === 'string' ? x.path : ''
    const size = typeof x.size === 'number' ? x.size : 0
    const mime = typeof x.mime === 'string' ? x.mime : 'application/octet-stream'
    // a file kept with the chat: its own address, which checks again that the person sees the chat
    if (x.source === 'chat' && id) { out.push({ name, size, mime, url: `${base}/api/chats/${encodeURIComponent(chatId)}/files/${encodeURIComponent(id)}?download=1` }); continue }
    // an upload or a team file: only while the person can read it now (a team file they lost access to tells nothing)
    if (rel && readable(rel)) { out.push({ name, size, mime, url: `${base}/api/files/download?path=${encodeURIComponent(rel)}` }); continue }
    out.push({ name: '', size: 0, mime: '', url: null })
  }
  return out
}

const mdText = (s: string) => s.replace(/[\\[\]]/g, (c) => `\\${c}`)

/** One chat as Markdown: the owner export's text, with a link to the chat and the message's files under each one. */
export function myChatMarkdown(chat: ChatRow, msgs: MsgRow[], base: string, locale: Locale, withheld: (id: string) => boolean, files: (m: MsgRow) => MyExportFile[]): string {
  const fw = FILE_WORDS[locale] ?? FILE_WORDS.en
  const text = chatMarkdown(chat, msgs.map((m) => {
    if (withheld(m.id)) return m
    const f = files(m)
    if (!f.length) return m
    const lines = f.map((x) => x.url ? `- ${fw.file}: [${mdText(x.name)}](<${x.url}>)` : `- ${fw.file}: ${fw.gone}`)
    return { ...m, content: `${m.content}\n\n${lines.join('\n')}` }
  }), locale, withheld)
  // the chat's own address, after the title
  const nl = text.indexOf('\n')
  return `${text.slice(0, nl)}\n\n<${base}/c/${encodeURIComponent(chat.id)}>${text.slice(nl)}`
}

/** One chat as JSON, for another app. A withheld answer has no text and no files. */
export function myChatJson(chat: ChatRow, msgs: MsgRow[], base: string, withheld: (id: string) => boolean, files: (m: MsgRow) => MyExportFile[]): string {
  return JSON.stringify({
    id: chat.id,
    title: chat.title,
    url: `${base}/c/${encodeURIComponent(chat.id)}`,
    createdAt: chat.created_at,
    updatedAt: chat.updated_at,
    engine: chat.engine,
    messages: msgs.map((m) => withheld(m.id)
      ? { id: m.id, role: m.role, at: m.created_at, withheld: true }
      : { id: m.id, role: m.role, at: m.created_at, model: m.model, status: m.status, text: m.content, files: files(m) }),
  }, null, 2) + '\n'
}

/** The ZIP's entries, made one chat at a time. `count` is told the number of chats at the end. */
export async function* myExportEntries(db: Database, req: MyExportRequest, progress: (f: number | null, step: string) => void = () => {}, count: (n: number) => void = () => {}): AsyncGenerator<ZipOutEntry> {
  const locale = req.locale ?? DEFAULT_LOCALE
  const w = MD_WORDS[locale] ?? MD_WORDS.en
  const total = (db.query('SELECT COUNT(*) AS n FROM chats WHERE user_id = ? AND deleted_at IS NULL').get(req.ownerId) as { n: number }).n || 1
  const names = new Names()
  let n = 0
  progress(0, 'chats')
  for (const { chat, msgs, withheld } of ownChats(db, req)) {
    // the title is hidden already (ownChats): the file name, heading and JSON all come from it
    const stem = names.take('chats', `${chat.created_at.slice(0, 10)} ${safeSegment(chat.title || w.untitled, 80)}`)
    const files = (m: MsgRow) => m.role === 'user' ? messageFiles(m, chat.id, req.base, req.readable) : []
    const mtime = new Date(chat.updated_at)
    yield { name: `chats/${stem}.md`, mtime, data: textBytes(myChatMarkdown(chat, msgs, req.base, locale, withheld, files)) }
    yield { name: `chats/${stem}.json`, mtime, data: textBytes(myChatJson(chat, msgs, req.base, withheld, files)) }
    n++
    progress(Math.min(0.95, n / total), 'chats')
  }
  count(n)
}

/** Write the person's export for job `jobId`; earlier exports of the person are deleted once it is there. */
export async function runMyExport(db: Database, dataDir: string, jobId: string, req: MyExportRequest, progress: (f: number | null, step: string) => void = () => {}): Promise<{ download: string; size: number; chats: number }> {
  if (!UserId.safeParse(req.ownerId).success) throw new Error('bad user id')
  let chats = 0
  const file = myExportFile(dataDir, req.ownerId, jobId)
  const w = await writeAtomic(zipOut(myExportEntries(db, req, progress, (n) => { chats = n })), file, 0o600)
  for (const f of safeList(path.dirname(file))) if (f !== path.basename(file)) fs.rmSync(path.join(path.dirname(file), f), { force: true })
  progress(1, 'done')
  return { download: `/api/me/export/${jobId}/download`, size: w.size, chats }
}

/** Delete exports older than MY_EXPORT_KEEP_MS (and unfinished leftovers). Returns how many files went. */
export function sweepMyExports(dataDir: string, now = Date.now()): number {
  const root = path.join(dataDir, 'my-exports')
  let gone = 0
  for (const person of safeList(root)) {
    const dir = path.join(root, person)
    for (const f of safeList(dir)) {
      const abs = path.join(dir, f)
      try { if (now - fs.lstatSync(abs).mtimeMs > MY_EXPORT_KEEP_MS) { fs.rmSync(abs, { force: true }); gone++ } } catch { /* gone already */ }
    }
    try { if (!safeList(dir).length) fs.rmdirSync(dir) } catch { /* in use */ }
  }
  return gone
}

function safeList(dir: string): string[] {
  try { return fs.readdirSync(dir) } catch { return [] }
}
