// Export (design tab 6 "내보내기"): chats as Markdown, memories as CSV, the team folder as is — so a team can move to
// another product. One .tar.zst (optionally age-encrypted with a password: .tar.zst.age, opens with `age -d`) written
// to users/<owner>/exports/ in the team folder. Component G.
//
// Privacy: nobody, the owner included, reads other people's conversations or memories (tab 1/7), so chats and
// memories are the requesting owner's own; the files part is the team folder without .system/, without other
// people's private users/<id>/ folders (tab 6 "내보내기") and without earlier exports.
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { PRODUCT, UserId } from '@mycel/shared'
import { DEFAULT_LOCALE, type Locale } from '@mycel/shared/api'
import { walkTree } from './manifest'
import { ageEncrypt, writeAtomic, zstdCompress } from './streams'
import { tarStream, type TarEntryInput } from './tar'

export interface ExportRequest {
  ownerId: string
  /** language of the Markdown headings (the person exporting) */
  locale?: Locale
  what: ('chats' | 'memories' | 'files')[]
  password?: string
  /** hides the person's stored connection secrets (integrations/connections/redact.ts) in the chat titles: the file
   * names and the headings (QA SEC-16, B-W5-1). A title made before the fix can still hold one in the database. */
  hide?: (text: string) => string
}

interface ChatRow { id: string; title: string; created_at: string; updated_at: string; engine: string; active_leaf_id: string | null }
interface MsgRow { id: string; parent_id: string | null; role: 'user' | 'assistant'; content: string; created_at: string; status: string; engine: string | null; model: string | null }

const enc = (s: string) => Buffer.from(s, 'utf8')

function slug(s: string): string {
  const t = s.normalize('NFC').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
  return t || 'chat'
}

/** The visible path of a chat: from the active leaf up through parent_id; all messages by time when there is no tree. */
export function chatPath(rows: MsgRow[], activeLeaf: string | null): MsgRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  if (activeLeaf && byId.has(activeLeaf)) {
    const out: MsgRow[] = []
    const seen = new Set<string>()
    let cur: MsgRow | undefined = byId.get(activeLeaf)
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.unshift(cur); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined }
    return out
  }
  return [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at))
}

export const MD_WORDS: Record<Locale, { untitled: string; user: string }> = {
  ko: { untitled: '(제목 없음)', user: '사용자' },
  en: { untitled: '(untitled)', user: 'User' },
  id: { untitled: '(tanpa judul)', user: 'Pengguna' },
}

/** One chat as Markdown, headings in the language of the person exporting. */
export function chatMarkdown(chat: ChatRow, msgs: MsgRow[], locale: Locale = DEFAULT_LOCALE): string {
  const w = MD_WORDS[locale] ?? MD_WORDS.en
  const lines = [`# ${chat.title || w.untitled}`, '', `- created: ${chat.created_at}`, `- updated: ${chat.updated_at}`, `- engine: ${chat.engine}`, '']
  for (const m of msgs) {
    lines.push(`## ${m.role === 'user' ? w.user : 'AI'} · ${m.created_at}${m.model ? ` · ${m.model}` : ''}${m.status !== 'done' ? ` · (${m.status})` : ''}`, '', m.content, '')
  }
  return lines.join('\n')
}

const csvCell = (s: string) => /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s

export function memoriesCsv(rows: { id: string; text: string; created_at: string; source_chat_id: string | null }[]): string {
  return '﻿' + ['id,text,created_at,source_chat_id', ...rows.map((r) => [r.id, r.text, r.created_at, r.source_chat_id ?? ''].map(csvCell).join(','))].join('\r\n') + '\r\n'
}

/**
 * Folders of the team folder the export leaves out: .system/, the owner's earlier exports and every OTHER person's
 * users/<id>/ (design tab 6 "내보내기": other people's private folders are not exported; the owner's own is).
 */
export async function exportExcludes(teamRoot: string, ownerId: string): Promise<string[]> {
  const out = [PRODUCT.systemDir, `users/${ownerId}/exports`]
  let names: string[] = []
  try { names = await fsp.readdir(path.join(teamRoot, 'users')) } catch {}
  for (const n of names) if (n !== ownerId) out.push(`users/${n}`)
  return out
}

export async function runExport(db: Database, teamRoot: string, req: ExportRequest, progress: (f: number | null, msg: string) => void = () => {}): Promise<{ path: string; size: number }> {
  if (!UserId.safeParse(req.ownerId).success) throw new Error('bad owner id')
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const relDir = `users/${req.ownerId}/exports`
  const name = `${PRODUCT.id}-export-${stamp}.tar.zst${req.password ? '.age' : ''}`
  const root = `export-${stamp}`
  const tree = req.what.includes('files') ? await walkTree(teamRoot, { exclude: await exportExcludes(teamRoot, req.ownerId) }) : null
  const total = tree ? tree.files.reduce((a, f) => a + f.size, 0) || 1 : 1

  // entries are produced one at a time while the archive is written: a long chat history is never all in memory
  async function* entries(): AsyncGenerator<TarEntryInput> {
    yield { name: root, type: 'dir' }
    if (req.what.includes('chats')) {
      progress(0.05, 'chats')
      const chats = db.query('SELECT id, title, created_at, updated_at, engine, active_leaf_id FROM chats WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at').all(req.ownerId) as ChatRow[]
      yield { name: `${root}/chats`, type: 'dir' }
      const q = db.query('SELECT id, parent_id, role, content, created_at, status, engine, model FROM messages WHERE chat_id = ?')
      const used = new Set<string>()
      const hide = req.hide ?? ((t: string) => t)
      for (const raw of chats) {
        const c = { ...raw, title: hide(raw.title) }
        let base = `${c.created_at.slice(0, 10)} ${slug(c.title)}`
        if (used.has(base)) base += ` ${c.id.slice(-6)}`
        used.add(base)
        yield { name: `${root}/chats/${base}.md`, type: 'file', data: enc(chatMarkdown(c, chatPath(q.all(c.id) as MsgRow[], c.active_leaf_id), req.locale)) }
      }
    }
    if (req.what.includes('memories')) {
      progress(0.1, 'memories')
      const rows = db.query('SELECT id, text, created_at, source_chat_id FROM memories WHERE user_id = ? ORDER BY created_at').all(req.ownerId) as { id: string; text: string; created_at: string; source_chat_id: string | null }[]
      yield { name: `${root}/memories.csv`, type: 'file', data: enc(memoriesCsv(rows)) }
    }
    if (tree) {
      progress(0.15, 'files')
      yield { name: `${root}/files`, type: 'dir' }
      for (const d of tree.dirs) yield { name: `${root}/files/${d.rel}`, type: 'dir', mode: d.mode, mtimeMs: d.mtimeMs }
      for (const f of tree.files) yield { name: `${root}/files/${f.rel}`, type: 'file', source: f.abs }
    }
  }
  let done = 0
  const tar = tarStream(entries(), (w) => { if (w.name.startsWith(`${root}/files/`)) { done += w.size; progress(0.15 + 0.8 * Math.min(1, done / total), 'files') } })
  const out = req.password ? ageEncrypt(zstdCompress(tar), req.password) : zstdCompress(tar)
  const dir = path.join(teamRoot, relDir)
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  const w = await writeAtomic(out, path.join(dir, name), 0o600)
  progress(1, 'done')
  return { path: `${relDir}/${name}`, size: w.size }
}
