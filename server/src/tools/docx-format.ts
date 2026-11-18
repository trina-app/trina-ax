// Formatting of the Word files make_file writes (tools/make-file.ts) that pandoc's Markdown cannot say (second limits
// audit N3, QA TC-4915; docs/decisions/20261118-rich-office-output.md):
// - text colour and highlight: a Markdown span or block with `color` / `highlight` attributes ("[late]{color=red}",
//   "[risk]{highlight=yellow}", "::: {color=#C00000}" ... ":::") or the class .mark (yellow highlight). In pandoc's
//   tree each one gets a custom-style named after its colours ("Color FF0000 Highlight yellow"); pandoc writes it as a
//   character (span) or paragraph (block) style, and after pandoc the style gets its colour in word/styles.xml. Bold,
//   italic and links inside keep their own formatting; Word lists the style by that name.
// - page: size, orientation and margins (the last section's w:pgSz / w:pgMar), and a header and footer of their own
//   (word/header-mk1.xml, word/footer-mk1.xml with relationships and content types), where {page} and {pages} become
//   PAGE and NUMPAGES fields. A template's own header or footer stays unless one is given here.
// Every other part of the file is copied as pandoc wrote it (files/zip-write.ts).
import type { z } from 'zod'
import type { MakeFilePage, MakeFileHeaderFooter } from '@mycel/shared'
import { readZip, writeZip, type ZipEntry } from '../files/zip-write'
import { ToolError } from '../policy/errors'

export type PageOptions = z.output<typeof MakeFilePage>
type HeaderFooter = z.output<typeof MakeFileHeaderFooter>

/** Colour names the AI may use for text and cells, with their RGB. */
export const COLOR_NAMES: Record<string, string> = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', darkred: 'C00000', orange: 'FFA500', yellow: 'FFFF00', lightyellow: 'FFFF99', gold: 'FFC000',
  green: '00B050', darkgreen: '006100', lightgreen: 'C6EFCE', blue: '0070C0', darkblue: '002060', lightblue: 'BDD7EE',
  purple: '7030A0', pink: 'FFC7CE', gray: '808080', grey: '808080', lightgray: 'D9D9D9', lightgrey: 'D9D9D9', brown: '996633',
  cyan: '00FFFF', magenta: 'FF00FF', teal: '008080', navy: '1F3864',
}
/** "#C00000", "C00000", "#f00", "red", "dark red" -> "C00000" / "FF0000"; null when it is none of those */
export function colorHex(v: string): string | null {
  const s = v.trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (COLOR_NAMES[s]) return COLOR_NAMES[s]!
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(s)
  if (!m) return null
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!
  return h.toUpperCase()
}

const colorError = (what: string, v: string) =>
  new ToolError(`${what} "${v.slice(0, 40)}" is not a colour: give a name (${Object.keys(COLOR_NAMES).filter((n) => !n.includes('grey')).join(', ')}) or "#RRGGBB"; nothing was saved`)

/** A text colour and a highlight, as one style of the document. */
export interface TextMark { color?: string; highlight?: string }
/** the style's name in Word (also how pandoc names its id, without the spaces) */
const markName = (m: TextMark) => [m.color && `Color ${m.color}`, m.highlight && `Highlight ${m.highlight}`].filter(Boolean).join(' ')

type Attr = [string, string[], [string, string][]]
/** different colour and highlight pairs in one document at most (each is a Word style) */
export const MAX_TEXT_COLORS = 64

/**
 * In pandoc's tree of a document for Word: every Span and Div with `color` / `highlight` (or the class "mark") gets a
 * custom-style of its colours instead. Returns the styles used (name -> colours); nothing when none. A colour that is
 * not one throws (nothing is saved).
 */
