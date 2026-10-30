// Where a web_fetch URL came from (design tab 7 "프롬프트 주입", tab 3 web_fetch): a GET can carry data out in its
// address (https://attacker/?d=<secret>), and the AI that calls web_fetch may be following instructions hidden in a
// team document. So the server, not the AI, decides when a person must confirm the full URL first:
//   ① opened without asking: URLs that appear verbatim in what the person typed in this chat (user messages; not the
//     messages a scheduled run sent for them, whose text the AI wrote: auto_sent), URLs the person allowed on a card
//     (chat_seen_urls 'allowed', also those a scheduled task's card carried into its run), and learned links: web
//     search results of this chat (this turn's and the saved steps of earlier answers) and links of an earlier
//     web_fetch result of this chat. Learned links are within a budget: which link the AI picks can carry data out
//     (about 9 bits a pick), and a search result can bring in an attacker's page without any card, so at most
//     LINK_BUDGET.turn new ones per answer and LINK_BUDGET.chat per chat open without asking (docs/DECISIONS.md
//     "Outbound web channels"); then each new one needs the person;
//   ② any other URL: a confirmation card with the full URL, raised by the server inside the tool call;
//   ③ also a card when the query string is longer than 200 characters, even for a URL from ①;
//   and a card for every URL while the office's public exit address is unknown (tools/egress.ts).
// The caller looks nothing up in DNS before this says yes (tools/index.ts web_fetch, chat/tools.ts browser tools): a
// host name can carry data to the attacker's name server even when the person declines.
// Not done here (follow-up): the "32 characters in common with a file read in this chat" check of ③ and the admin
// allow-list of ④.
import type { Database } from 'bun:sqlite'
import type { ConfirmDetail, Locale } from '@mycel/shared/api'
import { ToolError } from '../policy/errors'

/** ③: a query string this long always needs a person, wherever the URL came from */
export const MAX_UNCONFIRMED_QUERY = 200
/** links of one fetched page remembered for later turns of the chat */
export const MAX_SEEN_PER_FETCH = 500

/** Learned links (search results, links of fetched pages) the AI may open without a card: per answer, per chat.
 * Operators can change them with MYCEL_WEB_LINK_BUDGET="<per answer>,<per chat>" (e.g. "8,30"); 0 asks for every one. */
export function linkBudgetFrom(v: string | undefined): { turn: number; chat: number } {
  const m = /^\s*(\d{1,4})\s*,\s*(\d{1,4})\s*$/.exec(v ?? '')
  return m ? { turn: Number(m[1]), chat: Number(m[2]) } : { turn: 8, chat: 30 }
}
export const LINK_BUDGET = linkBudgetFrom(process.env.MYCEL_WEB_LINK_BUDGET)

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

/** What a server card shows besides its question: what is about to go out, in full (ConfirmDetail). */
export interface ConfirmExtra { details?: ConfirmDetail[] }

/** The person behind a chat turn, as far as a tool needs them. */
export interface TurnPerson {
  locale: Locale
  /** Show a yes / no card to the person (raised by the server, never by the AI); false = declined or no answer. */
  confirm(question: string, allow: string, deny: string, extra?: ConfirmExtra): Promise<boolean>
  /** A server card with more than two answers: the value picked, or null (declined, no answer). Optional: a caller
   * without it falls back to confirm() with its safest "yes". */
  choose?(question: string, options: { label: string; value: string }[], extra?: ConfirmExtra): Promise<string | null>
  /** URLs of web search results seen so far in this turn (not saved to the answer yet) */
  turnUrls(): Iterable<string>
}

/** Addresses written out in what the person typed in this chat (user messages the server did not send for them). A
 * scheduled turn's message counts as sent for them also without the mark: an older build run on this database (a
 * rollback) writes its runs unmarked. */
