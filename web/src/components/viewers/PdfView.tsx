// PDF preview with pdf.js (react-pdf), the pages stacked and fitted to the panel. Ported from Saram.
// Lazy pages (docs/DECISIONS.md "Lazy PDF pages", the window math in lib/pdfPages.ts): every page has a placeholder of
// its own size (page 1's until pdf.js has read the others', in the background), and only the pages within 1.5 screens
// of the visible part of the scroll box get a canvas and a text layer; pages further away are released, so a 60-page
// file holds a few canvases, and pdf.js is told to drop what it kept for a page that left. A canvas has at most twice
// the screen's pixels, 4,096 px of width and 16.7 megapixels (Safari's limit on iPhone and iPad); beyond, it is scaled.
// Used everywhere a PDF is previewed: the side panel, 크게 보기 and the room file viewer.
// `startPage` (an answer's source, a link with &page=N): the panel opens at that page and keeps it at the top while the
// pages' sizes come in, until the person scrolls themselves. A link inside the file to one of its pages goes there.
// A toolbar above the pages zooms in and out and goes back to the panel width (computers; a phone has no room for it).
// A pinch zooms the pages (live as a transform, then drawn at the new width) and a double tap goes between the width
// and 200 %, the point under the fingers staying put (lib/usePinch.ts: the app itself does not zoom, QA TC-259). The
// place being read stays at the top when the pages change size otherwise (the buttons, a wider panel).
// `thumbnails` (the room file viewer, components/ViewerDocument.tsx): an element beside the scroll box for a rail of
// small page pictures, for more than one page; the viewer gives it only where its stage has room for the rail and a
// readable document (lib/imageViewer.ts pdfRailFits), never on a phone. They are drawn as they come into the rail's
// view, the current page is marked and kept in view as the pages scroll, and a click (or ↑ ↓ Home End on one) goes to
// that page; the toolbar then says where the reader is ("3 / 60").
// A file that pdf.js cannot read shows a plain notice and a Download button, never the parser's own message.
import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { Document, Page, pdfjs } from 'react-pdf'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import 'react-pdf/dist/Page/TextLayer.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'
// the worker ships as its own hashed file from this server (worker-src 'self')
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { Download, MoveHorizontal, ZoomIn, ZoomOut } from 'lucide-react'
import { useT } from '../../i18n'
import { Button, IconButton } from '../ui'
import { pdfjsDataOptions } from '../../lib/pdfjs-assets'
import { clamp, usePinch, type Pt } from '../../lib/usePinch'
import { anchorAt, anchorTop, currentPage, layoutTop, pageHeight, pageLayout, pageStart, pageWindow, type PageAnchor, type PageSize, type PageView } from '../../lib/pdfPages'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
// CMaps, standard fonts and the image decoders from this server: without them scanned pages (fax / JBIG2, JPEG 2000)
// are blank and Korean text in fonts the file does not embed is missing. One object for good: react-pdf reloads the
// document when `options` changes.
const OPTIONS = pdfjsDataOptions(location.origin, pdfjs.version)
// zoom steps of the buttons, as a part of the panel width (1 = the page fits the panel); a pinch goes anywhere between
// the first and the last
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3]
/** a double tap's zoom, from the width */
const TAP_ZOOM = 2
/** the widest canvas drawn, in device pixels: zoomed in beyond it, the page is scaled */
const MAX_CANVAS = 4096
/** the largest canvas, in device pixels: Safari on iPhone and iPad draws nothing on a larger one (a long receipt) */
const MAX_PIXELS = 16_777_216
/** the rail's page pictures, px wide */
const THUMB_W = 96
/** pages whose size pdf.js reads at once, after the first */
const SIZE_BATCH = 16

const sizeOf = (page: PDFPageProxy): PageSize => {
  const v = page.getViewport({ scale: 1 })
  return { width: v.width, height: v.height }
}

/** Each page's size at scale 1: all page 1's at first, then each its own as pdf.js reads them in the background, or as
 * a drawn page reports it (`note`). A document whose first page cannot be read calls `onError`. */
