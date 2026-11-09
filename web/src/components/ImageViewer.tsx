// The image viewer: a picture clicked anywhere in the app opens over the whole window, like Slack (docs/DECISIONS.md
// "One image viewer"). A name, chip or link still opens the side panel; a picture opens this, the panel's own picture too.
// - The picture fits the window and is never drawn larger than itself to fit; its thumbnail shows at once and gives way
//   to the original when that has loaded. Nothing is painted behind it: a transparent picture sits on the dark backdrop.
// - Zoom: a click on the picture toggles fit and 100 % (2× for a small one) about the click; ⌘/Ctrl + wheel and a
//   trackpad pinch zoom about the pointer; a drag pans when zoomed; + − 0; −, % and + in the bar. Phones: pinch,
//   double tap, one finger pans when zoomed; when not zoomed a swipe down closes and a swipe sideways steps.
// - ← → and the edge arrows step through the pictures of the pane it was opened from (ImageGroup below; its list is
//   lib/imageViewer.ts ViewerGroup).
// - The bar: the file's name, who sent it and when, "3 / 7", the zoom, 복사, download, the original in a new tab (a plain
//   browser only: the desktop and phone apps would open the system browser, which is not signed in) and ✕. Always shown
//   on a computer; a tap shows or hides it on a phone.
// - 복사 and ⌘C / Ctrl+C put the picture drawn here on the clipboard as a PNG (lib/copyImage.ts): the original, waited
//   for while it loads, else the thumbnail shown in its place (the toast says so). Only where the clipboard takes a
//   picture: never a button that does nothing.
// - Esc, ✕, a click on the backdrop, a swipe down and Back close it; focus goes back to the picture that opened it.
// - It is on the team page itself (a portal on <body>, never a frame): the desktop app's 이미지 복사 copies the original,
//   which is then the only picture under the pointer.
import clsx from 'clsx'
import { ChevronLeft, ChevronRight, Copy, Download, ExternalLink, Loader2, Minus, Plus, X } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import { closeImageViewer, notePage, openImageViewer, showEntry, skipLeftEntry, useImageViewer, ViewerGroup, type ViewerEntry, type ViewerItem, type ViewerMetaValue, type ViewerOpen, type ViewerSender } from '../lib/imageViewer'
import { clampView, fitView, isZoomed, layoutSize, onPicture, pinchView, stepScale, swipeResult, toggleAt, wheelScale, zoomAt, type Point, type Size, type View } from '../lib/zoom'
import { canCopyImage, copyImage, isCopyKey, type CopyFailure, type PickPicture } from '../lib/copyImage'
import { clientKind } from '../lib/desktop'
import { formatDateTime } from '../lib/format'
import { aiName } from '../lib/tabs'
import { useLocale, useT, type MessageKey } from '../i18n'
import { useAvatarOf, useNameOf } from '../store/people'
import { toast } from '../store/ui'
import { Avatar } from './Avatar'
import { AiFace } from './rooms/AiFace'
import { Tooltip } from './Tooltip'
import { useFocusTrap } from './ui'

// ---------------- panes and pictures ----------------

const GroupContext = createContext<ViewerGroup | null>(null)
const MetaContext = createContext<ViewerMetaValue>({})

/** A pane whose pictures next / previous walks through: a room's timeline, a thread, the AI chat, a message box's row. */
export function ImageGroup({ children }: { children: ReactNode }) {
  const [group] = useState(() => new ViewerGroup())
  return <GroupContext.Provider value={group}>{children}</GroupContext.Provider>
}

/** Who sent the pictures inside and when (a message), for the viewer's bar. */
export function ViewerMeta({ sender, at, children }: ViewerMetaValue & { children: ReactNode }) {
  const kind = sender?.kind
  const user = sender?.kind === 'user' ? sender.user : null
  const value = useMemo<ViewerMetaValue>(() => ({ sender: kind === 'ai' ? { kind: 'ai' } : kind === 'user' ? { kind: 'user', user } : undefined, at }), [kind, user, at])
  return <MetaContext.Provider value={value}>{children}</MetaContext.Provider>
}

