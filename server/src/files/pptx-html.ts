// A PowerPoint deck drawn as an HTML page with one page per slide, for make_file's PDF of a .pptx (tools/make-file.ts
// fromPptx; the page is then printed by files/html-pdf.ts). Nothing on this server converts a deck the way PowerPoint
// does (no LibreOffice), so the server draws each slide itself from the deck's parts: the slide size, every shape at its
// place (its own, or its layout's or master's placeholder's), text with its size, weight, colour, alignment and
// bullets, plain and theme colours, shape fills and outlines, lines, pictures (cropped as in the deck), tables, the
// slide's background, and the layout's and master's own shapes (logos, bars). Not drawn: charts, SmartArt, video,
// gradients beyond their first colour, shadows and effects, WordArt, EMF/WMF/TIFF pictures; a chart, diagram or
// unsupported picture leaves a light grey box, and the counts go back to the AI, which tells the person.
// Hidden slides are left out, as PowerPoint's own PDF export does.
// The deck is untrusted, so this runs only in the office worker (files/office-worker.ts, mode `pptx-html`), never in
// the server process; the zip is checked first (ooxml.ts parts → zip-guard.ts), the XML is scanned linearly (ooxml.ts
// tags), the element tree and the pictures are capped. Text is escaped; the page has no scripts and loads nothing but
// its own pictures, which the server answers from the worker's output (never from the team folder or the network).
import { ToolError } from '../policy/errors'
import { attr, parts, rels, slideOrder, tags, unescapeXml, xmlOf, type Parts } from './ooxml'
import { tooComplex } from './zip-guard'

export const PPTX_HTML_MODE = 'pptx-html'
/** every slide, hidden ones too, so page N is slide N: for the AI to look at a deck (read with pages / as_images,
 * files/deck-pdf.ts) */
export const PPTX_SLIDES_MODE = 'pptx-slides'
/** slides in one PDF (html-pdf.ts prints at most 200 pages) */
export const PPTX_PDF_SLIDES_MAX = 200
/** pictures and their bytes handed to the print: inside HTML_PDF_LIMITS.maxAssets / maxAssetBytes, and, as base64 in
 * the worker's JSON answer (4/3 of the bytes), inside the office worker's 64 MB output with room for the page */
const MEDIA_MAX = 190
const MEDIA_BYTES_MAX = 40 * 1024 * 1024
const PICTURE_BYTES_MAX = 20 * 1024 * 1024
const NODES_MAX = 400_000
const DEPTH_MAX = 200
const EMU_PER_IN = 914400

export interface SlidesHtml {
  html: string
  /** picture name in the page (`m<n>.<ext>`) -> its bytes, base64 */
  media: Record<string, string>
  slides: number
  hidden: number
  /** with `withHidden`: the numbers of the slides that are hidden in the deck (drawn, as PowerPoint's editor shows them) */
  hiddenSlides?: number[]
  /** what was not drawn: charts, SmartArt diagrams, other embedded objects, pictures in a format a browser cannot show or over the limits */
  notDrawn: { charts: number; diagrams: number; objects: number; pictures: number }
}

// ---------------- a small element tree over the linear tag scan ----------------

interface El { name: string; head: string; kids: El[]; text: string }

function tree(xml: string, count: { n: number }): El {
  const root: El = { name: '#root', head: '', kids: [], text: '' }
  const stack: El[] = [root]
  let last = 0
  for (const t of tags(xml)) {
    const top = stack[stack.length - 1]!
    // only text runs keep their text
    if (t.start > last && (top.name === 'a:t')) top.text += xml.slice(last, t.start)
    last = t.end
    if (t.name.startsWith('?') || t.name.startsWith('!')) continue
    if (t.close) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i]!.name === t.name) { stack.length = i; break }
      continue
    }
    if (++count.n > NODES_MAX) throw tooComplex('too many elements in the slides')
    const el: El = { name: t.name, head: t.head, kids: [], text: '' }
    top.kids.push(el)
    if (!t.selfClose) {
      if (stack.length > DEPTH_MAX) throw tooComplex('elements nested too deep')
      stack.push(el)
    }
  }
  return root
}
const kid = (e: El | undefined, name: string): El | undefined => e?.kids.find((k) => k.name === name)
const kidsOf = (e: El | undefined, name: string): El[] => e?.kids.filter((k) => k.name === name) ?? []
const path = (e: El | undefined, ...names: string[]): El | undefined => names.reduce<El | undefined>((x, n) => kid(x, n), e)
const at = (e: El | undefined, name: string): string | undefined => (e ? attr(e.head, name) : undefined)
const yes = (v: string | undefined) => v === '1' || v === 'true'
const no = (v: string | undefined) => v === '0' || v === 'false'
const num = (v: string | undefined, d: number): number => { const n = v === undefined ? NaN : Number(v); return Number.isFinite(n) ? n : d }

// ---------------- colours ----------------

