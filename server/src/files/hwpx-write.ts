// make_file's Hangul documents (.hwpx, OWPML / KS X 6101): pandoc's JSON tree of the AI's Markdown becomes a new
// .hwpx in pure TypeScript. Runs ONLY in the office worker (files/office-worker.ts, isolated like the other
// converters), never in the server process: the template is an untrusted zip and the tree comes from the AI.
//
// Supported (stage 1): headings (# to ######) as outline levels 개요 1-6, paragraphs (with hard line breaks), bold,
// italic, bullet and numbered lists (6 levels), simple tables (no merged cells; plain text in cells, the header row
// bold) and page breaks (a line `\newpage` or `\pagebreak`). Everything else is refused with one ToolError that names
// all of it; nothing is written, so a file never holds half the document.
//
// Styles and the page come from a template: the built-in one (files/hwpx-template.ts) or a team's .hwpx under
// skills/, like pandoc's reference document. A template is untrusted input: size and zip limits, no scripts
// (Scripts/), OLE objects or encryption, and its header.xml and first section are read by an XML parser (well-formed,
// no DTD, comments, CDATA or processing instructions, Hangul's prefixes for Hangul's namespaces). Only allowlisted
// parts are kept and written again in one canonical form before anything edits them as text: from the header the
// reference lists (fonts, border fills, character and paragraph shapes, tabs, numbering, bullets, styles, memo
// shapes), the numbering start, compatibility and options (the path of a linked document emptied; tracked changes and
// their authors, metadata and anything else left out); from the first section its page setup (paper, margins, grid,
// note and page border settings; no master pages) and columns. Below that, every element must be one Hangul writes
// there and text only a numbering label (anything else is refused), and nothing may point at BinData, an address or a
// path. Of the section only those two become trees. Its text, pictures, headers and footers are not used.
//
// The writer adds what the document needs to the header (bold and italic variants of character shapes, list and
// table-cell paragraph shapes, numbering, bullets, table borders) after the template's own items, with the next ids.
import { SaxesParser } from 'saxes'
import * as XLSX from 'xlsx'
import { ToolError } from '../policy/errors'
import { checkZip, isZip } from './zip-guard'
import { writeZip, type ZipEntry } from './zip-write'
import { COL_PR, NO_CHAR_SHAPE, NS_ATTRS, OWPML_NS, XML_DECL, defaultTemplate, paraHeadXml, paraPrXml, type ParaShape } from './hwpx-template'
import { cleanText, decodeHwpxRequest, HWPX_TEMPLATE_MAX, HWPX_TEXT_MAX } from './hwpx-check'
// the product module alone: the shared index brings zod into the office worker's bundle, and a second Bun.build of zod
// in the same process (tests) then fails with EISDIR on Linux
import { PRODUCT } from '@mycel/shared/product'

const MIB = 1024 * 1024
export const HWPX_LIMITS = {
  templateBytes: HWPX_TEMPLATE_MAX,
  templateExpanded: 64 * MIB,
  templateEntries: 1000,
  headerBytes: 16 * MIB,
  xmlDepth: 64,
  listDepth: 6,
  inlineDepth: 64,
  tableColumns: 64,
  tableCells: 10_000,
  /** ordered lists (each has its own numbering, so each starts again) */
  numberedLists: 1000,
}

const NS = Object.fromEntries(OWPML_NS) as Record<(typeof OWPML_NS)[number][0], string>

// ---------------------------------------------------------------- the document model
interface Run { text: string; bold: boolean; italic: boolean }
type Align = 'LEFT' | 'RIGHT' | 'CENTER'
interface ListPos { kind: 'bullet' | 'number'; depth: number; numbering?: number; continued?: boolean }
interface Para { k: 'p'; heading: number; list?: ListPos; runs: Run[]; pageBreak: boolean }
interface Cell { align: Align; paras: Run[][] }
interface Table { k: 'table'; widths: number[]; rows: { head: boolean; cells: Cell[] }[]; pageBreak: boolean }
type Block = Para | Table
interface Numbering { start: number; format: string; label: string }

interface Node { t?: unknown; c?: unknown }
const isNode = (v: unknown): v is Node => !!v && typeof v === 'object' && !Array.isArray(v)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** what the person reads in the refusal, by pandoc node */
const NAMES: Record<string, string> = {
  CodeBlock: 'code blocks', BlockQuote: 'block quotes (>)', HorizontalRule: 'horizontal rules (---)', DefinitionList: 'definition lists',
  LineBlock: 'line blocks (| ...)', Div: 'divs (::: or <div>)', Figure: 'images', Image: 'images', Note: 'footnotes', Link: 'links',
  Code: 'inline code (`...`)', Math: 'math', Strikeout: 'strikethrough (~~)', Underline: 'underline', Superscript: 'superscript',
  Subscript: 'subscript', SmallCaps: 'small caps', Cite: 'citations', Span: 'bracketed spans ([...]{...})',
}
const QUOTES: Record<string, [string, string]> = { DoubleQuote: ['“', '”'], SingleQuote: ['‘', '’'] }
const PAGE_BREAK = /^\\(?:newpage|pagebreak|clearpage)\s*$/
const FORMATS: Record<string, string> = { LowerAlpha: 'LATIN_SMALL', UpperAlpha: 'LATIN_CAPITAL', LowerRoman: 'ROMAN_SMALL', UpperRoman: 'ROMAN_CAPITAL' }
const DELIMS: Record<string, string> = { OneParen: '^1)', TwoParens: '(^1)' }

class Converter {
  readonly blocks: Block[] = []
  readonly numberings: Numbering[] = []
  private problems = new Map<string, number>()
  private pendingBreak = false
  private chars = 0

  problem(what: string) { this.problems.set(what, (this.problems.get(what) ?? 0) + 1) }
  refusal(): string | null {
    if (!this.problems.size) return null
    const list = [...this.problems].map(([w, n]) => (n > 1 ? `${w} (${n})` : w)).join(', ')
    return `a .hwpx cannot hold this document yet: ${list}. Nothing was saved. Supported: headings (# to ######), paragraphs, **bold**, *italic*, ` +
      'bullet and numbered lists (up to 6 levels), simple tables (no merged cells, plain text in cells) and page breaks (a line \\newpage). ' +
      'Leave the rest out or write it as plain text (a link as "text (address)"), then try again.'
  }

  document(ast: unknown) {
    if (!isNode(ast) || !Array.isArray((ast as { blocks?: unknown }).blocks)) throw new ToolError('the converter produced an unexpected document tree')
    const meta = (ast as { meta?: unknown }).meta
    if (isNode(meta) && Object.keys(meta).length) this.problem(`YAML metadata (${Object.keys(meta).slice(0, 5).join(', ')}): write the title as a # heading`)
    this.top((ast as { blocks: unknown[] }).blocks)
    if (this.chars > HWPX_TEXT_MAX) throw new ToolError(`the document is too long for a .hwpx (more than ${HWPX_TEXT_MAX.toLocaleString('en')} characters)`)
  }

  private emit(b: Block) {
    if (this.pendingBreak) { b.pageBreak = true; this.pendingBreak = false }
    this.blocks.push(b)
  }

