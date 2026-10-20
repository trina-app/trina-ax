// File preview next to the chat or the file screen: PDF, Word, PowerPoint, Excel/CSV, Markdown, text/code, HTML/SVG
// (isolated frame), images, audio/video. Bytes come from /api/files/download (always an attachment with a sandbox
// CSP on the server side) and are drawn here; HTML/SVG only run in the sandbox frame (SandboxFrame, /sandbox/frame),
// never as srcdoc or a blob: page of this origin.
import { Download, FileText, FolderOpen, Loader2, X } from 'lucide-react'
import Papa from 'papaparse'
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchFileBlob, fileUrl, isApiError, PreviewTooLargeError, saveBlob, startDownload, errorText } from '../lib/api'
import { wrapHtml } from '../lib/artifacts'
import { formatSize } from '../lib/format'
import { parentPath } from '../lib/paths'
import { languageOf, previewKind, previewLimit, PREVIEW_TEXT_MAX, type PreviewKind } from '../lib/preview'
import type { PreviewFile } from '../lib/sidePanel'
import { useLocale, useT } from '../i18n'
import { CodeBlock, Markdown } from './Markdown'
import SandboxFrame from './SandboxFrame'
import { IconButton } from './ui'

const PdfView = lazy(() => import('./viewers/PdfView'))
const DocxView = lazy(() => import('./viewers/OfficeView').then((m) => ({ default: m.DocxView })))
const PptxView = lazy(() => import('./viewers/OfficeView').then((m) => ({ default: m.PptxView })))
const SheetView = lazy(() => import('./viewers/OfficeView').then((m) => ({ default: m.SheetView })))

const MAX_TEXT = PREVIEW_TEXT_MAX

