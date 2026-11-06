// A small DOM for unit tests that render components with react-dom/client and click them (bun has no DOM): nodes,
// attributes, a style object, value / checked properties React can track, events that capture and bubble, focus, and
// a form's submit from its submit button or requestSubmit. Installed only around the tests that use it
// (installDom / removeDom), so other tests keep seeing no `window`; mount() renders into it and clicks, types and waits
// inside act(). What it does not do: layout, CSS, selection (a text field keeps only its selectionStart and End), real
// navigation. The browser itself is covered by the e2e specs. Every test file starts from the same place whatever ran
// before it (test/unit/preload.ts: React DOM loaded with a document, fresh stores, the usual globals, no document left).
import { act, type ReactNode } from 'react'
const HTML_NS = 'http://www.w3.org/1999/xhtml'

type Listener = { fn: (e: FakeEvent) => void; capture: boolean; once: boolean }

export class FakeEvent {
  type: string
  bubbles: boolean
  cancelable: boolean
  defaultPrevented = false
  target: FakeNode | null = null
  currentTarget: FakeNode | null = null
  eventPhase = 0
  timeStamp = Date.now()
  isTrusted = true
  key?: string
  shiftKey = false
  keyCode = 0
  isComposing = false
  stopped = false
  immediate = false
  constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean; key?: string; shiftKey?: boolean } = {}) {
    this.type = type
    this.bubbles = init.bubbles ?? false
    this.cancelable = init.cancelable ?? false
    if (init.key !== undefined) this.key = init.key
    if (init.shiftKey) this.shiftKey = true
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true }
  stopPropagation() { this.stopped = true }
  stopImmediatePropagation() { this.stopped = true; this.immediate = true }
  composedPath() { const p: FakeNode[] = []; for (let n = this.target; n; n = n.parentNode) p.push(n); return p }
}

export class FakeNode {
  parentNode: FakeNode | null = null
  childNodes: FakeNode[] = []
  private listeners = new Map<string, Listener[]>()
  constructor(public nodeType: number, public nodeName: string, public ownerDocument: FakeDocument | null) {}
  get parentElement(): FakeElement | null { return this.parentNode instanceof FakeElement ? this.parentNode : null }
  get firstChild() { return this.childNodes[0] ?? null }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null }
  get nextSibling(): FakeNode | null { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) + 1] ?? null : null }
  get previousSibling(): FakeNode | null { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) - 1] ?? null : null }
  get isConnected(): boolean { let n: FakeNode | null = this; while (n.parentNode) n = n.parentNode; return n.nodeType === 9 }
  appendChild<T extends FakeNode>(c: T): T { return this.insertBefore(c, null) }
  insertBefore<T extends FakeNode>(c: T, ref: FakeNode | null): T {
    c.parentNode?.removeChild(c)
    const i = ref ? this.childNodes.indexOf(ref) : -1
    if (i < 0) this.childNodes.push(c)
    else this.childNodes.splice(i, 0, c)
    c.parentNode = this
    return c
  }
  removeChild<T extends FakeNode>(c: T): T {
    this.childNodes = this.childNodes.filter((x) => x !== c)
    c.parentNode = null
    return c
  }
  contains(n: FakeNode | null): boolean { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false }
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join('') }
  set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null
    this.childNodes = []
    if (v) this.appendChild(this.ownerDocument!.createTextNode(String(v)))
  }
  addEventListener(type: string, fn: ((e: FakeEvent) => void) | null, opts?: boolean | { capture?: boolean; once?: boolean }) {
    if (!fn) return
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture
    const l = this.listeners.get(type) ?? []
    if (!l.some((x) => x.fn === fn && x.capture === capture)) l.push({ fn, capture, once: typeof opts === 'object' && !!opts?.once })
    this.listeners.set(type, l)
  }
  removeEventListener(type: string, fn: (e: FakeEvent) => void, opts?: boolean | { capture?: boolean }) {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((x) => !(x.fn === fn && x.capture === capture)))
  }
  /** listeners of this node for one phase */
  fire(e: FakeEvent, capture: boolean) {
    for (const l of [...(this.listeners.get(e.type) ?? [])]) {
      if (l.capture !== capture) continue
      if (l.once) this.removeEventListener(e.type, l.fn, { capture })
      l.fn.call(this, e)
      if (e.immediate) return
    }
  }
  dispatchEvent(e: FakeEvent): boolean {
    e.target = this
    const path: FakeNode[] = []
    for (let n: FakeNode | null = this; n; n = n.parentNode) path.push(n)
    const doc = this.nodeType === 9 ? (this as unknown as FakeDocument) : this.ownerDocument
    if (doc && this !== doc.windowNode && path[path.length - 1] === doc) path.push(doc.windowNode)
    for (let i = path.length - 1; i > 0 && !e.stopped; i--) { e.eventPhase = 1; e.currentTarget = path[i]!; path[i]!.fire(e, true) }
    if (!e.stopped) { e.eventPhase = 2; e.currentTarget = this; this.fire(e, true); if (!e.stopped) this.fire(e, false) }
    if (e.bubbles) for (let i = 1; i < path.length && !e.stopped; i++) { e.eventPhase = 3; e.currentTarget = path[i]!; path[i]!.fire(e, false) }
    e.currentTarget = null
    e.eventPhase = 0
    return !e.defaultPrevented
  }
}

