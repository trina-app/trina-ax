// The AI accent's sanitizer (docs/DECISIONS.md "D2", round 2): the AI may draw at most two decorative accents per deck
// (cover, opening, closing) as SVG in a small grammar. SVG is code, so every input is treated as hostile:
// - a small XML reader of our own: no DTD, no entities but the five predefined ones and numeric references, no CDATA,
//   no processing instruction but one leading `<?xml …?>`; comments are dropped; text between tags must be whitespace;
// - then a NEW SVG is written from an allowlist of elements and attributes. No input text is passed through: numbers
//   are re-read and re-written, path data is re-tokenized, colours are theme names mapped to the theme's hex values
//   (an accent never brings its own palette), ids are renamed `a1`, `a2`, … in document order.
// Anything outside the grammar rejects the whole accent with a reason (the slide keeps its drawn pattern). Unknown
// attributes are rejected too, not dropped: the grammar is in the tool description, so an attribute outside it is
// either a mistake or an attack, and a quiet drop would draw something other than what the AI meant.
// The output is deterministic, ASCII only, and sanitizes to itself (a hex value equal to one of the five theme colours
// is read as that colour, so the rebuilt SVG passes again unchanged).
import { DECK_ACCENT_MAX_BYTES } from '@mycel/shared/api'

/** The theme colours an accent may use, by name; each "#rrggbb". */
export type AccentColors = { ink: string; ground: string; line: string; mark: string; onMark: string }
export type AccentResult = { ok: true; svg: string; elements: number } | { ok: false; reason: string }

export const ACCENT_MAX_ELEMENTS = 150
/** Open elements at once, the root `svg` counted as 1. */
export const ACCENT_MAX_DEPTH = 8
export const ACCENT_MAX_PATH = 8_000
export const ACCENT_MAX_NUMBER = 10_000
const MAX_ATTRS = 24
const MAX_VALUE = 512 // any attribute but `d` and `points`
const MAX_TRANSFORMS = 8
const MAX_DASHES = 16
const STROKE_WIDTHS = [1.5, 2, 3]
const OPACITY_MIN = 0.08
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/
const SVG_NS = 'http://www.w3.org/2000/svg'
const ROOT = `<svg xmlns="${SVG_NS}" viewBox="0 0 800 800" width="800" height="800"`
const COLOUR_NAMES = ['ink', 'ground', 'line', 'mark', 'onMark'] as const

class Reject extends Error {}
function fail(reason: string): never {
  throw new Reject(reason)
}

// ---- the grammar ----