  private top(blocks: unknown[]) {
    for (const b of blocks) {
      if (!isNode(b)) continue
      const c = b.c as any
      switch (b.t) {
        case 'Header': {
          const level = Number(c?.[0])
          this.emit({ k: 'p', heading: Number.isInteger(level) && level >= 1 ? Math.min(level, 6) : 1, runs: this.inlines(c?.[2], true), pageBreak: false })
          break
        }
        case 'Para': case 'Plain': this.emit({ k: 'p', heading: 0, runs: this.inlines(c, false), pageBreak: false }); break
        case 'BulletList': case 'OrderedList': this.list(b, 0); break
        case 'Table': { const t = this.table(c); if (t) this.emit(t); break }
        case 'RawBlock': {
          const [format, text] = arr(c) as [unknown, unknown]
          if (/^(tex|latex)$/.test(String(format)) && PAGE_BREAK.test(String(text).trim())) {
            // a break before any text does nothing; two in a row leave an empty page between them
            if (!this.blocks.length) break
            if (this.pendingBreak) this.blocks.push({ k: 'p', heading: 0, runs: [], pageBreak: true })
            this.pendingBreak = true
          } else this.problem(String(format) === 'html' ? 'raw HTML' : `raw ${String(format).slice(0, 20)} markup`)
          break
        }
        default: this.problem(NAMES[String(b.t)] ?? `${String(b.t).slice(0, 40)} blocks`)
      }
    }
  }

  private list(b: Node, depth: number) {
    if (depth >= HWPX_LIMITS.listDepth) { this.problem(`lists nested more than ${HWPX_LIMITS.listDepth} levels`); return }
    let items: unknown[]
    let pos: ListPos
    if (b.t === 'OrderedList') {
      const [attrs, list] = arr(b.c) as [unknown[], unknown[]]
      const [start, style, delim] = arr(attrs) as [unknown, Node, Node]
      if (this.numberings.length >= HWPX_LIMITS.numberedLists) { this.problem(`more than ${HWPX_LIMITS.numberedLists} numbered lists`); return }
      // Hangul draws a list that starts at 0 from 1, and keeps start numbers to 16 bits: refused, not changed
      const n = Number(start)
      if (!(Number.isInteger(n) && n >= 1 && n <= 65535)) { this.problem('numbered lists that start at 0 or above 65535'); return }
      this.numberings.push({ start: n, format: FORMATS[String(style?.t)] ?? 'DIGIT', label: DELIMS[String(delim?.t)] ?? '^1.' })
      pos = { kind: 'number', depth, numbering: this.numberings.length }
      items = arr(list)
    } else {
      pos = { kind: 'bullet', depth }
      items = arr(b.c)
    }
    for (const item of items) {
      let first = true
      for (const x of arr(item)) {
        if (!isNode(x)) continue
        if (x.t === 'Para' || x.t === 'Plain') {
          this.emit({ k: 'p', heading: 0, list: first ? pos : { ...pos, continued: true }, runs: this.inlines(x.c, false), pageBreak: false })
          first = false
        } else if (x.t === 'BulletList' || x.t === 'OrderedList') {
          // an item that starts with a list: its own (empty) line first, as a word processor shows it
          if (first) { this.emit({ k: 'p', heading: 0, list: pos, runs: [], pageBreak: false }); first = false }
          this.list(x, depth + 1)
        } else this.problem(x.t === 'Table' ? 'tables inside list items' : x.t === 'Header' ? 'headings inside list items' : `${NAMES[String(x.t)] ?? String(x.t)} inside list items`)
      }
      // an empty item keeps its place (and its number: "1. a / 2. / 3. c" stays 1, 2, 3)
      if (first) this.emit({ k: 'p', heading: 0, list: pos, runs: [], pageBreak: false })
    }
  }

  private table(c: any): Table | null {
    const [, caption, colspecs, thead, tbodies, tfoot] = arr(c) as any[]
    if (arr(arr(caption)[1]).length) this.problem('table captions')
    const specs = arr(colspecs) as [Node, Node][]
    const cols = specs.length
    if (!cols) return null
    if (cols > HWPX_LIMITS.tableColumns) { this.problem(`tables wider than ${HWPX_LIMITS.tableColumns} columns`); return null }
    const rows: { head: boolean; row: unknown }[] = []
    for (const r of arr(arr(thead)[1])) rows.push({ head: true, row: r })
    for (const body of arr(tbodies)) {
      for (const r of arr(arr(body)[2])) rows.push({ head: true, row: r })
      for (const r of arr(arr(body)[3])) rows.push({ head: false, row: r })
    }
    for (const r of arr(arr(tfoot)[1])) rows.push({ head: false, row: r })
    // a table without rows holds no text, and Hangul has no table of no rows
    if (!rows.length) return null
    if (rows.length * cols > HWPX_LIMITS.tableCells) { this.problem(`tables with more than ${HWPX_LIMITS.tableCells.toLocaleString('en')} cells`); return null }
    const colAlign = specs.map((s) => align(arr(s)[0]))
    const given = specs.map((s) => { const w = arr(s)[1] as Node; return w?.t === 'ColWidth' && Number(w.c) > 0 ? Number(w.c) : 0 })
    const sum = given.reduce((a, b) => a + b, 0)
    const unset = given.filter((w) => !w).length
    const rest = unset ? Math.max(0.02, (1 - Math.min(sum, 1)) / unset) : 0
    const widths = given.map((w) => w || rest || 1)
    const out: Table = { k: 'table', widths, rows: [], pageBreak: false }
    for (const { head, row } of rows) {
      const cells: Cell[] = []
      for (const cell of arr(arr(row)[1])) {
        const [, a, rowspan, colspan, blocks] = arr(cell) as [unknown, Node, unknown, unknown, unknown[]]
        if (Number(rowspan) !== 1 || Number(colspan) !== 1) this.problem('merged table cells')
        const paras: Run[][] = []
        for (const x of arr(blocks)) {
          if (!isNode(x)) continue
          if (x.t === 'Para' || x.t === 'Plain') paras.push(this.inlines(x.c, false, head))
          else this.problem(x.t === 'Table' ? 'nested tables' : x.t === 'BulletList' || x.t === 'OrderedList' ? 'lists inside table cells' : x.t === 'Header' ? 'headings inside table cells' : `${NAMES[String(x.t)] ?? String(x.t)} inside table cells`)
        }
        const own = align(a)
        cells.push({ align: own ?? colAlign[cells.length] ?? 'LEFT', paras })
      }
      if (cells.length > cols) this.problem('table rows with more cells than the table has columns')
      while (cells.length < cols) cells.push({ align: colAlign[cells.length] ?? 'LEFT', paras: [] })
      out.rows.push({ head, cells: cells.slice(0, cols) })
    }
    return out
  }