function usePageSizes(pdf: PDFDocumentProxy | null, onError: (message: string) => void) {
  const [sizes, setSizes] = useState<PageSize[]>([])
  const all = useRef<PageSize[]>([])
  const put = (next: PageSize[]) => {
    all.current = next
    setSizes(next)
  }
  const note = useCallback((i: number, page: PDFPageProxy) => {
    const s = sizeOf(page)
    const was = all.current[i]
    if (!was || (was.width === s.width && was.height === s.height)) return
    const next = all.current.slice()
    next[i] = s
    put(next)
  }, [])
  useEffect(() => {
    put([])
    if (!pdf) return
    let live = true
    const read = async () => {
      let first: PageSize
      try {
        first = sizeOf(await pdf.getPage(1))
      } catch (e) {
        if (live) onError(e instanceof Error ? e.message : String(e))
        return
      }
      if (!live) return
      put(Array.from({ length: pdf.numPages }, () => first))
      for (let from = 2; from <= pdf.numPages; from += SIZE_BATCH) {
        // a page pdf.js cannot read keeps page 1's size (drawing it shows the notice); the others go on
        const got = await Promise.allSettled(Array.from({ length: Math.min(SIZE_BATCH, pdf.numPages - from + 1) }, (_, k) => pdf.getPage(from + k)))
        if (!live) return
        let next: PageSize[] | null = null
        got.forEach((r, k) => {
          if (r.status !== 'fulfilled') return
          const s = sizeOf(r.value)
          const i = from - 1 + k
          if (s.width !== all.current[i].width || s.height !== all.current[i].height) (next ??= all.current.slice())[i] = s
        })
        if (next) put(next)
      }
    }
    read().catch((e: unknown) => console.warn('PDF page sizes:', e instanceof Error ? e.message : e))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf])
  return { sizes, note }
}

/** The nearest ancestor that scrolls up and down: the side panel's body, the viewer's column. */
function scrollBox(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY
    if (y === 'auto' || y === 'scroll') return p
  }
  return null
}