const SHAPES = ['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']
const CONTENT = new Set(['g', 'defs', 'linearGradient', 'radialGradient', 'clipPath', ...SHAPES])
const CHILDREN: Record<string, Set<string>> = {
  svg: CONTENT,
  g: CONTENT,
  defs: new Set(['linearGradient', 'radialGradient', 'clipPath']),
  linearGradient: new Set(['stop']),
  radialGradient: new Set(['stop']),
  clipPath: new Set(SHAPES),
  stop: new Set(),
  ...Object.fromEntries(SHAPES.map((s) => [s, new Set<string>()])),
}
/** Presentation attributes, in output order. */
const PAINT = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'opacity', 'clip-path', 'clip-rule', 'transform']
/** Allowed attributes per element, in output order. */
const ATTRS: Record<string, string[]> = {
  svg: ['xmlns', 'viewBox', 'width', 'height', ...PAINT.filter((a) => a !== 'transform')],
  g: PAINT,
  defs: [],
  path: ['d', ...PAINT],
  circle: ['cx', 'cy', 'r', ...PAINT],
  ellipse: ['cx', 'cy', 'rx', 'ry', ...PAINT],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry', ...PAINT],
  line: ['x1', 'y1', 'x2', 'y2', ...PAINT],
  polyline: ['points', ...PAINT],
  polygon: ['points', ...PAINT],
  linearGradient: ['id', 'x1', 'y1', 'x2', 'y2', 'gradientUnits', 'spreadMethod'],
  radialGradient: ['id', 'cx', 'cy', 'r', 'fx', 'fy', 'gradientUnits', 'spreadMethod'],
  stop: ['offset', 'stop-color', 'stop-opacity'],
  clipPath: ['id', 'transform'],
}
const ENUMS: Record<string, string[]> = {
  'stroke-linecap': ['round', 'butt', 'square'],
  'stroke-linejoin': ['round', 'miter', 'bevel'],
  'fill-rule': ['nonzero', 'evenodd'],
  'clip-rule': ['nonzero', 'evenodd'],
  gradientUnits: ['userSpaceOnUse', 'objectBoundingBox'],
  spreadMethod: ['pad'],
}
const GEOMETRY = new Set(['cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'fx', 'fy'])
const NON_NEGATIVE = new Set(['r', 'rx', 'ry', 'width', 'height'])
const OPACITIES = new Set(['opacity', 'fill-opacity', 'stroke-opacity', 'stop-opacity'])
const IDS_ON = new Set(['linearGradient', 'radialGradient', 'clipPath'])

// ---- the XML reader ----

interface Node { name: string; attrs: Map<string, string>; children: Node[] }

const NAME = /[A-Za-z_:][A-Za-z0-9_.:-]*/y
const isWs = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r'
const show = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s)

/** An attribute value with its references resolved: the five predefined entities and numeric references only. */
function decode(raw: string): string {
  if (raw.includes('<')) fail('"<" is not allowed in an attribute value')
  if (!raw.includes('&')) return raw
  let out = ''
  let i = 0
  while (i < raw.length) {
    const amp = raw.indexOf('&', i)
    if (amp < 0) { out += raw.slice(i); break }
    out += raw.slice(i, amp)
    const semi = raw.indexOf(';', amp)
    const ref = semi < 0 || semi - amp > 10 ? '' : raw.slice(amp + 1, semi)
    const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
    if (Object.hasOwn(named, ref)) out += named[ref]
    else if (/^#[0-9]{1,7}$/.test(ref) || /^#x[0-9A-Fa-f]{1,6}$/.test(ref)) {
      const cp = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
      const xmlChar = cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff)
      if (!xmlChar) fail('a character reference points to a character XML does not allow')
      out += String.fromCodePoint(cp)
    } else fail(`entities other than &lt; &gt; &amp; &quot; &apos; are not allowed${ref ? ` (&${show(ref)};)` : ''}`)
    i = semi + 1
  }
  return out
}

