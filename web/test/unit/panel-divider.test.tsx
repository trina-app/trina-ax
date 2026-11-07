// The panel divider itself (components/PanelDivider.tsx), rendered into the small test DOM with a pretend layout: a row
// of 1160 px shared by a column and the panel, the panel 440 px wide unless `--panel-w` says otherwise. The keys set and
// remember the width, a double-click forgets it, a remembered width comes back within the limits of the window there is
// now, and nothing breaks without a ResizeObserver (the test DOM has none). Drag and the real layout: e2e
// thread-resize.spec.ts and preview-resize.spec.ts.
import { act } from 'react'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { PanelDivider } from '../../src/components/PanelDivider'
import { THREAD_PANEL } from '../../src/lib/panelWidth'
import { FakeEvent, installDom, mount, removeDom, type FakeElement, type Mounted } from './dom-host'

beforeAll(() => { installDom() })
afterEach(() => localStorage.clear())
afterAll(() => removeDom())

const DEFAULT = 440
let row = 1160

/** The panel's width as a browser would lay it out: `--panel-w` when set, else its default; the column takes the rest. */
function layout(m: Mounted) {
  const box = m.get('box')
  const col = m.get('col')
  const w = () => { const v = (box.style as Record<string, string>)['--panel-w']; return v ? parseInt(v, 10) : DEFAULT }
  Object.defineProperty(box, 'offsetWidth', { configurable: true, get: w })
  Object.defineProperty(col, 'offsetWidth', { configurable: true, get: () => row - w() })
  Object.defineProperty(box, 'previousElementSibling', { configurable: true, value: col })
  return { box, width: w }
}

async function open() {
  const m = await mount(
    <div data-testid="row">
      <div data-testid="col" />
      <div data-testid="box">
        <PanelDivider sizing={THREAD_PANEL} label="Resize the thread" testId="divider" overlayTestId="overlay" />
      </div>
    </div>,
  )
  const l = layout(m)
  // the window "resizes": the divider measures the row again
  const resize = () => act(async () => { window.dispatchEvent(new FakeEvent('resize') as unknown as Event) })
  await resize()
  return { m, ...l, resize, divider: m.get('divider') }
}

const press = (el: FakeElement, key: string, shiftKey = false) =>
  act(async () => { el.dispatchEvent(new FakeEvent('keydown', { bubbles: true, cancelable: true, key, shiftKey })) })

test('the divider says what it is and where it stands', async () => {
  row = 1160
  const { m, divider } = await open()
  expect(divider.getAttribute('role')).toBe('separator')
  expect(divider.getAttribute('aria-orientation')).toBe('vertical')
  expect(divider.getAttribute('aria-label')).toBe('Resize the thread')
  expect(divider.getAttribute('tabindex')).toBe('0')
  expect(divider.getAttribute('aria-valuenow')).toBe('440')
  expect(divider.getAttribute('aria-valuemin')).toBe('320')
  expect(divider.getAttribute('aria-valuemax')).toBe('740')
  expect(m.find('overlay')).toBeNull()
  await m.unmount()
})

test('keys set the width and remember it; a double-click goes back to the default and forgets it', async () => {
  row = 1160
  const { m, divider, width } = await open()
  await press(divider, 'ArrowLeft')
  expect(width()).toBe(464)
  expect(divider.getAttribute('aria-valuenow')).toBe('464')
  expect(localStorage.getItem(THREAD_PANEL.key)).toBe('0.4')
  await press(divider, 'ArrowRight', true)
  expect(width()).toBe(368)
  await press(divider, 'Home')
  expect(width()).toBe(320)
  await press(divider, 'ArrowRight')
  // never under the minimum
  expect(width()).toBe(320)
  await press(divider, 'End')
  expect(width()).toBe(740)
  await press(divider, 'ArrowLeft', true)
  // never so wide the column gets under its 420 px
  expect(width()).toBe(740)
  // a key the divider does not use changes nothing
  await press(divider, 'ArrowUp')
  expect(width()).toBe(740)

  await act(async () => { divider.dispatchEvent(new FakeEvent('dblclick', { bubbles: true })) })
  expect(width()).toBe(DEFAULT)
  expect(divider.getAttribute('aria-valuenow')).toBe(String(DEFAULT))
  expect(localStorage.getItem(THREAD_PANEL.key)).toBeNull()
  await m.unmount()
})

test('a remembered width comes back, kept within the window there is now', async () => {
  row = 1160
  localStorage.setItem(THREAD_PANEL.key, '0.6')
  const { m, width, resize, divider } = await open()
  expect(width()).toBe(696)
  // a narrower window: the same share, but the column keeps its 420 px
  row = 1100
  await resize()
  expect(width()).toBe(660)
  row = 1000
  await resize()
  expect(width()).toBe(580)
  row = 900
  await resize()
  expect(width()).toBe(480)
  expect(divider.getAttribute('aria-valuemax')).toBe('480')
  // the share is still the one remembered: a wide window gives it back
  row = 1160
  await resize()
  expect(width()).toBe(696)
  expect(localStorage.getItem(THREAD_PANEL.key)).toBe('0.6')
  await m.unmount()
})
