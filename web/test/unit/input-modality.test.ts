// lib/inputModality.ts: the focus ring is the keyboard's only. A mouse, pen or finger press sets <html data-input="pointer">
// (index.css then draws no ring), a key that moves around the page sets "keyboard"; Shift, ⌘ and shortcuts change
// nothing, and in a text field only Tab and Escape count.
import { describe, expect, test } from 'bun:test'
import { followInputModality, keyMovesFocus } from '../../src/lib/inputModality'

const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey', boolean>> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods })
const button = { tagName: 'BUTTON', isContentEditable: false }
const field = (type = 'text') => ({ tagName: 'INPUT', type, isContentEditable: false })
const textarea = { tagName: 'TEXTAREA', isContentEditable: false }
const editable = { tagName: 'DIV', isContentEditable: true }

describe('keyMovesFocus', () => {
  test('Tab, arrows, Enter, Space and Escape on a button move around the page', () => {
    for (const k of ['Tab', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Escape', 'Home', 'End', 'PageDown']) expect(keyMovesFocus(key(k), button as never)).toBe(true)
  })
  test('modifier keys alone (⌘⇧4 for a screenshot, ⌘Tab) and letters do not', () => {
    for (const k of ['Shift', 'Meta', 'Control', 'Alt', 'CapsLock', 'a', '4']) expect(keyMovesFocus(key(k), button as never)).toBe(false)
  })
  test('a key held with ⌘, Ctrl or Alt is a shortcut', () => {
    expect(keyMovesFocus(key('Tab', { metaKey: true }), button as never)).toBe(false)
    expect(keyMovesFocus(key('Tab', { ctrlKey: true }), button as never)).toBe(false)
    expect(keyMovesFocus(key('ArrowDown', { altKey: true }), button as never)).toBe(false)
  })
  test('in a text field only Tab and Escape count (the others type, move the caret or send)', () => {
    for (const t of [field(), field('search'), textarea, editable]) {
      expect(keyMovesFocus(key('Tab'), t as never)).toBe(true)
      expect(keyMovesFocus(key('Escape'), t as never)).toBe(true)
      for (const k of ['Enter', ' ', 'ArrowLeft', 'ArrowDown', 'Home']) expect(keyMovesFocus(key(k), t as never)).toBe(false)
    }
  })
  test('a checkbox or radio is not a text field', () => {
    expect(keyMovesFocus(key(' '), field('checkbox') as never)).toBe(true)
    expect(keyMovesFocus(key('ArrowDown'), field('radio') as never)).toBe(true)
  })
})

describe('followInputModality', () => {
  function fakeWindow() {
    const listeners = new Map<string, (e: unknown) => void>()
    const dataset: Record<string, string> = {}
    const win = {
      document: { documentElement: { dataset } },
      addEventListener: (type: string, fn: (e: unknown) => void, capture?: boolean) => {
        expect(capture).toBe(true)
        listeners.set(type, fn)
      },
      removeEventListener: (type: string) => void listeners.delete(type),
    }
    return { win, listeners, dataset }
  }
  test('a press sets pointer, a moving key sets keyboard, Shift after a click keeps pointer', () => {
    const { win, listeners, dataset } = fakeWindow()
    const stop = followInputModality(win as never)
    expect(dataset.input).toBeUndefined()
    listeners.get('pointerdown')!({})
    expect(dataset.input).toBe('pointer')
    listeners.get('keydown')!({ ...key('Shift'), target: button })
    expect(dataset.input).toBe('pointer')
    listeners.get('keydown')!({ ...key('Tab'), target: button })
    expect(dataset.input).toBe('keyboard')
    listeners.get('pointerdown')!({})
    expect(dataset.input).toBe('pointer')
    stop()
    expect(listeners.size).toBe(0)
  })
})