function typedUrls(db: Database, chatId: string): Set<string> {
  const seen = new Set<string>()
  for (const r of db.query(`SELECT content FROM messages WHERE chat_id = ? AND role = 'user' AND auto_sent = 0
    AND id NOT IN (SELECT user_message_id FROM turns WHERE chat_id = ? AND client_kind = 'schedule' AND user_message_id IS NOT NULL)`).all(chatId, chatId) as { content: string }[]) {
    for (const u of extractUrls(r.content)) seen.add(u)
  }
  return seen
}

/** Web search results saved in the steps of this chat's answers. */
function searchUrls(db: Database, chatId: string): Set<string> {
  const seen = new Set<string>()
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
  return seen
}

/** ① sources of a chat (all of them; the learned ones are within the link budget when opened). */
export function chatUrls(db: Database, chatId: string): Set<string> {
  const seen = typedUrls(db, chatId)
  for (const u of searchUrls(db, chatId)) seen.add(u)
  for (const r of db.query('SELECT url FROM chat_seen_urls WHERE chat_id = ?').all(chatId) as { url: string }[]) seen.add(r.url)
  return seen
}

type SeenRow = { source: string | null; free_turn_id: string | null }

/** Where an address of ① came from: typed by the person, allowed by the person, or learned (search result, link of a
 * fetched page); null = not in the conversation. */
function originOf(db: Database, chatId: string | null, url: string, person: TurnPerson | null): { origin: 'typed' | 'allowed' | 'learned'; row: SeenRow | null } | null {
  const row = chatId ? db.query('SELECT source, free_turn_id FROM chat_seen_urls WHERE chat_id = ? AND url = ?').get(chatId, url) as SeenRow | null : null
  if (chatId && typedUrls(db, chatId).has(url)) return { origin: 'typed', row }
  if (row?.source === 'allowed') return { origin: 'allowed', row }
  if (row) return { origin: 'learned', row }
  if (person) for (const u of person.turnUrls()) if (normUrl(u) === url) return { origin: 'learned', row }
  if (chatId && searchUrls(db, chatId).has(url)) return { origin: 'learned', row }
  return null
}

/** A learned address opened without a card: counted once per chat (the same address again is free). Synchronous, so
 * parallel calls of one answer cannot all pass the same last place. false = over the budget (the person decides). */
function spendLinkBudget(db: Database, chatId: string, url: string, turnId: string | null, row: SeenRow | null): boolean {
  if (row?.free_turn_id) return true
  if (url.length > 4000) return false
  const turn = turnId ?? ''
  const nTurn = (db.query('SELECT COUNT(*) AS n FROM chat_seen_urls WHERE chat_id = ? AND free_turn_id = ?').get(chatId, turn) as { n: number }).n
  const nChat = (db.query('SELECT COUNT(*) AS n FROM chat_seen_urls WHERE chat_id = ? AND free_turn_id IS NOT NULL').get(chatId) as { n: number }).n
  if (nTurn >= LINK_BUDGET.turn || nChat >= LINK_BUDGET.chat) return false
  db.query(`INSERT INTO chat_seen_urls (chat_id, url, source, free_turn_id) VALUES (?, ?, 'search', ?)
    ON CONFLICT (chat_id, url) DO UPDATE SET free_turn_id = excluded.free_turn_id`).run(chatId, url, turn)
  return true
}

/** Remember URLs for later turns of the chat: links of a fetched page ('fetched', within the link budget later) or
 * addresses the person allowed ('allowed', open without asking). */
export function rememberUrls(db: Database, chatId: string, urls: Iterable<string>, source: 'fetched' | 'allowed' = 'fetched') {
  const ins = source === 'allowed'
    ? db.query("INSERT INTO chat_seen_urls (chat_id, url, source) VALUES (?, ?, 'allowed') ON CONFLICT (chat_id, url) DO UPDATE SET source = 'allowed'")
    : db.query("INSERT OR IGNORE INTO chat_seen_urls (chat_id, url, source) VALUES (?, ?, 'fetched')")
  db.transaction(() => {
    let n = 0
    for (const u of urls) {
      if (n++ >= MAX_SEEN_PER_FETCH) break
      if (u.length <= 4000) ins.run(chatId, u)
    }
  })()
}

