// The image viewer's zoom and pan (web/src/lib/zoom.ts): a fitted picture is never drawn larger than itself, a click
// zooms about its point, the pan never leaves an empty band, a pinch follows the fingers, a swipe decides close or step.
import { describe, expect, test } from 'bun:test'
import { clampView, clickScale, fitScale, fitView, isZoomed, layoutSize, MAX_SCALE, onPicture, pinchView, stepScale, swipeResult, toggleAt, wheelScale, zoomAt } from '../../src/lib/zoom'

const stage = { width: 1000, height: 800 }
const shot = { width: 2880, height: 1800 } // a large screenshot
const icon = { width: 200, height: 100 } // a small picture

describe('fit', () => {
  test('a large picture shrinks to the stage, centred', () => {
    expect(fitScale(shot, stage)).toBeCloseTo(1000 / 2880)
    const v = fitView(shot, stage)
    expect(v.x).toBeCloseTo(0)
    expect(v.y).toBeCloseTo((800 - 1800 * v.scale) / 2)
  })
  test('a small picture is never upscaled to fit', () => {
    expect(fitScale(icon, stage)).toBe(1)
    expect(fitView(icon, stage)).toEqual({ scale: 1, x: 400, y: 350 })
  })
  test('a tall picture fits by its height', () => {
    expect(fitScale({ width: 500, height: 4000 }, stage)).toBeCloseTo(0.2)
  })
  test('no size yet: 1', () => {
    expect(fitScale({ width: 0, height: 0 }, stage)).toBe(1)
    expect(fitScale(shot, { width: 0, height: 0 })).toBe(1)
  })
})

describe('click zoom', () => {
  test('100 % for a large picture, 2× the fitted size for one shown at 80 % or more', () => {
    expect(clickScale(0.35)).toBe(1)
    expect(clickScale(1)).toBe(2)
    expect(clickScale(0.9)).toBeCloseTo(1.8)
  })
  test('the point clicked stays under the pointer', () => {
    const v0 = fitView(shot, stage)
    const at = { x: 700, y: 300 }
    const v1 = toggleAt(v0, at, shot, stage)
    expect(v1.scale).toBe(1)
    // the picture's point that was under the pointer, before and after
    const before = { x: (at.x - v0.x) / v0.scale, y: (at.y - v0.y) / v0.scale }
    const after = { x: (at.x - v1.x) / v1.scale, y: (at.y - v1.y) / v1.scale }
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    expect(isZoomed(v1, shot, stage)).toBe(true)
  })
  test('a second click goes back to fitted', () => {
    const v1 = toggleAt(fitView(shot, stage), { x: 500, y: 400 }, shot, stage)
    expect(toggleAt(v1, { x: 10, y: 10 }, shot, stage)).toEqual(fitView(shot, stage))
  })
  test('a small picture doubles, about the click', () => {
    const v = toggleAt(fitView(icon, stage), { x: 450, y: 400 }, icon, stage)
    expect(v.scale).toBe(2)
    // 400 × 200 still fits the stage: centred
    expect(v.x).toBe(300)
    expect(v.y).toBe(300)
  })
})

describe('pan and limits', () => {
  test('a zoomed picture leaves no empty band at its edges', () => {
    const v = clampView({ scale: 1, x: 200, y: -5000 }, shot, stage)
    expect(v.x).toBe(0)
    expect(v.y).toBe(800 - 1800)
  })
  test('an axis that fits stays centred', () => {
    const wide = { width: 4000, height: 400 }
    const v = clampView({ scale: 1, x: -100, y: -100 }, wide, stage)
    expect(v.x).toBe(-100)
    expect(v.y).toBe(200)
  })
  test('never below the fitted size, never past 400 %', () => {
    expect(clampView({ scale: 0.01, x: 0, y: 0 }, shot, stage).scale).toBeCloseTo(fitScale(shot, stage))
    expect(zoomAt(fitView(shot, stage), 50, { x: 0, y: 0 }, shot, stage).scale).toBe(MAX_SCALE)
  })
  test('the hit test follows the drawn picture', () => {
    const v = fitView(icon, stage)
    expect(onPicture(v, icon, { x: 500, y: 400 })).toBe(true)
    expect(onPicture(v, icon, { x: 100, y: 100 })).toBe(false)
  })
})

describe('steps, wheel and pinch', () => {
  test('+ and − stop at 100 % on the way and at the fitted size', () => {
    const fit = fitScale(shot, stage)
    expect(stepScale(fit, 1, fit)).toBeCloseTo(fit * 1.5)
    expect(stepScale(0.8, 1, fit)).toBe(1)
    // no 1 % step at the end: 66 % goes straight to 100 %
    expect(stepScale(0.66, 1, fit)).toBe(1)
    expect(stepScale(1.5, -1, fit)).toBe(1)
    expect(stepScale(1.2, -1, fit)).toBe(1)
    expect(stepScale(fit * 1.2, -1, fit)).toBeCloseTo(fit)
    expect(stepScale(3.5, 1, fit)).toBe(MAX_SCALE)
  })
  test('a wheel notch is about 30 %, a pinch event a little; lines count as 16 px', () => {
    expect(wheelScale(1, -100)).toBeCloseTo(2 ** 0.5)
    expect(wheelScale(1, 100)).toBeCloseTo(2 ** -0.5)
    expect(wheelScale(1, -4)).toBeCloseTo(2 ** 0.04)
    expect(wheelScale(1, -3, 1)).toBeCloseTo(2 ** 0.48)
  })
  test('a pinch grows with the fingers and keeps the point under them', () => {
    const start = fitView(shot, stage)
    const m = { x: 500, y: 400 }
    const v = pinchView(start, 100, 300, m, m, shot, stage)
    expect(v.scale).toBeCloseTo(start.scale * 3)
    const before = (m.x - start.x) / start.scale
    const after = (m.x - v.x) / v.scale
    expect(after).toBeCloseTo(before)
  })
})

describe('swipes', () => {
  test('down past a fifth of the height, or a flick, closes', () => {
    expect(swipeResult(0, 200, 0, 0.1, stage)).toBe('close')
    expect(swipeResult(0, 60, 0, 0.9, stage)).toBe('close')
    expect(swipeResult(0, 60, 0, 0.1, stage)).toBe(null)
    expect(swipeResult(0, -300, 0, -1, stage)).toBe(null)
  })
  test('sideways steps to the next or the previous', () => {
    expect(swipeResult(-300, 10, -0.2, 0, stage)).toBe('next')
    expect(swipeResult(300, 10, 0.2, 0, stage)).toBe('prev')
    expect(swipeResult(-60, 0, -0.8, 0, stage)).toBe('next')
    expect(swipeResult(-60, 0, -0.1, 0, stage)).toBe(null)
  })
})

describe('layout before the original loads', () => {
  const thumb = { width: 640, height: 400 }
  test('the stored size when the thumbnail has its shape', () => {
    expect(layoutSize(null, shot, thumb)).toEqual(shot)
  })
  test('the thumbnail when the stored size has another shape (a photo stored before it was upright)', () => {
    expect(layoutSize(null, { width: 1800, height: 2880 }, thumb)).toEqual(thumb)
  })
  test('the original once it is there; nothing known: null', () => {
    expect(layoutSize({ width: 10, height: 10 }, shot, thumb)).toEqual({ width: 10, height: 10 })
    expect(layoutSize(null, undefined, null)).toBe(null)
    expect(layoutSize(null, shot, null)).toEqual(shot)
  })
})
