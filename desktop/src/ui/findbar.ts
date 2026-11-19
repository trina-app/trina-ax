// The find bar (Cmd/Ctrl+F, Edit › Find…): one field, the "N of M" count, previous / next and ✕, drawn in its own small
// view over the top-right corner of the page it searches (main/find-bar.ts). Enter / Cmd+G: the next match;
// Shift+Enter / Shift+Cmd+G: the one before; Esc or ✕: close (common/find-bar.ts findKey).
import { findCount, findKey, type FindResult } from '../common/find-bar'
import { h, onLocaleChange, tr, ui } from './dom'

const root = document.getElementById('root')!
const mac = navigator.platform.toLowerCase().startsWith('mac')
let text = ''
let result: FindResult | null = null
let seq = -1

const SVG = 'http://www.w3.org/2000/svg'
function chevron(up: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('aria-hidden', 'true')
  const p = document.createElementNS(SVG, 'path')
  p.setAttribute('d', up ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4')
  svg.append(p)
  return svg
}
function cross(): SVGSVGElement {
  const svg = chevron(true)
  svg.firstElementChild!.setAttribute('d', 'M4.5 4.5l7 7M11.5 4.5l-7 7')
  return svg
}

const input = h('input', {
  type: 'text',
  class: 'find-field',
  spellcheck: 'false',
  autocomplete: 'off',
  'data-testid': 'find-field',
}) as HTMLInputElement
const count = h('span', { class: 'find-count', role: 'status', 'aria-live': 'polite', 'data-testid': 'find-count' })
const prev = h('button', { type: 'button', class: 'find-btn', 'data-testid': 'find-prev', onclick: () => step(false) }, chevron(true))
const next = h('button', { type: 'button', class: 'find-btn', 'data-testid': 'find-next', onclick: () => step(true) }, chevron(false))
const close = h('button', { type: 'button', class: 'find-btn', 'data-testid': 'find-close', onclick: () => ui.find.close() }, cross())

function step(forward: boolean) {
  if (text) ui.find.step(forward)
  input.focus()
}

function render() {
  input.setAttribute('aria-label', tr('find.label'))
  input.placeholder = tr('find.label')
  for (const [b, k] of [[prev, 'find.prev'], [next, 'find.next'], [close, 'find.close']] as const) {
    b.setAttribute('aria-label', tr(k))
    b.title = tr(k)
  }
  const c = findCount(text, result)
  count.textContent = c.kind === 'count' ? tr('find.count', { n: String(c.n), m: String(c.m) }) : c.kind === 'none' ? tr('find.none') : ''
  count.dataset.kind = c.kind
  const none = c.kind !== 'count'
  prev.disabled = none
  next.disabled = none
}

input.addEventListener('input', () => {
  if (input.value === text) return
  text = input.value
  result = null
  ui.find.query(text)
  render()
})
input.addEventListener('keydown', (e) => {
  const k = findKey({ key: e.key, shift: e.shiftKey, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, mac, composing: e.isComposing })
  if (!k) return
  e.preventDefault()
  if (k === 'close') ui.find.close()
  else step(k === 'next')
})
// the view got the keyboard (Cmd+F again, the window back): it goes to the field
window.addEventListener('focus', () => input.focus())

function opened(o: { text: string; seq: number }) {
  if (o.seq === seq) return
  seq = o.seq
  // another text (the selection): its count comes back from the main process
  if (o.text !== text) result = null
  input.value = o.text
  text = o.text
  input.focus()
  input.select()
  render()
}

ui.find.onOpen(opened)
ui.find.onResult((r) => {
  result = r
  render()
})
onLocaleChange(render)
void ui.find.state().then((s) => {
  if (!s) return
  result = s.result
  if (s.seq > 0) opened(s)
  else render()
})

root.replaceChildren(h('div', { class: 'find-card', role: 'search', 'data-testid': 'find-bar' }, input, count, h('span', { class: 'find-sep', 'aria-hidden': 'true' }), prev, next, close))
render()
