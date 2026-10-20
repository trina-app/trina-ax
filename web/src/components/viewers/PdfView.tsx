// PDF preview with pdf.js (react-pdf), every page stacked and fitted to the panel. Ported from Saram.
import { Component, useEffect, useState, type ReactNode } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/TextLayer.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import { useT } from '../../i18n'

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

export default function PdfView({ blob, width }: { blob: Blob; width: number }) {
  const t = useT()
  const [pages, setPages] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // a blob URL instead of raw bytes: pdf.js detaches ArrayBuffers it hands to its worker
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const u = URL.createObjectURL(blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])

  if (error) return <p className="p-6 text-sm text-danger">{t('preview.cantOpen', { what: 'PDF', error })}</p>
  if (!url) return null
  return (
    <Boundary onError={setError}>
      <Document
        file={url}
        onLoadSuccess={({ numPages }) => setPages(numPages)}
        onLoadError={(e) => setError(e.message)}
        loading={<p className="p-6 text-sm text-faint">{t('common.loading')}</p>}
      >
        <div className="flex flex-col items-center gap-3 py-3">
          {Array.from({ length: pages }, (_, i) => (
            <div key={i} className="shadow-sm ring-1 ring-line">
              <Page pageNumber={i + 1} width={Math.max(240, width - 32)} />
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
