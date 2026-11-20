// A very small HTML document for unit tests that need DOMParser (bun has none): elements, attributes, text, raw-text
// elements (script, style, textarea, title), void elements and the SVG namespace, with the few DOM calls that
// lib/frame-files.ts and lib/artifacts.ts cleanStatic use. Test inputs only; the browser's own parser is covered by the
// e2e specs.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const RAW = new Set(['script', 'style', 'textarea', 'title'])
const SVG_NS = 'http://www.w3.org/2000/svg'
const HTML_NS = 'http://www.w3.org/1999/xhtml'

const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()]!)
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export class MiniAttr {
  constructor(public name: string, public value: string, public owner: MiniElement) {}
  get localName() { return this.name.includes(':') ? this.name.slice(this.name.indexOf(':') + 1) : this.name }
}

type Node = MiniElement | { text: string; parent: MiniElement | null }

export class MiniElement {
  attrs: MiniAttr[] = []
  children: Node[] = []
  parent: MiniElement | null = null
  constructor(public localName: string, public namespaceURI: string) {}
  get attributes() { return [...this.attrs] }
  getAttribute(n: string) { return this.attrs.find((a) => a.name === n.toLowerCase() || a.name === n)?.value ?? null }
  hasAttribute(n: string) { return this.getAttribute(n) !== null }
  setAttribute(n: string, v: string) { const a = this.attrs.find((x) => x.name === n); if (a) a.value = v; else this.attrs.push(new MiniAttr(n, v, this)) }
  removeAttributeNode(a: MiniAttr) { this.attrs = this.attrs.filter((x) => x !== a) }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null }
  get textContent(): string { return this.children.map((c) => (c instanceof MiniElement ? c.textContent : c.text)).join('') }
  set textContent(v: string) { this.children = [{ text: v, parent: this }] }
  get outerHTML(): string {
    const open = `<${this.localName}${this.attrs.map((a) => ` ${a.name}="${escAttr(a.value)}"`).join('')}>`
    if (VOID.has(this.localName) && this.namespaceURI === HTML_NS) return open
    const raw = RAW.has(this.localName)
    return open + this.children.map((c) => (c instanceof MiniElement ? c.outerHTML : raw ? c.text : escText(c.text))).join('') + `</${this.localName}>`
  }
  all(): MiniElement[] { return this.children.flatMap((c) => (c instanceof MiniElement ? [c, ...c.all()] : [])) }
}

export class MiniDocument {
  constructor(public documentElement: MiniElement) {}
  querySelectorAll(sel: string): MiniElement[] {
    const all = [this.documentElement, ...this.documentElement.all()]
    if (sel.trim() === '*') return all
    const names = new Set(sel.split(',').map((s) => s.trim().toLowerCase()))
    return all.filter((e) => names.has(e.localName.toLowerCase()))
  }
}

/** Parse a page (a full document or a fragment, which goes into <html><body>). */
export function parseMini(html: string): MiniDocument {
  const root = new MiniElement('html', HTML_NS)
  let cur = root
  let sawHtml = false
  let i = 0
  const n = html.length
  const textNode = (t: string) => { if (t) cur.children.push({ text: decode(t), parent: cur }) }
  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt < 0) { textNode(html.slice(i)); break }
    textNode(html.slice(i, lt))
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt); i = e < 0 ? n : e + 3; continue }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') { const e = html.indexOf('>', lt); i = e < 0 ? n : e + 1; continue }
    const m = /^<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/.exec(html.slice(lt))
    if (!m) { textNode('<'); i = lt + 1; continue }
    i = lt + m[0].length
    const svg = cur.namespaceURI === SVG_NS || m[2]!.toLowerCase() === 'svg'
    const name = svg ? m[2]! : m[2]!.toLowerCase()
    if (m[1]) {
      for (let e: MiniElement | null = cur; e; e = e.parent) if (e.localName.toLowerCase() === name.toLowerCase()) { cur = e.parent ?? root; break }
      continue
    }
    if (name === 'html' && !sawHtml) { sawHtml = true; addAttrs(root, m[3]!, false); continue }
    const el = new MiniElement(name, svg ? SVG_NS : HTML_NS)
    addAttrs(el, m[3]!, svg)
    el.parent = cur
    cur.children.push(el)
    if (RAW.has(name) && !svg) {
      const close = html.toLowerCase().indexOf(`</${name}`, i)
      const end = close < 0 ? n : close
      el.children.push({ text: html.slice(i, end), parent: el })
      i = close < 0 ? n : html.indexOf('>', close) + 1
      continue
    }
    if ((VOID.has(name) && !svg) || m[4]) continue
    cur = el
  }
  return new MiniDocument(root)
}

function addAttrs(el: MiniElement, src: string, svg: boolean) {
  for (const a of src.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const name = svg ? a[1]! : a[1]!.toLowerCase()
    if (!el.attrs.some((x) => x.name === name)) el.attrs.push(new MiniAttr(name, decode(a[2] ?? a[3] ?? a[4] ?? ''), el))
  }
}