/** A picture that opens the viewer: `ref` goes on the element clicked (focus comes back to it), `open` on its click.
 * `make` builds the picture from its message's who and when; null: this is no picture (nothing is registered). */
export function useViewerItem(make: ((meta: ViewerMetaValue) => ViewerItem) | null) {
  const group = useContext(GroupContext)
  const meta = useContext(MetaContext)
  const item = make ? make(meta) : null
  const entry = useRef<ViewerEntry | null>(null)
  if (item && !entry.current) entry.current = { item, el: null }
  const [el, setEl] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (entry.current && item) entry.current.item = item
  })
  const on = !!item
  useLayoutEffect(() => {
    const e = entry.current
    if (!e || !el || !on) return
    e.el = el
    return group?.add(e)
  }, [group, el, on])
  const open = useCallback(() => {
    const e = entry.current
    if (!e) return
    if (item) e.item = item
    e.el ??= el
    openImageViewer({ group: group && e.el ? group : null, entry: e, opener: el, openerKey: e.item.key })
  }, [group, el, item])
  return { ref: setEl, open }
}

/** Mounted once (App.tsx): the viewer while one is open. A move to another page closes it. */
export function ImageViewerHost() {
  const open = useImageViewer()
  const { pathname, key } = useLocation()
  const was = useRef(pathname)
  useEffect(() => {
    if (was.current === pathname) return
    was.current = pathname
    // a page change (a notice opened meanwhile) left the viewer's history entry already: no going back
    closeImageViewer(false)
  }, [pathname])
  // Back past a viewer's entry left behind by such a page change (lib/imageViewer.ts skipLeftEntry)
  useEffect(() => notePage(), [key])
  useEffect(() => {
    window.addEventListener('popstate', skipLeftEntry)
    return () => window.removeEventListener('popstate', skipLeftEntry)
  }, [])
  if (!open || typeof document === 'undefined') return null
  return createPortal(<Viewer open={open} />, document.body)
}

// ---------------- the viewer ----------------

interface Pic {
  /** a new one for each showing: its <img>s are drawn anew, so a picture at the same address as the last loads again */
  id: number
  entry: ViewerEntry
  thumb: Size | null
  orig: Size | null
  state: 'loading' | 'shown' | 'failed'
  /** null: fitted (it follows the window's size) */
  view: View | null
  /** the next change of view eases (a click, a key, a snap back); a drag, a wheel and a pinch follow the hand */
  ease: boolean
}
let picSeq = 0
const freshPic = (entry: ViewerEntry): Pic => ({ id: ++picSeq, entry, thumb: null, orig: null, state: 'loading', view: null, ease: false })

/** An object URL for bytes we have, gone with them. */
function useObjectUrl(blob: Blob | undefined): string | null {
  const [made, setMade] = useState<{ blob: Blob; url: string } | null>(null)
  useEffect(() => {
    if (!blob) return setMade(null)
    const url = URL.createObjectURL(blob)
    setMade({ blob, url })
    return () => URL.revokeObjectURL(url)
  }, [blob])
  return blob && made?.blob === blob ? made.url : null
}

/** The picture has loaded (waiting while it loads); false: it did not. */
const loaded = (img: HTMLImageElement): Promise<boolean> =>
  img.complete
    ? Promise.resolve(img.naturalWidth > 0)
    : new Promise((resolve) => {
        img.addEventListener('load', () => resolve(img.naturalWidth > 0), { once: true })
        img.addEventListener('error', () => resolve(false), { once: true })
      })

/** a text selected in the viewer (none can be: it copies as text, as a page does) */
function textSelectedIn(root: HTMLElement | null): boolean {
  const sel = typeof window === 'undefined' ? null : window.getSelection()
  return !!root && !!sel && !sel.isCollapsed && !!sel.toString().trim() && !!sel.anchorNode && root.contains(sel.anchorNode)
}

