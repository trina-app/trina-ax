// File preview next to the chat or the file screen: PDF, Word, PowerPoint, Excel/CSV, Markdown, text/code, HTML/SVG
// (isolated frame), images, audio/video. Bytes come from /api/files/download (always an attachment with a sandbox
// CSP on the server side) and are drawn here; HTML/SVG only run in the sandbox frame (SandboxFrame, /sandbox/frame),
// never as srcdoc or a blob: page of this origin.
// Text files the person may write can be fixed in place (tab 5 "텍스트 파일 고치기"): the editor keeps the sha256 it
// loaded and saves with it as baseSha256 (PUT /api/files/content); when someone changed the file in between, the
// server keeps their version and saves this one as a conflict copy, which the panel then opens.
import clsx from 'clsx'
import { Download, FileText, FolderOpen, Loader2, Paperclip, Pencil, Sparkles, X } from 'lucide-react'
import Papa from 'papaparse'
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api, API, fetchFileBlob, fetchServerPreview, fileUrl, isApiError, PreviewTooLargeError, saveBlob, startDownload, errorText } from '../lib/api'
import { wrapHtml } from '../lib/artifacts'
import { useFrameScripts } from '../lib/confidential'
import { formatSize } from '../lib/format'
import { parentPath } from '../lib/paths'
import { decodePreviewText, languageOf, previewKind, previewLimit, PREVIEW_TEXT_MAX, serverPreview, type PreviewKind } from '../lib/preview'
import { openTeamFile, type PreviewFile } from '../lib/sidePanel'
import { TEAM_FILE_DRAG_TYPE } from '../lib/teamAttach'
import { useTeamAttach } from '../lib/useTeamAttach'
import { useLocale, useT } from '../i18n'
import { CodeBlock, Markdown } from './Markdown'
import SandboxFrame, { StaticFrame } from './SandboxFrame'
import { toast } from '../store/ui'
import { Button, confirmDialog, IconButton } from './ui'

const HwpView = lazy(() => import('./viewers/HwpView'))
const PdfView = lazy(() => import('./viewers/PdfView'))
const DocxView = lazy(() => import('./viewers/OfficeView').then((m) => ({ default: m.DocxView })))
const PptxView = lazy(() => import('./viewers/OfficeView').then((m) => ({ default: m.PptxView })))
const SheetView = lazy(() => import('./viewers/OfficeView').then((m) => ({ default: m.SheetView })))

const MAX_TEXT = PREVIEW_TEXT_MAX
/** kinds the panel can edit as plain text */
const EDITABLE: PreviewKind[] = ['markdown', 'text', 'csv', 'html', 'svg', 'xml']

