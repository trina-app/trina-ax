// The shared tooltip (components/Tooltip.tsx): after 300 ms of a mouse resting on the element, at once on keyboard focus
// (not the focus a click gives); gone on leave, a click, blur and Esc; never for a finger or on a device without a fine
// pointer, nor while the element's own menu is open, nor while the element shows the same words; described by it only
// when it says more than the element's name; placed above, below when there is no room, inside the window. IconButton
// and CopyButton bring it along.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { placeTip, Tooltip, TOOLTIP_DELAY_MS } from '../../src/components/Tooltip'
import { CopyButton, IconButton } from '../../src/components/ui'
import { t as tr } from '../../src/i18n'
import { FakeEvent, installDom, mount, removeDom } from './dom-host'

const media = (fine: boolean) => {
  ;(window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = (q: string) => ({ matches: fine && q.includes('fine'), addEventListener() {}, removeEventListener() {} } as never)
}
beforeAll(() => installDom())
afterEach(() => media(false))
afterAll(() => removeDom())

const fire = (el: unknown, type: string, o: Record<string, unknown> = {}) => (el as { dispatchEvent: (e: unknown) => void }).dispatchEvent(Object.assign(new FakeEvent(type, { bubbles: true, cancelable: true }), o))
const tip = () => document.body.querySelector('[role="tooltip"]')

test('a mouse resting on it shows the tip after the delay; leaving, a click or Esc takes it away', async () => {
  media(true)
  const m = await mount(<Tooltip label="반응 추가"><button aria-label="반응 추가" data-testid="b">+</button></Tooltip>)
  try {
    const b = m.get('b')
    fire(b, 'pointerover', { pointerType: 'mouse', relatedTarget: null })
    await m.settle(TOOLTIP_DELAY_MS / 3)
    expect(tip()).toBeNull()
    await m.settle(TOOLTIP_DELAY_MS)
    expect(tip()?.textContent).toBe('반응 추가')
    // the same words as its name: the visible tip is enough, nothing more to describe
    expect(b.getAttribute('aria-describedby')).toBeNull()
    fire(b, 'pointerout', { pointerType: 'mouse', relatedTarget: null })
    await m.settle(10)
    expect(tip()).toBeNull()
    // back on it, then a click: gone
    fire(b, 'pointerover', { pointerType: 'mouse', relatedTarget: null })
    await m.settle(TOOLTIP_DELAY_MS + 50)
    expect(tip()).not.toBeNull()
    fire(b, 'pointerdown', { pointerType: 'mouse' })
    await m.settle(10)
    expect(tip()).toBeNull()
    // and Esc
    fire(b, 'pointerover', { pointerType: 'mouse', relatedTarget: null })
    await m.settle(TOOLTIP_DELAY_MS + 50)
    expect(tip()).not.toBeNull()
    fire(b, 'keydown', { key: 'Escape' })
    await m.settle(10)
    expect(tip()).toBeNull()
  } finally { await m.unmount() }
})

test('keyboard focus shows it at once and blur hides it; a tip that says more than the name describes the element', async () => {
  media(true)
  const m = await mount(<Tooltip label="⌘K로 열기"><button aria-label="검색" data-testid="b">S</button></Tooltip>)
  try {
    const b = m.get('b')
    fire(b, 'focusin')
    await m.settle(10)
    const t = tip()!
    expect(t.textContent).toBe('⌘K로 열기')
    expect(b.getAttribute('aria-describedby')).toBe(t.getAttribute('id'))
    fire(b, 'focusout')
    await m.settle(10)
    expect(tip()).toBeNull()
    expect(b.getAttribute('aria-describedby')).toBeNull()
  } finally { await m.unmount() }
})

test('never for a finger, never on a device without a fine pointer, never while its own menu is open', async () => {
  media(true)
  let m = await mount(<Tooltip label="더 보기"><button aria-label="더 보기" data-testid="b">⋮</button></Tooltip>)
  try {
    fire(m.get('b'), 'pointerover', { pointerType: 'touch', relatedTarget: null })
    await m.settle(TOOLTIP_DELAY_MS + 50)
    expect(tip()).toBeNull()
  } finally { await m.unmount() }
  media(false)
  m = await mount(<Tooltip label="더 보기"><button aria-label="더 보기" data-testid="b">⋮</button></Tooltip>)
  try {
    fire(m.get('b'), 'pointerover', { pointerType: 'mouse', relatedTarget: null })
    fire(m.get('b'), 'focusin')
    await m.settle(TOOLTIP_DELAY_MS + 50)
    expect(tip()).toBeNull()
  } finally { await m.unmount() }
  media(true)
  m = await mount(<Tooltip label="더 보기"><button aria-label="더 보기" aria-expanded="true" data-testid="b">⋮</button></Tooltip>)
  try {
    fire(m.get('b'), 'focusin')
    await m.settle(10)
    expect(tip()).toBeNull()
  } finally { await m.unmount() }
})

test("IconButton: its name is its tooltip, never the browser's title; tip=\"…\" says more; the element keeps its own handlers", async () => {
  media(true)
  let clicks = 0
  let m = await mount(<IconButton label="닫기" onClick={() => clicks++} data-testid="b">x</IconButton>)
  try {
    const b = m.get('b')
    expect(b.getAttribute('title')).toBeNull()
    expect(b.getAttribute('aria-label')).toBe('닫기')
    fire(b, 'focusin')
    await m.settle(10)
    expect(tip()?.textContent).toBe('닫기')
    // its own name: nothing more to describe
    expect(b.getAttribute('aria-describedby')).toBeNull()
    await m.click('b')
    expect(clicks).toBe(1)
  } finally { await m.unmount() }
  // other words: they show, and describe the button
  m = await mount(<IconButton label="잠김" tip="읽기 전용: 볼 수만 있어요" data-testid="b">x</IconButton>)
  try {
    const b = m.get('b')
    fire(b, 'focusin')
    await m.settle(10)
    expect(tip()?.textContent).toBe('읽기 전용: 볼 수만 있어요')
    expect(b.getAttribute('aria-describedby')).toBe(tip()!.getAttribute('id'))
  } finally { await m.unmount() }
  // tip={false}: inside a <Tooltip> of its own, one tip and no title
  m = await mount(<Tooltip label="⌘K로 열기"><IconButton tip={false} label="검색" data-testid="b">S</IconButton></Tooltip>)
  try {
    const b = m.get('b')
    expect(b.getAttribute('title')).toBeNull()
    fire(b, 'focusin')
    await m.settle(10)
    expect(document.body.querySelectorAll('[role="tooltip"]').length).toBe(1)
    expect(tip()?.textContent).toBe('⌘K로 열기')
  } finally { await m.unmount() }
})

test("CopyButton: the icon alone has the tooltip (\"복사됨\" for a moment after a copy from the keyboard); with its words shown, none", async () => {
  media(true)
  const nav = globalThis.navigator as unknown as { clipboard?: unknown }
  const had = nav.clipboard
  Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText: async () => {}, write: async () => {} }, configurable: true })
  let m = await mount(<CopyButton text="hello" />)
  try {
    const b = m.container.querySelector('button')!
    expect(b.getAttribute('title')).toBeNull()
    fire(b, 'focusin')
    await m.settle(10)
    expect(tip()?.textContent).toBe(tr('common.copy'))
    // Enter on it (a click without a pointer): the tip stays and says it is done
    await m.click(b)
    await m.until(() => tip()?.textContent === tr('common.copied'), 'the copied tip')
    // and back after 1.5 s (no timer left running past the test)
    await m.until(() => tip()?.textContent === tr('common.copy'), 'the tip back to copy', 3000)
  } finally { await m.unmount() }
  m = await mount(<CopyButton text="hello" showLabel />)
  try {
    const b = m.container.querySelector('button')!
    expect(b.getAttribute('title')).toBeNull()
    fire(b, 'focusin')
    await m.settle(10)
    expect(tip()).toBeNull()
  } finally {
    await m.unmount()
    Object.defineProperty(globalThis.navigator, 'clipboard', { value: had, configurable: true })
  }
})

