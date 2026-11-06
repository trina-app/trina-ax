// The token box (components/TokenTextarea.tsx) without a room: both layers hold the same text with the tokens marked,
// take over the text area's metrics (its padding widened by a scroll bar that takes room) and follow its scroll. The
// browser's layout is the e2e specs' (room-mentions.spec.ts); this DOM has none, so the text area's sizes are set here.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { act, useState } from 'react'
import { TokenTextarea, type TextToken } from '../../src/components/TokenTextarea'
import { FakeElement, FakeEvent, installDom, mount, removeDom } from './dom-host'

beforeAll(() => { installDom() })
afterAll(() => { removeDom() })

const STYLE: Record<string, string> = { 'font-size': '17px', 'line-height': '26px', 'padding-left': '6px', 'padding-right': '6px', 'border-left-width': '0px', 'border-right-width': '0px', color: 'rgb(20, 17, 15)', direction: 'ltr' }

test('both layers: the same text and tokens, the metrics of the text area, its scroll bar and its scroll', async () => {
  const was = globalThis.getComputedStyle
  globalThis.getComputedStyle = (() => ({ getPropertyValue: (p: string) => STYLE[p] ?? '' })) as unknown as typeof getComputedStyle
  let rerender = () => {}
  function Box() {
    const [n, setN] = useState(0)
    rerender = () => setN((x) => x + 1)
    const tokens: TextToken[] = [{ start: 3, end: 7, kind: 'person' }]
    return <TokenTextarea value={`hi @Ann and more${'!'.repeat(n)}`} tokens={tokens} onTextChange={() => {}} tokenClass={() => 'tok'} data-testid="box" />
  }
  const m = await mount(<Box />)
  try {
    const box = m.get('box')
    // a classic scroll bar of 15px inside a 300px text area; scrolled 40px down
    Object.defineProperties(box, { offsetWidth: { value: 300 }, clientWidth: { value: 285 }, scrollTop: { value: 40, writable: true }, scrollLeft: { value: 0 } })
    await act(async () => rerender())
    const layers = m.container.querySelectorAll('[data-token-layer]')
    expect(layers.map((l) => l.getAttribute('data-token-layer'))).toEqual(['back', 'front'])
    for (const l of layers) {
      const inner = l.firstChild as FakeElement
      expect(inner.textContent).toBe('hi @Ann and more!​')
      expect(inner.querySelectorAll('[data-token]').map((x) => x.textContent)).toEqual(['@Ann'])
      expect(inner.style['font-size']).toBe('17px')
      expect(inner.style['line-height']).toBe('26px')
      expect(inner.style.color).toBe('rgb(20, 17, 15)')
      // the scroll bar's 15px on the padding: the lines break where the text area's do
      expect(inner.style['padding-right']).toBe('21px')
      expect(inner.style.transform).toBe('translate(0px, -40px)')
      expect(l.getAttribute('aria-hidden')).toBe('true')
      expect(l.getAttribute('translate')).toBe('no')
    }
    // the text area scrolls: the layers follow
    Object.assign(box, { scrollTop: 64 })
    await act(async () => { box.dispatchEvent(new FakeEvent('scroll')) })
    for (const l of layers) expect((l.firstChild as FakeElement).style.transform).toBe('translate(0px, -64px)')
    // the text area's own letters: marked for index.css to leave them unpainted; its background stays clear
    expect(box.getAttribute('data-token-input')).toBe('')
    expect(box.style.backgroundColor).toBe('transparent')
  } finally {
    await m.unmount()
    globalThis.getComputedStyle = was
  }
})
