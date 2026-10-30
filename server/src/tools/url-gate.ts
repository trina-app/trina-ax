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
//   ①b addresses on a site the person allowed for this conversation on an address card ("allow this site in this
//     conversation", chat_allowed_sites): the same registrable domain (eTLD+1, Public Suffix List with its private
//     section: news.example.co.kr and example.co.kr are one site, alice.github.io and bob.github.io are two), in this
//     chat, for this person, outside the link budget. Never for an address with a long random-looking part (opaqueParts:
//     it can carry data, so the card shows it highlighted every time), never in a confidential chat. Like Claude Code's
//     "don't ask again for this domain", but for one conversation;
//   ② any other URL: a confirmation card with the full URL, raised by the server inside the tool call;
//   ③ also a card when the query string is longer than 200 characters, even for a URL from ①;
//   and a card for every URL while the office's public exit address is unknown (tools/egress.ts).
// The caller looks nothing up in DNS before this says yes (tools/index.ts web_fetch, chat/tools.ts browser tools): a
// host name can carry data to the attacker's name server even when the person declines.
// Not done here (follow-up): the "32 characters in common with a file read in this chat" check of ③ and the admin
// allow-list of ④.
import type { Database } from 'bun:sqlite'
import { domainToUnicode } from 'node:url'
import { getDomain } from 'tldts'
import type { ConfirmDetail, Locale } from '@mycel/shared/api'
import { ToolError } from '../policy/errors'
import { isConfidentialChat } from '../safe-ops/confidential'

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

/**
 * The site of an address for "allow this site in this conversation": its registrable domain (eTLD+1) by the Public
 * Suffix List, private section included (tldts), in the address's ASCII (punycode) form: news.example.co.kr ->
 * example.co.kr, x.alice.github.io -> alice.github.io. From the name alone, never DNS. null = nothing to allow: an IP
 * address, a single-label name, or a name that is itself a public suffix (co.kr, github.io, s3.amazonaws.com).
 */
export function siteOf(rawUrl: string): string | null {
  let host: string
  try { host = new URL(rawUrl).hostname.toLowerCase() } catch { return null }
  host = host.replace(/\.+$/, '')
  if (!host || host.startsWith('[') || !host.includes('.') || /^[\d.]+$/.test(host)) return null
  const d = getDomain(host, { allowPrivateDomains: true, detectIp: true, validateHostname: true, extractHostname: false })
  return d && d.includes('.') ? d : null
}

/** A site as shown on a card: ASCII form, and the Unicode form next to it when they differ (예시.한국). */
export function siteLabel(site: string): string {
  const u = domainToUnicode(site)
  return u && u !== site ? `${site} (${u})` : site
}

/** The address with its %-escapes decoded (as written when they do not decode as UTF-8), for finding random-looking
 * parts and for showing them: control and direction characters it decodes to are shown as U+FFFD (the card's question
 * has the address as written). */
function decodedUrl(url: string): string {
  let d: string
  try { d = decodeURIComponent(url) } catch { return url }
  return d.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '\ufffd')
}

/** A site allowance lives in one chat of its owner: never another chat, never another person. */
function siteScope(db: Database, chatId: string | null, userId: string | null | undefined): chatId is string {
  return !!chatId && !!userId && !!db.query('SELECT 1 FROM chats WHERE id = ? AND user_id = ?').get(chatId, userId) && !isConfidentialChat(db, chatId)
}

/** The sites the person allowed in this chat; none in a confidential chat, in another person's chat or without a person. */
function allowedSites(db: Database, chatId: string | null, userId: string | null | undefined): Set<string> {
  if (!siteScope(db, chatId, userId)) return new Set()
  return new Set((db.query('SELECT site FROM chat_allowed_sites WHERE chat_id = ? AND user_id = ?').all(chatId, userId!) as { site: string }[]).map((r) => r.site))
}