function parseXml(src: string): { root: Node; count: number } {
  const n = src.length
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0
  const skipWs = () => { while (i < n && isWs(src[i])) i++ }
  skipWs()
  if (src.startsWith('<?xml', i) && isWs(src[i + 5])) {
    const end = src.indexOf('?>', i)
    if (end < 0) fail('the XML declaration is not closed')
    if (!/^(?:[ \t\r\n]+[A-Za-z]+[ \t\r\n]*=[ \t\r\n]*(?:"[^"<>&]*"|'[^'<>&]*'))*[ \t\r\n]*$/.test(src.slice(i + 5, end))) fail('the XML declaration is malformed')
    i = end + 2
  }
  let root: Node | null = null
  const stack: Node[] = []
  let count = 0
  while (i < n) {
    const lt = src.indexOf('<', i)
    const textEnd = lt < 0 ? n : lt
    if (textEnd > i) {
      const text = src.slice(i, textEnd)
      if (!/^[ \t\r\n]*$/.test(text)) fail(text.includes('&') ? 'entities and text are not allowed between tags' : 'text is not allowed in an accent')
      i = textEnd
      if (lt < 0) break
    }
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4)
      if (end < 0) fail('a comment is not closed')
      i = end + 3
      continue
    }
    if (src.startsWith('<![CDATA[', i)) fail('CDATA sections are not allowed')
    if (src.startsWith('<!', i)) fail(/^<!(?:DOCTYPE|ENTITY)/i.test(src.slice(i, i + 9)) ? 'DOCTYPE and ENTITY declarations are not allowed' : 'markup declarations are not allowed')
    if (src.startsWith('<?', i)) fail('processing instructions are not allowed')
    if (src.startsWith('</', i)) {
      NAME.lastIndex = i + 2
      const m = NAME.exec(src)
      if (!m) fail('a closing tag is malformed')
      i += 2 + m[0].length
      skipWs()
      if (src[i] !== '>') fail(`the closing tag </${show(m[0])}> is malformed`)
      i++
      const top = stack.pop()
      if (!top) fail(`</${show(m[0])}> closes nothing`)
      if (top.name !== m[0]) fail(`</${show(m[0])}> does not match <${top.name}>`)
      continue
    }
    // a start tag
    NAME.lastIndex = i + 1
    const m = NAME.exec(src)
    if (!m) fail('a tag is malformed')
    const name = m[0]
    if (name.includes(':')) fail(`the namespaced element <${show(name)}> is not allowed`)
    if (!Object.hasOwn(ATTRS, name)) fail(`the element <${show(name)}> is not allowed`)
    const parent = stack[stack.length - 1]
    if (!parent) {
      if (root) fail('there is more than one root element')
      if (name !== 'svg') fail('the root element must be <svg>')
    } else if (!CHILDREN[parent.name].has(name)) fail(`<${name}> is not allowed inside <${parent.name}>`)
    if (++count > ACCENT_MAX_ELEMENTS) fail(`an accent has at most ${ACCENT_MAX_ELEMENTS} elements`)
    if (stack.length + 1 > ACCENT_MAX_DEPTH) fail(`elements are nested deeper than ${ACCENT_MAX_DEPTH}`)
    i += 1 + name.length
    const node: Node = { name, attrs: new Map(), children: [] }
    let selfClosed = false
    for (;;) {
      const before = i
      skipWs()
      if (src.startsWith('/>', i)) { i += 2; selfClosed = true; break }
      if (src[i] === '>') { i++; break }
      if (i >= n) fail(`the tag <${name}> is not closed`)
      if (i === before) fail(`the tag <${name}> is malformed`)
      NAME.lastIndex = i
      const a = NAME.exec(src)
      if (!a) fail(`an attribute in <${name}> is malformed`)
      i += a[0].length
      skipWs()
      if (src[i] !== '=') fail(`the attribute ${show(a[0])} in <${name}> has no value`)
      i++
      skipWs()
      const q = src[i]
      if (q !== '"' && q !== "'") fail(`the attribute ${show(a[0])} in <${name}> must be quoted`)
      const end = src.indexOf(q, i + 1)
      if (end < 0) fail(`the attribute ${show(a[0])} in <${name}> is not closed`)
      if (node.attrs.has(a[0])) fail(`the attribute ${show(a[0])} appears twice in <${name}>`)
      if (node.attrs.size >= MAX_ATTRS) fail(`<${name}> has more than ${MAX_ATTRS} attributes`)
      node.attrs.set(a[0], decode(src.slice(i + 1, end)))
      i = end + 1
    }
    if (parent) parent.children.push(node)
    else root = node
    if (!selfClosed) stack.push(node)
  }
  if (stack.length) fail(`<${stack[stack.length - 1].name}> is not closed`)
  if (!root) fail('there is no <svg> element')
  return { root, count }
}

// ---- values ----

const NUM = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/
const NUM_AT = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y
const isSep = (c: string) => isWs(c) || c === ','

/** Up to three decimals, never an exponent (|x| ≤ 10,000), "-0" as "0". */
const fmt = (x: number) => String(Math.round(x * 1000) / 1000)

function finite(text: string, what: string): number {
  const x = Number(text)
  if (!Number.isFinite(x) || Math.abs(x) > ACCENT_MAX_NUMBER) fail(`${what} has a number outside ±${ACCENT_MAX_NUMBER}`)
  return x
}

function num(v: string, what: string): number {
  const s = v.trim()
  if (!NUM.test(s)) fail(`${what} must be a plain number`)
  return finite(s, what)
}

/** Numbers separated by whitespace and commas ("1,2 3-4" reads as 1 2 3 −4); anything else rejects. */
function numberList(v: string, what: string): number[] {
  const out: number[] = []
  let i = 0
  for (;;) {
    while (i < v.length && isSep(v[i])) i++
    if (i >= v.length) return out
    NUM_AT.lastIndex = i
    const m = NUM_AT.exec(v)
    if (!m) fail(`${what} must be numbers only`)
    out.push(finite(m[0], what))
    i += m[0].length
  }
}

const ARITY: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 }
const COMMAND = /^[MmLlHhVvCcSsQqTtAaZz]$/

