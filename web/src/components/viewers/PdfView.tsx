// PDF preview with pdf.js (react-pdf), every page stacked and fitted to the panel. Ported from Saram.
// `startPage` (an answer's source, a link with &page=N): the panel opens scrolled to that page, and keeps it in view
// while the pages above it are drawn, until the person scrolls themselves.
// A toolbar above the pages zooms in and out (small text on a phone) and goes back to the panel width. A file that
// pdf.js cannot read shows a plain notice and a Download button, never the parser's own message.
import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/TextLayer.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'
// the worker ships as its own hashed file from this server (worker-src 'self')
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { Download, MoveHorizontal, ZoomIn, ZoomOut } from 'lucide-react'
import { useT } from '../../i18n'
import { Button, IconButton } from '../ui'
import { pdfjsDataOptions } from '../../lib/pdfjs-assets'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
// CMaps, standard fonts and the image decoders from this server: without them scanned pages (fax / JBIG2, JPEG 2000)
// are blank and Korean text in fonts the file does not embed is missing. One object for good: react-pdf reloads the
// document when `options` changes.
const OPTIONS = pdfjsDataOptions(location.origin, pdfjs.version)
// zoom steps, as a part of the panel width (1 = the page fits the panel)
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3]

export default function PdfView({ blob, width, startPage, download }: { blob: Blob; width: number; startPage?: number; download: () => void }) {
  const t = useT()
  const [pages, setPages] = useState(0)
  // a blob URL instead of raw bytes: pdf.js detaches ArrayBuffers it hands to its worker
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const u = URL.createObjectURL(blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])
  const holder = useRef<HTMLDivElement>(null)
  const target = startPage && startPage >= 1 && (!pages || startPage <= pages) ? startPage : null
  // follow the target page until the person scrolls (wheel, touch, keys) or the pages above it are all drawn
  const follow = useRef(true)
  const drawn = useRef(new Set<number>())
  useEffect(() => { follow.current = true; drawn.current = new Set() }, [blob, startPage])
  useEffect(() => {
    const el = holder.current
    if (!el || !target) return
    const stop = () => { follow.current = false }
    el.addEventListener('wheel', stop, { passive: true })
    el.addEventListener('touchmove', stop, { passive: true })
    el.addEventListener('keydown', stop)
    return () => { el.removeEventListener('wheel', stop); el.removeEventListener('touchmove', stop); el.removeEventListener('keydown', stop) }
  }, [target, url, pages])
  const drawnPage = (n: number) => {
    if (!target || !follow.current || n > target) return
    drawn.current.add(n)
    holder.current?.querySelector(`[data-page="${target}"]`)?.scrollIntoView({ block: 'start' })
    if (drawn.current.size >= target) follow.current = false
  }
  const [error, setError] = useState(false)
  // the parser's message helps a developer, not the person: it goes to the console only
  const fail = (message: string) => {
    console.warn('PDF preview failed:', message)
    setError(true)
  }
  // the index in ZOOMS; a new file opens at the panel width again
  const [zoom, setZoom] = useState(ZOOMS.indexOf(1))
  useEffect(() => setZoom(ZOOMS.indexOf(1)), [blob])
  const scale = ZOOMS[zoom]

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
        // as wide as the widest page: a page wider than the panel (zoomed in) scrolls to its left edge too
        className="w-max min-w-full"
        onLoadSuccess={({ numPages }) => setPages(numPages)}
        onLoadError={(e) => fail(e.message)}
        loading={<p className="p-6 text-sm text-faint">{t('common.loading')}</p>}
      >
        {pages > 0 && (
          // sticky in the panel's scroll box and as wide as the panel: it stays in view when the pages scroll down or
          // (zoomed in) to the side
          <div role="toolbar" aria-label={t('pdfView.toolbar')} style={{ width }} className="sticky top-0 left-0 z-10 flex items-center justify-center gap-1 border-b border-line bg-surface px-2 py-1" data-testid="pdf-toolbar">
            <IconButton label={t('pdfView.zoomOut')} onClick={() => setZoom((z) => Math.max(0, z - 1))} disabled={zoom === 0} data-testid="pdf-zoom-out">
              <ZoomOut size={16} />
            </IconButton>
            <span className="min-w-12 text-center text-xs text-muted tabular-nums" aria-live="polite" data-testid="pdf-zoom-level">
              {t('pdfView.zoomLevel', { n: Math.round(scale * 100) })}
            </span>
            <IconButton label={t('pdfView.zoomIn')} onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))} disabled={zoom === ZOOMS.length - 1} data-testid="pdf-zoom-in">
              <ZoomIn size={16} />
            </IconButton>
            {/* ↔, not the panel header's ⤢ 크게 보기 (SidePanelFrame PanelExpandButton) right above it */}
            <IconButton label={t('pdfView.fitWidth')} onClick={() => setZoom(ZOOMS.indexOf(1))} disabled={scale === 1} data-testid="pdf-fit-width">
              <MoveHorizontal size={16} />
            </IconButton>
          </div>
        )}
        {/* mx-auto on each page, not items-center: items-center would cut off the left edge of a page wider than the panel.
            scroll-mt-12: a page scrolled into view (startPage) is not hidden under the toolbar */}
        <div ref={holder} className="flex flex-col gap-3 px-4 py-3" data-start-page={target ?? undefined}>
          {Array.from({ length: pages }, (_, i) => (
            <div key={i} data-page={i + 1} className={clsx('mx-auto scroll-mt-12', target === i + 1 ? 'shadow-sm ring-2 ring-accent' : 'shadow-sm ring-1 ring-line')}>
              <Page pageNumber={i + 1} width={Math.round(Math.max(240, width - 32) * scale)} onRenderSuccess={() => drawnPage(i + 1)} />
            </div>
          ))}
        </div>
      </Document>
    </Boundary>
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