export class FakeText extends FakeNode {
  constructor(public data: string, doc: FakeDocument) { super(3, '#text', doc) }
  get nodeValue() { return this.data }
  set nodeValue(v: string) { this.data = v }
  override get textContent() { return this.data }
  override set textContent(v: string) { this.data = v }
}

const styleObject = () => {
  const s: Record<string, unknown> = {}
  Object.defineProperties(s, {
    setProperty: { value: (k: string, v: string) => { s[k] = v }, enumerable: false },
    removeProperty: { value: (k: string) => { delete s[k] }, enumerable: false },
    getPropertyValue: { value: (k: string) => (s[k] as string) ?? '', enumerable: false },
  })
  return s
}

export class FakeElement extends FakeNode {
  attributes: Map<string, string> = new Map()
  style = styleObject()
  readonly localName: string
  readonly tagName: string
  constructor(name: string, public namespaceURI: string, doc: FakeDocument) {
    super(1, namespaceURI === HTML_NS ? name.toUpperCase() : name, doc)
    this.localName = name
    this.tagName = this.nodeName
  }
  get children(): FakeElement[] { return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement) }
  getAttribute(n: string) { return this.attributes.get(n.toLowerCase()) ?? null }
  hasAttribute(n: string) { return this.attributes.has(n.toLowerCase()) }
  setAttribute(n: string, v: unknown) { this.attributes.set(n.toLowerCase(), String(v)) }
  removeAttribute(n: string) { this.attributes.delete(n.toLowerCase()) }
  setAttributeNS(_ns: string | null, n: string, v: unknown) { this.setAttribute(n, v) }
  removeAttributeNS(_ns: string | null, n: string) { this.removeAttribute(n) }
  // React's old-browser change detection (not used once 'oninput' is known, but harmless)
  attachEvent() {}
  detachEvent() {}
  get id() { return this.getAttribute('id') ?? '' }
  get className() { return this.getAttribute('class') ?? '' }
  get disabled() { return this.hasAttribute('disabled') }
  set disabled(v: boolean) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled') }
  get type() { return this.getAttribute('type') ?? (this.localName === 'button' ? 'submit' : this.localName === 'input' ? 'text' : '') }
  set type(v: string) { this.setAttribute('type', v) }
  /** a <select>'s options: React picks the chosen one through them (updateOptions) */
  get options(): FakeElement[] | undefined { return this.localName === 'select' ? this.querySelectorAll('option') : undefined }
  get form(): FakeElement | null { for (let n = this.parentNode; n; n = n.parentNode) if (n instanceof FakeElement && n.localName === 'form') return n; return null }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this }
  blur() { if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body }
  scrollIntoView() {}
  /** a text field's selection (no layout: only where it is) */
  setSelectionRange(start: number, end: number) { Object.assign(this, { selectionStart: start, selectionEnd: end }) }
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 } }
  get scrollHeight() { return 0 }
  get clientHeight() { return 0 }
  matches(sel: string) { return matches(this, sel) }
  closest(sel: string): FakeElement | null { for (let n: FakeNode | null = this; n; n = n.parentNode) if (n instanceof FakeElement && matches(n, sel)) return n; return null }
  querySelectorAll(sel: string): FakeElement[] { return all(this).filter((e) => sel.split(',').some((s) => matches(e, s.trim()))) }
  querySelector(sel: string): FakeElement | null { return this.querySelectorAll(sel)[0] ?? null }
  get innerHTML(): string { return this.childNodes.map(html).join('') }
  set innerHTML(v: string) { this.textContent = v }
  get outerHTML(): string { return html(this) }
  /** what a click does in a browser besides its listeners: a submit button submits its form */
  click() {
    if (this.disabled) return
    // the click's user activation lasts while its handlers run, not after an await (a browser blocks a popup then)
    activation++
    try {
      const ok = this.dispatchEvent(new FakeEvent('click', { bubbles: true, cancelable: true }))
      if (ok && this.localName === 'button' && this.type === 'submit') this.form?.requestSubmit()
    } finally { activation-- }
  }
  requestSubmit() { this.dispatchEvent(new FakeEvent('submit', { bubbles: true, cancelable: true })) }
}

