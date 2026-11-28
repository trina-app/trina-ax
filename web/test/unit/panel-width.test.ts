// The widths behind the panel dividers (lib/panelWidth.ts, components/PanelDivider.tsx): the right-hand panel beside the
// chat, a thread beside its room and the list panel beside the rail share the logic, each with its own limits and its own
// remembered width (the list panel's in px, on the left of its row).
import { describe, expect, test } from 'bun:test'
import { clampPanel, fitPanel, keyWidth, LIST_PANEL, panelLimits, PANEL_BIG_STEP, PANEL_STEP, readPanelFraction, settlePanel, SIDE_PANEL, SIDE_PANEL_BESIDE_THREAD, THREAD_PANEL, writePanelFraction } from '../../src/lib/panelWidth'

const setStorage = (s: unknown) => { (globalThis as { localStorage?: unknown }).localStorage = s }
const clearStorage = () => { delete (globalThis as { localStorage?: unknown }).localStorage }
function memoryStorage() {
  const store = new Map<string, string>()
  setStorage({ getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) })
  return store
}

describe('panel width limits', () => {
  test('the side panel keeps 320 px and the chat keeps 360 px', () => {
    expect(panelLimits(1100, SIDE_PANEL)).toEqual({ min: 320, max: 740 })
    expect(clampPanel(100, 1100, SIDE_PANEL)).toBe(320)
    expect(clampPanel(900, 1100, SIDE_PANEL)).toBe(740)
    expect(clampPanel(500.4, 1100, SIDE_PANEL)).toBe(500)
  })
  test('a thread keeps 320 px and the room keeps 420 px', () => {
    // a wide window: the room row is 1160 px
    expect(panelLimits(1160, THREAD_PANEL)).toEqual({ min: 320, max: 740 })
    expect(clampPanel(200, 1160, THREAD_PANEL)).toBe(320)
    expect(clampPanel(1000, 1160, THREAD_PANEL)).toBe(740)
    expect(clampPanel(612.6, 1160, THREAD_PANEL)).toBe(613)
  })
  test('the right-hand panel beside an open thread leaves the room 420 px and the thread 320', () => {
    expect(SIDE_PANEL_BESIDE_THREAD.key).toBe(SIDE_PANEL.key)
    // 1440 px window: the page and the panel share 1440 - 280 = 1160
    expect(panelLimits(1160, SIDE_PANEL_BESIDE_THREAD)).toEqual({ min: 320, max: 420 })
    expect(fitPanel(0.6, 1160, SIDE_PANEL_BESIDE_THREAD)).toBe(420)
  })
  test('a window too narrow for both: the panel minimum wins', () => {
    expect(panelLimits(600, SIDE_PANEL)).toEqual({ min: 320, max: 320 })
    expect(clampPanel(500, 600, SIDE_PANEL)).toBe(320)
    expect(panelLimits(700, THREAD_PANEL)).toEqual({ min: 320, max: 320 })
    expect(clampPanel(500, 700, THREAD_PANEL)).toBe(320)
  })
  test('not a number falls back to the minimum', () => {
    expect(clampPanel(Number.NaN, 1100, SIDE_PANEL)).toBe(320)
    expect(clampPanel(Number.POSITIVE_INFINITY, 1100, THREAD_PANEL)).toBe(320)
  })
})