  /** Runs of formatted text; Space and SoftBreak are spaces, LineBreak a line break inside the paragraph ("\n"). */
  private inlines(inlines: unknown, heading: boolean, bold = false): Run[] {
    const runs: Run[] = []
    const add = (text: string, b: boolean, i: boolean) => {
      text = cleanText(text)
      if (!text) return
      this.chars += text.length
      const last = runs[runs.length - 1]
      if (last && last.bold === b && last.italic === i) last.text += text
      else runs.push({ text, bold: b, italic: i })
    }
    type Frame = { list: unknown[]; i: number; bold: boolean; italic: boolean; close?: string }
    const stack: Frame[] = [{ list: arr(inlines), i: 0, bold, italic: false }]
    while (stack.length) {
      const f = stack[stack.length - 1]!
      if (f.i >= f.list.length) { stack.pop(); if (f.close) add(f.close, f.bold, f.italic); continue }
      const v = f.list[f.i++]
      if (!isNode(v)) continue
      switch (v.t) {
        case 'Str': add(String(v.c ?? ''), f.bold, f.italic); break
        case 'Space': case 'SoftBreak': add(' ', f.bold, f.italic); break
        case 'LineBreak': add(heading ? ' ' : '\n', f.bold, f.italic); break
        case 'Strong': case 'Emph': case 'Quoted': {
          if (stack.length >= HWPX_LIMITS.inlineDepth) { this.problem('formatting nested too deeply'); break }
          if (v.t === 'Quoted') {
            const [kind, inner] = arr(v.c) as [Node, unknown]
            const q = QUOTES[String(kind?.t)] ?? ['"', '"']
            add(q[0], f.bold, f.italic)
            stack.push({ list: arr(inner), i: 0, bold: f.bold, italic: f.italic, close: q[1] })
          } else stack.push({ list: arr(v.c), i: 0, bold: f.bold || v.t === 'Strong', italic: f.italic || v.t === 'Emph' })
          break
        }
        case 'RawInline': {
          const [format] = arr(v.c)
          this.problem(String(format) === 'html' ? 'raw HTML' : `raw ${String(format).slice(0, 20)} markup`)
          break
        }
        default: this.problem(NAMES[String(v.t)] ?? `${String(v.t).slice(0, 40)}`)
      }
    }
    return runs
  }
}

function align(a: unknown): Align | undefined {
  const t = isNode(a) ? a.t : undefined
  return t === 'AlignRight' ? 'RIGHT' : t === 'AlignCenter' ? 'CENTER' : t === 'AlignLeft' ? 'LEFT' : undefined
}

// ---------------------------------------------------------------- XML helpers
const TEMPLATE_BAD = 'the template cannot be used'
export const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;')
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unescape = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m))

/** The end (index after '>') of the tag that starts at `start` ('<'), quotes respected. */
function tagEnd(xml: string, start: number): number {
  let q = ''
  for (let i = start + 1; i < xml.length; i++) {
    const ch = xml[i]
    if (q) { if (ch === q) q = ''; continue }
    if (ch === '"' || ch === "'") q = ch
    else if (ch === '>') return i + 1
  }
  throw new ToolError('the template is damaged (an unfinished tag)')
}

