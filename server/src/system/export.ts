// Export (design tab 6 "내보내기"): chats as Markdown, memories as CSV, the team folder as is — so a team can move to
// another product. One .tar.zst (optionally age-encrypted with a password: .tar.zst.age, opens with `age -d`) written
// to users/<owner>/exports/ in the team folder. Component G.
//
// Privacy: nobody, the owner included, reads other people's conversations or memories (tab 1/7), so chats and
// memories are the requesting owner's own; the files part is the whole team folder (the owner may read all of it),
// without .system/ and without earlier exports.
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { PRODUCT } from '@mycel/shared'
import { walkTree } from './manifest'
import { ageEncrypt, writeAtomic, zstdCompress } from './streams'
import { tarStream, type TarEntryInput } from './tar'

export interface ExportRequest {
  ownerId: string
  what: ('chats' | 'memories' | 'files')[]
  password?: string
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

export function chatMarkdown(chat: ChatRow, msgs: MsgRow[]): string {
  const lines = [`# ${chat.title || '(제목 없음)'}`, '', `- created: ${chat.created_at}`, `- updated: ${chat.updated_at}`, `- engine: ${chat.engine}`, '']
  for (const m of msgs) {
    lines.push(`## ${m.role === 'user' ? '사용자' : 'AI'} · ${m.created_at}${m.model ? ` · ${m.model}` : ''}${m.status !== 'done' ? ` · (${m.status})` : ''}`, '', m.content, '')
  }
  return lines.join('\n')
}

const csvCell = (s: string) => /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s

export function memoriesCsv(rows: { id: string; text: string; created_at: string; source_chat_id: string | null }[]): string {
  return '﻿' + ['id,text,created_at,source_chat_id', ...rows.map((r) => [r.id, r.text, r.created_at, r.source_chat_id ?? ''].map(csvCell).join(','))].join('\r\n') + '\r\n'
}

export async function runExport(db: Database, teamRoot: string, req: ExportRequest, progress: (f: number | null, msg: string) => void = () => {}): Promise<{ path: string; size: number }> {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const relDir = `users/${req.ownerId}/exports`
  const name = `${PRODUCT.id}-export-${stamp}.tar.zst${req.password ? '.age' : ''}`
  const entries: TarEntryInput[] = []
  const root = `export-${stamp}`
  entries.push({ name: root, type: 'dir' })
  if (req.what.includes('chats')) {
    progress(0.05, 'chats')
    const chats = db.query('SELECT id, title, created_at, updated_at, engine, active_leaf_id FROM chats WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at').all(req.ownerId) as ChatRow[]
    entries.push({ name: `${root}/chats`, type: 'dir' })
    const q = db.query('SELECT id, parent_id, role, content, created_at, status, engine, model FROM messages WHERE chat_id = ?')
    const used = new Set<string>()
    for (const c of chats) {
      let base = `${c.created_at.slice(0, 10)} ${slug(c.title)}`
      if (used.has(base)) base += ` ${c.id.slice(-6)}`
      used.add(base)
      entries.push({ name: `${root}/chats/${base}.md`, type: 'file', data: enc(chatMarkdown(c, chatPath(q.all(c.id) as MsgRow[], c.active_leaf_id))) })
    }
  }
  if (req.what.includes('memories')) {
    progress(0.1, 'memories')
    const rows = db.query('SELECT id, text, created_at, source_chat_id FROM memories WHERE user_id = ? ORDER BY created_at').all(req.ownerId) as { id: string; text: string; created_at: string; source_chat_id: string | null }[]
    entries.push({ name: `${root}/memories.csv`, type: 'file', data: enc(memoriesCsv(rows)) })
  }
  let total = 1
  if (req.what.includes('files')) {
    progress(0.15, 'files')
    const tree = await walkTree(teamRoot, { exclude: [PRODUCT.systemDir, relDir] })
    entries.push({ name: `${root}/files`, type: 'dir' })
    for (const d of tree.dirs) entries.push({ name: `${root}/files/${d.rel}`, type: 'dir', mode: d.mode, mtimeMs: d.mtimeMs })
    for (const f of tree.files) entries.push({ name: `${root}/files/${f.rel}`, type: 'file', source: f.abs })
    total = tree.files.reduce((a, f) => a + f.size, 0) || 1
  }
  let done = 0
  const tar = tarStream(entries, (w) => { done += w.size; progress(0.15 + 0.8 * Math.min(1, done / total), 'files') })
  const out = req.password ? ageEncrypt(zstdCompress(tar), req.password) : zstdCompress(tar)
  const dir = path.join(teamRoot, relDir)
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  const w = await writeAtomic(out, path.join(dir, name), 0o600)
  progress(1, 'done')
  return { path: `${relDir}/${name}`, size: w.size }
}