export default function PdfView({ blob, width, startPage, download, thumbnails }: { blob: Blob; width: number; startPage?: number; download: () => void; thumbnails?: HTMLElement | null }) {
  const t = useT()
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const pages = pdf?.numPages ?? 0
  // a blob URL instead of raw bytes: pdf.js detaches ArrayBuffers it hands to its worker
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const u = URL.createObjectURL(blob)
    setUrl(u)
    setPdf(null)
    // revoked a moment later: closed while it loads, pdf.js may still start reading it as its loading task is dropped,
    // and the browser reports that read as an error
    return () => void setTimeout(() => URL.revokeObjectURL(u), 1000)
  }, [blob])
  const target = startPage && startPage >= 1 && (!pages || startPage <= pages) ? startPage : null
  const [error, setError] = useState(false)
  // the parser's message helps a developer, not the person: it goes to the console only
  const fail = (message: string) => {
    console.warn('PDF preview failed:', message)
    setError(true)
  }
  // a part of the panel width; a new file opens at the panel width again
  const [scale, setScale] = useState(1)
  useEffect(() => setScale(1), [blob])
  const pageWidth = Math.round(Math.max(240, width - 32) * scale)
  const { sizes, note } = usePageSizes(pdf, fail)
  const layout = useMemo(() => pageLayout(sizes, pageWidth), [sizes, pageWidth])

  // ---- what is in view: the pages drawn and the current one (lib/pdfPages.ts) ----
  const holder = useRef<HTMLDivElement>(null)
  /** a pinch in progress: where the fingers came down (client coordinates), the transform's origin */
  const pinchAt = useRef<Pt | null>(null)
  /** a pinch's live transform on the holder: its origin (px below the holder's layout top) and scale */
  const live = useRef<{ origin: number; k: number } | null>(null)
  /** the holder's top in the layout (client y), whatever a pinch's live transform draws: what the view is measured on */
  const holderTop = (h: HTMLElement) => {
    const top = h.getBoundingClientRect().top
    return live.current ? layoutTop(top, live.current.origin, live.current.k) : top
  }
  /** a pinch's live transform gone */
  const clearLive = () => {
    live.current = null
    const h = holder.current
    if (h) h.style.transform = h.style.transformOrigin = ''
  }
  const bar = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => setBox(pages ? scrollBox(holder.current) : null), [pages])
  const [shown, setShown] = useState({ first: 0, last: -1, current: 0 })
  const laidOut = useRef({ layout, pageWidth })
  // the place being read, kept when the pages change size
  const anchor = useRef<PageAnchor | null>(null)
  // a pinch or double tap that changed the zoom: the point under the fingers (client coordinates), kept in place when
  // the pages are laid out at the new width
  const focus = useRef<Pt | null>(null)
  // a page gone to (the start page, a thumbnail, a link in the file) is the current one and stays at the top until the
  // person scrolls: the box is no longer where it was put
  const pinned = useRef<{ page: number; top: number } | null>(null)
  // the part of the page column in view: under the toolbar stuck at the top of the box
  const viewOf = useCallback((): PageView | null => {
    const h = holder.current
    if (!box || !h) return null
    const sticky = bar.current?.offsetHeight ?? 0
    return { top: box.getBoundingClientRect().top + box.clientTop + sticky - holderTop(h), height: Math.max(0, box.clientHeight - sticky) }
  }, [box])
  const update = useCallback(() => {
    const v = viewOf()
    if (!v || !box) return
    const { layout: now } = laidOut.current
    if (pinned.current && Math.abs(box.scrollTop - pinned.current.top) > 1) pinned.current = null
    if (!pinned.current) anchor.current = anchorAt(now, v.top)
    const w = pageWindow(now, v)
    const current = pinned.current?.page ?? currentPage(now, v)
    setShown((s) => (s.first === w.first && s.last === w.last && s.current === current ? s : { ...w, current }))
  }, [box, viewOf])
  /** scrolls so that the view's top is at `top` (the page column's coordinates); not by less than a pixel, which on
   * a phone would stop a flick for nothing (pages below the view changed size) */
  const scrollTo = useCallback((top: number) => {
    const v = viewOf()
    if (v && box && Math.abs(top - v.top) >= 1) box.scrollTop += top - v.top
  }, [box, viewOf])
  const goTo = useCallback((page: number) => {
    if (!box || page < 0 || page >= laidOut.current.layout.tops.length) return
    anchor.current = pageStart(laidOut.current.layout, page)
    scrollTo(anchorTop(laidOut.current.layout, anchor.current))
    pinned.current = { page, top: box.scrollTop }
    update()
  }, [box, scrollTo, update])
  // react-pdf keeps the first onItemClick it is given (when nothing is laid out yet): it calls the latest goTo through this
  const goToNow = useRef(goTo)
  goToNow.current = goTo
  // the pages changed size (zoom, the panel's width, a page's own size known): the place being read stays at the top,
  // and the middle of a zoomed page stays in the middle
  useLayoutEffect(() => {
    const before = laidOut.current
    laidOut.current = { layout, pageWidth }
    if (!box) return
    // a pinch's point: from the box's top and left; otherwise the top and the middle
    const at = focus.current
    focus.current = null
    // a pinch's live transform goes now that the pages are drawn at its width (not before: a frame at the old size);
    // not while the fingers are still down (a page's size read meanwhile): the next move would draw it from the wrong
    // origin and the view be measured without it
    if (!pinchAt.current) clearLive()
    const r = box.getBoundingClientRect()
    const dy = at ? at.y - (r.top + box.clientTop + (bar.current?.offsetHeight ?? 0)) : 0
    const dx = at ? at.x - (r.left + box.clientLeft) : box.clientWidth / 2
    if (before.layout !== layout && anchor.current) {
      scrollTo(anchorTop(layout, anchor.current) - dy)
      if (pinned.current) pinned.current.top = box.scrollTop
    }
    if (before.pageWidth !== pageWidth && box.scrollWidth > box.clientWidth) box.scrollLeft = (box.scrollLeft + dx) * (pageWidth / before.pageWidth) - dx
    update()
  }, [layout, pageWidth, box, scrollTo, update])
  // the start page, once the pages are laid out; again for another start page of the same file
  const ready = layout.tops.length > 0
  useLayoutEffect(() => {
    if (target && ready) goTo(target - 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, ready, box, pdf])
  // scrolling and a box of another height move the window, a frame at a time
  useEffect(() => {
    if (!box) return
    let frame = 0
    const later = () => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0
        update()
      })
    }
    box.addEventListener('scroll', later, { passive: true })
    const ro = new ResizeObserver(later)
    ro.observe(box)
    return () => {
      box.removeEventListener('scroll', later)
      ro.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [box, update])

  /** zooms to `to` (within the steps' ends), keeping `at` (client coordinates) where it is; false: no change */
  const zoomTo = (to: number, at: Pt) => {
    const next = clamp(to, ZOOMS[0]!, ZOOMS.at(-1)!)
    const v = viewOf()
    if (Math.abs(next - scale) < 0.01 || !v || !box) return false
    const r = box.getBoundingClientRect()
    // the place under the fingers, kept by the layout effect above
    pinned.current = null
    anchor.current = anchorAt(laidOut.current.layout, v.top + at.y - (r.top + box.clientTop + (bar.current?.offsetHeight ?? 0)))
    focus.current = at
    setScale(next)
    return true
  }
  // the pinch: the pages follow the fingers as a transform (cheap) around the point where they came down, and are
  // drawn at the new width when they lift
  usePinch(pages ? box : null, {
    onPinch: ({ scale: k, center, phase }) => {
      const h = holder.current
      if (!h) return
      if (phase === 'start') {
        // the holder's own box (a transform does not move it in the layout): a previous pinch's not cleared yet is reset
        clearLive()
        const r = h.getBoundingClientRect()
        pinchAt.current = center
        live.current = { origin: center.y - r.top, k: 1 }
        h.style.transformOrigin = `${center.x - r.left}px ${center.y - r.top}px`
        return
      }
      const at = pinchAt.current ?? center
      const by = clamp(scale * k, ZOOMS[0]!, ZOOMS.at(-1)!) / scale
      if (phase === 'end') {
        pinchAt.current = null
        // the place under the fingers is measured in the layout (viewOf), the transform still drawn until the pages
        // are at the new width; no change (at an end of the steps): nothing is drawn again, so the transform goes now
        if (!zoomTo(scale * by, at)) clearLive()
        return
      }
      if (live.current) live.current.k = by
      h.style.transform = `scale(${by})`
    },
    onDoubleTap: (at) => zoomTo(scale < (1 + TAP_ZOOM) / 2 ? TAP_ZOOM : 1, at),
  })
  /** the buttons: the next step out or in from where a pinch left it */
  const stepOut = [...ZOOMS].reverse().find((z) => z < scale - 0.001)
  const stepIn = ZOOMS.find((z) => z > scale + 0.001)

  const rail = thumbnails && pages > 1 ? thumbnails : null
  // a page's canvas, in device pixels per CSS pixel: the screen's (2 at most), within the width and area limits
  const ratioFor = (height: number) => Math.min(window.devicePixelRatio || 1, 2, MAX_CANVAS / pageWidth, Math.sqrt(MAX_PIXELS / (pageWidth * height)))

  // the same notice and button as a format with no preview (FileBody "preview-unsupported")
  if (error)
    return (
      <div className="flex flex-col items-start gap-3 p-6" data-testid="preview-unsupported">
        <p className="text-sm text-muted">{t('pdfView.cantOpen')}</p>
        <Button variant="primary" onClick={download} data-testid="preview-unsupported-download">
          <Download size={16} aria-hidden /> {t('common.download')}
        </Button>
      </div>
    )
  if (!url) return null
  return (
    <Boundary onError={fail}>
      <Document
        file={url}
        options={OPTIONS}
        // as wide as the widest page: a page wider than the panel (zoomed in) scrolls to its left edge too. No scroll
        // anchoring: the place being read is kept here (the browser's would fight it while pages change size)
        className="w-max min-w-full [overflow-anchor:none]"
        onLoadSuccess={setPdf}
        onLoadError={(e) => fail(e.message)}
        // a link in the file to one of its pages: the page may not be drawn, so it is scrolled to here
        onItemClick={({ pageNumber }) => goToNow.current(pageNumber - 1)}
        loading={<p className="p-6 text-sm text-faint">{t('common.loading')}</p>}
      >
        {pages > 0 && (
          // sticky in the panel's scroll box and as wide as the panel: it stays in view when the pages scroll down or
          // (zoomed in) to the side. Phones (narrow and touch; no thumbnails there) pinch instead: no toolbar. A narrow
          // window with a mouse keeps it
          <div ref={bar} role="toolbar" aria-label={t('pdfView.toolbar')} style={{ width }} className="sticky top-0 left-0 z-10 flex max-md:pointer-coarse:hidden items-center justify-center gap-1 border-b border-line bg-surface px-2 py-1" data-testid="pdf-toolbar">
            {rail && (
              <span className="mr-2 min-w-14 shrink-0 border-r border-line pr-3 text-center text-xs whitespace-nowrap text-muted tabular-nums" data-testid="pdf-page-info">
                {t('pdfView.pageOf', { n: shown.current + 1, total: pages })}
              </span>
            )}
            <IconButton label={t('pdfView.zoomOut')} onClick={() => stepOut !== undefined && setScale(stepOut)} disabled={stepOut === undefined} data-testid="pdf-zoom-out">
              <ZoomOut size={16} />
            </IconButton>
            <span className="min-w-12 text-center text-xs text-muted tabular-nums" aria-live="polite" data-testid="pdf-zoom-level">
              {t('pdfView.zoomLevel', { n: Math.round(scale * 100) })}
            </span>
            <IconButton label={t('pdfView.zoomIn')} onClick={() => stepIn !== undefined && setScale(stepIn)} disabled={stepIn === undefined} data-testid="pdf-zoom-in">
              <ZoomIn size={16} />
            </IconButton>
            {/* ↔, not the panel header's ⤢ 크게 보기 (SidePanelFrame PanelExpandButton) right above it */}
            <IconButton label={t('pdfView.fitWidth')} onClick={() => setScale(1)} disabled={scale === 1} data-testid="pdf-fit-width">
              <MoveHorizontal size={16} />
            </IconButton>
          </div>
        )}
        {/* mx-auto on each page, not items-center: items-center would cut off the left edge of a page wider than the
            panel. Each page is a placeholder of its size; the pages near the view draw in it (data-drawn) */}
        {pages > 0 && (
          // data-keeps-place: the side panel leaves the scroll position to it when its width changes (FilePanel)
          <div ref={holder} className="flex flex-col gap-3 px-4 py-3" data-start-page={target ?? undefined} data-current-page={ready ? shown.current + 1 : undefined} data-keeps-place="">
            {layout.heights.map((h, i) => {
              const drawn = i >= shown.first && i <= shown.last
              return (
                <div key={i} data-page={i + 1} data-drawn={drawn ? '' : undefined} style={{ width: pageWidth, height: h }} className={clsx('mx-auto shrink-0 bg-white', target === i + 1 ? 'shadow-sm ring-2 ring-accent' : 'shadow-sm ring-1 ring-line')}>
                  {/* read in an effect, not through Suspense: a page coming into view shows its blank placeholder,
                      not the whole file's "loading", and is not held back by React's reveal throttle (~300 ms) */}
                  {drawn && <LeanPage pageNumber={i + 1} width={pageWidth} devicePixelRatio={ratioFor(h)} suspense={false} loading={null} error={null} onLoadSuccess={(p) => note(i, p)} onLoadError={(e) => fail(e.message)} onRenderError={(e) => fail(e.message)} />}
                </div>
              )
            })}
          </div>
        )}
        {rail && createPortal(<Thumbnails sizes={sizes} current={shown.current} onPick={goTo} />, rail)}
      </Document>
    </Boundary>
  )
}