describe('settling and fitting a width', () => {
  test('a width set for good is clamped and remembered as a share of the row; null is the default and forgets', () => {
    expect(settlePanel(580, 1160, THREAD_PANEL, null)).toEqual({ width: 580, fraction: 0.5 })
    expect(settlePanel(2000, 1160, THREAD_PANEL, 0.3)).toEqual({ width: 740, fraction: 740 / 1160 })
    expect(settlePanel(null, 1160, THREAD_PANEL, 0.3)).toEqual({ width: null, fraction: null })
  })
  test('a row with no room to choose keeps the width chosen before', () => {
    // 700 px: 320 is both the smallest and the largest thread; a drag or a key there changes nothing remembered
    expect(settlePanel(500, 700, THREAD_PANEL, 0.6)).toEqual({ width: 320, fraction: 0.6 })
    expect(settlePanel(320, 700, THREAD_PANEL, null)).toEqual({ width: null, fraction: null })
    // and a wider row later brings that width back
    expect(fitPanel(settlePanel(500, 700, THREAD_PANEL, 0.6).fraction, 1160, THREAD_PANEL)).toBe(696)
    // the right-hand panel beside an open thread, at its largest: the same
    expect(settlePanel(400, 1000, SIDE_PANEL_BESIDE_THREAD, 0.45)).toEqual({ width: 320, fraction: 0.45 })
    // no row measured yet: nothing is remembered either
    expect(settlePanel(400, 0, THREAD_PANEL, null)).toEqual({ width: null, fraction: null })
    // a double-click still forgets
    expect(settlePanel(null, 700, THREAD_PANEL, 0.6)).toEqual({ width: null, fraction: null })
  })
  test('a remembered share follows the window and stays within the limits', () => {
    expect(fitPanel(null, 1160, THREAD_PANEL)).toBeNull()
    expect(fitPanel(0.5, 1160, THREAD_PANEL)).toBe(580)
    // a narrower window (1280: the row is 1000): the same share
    expect(fitPanel(0.5, 1000, THREAD_PANEL)).toBe(500)
    // a much narrower one: the room keeps its 420 px
    expect(fitPanel(0.7, 900, THREAD_PANEL)).toBe(480)
    // narrower than both minimums: the panel keeps 320
    expect(fitPanel(0.5, 500, THREAD_PANEL)).toBe(320)
    // the side panel's own limits
    expect(fitPanel(0.7, 900, SIDE_PANEL)).toBe(540)
  })
})