export default function FilePanel({ file, onClose }: { file: PreviewFile; onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  const [blob, setBlob] = useState<Blob | null>(file.source === 'local' ? file.blob : null)
  const [error, setError] = useState<{ kind: 'missing' | 'large' | 'other'; text: string } | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  const kind = previewKind(file.name)

  useEffect(() => {
    if (file.source === 'local') return
    let live = true
    const ctrl = new AbortController()
    setBlob(null)
    setError(null)
    if (!kind) return
    const limit = previewLimit(kind)
    fetchFileBlob(file.path, limit.max, ctrl.signal, { truncate: limit.truncate }).then(
      (b) => live && setBlob(b),
      (e: unknown) => {
        if (!live) return
        if (e instanceof PreviewTooLargeError) setError({ kind: 'large', text: t('preview.tooLarge', { size: formatSize(e.size, locale) }) })
        else if (isApiError(e, 'not_found')) setError({ kind: 'missing', text: t('preview.notFound') })
        else setError({ kind: 'other', text: errorText(e, locale, t('error.network')) })
      },
    )
    return () => {
      live = false
      ctrl.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file])

  useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const download = () => (file.source === 'team' ? startDownload(fileUrl(file.path), file.name) : saveBlob(file.blob, file.name))

  return (
    <aside aria-label={t('preview.panel')} className="flex h-full min-w-0 flex-col bg-surface" data-testid="file-panel">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <FileText size={16} className="shrink-0 text-muted" aria-hidden />
        <h2 className="min-w-0 truncate text-sm font-semibold" title={file.source === 'team' ? file.path : file.name}>
          {file.name}
        </h2>
        <div className="ml-auto flex shrink-0 items-center">
          {file.source === 'team' && (
            <IconButton label={t('preview.openInFiles')} onClick={() => navigate(`/files?path=${encodeURIComponent(parentPath(file.path))}&select=${encodeURIComponent(file.name)}`)}>
              <FolderOpen size={16} />
            </IconButton>
          )}
          {error?.kind !== 'missing' && (
            <IconButton label={t('common.download')} onClick={download}>
              <Download size={16} />
            </IconButton>
          )}
          <IconButton label={t('common.close')} onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
      </header>
      <div ref={body} className="min-h-0 flex-1 overflow-auto bg-subtle/50">
        {!kind ? (
          <p className="p-6 text-sm text-muted">{t('preview.unsupported')}</p>
        ) : error ? (
          <p className={error.kind === 'other' ? 'p-6 text-sm text-danger' : 'p-6 text-sm text-muted'} role="alert">
            {error.text}
          </p>
        ) : !blob ? (
          <p className="flex items-center gap-2 p-6 text-sm text-faint">
            <Loader2 size={14} className="animate-spin" aria-hidden /> {t('common.loading')}
          </p>
        ) : (
          <Suspense fallback={<p className="p-6 text-sm text-faint">{t('common.loading')}</p>}>
            <Viewer kind={kind} blob={blob} width={width} name={file.name} />
          </Suspense>
        )}
      </div>
    </aside>
  )
}

function Viewer({ kind, blob, width, name }: { kind: PreviewKind; blob: Blob; width: number; name: string }) {
  switch (kind) {
    case 'pdf':
      return <PdfView blob={blob} width={width} />
    case 'docx':
      return <DocxView blob={blob} />
    case 'pptx':
      return <PptxView blob={blob} width={width} />
    case 'sheet':
      return <SheetView blob={blob} />
    case 'image':
    case 'audio':
    case 'video':
      return <MediaView kind={kind} blob={blob} name={name} />
    default:
      return <TextKinds kind={kind} blob={blob} name={name} />
  }
}

function MediaView({ kind, blob, name }: { kind: 'image' | 'audio' | 'video'; blob: Blob; name: string }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  if (kind === 'audio')
    return (
      <div className="p-6">
        <audio controls src={url} className="w-full" aria-label={name} />
      </div>
    )
  if (kind === 'video')
    return (
      <div className="p-4">
        <video controls src={url} className="max-h-[80vh] w-full rounded" aria-label={name} />
      </div>
    )
  return (
    <div className="flex justify-center p-4">
      <img src={url} alt={name} className="max-w-full rounded shadow-sm" />
    </div>
  )
}

function TextKinds({ kind, blob, name }: { kind: PreviewKind; blob: Blob; name: string }) {
  const t = useT()
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    blob.slice(0, MAX_TEXT).text().then((v) => live && setText(v))
    return () => {
      live = false
    }
  }, [blob])
  if (text === null) return null
  const cut = blob.size > MAX_TEXT && <p className="px-4 pb-4 text-xs text-faint">{t('preview.truncated')}</p>
  if (kind === 'markdown')
    return (
      <div className="mx-auto max-w-3xl bg-surface p-6">
        <Markdown text={text} />
        {cut}
      </div>
    )
  if (kind === 'html') return <SandboxFrame html={wrapHtml(text, location.origin)} title={name} className="h-full min-h-[70vh] w-full border-0 bg-white" />
  if (kind === 'svg') return <SandboxFrame html={wrapHtml(`<div style="display:grid;place-items:center;min-height:100vh">${text}</div>`, location.origin)} title={name} className="h-full min-h-[70vh] w-full border-0 bg-white" />
  if (kind === 'csv') {
    const rows = Papa.parse<string[]>(text, { skipEmptyLines: true, delimiter: name.toLowerCase().endsWith('.tsv') ? '\t' : '' }).data.slice(0, 2000)
    return (
      <div className="overflow-auto p-3">
        <table className="border-collapse bg-surface text-xs">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={i === 0 ? 'bg-subtle font-semibold' : ''}>
                {r.map((c, j) => (
                  <td key={j} className="border border-line px-2 py-1 whitespace-nowrap">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {cut}
      </div>
    )
  }
  if (kind === 'text' && /\.(txt|log)$/i.test(name))
    return (
      <>
        <pre className="m-0 overflow-auto bg-surface p-4 font-mono text-[12.5px] leading-5 whitespace-pre-wrap text-ink">{text}</pre>
        {cut}
      </>
    )
  // code, json, xml: highlighted, escaped text (XML is never rendered as a document)
  return (
    <div className="p-3">
      <CodeBlock lang={languageOf(name) ?? null} code={text} />
      {cut}
    </div>
  )
}