/** Long random-looking parts of a text (base32 / hex / base64 of something): an address can carry data in them. 20+
 * characters without separators that mix letters and digits (or both cases) with high character entropy. Shown
 * highlighted on cards; a hint, not a rule. */
export function opaqueParts(text: string, max = 50): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/[A-Za-z0-9+%]{20,}/g)) {
    if (out.size >= max) break
    const s = m[0]
    const mixed = /\d/.test(s) ? /[A-Za-z]/.test(s) : /[a-z]/.test(s) && /[A-Z]/.test(s)
    if (mixed && entropy(s) >= 3) out.add(s)
  }
  return [...out]
}
function entropy(s: string): number {
  const n = new Map<string, number>()
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1)
  let e = 0
  for (const k of n.values()) { const p = k / s.length; e -= p * Math.log2(p) }
  return e
}

export const TEXT = {
  unseen: {
    ko: 'AI가 이 대화에 나온 적 없는 주소를 열려고 합니다. 주소에 내용을 실어 밖으로 보낼 수도 있으니 주소 전체를 확인해 주세요.\n\n{url}',
    en: 'The AI wants to open an address that did not appear in this conversation. An address can carry data out, so check the whole address:\n\n{url}',
    id: 'AI ingin membuka alamat yang tidak muncul di percakapan ini. Alamat bisa membawa data keluar, jadi periksa seluruh alamatnya:\n\n{url}', ja: "AIがこの会話に出ていないアドレスを開こうとしています。アドレスを通じてデータが外部に送られる可能性があるため、全体を確認してください：\n\n{url}", es: "La IA quiere abrir una dirección que no apareció en esta conversación. Una dirección puede transmitir datos al exterior; revise la dirección completa:\n\n{url}",
  },
  noEgress: {
    ko: '팀 서버가 아직 사무실의 공인 주소를 몰라서, AI가 여는 주소가 사무실 안의 공유기나 기기로 되돌아오는지 확인할 수 없습니다. 주소 전체를 확인해 주세요.\n\n{url}',
    en: 'The team server does not know the office\'s public address yet, so it cannot tell whether this address leads back into the office (router, devices). Check the whole address:\n\n{url}',
    id: 'Server tim belum mengetahui alamat publik kantor, jadi tidak bisa memastikan apakah alamat ini mengarah kembali ke dalam kantor (router, perangkat). Periksa seluruh alamatnya:\n\n{url}', ja: "チームサーバーはまだオフィスの公開アドレスを把握していないため、このアドレスが社内（ルーターや機器）に戻るか判断できません。アドレス全体を確認してください：\n\n{url}", es: "El servidor del equipo aún no conoce la dirección pública de la oficina y no puede saber si esta dirección lleva de vuelta a la red interna (router, dispositivos). Revise la dirección completa:\n\n{url}",
  },
  longQuery: {
    ko: 'AI가 여는 주소 뒤에 긴 내용이 붙어 있습니다. 내용을 실어 밖으로 보낼 수도 있으니 주소 전체를 확인해 주세요.\n\n{url}',
    en: 'The address the AI wants to open carries a long query. An address can carry data out, so check the whole address:\n\n{url}',
    id: 'Alamat yang ingin dibuka AI membawa kueri panjang. Alamat bisa membawa data keluar, jadi periksa seluruh alamatnya:\n\n{url}', ja: "AIが開こうとしているアドレスには長いクエリが含まれます。アドレスを通じてデータが外部に送られる可能性があるため、全体を確認してください：\n\n{url}", es: "La dirección que la IA quiere abrir contiene una consulta larga. Una dirección puede transmitir datos al exterior; revise la dirección completa:\n\n{url}",
  },
  budget: {
    ko: 'AI가 웹 페이지와 검색 결과에 있던 주소를 묻지 않고 열 수 있는 만큼 다 열었어요(답변마다 {turn}개, 대화마다 {chat}개). 어떤 주소를 여느냐로도 내용을 밖으로 보낼 수 있으니 주소 전체를 확인해 주세요.\n\n{url}',
    en: 'The AI has opened as many addresses from web pages and search results without asking as it may ({turn} per answer, {chat} per conversation). Which address it opens can also carry data out, so check the whole address:\n\n{url}',
    id: 'AI sudah membuka sebanyak mungkin alamat dari halaman web dan hasil pencarian tanpa bertanya ({turn} per jawaban, {chat} per percakapan). Pilihan alamat yang dibuka juga bisa membawa data keluar, jadi periksa seluruh alamatnya:\n\n{url}',
    ja: 'AIが確認なしで開けるウェブページや検索結果のアドレスの上限に達しました（回答ごとに{turn}件、会話ごとに{chat}件）。どのアドレスを開くかによってもデータが外部に送られる可能性があるため、アドレス全体を確認してください：\n\n{url}',
    es: 'La IA ya abrió sin preguntar todas las direcciones de páginas web y resultados de búsqueda que puede ({turn} por respuesta, {chat} por conversación). La dirección que elige también puede sacar datos; revise la dirección completa:\n\n{url}',
  },
  allow: { ko: '열기', en: 'Open', id: 'Buka', ja: "開く", es: "Abrir" },
  deny: { ko: '열지 않기', en: 'Don’t open', id: 'Jangan buka', ja: "開かない", es: "No abrir" },
} as const

