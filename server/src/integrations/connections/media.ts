// Images, audio and embedded files that a connection's MCP answer carries inline (image / audio content blocks,
// `resource.blob`), kept for a while so the AI can save one with save_url("mcp-file:<id>") without the service being
// asked again, and without the bytes ever going through the AI's text (docs/DECISIONS.md "save_url").
//   <data>/connection-media/<chat id>/<id>.bin + <id>.json (who, which connection, what it is), 0600 in 0700 folders
//   kept 24 hours; at most 200 MiB per chat, 1 GiB per person and 4 GiB server-wide (the oldest go first); one item is
//   at most what one answer can carry (MCP_CALL_MAX_BYTES of base64)
// A handle opens only in the chat it was made in and only for the person of that turn; the id is 128 random bits.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { sniffKind, type FileKind } from '../../tools/sniff'

export const MEDIA_TTL_MS = 24 * 3600_000
export const MEDIA_CHAT_MAX = 200 * 1024 * 1024
/** kept inline media across all of one person's chats, and across the whole server: the oldest go first when a new
 * item would push a total over its cap (so many chats, or many people, cannot fill the disk with day-old media) */
export const MEDIA_USER_MAX = 1024 * 1024 * 1024
export const MEDIA_TOTAL_MAX = 4 * 1024 * 1024 * 1024
export const MEDIA_PREFIX = 'mcp-file:'
const ID = /^[A-Za-z0-9_-]{22}$/
const CHAT = /^[A-Za-z0-9-]{1,64}$/

export interface MediaMeta { id: string; chatId: string; userId: string; integrationId: string; size: number; sha256: string; kind: FileKind['name'] | null; declared: string; createdAt: number }
export interface MediaItem { file: string; meta: MediaMeta }

const root = (dataDir: string) => path.join(dataDir, 'connection-media')
const chatDir = (dataDir: string, chatId: string) => path.join(root(dataDir), chatId)

function items(dir: string): MediaMeta[] {
  let names: string[] = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out: MediaMeta[] = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as MediaMeta) } catch { /* half-written: the sweep takes it */ }
  }
  return out
}
function drop(dir: string, id: string) {
  fs.rmSync(path.join(dir, `${id}.bin`), { force: true })
  fs.rmSync(path.join(dir, `${id}.json`), { force: true })
}

/** Every kept item across all chats (its folder and meta), expired ones dropped on the way. */
function allItems(dataDir: string, now: number): { dir: string; meta: MediaMeta }[] {
  let chats: string[] = []
  try { chats = fs.readdirSync(root(dataDir)) } catch { return [] }
  const out: { dir: string; meta: MediaMeta }[] = []
  for (const c of chats) {
    const dir = path.join(root(dataDir), c)
    for (const m of items(dir)) {
      if (now - m.createdAt > MEDIA_TTL_MS) { drop(dir, m.id); continue }
      out.push({ dir, meta: m })
    }
  }
  return out
}

/** Drop the oldest items that match `pick` until adding `incoming` bytes would fit under `cap`. */
function evictToFit(all: { dir: string; meta: MediaMeta }[], pick: (m: MediaMeta) => boolean, cap: number, incoming: number): { dir: string; meta: MediaMeta }[] {
  let total = all.reduce((n, x) => n + (pick(x.meta) ? x.meta.size : 0), 0)
  if (total + incoming <= cap) return all
  const gone = new Set<string>()
  for (const x of all.filter((y) => pick(y.meta)).sort((a, b) => a.meta.createdAt - b.meta.createdAt)) {
    if (total + incoming <= cap) break
    drop(x.dir, x.meta.id); gone.add(x.meta.id); total -= x.meta.size
  }
  return all.filter((x) => !gone.has(x.meta.id))
}

/** Keep one inline item for this chat; the handle (mcp-file:<id>) and what the bytes are (sniffed, not declared). */
export function putMedia(dataDir: string, o: { chatId: string; userId: string; integrationId: string; bytes: Buffer; declared: string }, limits: { chat?: number; user?: number; total?: number } = {}): MediaMeta | null {
  const chatMax = limits.chat ?? MEDIA_CHAT_MAX
  const userMax = limits.user ?? MEDIA_USER_MAX
  const totalMax = limits.total ?? MEDIA_TOTAL_MAX
  if (!CHAT.test(o.chatId) || !o.bytes.length || o.bytes.length > chatMax) return null
  const dir = chatDir(dataDir, o.chatId)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // expired ones first, then the oldest until the new one fits
  const now = Date.now()
  const kept = items(dir).filter((m) => { if (now - m.createdAt > MEDIA_TTL_MS) { drop(dir, m.id); return false } return true }).sort((a, b) => a.createdAt - b.createdAt)
  let total = kept.reduce((n, m) => n + m.size, 0)
  while (kept.length && total + o.bytes.length > chatMax) { const m = kept.shift()!; drop(dir, m.id); total -= m.size }
  // then across chats: this person's total, and the whole server's (the new item is not written yet, so it is not in
  // `all`; a single item is capped at chatMax, well under both caps, so it always fits after eviction)
  let all = allItems(dataDir, now)
  all = evictToFit(all, (m) => m.userId === o.userId, userMax, o.bytes.length)
  evictToFit(all, () => true, totalMax, o.bytes.length)
  const id = crypto.randomBytes(16).toString('base64url')
  const meta: MediaMeta = {
    id, chatId: o.chatId, userId: o.userId, integrationId: o.integrationId, size: o.bytes.length,
    sha256: crypto.createHash('sha256').update(o.bytes).digest('hex'), kind: sniffKind(o.bytes.subarray(0, 64))?.name ?? null,
    declared: o.declared.slice(0, 100), createdAt: now,
  }
  fs.writeFileSync(path.join(dir, `${id}.bin`), o.bytes, { mode: 0o600, flag: 'wx' })
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(meta), { mode: 0o600, flag: 'wx' })
  return meta
}

/** The item behind a handle, for this chat and this person only; null when there is none (or not theirs, or expired). */
export function getMedia(dataDir: string, chatId: string, userId: string, handle: string): MediaItem | null {
  const id = handle.startsWith(MEDIA_PREFIX) ? handle.slice(MEDIA_PREFIX.length) : ''
  if (!ID.test(id) || !CHAT.test(chatId)) return null
  const dir = chatDir(dataDir, chatId)
  let meta: MediaMeta
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')) as MediaMeta } catch { return null }
  if (meta.id !== id || meta.chatId !== chatId || meta.userId !== userId || Date.now() - meta.createdAt > MEDIA_TTL_MS) return null
  const file = path.join(dir, `${id}.bin`)
  try { const st = fs.lstatSync(file); if (!st.isFile() || st.size !== meta.size) return null } catch { return null }
  return { file, meta }
}

/** Remove expired items and empty chat folders (the hourly sweep of component C). Returns how many items went. */
export function sweepMedia(dataDir: string, now = Date.now()): number {
  let n = 0
  let chats: string[] = []
  try { chats = fs.readdirSync(root(dataDir)) } catch { return 0 }
  for (const c of chats) {
    const dir = path.join(root(dataDir), c)
    let names: string[] = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      const p = path.join(dir, name)
      try { if (now - fs.lstatSync(p).mtimeMs > MEDIA_TTL_MS) { fs.rmSync(p, { force: true, recursive: true }); if (name.endsWith('.bin')) n++ } } catch { /* gone */ }
    }
    try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir) } catch { /* not empty, or gone */ }
  }
  return n
}
