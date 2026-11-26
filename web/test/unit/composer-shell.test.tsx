// The one message box (components/composer/ComposerShell.tsx, docs/decisions/20261126-one-composer.md): its keys
// (Enter sends with a keyboard, not while an input method composes nor on a touch screen; Esc stops a running answer,
// not while a menu, a list or a dialog is open), its buttons (one round send; while my answer runs, Stop with the clock
// beside it only when there is something to send) and the + menu, in the AI chat's box.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act, type KeyboardEvent } from 'react'
import Composer from '../../src/components/chat/Composer'
import { composing, enterSends, escStops } from '../../src/components/composer/keys'
import { CHAT } from './fixtures'
import { FakeEvent, installDom, mount, removeDom, type FakeElement, type Mounted } from './dom-host'

const g = globalThis as Record<string, unknown>
/** a computer (a mouse) or a touch screen */
const pointer = (fine: boolean) => { g.matchMedia = (q: string) => ({ matches: fine ? q === '(pointer: fine)' : q === '(pointer: coarse)', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) }
const realFetch = globalThis.fetch

beforeAll(() => {
  installDom()
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'not here' } }), { status: 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
})
afterEach(() => { localStorage.clear() })
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
})

const ev = (key: string, more: { shiftKey?: boolean; isComposing?: boolean; keyCode?: number; ctrlKey?: boolean } = {}) =>
  ({ key, shiftKey: !!more.shiftKey, ctrlKey: !!more.ctrlKey, altKey: false, metaKey: false, keyCode: more.keyCode ?? 0, nativeEvent: { isComposing: !!more.isComposing } }) as unknown as KeyboardEvent

describe('keys', () => {
  test('Enter sends with a keyboard; Shift+Enter, an input method and a touch screen make a new line', () => {
    pointer(true)
    expect(enterSends(ev('Enter'))).toBe(true)
    expect(enterSends(ev('Enter', { shiftKey: true }))).toBe(false)
    expect(enterSends(ev('Enter', { isComposing: true }))).toBe(false)
    expect(enterSends(ev('Enter', { keyCode: 229 }))).toBe(false)
    expect(composing(ev('Enter', { keyCode: 229 }))).toBe(true)
    pointer(false)
    expect(enterSends(ev('Enter'))).toBe(false)
  })
  test('Esc stops, not while an input method composes or with a modifier', () => {
    expect(escStops(ev('Escape'))).toBe(true)
    expect(escStops(ev('Escape', { isComposing: true }))).toBe(false)
    expect(escStops(ev('Escape', { keyCode: 229 }))).toBe(false)
    expect(escStops(ev('Escape', { ctrlKey: true }))).toBe(false)
    expect(escStops(ev('Enter'))).toBe(false)
  })
})

const box = (m: Mounted) => m.get('composer-input') as FakeElement
const key = async (m: Mounted, k: string) => {
  const e = new FakeEvent('keydown', { bubbles: true, cancelable: true, key: k })
  await act(async () => { box(m).dispatchEvent(e) })
  return e
}
async function open(running: boolean) {
  const sent: string[] = []
  let stops = 0
  const m = await mount(<Composer draftId={CHAT} ensureChat={async () => CHAT} running={running} onSend={async (text) => void sent.push(text)} onStop={async () => void stops++} engine={{ engine: undefined, model: undefined }} />)
  return { m, sent, stops: () => stops }
}

describe("the AI chat's box on the shell", () => {
  test('one round accent send; Enter sends with a keyboard', async () => {
    pointer(true)
    const { m, sent } = await open(false)
    try {
      expect(m.get('send').getAttribute('class')).toContain('rounded-full')
      expect(m.get('send').getAttribute('class')).toContain('bg-subtle')
      await m.type(box(m), 'hello')
      expect(m.get('send').getAttribute('class')).toContain('bg-accent')
      await key(m, 'Enter')
      await m.settle()
      expect(sent).toEqual(['hello'])
    } finally {
      await m.unmount()
    }
  })

  test('a touch screen: Return makes a new line, the button sends', async () => {
    pointer(false)
    const { m, sent } = await open(false)
    try {
      await m.type(box(m), 'hello')
      const e = await key(m, 'Enter')
      expect(e.defaultPrevented).toBe(false)
      await m.settle()
      expect(sent).toEqual([])
      await m.click('send')
      await m.settle()
      expect(sent).toEqual(['hello'])
    } finally {
      await m.unmount()
    }
  })

  test('while my answer runs: Stop, the clock only with text, and Esc stops (taken, so a panel stays)', async () => {
    pointer(true)
    const { m, stops } = await open(true)
    try {
      expect(m.find('stop')).not.toBeNull()
      expect(m.find('send')).toBeNull()
      expect(m.find('send-later')).toBeNull()
      await m.type(box(m), 'next one')
      expect(m.find('send-later')).not.toBeNull()
      const e = await key(m, 'Escape')
      await m.settle()
      expect(stops()).toBe(1)
      expect(e.defaultPrevented).toBe(true)
    } finally {
      await m.unmount()
    }
  })

  test('Esc does not stop while a menu is open', async () => {
    pointer(true)
    const { m, stops } = await open(true)
    try {
      await m.click('attach-button')
      expect(m.find('attach-menu')).not.toBeNull()
      await key(m, 'Escape')
      await m.settle()
      expect(stops()).toBe(0)
    } finally {
      await m.unmount()
    }
  })

  test('no answer running: Esc does nothing in the box', async () => {
    pointer(true)
    const { m, stops } = await open(false)
    try {
      const e = await key(m, 'Escape')
      expect(e.defaultPrevented).toBe(false)
      expect(stops()).toBe(0)
    } finally {
      await m.unmount()
    }
  })

  test('the + menu: this computer and team files', async () => {
    pointer(true)
    const { m } = await open(false)
    try {
      await m.click('attach-button')
      expect(m.find('attach-computer')).not.toBeNull()
      expect(m.find('attach-team')).not.toBeNull()
    } finally {
      await m.unmount()
    }
  })
})