/** Path data re-tokenized and re-written: the SVG commands with plain numbers, arc flags 0/1. */
function pathData(d: string): string | null {
  if (d.length > ACCENT_MAX_PATH) fail(`path data is longer than ${ACCENT_MAX_PATH} characters`)
  const out: string[] = []
  let i = 0
  const skip = () => { while (i < d.length && isSep(d[i])) i++ }
  const unknown = () => fail(`path data has an unknown command or a malformed number near "${show(d.slice(i, i + 12))}"`)
  skip()
  while (i < d.length) {
    const c = d[i]
    if (!COMMAND.test(c)) unknown()
    const k = ARITY[c.toLowerCase()]
    if (!out.length && c !== 'M' && c !== 'm') fail('path data must start with M')
    i++
    const args: string[] = []
    for (;;) {
      skip()
      if (i >= d.length) break
      if (/[A-Za-z]/.test(d[i])) {
        if (COMMAND.test(d[i])) break
        unknown()
      }
      if (k === 7 && (args.length % 7 === 3 || args.length % 7 === 4)) {
        if (d[i] !== '0' && d[i] !== '1') fail('arc flags must be 0 or 1')
        args.push(d[i])
        i++
        continue
      }
      NUM_AT.lastIndex = i
      const m = NUM_AT.exec(d)
      if (!m) fail(`path data has a malformed number near "${show(d.slice(i, i + 12))}"`)
      args.push(fmt(finite(m[0], 'path data')))
      i += m[0].length
    }
    if (k === 0 ? args.length > 0 : args.length === 0 || args.length % k !== 0) fail(`the path command ${c} has the wrong number of values`)
    out.push(c + args.join(' '))
  }
  if (!out.length) return null
  const s = out.join('')
  if (s.length > ACCENT_MAX_PATH) fail(`path data is longer than ${ACCENT_MAX_PATH} characters`)
  return s
}

function pointList(v: string): string | null {
  if (v.length > ACCENT_MAX_PATH) fail(`points is longer than ${ACCENT_MAX_PATH} characters`)
  const xs = numberList(v, 'points')
  if (!xs.length) return null
  if (xs.length % 2) fail('points must come in x y pairs')
  const s = xs.map(fmt).join(' ')
  if (s.length > ACCENT_MAX_PATH) fail(`points is longer than ${ACCENT_MAX_PATH} characters`)
  return s
}

const TRANSFORM_AT = /([A-Za-z]+)[ \t\r\n]*\(([^()]*)\)/y
const TRANSFORM_ARGS: Record<string, number[]> = { translate: [1, 2], rotate: [1, 3], scale: [1, 2] }

function transform(v: string): string | null {
  const out: string[] = []
  let i = 0
  for (;;) {
    while (i < v.length && isSep(v[i])) i++
    if (i >= v.length) break
    TRANSFORM_AT.lastIndex = i
    const m = TRANSFORM_AT.exec(v)
    if (!m) fail('transform must be translate, rotate or scale with numbers')
    if (!Object.hasOwn(TRANSFORM_ARGS, m[1])) fail(`the transform ${show(m[1])} is not allowed (translate, rotate or scale only)`)
    const args = numberList(m[2], `transform ${m[1]}`)
    if (!TRANSFORM_ARGS[m[1]].includes(args.length)) fail(`transform ${m[1]} has the wrong number of values`)
    if (out.push(`${m[1]}(${args.map(fmt).join(' ')})`) > MAX_TRANSFORMS) fail(`transform has more than ${MAX_TRANSFORMS} steps`)
    i += m[0].length
  }
  return out.length ? out.join(' ') : null
}

// ---- the rebuild ----

interface Ref { id: string; kind: 'paint' | 'clip' }
interface Ctx { palette: Map<string, string>; hexes: Set<string>; ids: Map<string, Ref>; shapes: number }

function colour(v: string, attr: string, ctx: Ctx): string {
  const s = v.trim()
  const named = ctx.palette.get(s)
  if (named) return named
  if (ctx.hexes.has(s.toLowerCase())) return s.toLowerCase()
  fail(`${attr} must be a theme colour name (${COLOUR_NAMES.join(', ')})`)
}