/** Remember "allow this site in this conversation" (the person picked it on an address card of their own chat). */
export function allowSite(db: Database, chatId: string, userId: string, site: string, turnId: string | null) {
  if (!siteScope(db, chatId, userId)) return
  db.query('INSERT OR IGNORE INTO chat_allowed_sites (chat_id, user_id, site, turn_id) VALUES (?, ?, ?, ?)').run(chatId, userId, site, turnId)
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
    ko: 'AI가 이 대화에 나온 적 없는 주소를 열려고 해요. 주소에 내용을 실어 밖으로 보낼 수도 있으니 주소 전체를 확인해 주세요.\n\n{url}',
    en: 'The AI wants to open an address that did not appear in this conversation. An address can carry data out, so check the whole address:\n\n{url}',
    id: 'AI ingin membuka alamat yang tidak muncul di percakapan ini. Alamat bisa membawa data keluar, jadi periksa seluruh alamatnya:\n\n{url}', ja: "AIがこの会話に出ていないアドレスを開こうとしています。アドレスを通じてデータが外部に送られる可能性があるため、全体を確認してください：\n\n{url}", es: "La IA quiere abrir una dirección que no apareció en esta conversación. Una dirección puede transmitir datos al exterior; revise la dirección completa:\n\n{url}",
  },
  noEgress: {
    ko: '팀 서버가 아직 사무실의 공인 주소를 몰라서, AI가 여는 주소가 사무실 안의 공유기나 기기로 되돌아오는지 확인할 수 없어요. 주소 전체를 확인해 주세요.\n\n{url}',
    en: 'The team server does not know the office\'s public address yet, so it cannot tell whether this address leads back into the office (router, devices). Check the whole address:\n\n{url}',
    id: 'Server tim belum mengetahui alamat publik kantor, jadi tidak bisa memastikan apakah alamat ini mengarah kembali ke dalam kantor (router, perangkat). Periksa seluruh alamatnya:\n\n{url}', ja: "チームサーバーはまだオフィスの公開アドレスを把握していないため、このアドレスが社内（ルーターや機器）に戻るか判断できません。アドレス全体を確認してください：\n\n{url}", es: "El servidor del equipo aún no conoce la dirección pública de la oficina y no puede saber si esta dirección lleva de vuelta a la red interna (router, dispositivos). Revise la dirección completa:\n\n{url}",
  },
  longQuery: {
    ko: 'AI가 여는 주소 뒤에 긴 내용이 붙어 있어요. 내용을 실어 밖으로 보낼 수도 있으니 주소 전체를 확인해 주세요.\n\n{url}',
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
  opaque: {
    ko: '주소에 알아보기 어려운 긴 문자열이 있어요(강조 표시). 내용을 실어 보낼 수 있으니 무엇인지 확인해 주세요.',
    en: 'The address contains long strings that are hard to read (highlighted). They can carry data; check what they are.',
    id: 'Alamat ini berisi string panjang yang sulit dibaca (disorot). String itu bisa membawa data; periksa isinya.',
    ja: 'アドレスに読み取りにくい長い文字列が含まれています（強調表示）。データを運べるため、内容を確認してください。',
    es: 'La dirección contiene cadenas largas difíciles de leer (resaltadas). Pueden llevar datos; compruebe qué son.',
  },
  site: {
    ko: '사이트를 허용하면 이 대화에서만 {site}의 다른 주소도 묻지 않고 열어요. 알아보기 어려운 긴 문자열이나 긴 내용이 붙은 주소는 계속 물어요.',
    en: 'If you allow the site, other addresses on {site} open without asking, in this conversation only. Addresses with long hard-to-read strings or a long query still ask.',
    id: 'Jika situs diizinkan, alamat lain di {site} dibuka tanpa bertanya, hanya di percakapan ini. Alamat dengan string panjang yang sulit dibaca atau kueri panjang tetap ditanyakan.',
    ja: 'サイトを許可すると、この会話に限り{site}の他のアドレスも確認なしで開きます。読み取りにくい長い文字列や長いクエリを含むアドレスは引き続き確認します。',
    es: 'Si permite el sitio, otras direcciones de {site} se abren sin preguntar, solo en esta conversación. Las direcciones con cadenas largas difíciles de leer o una consulta larga siguen preguntando.',
  },
  labelUrl: { ko: '주소', en: 'Address', id: 'Alamat', ja: 'アドレス', es: 'Dirección' },
  allow: { ko: '열기', en: 'Open', id: 'Buka', ja: "開く", es: "Abrir" },
  allowSite: {
    ko: '이 대화에서 이 사이트 허용 ({site})', en: 'Allow this site in this conversation ({site})', id: 'Izinkan situs ini di percakapan ini ({site})',
    ja: 'この会話でこのサイトを許可（{site}）', es: 'Permitir este sitio en esta conversación ({site})',
  },
  deny: { ko: '열지 않기', en: 'Don’t open', id: 'Jangan buka', ja: "開かない", es: "No abrir" },
} satisfies Record<string, Record<Locale, string>>