export function markTextColors(ast: unknown): Map<string, TextMark> {
  const used = new Map<string, TextMark>()
  const stack: unknown[] = [ast]
  while (stack.length) {
    const v = stack.pop()
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object') stack.push(x); continue }
    if (!v || typeof v !== 'object') continue
    const node = v as { t?: unknown; c?: unknown }
    if ((node.t === 'Span' || node.t === 'Div') && Array.isArray(node.c) && Array.isArray(node.c[0])) {
      const attr = node.c[0] as Attr
      const kv = Array.isArray(attr[2]) ? attr[2] : []
      const classes = Array.isArray(attr[1]) ? attr[1] : []
      const get = (k: string) => kv.find((p) => Array.isArray(p) && typeof p[0] === 'string' && p[0].toLowerCase() === k)?.[1]
      const color = get('color') ?? get('colour')
      let highlight = get('highlight') ?? get('background')
      if (highlight === undefined && classes.includes('mark')) highlight = 'yellow'
      if (typeof color === 'string' || typeof highlight === 'string') {
        const m: TextMark = {}
        if (typeof color === 'string') { const h = colorHex(color); if (!h) throw colorError('color', color); m.color = h }
        if (typeof highlight === 'string') { const h = colorHex(highlight); if (!h) throw colorError('highlight', highlight); m.highlight = h }
        // a block's style is a paragraph style: a name of its own, or Word would get two styles with one id
        const name = (node.t === 'Div' ? 'Paragraph ' : '') + markName(m)
        used.set(name, m)
        if (used.size > MAX_TEXT_COLORS) throw new ToolError(`the document uses more than ${MAX_TEXT_COLORS} different text colours and highlights; use fewer; nothing was saved`)
        attr[1] = classes.filter((c) => c !== 'mark')
        attr[2] = [...kv.filter((p) => !['color', 'colour', 'highlight', 'background', 'custom-style'].includes(String(p[0]).toLowerCase())), ['custom-style', name]]
      }
    }
    for (const x of Object.values(node)) if (x && typeof x === 'object') stack.push(x)
  }
  return used
}

const escXml = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!)
  // eslint-disable-next-line no-control-regex
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')

/** w:rPr children of a mark, in the schema's order (color before highlight and shd) */
function markRpr(m: TextMark): string {
  const parts: string[] = []
  if (m.color) parts.push(`<w:color w:val="${m.color}"/>`)
  // shading, not w:highlight: LibreOffice ignores w:highlight in a style (checked with 26.8), Word shows both; any colour
  if (m.highlight) parts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${m.highlight}"/>`)
  return parts.join('')
}

/** styles.xml with each mark's colours on the style pandoc made for it. A style of that name that already has run
 * properties (a template's own) is left as it is. One pass over the styles, each looked up by its name. */
export function colorStyles(stylesXml: string, marks: Map<string, TextMark>): string {
  if (!marks.size) return stylesXml
  return stylesXml.replace(/<w:style\b[^>]*>[\s\S]*?<\/w:style>/g, (block) => {
    const name = /<w:name w:val="([^"]*)"/.exec(block)?.[1]
    const m = name === undefined ? undefined : marks.get(name)
    if (!m || /<w:rPr\b/.test(block)) return block
    return `${block.slice(0, -'</w:style>'.length)}<w:rPr>${markRpr(m)}</w:rPr></w:style>`
  })
}

/** page sizes in twentieths of a point (w × h, portrait) */
const PAPER: Record<NonNullable<PageOptions['size']>, [number, number]> = { a4: [11906, 16838], letter: [12240, 15840], a3: [16838, 23811], legal: [12240, 20160] }
const twips = (cm: number) => Math.round((cm / 2.54) * 1440)

/** The page's geometry in twips: size, margins, and the text width between the margins. */
export function pageGeometry(p: PageOptions) {
  let [w, h] = PAPER[p.size ?? 'a4']
  if (p.orientation === 'landscape') [w, h] = [h, w]
  const m = typeof p.margins_cm === 'number' ? { top: p.margins_cm, bottom: p.margins_cm, left: p.margins_cm, right: p.margins_cm } : (p.margins_cm ?? {})
  const mg = { top: twips(m.top ?? 2.54), bottom: twips(m.bottom ?? 2.54), left: twips(m.left ?? 2.54), right: twips(m.right ?? 2.54) }
  const text = w - mg.left - mg.right
  if (text < 1440 || h - mg.top - mg.bottom < 1440) throw new ToolError('the margins leave less than 2.54 cm for the text; nothing was saved')
  return { w, h, landscape: p.orientation === 'landscape', ...mg, text }
}