const SCHEME = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']
interface Theme { colors: Map<string, string>; major: string | null; minor: string | null }

function themeOf(xml: string | null, count: { n: number }): Theme {
  const colors = new Map<string, string>()
  if (!xml) return { colors, major: null, minor: null }
  const t = tree(xml, count)
  const elements = path(t, 'a:theme', 'a:themeElements')
  const scheme = kid(elements, 'a:clrScheme')
  for (const name of SCHEME) {
    const c = kid(scheme, `a:${name}`)?.kids[0]
    const v = c?.name === 'a:srgbClr' ? at(c, 'val') : c?.name === 'a:sysClr' ? at(c, 'lastClr') : undefined
    if (v && /^[0-9a-f]{6}$/i.test(v)) colors.set(name, v)
  }
  const font = (k: string) => {
    const f = path(elements, 'a:fontScheme', k)
    return at(kid(f, 'a:latin'), 'typeface') || at(kid(f, 'a:ea'), 'typeface') || null
  }
  return { colors, major: font('a:majorFont'), minor: font('a:minorFont') }
}

const clamp = (v: number) => Math.max(0, Math.min(1, v))
function hexRgb(h: string): [number, number, number] { return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255] }
function rgbHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2
  if (mx === mn) return [0, 0, l]
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}
function hslRgb([h, s, l]: [number, number, number]): [number, number, number] {
  if (s === 0) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q
  const f = (t: number) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p }
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)]
}

interface Ctx {
  p: Parts
  theme: Theme
  /** the master's colour map: bg1 -> lt1 ... */
  map: Map<string, string>
  count: { n: number }
  media: Map<string, string>
  mediaOut: Record<string, string>
  mediaBytes: number
  notDrawn: SlidesHtml['notDrawn']
  slideNo: number
  rels: Map<string, ReturnType<typeof rels>>
}