/** 'seen' and 'site' opened without a card (① and ①b), 'confirmed' after one. */
export type GateResult = 'seen' | 'site' | 'confirmed'

/**
 * Throws ToolError unless the URL may be fetched. `person` is null outside a chat turn (no one to ask): then only ①
 * URLs pass (learned ones within the link budget). `turnId`: the answer the link budget counts for. `userId`: the
 * person of the turn; the sites they allowed in this chat (①b) count only for them (none without it).
 * Decides from the address text and the database alone: the caller looks the name up only after a yes.
 */
export async function gateUrl(db: Database, chatId: string | null, rawUrl: string, person: TurnPerson | null, o: { egressKnown?: boolean; turnId?: string | null; userId?: string | null } = {}): Promise<GateResult> {
  const url = normUrl(rawUrl)
  if (!url) throw new ToolError('only http and https URLs can be fetched')
  const query = new URL(url).search.slice(1)
  const long = query.length > MAX_UNCONFIRMED_QUERY
  // the office's public exit address is not known yet (tools/egress.ts): no URL opens without the person
  const noEgress = o.egressKnown === false
  // long random-looking parts of the address: a site allowance never covers them, the card marks them. Looked for in
  // the decoded address, so a Korean path (%ED%95%9C…) is words, not a random string; one that does not decode is
  // checked as written
  const readable = decodedUrl(url)
  const marks = opaqueParts(readable.replace(/^https?:\/\//i, ''))
  const site = siteOf(url)
  let why: 'unseen' | 'longQuery' | 'noEgress' | 'budget' = long ? 'longQuery' : noEgress ? 'noEgress' : 'unseen'
  if (!long && !noEgress) {
    const from = originOf(db, chatId, url, person)
    if (from?.origin === 'typed' || from?.origin === 'allowed') return 'seen'
    // ①b: a site the person allowed in this conversation, outside the link budget
    if (site && !marks.length && allowedSites(db, chatId, o.userId).has(site)) return 'site'
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
  const lines = [TEXT[why][L].replace('{turn}', String(LINK_BUDGET.turn)).replace('{chat}', String(LINK_BUDGET.chat)).replace('{url}', () => shown)]
  if (marks.length) lines.push(TEXT.opaque[L])
  // "allow this site in this conversation": only where an allowance could ever apply (not for a long query or while the
  // exit address is unknown, never in a confidential chat or without a chat and person to keep it for)
  const offerSite = !!(site && person.choose && !long && !noEgress && siteScope(db, chatId, o.userId))
  if (offerSite) lines.push(TEXT.site[L].replace('{site}', () => siteLabel(site!)))
  const extra: ConfirmExtra | undefined = marks.length ? { details: [{ label: TEXT.labelUrl[L], text: readable, marks }] } : undefined
  const question = lines.join('\n\n')
  const answer = offerSite
    ? await person.choose!(question, [
      { label: TEXT.allow[L], value: 'allow' },
      { label: TEXT.allowSite[L].replace('{site}', () => siteLabel(site!)), value: 'site' },
      { label: TEXT.deny[L], value: 'deny' },
    ], extra)
    : (await person.confirm(question, TEXT.allow[L], TEXT.deny[L], extra)) ? 'allow' : null
  if (answer !== 'allow' && answer !== 'site') {
    throw new ToolError('the user did not allow opening this address. Do not try other addresses to get around this; tell the user what you could not do')
  }
  if (chatId && !long && !noEgress) rememberUrls(db, chatId, [url], 'allowed')
  if (answer === 'site' && offerSite) allowSite(db, chatId!, o.userId!, site!, o.turnId ?? null)
  return 'confirmed'
}
