// A pinch and a double tap on a document viewer (a PDF's pages; QA TC-259): two fingers give the scale since they came
// down and the point between them, a quick second tap at the same place gives that place. The browser's own page zoom
// is held back on that element (a pinch or double tap there zoomed the whole app on an iPhone): the two-finger
// touchmove and the double tap's touchend are cancelled (non-passive listeners), WebKit's gesture* events too, and the
// element's touch-action leaves the browser only the scrolling. One finger still scrolls as before. A HTML page in its
// frame does the same inside the frame (lib/pageFit.ts): the frame's touches never reach this page.
import { useEffect, useRef } from 'react'

export interface Pt { x: number; y: number }
/** a tap: where, and when (ms) */
export interface Tap extends Pt { t: number }

/** the most time (ms) and distance (px) between the two taps of a double tap */
export const DOUBLE_TAP_MS = 300
export const DOUBLE_TAP_PX = 30
/** a finger that moved further than this (px) scrolled: no tap */
export const TAP_SLOP = 10

export const distance = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
export const midpoint = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
/** whether `now` is the second tap of a double tap after `prev` */
export const isDoubleTap = (prev: Tap | null, now: Tap) => !!prev && now.t - prev.t <= DOUBLE_TAP_MS && distance(prev, now) <= DOUBLE_TAP_PX
/** `value` within [min, max] */
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export interface PinchHandlers {
  /** `scale`: the fingers' distance now over their distance when the second came down; `center`: between them, in
   * client coordinates. 'end' comes with the last scale when a finger lifts. */
  onPinch?: (p: { scale: number; center: Pt; phase: 'start' | 'move' | 'end' }) => void
  /** the second tap's place, in client coordinates */
  onDoubleTap?: (at: Pt) => void
}

const point = (t: Touch): Pt => ({ x: t.clientX, y: t.clientY })

/** Pinch and double tap on `el` (null: none) for as long as it is given. */
export function usePinch(el: HTMLElement | null, handlers: PinchHandlers) {
  const live = useRef(handlers)
  live.current = handlers
  useEffect(() => {
    if (!el) return
    let pinch: { from: number; scale: number; center: Pt } | null = null
    let tap: Tap | null = null
    let lastTap: Tap | null = null
    const onStart = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        const a = point(e.touches[0]!)
        const b = point(e.touches[1]!)
        e.preventDefault()
        tap = lastTap = null
        pinch = { from: Math.max(1, distance(a, b)), scale: 1, center: midpoint(a, b) }
        live.current.onPinch?.({ scale: 1, center: pinch.center, phase: 'start' })
      } else if (e.touches.length === 1) tap = { ...point(e.touches[0]!), t: e.timeStamp }
    }
    const onMove = (e: TouchEvent) => {
      if (pinch && e.touches.length >= 2) {
        e.preventDefault()
        const a = point(e.touches[0]!)
        const b = point(e.touches[1]!)
        pinch.scale = distance(a, b) / pinch.from
        pinch.center = midpoint(a, b)
        live.current.onPinch?.({ scale: pinch.scale, center: pinch.center, phase: 'move' })
      } else if (tap && e.touches[0] && distance(tap, point(e.touches[0])) > TAP_SLOP) tap = null
    }
    const onEnd = (e: TouchEvent) => {
      if (pinch) {
        if (e.touches.length >= 2) return
        const p = pinch
        pinch = null
        live.current.onPinch?.({ scale: p.scale, center: p.center, phase: 'end' })
        return
      }
      const start = tap
      tap = null
      const lifted = e.changedTouches[0]
      if (!start || !lifted || e.touches.length || e.type === 'touchcancel') return
      const now: Tap = { ...point(lifted), t: e.timeStamp }
      if (distance(start, now) > TAP_SLOP || now.t - start.t > DOUBLE_TAP_MS) {
        lastTap = null
        return
      }
      if (isDoubleTap(lastTap, now)) {
        // no zoom of the page, no click of the second tap
        e.preventDefault()
        lastTap = null
        live.current.onDoubleTap?.(now)
      } else lastTap = now
    }
    // Safari's own pinch of the page (it comes beside the touches)
    const onGesture = (e: Event) => e.preventDefault()
    const before = el.style.touchAction
    el.style.touchAction = 'pan-x pan-y'
    el.addEventListener('touchstart', onStart, { passive: false })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: false })
    el.addEventListener('touchcancel', onEnd, { passive: false })
    for (const g of ['gesturestart', 'gesturechange', 'gestureend']) el.addEventListener(g, onGesture, { passive: false })
    return () => {
      el.style.touchAction = before
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
      for (const g of ['gesturestart', 'gesturechange', 'gestureend']) el.removeEventListener(g, onGesture)
    }
  }, [el])
}