const COPY_FAILED: Record<CopyFailure, MessageKey> = { denied: 'viewer.copyDenied', tooBig: 'viewer.copyTooBig', notLoaded: 'viewer.copyNotLoaded', failed: 'viewer.copyError' }

type Gesture =
  | { kind: 'press'; touch: boolean; start: Point; view: View | null; zoomed: boolean; last: Point; lastT: number; vx: number; vy: number }
  | { kind: 'pan'; start: Point; view: View }
  | { kind: 'swipe'; start: Point; last: Point; lastT: number; vx: number; vy: number }
  | { kind: 'pinch'; view: View; d0: number; m0: Point }
  | { kind: 'idle' }

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

function Viewer({ open }: { open: ViewerOpen }) {
  const t = useT()
  const root = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const { group, entry, opener, openerKey } = open

  // the pane's pictures, kept current while open (a new photo in the room adds to the count)
  const subscribe = useCallback((l: () => void) => group?.subscribe(l) ?? (() => {}), [group])
  const version = useSyncExternalStore(subscribe, () => group?.version ?? 0)
  const list = useMemo(() => {
    const all = group ? group.list() : []
    return all.length ? all : [entry]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, entry, version])
  // the picture shown: its entry, or the same picture drawn anew (its message was drawn again)
  const cur = list.includes(entry) ? entry : (list.find((e) => e.item.key === entry.item.key) ?? entry)
  const index = list.indexOf(cur)
  const prev = index > 0 ? list[index - 1]! : null
  const next = index >= 0 && index < list.length - 1 ? list[index + 1]! : null
  const item = cur.item

  const close = useCallback(() => closeImageViewer(), [])
  const back = opener?.isConnected ? opener : (list.find((e) => e.item.key === openerKey)?.el ?? null)
  useFocusTrap(root, true, close, back)

  const [pic, setPic] = useState<Pic>(() => freshPic(cur))
  let p = pic
  if (pic.entry !== cur) {
    p = freshPic(cur)
    setPic(p)
  }

  const [stage, setStage] = useState<Size>({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const read = () => setStage({ width: el.clientWidth, height: el.clientHeight })
    const ro = new ResizeObserver(read)
    ro.observe(el)
    read()
    return () => ro.disconnect()
  }, [])

  const blobUrl = useObjectUrl(item.blob)
  const original = item.blob ? blobUrl : item.original
  // the thumbnail, unless it is the original itself (an answer's picture is already the original)
  const thumb = !item.blob && item.thumb && item.thumb !== item.original ? item.thumb : null
  const willLoad = !!original && p.state !== 'failed'
  const natural = layoutSize(p.orig, willLoad ? { width: item.width, height: item.height } : undefined, p.thumb)
  const ready = !!natural && stage.width > 0 && stage.height > 0
  const v = ready ? (p.view ? clampView(p.view, natural, stage) : fitView(natural, stage)) : null
  const zoomed = !!v && !!natural && isZoomed(v, natural, stage)
  const showThumb = !!thumb && p.state !== 'shown'
  // something to copy: the original (drawn, or loading), or the thumbnail shown in its place
  const copyOn = ((!!original && p.state !== 'failed') || !!thumb) && canCopyImage()
  const origEl = useRef<HTMLImageElement | null>(null)
  const thumbEl = useRef<HTMLImageElement | null>(null)
  const pick: PickPicture = async () => {
    // this picture's, as the copy was asked (a step to the next one meanwhile draws others)
    const o = origEl.current
    const s = thumbEl.current
    if (o && (await loaded(o))) return { drawn: { img: o, width: o.naturalWidth, height: o.naturalHeight }, thumb: false }
    // no original drawn (over the preview limit, or it failed): the thumbnail on screen
    if (s && (await loaded(s))) return { drawn: { img: s, width: s.naturalWidth, height: s.naturalHeight }, thumb: true }
    return null
  }
  const copy = () => {
    void copyImage({ blob: item.blob, pick }).then((r) => {
      if (r.ok) toast({ level: 'success', text: t('viewer.copied'), detail: r.smaller === 'thumb' ? t('viewer.copiedThumb') : r.smaller === 'scaled' ? t('viewer.copiedScaled') : undefined })
      else toast({ level: 'error', text: t('viewer.copyFailed'), detail: t(COPY_FAILED[r.reason]) })
    })
  }

  const [bars, setBars] = useState(true)
  const [swipe, setSwipe] = useState<{ dx: number; dy: number } | null>(null)

  /** set the view from the current one (fitted when it is null), for this picture only */
  const setView = (fn: (from: View, n: Size) => View | null, ease: boolean) =>
    setPic((q) => {
      if (q.entry !== cur || !natural || !stage.width) return q
      const from = q.view ? clampView(q.view, natural, stage) : fitView(natural, stage)
      return { ...q, view: fn(from, natural), ease }
    })
  const fit = () => setView(() => null, true)
  const step = (dir: 1 | -1) =>
    setView((from, n) => {
      const fitted = fitView(n, stage).scale
      const to = stepScale(from.scale, dir, fitted)
      return to <= fitted * 1.001 ? null : zoomAt(from, to, { x: stage.width / 2, y: stage.height / 2 }, n, stage)
    }, true)
  const go = (e: ViewerEntry | null) => {
    if (!e) return
    setSwipe(null)
    showEntry(e)
  }

  // the latest values for the native listeners and the gesture handlers
  const live = useRef({ v, natural, stage, zoomed, setView, close, go, prev, next })
  live.current = { v, natural, stage, zoomed, setView, close, go, prev, next }

  // ---- pointer: click, drag, pinch, swipe, taps ----
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<Gesture>({ kind: 'idle' })
  const lastTap = useRef<{ t: number; at: Point } | null>(null)
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (tapTimer.current) clearTimeout(tapTimer.current)
  }, [])
  const pointOf = (e: { clientX: number; clientY: number }): Point => {
    const r = stageRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // a right-click (and a Mac's control-click) is the browser's or the desktop app's own menu: copy, save
    if (e.pointerType === 'mouse' && (e.button !== 0 || e.ctrlKey)) return
    const L = live.current
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const at = pointOf(e)
    pointers.current.set(e.pointerId, at)
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [Point, Point]
      gesture.current = L.v ? { kind: 'pinch', view: L.v, d0: dist(a, b), m0: mid(a, b) } : { kind: 'idle' }
      setSwipe(null)
      return
    }
    if (pointers.current.size > 2) return
    // nothing drawn yet (or nothing to draw): a click still closes and a swipe still steps or closes
    gesture.current = { kind: 'press', touch: e.pointerType === 'touch', start: at, view: L.v, zoomed: L.zoomed, last: at, lastT: e.timeStamp, vx: 0, vy: 0 }
  }
  /** a menu opened (a long press, a right-click that came as a press): whatever the hand was doing ends */
  const onContextMenu = () => {
    pointers.current.clear()
    gesture.current = { kind: 'idle' }
    setSwipe(null)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const L = live.current
    const at = pointOf(e)
    if (!pointers.current.has(e.pointerId)) {
      // hover: the pointer says what a click does
      if (e.pointerType === 'mouse' && L.v && L.natural && stageRef.current) stageRef.current.style.cursor = !onPicture(L.v, L.natural, at) ? 'default' : L.zoomed ? 'grab' : 'zoom-in'
      return
    }
    pointers.current.set(e.pointerId, at)
    const g = gesture.current
    if (g.kind === 'pinch' && pointers.current.size >= 2 && L.natural) {
      const [a, b] = [...pointers.current.values()] as [Point, Point]
      L.setView(() => pinchView(g.view, g.d0, dist(a, b), g.m0, mid(a, b), L.natural!, L.stage), false)
      return
    }
    if (g.kind === 'press') {
      const dt = Math.max(1, e.timeStamp - g.lastT)
      g.vx = (at.x - g.last.x) / dt
      g.vy = (at.y - g.last.y) / dt
      g.last = at
      g.lastT = e.timeStamp
      if (dist(at, g.start) < (g.touch ? 10 : 4)) return
      if (g.zoomed && g.view) gesture.current = { kind: 'pan', start: g.start, view: g.view }
      else if (g.touch) gesture.current = { kind: 'swipe', start: g.start, last: at, lastT: e.timeStamp, vx: g.vx, vy: g.vy }
      else gesture.current = { kind: 'idle' } // a mouse drag on a fitted picture does nothing
    }
    const h = gesture.current
    if (h.kind === 'pan' && L.natural) {
      if (stageRef.current) stageRef.current.style.cursor = 'grabbing'
      L.setView(() => clampView({ scale: h.view.scale, x: h.view.x + at.x - h.start.x, y: h.view.y + at.y - h.start.y }, L.natural!, L.stage), false)
    } else if (h.kind === 'swipe') {
      const dt = Math.max(1, e.timeStamp - h.lastT)
      h.vx = (at.x - h.last.x) / dt
      h.vy = (at.y - h.last.y) / dt
      h.last = at
      h.lastT = e.timeStamp
      const dx = at.x - h.start.x
      const dy = at.y - h.start.y
      // one way at a time: down to close, sideways to step
      setSwipe(Math.abs(dy) >= Math.abs(dx) ? { dx: 0, dy } : { dx, dy: 0 })
    }
  }

  const onTap = (at: Point) => {
    const now = Date.now()
    const before = lastTap.current
    if (before && now - before.t < 300 && dist(before.at, at) < 30) {
      // a double tap: zoom in about it, or back to fitted
      if (tapTimer.current) clearTimeout(tapTimer.current)
      lastTap.current = null
      const L = live.current
      if (L.natural && L.v && onPicture(L.v, L.natural, at)) L.setView((from, n) => toggleAt(from, at, n, L.stage), true)
      else if (L.zoomed) L.setView(() => null, true)
      return
    }
    lastTap.current = { t: now, at }
    if (tapTimer.current) clearTimeout(tapTimer.current)
    // one tap: the bar and the arrows show or hide (after the time a second tap would have taken)
    tapTimer.current = setTimeout(() => setBars((b) => !b), 280)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    if (!pointers.current.has(e.pointerId)) return
    const at = pointers.current.get(e.pointerId)!
    pointers.current.delete(e.pointerId)
    const L = live.current
    const g = gesture.current
    if (g.kind === 'pinch') {
      // one finger left: it goes on panning from here
      const rest = [...pointers.current.values()][0]
      gesture.current = rest && L.v ? { kind: 'pan', start: rest, view: L.v } : { kind: 'idle' }
      return
    }
    gesture.current = { kind: 'idle' }
    if (stageRef.current && e.pointerType === 'mouse') stageRef.current.style.cursor = L.zoomed ? 'grab' : 'zoom-in'
    if (cancelled) return setSwipe(null)
    if (g.kind === 'press') {
      if (g.touch) return onTap(at)
      // a click: on the picture it zooms in or back out; on the backdrop (or with nothing drawn) it closes
      if (L.v && L.natural && onPicture(L.v, L.natural, at)) L.setView((from, n) => toggleAt(from, at, n, L.stage), true)
      else L.close()
      return
    }
    if (g.kind === 'swipe') {
      const r = swipeResult(at.x - g.start.x, at.y - g.start.y, g.vx, g.vy, L.stage)
      if (r === 'close') return L.close()
      if (r === 'next' && L.next) return L.go(L.next)
      if (r === 'prev' && L.prev) return L.go(L.prev)
      // back where it was, easing
      setPic((q) => ({ ...q, ease: true }))
      setSwipe(null)
    }
  }

  // ---- wheel and Safari's trackpad pinch (native listeners: they must be able to stop the page's own zoom) ----
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const L = live.current
      if (!L.v || !L.natural) return
      const r = el.getBoundingClientRect()
      const at = { x: e.clientX - r.left, y: e.clientY - r.top }
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        L.setView((from, n) => zoomAt(from, wheelScale(from.scale, e.deltaY, e.deltaMode), at, n, L.stage), false)
      } else if (L.zoomed) {
        e.preventDefault()
        const k = e.deltaMode === 1 ? 16 : 1
        L.setView((from, n) => clampView({ scale: from.scale, x: from.x - e.deltaX * k, y: from.y - e.deltaY * k }, n, L.stage), false)
      }
    }
    let base = 1
    type GestureEvt = Event & { scale: number; clientX: number; clientY: number }
    const onGestureStart = (e: Event) => {
      // iOS sends these beside the touch pointers: the pointers' pinch is the one used there
      if (pointers.current.size) return
      e.preventDefault()
      base = live.current.v?.scale ?? 1
    }
    const onGestureChange = (e: Event) => {
      if (pointers.current.size) return
      e.preventDefault()
      const g = e as GestureEvt
      const r = el.getBoundingClientRect()
      const at = { x: g.clientX - r.left, y: g.clientY - r.top }
      live.current.setView((from, n) => zoomAt(from, base * g.scale, at, n, live.current.stage), false)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('gesturestart', onGestureStart)
    el.addEventListener('gesturechange', onGestureChange)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('gesturestart', onGestureStart)
      el.removeEventListener('gesturechange', onGestureChange)
    }
  }, [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    // the page's own shortcuts (⌘K search, ⌘⇧O new chat) wait until it is closed; Esc goes on to the focus trap
    if (e.key !== 'Escape') e.stopPropagation()
    // Tab from the picture's area (where the focus starts, outside the Tab order) goes to the bar's first or last button
    if (e.key === 'Tab' && e.target === stageRef.current) {
      const items = [...root.current!.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')].filter((x) => x.offsetParent !== null)
      const to = e.shiftKey ? items.at(-1) : items[0]
      if (to) {
        e.preventDefault()
        to.focus()
      }
      return
    }
    // ⌘C / Ctrl+C: the picture, unless a text in the viewer is selected
    if (!e.defaultPrevented && copyOn && isCopyKey(e) && !textSelectedIn(root.current)) {
      e.preventDefault()
      copy()
      return
    }
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
    const k = e.key
    if (k === 'ArrowLeft' || k === 'ArrowRight') go(k === 'ArrowLeft' ? prev : next)
    else if (k === '+' || k === '=') step(1)
    else if (k === '-' || k === '_') step(-1)
    else if (k === '0') fit()
    else return
    e.preventDefault()
  }

  const onThumbLoad = (img: HTMLImageElement) => {
    const size = { width: img.naturalWidth, height: img.naturalHeight }
    setPic((q) => (q.entry === cur ? { ...q, thumb: size, ease: false } : q))
  }
  const onOriginalLoad = (img: HTMLImageElement) => {
    const size = { width: img.naturalWidth, height: img.naturalHeight }
    const shown = () =>
      setPic((q) => {
        if (q.entry !== cur) return q
        // a zoomed view keeps what it shows: the same box on the screen, at the original's own size
        const before = layoutSize(q.orig, { width: item.width, height: item.height }, q.thumb)
        const view = q.view && before ? { ...q.view, scale: (q.view.scale * before.width) / size.width } : q.view
        return { ...q, orig: size, state: 'shown', view, ease: false }
      })
    // decoded before it is shown, so the swap from the thumbnail does not blink
    if (typeof img.decode === 'function') void img.decode().catch(() => {}).then(shown)
    else shown()
  }

  const pct = v ? Math.round(v.scale * 100) : null
  const swipeY = swipe?.dy ?? 0
  const fade = stage.height ? Math.max(0.35, 1 - Math.abs(swipeY) / stage.height) : 1
  const browser = clientKind() === 'web'
  const count = list.length > 1 && index >= 0 ? t('viewer.count', { n: index + 1, total: list.length }) : null
  const note = !original && !item.blob ? (thumb ? t('viewer.thumbOnly') : t('viewer.noPicture')) : p.state === 'failed' ? (thumb ? t('viewer.failed') : t('viewer.noPicture')) : null

  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={t('viewer.label', { name: item.name })}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-[55] overflow-hidden text-white select-none"
      data-testid="image-viewer"
      data-zoomed={zoomed ? '' : undefined}
    >
      {/* the page behind shows only while a swipe down is closing it */}
      <div aria-hidden className="absolute inset-0 bg-[#0d0d0c]" style={{ opacity: fade }} />
      <div
        ref={stageRef}
        tabIndex={-1}
        data-autofocus
        className="absolute inset-x-0 top-0 bottom-0 touch-none overflow-hidden outline-none md:top-14"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => onPointerUp(e)}
        onPointerCancel={(e) => onPointerUp(e, true)}
        onContextMenu={onContextMenu}
        data-testid="image-viewer-stage"
      >
        <div
          className={clsx('absolute top-0 left-0 origin-top-left', !ready && 'invisible', p.ease && !swipe && 'transition-transform duration-200 ease-out')}
          style={natural && v ? { width: natural.width, height: natural.height, transform: `translate(${v.x + (swipe?.dx ?? 0)}px, ${v.y + swipeY}px) scale(${v.scale})` } : undefined}
          data-testid="image-viewer-picture"
        >
          {showThumb && (
            <img
              key={`t:${p.id}`}
              ref={thumbEl}
              src={thumb!}
              alt=""
              aria-hidden
              draggable={false}
              onLoad={(e) => onThumbLoad(e.currentTarget)}
              className="pointer-events-none absolute inset-0 size-full"
              data-testid="image-viewer-thumb"
            />
          )}
          {original && p.state !== 'failed' && (
            <img
              key={`o:${p.id}:${original}`}
              ref={origEl}
              src={original}
              alt={item.name}
              draggable={false}
              onLoad={(e) => onOriginalLoad(e.currentTarget)}
              onError={() => setPic((q) => (q.entry === cur ? { ...q, state: 'failed' } : q))}
              className={clsx('absolute inset-0 size-full', p.state !== 'shown' && 'opacity-0')}
              data-testid="image-viewer-original"
              data-state={p.state}
            />
          )}
        </div>
        {(note || (p.state === 'loading' && original)) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-[calc(1rem+var(--safe-bottom))] flex justify-center px-4">
            {note ? (
              <p className="rounded-full bg-black/70 px-3 py-1.5 text-center text-xs text-white/85" role="status" data-testid="image-viewer-note">{note}</p>
            ) : (
              <Loader2 size={18} className="animate-spin text-white/70" aria-label={t('common.loading')} />
            )}
          </div>
        )}
      </div>

      <div
        className={clsx(
          'absolute inset-x-0 top-0 flex items-center gap-1 px-3 transition-opacity md:h-14 md:border-b md:border-white/10 md:bg-[#161615] md:pr-2',
          'max-md:bg-gradient-to-b max-md:from-black/80 max-md:to-transparent max-md:pt-[calc(var(--safe-top)+0.5rem)] max-md:pb-6',
          !bars && 'max-md:invisible max-md:opacity-0',
        )}
        data-testid="image-viewer-bar"
      >
        <Who sender={item.sender} />
        <div className="ml-1.5 min-w-0 flex-1">
          <p className="truncate text-sm font-medium" data-testid="image-viewer-name">{item.name}</p>
          <SentLine sender={item.sender} at={item.at} />
        </div>
        {count && <span className="mx-2 shrink-0 text-xs text-white/70 tabular-nums" data-testid="image-viewer-count">{count}</span>}
        <div className="mr-1 flex shrink-0 items-center max-md:hidden">
          <BarButton label={t('viewer.zoomOut')} onClick={() => step(-1)} disabled={!zoomed} testId="image-viewer-zoom-out">
            <Minus size={16} />
          </BarButton>
          <span className="min-w-11 text-center text-xs text-white/75 tabular-nums" data-testid="image-viewer-zoom">{pct === null ? '' : t('viewer.zoomLevel', { n: pct })}</span>
          <BarButton label={t('viewer.zoomIn')} onClick={() => step(1)} disabled={!v || v.scale >= 3.999} testId="image-viewer-zoom-in">
            <Plus size={16} />
          </BarButton>
        </div>
        {copyOn && (
          <BarButton label={t('common.copy')} onClick={copy} testId="image-viewer-copy">
            <Copy size={18} />
          </BarButton>
        )}
        {item.download && (
          <BarButton label={t('common.download')} onClick={item.download} testId="image-viewer-download">
            <Download size={18} />
          </BarButton>
        )}
        {item.href && browser && p.state !== 'failed' && (
          <Tooltip label={t('viewer.openOriginal')}>
            <a href={item.href} target="_blank" rel="noopener noreferrer" aria-label={t('viewer.openOriginal')} className={BAR_BUTTON} data-testid="image-viewer-open">
              <ExternalLink size={18} aria-hidden />
            </a>
          </Tooltip>
        )}
        <BarButton label={t('common.close')} onClick={close} testId="image-viewer-close">
          <X size={20} />
        </BarButton>
      </div>

      {prev && (
        <EdgeButton side="left" label={t('viewer.prev')} onClick={() => go(prev)} hidden={!bars}>
          <ChevronLeft size={24} />
        </EdgeButton>
      )}
      {next && (
        <EdgeButton side="right" label={t('viewer.next')} onClick={() => go(next)} hidden={!bars}>
          <ChevronRight size={24} />
        </EdgeButton>
      )}
      <p className="sr-only" aria-live="polite">{count ? `${item.name}, ${count}` : item.name}</p>
    </div>
  )
}

