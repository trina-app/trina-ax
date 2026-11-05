// The AI's Markdown answer as Slack rich text (docs.slack.dev "Rich text block", "Text element", "Link element"), and
// the same answer as plain text for the notification. Slack's mrkdwn was not kept: its `*bold*` closes only before a
// space or punctuation, so "**하나뿐**이에요" showed "*하나뿐*이에요" with the asterisks, and a zero-width space around the
// markers (not documented by Slack) would be copied along with the text. In rich text, bold, italic, strike, code, links
// and lists are fields, not markup Slack parses: they work next to Hangul, in DMs, ephemeral messages and posted thread
// replies alike, and copying gives the words only. A text element is shown as written, so an answer can never mention
// @channel or a person; a link goes only to an http(s) address or the app's own page, and its text never hides where.
import { clip, plain } from './text'

type Style = { bold?: true; italic?: true; strike?: true; code?: true }
export type RichInline =
  | { type: 'text'; text: string; style?: Style }
  | { type: 'link'; url: string; text?: string; style?: Omit<Style, 'code'> }
export type RichSection = { type: 'rich_text_section'; elements: RichInline[] }
export type RichList = { type: 'rich_text_list'; style: 'bullet' | 'ordered'; indent: number; offset?: number; elements: RichSection[] }
export type RichPre = { type: 'rich_text_preformatted'; elements: { type: 'text'; text: string }[] }
export type RichQuote = { type: 'rich_text_quote'; elements: RichInline[] }
export type RichElement = RichSection | RichList | RichPre | RichQuote
export type RichTextBlock = { type: 'rich_text'; elements: RichElement[] }

/** The team's address for the app's own links, an http(s) origin and nothing else; null otherwise */
export const originOf = (o: string | null | undefined): string | null => {
  if (!o) return null
  try { const u = new URL(o); return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === o.replace(/\/$/, '') ? u.origin : null } catch { return null }
}

// ---------------- links ----------------

/** the end of a file name: such a link text is a file, not an address (`budget-2027.txt`, `보고서.hwpx`) */
const FILE_END = /\.(txt|md|markdown|pdf|docx?|xlsx?|pptx?|hwpx?|csv|tsv|json|ya?ml|xml|html?|png|jpe?g|gif|webp|svg|heic|zip|7z|tar|gz|mov|mp4|m4a|mp3|wav|py|js|ts|tsx|jsx|sh|sql|log|key|numbers|pages|rtf|odt|ods|odp|eml)$/i

/** A link text that reads as a web address: with a scheme, `www.`, an IP address or a host name (`acme.example`,
 * `acme.example/refunds`). A file name is not one. */