/** text with {page} / {pages} as Word runs (9 pt), the two as PAGE / NUMPAGES fields */
function runs(text: string): string {
  const out: string[] = []
  const rpr = '<w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>'
  for (const part of text.split(/(\{pages\}|\{page\})/)) {
    if (!part) continue
    if (part === '{page}' || part === '{pages}') out.push(`<w:fldSimple w:instr=" ${part === '{page}' ? 'PAGE' : 'NUMPAGES'} "><w:r>${rpr}<w:t>1</w:t></w:r></w:fldSimple>`)
    else out.push(`<w:r>${rpr}<w:t xml:space="preserve">${escXml(part)}</w:t></w:r>`)
  }
  return out.join('')
}

/** One paragraph: centred text, or left / centre / right parts on tab stops at the middle and the right margin. */
export function headerFooterParagraph(hf: HeaderFooter, textWidth: number): string {
  if (typeof hf === 'string') return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${runs(hf)}</w:p>`
  const tab = '<w:r><w:tab/></w:r>'
  return `<w:p><w:pPr><w:tabs><w:tab w:val="center" w:pos="${Math.round(textWidth / 2)}"/><w:tab w:val="right" w:pos="${textWidth}"/></w:tabs></w:pPr>` +
    `${runs(hf.left ?? '')}${hf.center || hf.right ? tab + runs(hf.center ?? '') : ''}${hf.right ? tab + runs(hf.right) : ''}</w:p>`
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** the footer with the page number added (centred), unless it has {page} already */
export function footerWithPageNumber(f: HeaderFooter | undefined): HeaderFooter {
  if (f === undefined || f === '') return '{page}'
  if (typeof f === 'string') return f.includes('{page}') ? f : { left: f, right: '{page}' }
  if ([f.left, f.center, f.right].some((x) => x?.includes('{page}'))) return f
  return f.center ? { ...f, right: [f.right, '{page}'].filter(Boolean).join('  ') } : { ...f, center: '{page}' }
}

/** The direct children of a w:sectPr's content, each as its own string. */
function children(xml: string): string[] {
  const out: string[] = []
  const re = /<w:([A-Za-z]+)\b[^>]*?\/>|<w:([A-Za-z]+)\b[^>]*>[\s\S]*?<\/w:\2>/g
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[0])
  return out
}
const nameOf = (el: string) => /^<w:([A-Za-z]+)/.exec(el)![1]!
/** CT_SectPr's order after the header and footer references */
const SECT_ORDER = ['footnotePr', 'endnotePr', 'type', 'pgSz', 'pgMar', 'paperSrc', 'pgBorders', 'lnNumType', 'pgNumType', 'cols', 'formProt', 'vAlign', 'noEndnote', 'titlePg', 'textDirection', 'bidi', 'rtlGutter', 'docGrid', 'printerSettings', 'sectPrChange']

/**
 * The finished .docx: mark colours on their styles, and the page options on the document's last section (with a
 * header and footer part of their own). Returns the bytes unchanged when there is nothing to do.
 */
export function finishDocx(bytes: Uint8Array, marks: Map<string, TextMark>, page: PageOptions | undefined): Uint8Array {
  if (!marks.size && !page) return bytes
  const entries: ZipEntry[] = readZip(bytes)
  const dec = new TextDecoder()
  const enc = new TextEncoder()
  const get = (name: string) => entries.find((e) => e.name === name)
  const text = (name: string) => { const e = get(name); return e ? dec.decode(e.data) : null }
  const put = (name: string, s: string) => {
    const e = get(name)
    // a changed part is compressed again: its bytes as pandoc compressed them no longer fit
    if (e) { e.data = enc.encode(s); delete e.raw; delete e.store } else entries.push({ name, data: enc.encode(s) })
  }
  if (marks.size) {
    const styles = text('word/styles.xml')
    if (styles === null) throw new ToolError('the converter wrote a Word file without styles; nothing was saved')
    put('word/styles.xml', colorStyles(styles, marks))
  }
  if (page) {
    const g = pageGeometry(page)
    let doc = text('word/document.xml')
    let rels = text('word/_rels/document.xml.rels')
    let types = text('[Content_Types].xml')
    if (doc === null || rels === null || types === null) throw new ToolError('the converter wrote an incomplete Word file; nothing was saved')
    const footer = page.page_numbers ? footerWithPageNumber(page.footer) : page.footer
    const refs: string[] = []
    const add = (kind: 'header' | 'footer', hf: HeaderFooter) => {
      let n = 1
      while (get(`word/${kind}-mk${n}.xml`)) n++
      const part = `${kind}-mk${n}.xml`
      let id = `rIdMk${kind === 'header' ? 'H' : 'F'}${n}`
      while (rels!.includes(`Id="${id}"`)) id += 'x'
      const root = kind === 'header' ? 'w:hdr' : 'w:ftr'
      put(`word/${part}`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${root} xmlns:w="${W_NS}" xmlns:r="${R_NS}">${headerFooterParagraph(hf, g.text)}</${root}>`)
      rels = rels!.replace('</Relationships>', `<Relationship Id="${id}" Type="${REL}/${kind}" Target="${part}"/></Relationships>`)
      types = types!.replace('</Types>', `<Override PartName="/word/${part}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml"/></Types>`)
      refs.push(`<w:${kind}Reference w:type="default" r:id="${id}"/>`)
    }
    if (page.header !== undefined && page.header !== '') add('header', page.header)
    if (footer !== undefined && footer !== '') add('footer', footer)
    // the body's own section is its last w:sectPr (one in a paragraph ends an earlier section)
    const at = doc.lastIndexOf('<w:sectPr')
    const end = at < 0 ? -1 : doc.indexOf('</w:sectPr>', at)
    const selfClosed = at >= 0 && /^<w:sectPr\b[^>]*\/>/.test(doc.slice(at))
    let open = '<w:sectPr>', inner = '', after: number, before: number
    if (at < 0) {
      before = after = doc.lastIndexOf('</w:body>')
      if (before < 0) throw new ToolError('the converter wrote an incomplete Word file; nothing was saved')
    } else if (selfClosed) {
      const m = /^<w:sectPr\b[^>]*?(?=\/>)/.exec(doc.slice(at))!
      open = m[0] + '>'
      before = at
      after = at + m[0].length + 2
    } else {
      open = /^<w:sectPr\b[^>]*>/.exec(doc.slice(at))![0]
      inner = doc.slice(at + open.length, end)
      before = at
      after = end + '</w:sectPr>'.length
    }
    let kids = children(inner).filter((k) => !['pgSz', 'pgMar'].includes(nameOf(k)))
    // a header or footer given here replaces the template's default one of that kind
    if (refs.some((r) => r.startsWith('<w:headerReference'))) kids = kids.filter((k) => !(nameOf(k) === 'headerReference' && /w:type="default"/.test(k)))
    if (refs.some((r) => r.startsWith('<w:footerReference'))) kids = kids.filter((k) => !(nameOf(k) === 'footerReference' && /w:type="default"/.test(k)))
    const keptRefs = kids.filter((k) => /^(header|footer)Reference$/.test(nameOf(k)))
    const rest = [...kids.filter((k) => !/^(header|footer)Reference$/.test(nameOf(k))),
      `<w:pgSz w:w="${g.w}" w:h="${g.h}"${g.landscape ? ' w:orient="landscape"' : ''}/>`,
      `<w:pgMar w:top="${g.top}" w:right="${g.right}" w:bottom="${g.bottom}" w:left="${g.left}" w:header="708" w:footer="708" w:gutter="0"/>`]
    const rank = (k: string) => { const i = SECT_ORDER.indexOf(nameOf(k)); return i < 0 ? SECT_ORDER.length : i }
    rest.sort((a, b) => rank(a) - rank(b))
    // header references before footer references (the schema allows them mixed; Word writes them so)
    const allRefs = [...refs, ...keptRefs].sort((a, b) => Number(a.startsWith('<w:footer')) - Number(b.startsWith('<w:footer')))
    doc = `${doc.slice(0, before)}${open}${allRefs.join('')}${rest.join('')}</w:sectPr>${doc.slice(after)}`
    // r:id needs the relationships namespace on the document element (pandoc declares it; a template may not)
    if (refs.length && !/<w:document\b[^>]*\sxmlns:r=/.test(doc)) doc = doc.replace(/<w:document\b/, `<w:document xmlns:r="${R_NS}"`)
    put('word/document.xml', doc)
    put('word/_rels/document.xml.rels', rels)
    put('[Content_Types].xml', types)
  }
  return writeZip(entries)
}
