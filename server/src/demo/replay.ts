// Demo replays (docs/DECISIONS.md "Demo company: a new hire at 트리나", round 2). On a demo server (MYCEL_DEMO with a
// `replays` folder), a demo person's first message in a new chat that is exactly the prompt of one of their recorded
// real answers (scripts/demo/company/record.ts) is answered by playing that answer again instead of starting an engine:
// the same text, and every team tool call made again through this turn's own tools (the same handler the API engine
// uses), as this person, now. So the files read are read with their permissions and the files, artifacts and tasks the
// answer shows are made by the product during the replay; only the model's choices come from the recording. The
// engine's own tools (a to-do list, a tool search) are shown as they were. A replay needs no AI and takes seconds.
// The answer's step trail says it was prepared in advance (a `demo_replay` step, shown in the expanded trail).
//
// Never off a demo server: demoReplayFor checks the same conditions as the demo routes (development mode, not hosted,
// not office) besides the flag.
import fs from 'node:fs'
import path from 'node:path'
import { TEAM_TOOL_PREFIX, type EngineEvent } from '@mycel/shared'
import { DemoRecording } from '@mycel/shared/api'
import type { Database } from 'bun:sqlite'
import type { AppContext } from '../context'

export const DEMO_REPLAY_TOOL = 'demo_replay'

/** the team tools whose call makes a file: the file is renamed when it is already there (a second replay) */
const FILE_TARGETS: Record<string, string> = { write: 'file_path', make_file: 'output' }
/** the team tools that fill a folder that must exist already: never renamed themselves, only moved along when they are
 * inside a folder the answer made (below) */
const FOLDER_TARGETS: Record<string, string> = { copy_files: 'to_folder' }

const norm = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim()

let cache: { dir: string; stamp: string; items: DemoRecording[] } | null = null

/** The recordings in `dir` (each *.json a DemoRecording; a file that is not one is skipped with a warning). */
export function loadRecordings(dir: string, warn: (m: string) => void = () => {}): DemoRecording[] {
  let names: string[]
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort() } catch { return [] }
  const stamp = names.map((n) => { try { return `${n}:${fs.statSync(path.join(dir, n)).mtimeMs}` } catch { return n } }).join('|')
  if (cache && cache.dir === dir && cache.stamp === stamp) return cache.items
  const items: DemoRecording[] = []
  for (const n of names) {
    try {
      const r = DemoRecording.safeParse(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')))
      if (r.success) items.push(r.data)
      else warn(`demo recording ${n} is not a recording: ${r.error.issues[0]?.message ?? ''}`)
    } catch (e) { warn(`demo recording ${n} cannot be read: ${(e as Error).message}`) }
  }
  cache = { dir, stamp, items }
  return items
}

/** The recording this message replays, or null (not a demo server, not a demo person's first message, no match). */
export function demoReplayFor(ctx: AppContext, q: { username: string; content: string; first: boolean; scheduled: boolean; attachments: boolean }): DemoRecording | null {
  const d = ctx.config.demo
  if (!d?.replays || ctx.config.mode !== 'dev' || ctx.config.deployment === 'hosted' || ctx.config.office) return null
  if (!q.first || q.scheduled || q.attachments) return null
  if (!d.personas.some((p) => p.username.toLowerCase() === q.username.toLowerCase())) return null
  const want = norm(q.content)
  return loadRecordings(d.replays, (m) => ctx.log.warn(m)).find((r) => r.username.toLowerCase() === q.username.toLowerCase() && norm(r.prompt) === want) ?? null
}

type Rpc = (msg: unknown) => Promise<any>
export interface ReplayIo {
  rpc: Rpc
  emit: (e: EngineEvent) => void
  signal: AbortSignal
  /** the person's id now (their folder users/<id>/) */
  userId: string
  /** is there a file at this team path now */
  exists: (rel: string) => boolean
  /** no pauses and the text at once (a seeded past chat) */
  fast?: boolean
  sleep?: (ms: number) => Promise<void>
}

/** A free name next to `rel`: "보고서.xlsx" -> "보고서-2.xlsx", "-3" … */
export function freeName(rel: string, exists: (rel: string) => boolean): string {
  if (!exists(rel)) return rel
  const m = /^(.*?)(\.[^./]+)?$/.exec(rel)!
  for (let i = 2; i < 1000; i++) { const c = `${m[1]}-${i}${m[2] ?? ''}`; if (!exists(c)) return c }
  return rel
}

/** The pause before an event, from the recorded pace: about a third of it, at least a moment, at most a breath. */
export const replayPause = (gapMs: number) => Math.min(1800, Math.max(150, Math.round(gapMs * 0.3)))
/** Text arrives in small pieces, like an answer being written. */
export const TEXT_PIECE = 28
export const TEXT_PIECE_MS = 30

/**
 * Play a recording through the turn: text events and tool events, the team tools called for real through `rpc`.
 * Returns how many team tool calls failed (a recording made against files that are gone, say).
 */