export function isWebAddress(s: string): boolean {
  const t = s.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^www\./i.test(t)) return true
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]\S*)?$/.test(t)) return true
  const m = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?([/?#]\S*)?$/i.exec(t)
  if (!m || !/\.[a-z]{2,}$/i.test(m[1]!)) return false
  return !!m[2] || /:\d+$/.test(t) || !FILE_END.test(m[1]!)
}

/** the host a web address names (no `www.`, lower case) */
const hostOf = (s: string): string | null => {
  const t = s.trim()
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`).hostname.replace(/^www\./, '').toLowerCase() } catch { return null }
}

/** Where a Markdown link goes: an http(s) address, the app's own page (a path from the root) at the team's address,
 * `'text'` (the app's page with no team address: its text alone) or null (another kind: kept as written) */
function targetOf(url: string, home: string | null): string | 'text' | null {
  if (/^https?:\/\//i.test(url)) { try { new URL(url); return url } catch { return null } }
  if (/^\/(?!\/)/.test(url)) return home ? home + url : 'text'
  return null
}

// ---------------- inline ----------------

const linkStyle = (s: Style | undefined): Omit<Style, 'code'> | undefined => {
  if (!s) return undefined
  const { code: _code, ...rest } = s
  return Object.keys(rest).length ? rest : undefined
}
const sameStyle = (a: object | undefined, b: object | undefined) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})

/** add one element, joined with the one before when they look the same; never an empty text (Slack refuses it) */
function push(out: RichInline[], el: RichInline) {
  if (el.type === 'text' && !el.text) return
  const last = out[out.length - 1]
  if (last?.type === 'text' && el.type === 'text' && sameStyle(last.style, el.style)) { last.text += el.text; return }
  if (last?.type === 'link' && el.type === 'link' && last.url === el.url && last.text !== undefined && el.text !== undefined && sameStyle(last.style, el.style)) { last.text += el.text; return }
  out.push(el)
}
const text = (t: string, style: Style): RichInline => ({ type: 'text', text: t, ...(Object.keys(style).length ? { style: { ...style } } : {}) })

/** the next run of exactly `n` × `ch` from `from` that `ok` accepts; -1 if none */
function findRun(s: string, from: number, ch: string, n: number, ok: (start: number, end: number) => boolean): number {
  let j = s.indexOf(ch, from)
  while (j !== -1) {
    let k = j
    while (s[k] === ch) k++
    if (k - j === n && ok(j, k)) return j
    j = s.indexOf(ch, k)
  }
  return -1
}

const ESCAPABLE = /[!-/:-@[-`{-~]/
const WORD = /[A-Za-z0-9]/
const SPACE = /\s/
/** the address ends with a ) or ] it did not open */
const unopened = (u: string) => {
  const [close, open] = u.endsWith(')') ? [')', '('] : u.endsWith(']') ? [']', '['] : ['', '']
  return !!close && u.split(close).length > u.split(open).length
}
const LINK = /\[((?:[^[\]\n\\]|\\.|\[[^[\]\n]*\]){0,500})\]\(\s*([^\s()]{0,2000}(?:\([^\s()]*\)[^\s()]*)*)(?:\s+"[^"\n]*")?\s*\)/y
const AUTOLINK = /<(https?:\/\/[^\s<>]{1,2000})>/y
const BARE = /https?:\/\/[!#-;=?-~]{1,2000}/iy // ASCII without spaces, ", < and >; text after it (Hangul) is not part of it

/** One line of Markdown as rich text elements (`style`: what the text around it has). Delimiters pair by themselves,
 * whatever letter comes after them (CommonMark's rule would not close `**하나뿐**이에요`); one that does not pair stays as
 * text. `_` does not start or end inside a word (`file_name`). */
function inline(s: string, style: Style, home: string | null, out: RichInline[] = []): RichInline[] {
  let buf = ''
  const flush = () => { if (buf) { push(out, text(buf, style)); buf = '' } }
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.test(s[i + 1]!)) { buf += s[i + 1]; i += 2; continue }
    if (c === '`') {
      let n = 0
      while (s[i + n] === '`') n++
      const j = findRun(s, i + n, '`', n, () => true)
      if (j === -1) { buf += s.slice(i, i + n); i += n; continue }
      let code = s.slice(i + n, j)
      if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1)
      flush()
      push(out, text(code, { ...style, code: true }))
      i = j + n
      continue
    }
    if (c === '[') {
      LINK.lastIndex = i
      const m = LINK.exec(s)
      const target = m ? targetOf(m[2]!, home) : null
      if (m && target !== null) {
        flush()
        const label = inline(m[1]!, style, home).map((e): RichInline => e.type === 'link' ? text(e.text ?? e.url, (e.style ?? {}) as Style) : e)
        if (target === 'text') for (const e of label) push(out, e)
        else {
          const shown = label.map((e) => e.type === 'text' ? e.text : '').join('')
          const own = !!home && (target === home || target.startsWith(home + '/'))
          // a text that reads as another address than the link's: the real address is shown next to it
          if (!own && isWebAddress(shown) && hostOf(shown) !== hostOf(target)) {
            for (const e of label) push(out, e)
            push(out, text(' (', style)); push(out, { type: 'link', url: target, ...(linkStyle(style) ? { style: linkStyle(style) } : {}) }); push(out, text(')', style))
          } else if (!label.length) push(out, { type: 'link', url: target, ...(linkStyle(style) ? { style: linkStyle(style) } : {}) })
          else for (const e of label) if (e.type === 'text') push(out, { type: 'link', url: target, text: e.text, ...(linkStyle(e.style) ? { style: linkStyle(e.style) } : {}) })
        }
        i = LINK.lastIndex
        continue
      }
      if (m) { buf += m[0]; i = LINK.lastIndex; continue } // another kind of link: as written
    }
    if (c === '<') {
      AUTOLINK.lastIndex = i
      const m = AUTOLINK.exec(s)
      if (m) { flush(); push(out, { type: 'link', url: m[1]!, ...(linkStyle(style) ? { style: linkStyle(style) } : {}) }); i = AUTOLINK.lastIndex; continue }
    }
    if ((c === 'h' || c === 'H') && (i === 0 || !WORD.test(s[i - 1]!))) {
      BARE.lastIndex = i
      const m = BARE.exec(s)
      if (m) {
        // punctuation after it, and a closing bracket it did not open, belong to the text: (https://acme.example).
        let url = m[0]
        for (let before = ''; before !== url;) { before = url; url = url.replace(/[.,;:!?*_~'"]+$/, ''); if (unopened(url)) url = url.slice(0, -1) }
        if (/^https?:\/\/[^/?#]/i.test(url) && URL.canParse(url)) { flush(); push(out, { type: 'link', url, ...(linkStyle(style) ? { style: linkStyle(style) } : {}) }); i += url.length; continue }
      }
    }
    if (c === '*' || c === '_' || c === '~') {
      let n = 0
      while (s[i + n] === c) n++
      const add: Style | null = c === '~' ? (n === 2 ? { strike: true } : null) : n === 1 ? { italic: true } : n === 2 ? { bold: true } : n === 3 ? { bold: true, italic: true } : null
      const opens = add && i + n < s.length && !SPACE.test(s[i + n]!) && !(c === '_' && i > 0 && WORD.test(s[i - 1]!))
      const j = opens ? findRun(s, i + n + 1, c, n, (a, b) => !SPACE.test(s[a - 1]!) && !(c === '_' && b < s.length && WORD.test(s[b]!))) : -1
      if (j === -1) { buf += s.slice(i, i + n); i += n; continue }
      flush()
      inline(s.slice(i + n, j), { ...style, ...add }, home, out)
      i = j + n
      continue
    }
    buf += c
    i++
  }
  flush()
  return out
}

// ---------------- blocks ----------------

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const QUOTE = /^ {0,3}>\s?(.*)$/
const HEADING = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/
const ITEM = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/
const RULE = /^ {0,3}([-*_])( *\1){2,} *$/
const widthOf = (ws: string) => ws.replace(/\t/g, '    ').length

/** The AI's Markdown as rich text elements. `origin`: the team's address (where people sign in); the app's own links
 * (`[budget.txt](/files/view?…)`) open there, without it only their text is kept. Paragraphs, headings (bold),
 * bullet and numbered lists (nested by indent), quotes, code blocks and code spans; a table stays as its lines. */
export function richText(md: string, origin: string | null = null): RichElement[] {
  const home = originOf(origin)
  const lines = md.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').split('\n')
  const out: RichElement[] = []
  let para: RichInline[] = []
  let gap = ''
  // the list going on: the widths of its levels; null after anything that is not a list
  let levels: number[] | null = null
  const endPara = () => { if (para.length) out.push({ type: 'rich_text_section', elements: para }); para = []; gap = '' }
  const addLine = (els: RichInline[]) => {
    if (!els.length) return
    if (para.length && gap) push(para, text(gap, {}))
    for (const e of els) push(para, e)
    gap = '\n'
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.trim()) { if (para.length) gap = '\n\n'; continue }
    const fence = FENCE.exec(line)
    // (```code``` on one line is a code span, not a block)
    if (fence && !(fence[1]![0] === '`' && line.slice(fence[0].length).includes('`'))) {
      endPara(); levels = null
      const mark = fence[1]!
      const body: string[] = []
      for (i++; i < lines.length; i++) {
        const close = /^ {0,3}(`+|~+)\s*$/.exec(lines[i]!)
        if (close && close[1]![0] === mark[0] && close[1]!.length >= mark.length) break
        body.push(lines[i]!)
      }
      const code = body.join('\n')
      if (code.trim()) out.push({ type: 'rich_text_preformatted', elements: [{ type: 'text', text: code }] })
      continue
    }
    if (QUOTE.test(line)) {
      endPara(); levels = null
      const quoted: string[] = []
      for (; i < lines.length && QUOTE.test(lines[i]!); i++) quoted.push(QUOTE.exec(lines[i]!)![1]!.replace(/^(\s*)[-*+]\s+/, '$1• '))
      i--
      const els: RichInline[] = []
      quoted.join('\n').trim().split('\n').forEach((l, k) => { if (k) push(els, text('\n', {})); inline(l, {}, home, els) })
      if (els.length) out.push({ type: 'rich_text_quote', elements: els })
      continue
    }
    // a rule: a break between paragraphs
    if (RULE.test(line)) { levels = null; if (para.length) gap = '\n\n'; continue }
    const item = ITEM.exec(line)
    if (item && item[4]!.trim()) {
      endPara()
      const width = widthOf(item[1]!)
      const continuing = levels !== null
      levels ??= []
      while (levels.length && width < levels[levels.length - 1]!) levels.pop()
      if (!levels.length || width > levels[levels.length - 1]!) levels.push(width)
      const indent = Math.min(8, levels.length - 1)
      const style = item[3] ? 'ordered' : 'bullet'
      const entry: RichSection = { type: 'rich_text_section', elements: inline(item[4]!.trimEnd(), {}, home) }
      if (!entry.elements.length) continue
      const last = out[out.length - 1]
      if (continuing && last?.type === 'rich_text_list' && last.style === style && last.indent === indent) last.elements.push(entry)
      else {
        const n = item[3] ? Number(item[3]) : 1
        out.push({ type: 'rich_text_list', style, indent, ...(n > 1 ? { offset: n - 1 } : {}), elements: [entry] })
      }
      continue
    }
    // a line indented under a list item goes on in that item
    const last = out[out.length - 1]
    if (levels && last?.type === 'rich_text_list' && widthOf(/^\s*/.exec(line)![0]) >= 2 && !para.length) {
      const entry = last.elements[last.elements.length - 1]!
      push(entry.elements, text('\n', {}))
      inline(line.trim(), {}, home, entry.elements)
      continue
    }
    levels = null
    const heading = HEADING.exec(line)
    if (heading) { addLine(inline(heading[1]!, { bold: true }, home)); continue }
    addLine(inline(line.trimEnd(), {}, home))
  }
  endPara()
  return out
}

/** Text as it is, no Markdown read (a sentence of ours: why an answer failed) */
export const literal = (s: string): RichElement[] => s ? [{ type: 'rich_text_section', elements: [{ type: 'text', text: s }] }] : []

const inlineText = (els: RichInline[]) => els.map((e) => e.type === 'text' ? e.text : e.text ?? e.url).join('')

/** The elements as plain text: no markers, a link as its text (its address when it has none), list items with • or
 * their number. */
export function plainOf(els: RichElement[]): string {
  return els.map((e) => {
    if (e.type === 'rich_text_section' || e.type === 'rich_text_quote') return inlineText(e.elements)
    if (e.type === 'rich_text_preformatted') return e.elements.map((t) => t.text).join('')
    return e.elements.map((it, k) => `${'  '.repeat(e.indent)}${e.style === 'ordered' ? `${(e.offset ?? 0) + k + 1}.` : '•'} ${inlineText(it.elements)}`).join('\n')
  }).join('\n')
}

// ---------------- sizes ----------------

const inlineSize = (e: RichInline) => e.type === 'text' ? e.text.length : (e.text?.length ?? 0) + e.url.length
const sizeOf = (e: RichElement): number =>
  e.type === 'rich_text_list' ? e.elements.reduce((n, it) => n + sizeOf(it), 0)
    : e.type === 'rich_text_preformatted' ? e.elements.reduce((n, t) => n + t.text.length, 0)
      : e.elements.reduce((n, x) => n + inlineSize(x), 0)

/** where to cut `s` to at most `room` characters: a line end, else a space, else `room` (never inside a surrogate pair) */
function cutAt(s: string, room: number): number {
  let at = s.lastIndexOf('\n', room)
  if (at < room * 0.6) at = s.lastIndexOf(' ', room)
  if (at < room * 0.6) at = room
  if (/[\ud800-\udbff]/.test(s[at - 1] ?? '')) at--
  return Math.max(1, at)
}

/** inline elements in runs of at most `budget` characters (a text is cut at a line end or space; a link is never cut) */
function splitInline(els: RichInline[], budget: number): RichInline[][] {
  const out: RichInline[][] = []
  let cur: RichInline[] = []
  let size = 0
  for (const el of els) {
    let rest: RichInline | null = { ...el }
    while (rest) {
      const n = inlineSize(rest)
      if (size + n <= budget) { cur.push(rest); size += n; rest = null; continue }
      if (rest.type === 'text' && budget - size >= Math.min(200, budget)) {
        const at = cutAt(rest.text, budget - size)
        cur.push({ ...rest, text: rest.text.slice(0, at) })
        const left: string = rest.text.slice(at).replace(/^\s+/, '')
        rest = left ? { ...rest, text: left } : null
      }
      if (cur.length) { out.push(cur); cur = []; size = 0 }
      else if (rest) { cur.push(rest); size += inlineSize(rest); rest = null } // a link longer than a block: whole
    }
  }
  if (cur.length) out.push(cur)
  return out
}

/** one element in pieces of at most `budget` characters each */
function split(e: RichElement, budget: number): RichElement[] {
  if (sizeOf(e) <= budget) return [e]
  if (e.type === 'rich_text_section' || e.type === 'rich_text_quote') return splitInline(e.elements, budget).map((els) => ({ ...e, elements: els }))
  if (e.type === 'rich_text_preformatted') {
    const pieces: RichElement[] = []
    let rest = e.elements.map((t) => t.text).join('')
    while (rest) { const at = rest.length <= budget ? rest.length : cutAt(rest, budget); pieces.push({ type: 'rich_text_preformatted', elements: [{ type: 'text', text: rest.slice(0, at) }] }); rest = rest.slice(at).replace(/^\n/, '') }
    return pieces
  }
  const items = e.elements.flatMap((it) => splitInline(it.elements, budget).map((els): RichSection => ({ type: 'rich_text_section', elements: els })))
  const lists: RichList[] = []
  let start = e.offset ?? 0
  let cur: RichSection[] = []
  let size = 0
  for (const it of items) {
    const n = sizeOf(it)
    if (cur.length && size + n > budget) { lists.push({ ...e, ...(start ? { offset: start } : {}), elements: cur }); start += cur.length; cur = []; size = 0 }
    cur.push(it); size += n
  }
  if (cur.length) lists.push({ ...e, ...(start ? { offset: start } : {}), elements: cur })
  return lists
}

/** The elements in rich_text blocks of about `budget` characters, at most `max` of them; `cut`: something was left out
 * (the last block ends with " …"). Slack documents no size for a rich_text block; 2,900 is what a section allows. */
export function richBlocks(els: RichElement[], max: number, budget = 2900): { blocks: RichTextBlock[]; cut: boolean } {
  const blocks: RichTextBlock[] = []
  let cur: RichElement[] = []
  let size = 0
  let cut = false
  for (const piece of els.flatMap((e) => split(e, budget))) {
    const n = sizeOf(piece)
    if (cur.length && size + n > budget) {
      blocks.push({ type: 'rich_text', elements: cur }); cur = []; size = 0
      if (blocks.length >= max) { cut = true; break }
    }
    cur.push(piece); size += n
  }
  if (cur.length) blocks.push({ type: 'rich_text', elements: cur })
  if (cut) {
    const last = blocks[blocks.length - 1]!.elements
    const end = last[last.length - 1]
    // a copy: the elements are the caller's too
    if (end?.type === 'rich_text_section' || end?.type === 'rich_text_quote') {
      const copy = { ...end, elements: end.elements.map((x) => ({ ...x })) }
      push(copy.elements, text(' …', {}))
      last[last.length - 1] = copy
    } else last.push({ type: 'rich_text_section', elements: [{ type: 'text', text: '…' }] })
  }
  return { blocks, cut }
}

/** An answer for Slack: its blocks (at most `max`), whether it was cut, the notification text (plain, at most about
 * 300 characters, with Slack's `&`, `<`, `>` written out), and `plainBlocks`, the same answer as plain text in one block
 * for when Slack refuses the blocks (Slack documents no size for rich text, but has `msg_blocks_too_long`).
 * `markdown: false`: a sentence of ours, as it is. */
export function slackAnswer(s: string, origin: string | null, max: number, markdown = true): { blocks: RichTextBlock[]; cut: boolean; text: string; plainBlocks: RichTextBlock[] } {
  let els = markdown ? richText(s, origin) : literal(s)
  if (!els.length) els = literal(s.trim() ? s : '…')
  const { blocks, cut } = richBlocks(els, max)
  const flat = plainOf(els)
  return { blocks, cut, text: plain(clip(flat, 300).text), plainBlocks: richBlocks(literal(clip(flat, 2900).text), 1).blocks }
}