test('focus from a click, or a dialog focusing its first button after a click opened it, shows no tip: only keyboard focus (:focus-visible) does', async () => {
  media(true)
  const css = (globalThis as { CSS?: unknown }).CSS
  ;(globalThis as { CSS?: unknown }).CSS = { supports: (q: string) => q.includes('focus-visible') }
  const m = await mount(<Tooltip label="닫기"><button aria-label="닫기" data-testid="b">x</button></Tooltip>)
  try {
    const b = m.get('b') as unknown as { matches: (s: string) => boolean }
    let visible = false
    const own = b.matches.bind(b)
    b.matches = (sel: string) => (sel === ':focus-visible' ? visible : own(sel))
    fire(b, 'focusin')
    await m.settle(10)
    expect(tip()).toBeNull()
    fire(b, 'focusout')
    visible = true
    fire(b, 'focusin')
    await m.settle(10)
    expect(tip()?.textContent).toBe('닫기')
  } finally {
    await m.unmount()
    ;(globalThis as { CSS?: unknown }).CSS = css
  }
})

test('no tip while the element shows the same words; it comes when a narrow window hides them', async () => {
  media(true)
  const m = await mount(
    <Tooltip label="업로드">
      <button aria-label="업로드" data-testid="b">
        <svg aria-hidden /> <span data-testid="words">업로드</span>
      </button>
    </Tooltip>,
  )
  try {
    const b = m.get('b')
    const words = m.get('words') as unknown as { getClientRects: () => unknown[] }
    // drawn: a box on the page
    words.getClientRects = () => [{}]
    fire(b, 'pointerover', { pointerType: 'mouse', relatedTarget: null })
    await m.settle(TOOLTIP_DELAY_MS + 50)
    expect(tip()).toBeNull()
    fire(b, 'pointerout', { pointerType: 'mouse', relatedTarget: null })
    // display: none (`@max-2xl:hidden`): no box
    words.getClientRects = () => []
    fire(b, 'pointerover', { pointerType: 'mouse', relatedTarget: null })
    await m.settle(TOOLTIP_DELAY_MS + 50)
    expect(tip()?.textContent).toBe('업로드')
  } finally { await m.unmount() }
})

test('placed above and centred; below when there is no room above; never outside the window', () => {
  const view = { width: 1000, height: 800 }
  expect(placeTip({ top: 100, bottom: 128, left: 500, width: 28 }, { width: 80, height: 24 }, view)).toEqual({ top: 70, left: 474, below: false })
  expect(placeTip({ top: 10, bottom: 38, left: 500, width: 28 }, { width: 80, height: 24 }, view)).toEqual({ top: 44, left: 474, below: true })
  expect(placeTip({ top: 100, bottom: 128, left: 985, width: 10 }, { width: 80, height: 24 }, view).left).toBe(916)
  expect(placeTip({ top: 100, bottom: 128, left: 0, width: 10 }, { width: 80, height: 24 }, view).left).toBe(4)
})
