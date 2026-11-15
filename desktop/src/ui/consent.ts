// The app's own "Find work files on this computer" question (main/work-consent-window.ts opens it; the words and the
// places come finished from the main process, common/work-consent.ts). This page only draws them and says yes or no
// through its preload (preload/consent.ts); the main process decides whether a yes counts (ConsentGate).
import type { ConsentIcon, ConsentView } from '../common/work-consent'

const api = (window as unknown as { trinaConsent: { view(): ConsentView | null; answer(yes: boolean): void } }).trinaConsent

const NS = 'http://www.w3.org/2000/svg'
/** 16px line icons, drawn for this window (currentColor) */
const PATHS: Record<ConsentIcon | 'check' | 'ai' | 'mark' | 'upload', string[]> = {
  documents: ['M2.5 4.5a1.5 1.5 0 0 1 1.5-1.5h2.6l1.4 1.6H12a1.5 1.5 0 0 1 1.5 1.5v5.4A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5z', 'M5.5 8.5h5', 'M5.5 10.5h3'],
  desktop: ['M2.5 4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z', 'M6 13.5h4', 'M8 11v2.5'],
  downloads: ['M8 2.5v7', 'M5 6.8 8 9.8l3-3', 'M3 11.5v.5A1.5 1.5 0 0 0 4.5 13.5h7A1.5 1.5 0 0 0 13 12v-.5'],
  folder: ['M2.5 4.5a1.5 1.5 0 0 1 1.5-1.5h2.6l1.4 1.6H12a1.5 1.5 0 0 1 1.5 1.5v5.4A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5z'],
  cloud: ['M4.6 12.5a2.6 2.6 0 0 1-.4-5.2 3.6 3.6 0 0 1 7-1A2.9 2.9 0 0 1 11.4 12.5z'],
  messenger: ['M2.5 7.5c0-2.5 2.5-4.5 5.5-4.5s5.5 2 5.5 4.5S11 12 8 12c-.7 0-1.4-.1-2-.3L3 13l.8-2.4C3 9.8 2.5 8.7 2.5 7.5z'],
  recent: ['M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z', 'M8 5v3.2l2.2 1.4'],
  file: ['M4.5 2.5h4.6l2.9 2.9v7.1a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z', 'M9 2.5V5.5h3'],
  upload: ['M3 7.5a2 2 0 0 1 2-2h4.2l2 2.2H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M12 17v-6', 'M9.5 13.5 12 11l2.5 2.5'],
  check: ['M3.5 8.5 6.5 11.5 12.5 4.5'],
  ai: ['M8 2.5c.4 2.6 1.4 3.6 4 4-2.6.4-3.6 1.4-4 4-.4-2.6-1.4-3.6-4-4 2.6-.4 3.6-1.4 4-4z', 'M12.3 10.5c.15.9.5 1.25 1.4 1.4-.9.15-1.25.5-1.4 1.4-.15-.9-.5-1.25-1.4-1.4.9-.15 1.25-.5 1.4-1.4z'],
  mark: ['M3 7.5a2 2 0 0 1 2-2h4.2l2 2.2H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M13.5 11.5l.75 1.75 1.75.75-1.75.75-.75 1.75-.75-1.75L11 14l1.75-.75z'],
}
function icon(name: keyof typeof PATHS, size = 16): SVGSVGElement {
  const s = document.createElementNS(NS, 'svg')
  const box = name === 'mark' || name === 'upload' ? 24 : 16
  s.setAttribute('viewBox', `0 0 ${box} ${box}`)
  s.setAttribute('width', String(size))
  s.setAttribute('height', String(size))
  s.setAttribute('aria-hidden', 'true')
  s.setAttribute('class', `ic ic-${name}`)
  for (const d of PATHS[name]) {
    const p = document.createElementNS(NS, 'path')
    p.setAttribute('d', d)
    s.append(p)
  }
  return s
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  e.append(...kids)
  return e
}

function render(v: ConsentView) {
  document.documentElement.lang = v.locale
  document.title = v.title
  const root = document.getElementById('root')!
  const title = el('h1', 'consent-title', v.title)
  title.id = 'consent-title'
  const sub = el('p', 'consent-sub', v.sub)
  sub.id = 'consent-sub'
  const head = el('header', 'consent-head', el('div', 'consent-mark', icon(v.kind === 'add' ? 'upload' : 'mark', 26)), el('div', 'consent-head-text', title, sub))

  const list = el('ul', 'consent-places')
  list.setAttribute('aria-label', v.placesLabel)
  for (const p of v.places) {
    const name = el('span', 'consent-place-name', p.name)
    name.title = p.name
    const text = el('span', 'consent-place-text', name)
    if (p.note) text.append(el('span', 'consent-place-note', p.note))
    const li = el('li', 'consent-place', icon(p.icon), text)
    li.dataset.testid = 'consent-place'
    list.append(li)
  }
  const more = v.more ? el('p', 'consent-more', v.more) : null
  const promises = v.promises.length ? el('ul', 'consent-promises') : null
  for (const x of v.promises) promises!.append(el('li', `consent-promise is-${x.icon}`, icon(x.icon), el('span', '', x.text)))
  const fine = v.fine ? el('p', 'consent-fine', v.fine) : null

  const no = el('button', 'consent-no', v.no)
  no.type = 'button'
  no.dataset.testid = 'consent-no'
  no.addEventListener('click', () => api.answer(false))
  const yes = el('button', 'primary consent-yes', v.yes)
  yes.type = 'button'
  yes.dataset.testid = 'consent-yes'
  yes.addEventListener('click', () => api.answer(true))
  const foot = el('footer', 'consent-foot', no, yes)

  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-labelledby', 'consent-title')
  // the Add window: the files' names are read with the question (focus lands on the button, past the list)
  list.id = 'consent-places'
  root.setAttribute('aria-describedby', v.kind === 'add' ? 'consent-sub consent-places' : 'consent-sub')
  root.replaceChildren(head, el('div', 'consent-body-scroll', ...([list, more, promises, fine] as (HTMLElement | null)[]).filter((x): x is HTMLElement => !!x)), foot)
  yes.focus()
  // a smaller app window: the words scroll, and the buttons get a line above them so it shows there is more
  const scroller = root.querySelector('.consent-body-scroll')!
  const edge = () => foot.classList.toggle('is-over', scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 1)
  scroller.addEventListener('scroll', edge)
  addEventListener('resize', edge)
  requestAnimationFrame(edge)
}

addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    api.answer(false)
  }
})
const view = api?.view()
if (view) render(view)