/** value and checked as properties on the prototype, so React's value tracker can wrap them */
for (const [prop, attr] of [['value', 'value'], ['checked', 'checked']] as const) {
  const store = new WeakMap<FakeElement, unknown>()
  Object.defineProperty(FakeElement.prototype, prop, {
    configurable: true,
    get(this: FakeElement) { return store.has(this) ? store.get(this) : prop === 'checked' ? this.hasAttribute(attr) : this.getAttribute(attr) ?? '' },
    set(this: FakeElement, v: unknown) { store.set(this, prop === 'checked' ? !!v : String(v)) },
  })
}
for (const prop of ['defaultValue', 'defaultChecked', 'multiple', 'selected', 'name', 'placeholder', 'tabIndex', 'htmlFor', 'autofocus', 'selectionStart', 'selectionEnd']) {
  if (!(prop in FakeElement.prototype)) Object.defineProperty(FakeElement.prototype, prop, { configurable: true, writable: true, value: undefined })
}

function all(root: FakeNode): FakeElement[] {
  return root.childNodes.flatMap((c) => (c instanceof FakeElement ? [c, ...all(c)] : []))
}
/** tag, [attr], [attr="v"], tag[attr="v"] */
function matches(e: FakeElement, sel: string): boolean {
  const m = /^([a-zA-Z0-9-]*)((?:\[[^\]]+\])*)$/.exec(sel.trim())
  if (!m) return false
  if (m[1] && e.localName !== m[1].toLowerCase()) return false
  for (const a of m[2]!.matchAll(/\[([^\]=~^$*]+)(?:="([^"]*)")?\]/g)) {
    const v = e.getAttribute(a[1]!)
    if (v === null || (a[2] !== undefined && v !== a[2])) return false
  }
  return true
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function html(n: FakeNode): string {
  if (n instanceof FakeText) return esc(n.data)
  if (!(n instanceof FakeElement)) return ''
  return `<${n.localName}${[...n.attributes].map(([k, v]) => ` ${k}="${esc(v).replace(/"/g, '&quot;')}"`).join('')}>${n.childNodes.map(html).join('')}</${n.localName}>`
}