export default function FilePanel({ file, onClose }: { file: PreviewFile; onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  const chatAttach = useTeamAttach()
  const [blob, setBlob] = useState<Blob | null>(file.source === 'local' ? file.blob : null)
  // 'unsupported': the server could not convert the file (no converter, a damaged photo): the "cannot preview" panel
  const [error, setError] = useState<{ kind: 'missing' | 'large' | 'unsupported' | 'busy' | 'other'; text: string } | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  // a HEIC photo needs the server's JPEG, so a local one (not uploaded yet) has no preview
  const viaServer = serverPreview(file.name)
  const kind = file.source === 'local' && viaServer ? null : previewKind(file.name)
  const [rev, setRev] = useState(0)
  const [editing, setEditing] = useState<{ base: string; text: string; draft: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [loadingEdit, setLoadingEdit] = useState(false)
  const canEdit = file.source === 'team' && !!kind && EDITABLE.includes(kind)

  useEffect(() => setEditing(null), [file])

  const startEdit = async () => {
    if (file.source !== 'team') return
    setLoadingEdit(true)
    try {
      const c = await api.call(API.content, { query: { path: file.path, maxBytes: MAX_TEXT } })
      if (c.access !== 'write') return toast({ level: 'warn', text: t('files.readOnlyFolder') })
      if (c.binary || c.content === null || c.truncated) return toast({ level: 'warn', text: t('preview.editTooLarge') })
      setEditing({ base: c.sha256, text: c.content, draft: c.content })
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setLoadingEdit(false)
    }
  }
  const cancelEdit = async () => {
    if (editing && editing.draft !== editing.text && !(await confirmDialog({ title: t('preview.discardTitle'), confirm: t('preview.discard'), danger: true }))) return
    setEditing(null)
  }
  const saveEdit = async () => {
    if (!editing || file.source !== 'team') return
    setSaving(true)
    try {
      const r = await api.call(API.saveContent, { body: { path: file.path, content: editing.draft, baseSha256: editing.base } })
      setEditing(null)
      if (r.conflict) {
        toast({ level: 'warn', text: t('preview.savedConflict', { path: r.path }) })
        openTeamFile(r.path)
      } else {
        toast({ level: 'success', text: t('preview.saved') })
        setRev((v) => v + 1)
      }
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (file.source === 'local') return
    let live = true
    const ctrl = new AbortController()
    setBlob(null)
    setError(null)
    if (!kind || kind === 'hwp') return
    const limit = previewLimit(kind)
    const load = viaServer ? fetchServerPreview(file.path, limit.max, ctrl.signal) : fetchFileBlob(file.path, limit.max, ctrl.signal, { truncate: limit.truncate })
    load.then(
      (b) => live && setBlob(b),
      (e: unknown) => {
        if (!live) return
        // too many conversions now, or a wait over the server's limit: "busy, try again", not "cannot preview"
        if (isApiError(e, 'unavailable') && e.body.params?.reason === 'quarantined') setError({ kind: 'unsupported', text: e.message })
        else if (viaServer && isApiError(e, 'unavailable') && e.body.params?.reason === 'busy') setError({ kind: 'busy', text: t('preview.photoBusy') })
        else if (viaServer && isApiError(e, 'unavailable')) setError({ kind: 'unsupported', text: t('preview.photoUnavailable') })
        else if (e instanceof PreviewTooLargeError) setError({ kind: 'large', text: t('preview.tooLarge', { size: formatSize(e.size, locale) }) })
        else if (isApiError(e, 'not_found')) setError({ kind: 'missing', text: t('preview.notFound') })
        else setError({ kind: 'other', text: errorText(e, locale, t('error.network')) })
      },
    )
    return () => {
      live = false
      ctrl.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, rev])

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
        <h2
          className={clsx('min-w-0 truncate text-sm font-semibold', file.source === 'team' && 'cursor-grab')}
          title={file.source === 'team' ? `${file.path}\n${t('files.dragToChat')}` : file.name}
          draggable={file.source === 'team'}
          onDragStart={(e) => {
            if (file.source !== 'team') return
            e.dataTransfer.setData(TEAM_FILE_DRAG_TYPE, file.path)
            e.dataTransfer.setData('text/plain', file.path)
            e.dataTransfer.effectAllowed = 'copy'
          }}
          data-testid="file-panel-title"
        >
          {file.name}
        </h2>
        <div className="ml-auto flex shrink-0 items-center">
          {file.source === 'team' && error?.kind !== 'missing' && (
            <button type="button" onClick={() => chatAttach.askAi([file.path])} title={t('files.askAi')} className="mr-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent-text hover:bg-accent-soft max-sm:py-1.5" data-testid="file-ask-ai">
              <Sparkles size={14} aria-hidden /> {t('files.askAiShort')}
            </button>
          )}
          {file.source === 'team' && error?.kind !== 'missing' && chatAttach.target && (
            <IconButton label={t('files.addToChatNamed', { title: chatAttach.target.title })} onClick={() => chatAttach.addToChat([file.path])} data-testid="file-add-to-chat">
              <Paperclip size={16} />
            </IconButton>
          )}
          {canEdit && !editing && !error && (
            <IconButton label={t('preview.edit')} onClick={() => void startEdit()} disabled={loadingEdit} data-testid="file-edit">
              {loadingEdit ? <Loader2 size={16} className="animate-spin" /> : <Pencil size={16} />}
            </IconButton>
          )}
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
        {editing ? (
          <div className="flex h-full flex-col gap-2 p-3">
            <textarea
              aria-label={t('preview.editorLabel', { name: file.name })}
              className="min-h-0 flex-1 resize-none rounded-lg border border-line bg-surface p-3 font-mono text-[13px] leading-5 text-ink focus:border-accent focus:outline-none"
              value={editing.draft}
              onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
              spellCheck={false}
              autoFocus
              data-testid="file-editor"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => void cancelEdit()} disabled={saving}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" onClick={() => void saveEdit()} busy={saving} disabled={editing.draft === editing.text} data-testid="file-save">
                {t('common.save')}
              </Button>
            </div>
          </div>
        ) : !kind || error?.kind === 'unsupported' ? (
          // No viewer for this format (HWP, HWPX, ZIP, ...) or no server conversion (HEIC without a converter): the
          // notice and a download button, never an automatic download
          <div className="flex flex-col items-start gap-3 p-6" data-testid="preview-unsupported">
            <p className="text-sm text-muted">{error?.kind === 'unsupported' ? error.text : t('preview.unsupported')}</p>
            <Button variant="primary" onClick={download} data-testid="preview-unsupported-download">
              <Download size={16} aria-hidden /> {t('common.download')}
            </Button>
          </div>
        ) : error?.kind === 'busy' ? (
          <div className="flex flex-col items-start gap-3 p-6" data-testid="preview-busy">
            <p className="text-sm text-muted" role="status">{error.text}</p>
            <Button variant="secondary" onClick={() => setRev((v) => v + 1)} data-testid="preview-busy-retry">
              {t('common.retry')}
            </Button>
          </div>
        ) : error ? (
          <p className={error.kind === 'other' ? 'p-6 text-sm text-danger' : 'p-6 text-sm text-muted'} role="alert">
            {error.text}
          </p>
        ) : kind === 'hwp' && file.source === 'team' ? (
          <Suspense fallback={<p className="p-6 text-sm text-faint">{t('common.loading')}</p>}><HwpView key={file.path} path={file.path} download={download} /></Suspense>
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
  // HTML / SVG next to a confidential chat (or with every chat confidential) run no scripts outside the desktop app
  const chatId = /^\/c\/([^/?#]+)/.exec(useLocation().pathname)?.[1] ?? null
  const scripts = useFrameScripts(kind === 'html' || kind === 'svg' ? chatId : null)
  useEffect(() => {
    let live = true
    blob.slice(0, MAX_TEXT).arrayBuffer().then((b) => live && setText(decodePreviewText(new Uint8Array(b), blob.size > MAX_TEXT)))
    return () => {
      live = false
    }
  }, [blob])
  if (text === null) return null
  const cut = blob.size > MAX_TEXT && <p className="px-4 pb-4 text-xs text-faint">{t('preview.truncated')}</p>
  if (kind === 'markdown')
    return (
      <div className="mx-auto min-h-full max-w-3xl bg-surface p-6">
        <Markdown text={text} />
        {cut}
      </div>
    )
  if ((kind === 'html' || kind === 'svg') && scripts === null) return null
  const page = kind === 'svg' ? `<div style="display:grid;place-items:center;min-height:100vh">${text}</div>` : text
  if ((kind === 'html' || kind === 'svg') && !scripts) return <StaticFrame html={page} title={name} gutter={kind === 'html'} className="min-h-[70vh] w-full flex-1 border-0 bg-white" />
  if (kind === 'html') return <SandboxFrame html={wrapHtml(page, location.origin, { gutter: true })} title={name} className="h-full min-h-[70vh] w-full border-0 bg-white" />
  if (kind === 'svg') return <SandboxFrame html={wrapHtml(page, location.origin)} title={name} className="h-full min-h-[70vh] w-full border-0 bg-white" />
  if (kind === 'csv') {
    const rows = Papa.parse<string[]>(text, { skipEmptyLines: true, delimiter: name.toLowerCase().endsWith('.tsv') ? '\t' : '' }).data.slice(0, 2000)
    return (
      <div className="overflow-auto p-4">
        <table className="border-collapse bg-surface text-xs">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={i === 0 ? 'bg-subtle font-semibold' : ''}>
                {r.map((c, j) => (
                  <td key={j} className="border border-line px-2.5 py-1.5 whitespace-nowrap">
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
        <pre className="m-0 min-h-full overflow-auto bg-surface p-4 font-mono text-[12.5px] leading-5 whitespace-pre-wrap text-ink">{text}</pre>
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
