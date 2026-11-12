// A person's words in a room (a message, the note of a shared answer) as Markdown (QA TC-072; docs/DECISIONS.md
// "Markdown in people's messages"): the answer renderer (components/Markdown.tsx PersonMarkdown) with this remark step,
// which keeps what the plain text did:
// - the @names the message mentions stand out (as lib/rooms.ts mentionParts finds them, and after Markdown's marks). They are taken out before the Markdown is
//   read (a placeholder each), so no Markdown can split, eat or restyle a name ("@Kim_Ji_Ho", "@*star*"), and come back
//   as the same mention span. Inside code, a link's address, a picture's words or raw HTML a placeholder goes back to
//   the name as typed (text, no mention);
// - plain web addresses are links by lib/textLinks.ts's rules, as before (GFM's own looser autolinks are undone: no
//   email or "www." rule of its own; an address cut by Korean text stays text);
// - a line break stays a line break (Markdown would join the lines).
// No DOM, no network: test/unit/message-markdown.test.ts.
import { gfmAutolinkLiteralFromMarkdown, gfmAutolinkLiteralToMarkdown } from 'mdast-util-gfm-autolink-literal'
import { gfmStrikethroughFromMarkdown, gfmStrikethroughToMarkdown } from 'mdast-util-gfm-strikethrough'
import { gfmTableFromMarkdown, gfmTableToMarkdown } from 'mdast-util-gfm-table'
import { gfmTaskListItemFromMarkdown, gfmTaskListItemToMarkdown } from 'mdast-util-gfm-task-list-item'
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal'
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough'
import { gfmTable } from 'micromark-extension-gfm-table'
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item'
import { mentionCanStart } from './rooms'
import { classifyLink } from './markdown'
import { linkParts } from './textLinks'

/** A mention to mark: the person (or "all", or the AI) and the name as the message writes it; `strong`: it is me (or
 * "@all" in someone else's message), shown on a soft background. */
export interface MessageMention { id: string; name: string; strong?: boolean; all?: boolean }
/** A name taken out of the text: its words and how it is drawn. */
interface Found { text: string; mention: MessageMention }

