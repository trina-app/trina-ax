// Where a web_fetch URL came from (design tab 7 "프롬프트 주입", tab 3 web_fetch): a GET can carry data out in its
// address (https://attacker/?d=<secret>), and the AI that calls web_fetch may be following instructions hidden in a
// team document. So the server, not the AI, decides when a person must confirm the full URL first:
//   ① opened without asking: URLs that appear verbatim in what the person typed in this chat (user messages), in
//     web search results of this chat (this turn's and the saved steps of earlier answers), or in an earlier
//     web_fetch result of this chat (chat_seen_urls);
//   ② any other URL: a confirmation card with the full URL, raised by the server inside the tool call;
//   ③ also a card when the query string is longer than 200 characters, even for a URL from ①.
// Not done here (follow-up): the "32 characters in common with a file read in this chat" check of ③ and the admin
// allow-list of ④.
import type { Database } from 'bun:sqlite'
import type { Locale } from '@mycel/shared/api'
import { ToolError } from '../policy/errors'

/** ③: a query string this long always needs a person, wherever the URL came from */
export const MAX_UNCONFIRMED_QUERY = 200
/** links of one fetched page remembered for later turns of the chat */
export const MAX_SEEN_PER_FETCH = 500

/** The URL as compared: parsed, without the #fragment (never sent). null for anything that is not http(s). */
export function normUrl(raw: string): string | null {
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  u.hash = ''
  return u.href
}

const URL_START = /https?:\/\//gi
const STOP = new Set([...' \t\r\n<>"\'`'])
const TRAIL = new Set([...'.,;:!?)]}\'"*_'])

/** Every http(s) URL written out in a text (one forward scan, no backtracking). */
export function extractUrls(text: string, max = 10_000): string[] {
  const out: string[] = []
  URL_START.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_START.exec(text)) && out.length < max) {
    let end = m.index + m[0].length
    while (end < text.length && !STOP.has(text[end]!) && text.charCodeAt(end) > 0x20) end++
    let s = text.slice(m.index, end)
    URL_START.lastIndex = end
    // "(see https://x.example/a)." and markdown "[t](https://x.example/a)": drop closing punctuation, but keep a
    // ")" that closes a "(" inside the URL (wikipedia-style paths)
    while (s.length && TRAIL.has(s[s.length - 1]!)) {
      if (s.endsWith(')') && s.split('(').length >= s.split(')').length) break
      s = s.slice(0, -1)
    }
    const n = normUrl(s)
    if (n) out.push(n)
  }
  return out
}

/** The person behind a chat turn, as far as a tool needs them. */
export interface TurnPerson {
  locale: Locale
  /** Show a yes / no card to the person (raised by the server, never by the AI); false = declined or no answer. */
  confirm(question: string, allow: string, deny: string): Promise<boolean>
  /** URLs of web search results seen so far in this turn (not saved to the answer yet) */
  turnUrls(): Iterable<string>
}

/** ① sources of a chat. */
export function chatUrls(db: Database, chatId: string): Set<string> {
  const seen = new Set<string>()
  for (const r of db.query("SELECT content FROM messages WHERE chat_id = ? AND role = 'user'").all(chatId) as { content: string }[]) {
    for (const u of extractUrls(r.content)) seen.add(u)
  }
  for (const r of db.query(`SELECT steps FROM messages WHERE chat_id = ? AND role = 'assistant' AND steps LIKE '%"sources"%'`).all(chatId) as { steps: string }[]) {
    let steps: unknown
    try { steps = JSON.parse(r.steps) } catch { continue }
    if (!Array.isArray(steps)) continue
    for (const s of steps) {
      for (const src of (s as { sources?: { url?: unknown }[] })?.sources ?? []) {
        const n = typeof src?.url === 'string' ? normUrl(src.url) : null
        if (n) seen.add(n)
      }
    }
  }
  for (const r of db.query('SELECT url FROM chat_seen_urls WHERE chat_id = ?').all(chatId) as { url: string }[]) seen.add(r.url)
  return seen
}

/** Remember URLs for later turns of the chat (links of a fetched page, a URL the person allowed). */
export function rememberUrls(db: Database, chatId: string, urls: Iterable<string>) {
  const ins = db.query('INSERT OR IGNORE INTO chat_seen_urls (chat_id, url) VALUES (?, ?)')
  db.transaction(() => {
    let n = 0
    for (const u of urls) {
      if (n++ >= MAX_SEEN_PER_FETCH) break
      if (u.length <= 4000) ins.run(chatId, u)
    }
  })()
}

const TEXT = {
  unseen: {
    ko: 'AI가 이 대화에 나온 적 없는 주소를 열려고 합니다. 주소에 내용을 실어 밖으로 보낼 수도 있으니 주소 전체를 확인해 주세요.\n\n{url}',
    en: 'The AI wants to open an address that did not appear in this conversation. An address can carry data out, so check the whole address:\n\n{url}',
    id: 'AI ingin membuka alamat yang tidak muncul di percakapan ini. Alamat bisa membawa data keluar, jadi periksa seluruh alamatnya:\n\n{url}',
  },
  longQuery: {
    ko: 'AI가 여는 주소 뒤에 긴 내용이 붙어 있습니다. 내용을 실어 밖으로 보낼 수도 있으니 주소 전체를 확인해 주세요.\n\n{url}',
    en: 'The address the AI wants to open carries a long query. An address can carry data out, so check the whole address:\n\n{url}',
    id: 'Alamat yang ingin dibuka AI membawa kueri panjang. Alamat bisa membawa data keluar, jadi periksa seluruh alamatnya:\n\n{url}',
  },
  allow: { ko: '열기', en: 'Open', id: 'Buka' },
  deny: { ko: '열지 않기', en: 'Don’t open', id: 'Jangan buka' },
} as const

export type GateResult = 'seen' | 'confirmed'

/**
 * Throws ToolError unless the URL may be fetched. `person` is null outside a chat turn (no one to ask): then only ①
 * URLs pass.
 */
export async function gateUrl(db: Database, chatId: string | null, rawUrl: string, person: TurnPerson | null): Promise<GateResult> {
  const url = normUrl(rawUrl)
  if (!url) throw new ToolError('only http and https URLs can be fetched')
  const query = new URL(url).search.slice(1)
  const long = query.length > MAX_UNCONFIRMED_QUERY
  if (!long) {
    if (person) for (const u of person.turnUrls()) if (normUrl(u) === url) return 'seen'
    if (chatId && chatUrls(db, chatId).has(url)) return 'seen'
  }
  if (!person) throw new ToolError('this address did not appear in the conversation and nobody can confirm it here, so it was not opened')
  const L = person.locale
  const question = TEXT[long ? 'longQuery' : 'unseen'][L].replace('{url}', url.length > 2000 ? url.slice(0, 2000) + '…' : url)
  if (!(await person.confirm(question, TEXT.allow[L], TEXT.deny[L]))) {
    throw new ToolError('the user did not allow opening this address. Do not try other addresses to get around this; tell the user what you could not do')
  }
  if (chatId && !long) rememberUrls(db, chatId, [url])
  return 'confirmed'
}