function attrsOf(tag: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of tag.matchAll(/\s([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out.set(m[1]!, unescape(m[2] ?? m[3] ?? ''))
  return out
}

interface El { start: number; end: number; open: string; self: boolean; attrs: Map<string, string>; xml: string }

/** Every element `qname` in `xml`, in order. Only for XML this module wrote itself (the template's parts are written
 * again by serialize() first: every closing tag exactly `</qname>`, no quote or `<` inside a value, no comments), and
 * for elements that do not nest in themselves (the header's are refused when they do). */
function elements(xml: string, qname: string, from = 0, to = xml.length): El[] {
  const out: El[] = []
  const needle = '<' + qname
  for (let i = xml.indexOf(needle, from); i >= 0 && i < to; i = xml.indexOf(needle, i + 1)) {
    const next = xml[i + needle.length]
    if (next !== ' ' && next !== '>' && next !== '/' && next !== '\t' && next !== '\n' && next !== '\r') continue
    const openEnd = tagEnd(xml, i)
    const open = xml.slice(i, openEnd)
    const self = open.endsWith('/>')
    let end = openEnd
    if (!self) {
      const close = xml.indexOf(`</${qname}>`, openEnd)
      if (close < 0) throw new ToolError('the template is damaged (an element is not closed)')
      end = close + qname.length + 3
    }
    out.push({ start: i, end, open, self, attrs: attrsOf(open), xml: xml.slice(i, end) })
    i = end - 1
  }
  return out
}

const withAttr = (open: string, name: string, value: string) => {
  const re = new RegExp(`(\\s${name.replace(/[.:]/g, '\\$&')}\\s*=\\s*)("[^"]*"|'[^']*')`)
  return re.test(open) ? open.replace(re, `$1"${escAttr(value)}"`) : open.replace(/\s*(\/?>)$/, ` ${name}="${escAttr(value)}"$1`)
}

/** An element of a template part as saxes read it: its qualified name, attributes in order, children. */
export interface XNode { name: string; attrs: [string, string][]; kids: (XNode | string)[] }
/** how a check refuses: a template's message by default; files/hwpx-edit.ts passes the one for a document */
export type Refuse = (part: string, why: string) => never
const templateRefuse: Refuse = (part, why) => { throw new ToolError(`${TEMPLATE_BAD} (${part}: ${why}). Use a .hwpx saved by Hangul, or no template.`) }
/** elements of a template part that become a tree (Hangul's largest header in a corpus of 1,124 files has 15,050) */
const TREE_NODES_MAX = 200_000
/** elements of a part that is only checked, not kept (a template's text) */
const XML_NODES_MAX = 2_000_000

/**
 * Reads one XML part of a template: well-formed, at most HWPX_LIMITS.xmlDepth deep, no DTD, comments, CDATA or
 * processing instructions, Hangul's own prefixes for Hangul's namespaces and never another namespace for one of those
 * prefixes (the writer adds elements with them). Returns the whole part as a tree, or with `only` just the first
 * element of each of those names with what is inside it (the rest is checked and dropped, so a template's long text
 * costs no memory). `noSelfNesting`: an element inside one of the same name is refused (the header's items never nest).
 * `maxNodes`: how many elements the part may have. `visit`: called at every element's start (with its attributes) and
 * end, and with every attribute and every text by the name of
 * the element they are in (files/hwpx-edit.ts looks for references outside the document).
 */
export function parseXml(xml: string, part: string, o: {
  noSelfNesting?: boolean; only?: string[]; refuse?: Refuse; maxNodes?: number
  visit?: { open?: (el: string, attrs: Map<string, string>) => void; close?: (el: string) => void; attr?: (el: string, name: string, value: string) => void; text?: (el: string, text: string) => void }
} = {}): Map<string, XNode> {
  const bad = (why: string): never => (o.refuse ?? templateRefuse)(part, why)
  const maxNodes = o.maxNodes ?? XML_NODES_MAX
  const parser = new SaxesParser({ xmlns: true })
  const canonical = new Map<string, string>(OWPML_NS.map(([p, u]) => [u, p]))
  const bound = new Map<string, string>(OWPML_NS.map(([p, u]) => [p, u]))
  /** the open elements' names, and the tree under construction (only inside a kept element) */
  const names: string[] = []
  const stack: XNode[] = []
  const out = new Map<string, XNode>()
  let roots = 0, nodes = 0, kept = 0
  parser.on('error', (e) => bad(`not well-formed XML: ${String(e.message).slice(0, 120)}`))
  parser.on('doctype', () => bad('a DTD'))
  parser.on('comment', () => bad('comments'))
  parser.on('cdata', () => bad('CDATA sections'))
  parser.on('processinginstruction', () => bad('processing instructions'))
  parser.on('opentag', (tag) => {
    if (names.length >= HWPX_LIMITS.xmlDepth) bad(`nested more than ${HWPX_LIMITS.xmlDepth} levels`)
    if (++nodes > maxNodes) bad('too many elements')
    if (!names.length && ++roots > 1) bad('two root elements')
    const want = canonical.get(tag.uri)
    if (want !== undefined && tag.prefix !== want) bad(`the prefix "${tag.prefix}" for ${want}`)
    for (const [p, u] of Object.entries(tag.ns ?? {})) if (bound.has(p) && bound.get(p) !== u) bad(`the prefix "${p}" bound to another namespace`)
    if (o.noSelfNesting && names.includes(tag.name)) bad(`${tag.name} inside ${tag.name}`)
    if (o.visit?.attr) for (const a of Object.values(tag.attributes)) o.visit.attr(tag.name, a.name, a.value)
    if (o.visit?.open) o.visit.open(tag.name, new Map(Object.values(tag.attributes).map((a) => [a.name, a.value])))
    names.push(tag.name)
    const keep = stack.length > 0 || (o.only ? o.only.includes(tag.name) && !out.has(tag.name) : names.length === 1)
    if (!keep) return
    if (++kept > TREE_NODES_MAX) bad('too many elements')
    const node: XNode = { name: tag.name, attrs: Object.values(tag.attributes).map((a) => [a.name, a.value] as [string, string]), kids: [] }
    if (stack.length) stack[stack.length - 1]!.kids.push(node)
    else out.set(tag.name, node)
    stack.push(node)
  })
  parser.on('text', (t) => {
    if (o.visit?.text && names.length) o.visit.text(names[names.length - 1]!, t)
    if (stack.length) stack[stack.length - 1]!.kids.push(t)
  })
  parser.on('closetag', () => { const n = names.pop(); if (n !== undefined) o.visit?.close?.(n); if (stack.length) stack.pop() })
  parser.write(xml).close()
  if (!roots) bad('empty')
  return out
}

/** A tree written back as XML in one canonical form: double-quoted values with `& < > " ' =` and tab and line ends
 * escaped (so a value can never look like another attribute to the edits), text with `& < >` and CR escaped, `<a/>`
 * for an element without children, `</a>` exactly. The header edits work on this form only. */
function serialize(n: XNode): string {
  const attrs = n.attrs.map(([k, v]) => ` ${k}="${escAttr(v).replace(/'/g, '&apos;').replace(/=/g, '&#61;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;')}"`).join('')
  if (!n.kids.length) return `<${n.name}${attrs}/>`
  return `<${n.name}${attrs}>${n.kids.map((k) => (typeof k === 'string' ? escText(k).replace(/\r/g, '&#13;') : serialize(k))).join('')}</${n.name}>`
}

const attr = (n: XNode, k: string) => n.attrs.find(([a]) => a === k)?.[1]
const setAttr = (n: XNode, k: string, v: string) => { const a = n.attrs.find(([x]) => x === k); if (a) a[1] = v; else n.attrs.push([k, v]) }
const find = (n: XNode, name: string): XNode | undefined => {
  for (const k of n.kids) {
    if (typeof k === 'string') continue
    if (k.name === name) return k
    const deep = find(k, name)
    if (deep) return deep
  }
  return undefined
}
/** keeps only the child elements named in `allowed` (text between them stays) */
const keepKids = (n: XNode, allowed: Set<string>) => { n.kids = n.kids.filter((k) => typeof k === 'string' || allowed.has(k.name)) }

/** an address or a path: \\server, //host, scheme://, file:, C:\ or C:/ */
const ADDRESS = /^\s*(\\\\|\/\/|[a-z][a-z0-9+.-]*:\/\/|file:|[a-z]:[\\/])/i

/**
 * Throws unless everything below the kept top of a part is what Hangul writes there: element names from `allowed`
 * only (the names Hangul uses in these parts; anything else, a field or a picture for example, is refused, not
 * dropped), text only in `textIn` elements (a numbering label), and no reference outside the file: a BinData item
 * (pictures, embedded fonts; BinData is not carried over) or an address or path, in an attribute or in text.
 * Namespace names are not addresses. Under hh:layoutCompatibility, Hangul's empty flag elements are allowed.
 * `refuse`: the caller's refusal (a document being changed, files/hwpx-edit.ts) instead of a template's.
 */
export function assertKnown(n: XNode, part: string, allowed: Set<string>, textIn: Set<string> = new Set(), refuse?: Refuse) {
  const bad = (why: string): never => {
    if (refuse) return refuse(part, why.replace(/, which make_file does not carry over$/, ''))
    throw new ToolError(`${TEMPLATE_BAD}: ${part} ${why}. Use a .hwpx saved by Hangul, or no template.`)
  }
  const stack = [n]
  while (stack.length) {
    const e = stack.pop()!
    const flags = e.name === 'hh:layoutCompatibility'
    for (const [k, v] of e.attrs) {
      if (/^xmlns(:|$)/.test(k) || /required-namespace$/.test(k)) continue
      if (/binaryItemIDRef$/i.test(k) && v.trim()) bad('uses pictures or embedded fonts (BinData), which are not carried over')
      if (ADDRESS.test(v)) bad(`refers to an address or path (${k})`)
    }
    for (const k of e.kids) {
      if (typeof k === 'string') {
        if (!k.trim()) continue
        if (!textIn.has(e.name)) bad(`has text in ${e.name}`)
        if (ADDRESS.test(k)) bad(`refers to an address or path (${e.name})`)
        continue
      }
      if (flags && /^hh:\w+$/.test(k.name) && !k.attrs.length && !k.kids.length) continue
      if (!allowed.has(k.name)) bad(`holds ${k.name.slice(0, 60)}, which make_file does not carry over`)
      stack.push(k)
    }
  }
}

/** The element names Hangul writes in the kept parts (from Hangul-saved files and the OWPML schema). */
const HEAD_NAMES = new Set([
  'hh:beginNum', 'hh:refList', 'hh:compatibleDocument', 'hh:layoutCompatibility', 'hh:docOption', 'hh:linkinfo', 'hh:trackchageConfig',
  'hh:fontfaces', 'hh:fontface', 'hh:font', 'hh:substFont', 'hh:typeInfo',
  'hh:borderFills', 'hh:borderFill', 'hh:slash', 'hh:backSlash', 'hh:leftBorder', 'hh:rightBorder', 'hh:topBorder', 'hh:bottomBorder', 'hh:diagonal',
  'hc:fillBrush', 'hc:winBrush', 'hc:gradation', 'hc:color', 'hc:imgBrush', 'hc:img',
  'hh:charProperties', 'hh:charPr', 'hh:fontRef', 'hh:ratio', 'hh:spacing', 'hh:relSz', 'hh:offset', 'hh:italic', 'hh:bold', 'hh:underline',
  'hh:strikeout', 'hh:outline', 'hh:shadow', 'hh:emboss', 'hh:engrave', 'hh:supscript', 'hh:subscript',
  'hh:tabProperties', 'hh:tabPr', 'hh:tabItem', 'hh:numberings', 'hh:numbering', 'hh:bullets', 'hh:bullet', 'hh:paraHead',
  'hh:paraProperties', 'hh:paraPr', 'hh:align', 'hh:heading', 'hh:breakSetting', 'hh:autoSpacing', 'hh:margin', 'hc:intent', 'hc:left', 'hc:right',
  'hc:prev', 'hc:next', 'hh:lineSpacing', 'hh:border', 'hp:switch', 'hp:case', 'hp:default',
  'hh:styles', 'hh:style', 'hh:memoProperties', 'hh:memoPr',
])
const SECPR_NAMES = new Set(['hp:grid', 'hp:startNum', 'hp:visibility', 'hp:lineNumberShape', 'hp:pagePr', 'hp:margin', 'hp:footNotePr', 'hp:endNotePr',
  'hp:autoNumFormat', 'hp:noteLine', 'hp:noteSpacing', 'hp:numbering', 'hp:placement', 'hp:pageBorderFill', 'hp:offset'])
const COLPR_NAMES = new Set(['hp:colLine', 'hp:colSz'])

/** What of a template's header goes into the new file: the reference lists of shapes and styles, numbering start,
 * compatibility and options, without the path of a linked document or the names in tracked changes. */
const HEAD_KEEP = new Set(['hh:beginNum', 'hh:refList', 'hh:compatibleDocument', 'hh:docOption', 'hh:trackchageConfig'])
const REFLIST_KEEP = new Set(['hh:fontfaces', 'hh:borderFills', 'hh:charProperties', 'hh:tabProperties', 'hh:numberings', 'hh:bullets', 'hh:paraProperties', 'hh:styles', 'hh:memoProperties'])
/** what of the first section's page setup does: paper, margins, grid, numbering start, note and border settings */
const OWPML_PREFIX = new RegExp(`^(${OWPML_NS.map(([p]) => p).join('|')}):`)
const SECPR_KEEP = new Set(['hp:grid', 'hp:startNum', 'hp:visibility', 'hp:lineNumberShape', 'hp:pagePr', 'hp:footNotePr', 'hp:endNotePr', 'hp:pageBorderFill'])

// ---------------------------------------------------------------- the template
interface Style { id: number; type: string; name: string; engName: string; paraPr: number; charPr: number }
interface Template {
  /** header.xml as it goes into the new file (canonical, the kept parts only), before the writer's items are added */
  header: string
  secPr: string
  colPr: string
  /** width of the text area in HWPUNIT */
  textWidth: number
}

/** compound-file (OLE) bytes: an embedded object, or a .hwp inside the package */
export const isCompoundFile = (b: Uint8Array) => b.length >= 8 && Buffer.from(b.subarray(0, 8)).toString('hex') === 'd0cf11e0a1b11ae1'

/**
 * The checks every .hwpx from outside gets, a template here or a document changed in place (files/hwpx-edit.ts): a
 * Hangul package (the application/hwp+zip mimetype), no scripts (Scripts/), no OLE objects (BinData/*.ole, compound
 * files in BinData, hp:ole anywhere in the XML; an equation's hp:script is its formula, not a program), no encryption
 * or distribution-only manifest. `text` reads a part as UTF-8, null when it is missing.
 */
export function assertPlainPackage(parts: Map<string, Uint8Array>, text: (n: string) => string | null, bad: (why: string) => never) {
  const names = [...parts.keys()]
  if (names.some((n) => /(^|\/)scripts(\/|$)/i.test(n))) bad('it contains scripts (Scripts/)')
  for (const [n, b] of parts) if (/^BinData\//i.test(n) && (/\.ole$/i.test(n) || isCompoundFile(b))) bad('it contains an embedded OLE object')
  const mimetype = text('mimetype')
  if (mimetype === null || mimetype.trim() !== 'application/hwp+zip') bad('it is not a Hangul document (no application/hwp+zip mimetype)')
  if (/encryption|<(?:\w+:)?encrypt/i.test(text('META-INF/manifest.xml') ?? '')) bad('it is encrypted or a distribution-only document')
  for (const n of names) {
    if (/\.(xml|hpf|rdf)$/i.test(n) && /<(?:\w+:)?ole\b/i.test(text(n)!)) bad(`${n} contains an embedded OLE object`)
  }
}

/** The parts of a template make_file uses, after the checks above. */
export function readTemplate(bytes: Uint8Array): Template {
  const bad = (why: string): never => { throw new ToolError(`${TEMPLATE_BAD}: ${why}. Use a .hwpx saved by Hangul, or no template.`) }
  if (bytes.length > HWPX_LIMITS.templateBytes) bad(`it is larger than ${HWPX_LIMITS.templateBytes / MIB} MB`)
  if (!isZip(bytes)) bad(bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).toString('hex') === 'd0cf11e0a1b11ae1' ? 'it is a .hwp file; save it as .hwpx in Hangul' : 'it is not a .hwpx file')
  try { checkZip(bytes, { total: HWPX_LIMITS.templateExpanded, entries: HWPX_LIMITS.templateEntries }) } catch (e) {
    bad(/encrypted/.test(String((e as Error).message)) ? 'it is encrypted' : `it is damaged or too large (${String((e as Error).message).replace(/^.*?\(/, '').replace(/\).*$/, '').slice(0, 120)})`)
  }
  let c: { FullPaths: string[]; FileIndex: { content?: Uint8Array | number[] }[] }
  try { c = XLSX.CFB.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { type: 'buffer' }) } catch { return bad('it is damaged') }
  const parts = new Map<string, Uint8Array>()
  c.FullPaths.forEach((p, i) => {
    const content = c.FileIndex[i]?.content
    parts.set(p.replace(/^Root Entry\//, ''), content instanceof Uint8Array ? content : Uint8Array.from(content ?? []))
  })
  const text = (n: string) => {
    const b = parts.get(n)
    if (!b) return null
    if (b.length > HWPX_LIMITS.headerBytes) bad(`${n} is larger than ${HWPX_LIMITS.headerBytes / MIB} MB`)
    try { return new TextDecoder('utf-8', { fatal: true }).decode(b) } catch { return bad(`${n} is not UTF-8`) }
  }
  assertPlainPackage(parts, text, bad)
  const headerXml = text('Contents/header.xml') ?? bad('it has no Contents/header.xml')
  const sectionXml = text('Contents/section0.xml') ?? bad('it has no Contents/section0.xml')
  // Both parts are read into trees and only what is used is written again, in one canonical form (serialize), so the
  // header edits below never meet XML they could read differently from the parser.
  const head = parseXml(headerXml, 'Contents/header.xml', { noSelfNesting: true }).get('hh:head') ?? bad('Contents/header.xml is not a Hangul header')
  // of the section, only the page setup and the columns become trees (its text is checked, then dropped)
  const section = parseXml(sectionXml, 'Contents/section0.xml', { only: ['hp:secPr', 'hp:colPr'] })
  keepKids(head, HEAD_KEEP)
  const refList = head.kids.find((k): k is XNode => typeof k !== 'string' && k.name === 'hh:refList')
  if (refList) keepKids(refList, REFLIST_KEEP)
  const docOption = head.kids.find((k): k is XNode => typeof k !== 'string' && k.name === 'hh:docOption')
  if (docOption) {
    keepKids(docOption, new Set(['hh:linkinfo']))
    for (const l of docOption.kids) if (typeof l !== 'string') setAttr(l, 'path', '')
  }
  assertKnown(head, 'Contents/header.xml', HEAD_NAMES, new Set(['hh:paraHead']))

  // the page setup of the first section, from the settings it may hold (no master pages: their files stay behind)
  const secPr = section.get('hp:secPr') ?? bad('it has no page setup (hp:secPr)')
  keepKids(secPr, SECPR_KEEP)
  setAttr(secPr, 'masterPageCnt', '0')
  assertKnown(secPr, 'the page setup', SECPR_NAMES)
  const col = section.get('hp:colPr')
  if (col) assertKnown(col, 'the column setup', COLPR_NAMES)
  // moved under the new section's root, which declares Hangul's namespaces only
  for (const [n, part] of [[secPr, 'the page setup'], [col, 'the column setup']] as const) {
    const stack = n ? [n] : []
    while (stack.length) {
      const e = stack.pop()!
      e.attrs = e.attrs.filter(([k]) => !/^xmlns(:|$)/.test(k))
      if (e.attrs.some(([k]) => k.includes(':') && !OWPML_PREFIX.test(k))) bad(`${part} uses names outside Hangul's namespaces`)
      for (const k of e.kids) if (typeof k !== 'string') stack.push(k)
    }
  }
  const pagePr = find(secPr, 'hp:pagePr')
  const margin = pagePr ? find(pagePr, 'hp:margin') : undefined
  const num = (n: XNode | undefined, k: string, d: number) => { const v = Number(n ? attr(n, k) : undefined); return Number.isFinite(v) ? v : d }
  const pageWidth = pagePr && attr(pagePr, 'landscape') === 'NARROWLY' ? num(pagePr, 'height', 84186) : num(pagePr, 'width', 59528)
  const textWidth = Math.max(2000, Math.min(300_000, pageWidth - num(margin, 'left', 8504) - num(margin, 'right', 8504) - num(margin, 'gutter', 0)))
  return { header: XML_DECL + serialize(head), secPr: serialize(secPr), colPr: col ? `<hp:ctrl>${serialize(col)}</hp:ctrl>` : COL_PR, textWidth }
}

// ---------------------------------------------------------------- the header: the template's items and ours
const CONTAINERS = ['fontfaces', 'borderFills', 'charProperties', 'tabProperties', 'numberings', 'bullets', 'paraProperties', 'styles'] as const
type Container = (typeof CONTAINERS)[number]
/** the item of each container and the id of its first item (Hangul counts some from 0, others from 1) */
const ITEMS: Partial<Record<Container, [string, number]>> = {
  borderFills: ['borderFill', 1], charProperties: ['charPr', 0], tabProperties: ['tabPr', 0], numberings: ['numbering', 1],
  bullets: ['bullet', 1], paraProperties: ['paraPr', 0], styles: ['style', 0],
}

class Header {
  private items = new Map<Container, El[]>()
  private boxes = new Map<Container, El | null>()
  private added = new Map<Container, string[]>()
  private charCache = new Map<string, number>()
  private paraCache = new Map<string, number>()
  private bulletCache = new Map<string, number>()
  private baseCache = new Map<number, Required<Pick<ParaShape, 'align' | 'lineSpacing' | 'tabPr' | 'borderFill'>>>()
  readonly styles: Style[]
  readonly body: Style
  readonly outline: (Style | undefined)[] = []
  private tableBorder: [number, number] | null = null

  constructor(private xml: string) {
    const refList = elements(xml, 'hh:refList')[0] ?? this.bad('no hh:refList')
    for (const c of CONTAINERS) {
      const boxes = elements(xml, `hh:${c}`, refList.start, refList.end)
      if (boxes.length > 1) this.bad(`hh:${c} twice`)
      const box = boxes[0] ?? null
      this.boxes.set(c, box)
      const item = ITEMS[c]
      if (!item) continue
      const list = box && !box.self ? elements(xml, `hh:${item[0]}`, box.start, box.end) : []
      list.forEach((e, i) => { if (e.attrs.get('id') !== String(item[1] + i)) this.bad(`hh:${item[0]} ids are not ${item[1]}, ${item[1] + 1}, ... in order`) })
      this.items.set(c, list)
    }
    for (const c of ['borderFills', 'charProperties', 'paraProperties', 'styles'] as const) if (!this.items.get(c)!.length) this.bad(`no hh:${c}`)
    this.styles = this.items.get('styles')!.map((e) => ({
      id: Number(e.attrs.get('id')), type: e.attrs.get('type') ?? '', name: e.attrs.get('name') ?? '', engName: e.attrs.get('engName') ?? '',
      paraPr: Number(e.attrs.get('paraPrIDRef')), charPr: Number(e.attrs.get('charPrIDRef')),
    }))
    const paraCount = this.items.get('paraProperties')!.length, charCount = this.items.get('charProperties')!.length
    for (const s of this.styles) if (!(s.paraPr >= 0 && s.paraPr < paraCount && s.charPr >= 0 && s.charPr < charCount)) this.bad(`style "${s.name.slice(0, 40)}" refers to a shape that is not there`)
    this.body = this.styles.find((s) => s.id === 0 && s.type === 'PARA') ?? this.styles.find((s) => s.type === 'PARA') ?? this.bad('no paragraph style')
    // the style of each outline level: 개요 N (or Outline N) whose paragraph shape is that level, else any such style
    // (each shape looked at once: the first hh:heading in it, as hwp.ts reads it)
    const levels = new Map<number, number>()
    const level = (s: Style) => {
      let l = levels.get(s.paraPr)
      if (l === undefined) {
        const h = elements(this.items.get('paraProperties')![s.paraPr]!.xml, 'hh:heading')[0]
        l = h && h.attrs.get('type') === 'OUTLINE' ? Number(h.attrs.get('level')) : -1
        levels.set(s.paraPr, l)
      }
      return l
    }
    const paraStyles = this.styles.filter((s) => s.type === 'PARA').map((s) => ({ s, l: level(s) }))
    for (let l = 0; l < 6; l++) {
      const all = paraStyles.filter((x) => x.l === l).map((x) => x.s)
      this.outline[l] = all.find((s) => s.name === `개요 ${l + 1}` || s.engName === `Outline ${l + 1}`) ?? all[0]
    }
  }

  private bad(why: string): never { throw new ToolError(`${TEMPLATE_BAD} (Contents/header.xml: ${why}). Use a .hwpx saved by Hangul, or no template.`) }

  private add(c: Container, make: (id: number) => string): number {
    const item = ITEMS[c]!
    const list = (this.added.get(c) ?? [])
    const id = item[1] + this.items.get(c)!.length + list.length
    list.push(make(id))
    this.added.set(c, list)
    return id
  }

  /** a paragraph shape of the template, for the values ours take from it */
  private paraPr(id: number): El { return this.items.get('paraProperties')![id]! }

  /** `base` with bold and / or italic (the template's own shape when it already is) */
  charPr(base: number, bold: boolean, italic: boolean): number {
    const key = `${base}:${bold}:${italic}`
    const hit = this.charCache.get(key)
    if (hit !== undefined) return hit
    const el = this.items.get('charProperties')![base]!
    const has = (n: string) => elements(el.xml, `hh:${n}`).length > 0
    const needItalic = italic && !has('italic'), needBold = bold && !has('bold')
    let id = base
    if (needItalic || needBold) {
      id = this.add('charProperties', (newId) => {
        const open = withAttr(el.self ? el.open.replace(/\s*\/>$/, '>') : el.open, 'id', String(newId))
        let inner = el.self ? '' : el.xml.slice(el.open.length, el.xml.length - '</hh:charPr>'.length)
        // Hangul's order: fontRef, ratio, spacing, relSz, offset, italic, bold, underline, ...
        const put = (mark: string, after: string[]) => {
          const at = after.map((n) => elements(inner, `hh:${n}`)[0]).find((e) => e)
          const i = at ? at.end : 0
          inner = inner.slice(0, i) + mark + inner.slice(i)
        }
        if (needItalic) put('<hh:italic/>', ['offset', 'relSz', 'spacing', 'ratio', 'fontRef'])
        if (needBold) put('<hh:bold/>', ['italic', 'offset', 'relSz', 'spacing', 'ratio', 'fontRef'])
        return open + inner + '</hh:charPr>'
      })
    }
    this.charCache.set(key, id)
    return id
  }

  /** a paragraph shape of ours, from the body shape's alignment, line spacing, tabs and border */
  para(s: ParaShape & { from?: number }): number {
    const from = s.from ?? this.body.paraPr
    let base = this.baseCache.get(from)
    if (!base) {
      // read once per shape: a template's shape can be large and there can be thousands of list items and cells
      const el = this.paraPr(from)
      const ls = elements(el.xml, 'hh:lineSpacing')[0]
      const type = ls?.attrs.get('type'), value = Number(ls?.attrs.get('value'))
      const align = elements(el.xml, 'hh:align')[0]?.attrs.get('horizontal')
      base = {
        align: align === 'LEFT' || align === 'RIGHT' || align === 'CENTER' ? align : 'JUSTIFY',
        lineSpacing: type === 'PERCENT' && value > 0 && value <= 500 ? { type, value } : { type: 'PERCENT', value: 160 },
        tabPr: Number(el.attrs.get('tabPrIDRef')) || 0,
        borderFill: Number(elements(el.xml, 'hh:border')[0]?.attrs.get('borderFillIDRef')) || 1,
      }
      this.baseCache.set(from, base)
    }
    const shape: ParaShape = {
      align: s.align ?? base.align, lineSpacing: s.lineSpacing ?? base.lineSpacing, tabPr: base.tabPr, borderFill: base.borderFill,
      heading: s.heading, left: s.left, indent: s.indent, prev: s.prev, next: s.next, keepWithNext: s.keepWithNext,
    }
    const key = JSON.stringify(shape)
    const hit = this.paraCache.get(key)
    if (hit !== undefined) return hit
    const id = this.add('paraProperties', (n) => paraPrXml(n, shape))
    this.paraCache.set(key, id)
    return id
  }

  bullet(char: string): number {
    const hit = this.bulletCache.get(char)
    if (hit !== undefined) return hit
    const id = this.add('bullets', (n) => `<hh:bullet id="${n}" char="${char}" useImage="0"><hh:paraHead level="0" align="LEFT" useInstWidth="0" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="${NO_CHAR_SHAPE}" checkable="0"/></hh:bullet>`)
    this.bulletCache.set(char, id)
    return id
  }

  numbering(n: Numbering): number {
    return this.add('numberings', (id) => `<hh:numbering id="${id}" start="${n.start}">${paraHeadXml(1, n.format, n.label, n.start)}` +
      Array.from({ length: 9 }, (_, i) => paraHeadXml(i + 2, 'DIGIT', '')).join('') + '</hh:numbering>')
  }

  /** [body cell, header cell] border fills: thin solid lines, the header row shaded */
  tableBorders(): [number, number] {
    if (this.tableBorder) return this.tableBorder
    const fill = (shade: string | null) => (id: number) => `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">` +
      '<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>' +
      ['left', 'right', 'top', 'bottom'].map((s) => `<hh:${s}Border type="SOLID" width="0.12 mm" color="#000000"/>`).join('') +
      '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>' +
      (shade ? `<hc:fillBrush><hc:winBrush faceColor="${shade}" hatchColor="#999999" alpha="0"/></hc:fillBrush>` : '') + '</hh:borderFill>'
    this.tableBorder = [this.add('borderFills', fill(null)), this.add('borderFills', fill('#E8E8E8'))]
    return this.tableBorder
  }

  /** header.xml with our items after the template's, each container's itemCnt counted again, one section */
  toXml(): string {
    // applied from the end of the text: a replacement before an insertion at the same place, and of two insertions
    // at one place the later container first (so it ends up after the earlier one)
    const edits: { at: number; end: number; text: string; seq: number }[] = []
    const push = (e: { at: number; end: number; text: string }) => edits.push({ ...e, seq: edits.length })
    for (const c of CONTAINERS) {
      const add = this.added.get(c)
      if (!add?.length) continue
      const box = this.boxes.get(c)
      const count = this.items.get(c)!.length + add.length
      if (box && !box.self) {
        push({ at: box.start, end: box.start + box.open.length, text: withAttr(box.open, 'itemCnt', String(count)) })
        const close = box.end - `</hh:${c}>`.length
        push({ at: close, end: close, text: add.join('') })
      } else {
        const whole = `<hh:${c} itemCnt="${count}">${add.join('')}</hh:${c}>`
        if (box) push({ at: box.start, end: box.end, text: whole })
        else {
          // a container the template does not have goes before the next one Hangul writes after it
          const later = CONTAINERS.slice(CONTAINERS.indexOf(c) + 1).map((n) => this.boxes.get(n)).find((b) => b)
          if (!later) this.bad(`no place for hh:${c}`)
          push({ at: later!.start, end: later!.start, text: whole })
        }
      }
    }
    const head = elements(this.xml, 'hh:head')[0]!
    let open = withAttr(head.open, 'secCnt', '1')
    for (const p of ['hh', 'hc', 'hp'] as const) if (!head.attrs.has(`xmlns:${p}`)) open = open.replace(/^<hh:head/, `<hh:head xmlns:${p}="${NS[p]}"`)
    push({ at: head.start, end: head.start + head.open.length, text: open })
    edits.sort((a, b) => b.at - a.at || b.end - a.end || b.seq - a.seq)
    let out = this.xml
    for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.end)
    return out
  }
}

// ---------------------------------------------------------------- the section
const BULLETS = ['●', '○', '■', '□', '◆', '◇']
/** list indent per level, and the extra indent of an item's later paragraphs (HWPUNIT, as Hangul shows them) */
const LIST_INDENT = 2000, CONTINUED = 1600
/** a cell's minimum height, as Hangul makes a new table (each row grows to its text), and the margins it uses */
const CELL_HEIGHT = 282
const CELL_MARGIN = '<hp:cellMargin left="510" right="510" top="141" bottom="141"/>'

function sectionXml(t: Template, h: Header, blocks: Block[], numberingIds: number[]): string {
  const body = h.body
  let first = true
  let tables = 0
  const runsXml = (runs: Run[], baseChar: number) => {
    if (!runs.length) return `<hp:run charPrIDRef="${baseChar}"><hp:t/></hp:run>`
    return runs.map((r) => `<hp:run charPrIDRef="${h.charPr(baseChar, r.bold, r.italic)}"><hp:t>${r.text.split('\n').map(escText).join('<hp:lineBreak/>')}</hp:t></hp:run>`).join('')
  }
  const p = (paraPr: number, style: number, pageBreak: boolean, inner: string) => {
    const sec = first ? `<hp:run charPrIDRef="${body.charPr}">${t.secPr}${t.colPr}</hp:run>` : ''
    first = false
    return `<hp:p id="0" paraPrIDRef="${paraPr}" styleIDRef="${style}" pageBreak="${pageBreak ? 1 : 0}" columnBreak="0" merged="0">${sec}${inner}</hp:p>`
  }
  const out: string[] = []
  for (const b of blocks) {
    if (b.k === 'p') {
      if (b.heading) {
        const s = h.outline[b.heading - 1]
        const paraPr = s ? s.paraPr : h.para({ heading: { type: 'OUTLINE', idRef: 0, level: b.heading - 1 }, align: 'LEFT', keepWithNext: true, prev: 800, next: 300 })
        const charPr = s ? s.charPr : h.charPr(body.charPr, true, false)
        out.push(p(paraPr, s ? s.id : body.id, b.pageBreak, runsXml(b.runs, charPr)))
      } else if (b.list) {
        const l = b.list
        const heading = l.continued ? undefined : l.kind === 'bullet'
          ? { type: 'BULLET' as const, idRef: h.bullet(BULLETS[l.depth % BULLETS.length]!), level: 0 }
          : { type: 'NUMBER' as const, idRef: numberingIds[l.numbering! - 1]!, level: 0 }
        const paraPr = h.para({ heading, left: l.depth * LIST_INDENT + (l.continued ? CONTINUED : 0), next: 200 })
        out.push(p(paraPr, body.id, b.pageBreak, runsXml(b.runs, body.charPr)))
      } else out.push(p(body.paraPr, body.id, b.pageBreak, runsXml(b.runs, body.charPr)))
      continue
    }
    // a table, as character in its own paragraph (as Hangul makes one): the columns share the text width
    const [border, headBorder] = h.tableBorders()
    const cols = b.widths.length
    const total = Math.max(cols * 600, t.textWidth - 568)
    const sum = b.widths.reduce((a, w) => a + w, 0)
    const widths = b.widths.map((w) => Math.max(600, Math.floor((total * w) / sum)))
    widths[cols - 1] = Math.max(600, total - widths.slice(0, -1).reduce((a, w) => a + w, 0))
    const width = widths.reduce((a, w) => a + w, 0)
    const rows = b.rows.map((row, r) => '<hp:tr>' + row.cells.map((cell, ci) => {
      const paraPr = h.para({ align: cell.align, next: 0, lineSpacing: undefined })
      const paras = (cell.paras.length ? cell.paras : [[]]).map((runs) => `<hp:p id="0" paraPrIDRef="${paraPr}" styleIDRef="${body.id}" pageBreak="0" columnBreak="0" merged="0">${runsXml(runs, body.charPr)}</hp:p>`).join('')
      return `<hp:tc name="" header="${row.head ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${row.head ? headBorder : border}">` +
        `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${paras}</hp:subList>` +
        `<hp:cellAddr colAddr="${ci}" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${widths[ci]}" height="${CELL_HEIGHT}"/>${CELL_MARGIN}</hp:tc>`
    }).join('') + '</hp:tr>').join('')
    const id = 1_000_000_000 + ++tables
    const tbl = `<hp:tbl id="${id}" zOrder="${tables - 1}" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${b.rows.length}" colCnt="${cols}" cellSpacing="0" borderFillIDRef="${border}" noAdjust="0">` +
      `<hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${b.rows.length * CELL_HEIGHT}" heightRelTo="ABSOLUTE" protect="0"/>` +
      '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
      '<hp:outMargin left="283" right="283" top="283" bottom="283"/><hp:inMargin left="510" right="510" top="141" bottom="141"/>' + rows + '</hp:tbl>'
    out.push(p(body.paraPr, body.id, b.pageBreak, `<hp:run charPrIDRef="${body.charPr}">${tbl}<hp:t/></hp:run>`))
  }
  return XML_DECL + `<hs:sec ${NS_ATTRS}>${out.join('')}</hs:sec>`
}

// ---------------------------------------------------------------- the package
function plainText(blocks: Block[], max: number): string {
  const lines: string[] = []
  let n = 0
  for (const b of blocks) {
    const texts = b.k === 'p' ? [b.runs.map((r) => r.text).join('')] : b.rows.flatMap((r) => r.cells.flatMap((c) => c.paras.map((p) => p.map((x) => x.text).join(''))))
    for (const s of texts) { lines.push(s.replace(/\n/g, ' ')); n += s.length + 2; if (n > max) return lines.join('\r\n').slice(0, max) }
  }
  return lines.join('\r\n')
}

function packageFiles(title: string, preview: string, header: string, section: string): ZipEntry[] {
  const enc = (s: string) => new TextEncoder().encode(s)
  const meta = ['creator', 'subject', 'description', 'lastsaveby', 'CreatedDate', 'ModifiedDate', 'date', 'keyword'].map((n) => `<opf:meta name="${n}" content="text"/>`).join('')
  const hpf = XML_DECL + `<opf:package ${NS_ATTRS} version="" unique-identifier="" id=""><opf:metadata><opf:title>${escText(title)}</opf:title><opf:language>ko</opf:language>${meta}</opf:metadata>` +
    '<opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>' +
    '<opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest>' +
    '<opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>'
  const rdf = XML_DECL + '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/header.xml"/></rdf:Description>' +
    '<rdf:Description rdf:about="Contents/header.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#HeaderFile"/></rdf:Description>' +
    '<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/section0.xml"/></rdf:Description>' +
    '<rdf:Description rdf:about="Contents/section0.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#SectionFile"/></rdf:Description>' +
    '<rdf:Description rdf:about=""><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#Document"/></rdf:Description></rdf:RDF>'
  const version = XML_DECL + `<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="1.5" application="${escAttr(PRODUCT.displayName)}" appVersion=""/>`
  const settings = XML_DECL + '<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>'
  const container = XML_DECL + '<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles>' +
    '<ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/><ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/>' +
    '<ocf:rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/></ocf:rootfiles></ocf:container>'
  const manifest = XML_DECL + '<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>'
  // the order Hangul writes them in; the mimetype first and stored, as OCF requires
  return [
    { name: 'mimetype', data: enc('application/hwp+zip'), store: true },
    { name: 'version.xml', data: enc(version) },
    { name: 'Contents/header.xml', data: enc(header) },
    { name: 'Contents/section0.xml', data: enc(section) },
    { name: 'Preview/PrvText.txt', data: enc(preview) },
    { name: 'settings.xml', data: enc(settings) },
    { name: 'META-INF/container.rdf', data: enc(rdf) },
    { name: 'Contents/content.hpf', data: enc(hpf) },
    { name: 'META-INF/container.xml', data: enc(container) },
    { name: 'META-INF/manifest.xml', data: enc(manifest) },
  ]
}

/** Every XML part of a written file parses (a writer bug would otherwise reach Hangul as a damaged file). */
function assertWellFormed(entries: ZipEntry[]) {
  for (const e of entries) {
    if (!/\.(xml|hpf|rdf)$/.test(e.name)) continue
    const parser = new SaxesParser({ xmlns: true })
    parser.on('error', (err) => { throw new ToolError(`the .hwpx writer made a damaged ${e.name} (${String(err.message).slice(0, 120)}); nothing was saved`) })
    parser.write(new TextDecoder().decode(e.data)).close()
  }
}

/** A .hwpx file of pandoc's JSON tree, styled by `template` (a .hwpx) or the built-in template. */
export function writeHwpx(ast: unknown, template?: Uint8Array | null): Uint8Array {
  const conv = new Converter()
  conv.document(ast)
  const refusal = conv.refusal()
  if (refusal) throw new ToolError(refusal)
  if (!conv.blocks.length) throw new ToolError('the document is empty; nothing was saved')
  const t = readTemplate(template ?? defaultTemplate())
  const h = new Header(t.header)
  const numberingIds = conv.numberings.map((n) => h.numbering(n))
  const section = sectionXml(t, h, conv.blocks, numberingIds)
  const firstHeading = conv.blocks.find((b): b is Para => b.k === 'p' && b.heading > 0)
  const title = (firstHeading?.runs.map((r) => r.text).join('') ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  const entries = packageFiles(title, plainText(conv.blocks, 1000), h.toXml(), section)
  assertWellFormed(entries)
  return writeZip(entries)
}

/** The office worker's `hwpx-write` mode: the framed request of hwpx-check.ts in, the file's bytes out. */
export function hwpxWriteRequest(input: Uint8Array): Uint8Array {
  let req: ReturnType<typeof decodeHwpxRequest>
  try { req = decodeHwpxRequest(input) } catch { throw new ToolError('the .hwpx writer got a damaged request') }
  let ast: unknown
  try { ast = JSON.parse(req.astJson) } catch { throw new ToolError('the converter produced an unexpected document tree') }
  return writeHwpx(ast, req.template)
}