const OPEN = ''
const CLOSE = ''
/** Markdown's marks a mention may follow: emphasis, strike, a code span's tick, a list's or quote's sign */
const MARKS = /[*_~`>]/
const TOKEN = /(\d+)/g
/** The class of a mention: the accent colour; mine on a soft background (as RoomMessages drew it before) */
export const mentionClass = (strong?: boolean) => ['font-medium', 'text-accent-text', ...(strong ? ['rounded', 'bg-accent-soft', 'px-0.5'] : [])]

/** The text to read as Markdown, its mentions replaced by placeholders (the characters a placeholder uses, if the
 * text has them itself, become U+FFFD so nothing typed can pose as one). */
export function protectMentions(body: string, mentions: MessageMention[]): { source: string; found: Found[] } {
  const clean = body.replace(/[]/g, '�')
  const found: Found[] = []
  // longest name first, as lib/rooms.ts mentionParts; an "@" may also follow Markdown's own marks ("**@Ben**")
  const names = mentions.filter((m) => m.name).sort((a, b) => b.name.length - a.name.length)
  let source = ''
  for (let i = 0; i < clean.length; ) {
    const hit = clean[i] === '@' && (mentionCanStart(clean, i) || MARKS.test(clean[i - 1] ?? '')) ? names.find((m) => clean.startsWith(m.name, i + 1)) : undefined
    if (hit) {
      // one placeholder per name, so "[@Ben]" and its "[@Ben]: …" definition still match
      let n = found.findIndex((f) => f.mention === hit)
      if (n < 0) n = found.push({ text: `@${hit.name}`, mention: hit }) - 1
      source += `${OPEN}${n}${CLOSE}`
      i += hit.name.length + 1
    } else source += clean[i++]
  }
  return { source, found }
}

/** The text of `s` with its placeholders back as the names typed. */
const restore = (s: string, found: Found[]) => s.replace(TOKEN, (m, i: string) => found[Number(i)]?.text ?? m)

// mdast, as far as this step needs it (web has no @types/mdast)
interface Node {
  type: string
  value?: string
  url?: string
  alt?: string | null
  label?: string | null
  identifier?: string
  title?: string | null
  spread?: boolean | null
  children?: Node[]
  position?: { start: { offset?: number }; end: { offset?: number } }
  data?: { hName?: string; hProperties?: Record<string, unknown>; hChildren?: unknown[] }
}

/** The pieces of one text node: mentions, plain addresses (not inside a link) and line breaks. */
function split(value: string, found: Found[], inLink: boolean): Node[] {
  const out: Node[] = []
  const words = (s: string) => {
    s.split('\n').forEach((line, i) => {
      if (i > 0) out.push({ type: 'break' })
      if (line) out.push({ type: 'text', value: line })
    })
  }
  let last = 0
  const plain = (s: string) => {
    if (!s) return
    if (inLink) return words(s)
    for (const p of linkParts(s)) {
      if (p.href) out.push({ type: 'link', url: p.href, title: null, children: [{ type: 'text', value: p.text }], data: { hProperties: { dataPlain: '' } } })
      else words(p.text)
    }
  }
  for (const m of value.matchAll(TOKEN)) {
    plain(value.slice(last, m.index))
    const f = found[Number(m[1])]
    if (f) {
      const props: Record<string, unknown> = { className: mentionClass(f.mention.strong) }
      if (f.mention.all) props.dataMention = 'all'
      out.push({ type: 'text', value: f.text, data: { hName: 'span', hProperties: props, hChildren: [{ type: 'text', value: f.text }] } })
    } else plain(m[0])
    last = m.index + m[0].length
  }
  plain(value.slice(last))
  return out
}

/** Nodes whose children are blocks (where an HTML block can stand). */
const FLOW = new Set(['root', 'blockquote', 'listItem'])

/** The text of a node and what is in it, its placeholders back as the names typed. */
const textOf = (n: Node, found: Found[]): string => restore(n.type === 'text' || n.type === 'inlineCode' ? (n.value ?? '') : (n.children ?? []).map((c) => textOf(c, found)).join(''), found)

/** The host a link opens, without "www." (null: no address) */
function hostOf(url: string): string | null {
  try {
    return new URL(url, 'http://localhost').host.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

/** Words as a person reads them: no zero-width or other invisible format characters ("https:/\u200b/bank.com"), wide
 * forms as their narrow ones ("bank．com", "ｂａｎｋ"), the ideographic full stops as "." (lowercase, trimmed). */
export const readAs = (s: string) => s.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[\u3002\uff61]/g, '.').trim().toLowerCase()

/** Characters that reorder what follows them on the screen (right-to-left overrides, embeddings, isolates, marks):
 * words with one may look like another address than they are ("‮x.io/moc.lapyap" shows "paypal.com/oi.x"). */
const BIDI = /[؜‎‏‪-‮⁦-⁩]/

/** What an outside link's words should show when they do not show where it goes (null: they do): the host of a web
 * address ("evil.example"), or the whole address when the words name an address of their own (a scheme, a path) and
 * it is not this one ("[https://bank.com/login](https://bank.com/redirect?to=…)"); the address of a mailto: link
 * (all of it when it has a "?": "?bcc=", "?to=" send it elsewhere too), the number of a tel: link. The words show it
 * when they are that host, with or without "www." (and a trailing "."), or that address as written; never when they
 * hold a character that reorders the screen (BIDI). */
export function hiddenAddress(words: string, url: string): string | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  const w = readAs(words)
  const bidi = BIDI.test(words)
  const trim = (x: string) => x.replace(/\/+$/, '')
  if (u.protocol === 'mailto:' || u.protocol === 'tel:') {
    let to = u.href.slice(u.protocol.length)
    try { to = decodeURIComponent(to) } catch { /* as written */ }
    if (!to) return u.href
    const shown = w.replace(/^(mailto|tel):/, '')
    if (u.protocol === 'tel:') return !bidi && shown.replace(/\D/g, '') !== '' && shown.replace(/\D/g, '') === to.replace(/\D/g, '') ? null : to
    return !bidi && !to.includes('?') && shown === to.toLowerCase() ? null : to
  }
  const host = u.host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
  const scheme = /^([a-z][a-z\d+.-]*):\/*/.exec(w)
  const shown = w.slice(scheme?.[0].length ?? 0).replace(/^www\./, '')
  const head = shown.split(/[/?#]/, 1)[0].replace(/\.$/, '')
  // (the words' host as the link would have it: "한국.kr" → punycode, ":443" on https → none)
  let shownHost = head
  try { shownHost = new URL(`${u.protocol}//${head}`).host.toLowerCase().replace(/^www\./, '') } catch { /* as written */ }
  // (words with an "@" before their path name a site before it, "paypal.com@evil.example": never the address shown)
  if (bidi || head.includes('@') || shownHost !== host) return host
  // the words name an address of their own: it must be this one (scheme, path, query), compared as written and
  // percent-encoded alike ("/wiki/서울" is "/wiki/%EC%84%9C%EC%9A%B8")
  const rest = shown.slice(shown.split(/[/?#]/, 1)[0].length)
  const same = (x: string) => trim(x.replace(/^\/(?=[?#]|$)/, ''))
  if (scheme || same(rest) !== '') {
    const real = u.pathname + u.search + u.hash
    let decoded = real
    try { decoded = decodeURI(real) } catch { /* as written */ }
    const ok = [readAs(real), readAs(decoded)].some((r) => same(r) === same(rest) || same(r) === same(asHref(rest).toLowerCase()))
    if ((scheme && scheme[1] !== u.protocol.slice(0, -1)) || !ok) return u.href
  }
  return null
}

/** How deep quotes and lists, and emphasis, may nest: deeper ones are their contents at the last allowed depth. A
 * message of "- - - - …" or ">>>>…" (2,000 deep in a 10,000-character message) would otherwise be thousands of nested
 * elements: the browser's stack runs out drawing it ("Maximum call stack size exceeded"), the whole page with it, for
 * everyone who opens the room. 6 also keeps a nested message readable on a phone (with PersonMarkdown's narrower
 * nested lists there). */
export const MAX_NEST = 6
const BLOCK_NEST = new Set(['blockquote', 'list'])
const INLINE_NEST = new Set(['emphasis', 'strong', 'delete'])

/** The tree with nothing nested deeper than MAX_NEST (see there). No recursion: the tree may be thousands deep. */
export function capDepth(tree: Node) {
  const work: { node: Node; block: number; inline: number }[] = [{ node: tree, block: 0, inline: 0 }]
  while (work.length) {
    const { node, block, inline } = work.pop()!
    if (!node.children) continue
    const out: Node[] = []
    const todo = [...node.children].reverse()
    while (todo.length) {
      const c = todo.pop()!
      const b = block + (BLOCK_NEST.has(c.type) ? 1 : 0)
      const i = inline + (INLINE_NEST.has(c.type) ? 1 : 0)
      if (b > MAX_NEST || i > MAX_NEST) {
        // its contents in its place (a list's: what each item holds)
        const inner = c.type === 'list' ? (c.children ?? []).flatMap((li) => li.children ?? []) : (c.children ?? [])
        for (let k = inner.length - 1; k >= 0; k--) todo.push(inner[k])
        // (each item's words a paragraph of their own: a "tight" list item would run them into one line)
        if (c.type === 'list') node.spread = true
        continue
      }
      out.push(c)
      work.push({ node: c, block: b, inline: i })
    }
    node.children = out
  }
}

/** How many quote and list signs a line may start with ("> - 1. …") before the text is not read as Markdown at all. */
export const MAX_LINE_MARKS = 32
/** How many "[" (links, pictures) or emphasis openers ("*" or "_" before a word) may be open at once, not yet closed by a
 * "]" or a closing "*"/"_", before the same: the parser matches those against each other, which takes seconds when
 * there are thousands ("![![![… ](u)](u)", "*x *x *x … x* x*"). Closed ones ("**a** **b**", "[a](u) [b](u)") cost
 * nothing. */
export const MAX_OPEN = 400
/** How many "*", "_" or "~~" marks may stand where they could both open and close emphasis ("a*b*c", "~*~*", ".*.*"), or
 * close one that was never opened ("x* * x* *"), before the same: the parser looks back over all the marks before each
 * of those, a fifth of a second for 2,000-5,000 of them. Marks that open and close in pairs ("**a** **b**") cost
 * little. */
export const MAX_LOOSE = 1000
/** How many words may follow a "[" that is not closed in its paragraph ("[x<x<x<…", "[draft" and a long text): GFM
 * tries a web or e-mail address at each word's start, and each try looks back over the whole paragraph for that "[" (a
 * fifth of a second for 5,000). */
export const MAX_AUTOLINK_TRIES = 1000
const ATEXT = /[A-Za-z\d+\-._]/
/** How many line breaks a message may have (a 10,000-character message can have 5,000): the parser reads the lines that
 * continue a quote's or a list's paragraph ("> x" and then thousands of short lines) over again for each new one, and a
 * list of thousands of items holding lists or quotes ("- - x", "- > x") costs more for each one: a quarter of a second
 * at 5,000 lines, or 1,700 items, in plain CommonMark too. 1,000 lines is a very long message already. */
export const MAX_LINES = 1000
const LONG_RUN = /[*_]{65,}/g
const SPACE = /\s/
const PUNCT = /[\p{P}\p{S}]/u

/** How many characters the parser may read looking for the end of code spans that never end (MAX_CODE_SEARCH). */
export const MAX_CODE_SEARCH = 2_000_000
const BLANK_LINE = /\n[ \t]*\n/g

/** Whether the parser would read too far looking for the ends of code spans: each "`" run reads on to the next run of
 * as many "`" in its paragraph, and to the paragraph's end when there is none ("```x\\" a thousand times: each "\`"
 * is an escaped "`" and then a "``" that is never closed), a fifth of a second for 10,000 characters. */
function codeSearchTooLong(text: string): boolean {
  if (!text.includes('`')) return false
  const runs: { at: number; len: number }[] = []
  for (let k = text.indexOf('`'); k >= 0; ) {
    let j = k
    while (text[j] === '`') j++
    runs.push({ at: k, len: j - k })
    k = text.indexOf('`', j)
  }
  // the runs of each length (their numbers in `runs`), and where each paragraph ends
  const byLen = new Map<number, number[]>()
  runs.forEach((r, i) => {
    const list = byLen.get(r.len)
    if (list) list.push(i)
    else byLen.set(r.len, [i])
  })
  const cursor = new Map<number, number>()
  const ends = [...text.matchAll(BLANK_LINE)].map((m) => m.index)
  let end = 0
  let read = 0
  for (let r = 0; r < runs.length; ) {
    const run = runs[r]
    while (end < ends.length && ends[end] < run.at) end++
    const stop = ends[end] ?? text.length
    // (outside code a "\" escapes the first "`" of a run)
    const len = run.len - (text[run.at - 1] === '\\' ? 1 : 0)
    const list = len > 0 ? byLen.get(len) : undefined
    let c = cursor.get(len) ?? 0
    while (list && c < list.length && list[c] <= r) c++
    cursor.set(len, c)
    const next = list?.[c]
    if (next !== undefined && runs[next].at < stop) {
      read += runs[next].at - run.at
      r = next + 1
    } else {
      read += stop - run.at
      r++
    }
    if (read > MAX_CODE_SEARCH) return true
  }
  return false
}

/** How many cells a text's tables may have in all: a table has as many cells in each row as its header has columns,
 * however short the row ("a|a|…" 2,000 columns, then a thousand lines of "x": two million cells, seconds to draw and
 * far more for the browser to lay out). */
export const MAX_TABLE_CELLS = 20_000
const CONTAINER_SIGNS = /^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])))*/
/** The text with Markdown's other line ends ("\r\n", "\r") as "\n": what the parser reads, and the guards count. */
export const lineEnds = (text: string) => (text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text)
const DELIMITER_ROW = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

/** Whether a text's tables would have more than MAX_TABLE_CELLS cells (counted generously: a table's rows run to the
 * next blank line). For an AI's answer too. */
export function tableTooBig(text: string): boolean {
  if (!text.includes('-')) return false
  // (a table in a quote or a list is one too: its lines without the signs before them)
  const lines = lineEnds(text).split('\n').map((l) => l.replace(CONTAINER_SIGNS, ''))
  let cells = 0
  for (let k = 1; k < lines.length; k++) {
    const line = lines[k]
    if (!line.includes('-') || !lines[k - 1].trim() || !DELIMITER_ROW.test(line)) continue
    const cols = line.split('|').filter((c) => c.trim()).length
    let rows = 1
    while (k + rows < lines.length && lines[k + rows].trim()) rows++
    cells += cols * rows
    if (cells > MAX_TABLE_CELLS) return true
    k += rows - 1
  }
  return false
}

/** Where a footnote definition's mark ("[^a]:") that starts at `i` ends (0: none starts there). */
function footnoteMark(text: string, i: number): number {
  const m = /^\[\^(?:\\.|[^\]\\\n])*\]:/.exec(text.slice(i, i + 1000))
  return m ? i + m[0].length : 0
}

/** Text Markdown could only read slowly (seconds) is shown as its plain words instead: a line that starts with
 * thousands of quote or list signs ("* * * … x", "1. 1. …", ">>>…", footnote marks "[^a]:" as one: capDepth keeps them from drawing deep, but reading
 * them is slow in itself), hundreds of "[" or emphasis openers open at once (MAX_OPEN), thousands of lines (MAX_LINES), a thousand emphasis marks that do not pair up (MAX_LOOSE), code spans that never end (MAX_CODE_SEARCH), a thousand words after a "[" that is not closed (MAX_AUTOLINK_TRIES), tables of more than MAX_TABLE_CELLS cells, or a long run mixing
 * "*" and "_". Nothing a person writes on purpose. For people's messages only: an AI's answer or a file is Markdown
 * whatever it holds (capDepth and MarkdownBoundary keep those from taking the page down). */
export function tooHeavyForMarkdown(text0: string): boolean {
  const text = lineEnds(text0)
  let lines = 0
  for (let k = text.indexOf('\n'); k >= 0; k = text.indexOf('\n', k + 1)) if (++lines > MAX_LINES) return true
  for (const run of text.matchAll(LONG_RUN)) if (run[0].includes('*') && run[0].includes('_')) return true
  let open = 0
  let loose = 0
  // the "*", "_" and "~~" openers still open; the "[" still open in this paragraph, and the words since
  const opened = [0, 0, 0]
  let label = 0
  let tries = 0
  for (let k = 0; k < text.length; k++) {
    const ch = text[k]
    // (a blank line ends a paragraph, and with it what the parser looks back over)
    if (ch === '\n' && /^[ \t]*(\n|$)/.test(text.slice(k + 1, k + 64))) {
      label = 0
      tries = 0
    }
    if (ch === '[') {
      open++
      label++
    } else if (ch === ']') {
      open = Math.max(0, open - 1)
      label = Math.max(0, label - 1)
    } else if (label > 0 && ATEXT.test(ch) && !ATEXT.test(text[k - 1] ?? ' ')) {
      if (++tries > MAX_AUTOLINK_TRIES) return true
    } else if (ch === '*' || ch === '_' || ch === '~') {
      let j = k
      while (text[j + 1] === ch) j++
      // (CommonMark's rules for a run of them: whether it may open or close emphasis, by what is on either side)
      const before = text[k - 1] ?? ' '
      const after = text[j + 1] ?? ' '
      const left = !SPACE.test(after) && (!PUNCT.test(after) || SPACE.test(before) || PUNCT.test(before))
      const right = !SPACE.test(before) && (!PUNCT.test(before) || SPACE.test(after) || PUNCT.test(after))
      // (an "_" inside a word, snake_case, does neither)
      const opens = ch === '_' ? left && (!right || PUNCT.test(before)) : left
      const closes = ch === '_' ? right && (!left || PUNCT.test(after)) : right
      // (a closer only closes an opener of its own sign: "__" does not close "*"; for "~~" strike, open ones cost
      // little, and one "~" or more than two are words)
      if (ch !== '~' || j - k === 1) {
        const own = ch === '*' ? 0 : ch === '_' ? 1 : 2
        if (opens && !closes) {
          if (ch !== '~') open++
          opened[own]++
        } else if (closes && !opens) {
          if (opened[own] === 0) loose++
          else opened[own]--
          open = Math.max(0, open - 1)
        } else if (opens && closes) loose++
      }
      k = j
    }
    if (open > MAX_OPEN || loose > MAX_LOOSE) return true
  }
  if (codeSearchTooLong(text) || tableTooBig(text)) return true
  let i = 0
  const n = text.length
  while (i < n) {
    // one line: its signs, with the spaces between them
    let marks = 0
    for (;;) {
      while (text[i] === ' ' || text[i] === '\t') i++
      const ch = text[i]
      if (ch === '>') i++
      else if (ch === '[' && text[i + 1] === '^' && footnoteMark(text, i) > 0) i = footnoteMark(text, i)
      else if ((ch === '-' || ch === '*' || ch === '+') && (i + 1 >= n || text[i + 1] === ' ' || text[i + 1] === '\t' || text[i + 1] === '\n')) i++
      else {
        let j = i
        while (j < n && j - i < 9 && text[j] >= '0' && text[j] <= '9') j++
        if (j === i || (text[j] !== '.' && text[j] !== ')') || !(j + 1 >= n || text[j + 1] === ' ' || text[j + 1] === '\t' || text[j + 1] === '\n')) break
        i = j + 1
      }
      if (++marks > MAX_LINE_MARKS) return true
    }
    const end = text.indexOf('\n', i)
    if (end < 0) break
    i = end + 1
  }
  return false
}

/** The remark step that caps nesting (capDepth), for the AI's answers too. */
export const remarkCapDepth = () => (tree: Node) => capDepth(tree)

/** remark-gfm (tables, strike, task lists, autolinks) without its footnotes. GFM's footnote syntax is what makes a
 * message slow to read: "[^a]:" definitions inside each other ("[^a]:\n\n\t" 1,250 times, under 10,000 characters)
 * took the parser 3-7 s, freezing the room for everyone who opened it; without footnotes the same text reads in
 * milliseconds. People's messages never show footnotes (they are their words: footnotesAsText), so they are read
 * without them; an AI's answer only when its text has footnotes of that kind (footnotesTooHeavy). `singleTilde` as
 * remark-gfm's. The parts are remark-gfm's own (micromark-extension-gfm-*, mdast-util-gfm-*). */
export function remarkGfmNoFootnotes(this: unknown, options: { singleTilde?: boolean } = {}) {
  const data = (this as { data(): Record<string, unknown[] | undefined> }).data()
  ;(data.micromarkExtensions ??= []).push(gfmAutolinkLiteral(), gfmStrikethrough(options), gfmTable(), gfmTaskListItem())
  ;(data.fromMarkdownExtensions ??= []).push([gfmAutolinkLiteralFromMarkdown(), gfmStrikethroughFromMarkdown(), gfmTableFromMarkdown(), gfmTaskListItemFromMarkdown()])
  ;(data.toMarkdownExtensions ??= []).push({ extensions: [gfmAutolinkLiteralToMarkdown(), gfmStrikethroughToMarkdown(), gfmTableToMarkdown(), gfmTaskListItemToMarkdown()] })
}

/** Read without footnotes (remarkGfmNoFootnotes), a footnote's marks are a reference link ("x[^1]") and its definition
 * ("[^1]: note"), which would make "[^1]" a link to "note" and hide the note: both are their words as written
 * instead. `src`: the text read (the tree's offsets are into it). */
export function footnotesAsText(tree: Node, src: string) {
  const isNote = (n: Node) => (n.type === 'definition' || n.type === 'linkReference' || n.type === 'imageReference') && (n.identifier ?? '').startsWith('^')
  const asWritten = (n: Node): Node => {
    const a = n.position?.start.offset
    const b = n.position?.end.offset
    const value = a !== undefined && b !== undefined ? src.slice(a, b) : `[${n.label ?? n.identifier ?? ''}]`
    return n.type === 'definition' ? { type: 'paragraph', children: [{ type: 'text', value }] } : { type: 'text', value }
  }
  // (no recursion: capDepth has run, but an answer's tree is walked here too)
  const work: Node[] = [tree]
  while (work.length) {
    const node = work.pop()!
    if (!node.children) continue
    if (node.children.some(isNote)) node.children = node.children.map((c) => (isNote(c) ? asWritten(c) : c))
    for (const c of node.children) work.push(c)
  }
}

/** The remark step of footnotesAsText, for an AI's answer read without footnotes. */
export const remarkFootnotesAsText = () => (tree: Node, file: { value?: unknown }) => footnotesAsText(tree, typeof file.value === 'string' ? file.value : '')

/** How many footnote definitions ("[^1]: …") an AI's answer may have, and how many of them not at a line's start (in a
 * quote, a list, another definition, after its own words), before it is read without footnotes (remarkGfmNoFootnotes:
 * their marks are then words). Definitions inside each other are what take the parser seconds; an answer's own
 * footnotes are a list at its end. */
export const MAX_FOOTNOTES = 100
export const MAX_INNER_FOOTNOTES = 2
// (a label may hold escaped brackets: "[^a\\]b]:")
const FOOTNOTE_DEF = /\[\^(?:\\.|[^\]\\\n])*\]:/g

/** An answer's text whose footnotes would read slowly (see MAX_FOOTNOTES). */
export function footnotesTooHeavy(text: string): boolean {
  if (!text.includes('[^')) return false
  let all = 0
  let inner = 0
  for (const m of text.matchAll(FOOTNOTE_DEF)) {
    if (++all > MAX_FOOTNOTES) return true
    if (m.index > 0 && text[m.index - 1] !== '\n' && ++inner > MAX_INNER_FOOTNOTES) return true
  }
  return false
}

/** What one child becomes before its words are read:
 * - raw HTML is words: a block of it a paragraph of text, inline HTML text (its mentions, addresses and line breaks are
 *   kept as in the rest of the message; nothing of it is ever HTML);
 * - GFM's autolink literals ("https://…", "www.…", "a@b.c" with no [ ] or < >) are their text again (textLinks rules);
 * - a reference link is its definition's link (the checks below);
 * - a link to "#…" is its words (its ids would jump out of the room and repeat in every message; footnotes are not read
 *   at all: remarkGfmNoFootnotes, footnotesAsText);
 * - a link whose words are another site's address ("[https://bank.com](https://evil.example)"), or look like one,
 *   shows where it really goes: its words, then the real address as a link in brackets; any other link to another
 *   site whose words are not its address, its words (still the link) and then its host in brackets ("(evil.example)",
 *   the address of a mailto: link), so a phone, which has no status bar to show it, shows it too.
 * `origin`: this server (its links are the app's, not another site's). */
function expand(c0: Node, flow: boolean, src: string, found: Found[], defs: Map<string, Node>, origin: string): Node[] {
  const text = (value: string): Node => ({ type: 'text', value })
  // a reference link ("[words][r]" … "[r]: https://…") is the link its definition makes, so the same checks see it
  const def = c0.type === 'linkReference' ? defs.get(c0.identifier ?? '') : undefined
  const c: Node = def ? { type: 'link', url: def.url ?? '', title: def.title ?? null, children: c0.children ?? [], position: c0.position } : c0
  if (c.type === 'html') return [flow ? { type: 'paragraph', children: [text(c.value ?? '')] } : text(c.value ?? '')]
  if (c.type !== 'link') return [c]
  const at = c.position?.start.offset
  if ((at !== undefined && src[at] !== '[' && src[at] !== '<') || (c.url ?? '').startsWith('#')) return c.children ?? []
  // a picture in a link is its words (no link in a link: the picture's card is a link of its own)
  const kids = (c.children ?? []).map(pictureWords)
  const link: Node = { ...c, children: kids }
  // (words that only look like an address, "https://bank.com@x.y", "https://bank．com" or "https:/\u200b/bank.com", show it too)
  const words = textOf(link, found)
  const seen = readAs(words)
  const shown = linkParts(seen).find((p) => p.href)
  const real = restore(c.url ?? '', found)
  if ((shown && hostOf(shown.href!) !== hostOf(real)) || (!shown && /:\/\/|www\./i.test(seen)))
    return [...kids, text(' ('), { type: 'link', url: real, title: null, children: [text(real)], data: { hProperties: { dataPlain: '' } } }, text(')')]
  // any other link to another site whose words are not its address ("[paypal.com](https://evil.example)", "[here](…)",
  // "[ceo@company.com](mailto:x@evil.example)"): its words, then where it goes in brackets, as text
  const l = classifyLink(asHref(real), origin)
  const hidden = l.kind === 'external' ? hiddenAddress(words, l.href) : null
  if (hidden !== null)
    return [link, text(' '), { type: 'realAddress', data: { hName: 'span', hProperties: { className: ['text-muted', '[unicode-bidi:isolate]'], dataRealAddress: '' }, hChildren: [{ type: 'text', value: `(${hidden})` }] } }]
  return [link]
}

/** A link's address as its href will be (mdast-util-to-hast's normalizeUri: what may not stand in a URL percent-encoded,
 * "/\\evil.example" → "/%5Cevil.example"), so it is checked as the link that opens. */
const asHref = (url: string) =>
  url.replace(/%(?![A-Za-z\d]{2})|[^A-Za-z\d!#$%&'()*+,\-./:;=?@_~]/gu, (ch) => {
    try {
      return encodeURIComponent(ch)
    } catch {
      return encodeURIComponent('\ufffd')
    }
  })

/** A picture (and what it holds) as its words: [alt]. */
function pictureWords(n: Node): Node {
  if (n.type === 'image' || n.type === 'imageReference') return { type: 'text', value: n.alt ?? '' }
  return n.children ? { ...n, children: n.children.map(pictureWords) } : n
}

/** The remark step for a person's words (after remark-gfm); `found`: what protectMentions took out; `origin`: this
 * server's. */
export function personWords({ found, origin }: { found: Found[]; origin: string }) {
  return (tree: Node, file: { value?: unknown }) => {
    capDepth(tree)
    const src = typeof file.value === 'string' ? file.value : ''
    footnotesAsText(tree, src)
    // the definitions of reference links, by their identifier
    const defs = new Map<string, Node>()
    const collect = (n: Node) => {
      if (n.type === 'definition' && n.identifier && !defs.has(n.identifier)) defs.set(n.identifier, n)
      n.children?.forEach(collect)
    }
    collect(tree)
    const walk = (node: Node, inLink: boolean) => {
      if (node.children) {
        // (expand), then neighbouring texts joined, so lib/textLinks.ts reads an address with the words around it
        const flow = FLOW.has(node.type)
        const kids: Node[] = []
        for (const c0 of node.children) {
          for (const k of expand(c0, flow, src, found, defs, origin)) {
            const prev = kids.at(-1)
            if (k.type === 'text' && prev?.type === 'text' && !prev.data) prev.value = (prev.value ?? '') + (k.value ?? '')
            else kids.push(k.type === 'text' ? { type: 'text', value: k.value ?? '' } : k)
          }
        }
        const link = inLink || node.type === 'link' || node.type === 'linkReference'
        node.children = kids.flatMap((c) => (c.type === 'text' ? split(c.value ?? '', found, link) : (walk(c, link), [c])))
      }
      // a placeholder anywhere else (code, raw HTML, an address, a picture's words): the name as typed
      if (node.type !== 'text' && typeof node.value === 'string') node.value = restore(node.value, found)
      if (typeof node.url === 'string') node.url = restore(node.url, found)
      if (typeof node.alt === 'string') node.alt = restore(node.alt, found)
      if (typeof node.title === 'string') node.title = restore(node.title, found)
    }
    walk(tree, false)
  }
}