/** react-pdf's Page, which tells pdf.js to drop what it kept for the page (its drawing commands, decoded pictures) when
 * it leaves; react-pdf itself only releases the canvas. pdf.js waits while a drawing of the same page still runs (the
 * page and its thumbnail share it). */
function LeanPage({ onLoadSuccess, ...props }: ComponentProps<typeof Page>) {
  const loaded = useRef<PDFPageProxy | null>(null)
  useEffect(() => () => void loaded.current?.cleanup(), [])
  return (
    <Page
      {...props}
      onLoadSuccess={(p) => {
        loaded.current = p
        onLoadSuccess?.(p)
      }}
    />
  )
}

/** The items of `list` (by `data-thumb`, 1-based) within a list's height of its view, as 0-based indexes. */
function useNearItems(list: RefObject<HTMLElement | null>, count: number): ReadonlySet<number> {
  const [near, setNear] = useState<ReadonlySet<number>>(() => new Set())
  useEffect(() => {
    const root = list.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) =>
        setNear((was) => {
          const next = new Set(was)
          for (const e of entries) {
            const i = Number((e.target as HTMLElement).dataset.thumb) - 1
            if (e.isIntersecting) next.add(i)
            else next.delete(i)
          }
          return next
        }),
      { root, rootMargin: '100% 0px' },
    )
    root.querySelectorAll('[data-thumb]').forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [list, count])
  return near
}