/** The CSS colour of a colour element (a:srgbClr, a:schemeClr, a:sysClr, a:prstClr) with its changes, or null. */
function colorOf(c: El | undefined, x: Ctx): string | null {
  if (!c) return null
  let hex: string | undefined
  if (c.name === 'a:srgbClr') hex = at(c, 'val')
  else if (c.name === 'a:sysClr') hex = at(c, 'lastClr')
  else if (c.name === 'a:schemeClr') { const v = at(c, 'val') ?? ''; hex = x.theme.colors.get(x.map.get(v) ?? v) }
  else if (c.name === 'a:prstClr') hex = ({ black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080' } as Record<string, string>)[at(c, 'val') ?? '']
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return null
  let rgb = hexRgb(hex)
  let alpha = 1
  for (const m of c.kids) {
    const v = num(at(m, 'val'), NaN) / 100000
    if (!Number.isFinite(v)) continue
    if (m.name === 'a:lumMod' || m.name === 'a:lumOff') { const hsl = rgbHsl(rgb); hsl[2] = clamp(m.name === 'a:lumMod' ? hsl[2] * v : hsl[2] + v); rgb = hslRgb(hsl) }
    else if (m.name === 'a:shade') rgb = rgb.map((u) => clamp(u * v)) as typeof rgb
    else if (m.name === 'a:tint') rgb = rgb.map((u) => clamp(u + (1 - u) * (1 - v))) as typeof rgb
    else if (m.name === 'a:alpha') alpha = clamp(v)
  }
  const [r, g, b] = rgb.map((u) => Math.round(u * 255))
  return alpha < 1 ? `rgba(${r},${g},${b},${alpha.toFixed(3)})` : `rgb(${r},${g},${b})`
}
const COLOR_NAMES = new Set(['a:srgbClr', 'a:schemeClr', 'a:sysClr', 'a:prstClr', 'a:scrgbClr', 'a:hslClr'])
const firstColor = (e: El | undefined) => e?.kids.find((k) => COLOR_NAMES.has(k.name))

/** A fill in a properties element: 'none', a CSS colour, a picture (`{ pic }`), or undefined when it names none. */
type Fill = 'none' | string | { pic: string } | undefined
function fillOf(props: El | undefined, x: Ctx, part: string): Fill {
  if (!props) return undefined
  if (kid(props, 'a:noFill')) return 'none'
  const solid = kid(props, 'a:solidFill')
  if (solid) return colorOf(firstColor(solid), x) ?? undefined
  const grad = kid(props, 'a:gradFill')
  if (grad) return colorOf(firstColor(kidsOf(path(grad, 'a:gsLst'), 'a:gs')[0]), x) ?? undefined
  const blip = kid(props, 'a:blipFill')
  if (blip) { const src = picture(kid(blip, 'a:blip'), x, part); return src ? { pic: src } : undefined }
  return undefined
}

// ---------------- pictures ----------------

const PICTURE_EXT: Record<string, string> = { png: 'png', jpg: 'jpg', jpeg: 'jpg', gif: 'gif', webp: 'webp', bmp: 'bmp', svg: 'svg' }

/** The page's name for the picture an a:blip refers to (from the rels of `part`), or null when it cannot be drawn. */
function picture(blip: El | undefined, x: Ctx, part: string): string | null {
  const id = at(blip, 'r:embed')
  if (!id) return null
  const target = relsOf(x, part).get(id)?.target
  if (!target) return null
  const known = x.media.get(target)
  if (known) return known
  const e = PICTURE_EXT[/\.([a-z0-9]+)$/i.exec(target)?.[1]?.toLowerCase() ?? '']
  const bytes = x.p.get(target)
  if (!e || !bytes || bytes.length > PICTURE_BYTES_MAX || x.media.size >= MEDIA_MAX || x.mediaBytes + bytes.length > MEDIA_BYTES_MAX) return null
  const name = `m${x.media.size + 1}.${e}`
  x.media.set(target, name)
  x.mediaBytes += bytes.length
  x.mediaOut[name] = Buffer.from(bytes).toString('base64')
  return name
}

/** a part's relationships, read once per deck */
function relsOf(x: Ctx, part: string) {
  let r = x.rels.get(part)
  if (!r) { r = rels(x.p, part); x.rels.set(part, r) }
  return r
}

// ---------------- placeholders and text styles ----------------

interface Layer { part: string; tree: El }
/** a slide's chain: the slide, its layout, its master */
interface Chain { slide: Layer; layout: Layer | null; master: Layer | null }

const spTree = (t: El) => path(t, t.kids.find((k) => /^p:(sld|sldLayout|sldMaster)$/.test(k.name))?.name ?? '', 'p:cSld', 'p:spTree')
const nvOf = (sh: El) => sh.kids.find((k) => /^p:nv\w+Pr$/.test(k.name))
const phOf = (sh: El) => path(nvOf(sh), 'p:nvPr', 'p:ph')
const TITLE = new Set(['title', 'ctrTitle'])
/** placeholder kinds that take the master's body placeholder */
const CONTENT = new Set(['body', 'subTitle', 'obj', 'pic', 'tbl', 'chart', 'media', 'clipArt', 'dgm'])

/** The shape of a layout or master that a placeholder of the slide inherits from. */
function inherited(layer: Layer | null, ph: El, master: boolean): El | undefined {
  if (!layer) return undefined
  const shapes = kidsOf(spTree(layer.tree), 'p:sp')
  const type = at(ph, 'type'), idx = at(ph, 'idx')
  const typeOf = (s: El) => at(phOf(s), 'type')
  if (!master && idx !== undefined) { const m = shapes.find((s) => phOf(s) && at(phOf(s), 'idx') === idx); if (m) return m }
  const want = master ? (TITLE.has(type ?? '') ? 'title' : type === undefined || CONTENT.has(type) ? 'body' : type) : type
  return shapes.find((s) => { const p = phOf(s); if (!p) return false; const t = typeOf(s); return want === undefined ? t === undefined || t === 'obj' || t === 'body' : t === want || (master && want === 'title' && t === 'ctrTitle') })
}

/** The shapes a slide shape takes its place and text style from: itself, then its layout's and master's placeholder. */
function lineage(sh: El, chain: Chain): El[] {
  const ph = phOf(sh)
  if (!ph) return [sh]
  const out = [sh]
  const l = inherited(chain.layout, ph, false)
  if (l) out.push(l)
  const lp = l ? phOf(l) : undefined
  const m = inherited(chain.master, lp ?? ph, true)
  if (m) out.push(m)
  return out
}

/** The master's text style for a shape: title, body or other. */
function masterStyle(sh: El, chain: Chain): El | undefined {
  const styles = chain.master ? path(chain.master.tree, 'p:sldMaster', 'p:txStyles') : undefined
  const ph = phOf(sh)
  if (!ph) return kid(styles, 'p:otherStyle')
  const type = at(ph, 'type')
  if (TITLE.has(type ?? '')) return kid(styles, 'p:titleStyle')
  if (type === undefined || type === 'body' || type === 'obj' || type === 'subTitle') return kid(styles, 'p:bodyStyle')
  return kid(styles, 'p:otherStyle')
}

// ---------------- HTML ----------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const inch = (emu: number) => `${(emu / EMU_PER_IN).toFixed(4)}in`
const FONT_FALLBACK = '"Pretendard","Apple SD Gothic Neo","Noto Sans CJK KR","Noto Sans KR","Malgun Gothic","Hiragino Sans","PingFang SC","Helvetica Neue",Arial,sans-serif'

/** a group's mapping from its children's coordinates to the slide's */
interface Tf { sx: number; sy: number; tx: number; ty: number }
const ID: Tf = { sx: 1, sy: 1, tx: 0, ty: 0 }

interface Box { x: number; y: number; w: number; h: number; rot: number; flipH: boolean; flipV: boolean }
function boxOf(xfrm: El | undefined, tf: Tf): Box | null {
  const off = kid(xfrm, 'a:off'), ext = kid(xfrm, 'a:ext')
  if (!off || !ext) return null
  return {
    x: tf.tx + tf.sx * num(at(off, 'x'), 0), y: tf.ty + tf.sy * num(at(off, 'y'), 0),
    w: tf.sx * num(at(ext, 'cx'), 0), h: tf.sy * num(at(ext, 'cy'), 0),
    rot: num(at(xfrm, 'rot'), 0) / 60000, flipH: yes(at(xfrm, 'flipH')), flipV: yes(at(xfrm, 'flipV')),
  }
}
const boxCss = (b: Box, flip = false) => `left:${inch(b.x)};top:${inch(b.y)};width:${inch(b.w)};height:${inch(b.h)};` +
  (b.rot || (flip && (b.flipH || b.flipV)) ? `transform:${b.rot ? `rotate(${b.rot}deg)` : ''}${flip && b.flipH ? ' scaleX(-1)' : ''}${flip && b.flipV ? ' scaleY(-1)' : ''};` : '')

function fontFamily(face: string | undefined, x: Ctx): string {
  let f = face
  if (f?.startsWith('+mj')) f = x.theme.major ?? undefined
  else if (f?.startsWith('+mn')) f = x.theme.minor ?? undefined
  return f ? `"${f.replace(/["\\<>;{}]/g, '')}",${FONT_FALLBACK}` : FONT_FALLBACK
}

interface RunStyle { sz?: number; b?: boolean; i?: boolean; u?: boolean; color?: string; face?: string }
/** A run's properties (a:rPr / a:defRPr / a:endParaRPr) over `base`. */
function runStyle(r: El | undefined, x: Ctx, base: RunStyle): RunStyle {
  if (!r) return base
  const out = { ...base }
  const sz = at(r, 'sz'); if (sz !== undefined) out.sz = num(sz, 1800) / 100
  const b = at(r, 'b'); if (b !== undefined) out.b = b === '1' || b === 'true'
  const i = at(r, 'i'); if (i !== undefined) out.i = i === '1' || i === 'true'
  const u = at(r, 'u'); if (u !== undefined) out.u = u !== 'none'
  const c = colorOf(firstColor(kid(r, 'a:solidFill')), x); if (c) out.color = c
  const face = at(kid(r, 'a:latin'), 'typeface') ?? at(kid(r, 'a:ea'), 'typeface'); if (face) out.face = face
  return out
}

interface ParaStyle { algn?: string; marL?: number; indent?: number; bullet?: { char?: string; auto?: boolean } | null; run: RunStyle }
function paraStyle(p: El | undefined, x: Ctx, base: ParaStyle): ParaStyle {
  if (!p) return base
  const out: ParaStyle = { ...base, run: runStyle(kid(p, 'a:defRPr'), x, base.run) }
  const algn = at(p, 'algn'); if (algn) out.algn = algn
  const marL = at(p, 'marL'); if (marL !== undefined) out.marL = num(marL, 0)
  const ind = at(p, 'indent'); if (ind !== undefined) out.indent = num(ind, 0)
  if (kid(p, 'a:buNone')) out.bullet = null
  else if (kid(p, 'a:buChar')) out.bullet = { char: at(kid(p, 'a:buChar'), 'char') ?? '•' }
  else if (kid(p, 'a:buAutoNum')) out.bullet = { auto: true }
  return out
}

const ALIGN: Record<string, string> = { l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify' }

/** The paragraphs of a text body as HTML. `levels(n)`: the inherited style of level n (0-8). */
function textHtml(body: El, x: Ctx, levels: (lvl: number) => ParaStyle, scale: number): string {
  const out: string[] = []
  let autoNo = 0, autoLvl = -1
  for (const p of kidsOf(body, 'a:p')) {
    const pPr = kid(p, 'a:pPr')
    const lvl = Math.max(0, Math.min(8, num(at(pPr, 'lvl'), 0)))
    const st = paraStyle(pPr, x, levels(lvl))
    const runs: string[] = []
    let hasText = false
    let firstRun: RunStyle | null = null
    for (const r of p.kids) {
      if (r.name === 'a:br') { runs.push('<br>'); continue }
      if (r.name !== 'a:r' && r.name !== 'a:fld') continue
      const t = kid(r, 'a:t')
      let text = t ? unescapeXml(t.text) : ''
      if (r.name === 'a:fld' && at(r, 'type') === 'slidenum') text = String(x.slideNo)
      if (!text) continue
      hasText = true
      const s = runStyle(kid(r, 'a:rPr'), x, st.run)
      firstRun ??= s
      runs.push(`<span style="${spanCss(s, x, scale)}">${esc(text)}</span>`)
    }
    const end = runStyle(kid(p, 'a:endParaRPr'), x, st.run)
    const lead = firstRun ?? end
    let bullet = ''
    if (hasText && st.bullet) {
      if (st.bullet.auto) { autoNo = autoLvl === lvl ? autoNo + 1 : 1; autoLvl = lvl; bullet = `${autoNo}.` }
      else bullet = st.bullet.char ?? '•'
    }
    if (!st.bullet?.auto) { autoLvl = -1; autoNo = 0 }
    const marL = st.marL ?? (bullet ? 342900 * (lvl + 1) : 0)
    const indent = st.indent ?? (bullet ? -342900 : 0)
    const css = `text-align:${ALIGN[st.algn ?? 'l'] ?? 'left'};padding-left:${inch(Math.max(0, marL))};text-indent:${inch(indent)};font-size:${((lead.sz ?? 18) * scale).toFixed(2)}pt;`
    const mark = bullet ? `<span style="${spanCss(lead, x, scale)};display:inline-block;min-width:${inch(Math.max(0, -indent))};text-indent:0">${esc(bullet)}</span>` : ''
    out.push(`<p style="${css}">${mark}${runs.join('') || '&#8203;'}</p>`)
  }
  return out.join('')
}
const spanCss = (s: RunStyle, x: Ctx, scale: number) =>
  `font-size:${((s.sz ?? 18) * scale).toFixed(2)}pt;font-family:${esc(fontFamily(s.face, x))};color:${s.color ?? 'inherit'};` +
  `${s.b ? 'font-weight:700;' : ''}${s.i ? 'font-style:italic;' : ''}${s.u ? 'text-decoration:underline;' : ''}`

// ---------------- shapes ----------------

/** Draws the shapes of a shape tree (p:spTree or p:grpSp) into `out`. `own`: placeholders are drawn (the slide's own
 * tree); a layout's or master's tree gives only its other shapes. */
function drawTree(t: El, x: Ctx, chain: Chain, layer: Layer, tf: Tf, own: boolean, out: string[]): void {
  for (const sh of t.kids) {
    // a shape the author hid (the selection pane) is not printed, as PowerPoint's own export leaves it out
    if (yes(at(path(nvOf(sh), 'p:cNvPr'), 'hidden'))) continue
    if (sh.name === 'p:grpSp') {
      const xf = path(sh, 'p:grpSpPr', 'a:xfrm')
      const off = kid(xf, 'a:off'), ext = kid(xf, 'a:ext'), cOff = kid(xf, 'a:chOff'), cExt = kid(xf, 'a:chExt')
      let inner = tf
      if (off && ext && cOff && cExt) {
        const sx = num(at(cExt, 'cx'), 0) ? num(at(ext, 'cx'), 0) / num(at(cExt, 'cx'), 1) : 1
        const sy = num(at(cExt, 'cy'), 0) ? num(at(ext, 'cy'), 0) / num(at(cExt, 'cy'), 1) : 1
        inner = { sx: tf.sx * sx, sy: tf.sy * sy, tx: tf.tx + tf.sx * (num(at(off, 'x'), 0) - sx * num(at(cOff, 'x'), 0)), ty: tf.ty + tf.sy * (num(at(off, 'y'), 0) - sy * num(at(cOff, 'y'), 0)) }
      }
      drawTree(sh, x, chain, layer, inner, own, out)
    } else if (sh.name === 'p:sp' || sh.name === 'p:pic' || sh.name === 'p:cxnSp') {
      if (!own && phOf(sh)) continue
      out.push(drawShape(sh, x, chain, layer, tf))
    } else if (sh.name === 'p:graphicFrame') {
      if (!own && phOf(sh)) continue
      out.push(drawFrame(sh, x, chain, layer, tf))
    } else if (sh.name === 'mc:AlternateContent') {
      // newer content with an older fallback: the fallback is what other apps draw
      const fb = kid(sh, 'mc:Fallback')
      if (fb) drawTree(fb, x, chain, layer, tf, own, out)
    }
  }
}

const GREY_BOX = 'background:#ecebea;'
/** the theme's text colour (the default of text that names none) */
const TX1: El = { name: 'a:schemeClr', head: ' val="tx1"', kids: [], text: '' }

function drawShape(sh: El, x: Ctx, chain: Chain, layer: Layer, tf: Tf): string {
  const own = layer === chain.slide
  const line = own ? lineage(sh, chain) : [sh]
  const spPr = (s: El) => s.kids.find((k) => k.name === 'p:spPr')
  // the place: the shape's own, or the placeholder's it inherits (a layout's or master's place is not grouped)
  let box = boxOf(kid(spPr(sh), 'a:xfrm'), tf)
  for (const s of line.slice(1)) { if (box) break; box = boxOf(kid(spPr(s), 'a:xfrm'), ID) }
  if (!box) return ''
  // a picture's or a fill's picture is in the rels of the part the shape belongs to
  const partOf = (s: El) => (s === sh ? layer.part : s === line[1] ? chain.layout?.part ?? layer.part : chain.master?.part ?? layer.part)
  const style = kid(sh, 'p:style')
  if (sh.name === 'p:pic') {
    const blipFill = kid(sh, 'p:blipFill')
    const src = picture(kid(blipFill, 'a:blip'), x, layer.part)
    if (!src) { x.notDrawn.pictures++; return `<div class="sh" style="${boxCss(box)}${GREY_BOX}"></div>` }
    const crop = kid(blipFill, 'a:srcRect')
    const l = num(at(crop, 'l'), 0) / 100000, r = num(at(crop, 'r'), 0) / 100000, tp = num(at(crop, 't'), 0) / 100000, b = num(at(crop, 'b'), 0) / 100000
    const w = 1 - l - r > 0.01 ? 1 / (1 - l - r) : 1, h = 1 - tp - b > 0.01 ? 1 / (1 - tp - b) : 1
    const img = crop ? `<img src="${src}" style="position:absolute;left:${(-l * w * 100).toFixed(3)}%;top:${(-tp * h * 100).toFixed(3)}%;width:${(w * 100).toFixed(3)}%;height:${(h * 100).toFixed(3)}%">`
      : `<img src="${src}" style="position:absolute;left:0;top:0;width:100%;height:100%">`
    return `<div class="sh" style="${boxCss(box, true)}overflow:hidden">${img}</div>`
  }
  // fill and outline: the shape's own, its placeholder's, or its style's
  let fill: Fill
  for (const s of line) { fill = fillOf(spPr(s), x, partOf(s)); if (fill !== undefined) break }
  if (fill === undefined && style && sh.name === 'p:sp' && num(at(kid(style, 'a:fillRef'), 'idx'), 0) > 0) fill = colorOf(firstColor(kid(style, 'a:fillRef')), x) ?? undefined
  let ln: El | undefined
  for (const s of line) { ln = kid(spPr(s), 'a:ln'); if (ln) break }
  let stroke: string | null = null
  if (ln && !kid(ln, 'a:noFill')) stroke = colorOf(firstColor(kid(ln, 'a:solidFill')), x)
  if (!ln && style && num(at(kid(style, 'a:lnRef'), 'idx'), 0) > 0) stroke = colorOf(firstColor(kid(style, 'a:lnRef')), x)
  const strokeW = Math.max(0.5, num(at(ln, 'w'), 12700) / 12700)
  if (sh.name === 'p:cxnSp') {
    if (!stroke) return ''
    const [x1, y1, x2, y2] = [box.flipH ? 100 : 0, box.flipV ? 100 : 0, box.flipH ? 0 : 100, box.flipV ? 0 : 100]
    return `<svg class="sh" style="${boxCss(box)}overflow:visible" viewBox="0 0 100 100" preserveAspectRatio="none"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${strokeW}pt" vector-effect="non-scaling-stroke"/></svg>`
  }
  const geom = at(kid(spPr(sh), 'a:prstGeom'), 'prst') ?? 'rect'
  const radius = geom === 'ellipse' ? 'border-radius:50%;' : geom === 'roundRect' ? `border-radius:${inch(Math.min(box.w, box.h) * 0.16)};` : ''
  const bg = typeof fill === 'string' && fill !== 'none' ? `background:${fill};` : typeof fill === 'object' ? `background:url("${fill.pic}") center/cover no-repeat;` : ''
  const border = stroke ? `border:${strokeW.toFixed(2)}pt solid ${stroke};` : ''
  // the text: its body properties and the levels' styles, from the shape, its placeholders and the master
  const body = kid(sh, 'p:txBody')
  let text = ''
  let anchor = 't', ins = [91440, 45720, 91440, 45720], wrap = true
  if (body) {
    const bodyPrs = line.map((s) => kid(kid(s, 'p:txBody'), 'a:bodyPr'))
    const first = (n: string) => bodyPrs.map((b) => at(b, n)).find((v) => v !== undefined)
    anchor = first('anchor') ?? 't'
    ins = [num(first('lIns'), 91440), num(first('tIns'), 45720), num(first('rIns'), 91440), num(first('bIns'), 45720)]
    wrap = first('wrap') !== 'none'
    const fit = kid(bodyPrs[0], 'a:normAutofit')
    const scale = fit ? num(at(fit, 'fontScale'), 100000) / 100000 : 1
    const master = masterStyle(sh, chain)
    const fontRef = kid(style, 'a:fontRef')
    const refColor = fontRef ? colorOf(firstColor(fontRef), x) : null
    const base: ParaStyle = { run: { color: refColor ?? colorOf(TX1, x) ?? undefined } }
    const levels = (lvl: number): ParaStyle => {
      const n = `a:lvl${lvl + 1}pPr`
      let st = paraStyle(kid(master, n), x, base)
      // the master's placeholder, the layout's, then the shape's own list style (nearest last)
      for (const s of [...line].reverse()) st = paraStyle(kid(kid(kid(s, 'p:txBody'), 'a:lstStyle'), n), x, st)
      if (!phOf(sh) && st.bullet === undefined) st = { ...st, bullet: null }
      return st
    }
    text = textHtml(body, x, levels, scale)
  }
  const justify = anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : 'flex-start'
  return `<div class="sh" style="${boxCss(box)}${bg}${border}${radius}padding:${inch(ins[1]!)} ${inch(ins[2]!)} ${inch(ins[3]!)} ${inch(ins[0]!)};justify-content:${justify}"${wrap ? '' : ' data-nowrap'}>${text}</div>`
}

function drawFrame(sh: El, x: Ctx, chain: Chain, layer: Layer, tf: Tf): string {
  let box = boxOf(kid(sh, 'p:xfrm'), tf)
  if (!box && layer === chain.slide) for (const s of lineage(sh, chain).slice(1)) { box = boxOf(kid(kid(s, 'p:spPr'), 'a:xfrm'), ID); if (box) break }
  if (!box) return ''
  const data = path(sh, 'a:graphic', 'a:graphicData')
  const uri = at(data, 'uri') ?? ''
  const tbl = kid(data, 'a:tbl')
  if (tbl) return `<div class="sh" style="${boxCss(box)}display:block">${tableHtml(tbl, x)}</div>`
  if (uri.includes('/chart')) x.notDrawn.charts++
  else if (uri.includes('/diagram')) x.notDrawn.diagrams++
  else x.notDrawn.objects++
  return `<div class="sh" style="${boxCss(box)}${GREY_BOX}"></div>`
}

function tableHtml(tbl: El, x: Ctx): string {
  const cols = kidsOf(kid(tbl, 'a:tblGrid'), 'a:gridCol').map((c) => num(at(c, 'w'), 0))
  const rows: string[] = []
  const base: ParaStyle = { bullet: null, run: { sz: 18, color: colorOf(TX1, x) ?? undefined } }
  for (const tr of kidsOf(tbl, 'a:tr')) {
    const cells: string[] = []
    for (const tc of kidsOf(tr, 'a:tc')) {
      if (yes(at(tc, 'hMerge')) || yes(at(tc, 'vMerge'))) continue
      const tcPr = kid(tc, 'a:tcPr')
      const fill = fillOf(tcPr, x, '')
      const span = num(at(tc, 'gridSpan'), 1), rspan = num(at(tc, 'rowSpan'), 1)
      const body = kid(tc, 'a:txBody')
      const anchor = at(tcPr, 'anchor')
      cells.push(`<td${span > 1 ? ` colspan="${Math.min(span, 1000)}"` : ''}${rspan > 1 ? ` rowspan="${Math.min(rspan, 1000)}"` : ''} style="${typeof fill === 'string' && fill !== 'none' ? `background:${fill};` : ''}vertical-align:${anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top'}">${body ? textHtml(body, x, () => base, 1) : ''}</td>`)
    }
    rows.push(`<tr style="height:${inch(num(at(tr, 'h'), 0))}">${cells.join('')}</tr>`)
  }
  return `<table><colgroup>${cols.map((w) => `<col style="width:${inch(w)}">`).join('')}</colgroup>${rows.join('')}</table>`
}

/** The slide's background: its own, its layout's or its master's (a colour or a picture). */
function background(chain: Chain, x: Ctx): string {
  for (const layer of [chain.slide, chain.layout, chain.master]) {
    if (!layer) continue
    const root = layer.tree.kids.find((k) => /^p:(sld|sldLayout|sldMaster)$/.test(k.name))
    const bg = path(root, 'p:cSld', 'p:bg')
    if (!bg) continue
    const fill = fillOf(kid(bg, 'p:bgPr'), x, layer.part) ?? colorOf(firstColor(kid(bg, 'p:bgRef')), x) ?? undefined
    if (typeof fill === 'object') return `background:#fff url("${fill.pic}") center/cover no-repeat;`
    if (fill && fill !== 'none') return `background:${fill};`
  }
  return 'background:#fff;'
}

// ---------------- the deck ----------------

const layerOf = (p: Parts, part: string | undefined, count: { n: number }): Layer | null => {
  if (!part) return null
  const xml = xmlOf(p, part)
  return xml ? { part, tree: tree(xml, count) } : null
}
const relOfType = (p: Parts, part: string, type: string) => [...rels(p, part).values()].find((r) => r.type.endsWith(type))?.target

/** The deck as one HTML page, a page per shown slide (`withHidden`: per slide, hidden ones too). Throws ToolError for a
 * file that is not a deck or is too large. */
export function pptxSlidesHtml(bytes: Uint8Array, o: { withHidden?: boolean } = {}): SlidesHtml {
  const p = parts(bytes, 'presentation')
  const count = { n: 0 }
  const pres = xmlOf(p, 'ppt/presentation.xml')
  if (!pres) throw new ToolError('this file is not a PowerPoint deck (no ppt/presentation.xml)')
  const presTree = tree(pres, count)
  const sz = path(presTree, 'p:presentation', 'p:sldSz')
  const W = Math.max(EMU_PER_IN, Math.min(num(at(sz, 'cx'), 12192000), 56 * EMU_PER_IN))
  const H = Math.max(EMU_PER_IN, Math.min(num(at(sz, 'cy'), 6858000), 56 * EMU_PER_IN))
  const order = slideOrder(p)
  const notDrawn = { charts: 0, diagrams: 0, objects: 0, pictures: 0 }
  const layers = new Map<string, Layer | null>()
  const themes = new Map<string, Theme>()
  const cached = (part: string | undefined) => { if (!part) return null; if (!layers.has(part)) layers.set(part, layerOf(p, part, count)); return layers.get(part)! }
  const x: Ctx = { p, theme: { colors: new Map(), major: null, minor: null }, map: new Map(), count, media: new Map(), mediaOut: {}, mediaBytes: 0, notDrawn, slideNo: 0, rels: new Map() }
  const pages: string[] = []
  let hidden = 0
  const hiddenSlides: number[] = []
  for (const [i, part] of order.entries()) {
    const slide = cached(part)
    if (!slide) continue
    const root = slide.tree.kids.find((k) => k.name === 'p:sld')
    if (no(at(root, 'show'))) {
      hidden++
      if (!o.withHidden) continue
      hiddenSlides.push(pages.length + 1)
    }
    if (pages.length >= PPTX_PDF_SLIDES_MAX) throw new ToolError(`the deck has more than ${PPTX_PDF_SLIDES_MAX} slides to show; a PDF of it cannot be made here`)
    const layout = cached(relOfType(p, part, '/slideLayout'))
    const master = layout ? cached(relOfType(p, layout.part, '/slideMaster')) : null
    const chain: Chain = { slide, layout, master }
    const themePart = master ? relOfType(p, master.part, '/theme') : undefined
    if (themePart && !themes.has(themePart)) themes.set(themePart, themeOf(xmlOf(p, themePart), count))
    x.theme = themePart ? themes.get(themePart)! : { colors: new Map(), major: null, minor: null }
    const clrMap = path(master?.tree, 'p:sldMaster', 'p:clrMap')
    x.map = new Map(['bg1', 'tx1', 'bg2', 'tx2'].map((k, j) => [k, at(clrMap, k) ?? ['lt1', 'dk1', 'lt2', 'dk2'][j]!]))
    x.slideNo = i + 1
    const out: string[] = []
    const showMaster = !no(at(root, 'showMasterSp')) && !no(at(layout?.tree.kids.find((k) => k.name === 'p:sldLayout'), 'showMasterSp'))
    if (master && showMaster) drawTree(spTree(master.tree) ?? master.tree, x, chain, master, ID, false, out)
    if (layout && !no(at(root, 'showMasterSp'))) drawTree(spTree(layout.tree) ?? layout.tree, x, chain, layout, ID, false, out)
    drawTree(spTree(slide.tree) ?? slide.tree, x, chain, slide, ID, true, out)
    pages.push(`<section class="s" style="${background(chain, x)}">${out.join('')}</section>`)
  }
  if (!pages.length) throw new ToolError(hidden ? 'every slide of this deck is hidden; there is nothing to put in a PDF' : 'this deck has no slides')
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>' +
    `@page{size:${inch(W)} ${inch(H)};margin:0}html,body{margin:0;padding:0}body{font-family:${FONT_FALLBACK};-webkit-print-color-adjust:exact;print-color-adjust:exact}` +
    // a page a hair shorter than the paper, so rounding never pushes a slide onto two pages
    `.s{position:relative;width:${inch(W)};height:calc(${inch(H)} - 1px);overflow:hidden;break-after:page}.s:last-child{break-after:auto}` +
    '.sh{position:absolute;box-sizing:border-box;display:flex;flex-direction:column;overflow:visible;line-height:1.15;overflow-wrap:break-word}' +
    'p{margin:0;white-space:pre-wrap}[data-nowrap] p{white-space:pre}table{border-collapse:collapse;width:100%;table-layout:fixed}td{border:0.75pt solid #9ca3af;padding:0.05in 0.08in}' +
    `</style></head><body>${pages.join('')}</body></html>`
  return { html, media: x.mediaOut, slides: pages.length, hidden, notDrawn, ...(o.withHidden ? { hiddenSlides } : {}) }
}

/** The office worker's answer: the page and its pictures as JSON (UTF-8). */
export const pptxHtmlRequest = (bytes: Uint8Array, o: { withHidden?: boolean } = {}): Uint8Array => new TextEncoder().encode(JSON.stringify(pptxSlidesHtml(bytes, o)))