const BAR_BUTTON = 'touch-hit inline-flex size-10 shrink-0 items-center justify-center rounded-md text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-35 disabled:hover:bg-transparent max-md:size-11'

function BarButton({ label, onClick, disabled, testId, children }: { label: string; onClick: () => void; disabled?: boolean; testId: string; children: ReactNode }) {
  return (
    <Tooltip label={label}>
      <button type="button" aria-label={label} onClick={onClick} disabled={disabled} className={BAR_BUTTON} data-testid={testId}>
        {children}
      </button>
    </Tooltip>
  )
}

/** a round arrow at the stage's edge (shown and hidden with the bar on a phone) */
function EdgeButton({ side, label, onClick, hidden, children }: { side: 'left' | 'right'; label: string; onClick: () => void; hidden: boolean; children: ReactNode }) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={clsx(
          'absolute top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white/90 transition hover:bg-black/80 hover:text-white md:mt-7',
          side === 'left' ? 'left-3' : 'right-3',
          hidden && 'max-md:invisible max-md:opacity-0',
        )}
        data-testid={`image-viewer-${side === 'left' ? 'prev' : 'next'}`}
      >
        {children}
      </button>
    </Tooltip>
  )
}

/** the sender's picture: a person's, or the AI's mark; nothing for a picture not sent yet */
function Who({ sender }: { sender?: ViewerSender }) {
  const user = useAvatarOf(sender?.kind === 'user' ? sender.user : null)
  if (sender?.kind === 'ai') return <AiFace size={32} />
  if (sender?.kind !== 'user') return null
  return user ? <Avatar user={user} size={32} /> : <span aria-hidden className="size-8 shrink-0 rounded-full bg-white/15" />
}

/** "가나 · 2026. 11. 9. 오후 2:10": who sent it and when, where known */
function SentLine({ sender, at }: { sender?: ViewerSender; at?: string | null }) {
  const t = useT()
  const locale = useLocale()
  const nameOf = useNameOf()
  const who = sender?.kind === 'ai' ? aiName(t) : sender?.kind === 'user' ? (nameOf(sender.user) ?? t('rooms.goneUser')) : null
  const when = at ? formatDateTime(at, locale) : null
  if (!who && !when) return null
  return (
    <p className="truncate text-xs text-white/65" data-testid="image-viewer-sent">
      {who}
      {who && when && ' · '}
      {when && <time dateTime={at!}>{when}</time>}
    </p>
  )
}