/** The rail of page pictures (the room file viewer, computers): one Tab stop, the current page's; ↑ ↓ Home End go to
 * the page before, after, the first and the last. A button is named by the page number it shows (in the list named
 * "페이지 목록"). No text or link layer, and not a target of the file's own links. */
function Thumbnails({ sizes, current, onPick }: { sizes: PageSize[]; current: number; onPick: (page: number) => void }) {
  const t = useT()
  const list = useRef<HTMLElement>(null)
  const near = useNearItems(list, sizes.length)
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  // the current page's picture stays in the rail's view as the pages scroll: once it would leave it, it is centred
  useEffect(() => {
    const el = list.current
    const item = el?.querySelector<HTMLElement>(`[data-thumb="${current + 1}"]`)
    if (!el || !item) return
    if (item.offsetTop < el.scrollTop || item.offsetTop + item.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = item.offsetTop - (el.clientHeight - item.offsetHeight) / 2
  }, [current])
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? sizes.length - 1 : null
    if (to === null || e.altKey || e.ctrlKey || e.metaKey) return
    e.preventDefault()
    const page = Math.max(0, Math.min(sizes.length - 1, to))
    onPick(page)
    list.current?.querySelector<HTMLElement>(`[data-thumb="${page + 1}"] button`)?.focus({ preventScroll: true })
  }
  return (
    // a touch on the rail is the rail's: React would pass it on (through the portal) to the column's swipe, which steps
    <nav ref={list} aria-label={t('pdfView.pages')} onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()} className="relative h-full w-32 overflow-y-auto overscroll-contain px-2.5 py-2 [scrollbar-width:thin]" data-testid="pdf-thumbnails">
      <ol className="flex flex-col gap-1">
        {sizes.map((s, i) => (
          <li key={i} data-thumb={i + 1}>
            <button
              type="button"
              tabIndex={i === current ? 0 : -1}
              aria-current={i === current ? 'page' : undefined}
              onClick={() => onPick(i)}
              onKeyDown={(e) => onKeyDown(e, i)}
              // the current page: a light box behind its picture and number, as in a desktop PDF reader's sidebar
              className={clsx('flex w-full flex-col items-center gap-1.5 rounded-md p-1.5 transition-colors', i === current ? 'bg-white/15' : 'hover:bg-white/5')}
              data-testid="pdf-thumb"
            >
              <span style={{ width: THUMB_W, height: pageHeight(s, THUMB_W) }} className="block overflow-hidden bg-white ring-1 ring-white/10">
                {near.has(i) && <LeanPage pageNumber={i + 1} width={THUMB_W} devicePixelRatio={ratio} suspense={false} loading={null} error={null} renderTextLayer={false} renderAnnotationLayer={false} _className="react-pdf__Thumbnail__page" _enableRegisterUnregisterPage={false} />}
              </span>
              <span className={clsx('text-xs tabular-nums', i === current ? 'font-medium text-white' : 'text-white/60')}>{i + 1}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}

class Boundary extends Component<{ onError: (message: string) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: Error) {
    this.props.onError(error.message || String(error))
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}
