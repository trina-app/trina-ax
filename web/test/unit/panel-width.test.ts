import { describe, expect, test } from 'bun:test'
import { clampPanel, panelLimits, PANEL_WIDTH_KEY, readPanelFraction, writePanelFraction } from '../../src/lib/panelWidth'

const setStorage = (s: unknown) => { (globalThis as { localStorage?: unknown }).localStorage = s }
const clearStorage = () => { delete (globalThis as { localStorage?: unknown }).localStorage }

describe('panel width limits', () => {
  test('the panel keeps 320 px and the chat keeps 360 px', () => {
    expect(panelLimits(1100)).toEqual({ min: 320, max: 740 })
    expect(clampPanel(100, 1100)).toBe(320)
    expect(clampPanel(900, 1100)).toBe(740)
    expect(clampPanel(500.4, 1100)).toBe(500)
  })
  test('a window too narrow for both: the panel minimum wins', () => {
    expect(panelLimits(600)).toEqual({ min: 320, max: 320 })
    expect(clampPanel(500, 600)).toBe(320)
  })
  test('not a number falls back to the minimum', () => {
    expect(clampPanel(Number.NaN, 1100)).toBe(320)
  })
})

describe('remembered width', () => {
  test('no storage or bad values give null; a saved fraction reads back', () => {
    clearStorage()
    expect(readPanelFraction()).toBeNull()
    const store = new Map<string, string>()
    setStorage({ getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) })
    try {
      expect(readPanelFraction()).toBeNull()
      writePanelFraction(0.5123456)
      expect(store.get(PANEL_WIDTH_KEY)).toBe('0.5123')
      expect(readPanelFraction()).toBe(0.5123)
      store.set(PANEL_WIDTH_KEY, '7')
      expect(readPanelFraction()).toBeNull()
      store.set(PANEL_WIDTH_KEY, 'abc')
      expect(readPanelFraction()).toBeNull()
      writePanelFraction(null)
      expect(store.has(PANEL_WIDTH_KEY)).toBe(false)
    } finally {
      clearStorage()
    }
  })
  test('a throwing storage does not throw', () => {
    const boom = () => { throw new Error('denied') }
    setStorage({ getItem: boom, setItem: boom, removeItem: boom })
    try {
      expect(readPanelFraction()).toBeNull()
      writePanelFraction(0.4)
      writePanelFraction(null)
    } finally {
      clearStorage()
    }
  })
})
