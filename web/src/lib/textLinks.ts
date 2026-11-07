// Web addresses in a person's words (a room message, the quote of one, a message being sent): which parts of the text
// are links. Only "http://…", "https://…" and "www.…" (opened as https) are links; no other scheme ever is (javascript:,
// data:, file:, mailto:, an app's own), and neither is an address with a user name or password in it ("https://bank.com@
// evil.example"). Where an address ends is what people mean in a chat: a space, a double or curly quote mark, Korean
// (or Japanese, Chinese, full-width) text right after it ("https://x.y/a에서", "https://x.y/a。"), an emoji or a sign
// like ✅ or →, a closing bracket it never opened ("(see https://x.y/a)", "[https://x.y](https://x.y)"), another
// "http(s)://" stuck to it. Then the punctuation of the sentence comes off its end ("https://x.y.", "'https://x.y'"); a
// bracket the address opened itself stays ("https://en.wikipedia.org/wiki/Bun_(software)"). Where the text around an
// address leaves its host or its query unclear ("https://evil．com", "https://x.y/?q=한국") it stays text: no link is
// better than a link to the wrong page. Pure, no DOM: test/unit/text-links.test.ts.

/** A piece of a text: words, or an address and where it opens (`href`, normalized: "www.x.y" → "https://www.x.y/"). */
export interface LinkPart { text: string; href?: string }

/** Ends an address: white space, < > " `, a backslash (a browser reads it as a slash), control characters; curly
 * quotes, guillemets, "…", soft hyphens, zero-width spaces and the rest of general punctuation; arrows and symbols
 * (✅ →); Hangul, kana, CJK and their punctuation (、。「」); full-width forms (！，（）); emoji and other characters
 * outside the basic plane. Other signs (© ° €) stay in it, as browsers keep them. */
const STOP = /[\s<>"`\\\u0000-\u001f\u007f-\u009f\u00ab\u00ad\u00bb\u1100-\u11ff\u2000-\u206f\u2190-\u2bff\u2e80-\u2fff\u3000-\u9fff\ua960-\ua97f\uac00-\ud7ff\ud800-\udfff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/
/** An address does not start inside a word, a path or another address ("xhttps://", "a.www.x.y", "a@www.x.y"). */
const INSIDE = /[A-Za-z0-9._\-/@]/
/** Comes off an address's end: the punctuation of the sentence around it, and a bracket it never closes. */
const TRAILING = /[.,:;!?'*_~([{]/
const OPENS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
/** Read as a dot, or as nothing, inside a host: "https://evil．com", "https://go<zero-width space>od.example" */
const HOST_DOT = /[\u00ad\u200b-\u200d\u2060\ufeff\u3002\uff0e\uff61\ufe52]/
/** Letters of Hangul, kana and CJK: a query that goes on in them ("?q=한국") is no address to cut there */
const IRI_LETTER = /[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u3400-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff]/

const count = (s: string, c: string) => s.split(c).length - 1

/** The address without the sentence's punctuation after it; a closing bracket stays when the address has its opener. */
function trimEnd(s: string): string {
  for (;;) {
    const last = s.at(-1)
    if (!last) return s
    const opener = OPENS[last]
    if (TRAILING.test(last) || (opener && count(s, opener) < count(s, last))) s = s.slice(0, -1)
    else return s
  }
}

/** Where the address from `from` on stops: at a stop character, a closing bracket it never opened, or another
 * "http(s)://" right after a letter, digit, comma or semicolon (two addresses pasted together). */
function scanEnd(text: string, from: number): number {
  const open: Record<string, number> = { '(': 0, '[': 0, '{': 0 }
  let end = from
  for (; end < text.length; end++) {
    const c = text[end]!
    if (STOP.test(c)) break
    if (c in open) open[c] = (open[c] ?? 0) + 1
    else if (c in OPENS) {
      const o = OPENS[c]!
      if (!open[o]) break
      open[o] = open[o]! - 1
    } else if ((c === 'h' || c === 'H') && /[A-Za-z0-9,;]/.test(text[end - 1] ?? '') && /^https?:\/\//i.test(text.slice(end, end + 8))) break
  }
  return end
}

/** Where a found address opens, or null when it is no address to open (no host, a user name or password, "www." with
 * nothing after it, a scheme other than http and https). */
export function linkHref(raw: string): string | null {
  const www = /^www\./i.test(raw)
  if (www && !/^www\.[^./?#:]+\.[^./?#:]/i.test(raw)) return null
  // "https:///evil.example" would open evil.example: the host comes right after the "//"
  if (!www && /^https?:\/\/\//i.test(raw)) return null
  let u: URL
  try {
    u = new URL(www ? `https://${raw}` : raw)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password || !/[a-z0-9]/i.test(u.hostname) || u.hostname === 'www') return null
  return u.href
}

/**
 * A text cut into words and the web addresses in it, in order; the parts put together are the text. `cut`: the text
 * was cut short with "…" (a quote's excerpt): an address that runs into that "…" is cut too, so it stays text.
 */
export function linkParts(text: string, o: { cut?: boolean } = {}): LinkPart[] {
  const start = /https?:\/\/|www\./gi
  if (!text || !/https?:\/\/|www\./i.test(text)) return text ? [{ text }] : []
  const parts: LinkPart[] = []
  let done = 0
  for (let m = start.exec(text); m; m = start.exec(text)) {
    const at = m.index
    // not inside a word or another address; right after an address just found, a new one may start ("https://a.bhttps://c.d")
    if (at > 0 && at !== done && INSIDE.test(text[at - 1]!)) continue
    const end = scanEnd(text, at + m[0].length)
    // the host stops at a dot-like or invisible character with more host after it, a query or fragment goes on in
    // Hangul or CJK, or the "…" of an excerpt cut it: text. The scan goes on after it, so one long run is read once.
    const host = at + (m[0].length === 4 ? 0 : m[0].length)
    const unclear =
      (HOST_DOT.test(text[end] ?? '') && /[A-Za-z0-9-]/.test(text[end + 1] ?? '') && !/[/?#]/.test(text.slice(host, end))) ||
      (IRI_LETTER.test(text[end] ?? '') && /[=?&#]/.test(text[end - 1] ?? '')) ||
      (!!o.cut && end === text.length - 1 && text.endsWith('…'))
    const raw = trimEnd(text.slice(at, end))
    const href = unclear ? null : linkHref(raw)
    if (!href) {
      start.lastIndex = end
      continue
    }
    if (at > done) parts.push({ text: text.slice(done, at) })
    parts.push({ text: raw, href })
    done = at + raw.length
    start.lastIndex = done
  }
  if (done < text.length) parts.push({ text: text.slice(done) })
  return parts
}

/** An address as pieces a line may break between: after its slashes and before "?", "#" and "&" (not inside "://"), so
 * a long one wraps at a slash rather than in the middle of a word ("…/artifact/" | "7A3N9vnb…"). */
export function addressPieces(address: string): string[] {
  return address.split(/(?<=\/)(?=[^/])|(?=[?#&])/).filter(Boolean)
}