function reference(v: string, attr: string, kind: Ref['kind'], ctx: Ctx): string | null {
  const m = /^url\(#([A-Za-z][A-Za-z0-9_-]{0,31})\)$/.exec(v.trim())
  if (!m) return null
  const ref = ctx.ids.get(m[1])
  if (!ref) fail(`${attr} points to a missing id "${m[1]}"`)
  if (ref.kind !== kind) fail(`${attr} must point to a ${kind === 'paint' ? 'gradient' : 'clipPath'}`)
  return `url(#${ref.id})`
}

function paint(v: string, attr: string, ctx: Ctx): string {
  if (v.trim() === 'none') return 'none'
  const ref = reference(v, attr, 'paint', ctx)
  if (ref) return ref
  if (/url\s*\(/i.test(v)) fail(`${attr} may point only to a gradient in this file, as url(#id)`)
  return colour(v, attr, ctx)
}

/** One attribute's canonical value, or null to leave it out. */
function value(el: string, attr: string, v: string, ctx: Ctx, inClip: boolean): string | null {
  if (attr !== 'd' && attr !== 'points' && v.length > MAX_VALUE) fail(`${attr} is too long`)
  const what = `${attr} on <${el}>`
  if (attr === 'd') return pathData(v)
  if (attr === 'points') return pointList(v)
  if (attr === 'transform') return transform(v)
  if (attr === 'fill' || attr === 'stroke') return paint(v, attr, ctx)
  if (attr === 'stop-color') return colour(v, attr, ctx)
  if (attr === 'clip-path') {
    if (inClip) fail('clip-path is not allowed inside a clipPath')
    const ref = reference(v, attr, 'clip', ctx)
    if (!ref) fail('clip-path must point to a clipPath in this file, as url(#id)')
    return ref
  }
  if (attr === 'id') return ctx.ids.get(v)!.id
  if (attr === 'stroke-width') {
    const w = num(v, what)
    let best = STROKE_WIDTHS[0]
    for (const c of STROKE_WIDTHS) if (Math.abs(w - c) <= Math.abs(w - best)) best = c // a tie goes to the thicker
    return fmt(best)
  }
  if (OPACITIES.has(attr)) return fmt(Math.min(1, Math.max(OPACITY_MIN, num(v, what))))
  if (attr === 'offset') {
    const s = v.trim()
    const x = s.endsWith('%') ? num(s.slice(0, -1), what) / 100 : num(s, what)
    return fmt(Math.min(1, Math.max(0, x)))
  }
  if (attr === 'stroke-dasharray') {
    if (v.trim() === 'none') return 'none'
    const xs = numberList(v, what)
    if (!xs.length || xs.length > MAX_DASHES) fail(`${what} must have 1 to ${MAX_DASHES} numbers`)
    if (xs.some((x) => x < 0)) fail(`${what} must not be negative`)
    return xs.map(fmt).join(' ')
  }
  if (Object.hasOwn(ENUMS, attr)) {
    const s = v.trim()
    if (!ENUMS[attr].includes(s)) fail(`${what} must be ${ENUMS[attr].join(' or ')}`)
    return s
  }
  if (GEOMETRY.has(attr)) {
    const s = v.trim()
    const pct = (el === 'linearGradient' || el === 'radialGradient') && s.endsWith('%')
    const x = num(pct ? s.slice(0, -1) : s, what)
    if (NON_NEGATIVE.has(attr) && x < 0) fail(`${what} must not be negative`)
    return fmt(x) + (pct ? '%' : '')
  }
  fail(`the attribute ${attr} is not allowed on <${el}>`)
}

function unknownAttribute(attr: string, el: string): string {
  if (attr.includes(':')) return `the namespaced attribute ${show(attr)} is not allowed`
  if (/^on/i.test(attr)) return `event attributes (${show(attr)}) are not allowed`
  if (/href/i.test(attr)) return 'href is not allowed'
  if (/^style$/i.test(attr)) return 'style attributes are not allowed'
  return `the attribute ${show(attr)} is not allowed on <${el}>`
}

function collectIds(node: Node, ctx: Ctx) {
  if (IDS_ON.has(node.name)) {
    const id = node.attrs.get('id')
    if (id === undefined) fail(`<${node.name}> needs an id`)
    if (!ID.test(id)) fail(`the id "${show(id)}" must be a letter and then up to 31 letters, digits, - or _`)
    if (ctx.ids.has(id)) fail(`the id "${id}" is used twice`)
    ctx.ids.set(id, { id: `a${ctx.ids.size + 1}`, kind: node.name === 'clipPath' ? 'clip' : 'paint' })
  }
  for (const c of node.children) collectIds(c, ctx)
}

function attributes(node: Node, ctx: Ctx, inClip: boolean): string {
  const allowed = ATTRS[node.name]
  for (const a of node.attrs.keys()) if (!allowed.includes(a)) fail(unknownAttribute(a, node.name))
  let out = ''
  for (const a of allowed) {
    const v = node.attrs.get(a)
    if (v === undefined) continue
    const x = value(node.name, a, v, ctx, inClip)
    if (x !== null) out += ` ${a}="${x}"`
  }
  return out
}

function element(node: Node, ctx: Ctx, inClip: boolean): string {
  if (SHAPES.includes(node.name)) ctx.shapes++
  const attrs = attributes(node, ctx, inClip)
  const inner = node.children.map((c) => element(c, ctx, inClip || node.name === 'clipPath')).join('')
  return inner ? `<${node.name}${attrs}>${inner}</${node.name}>` : `<${node.name}${attrs}/>`
}

function rootElement(root: Node, ctx: Ctx): string {
  const a = root.attrs
  for (const k of a.keys()) if (!ATTRS.svg.includes(k)) fail(unknownAttribute(k, 'svg'))
  if (a.has('xmlns') && a.get('xmlns') !== SVG_NS) fail(`xmlns must be ${SVG_NS}`)
  if (a.has('viewBox')) {
    const vb = numberList(a.get('viewBox')!, 'viewBox')
    if (vb.length !== 4 || vb[0] !== 0 || vb[1] !== 0 || vb[2] !== 800 || vb[3] !== 800) fail('viewBox must be "0 0 800 800"')
  }
  for (const k of ['width', 'height']) if (a.has(k) && num(a.get(k)!, `${k} on <svg>`) < 0) fail(`${k} on <svg> must not be negative`)
  const paintOnly: Node = { name: 'svg', attrs: new Map([...a].filter(([k]) => PAINT.includes(k))), children: [] }
  const attrs = attributes(paintOnly, ctx, false)
  return `${ROOT}${attrs}>${root.children.map((c) => element(c, ctx, false)).join('')}</svg>`
}

/** Checks an AI accent against the grammar and rebuilds it with the theme's colours. Never throws. */
export function sanitizeAccent(input: string, colors: AccentColors): AccentResult {
  try {
    if (typeof input !== 'string') fail('the accent must be text')
    const bytes = Buffer.byteLength(input, 'utf8')
    if (bytes > DECK_ACCENT_MAX_BYTES) fail(`the accent is ${bytes} bytes; at most ${DECK_ACCENT_MAX_BYTES}`)
    const palette = new Map<string, string>()
    for (const k of COLOUR_NAMES) {
      const hex = colors?.[k]
      if (typeof hex !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(hex)) fail(`the theme colour ${k} must be #rrggbb`)
      palette.set(k, hex.toLowerCase())
    }
    const { root, count } = parseXml(input)
    const ctx: Ctx = { palette, hexes: new Set(palette.values()), ids: new Map(), shapes: 0 }
    collectIds(root, ctx)
    const svg = rootElement(root, ctx)
    if (!ctx.shapes) fail('the accent draws nothing')
    if (svg.length > DECK_ACCENT_MAX_BYTES) fail(`the rebuilt accent is over ${DECK_ACCENT_MAX_BYTES} bytes`)
    // every value above is canonical; this only guards the writer itself
    if (!/^[A-Za-z0-9 <>/="#().,%:_-]*$/.test(svg)) fail('the rebuilt accent has an unexpected character')
    return { ok: true, svg, elements: count }
  } catch (e) {
    if (e instanceof Reject) return { ok: false, reason: e.message }
    return { ok: false, reason: 'the accent could not be read' }
  }
}

/** A sanitized accent as a data URI for an `<img>` (never inline markup). Throws on anything sanitizeAccent did not write. */
export function accentDataUri(svg: string): string {
  if (typeof svg !== 'string' || !svg.startsWith(ROOT) || !svg.endsWith('</svg>')) throw new Error('accentDataUri takes the svg sanitizeAccent returned')
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}