export type GateResult = 'seen' | 'confirmed'

/**
 * Throws ToolError unless the URL may be fetched. `person` is null outside a chat turn (no one to ask): then only ①
 * URLs pass (learned ones within the link budget). `turnId`: the answer the link budget counts for.
 */
export async function gateUrl(db: Database, chatId: string | null, rawUrl: string, person: TurnPerson | null, o: { egressKnown?: boolean; turnId?: string | null } = {}): Promise<GateResult> {
  const url = normUrl(rawUrl)
  if (!url) throw new ToolError('only http and https URLs can be fetched')
  const query = new URL(url).search.slice(1)
  const long = query.length > MAX_UNCONFIRMED_QUERY
  // the office's public exit address is not known yet (tools/egress.ts): no URL opens without the person
  const noEgress = o.egressKnown === false
  let why: 'unseen' | 'longQuery' | 'noEgress' | 'budget' = long ? 'longQuery' : noEgress ? 'noEgress' : 'unseen'
  if (!long && !noEgress) {
    const from = originOf(db, chatId, url, person)
    if (from?.origin === 'typed' || from?.origin === 'allowed') return 'seen'
    if (from?.origin === 'learned') {
      if (chatId && spendLinkBudget(db, chatId, url, o.turnId ?? null, from.row)) return 'seen'
      why = 'budget'
    }
  }
  if (!person) {
    throw new ToolError(why === 'budget'
      ? `this address came from a web page or search result, the AI already opened as many of those without asking as allowed (${LINK_BUDGET.turn} per answer, ${LINK_BUDGET.chat} per chat), and nobody can confirm it here, so it was not opened`
      : 'this address did not appear in the conversation and nobody can confirm it here, so it was not opened')
  }
  const L = person.locale
  // a function, so "$&" or "$`" in an address is shown as written (a string replacement would expand them)
  const shown = url.length > 2000 ? url.slice(0, 2000) + '…' : url
  const question = TEXT[why][L].replace('{turn}', String(LINK_BUDGET.turn)).replace('{chat}', String(LINK_BUDGET.chat)).replace('{url}', () => shown)
  if (!(await person.confirm(question, TEXT.allow[L], TEXT.deny[L]))) {
    throw new ToolError('the user did not allow opening this address. Do not try other addresses to get around this; tell the user what you could not do')
  }
  if (chatId && !long && !noEgress) rememberUrls(db, chatId, [url], 'allowed')
  return 'confirmed'
}