export class FakeDocument extends FakeNode {
  documentElement: FakeElement
  body: FakeElement
  head: FakeElement
  activeElement: FakeElement | null = null
  defaultView: unknown = null
  // React asks whether 'oninput' is a known event before it listens for input
  oninput = null
  /** the window's listeners */
  readonly windowNode: FakeNode
  constructor() {
    super(9, '#document', null)
    this.ownerDocument = null
    this.windowNode = new FakeNode(0, '#window', this)
    this.documentElement = this.createElement('html')
    this.head = this.createElement('head')
    this.body = this.createElement('body')
    this.appendChild(this.documentElement)
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
    this.activeElement = this.body
  }
  createElement(name: string) { return new FakeElement(name.toLowerCase(), HTML_NS, this) }
  createElementNS(ns: string, name: string) { return new FakeElement(name, ns, this) }
  createTextNode(data: string) { return new FakeText(data, this) }
  createComment(data: string) { const c = new FakeText(data, this); c.nodeType = 8; c.nodeName = '#comment'; return c }
  getElementById(id: string) { return all(this).find((e) => e.id === id) ?? null }
  querySelectorAll(sel: string) { return this.documentElement.querySelectorAll(sel) }
  querySelector(sel: string) { return this.documentElement.querySelector(sel) }
  hasFocus() { return true }
}

/** > 0 while a click is being handled (FakeElement.click) */
let activation = 0

export interface FakeWindowHandle { opened: { url: string; closed: boolean; replaced: string[] }[]; blocked: string[] }

let saved: Map<string, PropertyDescriptor | undefined> | null = null

function memoryStorage() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size } }
}

/** Put a document and a window on globalThis (the window is globalThis itself, as in a browser); removeDom puts back
 * what was there. `opened`: the windows window.open made. */
export function installDom(): FakeWindowHandle & { document: FakeDocument } {
  if (saved) throw new Error('installDom twice')
  const was = new Map<string, PropertyDescriptor | undefined>()
  saved = was
  const set = (k: string, v: unknown) => {
    if (!was.has(k)) was.set(k, Object.getOwnPropertyDescriptor(globalThis, k))
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v })
  }
  const doc = new FakeDocument()
  const handle: FakeWindowHandle = { opened: [], blocked: [] }
  // listeners on the window live on a node of their own; events reach it after the document
  const win = doc.windowNode
  set('addEventListener', win.addEventListener.bind(win))
  set('removeEventListener', win.removeEventListener.bind(win))
  set('dispatchEvent', win.dispatchEvent.bind(win))
  set('document', doc)
  set('HTMLElement', FakeElement)
  set('HTMLIFrameElement', class HTMLIFrameElement extends FakeElement {})
  set('Element', FakeElement)
  set('Node', FakeNode)
  set('Text', FakeText)
  set('Event', FakeEvent)
  set('KeyboardEvent', FakeEvent)
  set('MouseEvent', FakeEvent)
  set('requestAnimationFrame', (f: (t: number) => void) => setTimeout(() => f(Date.now()), 0))
  set('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id))
  set('localStorage', memoryStorage())
  set('sessionStorage', memoryStorage())
  set('isSecureContext', true)
  set('IS_REACT_ACT_ENVIRONMENT', true)
  set('top', globalThis)
  set('self', globalThis)
  set('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  set('getComputedStyle', () => ({ getPropertyValue: () => '' }))
  set('scrollTo', () => {})
  set('getSelection', () => ({ rangeCount: 0, anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, removeAllRanges() {}, addRange() {} }))
  set('open', (url: string) => {
    // outside a click (after an await, say) a browser blocks the popup and window.open returns null
    if (!activation) { handle.blocked.push(url); return null }
    const rec = { url, closed: false, replaced: [] as string[] }
    handle.opened.push(rec)
    return { get closed() { return rec.closed }, close() { rec.closed = true }, opener: null, location: { replace(u: string) { rec.replaced.push(u) } } }
  })
  set('window', globalThis)
  doc.defaultView = globalThis
  return Object.assign(handle, { document: doc })
}

/** Is a fake document installed now (test/unit/preload.ts takes away one a file left behind)? */
export const domInstalled = () => saved !== null

/** React roots mounted and not unmounted yet: removeDom unmounts them, so a component a test left behind (one that timed
 * out, say) stops its effects and timers before the next test or file */
const roots = new Set<{ unmount(): void }>()

export function removeDom() {
  if (!saved) return
  for (const r of [...roots]) {
    roots.delete(r)
    try { act(() => r.unmount()) } catch { /* its document is going anyway */ }
  }
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(globalThis, k, d)
    else delete (globalThis as Record<string, unknown>)[k]
  }
  saved = null
}

