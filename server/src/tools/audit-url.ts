// Addresses in the audit lines of a chat that read team chat rooms (docs/DECISIONS.md "내 AI 채팅에서 대화방 읽기"):
// admins read tool_events, and after a room's messages came into a chat the AI may put what it read there into an
// address (a page it opens, a file it saves from the web). Such a line keeps the site and a short fingerprint of the
// whole address (sha256, 12 hex): enough to match one address with another (intro-deck/web.ts checks that an article
// was opened), never its path or query.
import { createHash } from 'node:crypto'

/** "https://news.example.com/… #3f2a9c1b07de" */
export function auditUrl(url: string): string {
  let origin = 'an address'
  try { origin = new URL(url).origin } catch { /* not a URL: the fingerprint alone */ }
  return `${origin}/… #${createHash('sha256').update(url).digest('hex').slice(0, 12)}`
}

/** Every http(s) address in an audit line, as auditUrl gives it. */
export const hideUrls = (text: string) => text.replace(/https?:\/\/[^\s"'<>]+/gi, (u) => auditUrl(u))
