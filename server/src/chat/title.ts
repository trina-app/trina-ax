// Chat titles (docs/DECISIONS.md "Chat titles"). A new chat first gets a placeholder from the first message: its first
// meaningful line, without addresses, code fences, markdown or anything that looks like a secret (a pasted admin
// token became a chat title on screen, 2026-10-28). The AI that answers then names the chat with the set_title tool
// (tools.ts), offered only while the title is still automatic, in the chat's first two messages and never in a
// scheduled run. A rename by the person ends that for good. Where a title came from is chats.title_source:
// 'auto' | 'ai' | 'user' | 'schedule' | 'legacy' (made before the column existed; never renamed by the AI).
import type { Database } from 'bun:sqlite'
import type { Attachment } from '@mycel/shared/api'
import { hasSecret, maskSecrets } from '@mycel/shared'

/** Placeholder length in graphemes (the sidebar shows about this much). */
export const PLACEHOLDER_MAX = 40
/** The AI's title: 2–60 characters. */
export const AI_TITLE_MIN = 2
export const AI_TITLE_MAX = 60
/** set_title is offered in the chat's first this-many user messages (the first may be only a greeting). */
export const AI_TITLE_MESSAGES = 2

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
export const graphemes = (s: string): string[] => Array.from(segmenter.segment(s), (x) => x.segment)

// line breaks, control characters, zero-width spaces and the marks that turn text direction around (a title could
// read backwards); the zero-width (non-)joiners stay: emoji sequences and some scripts need them
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g
const URL = /\b(?:https?|ftp):\/\/[^\s<>()"'`]+/gi
const MEANINGFUL = /[\p{L}\p{N}]/u
const hostOf = (u: string) => { try { return new globalThis.URL(u).hostname } catch { return '' } }

/** One line without its markdown: headings, quotes, list markers, links (their text), emphasis and code marks, tags. */
function stripMarkdown(line: string): string {
  return line
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:(?:#{1,6}|>)\s*)+/, '')
    .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/\*\*|__|~~|`+/g, '')
    .replace(/\|/g, ' ')
}

/** Spaces collapsed, stray symbols off both ends (what masking and markdown leave behind). */
function tidy(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
    .replace(/^[\s\-–—:;,.=|>•·*#~+]+/u, '')
    .replace(/[\s\-–—:;,=|•·*#~+.。、]+$/u, '')
}

/** At most `max` graphemes: a first sentence that fits, else up to a space, else a hard cut; "…" when shortened. */
export function cutTitle(s: string, max: number): string {
  const g = graphemes(s)
  if (g.length <= max) return s
  const head = g.slice(0, max).join('')
  const sentence = /^(.{8,}?[.!?。！？])(?:\s|$)/u.exec(head)
  if (sentence) return tidy(sentence[1]!) || sentence[1]!
  const text = g.slice(0, max - 1).join('')
  const space = text.lastIndexOf(' ')
  return (space >= text.length / 2 ? text.slice(0, space) : text).replace(/[\s\-–—:;,.]+$/u, '') + '…'
}

/** A line as a title, or null when it is not worth one: empty, only symbols or an address, or mostly a secret. */
function lineTitle(line: string): string | null {
  let s = stripMarkdown(line.replace(INVISIBLE, ' '))
  if (!MEANINGFUL.test(s.replace(URL, ''))) return null
  // an address becomes its host: never its path, query or credentials
  s = s.replace(URL, hostOf)
  const secret = hasSecret(s)
  if (secret) s = maskSecrets(s, ' ')
  s = tidy(s)
  if (!MEANINGFUL.test(s)) return null
  // "키 aipm_… 연결해줘" keeps "키 연결해줘"; "Authorization: Bearer …" or "API_KEY=…" leave one word: skipped
  if (secret && s.split(' ').filter((w) => MEANINGFUL.test(w)).length < 2) return null
  return cutTitle(s, PLACEHOLDER_MAX)
}

/**
 * The placeholder title of a new chat from its first message: the first meaningful line outside code blocks (lines
 * inside them only when there is nothing else), else the name of an uploaded attachment (a team file's name is not
 * used: the title outlives the person's access to the file), else '' (the apps show "New chat" in their language).
 */
export function placeholderTitle(content: string, atts: Pick<Attachment, 'name' | 'source'>[] = []): string {
  const prose: string[] = [], code: string[] = []
  let fence = false, pem = false
  for (const raw of content.split(/\r?\n/)) {
    const l = raw.trim()
    if (/^(?:```|~~~)/.test(l)) { fence = !fence; continue }
    // a pasted private key: every line up to its END line
    if (/-----BEGIN[A-Z0-9 ]*-----/.test(l)) { pem = !/-----END[A-Z0-9 ]*-----/.test(l); continue }
    if (pem) { if (/-----END[A-Z0-9 ]*-----/.test(l)) pem = false; continue }
    ;(fence ? code : prose).push(l)
  }
  for (const l of [...prose, ...code]) {
    const t = lineTitle(l)
    if (t) return t
  }
  const file = atts.find((a) => a.source !== 'team')?.name
  return (file && lineTitle(file)) || ''
}

