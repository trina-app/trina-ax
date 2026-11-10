// lib/viewport.ts: which focused element has a phone's keyboard up (isTextField), and dismissKeyboard, which a phone's
// sheet over a message calls first so the keyboard goes down (the field's text stays).
import { expect, test } from 'bun:test'
import { dismissKeyboard, isTextField } from '../../src/lib/viewport'

const el = (tagName: string, more: Record<string, unknown> = {}) => ({ tagName, ...more }) as unknown as Element

test('text fields bring the keyboard up; buttons, checkboxes and sliders do not', () => {
  expect(isTextField(el('TEXTAREA'))).toBe(true)
  expect(isTextField(el('INPUT', { type: 'text' }))).toBe(true)
  expect(isTextField(el('INPUT', { type: 'search' }))).toBe(true)
  expect(isTextField(el('INPUT', { type: 'date' }))).toBe(true)
  expect(isTextField(el('INPUT', {}))).toBe(true)
  expect(isTextField(el('DIV', { isContentEditable: true }))).toBe(true)
  for (const type of ['button', 'checkbox', 'radio', 'range', 'submit', 'file']) expect(isTextField(el('INPUT', { type }))).toBe(false)
  expect(isTextField(el('BUTTON'))).toBe(false)
  expect(isTextField(el('DIV'))).toBe(false)
  expect(isTextField(null)).toBe(false)
})

test('dismissKeyboard blurs a focused text field only', () => {
  const g = globalThis as { document?: unknown }
  const had = 'document' in g, was = g.document
  let blurred = 0
  try {
    g.document = { activeElement: el('TEXTAREA', { blur: () => blurred++ }) }
    dismissKeyboard()
    expect(blurred).toBe(1)
    g.document = { activeElement: el('BUTTON', { blur: () => blurred++ }) }
    dismissKeyboard()
    expect(blurred).toBe(1)
  } finally {
    if (had) g.document = was
    else delete g.document
  }
})
