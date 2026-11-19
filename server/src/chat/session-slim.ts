// A saved Claude session kept small (docs/decisions/20261118-limits-context-summary.md). The engine's session file
// holds every picture it saw as base64, so a few answers with pictures made it pass the old 20 MB cap and the chat
// started over from its text. Now, over SESSION_SLIM_AT, pictures of the older turns are replaced by a short note,
// oldest first, until it is at most SESSION_SLIM_TO; the newest turn (from the person's last message on) keeps its
// pictures, so a follow-up about the picture just sent still sees it. The AI reads a file again to look at it.
// The session stays valid: an image block becomes a text block in the same place. Checked with the shipped Claude Code
// (2.1.305, scripts/linux/engines.lock.json) on 2026-11-18: a session whose image Read (message.content and its
// toolUseResult copy) was slimmed resumed with --resume, and the AI saw the note in place of the picture.

/** a saved session over this is slimmed */
export const SESSION_SLIM_AT = 8 * 1024 * 1024
/** ... down to this, when its older turns have enough pictures */
export const SESSION_SLIM_TO = 4 * 1024 * 1024
export const PICTURE_REMOVED = '[A picture was here. It was taken out of the saved conversation to keep it small; to look at it again, open the file again.]'

/** an image block (Anthropic: source.base64; MCP: data; Claude Code's Read result: file.base64) that carries its bytes */
function isPicture(v: Record<string, unknown>): boolean {
  if (v.type !== 'image') return false
  const src = v.source as { data?: unknown } | undefined
  const file = v.file as { base64?: unknown } | undefined
  return typeof src?.data === 'string' || typeof v.data === 'string' || typeof file?.base64 === 'string'
}

function strip(v: unknown, n: { removed: number }): unknown {
  if (Array.isArray(v)) return v.map((x) => strip(x, n))
  if (!v || typeof v !== 'object') return v
  const o = v as Record<string, unknown>
  if (isPicture(o)) { n.removed++; return { type: 'text', text: PICTURE_REMOVED } }
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(o)) out[k] = strip(x, n)
  return out
}

/** text the engine writes as a user line itself (an interruption, a slash command's echo), not the person's message */
const ENGINE_USER_TEXT = /^\s*(\[Request interrupted|<command-|<local-command-|<bash-|<user-memory-input>|Caveat: )/
/** the person's own message: a user line with text and no tool result, not one the engine wrote for itself (meta,
 * compact summary, transcript-only, a tool's follow-up, an interruption) */
function isPrompt(o: unknown): boolean {
  if (!o || typeof o !== 'object') return false
  const l = o as Record<string, unknown> & { message?: { role?: unknown; content?: unknown } }
  if (l.type !== 'user' || l.message?.role !== 'user') return false
  if (l.isMeta === true || l.isCompactSummary === true || l.isVisibleInTranscriptOnly === true || l.toolUseResult !== undefined || l.sourceToolUseID !== undefined) return false
  const c = l.message.content
  const texts = typeof c === 'string' ? [c] : Array.isArray(c)
    ? (c.some((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result') ? null
      : c.filter((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text').map((b) => String((b as { text?: unknown }).text ?? '')))
    : null
  if (!texts || !texts.some((t) => t.trim())) return false
  return !texts.every((t) => ENGINE_USER_TEXT.test(t))
}

/**
 * The session with the pictures of its older turns taken out (oldest first) until it is at most `to` bytes. Unchanged
 * when it is not over `at`, or has no such pictures. `removed`: how many pictures were taken out.
 */
export function slimSession(bytes: Buffer, at = SESSION_SLIM_AT, to = SESSION_SLIM_TO): { bytes: Buffer; removed: number } {
  if (bytes.length <= at || !bytes.includes('"image"')) return { bytes, removed: 0 }
  const lines = bytes.toString('utf8').split('\n')
  const parsed: unknown[] = lines.map((l) => { if (!l.trim()) return null; try { return JSON.parse(l) } catch { return null } })
  let last = -1
  for (let i = parsed.length - 1; i >= 0; i--) if (isPrompt(parsed[i])) { last = i; break }
  let size = bytes.length
  const n = { removed: 0 }
  for (let i = 0; i < (last < 0 ? 0 : last) && size > to; i++) {
    const line = lines[i]!
    if (!parsed[i] || !line.includes('"image"')) continue
    const before = n.removed
    const next = JSON.stringify(strip(parsed[i], n))
    if (n.removed === before) continue
    size += Buffer.byteLength(next) - Buffer.byteLength(line)
    lines[i] = next
  }
  return n.removed ? { bytes: Buffer.from(lines.join('\n'), 'utf8'), removed: n.removed } : { bytes, removed: 0 }
}

/**
 * The pictures a saved session carries into the next request, each once: the image blocks of its messages (base64
 * characters and how many), not the copies Claude Code keeps beside them (toolUseResult). A resumed session sends all
 * of them again with every request (files/vision.ts turnImageCaps counts them against the turn's caps).
 */
export function sessionPictures(bytes: Buffer): { count: number; bytes: number } {
  const out = { count: 0, bytes: 0 }
  if (!bytes.includes('"image"')) return out
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return }
    if (!v || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    if (o.type === 'image') {
      const d = (o.source as { data?: unknown } | undefined)?.data ?? o.data
      if (typeof d === 'string') { out.count++; out.bytes += d.length; return }
    }
    for (const x of Object.values(o)) walk(x)
  }
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line.includes('"image"')) continue
    try { walk((JSON.parse(line) as { message?: unknown }).message) } catch {}
  }
  return out
}
