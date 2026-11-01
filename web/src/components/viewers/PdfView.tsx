// PDF preview with pdf.js (react-pdf), every page stacked and fitted to the panel. Ported from Saram.
// `startPage` (an answer's source, a link with &page=N): the panel opens scrolled to that page, and keeps it in view
// while the pages above it are drawn, until the person scrolls themselves.
import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/TextLayer.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'
// the worker ships as its own hashed file from this server (worker-src 'self')
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useT } from '../../i18n'
import { pdfjsDataOptions } from '../../lib/pdfjs-assets'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
// CMaps, standard fonts and the image decoders from this server: without them scanned pages (fax / JBIG2, JPEG 2000)
// are blank and Korean text in fonts the file does not embed is missing. One object for good: react-pdf reloads the
// document when `options` changes.
const OPTIONS = pdfjsDataOptions(location.origin, pdfjs.version)

export default function PdfView({ blob, width, startPage }: { blob: Blob; width: number; startPage?: number }) {
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
  const [error, setError] = useState<string | null>(null)

  if (error) return <p className="p-6 text-sm text-danger">{t('preview.cantOpen', { what: 'PDF', error })}</p>
  if (!url) return null
  return (
    <Boundary onError={setError}>
      <Document
        file={url}
        options={OPTIONS}
        onLoadSuccess={({ numPages }) => setPages(numPages)}
        onLoadError={(e) => setError(e.message)}
        loading={<p className="p-6 text-sm text-faint">{t('common.loading')}</p>}
      >
        <div ref={holder} className="flex flex-col items-center gap-3 py-3" data-start-page={target ?? undefined}>
          {Array.from({ length: pages }, (_, i) => (
            <div key={i} data-page={i + 1} className={target === i + 1 ? 'shadow-sm ring-2 ring-accent' : 'shadow-sm ring-1 ring-line'}>
              <Page pageNumber={i + 1} width={Math.max(240, width - 32)} onRenderSuccess={() => drawnPage(i + 1)} />
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