/** A component rendered into the fake document (installDom first), and what a person does with it. */
export interface Mounted {
  container: FakeElement
  /** the first element with this data-testid, or null */
  find(testId: string): FakeElement | null
  /** the same, or a failure that shows the page */
  get(testId: string): FakeElement
  click(el: string | FakeElement): Promise<void>
  /** replace the text of an input or textarea, as typing does */
  type(el: string | FakeElement, text: string): Promise<void>
  /** the rendered page, for a failure message */
  html(): string
  /** wait (letting effects, timers and fetches run) until `fn` gives something truthy; at most `ms`, 4 s by default:
   * less than bun's 5 s for a test, so a wait that fails ends inside its test (which then cleans up) and not after it,
   * running on into the next one */
  until<T>(fn: () => T | null | undefined | false, what: string, ms?: number): Promise<T>
  /** let pending work run for `ms` */
  settle(ms?: number): Promise<void>
  unmount(): Promise<void>
}

/** how long until() waits by default (see Mounted.until) */
const UNTIL_MS = 4000

export async function mount(ui: ReactNode): Promise<Mounted> {
  const doc = globalThis.document as unknown as FakeDocument
  if (!(doc instanceof FakeDocument)) throw new Error('installDom first')
  const { createRoot } = await import('react-dom/client')
  const container = doc.createElement('div')
  doc.body.appendChild(container)
  const root = createRoot(container as unknown as Element)
  roots.add(root)
  await act(async () => root.render(ui))
  // the whole body, not only the container: a dialog (ui.tsx Modal) is rendered into <body> through a portal
  const find = (id: string) => doc.body.querySelector(`[data-testid="${id}"]`)
  const el = (x: string | FakeElement) => {
    if (typeof x !== 'string') return x
    const e = find(x)
    if (!e) throw new Error(`no [data-testid="${x}"] in ${doc.body.innerHTML}`)
    return e
  }
  const settle = (ms = 20) => act(async () => { await new Promise((r) => setTimeout(r, ms)) })
  return {
    container,
    find,
    get: el,
    click: async (x) => { const e = el(x); await act(async () => e.click()) },
    type: async (x, text) => {
      const e = el(x)
      await act(async () => {
        e.dispatchEvent(new FakeEvent('focusin', { bubbles: true }))
        Object.getOwnPropertyDescriptor(FakeElement.prototype, 'value')!.set!.call(e, text)
        e.dispatchEvent(new FakeEvent('input', { bubbles: true }))
        // the change detection React uses when it was loaded before this document existed
        e.dispatchEvent(new FakeEvent('keyup', { bubbles: true }))
      })
    },
    html: () => doc.body.innerHTML,
    settle,
    until: async (fn, what, ms = UNTIL_MS) => {
      const end = Date.now() + ms
      for (;;) {
        const v = fn()
        if (v) return v as never
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${doc.body.innerHTML}`)
        await settle()
      }
    },
    unmount: async () => {
      if (!roots.delete(root)) return
      await act(async () => root.unmount())
      container.parentNode?.removeChild(container)
    },
  }
}