describe('keyboard', () => {
  const limits = { min: 320, max: 740 }
  test('Left widens, Right narrows, Shift takes the bigger step, Home and End go to the limits', () => {
    expect(keyWidth('ArrowLeft', false, 440, limits)).toBe(440 + PANEL_STEP)
    expect(keyWidth('ArrowRight', false, 440, limits)).toBe(440 - PANEL_STEP)
    expect(keyWidth('ArrowLeft', true, 440, limits)).toBe(440 + PANEL_BIG_STEP)
    expect(keyWidth('ArrowRight', true, 440, limits)).toBe(440 - PANEL_BIG_STEP)
    expect(keyWidth('Home', false, 440, limits)).toBe(320)
    expect(keyWidth('End', false, 440, limits)).toBe(740)
  })
  test('other keys are left alone', () => {
    for (const k of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Tab', 'a']) expect(keyWidth(k, false, 440, limits)).toBeNull()
  })
  test('a step past a limit is clamped when it is set', () => {
    expect(settlePanel(keyWidth('ArrowRight', true, 340, limits)!, 1160, THREAD_PANEL, null).width).toBe(320)
    expect(settlePanel(keyWidth('ArrowLeft', true, 700, limits)!, 1160, THREAD_PANEL, null).width).toBe(740)
  })
})

describe('remembered width', () => {
  test('no storage or bad values give null; a saved fraction reads back', () => {
    clearStorage()
    expect(readPanelFraction(SIDE_PANEL)).toBeNull()
    const store = memoryStorage()
    try {
      expect(readPanelFraction(SIDE_PANEL)).toBeNull()
      writePanelFraction(0.5123456, SIDE_PANEL)
      expect(store.get('mycel.sidePanel.widthFraction')).toBe('0.5123')
      expect(readPanelFraction(SIDE_PANEL)).toBe(0.5123)
      store.set(SIDE_PANEL.key, '7')
      expect(readPanelFraction(SIDE_PANEL)).toBeNull()
      store.set(SIDE_PANEL.key, 'abc')
      expect(readPanelFraction(SIDE_PANEL)).toBeNull()
      writePanelFraction(null, SIDE_PANEL)
      expect(store.has(SIDE_PANEL.key)).toBe(false)
    } finally {
      clearStorage()
    }
  })
  test('each panel remembers its own width; resetting one leaves the other', () => {
    const store = memoryStorage()
    try {
      expect(THREAD_PANEL.key).toBe('mycel.threadPanel.widthFraction')
      writePanelFraction(0.4, SIDE_PANEL)
      writePanelFraction(0.35, THREAD_PANEL)
      expect(readPanelFraction(SIDE_PANEL)).toBe(0.4)
      expect(readPanelFraction(THREAD_PANEL)).toBe(0.35)
      writePanelFraction(null, THREAD_PANEL)
      expect(readPanelFraction(THREAD_PANEL)).toBeNull()
      expect(readPanelFraction(SIDE_PANEL)).toBe(0.4)
      expect([...store.keys()]).toEqual([SIDE_PANEL.key])
    } finally {
      clearStorage()
    }
  })
  test('a throwing storage does not throw', () => {
    const boom = () => { throw new Error('denied') }
    setStorage({ getItem: boom, setItem: boom, removeItem: boom })
    try {
      expect(readPanelFraction(THREAD_PANEL)).toBeNull()
      writePanelFraction(0.4, THREAD_PANEL)
      writePanelFraction(null, THREAD_PANEL)
    } finally {
      clearStorage()
    }
  })
})

describe('the list panel beside the rail (docs/decisions/20261127-list-panel-resize.md)', () => {
  // the panel and <main> share the window less the rail (72 px)
  test('240 to 400 px, and the main area keeps 740 px', () => {
    // 1440 window: 1368 shared, 400 is the cap
    expect(panelLimits(1440 - 72, LIST_PANEL)).toEqual({ min: 240, max: 400 })
    // 1280 window: 1208 shared, 468 would leave 740, the cap still wins
    expect(panelLimits(1280 - 72, LIST_PANEL)).toEqual({ min: 240, max: 400 })
    // 1100 window: 1028 shared, 288 keeps 740 for the main area
    expect(panelLimits(1100 - 72, LIST_PANEL)).toEqual({ min: 240, max: 288 })
    // 1052 window: nothing to drag
    expect(panelLimits(1052 - 72, LIST_PANEL)).toEqual({ min: 240, max: 240 })
    expect(clampPanel(1000, 1368, LIST_PANEL)).toBe(400)
    expect(clampPanel(100, 1368, LIST_PANEL)).toBe(240)
  })
  test('remembered in px: the same width on any window that has room, clamped where it has not, back when it has', () => {
    expect(settlePanel(352, 1368, LIST_PANEL, null)).toEqual({ width: 352, fraction: 352 })
    expect(settlePanel(900, 1368, LIST_PANEL, null)).toEqual({ width: 400, fraction: 400 })
    expect(fitPanel(352, 1368, LIST_PANEL)).toBe(352)
    expect(fitPanel(352, 1208, LIST_PANEL)).toBe(352)
    expect(fitPanel(352, 1028, LIST_PANEL)).toBe(288)
    expect(fitPanel(352, 980, LIST_PANEL)).toBe(240)
    // a 1052 window has no room to choose: what was set before stays remembered
    expect(settlePanel(300, 980, LIST_PANEL, 352)).toEqual({ width: 240, fraction: 352 })
    expect(settlePanel(null, 1368, LIST_PANEL, 352)).toEqual({ width: null, fraction: null })
  })
  test('the panel is on the divider\'s left: Right widens, Left narrows', () => {
    const limits = { min: 240, max: 400 }
    expect(keyWidth('ArrowRight', false, 288, limits, 'start')).toBe(288 + PANEL_STEP)
    expect(keyWidth('ArrowLeft', false, 288, limits, 'start')).toBe(288 - PANEL_STEP)
    expect(keyWidth('ArrowRight', true, 288, limits, 'start')).toBe(288 + PANEL_BIG_STEP)
    expect(keyWidth('ArrowLeft', true, 288, limits, 'start')).toBe(288 - PANEL_BIG_STEP)
    expect(keyWidth('Home', false, 288, limits, 'start')).toBe(240)
    expect(keyWidth('End', false, 288, limits, 'start')).toBe(400)
  })
  test('kept as whole px under its own key; a width under the minimum or not a number is dropped', () => {
    const store = memoryStorage()
    try {
      expect(LIST_PANEL.key).toBe('mycel.listPanel.width')
      writePanelFraction(331.6, LIST_PANEL)
      expect(store.get(LIST_PANEL.key)).toBe('332')
      expect(readPanelFraction(LIST_PANEL)).toBe(332)
      store.set(LIST_PANEL.key, '0.4')
      expect(readPanelFraction(LIST_PANEL)).toBeNull()
      store.set(LIST_PANEL.key, 'wide')
      expect(readPanelFraction(LIST_PANEL)).toBeNull()
      writePanelFraction(null, LIST_PANEL)
      expect(store.has(LIST_PANEL.key)).toBe(false)
    } finally {
      clearStorage()
    }
  })
})