export type AiTitle = { ok: true; title: string } | { ok: false; reason: 'secret' | 'empty' }

/** The AI's proposed title made safe to show: one line, no markdown, quotes or trailing punctuation; refused when it
 * holds anything that looks like a secret (the AI may try again without it). */
export function cleanAiTitle(raw: string): AiTitle {
  if (hasSecret(raw)) return { ok: false, reason: 'secret' }
  let s = stripMarkdown(raw.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim()).replace(URL, hostOf)
  s = tidy(s)
  for (let i = 0; i < 2; i++) {
    const q = /^(["'“‘«「『])([\s\S]*)(["'”’»」』])$/u.exec(s)
    if (q) s = tidy(q[2]!)
  }
  s = s.replace(/[\s.。!！?？…]+$/u, '')
  if (hasSecret(s)) return { ok: false, reason: 'secret' }
  if (graphemes(s).length < AI_TITLE_MIN || !MEANINGFUL.test(s)) return { ok: false, reason: 'empty' }
  return { ok: true, title: cutTitle(s, AI_TITLE_MAX) }
}

/** Whether this turn may name the chat (set_title): the title is still automatic, the chat is at its first or second
 * message, and nobody is reading along live in a scheduled run. */
export function titleToolOffered(db: Database, chatId: string, clientKind: string | null): boolean {
  if (clientKind === 'schedule') return false
  const r = db.query(`SELECT title_source AS s, (SELECT COUNT(*) FROM messages WHERE chat_id = chats.id AND role = 'user') AS n
    FROM chats WHERE id = ? AND deleted_at IS NULL`).get(chatId) as { s: string; n: number } | null
  return !!r && r.s === 'auto' && r.n <= AI_TITLE_MESSAGES
}

/** The AI's title, only while the title is still automatic (a rename by the person in the meantime wins). */
export function setAiTitle(db: Database, chatId: string, title: string): boolean {
  return db.query("UPDATE chats SET title = ?, title_source = 'ai' WHERE id = ? AND title_source = 'auto' AND deleted_at IS NULL").run(title, chatId).changes > 0
}

export const TITLE_SCAN_KEY = 'chat.titleSecretScan'
export const TITLE_SCAN_VERSION = 1

/**
 * Once per detector version, at server start: titles of existing chats that look like they hold a secret are masked;
 * one with nothing left gets the placeholder of its first message again (the founder's chat named after a token gets
 * his next line). Other titles stay as they are. Returns the number of titles changed.
 */
export function maskStoredTitles(db: Database): number {
  const done = db.query('SELECT value FROM settings WHERE key = ?').get(TITLE_SCAN_KEY) as { value: string } | null
  if (done && Number(JSON.parse(done.value)) >= TITLE_SCAN_VERSION) return 0
  let n = 0
  db.transaction(() => {
    for (const r of db.query("SELECT id, title FROM chats WHERE title <> ''").all() as { id: string; title: string }[]) {
      if (!hasSecret(r.title)) continue
      let title = lineTitle(r.title)
      if (!title) {
        const first = db.query("SELECT content, attachments FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY created_at, id LIMIT 1")
          .get(r.id) as { content: string; attachments: string } | null
        let atts: Attachment[] = []
        try { atts = first ? JSON.parse(first.attachments) : [] } catch {}
        title = first ? placeholderTitle(first.content, Array.isArray(atts) ? atts : []) : ''
      }
      db.query('UPDATE chats SET title = ? WHERE id = ?').run(title, r.id)
      n++
    }
    db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(TITLE_SCAN_KEY, JSON.stringify(TITLE_SCAN_VERSION))
  })()
  return n
}