export async function runReplay(rec: DemoRecording, io: ReplayIo): Promise<{ failed: number }> {
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  // paths of the recorded run that are someone else's here: the person's own folder, and files a replay before made
  const swaps = new Map<string, string>()
  if (rec.userId !== io.userId) swaps.set(`users/${rec.userId}/`, `users/${io.userId}/`)
  // a path in the text may also be a link (/files/view?path=<encoded>): both forms are swapped
  const swap = (s: string) => {
    for (const [a, b] of swaps) s = s.split(a).join(b).split(encodeURIComponent(a)).join(encodeURIComponent(b))
    return s
  }
  const swapDeep = (v: unknown): unknown => JSON.parse(swap(JSON.stringify(v ?? {})))
  // files the answer makes that are there already (the same showcase a second time): the next free name, before the
  // first word of the answer, so the text that names a file before making it says the new name too
  const files: string[] = []
  const folders: string[] = []
  for (const e of rec.events) {
    if (e.type !== 'tool' || !e.name.startsWith(TEAM_TOOL_PREFIX)) continue
    const bare = e.name.slice(TEAM_TOOL_PREFIX.length)
    const input = e.input && typeof e.input === 'object' ? (e.input as Record<string, unknown>) : {}
    const file = FILE_TARGETS[bare] ? input[FILE_TARGETS[bare]] : undefined
    const folder = FOLDER_TARGETS[bare] ? input[FOLDER_TARGETS[bare]] : undefined
    if (typeof file === 'string') files.push(file)
    if (typeof folder === 'string') folders.push(`${folder.replace(/\/+$/, '')}/x`)
  }
  // a folder the answer made in the person's own folder (users/<id>/<folder>/…: personal folders start empty in the
  // demo) that is there already: the whole folder gets the next free name
  const own = `users/${io.userId}/`
  for (const t of [...files, ...folders]) {
    const now = swap(t)
    if (!now.startsWith(own)) continue
    const parts = now.slice(own.length).split('/')
    if (parts.length < 2) continue
    const folder = own + parts[0]
    if (swaps.has(`${folder}/`) || !io.exists(folder)) continue
    swaps.set(`${folder}/`, `${freeName(folder, io.exists)}/`)
  }
  const planned = new Set<string>()
  for (const target of files) {
    const now = swap(target)
    if (planned.has(now)) continue
    const free = freeName(now, (rel) => io.exists(rel) || (rel !== now && planned.has(rel)))
    planned.add(free)
    if (free !== now) {
      swaps.set(now, free)
      // the answer often names the file alone ("[B사-제안서.pptx](…)"): the new name there too
      const base = now.slice(now.lastIndexOf('/') + 1), freeBase = free.slice(free.lastIndexOf('/') + 1)
      if (base.includes('.')) swaps.set(base, freeBase)
    }
  }
  let failed = 0
  let last = 0
  let n = 0
  // separate text blocks are separated by a blank line, as the Claude stream parser does (engine/claude-parse.ts)
  let written = ''
  for (const e of rec.events) {
    if (io.signal.aborted) break
    if (!io.fast) await sleep(replayPause(e.t - last))
    last = e.t
    if (e.type === 'text') {
      const text = (written && !written.endsWith('\n\n') ? '\n\n' : '') + swap(e.text)
      written += text
      if (io.fast) { io.emit({ type: 'text', delta: text }); continue }
      for (let i = 0; i < text.length && !io.signal.aborted; i += TEXT_PIECE) {
        io.emit({ type: 'text', delta: text.slice(i, i + TEXT_PIECE) })
        await sleep(TEXT_PIECE_MS)
      }
      continue
    }
    const id = `replay-${++n}`
    const team = e.name.startsWith(TEAM_TOOL_PREFIX)
    const bare = team ? e.name.slice(TEAM_TOOL_PREFIX.length) : e.name
    const input = swapDeep(e.input)
    io.emit({ type: 'tool_start', id, name: e.name, summary: bare, input })
    if (!team) {
      if (!io.fast && e.ms) await sleep(Math.min(1200, Math.round(e.ms * 0.3)))
      io.emit({ type: 'tool_end', id, ok: e.ok, ...(e.output !== undefined ? { output: swap(e.output) } : {}) })
      continue
    }
    let ok = false
    let out = ''
    try {
      const res = await io.rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: bare, arguments: input, _meta: { 'claudecode/toolUseId': id } } })
      try { res?.beforeDelivery?.() } catch { /* the person lost access meanwhile: the result is not used */ }
      out = (res?.result?.content ?? []).map((x: { text?: string }) => x.text ?? '').join('\n') || (res?.error ? `Error: ${res.error.message}` : '')
      ok = !res?.result?.isError && !res?.error
    } catch (err) {
      out = `Error: the tool failed: ${String((err as Error)?.message ?? err).slice(0, 300)}`
    }
    if (!ok) failed++
    io.emit({ type: 'tool_end', id, ok, output: out.slice(0, 4000) })
  }
  io.emit({ type: 'done' })
  return { failed }
}

/** A seeded past chat says it was `days` days ago (its messages keep their order and spacing). */
export function backdateChat(db: Database, chatId: string, days: number): void {
  const shift = (iso: string | null) => iso ? new Date(Date.parse(iso) - days * 86_400_000).toISOString() : iso
  const chat = db.query('SELECT created_at, updated_at FROM chats WHERE id = ?').get(chatId) as { created_at: string; updated_at: string } | null
  if (!chat) return
  db.transaction(() => {
    db.query('UPDATE chats SET created_at = ?, updated_at = ? WHERE id = ?').run(shift(chat.created_at), shift(chat.updated_at), chatId)
    for (const m of db.query('SELECT id, created_at, updated_at FROM messages WHERE chat_id = ?').all(chatId) as { id: string; created_at: string; updated_at: string | null }[]) {
      db.query('UPDATE messages SET created_at = ?, updated_at = ? WHERE id = ?').run(shift(m.created_at), shift(m.updated_at), m.id)
    }
  })()
}
