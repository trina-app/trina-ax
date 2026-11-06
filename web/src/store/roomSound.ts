// The room sound in this window (lib/roomSound.ts says what rings and why): started and stopped with the live updates
// (store/live.ts), fed every room.message from dispatch, and the switch for Settings › Notifications.
import { useSyncExternalStore } from 'react'
import type { RoomMessage } from '@mycel/shared/api'
import { Chime, RoomSound, roomSoundOn, setRoomSoundOn, SOUND_KEY, VIEW_EVERY_MS, type AudioLike, type LocksLike } from '../lib/roomSound'
import { isDesktop } from '../lib/desktop'
import { mobileApp } from '../lib/mobile'
import { useRooms } from './rooms'
import { useSession } from './session'
import { useUi } from './ui'

const chime = new Chime()
let sound: RoomSound | null = null
let stop: (() => void) | null = null

const storage = () => {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}
const tabId = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`)

/** Start listening (signed in): gestures unlock the audio; focus, visibility and the open room are told to the other
 * tabs; the service worker may ask whether this page takes care of a room notice's sound. */
export function startRoomSound(o: { audio?: AudioLike } = {}) {
  if (stop || typeof window === 'undefined' || typeof document === 'undefined') return
  const visible = () => document.visibilityState === 'visible'
  // a phone: the phone app, or a browser whose only pointer is a finger
  const phone = !!mobileApp() || !!window.matchMedia?.('(pointer: coarse)')?.matches
  // the phone app's page has no other window to lose focus to: on screen is looking at it
  const focused = () => visible() && (!!mobileApp() || document.hasFocus())
  // back on screen: what waited meanwhile arrives first, and the phone's notification already sounded for it
  let shownAt = 0
  const BACK_QUIET_MS = 1500
  const locks = (navigator as Navigator & { locks?: LocksLike }).locks ?? null
  const s = new RoomSound({
    tabId: tabId(), now: () => Date.now(), storage: storage(), locks, focused,
    quiet: () => phone && (!visible() || Date.now() - shownAt < BACK_QUIET_MS),
    openRoom: () => useRooms.getState().openRoomId,
    audio: o.audio ?? chime,
  })
  sound = s
  const prime = () => { if (roomSoundOn() && !chime.ready()) void chime.prime() }
  const publish = () => s.publishView()
  const shown = () => { if (visible()) shownAt = Date.now(); publish() }
  const gone = () => s.forgetView()
  // the events a browser counts as a gesture (a touch's pointerdown is not one in Chrome; its touchend is)
  const gestures = ['pointerdown', 'touchend', 'click', 'keydown'] as const
  for (const g of gestures) window.addEventListener(g, prime, { capture: true, passive: true })
  window.addEventListener('focus', publish)
  window.addEventListener('blur', publish)
  // pagehide comes before the page is hidden: the closing tab takes its word back; pageshow (back from the cache) says it again
  window.addEventListener('pagehide', gone)
  window.addEventListener('pageshow', publish)
  document.addEventListener('visibilitychange', shown)
  const offRooms = useRooms.subscribe((now, before) => { if (now.openRoomId !== before.openRoomId) publish() })
  const beat = setInterval(publish, VIEW_EVERY_MS)
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined
  const ask = (e: MessageEvent) => {
    if ((e.data as { type?: unknown } | null)?.type !== 'room-sound.ask' || !e.ports?.[0]) return
    e.ports[0].postMessage({ type: 'room-sound.answer', handled: s.handles(useUi.getState().conn === 'open') })
  }
  sw?.addEventListener('message', ask)
  try { sw?.startMessages() } catch { /* no worker here */ }
  publish()
  // the desktop app lets audio start without a gesture: ready from the start (after an update's relaunch too)
  if (isDesktop() && roomSoundOn()) void chime.prime()
  stop = () => {
    for (const g of gestures) window.removeEventListener(g, prime, { capture: true })
    window.removeEventListener('focus', publish)
    window.removeEventListener('blur', publish)
    window.removeEventListener('pagehide', gone)
    window.removeEventListener('pageshow', publish)
    document.removeEventListener('visibilitychange', shown)
    offRooms()
    clearInterval(beat)
    sw?.removeEventListener('message', ask)
    // signed out: no word left behind about a room this window showed
    s.forgetView()
  }
}

export function stopRoomSound() {
  stop?.()
  stop = null
  sound = null
}

/** A room.message reached this window (store/live.ts dispatch, after the rooms store took it). */
export function roomMessageSound(roomId: string, message: RoomMessage, replay: boolean) {
  if (!sound) return
  const room = useRooms.getState().rooms.find((r) => r.id === roomId) ?? null
  const st = useSession.getState().status
  void sound.message(roomId, message, room, st.kind === 'signed-in' ? st.me.user.id : null, replay, useRooms.getState().alerts).catch(() => {})
}

// ---------------- the switch ----------------
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  // another tab changed it
  const onStorage = (e: StorageEvent) => { if (e.key === SOUND_KEY || e.key === null) fn() }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(fn)
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

/** The "알림 소리" switch of this device. */
export function useRoomSoundOn(): boolean {
  return useSyncExternalStore(subscribe, () => roomSoundOn(), () => true)
}

/** Turn the sound on or off on this device; turning it on (a click) unlocks the audio and plays it once. */
export function changeRoomSound(on: boolean) {
  setRoomSoundOn(on)
  for (const fn of listeners) fn()
  if (on) chime.preview()
}
