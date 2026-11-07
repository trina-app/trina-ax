// File preview next to the chat or the file screen: PDF, Word, PowerPoint, Excel/CSV, Markdown, text/code, HTML/SVG
// (isolated frame), images, audio/video. Bytes come from /api/files/download (always an attachment with a sandbox
// CSP on the server side) and are drawn here; HTML/SVG only run in the sandbox frame (SandboxFrame, /sandbox/frame),
// never as srcdoc or a blob: page of this origin. A file sent in a team chat room comes the same way from
// /api/rooms/:id/files/:fileId (its members only; a page or script type as text with the sandbox CSP) and is drawn by
// the same viewers; it is not in a team folder, so a page pulls in no team images (HTML and SVG resolve none, Markdown
// shows a team picture as a link to open), and it has only the download.
// Text files the person may write can be fixed in place (tab 5 "텍스트 파일 고치기"): the editor keeps the sha256 it
// loaded and saves with it as baseSha256 (PUT /api/files/content); when someone changed the file in between, the
// server keeps their version and saves this one as a conflict copy, which the panel then opens.
// An .html file has "PDF로 저장" where the server can print HTML (Me.server.htmlPdf): the server's headless browser
// prints the page as a browser does and saves "<name>.pdf" next to it (POST /api/files/html-pdf); a folder the person
// cannot write gets the same PDF as a download (GET /api/files/html-pdf).
import clsx from 'clsx'
import { Download, FileDown, FileText, FolderOpen, Loader2, Paperclip, Pencil, Sparkles, X } from 'lucide-react'
import Papa from 'papaparse'
import { Fragment, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api, API, fetchFileBlob, fetchRoomFileBlob, fetchServerPreview, fileUrl, isApiError, PreviewTooLargeError, roomFileUrl, saveBlob, startDownload, errorText } from '../lib/api'
import { wrapHtml } from '../lib/artifacts'
import { useFrameScripts } from '../lib/confidential'
import { formatSize } from '../lib/format'
import { splitFrontMatter } from '../lib/markdown'
import { parentPath } from '../lib/paths'
import { decodePreviewText, languageOf, numberColumns, previewKind, previewLimit, PREVIEW_TEXT_MAX, serverPreview, type PreviewKind } from '../lib/preview'
import { openTeamFile, type PreviewFile } from '../lib/sidePanel'
import type { SourceLoc } from '@mycel/shared/api'
import { TEAM_FILE_DRAG_TYPE } from '../lib/teamAttach'
import { useTeamAttach } from '../lib/useTeamAttach'
import { useLocale, useT } from '../i18n'
import { CodeBlock, Markdown } from './Markdown'
import SandboxFrame, { StaticFrame } from './SandboxFrame'
import ExternalImagesNote from './ExternalImagesNote'
import { useFrameFiles } from '../lib/useFrameFiles'
import { toast } from '../store/ui'
import { useMe } from '../store/session'
import { Button, confirmDialog, IconButton } from './ui'
import { MenuButton, type MenuItem } from './rooms/MenuButton'
import { Tooltip } from './Tooltip'

const HwpView = lazy(() => import('./viewers/HwpView'))
const PdfView = lazy(() => import('./viewers/PdfView'))
const DocxView = lazy(() => import('./viewers/OfficeView').then((m) => ({ default: m.DocxView })))
const PptxView = lazy(() => import('./viewers/OfficeView').then((m) => ({ default: m.PptxView })))
const SheetView = lazy(() => import('./viewers/OfficeView').then((m) => ({ default: m.SheetView })))

const MAX_TEXT = PREVIEW_TEXT_MAX
/** kinds the panel can edit as plain text */
const EDITABLE: PreviewKind[] = ['markdown', 'text', 'csv', 'html', 'svg', 'xml']

/** "Ask AI" and "add to chat" for the open file: team files only, not a missing one, and not a download-only file (the AI
 * is refused that file's bytes, so the action could only fail). */
export function chatActionsFor(file: { source: PreviewFile['source'] }, error: { kind: string } | null, downloadOnly: boolean): boolean {
  return file.source === 'team' && error?.kind !== 'missing' && !downloadOnly
}

export default function FilePanel({ file, onClose }: { file: PreviewFile; onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  const chatAttach = useTeamAttach()
  const [blob, setBlob] = useState<Blob | null>(file.source === 'local' ? file.blob : null)
  // 'unsupported': the server could not convert the file (no converter, a damaged photo): the "cannot preview" panel
  const [error, setError] = useState<{ kind: 'missing' | 'large' | 'unsupported' | 'busy' | 'other'; text: string } | null>(null)
  // a download-only (quarantined) file: the AI cannot read it either, so "Ask AI" and "add to chat" are left out and the
  // notice says why (docs/SAFE-OPS-1A.md "Immutable publication and download-only quarantine")
  const [downloadOnly, setDownloadOnly] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  // a HEIC photo needs the server's JPEG (and a Hangul file its pages), made from team files only, so a local one (not
  // uploaded yet) and a room file have no preview
  const viaServer = serverPreview(file.name)
  const kind = file.source !== 'team' && viaServer ? null : previewKind(file.name)
  const [rev, setRev] = useState(0)
  const [editing, setEditing] = useState<{ base: string; text: string; draft: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [loadingEdit, setLoadingEdit] = useState(false)
  const canEdit = file.source === 'team' && !!kind && EDITABLE.includes(kind)
  const me = useMe()
  const [pdfBusy, setPdfBusy] = useState(false)

  useEffect(() => setEditing(null), [file])

  /** "PDF로 저장": the server prints the page and saves the PDF next to it; a read-only folder gets it as a download */
  const savePdf = async () => {
    if (file.source !== 'team' || pdfBusy) return
    setPdfBusy(true)
    try {
      const r = await api.call(API.saveHtmlPdf, { body: { path: file.path } })
      const detail = [r.blocked ? t('preview.pdfBlocked', { count: r.blocked }) : '', r.scripts ? t('preview.pdfScripts') : ''].filter(Boolean).join(' ')
      toast({ level: 'success', text: t('preview.pdfSaved', { name: r.entry.name }), ...(detail ? { detail } : {}), action: { label: t('preview.pdfOpen'), run: () => openTeamFile(r.entry.path) } })
    } catch (e) {
      // only a folder the person cannot write gets the download; any other refusal (the PDF would let more people see
      // a file of the page) says why and saves nothing
      if (isApiError(e, 'forbidden') && e.body.params?.reason === 'read_only') {
        startDownload(api.url(API.downloadHtmlPdf, { query: { path: file.path } }), file.name.replace(/\.[^./]+$/, '') + '.pdf')
        toast({ level: 'info', text: t('preview.pdfDownloaded') })
      } else toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setPdfBusy(false)
    }
  }

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
    setDownloadOnly(false)
    if (!kind || kind === 'hwp') return
    const limit = previewLimit(kind)
    const load = file.source === 'room'
      ? fetchRoomFileBlob(file.roomId, file.fileId, limit.max, ctrl.signal, { truncate: limit.truncate })
      : viaServer ? fetchServerPreview(file.path, limit.max, ctrl.signal) : fetchFileBlob(file.path, limit.max, ctrl.signal, { truncate: limit.truncate })
    load.then(
      (b) => live && setBlob(b),
      (e: unknown) => {
        if (!live) return
        // too many conversions now, or a wait over the server's limit: "busy, try again", not "cannot preview"
        if (isApiError(e, 'unavailable') && e.body.params?.reason === 'quarantined') {
          setDownloadOnly(true)
          setError({ kind: 'unsupported', text: e.message })
        }
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

  const download = () =>
    file.source === 'team' ? startDownload(fileUrl(file.path), file.name)
    : file.source === 'room' ? startDownload(roomFileUrl(file.roomId, file.fileId, { download: '1' }), file.name)
    : saveBlob(file.blob, file.name)
  // phones: "add to chat", "open in Files" and "download" sit behind one ⋯ (a computer keeps them as icons)
  const teamPath = file.source === 'team' ? file.path : null
  const addToChat = teamPath && chatActionsFor(file, error, downloadOnly) && chatAttach.target ? { title: chatAttach.target.title, add: () => chatAttach.addToChat([teamPath]) } : null
  const openInFiles = () => teamPath && navigate(`/files?path=${encodeURIComponent(parentPath(teamPath))}&select=${encodeURIComponent(file.name)}`)
  const canDownload = error?.kind !== 'missing'
  // an .html team file the server can print (never a button that cannot work), not while editing or after an error
  const canPdf = file.source === 'team' && kind === 'html' && !!me?.server.htmlPdf && !error && !editing
  // the app's "…" menu (rooms/MenuButton.tsx): arrow keys, Home / End, Esc back to the button; a bottom sheet on phones
  const more: MenuItem[] = [
    ...(canPdf ? [{ label: pdfBusy ? t('preview.savingPdf') : t('preview.savePdf'), icon: pdfBusy ? <Loader2 size={15} className="shrink-0 animate-spin" aria-hidden /> : <FileDown size={15} className="shrink-0" aria-hidden />, onSelect: () => void savePdf(), testId: 'file-more-save-pdf' }] : []),
    ...(addToChat ? [{ label: t('files.addToChatNamed', { title: addToChat.title }), icon: <Paperclip size={15} className="shrink-0" aria-hidden />, onSelect: addToChat.add, testId: 'file-more-add-to-chat' }] : []),
    ...(file.source === 'team' ? [{ label: t('preview.openInFiles'), icon: <FolderOpen size={15} className="shrink-0" aria-hidden />, onSelect: openInFiles, testId: 'file-more-open-in-files' }] : []),
    ...(canDownload ? [{ label: t('common.download'), icon: <Download size={15} className="shrink-0" aria-hidden />, onSelect: download, testId: 'file-more-download' }] : []),
  ]

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
          {file.source === 'team' && chatActionsFor(file, error, downloadOnly) && (
            <Tooltip label={t('files.askAi')}>
              <button type="button" onClick={() => chatAttach.askAi([file.path])} className="touch-hit mr-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent-text hover:bg-accent-soft max-md:p-1.5 max-sm:p-2" data-testid="file-ask-ai">
                {/* phones: the icon alone, as large as the header's other icons, in an IconButton's padding */}
                <Sparkles size={14} className="max-md:size-4" aria-hidden /> <span className="max-md:sr-only">{t('files.askAiShort')}</span>
              </button>
            </Tooltip>
          )}
          {addToChat && (
            <IconButton label={t('files.addToChatNamed', { title: addToChat.title })} className="max-md:hidden" onClick={addToChat.add} data-testid="file-add-to-chat">
              <Paperclip size={16} />
            </IconButton>
          )}
          {canPdf && (
            <button type="button" onClick={() => void savePdf()} disabled={pdfBusy} aria-busy={pdfBusy} className="touch-hit mr-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted transition hover:bg-hover hover:text-ink disabled:opacity-60 max-md:hidden" data-testid="file-save-pdf">
              {pdfBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <FileDown size={14} aria-hidden />} {pdfBusy ? t('preview.savingPdf') : t('preview.savePdf')}
            </button>
          )}
          {canEdit && !editing && !error && (
            <IconButton label={t('preview.edit')} onClick={() => void startEdit()} disabled={loadingEdit} data-testid="file-edit">
              {loadingEdit ? <Loader2 size={16} className="animate-spin" /> : <Pencil size={16} />}
            </IconButton>
          )}
          {file.source === 'team' && (
            <IconButton label={t('preview.openInFiles')} className="max-md:hidden" onClick={openInFiles}>
              <FolderOpen size={16} />
            </IconButton>
          )}
          {canDownload && (
            <IconButton label={t('common.download')} className="max-md:hidden" onClick={download}>
              <Download size={16} />
            </IconButton>
          )}
          {more.length > 0 && <MenuButton label={t('files.actionsFor', { name: file.name })} items={more} className="md:hidden" muted testId="file-panel-more" />}
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
              className="min-h-0 flex-1 resize-none rounded-lg border border-field-border bg-surface p-3 font-mono text-code leading-5 text-ink focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none"
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
            {downloadOnly && file.source === 'team' && <p className="text-sm text-muted" data-testid="preview-download-only-ai">{t('files.askAiDownloadOnly')}</p>}
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
          <Suspense fallback={<p className="p-6 text-sm text-faint">{t('common.loading')}</p>}><HwpView key={file.path} path={file.path} download={download} startPage={file.at?.kind === 'page' ? file.at.page : undefined} /></Suspense>
        ) : !blob ? (
          <p className="flex items-center gap-2 p-6 text-sm text-faint">
            <Loader2 size={14} className="animate-spin" aria-hidden /> {t('common.loading')}
          </p>
        ) : (
          <Suspense fallback={<p className="p-6 text-sm text-faint">{t('common.loading')}</p>}>
            <Viewer kind={kind} blob={blob} width={width} name={file.name} at={file.source === 'team' ? file.at : undefined} path={file.source === 'team' ? file.path : null} download={download} />
          </Suspense>
        )}
      </div>
    </aside>
  )
}

/** `at`: the place to open the file at (an answer's source, a link): a PDF page, a slide, a sheet and its range. Word
 * and Hangul previews have no such place and open at the top. */
function Viewer({ kind, blob, width, name, at, path, download }: { kind: PreviewKind; blob: Blob; width: number; name: string; at?: SourceLoc; path: string | null; download: () => void }) {
  switch (kind) {
    case 'pdf':
      // `download`: a PDF that pdf.js cannot read shows a Download button in place of the pages
      return <PdfView blob={blob} width={width} startPage={at?.kind === 'page' ? at.page : undefined} download={download} />
    case 'docx':
      return <DocxView blob={blob} />
    case 'pptx':
      return <PptxView blob={blob} width={width} startSlide={at?.kind === 'slide' ? at.slide : undefined} />
    case 'sheet':
      return <SheetView blob={blob} startSheet={at?.kind === 'sheet' ? at.sheet : undefined} range={at?.kind === 'sheet' ? at.range : undefined} />
    case 'image':
    case 'audio':
    case 'video':
      return <MediaView kind={kind} blob={blob} name={name} />
    default:
      return <TextKinds kind={kind} blob={blob} name={name} path={path} />
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

/** `path`: the team file (its folder is where the page's relative images are; null for a file from this computer) */
function TextKinds({ kind, blob, name, path }: { kind: PreviewKind; blob: Blob; name: string; path: string | null }) {
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
  const framed = kind === 'html' || kind === 'svg'
  const page = text === null || !framed ? null : kind === 'svg' ? `<div style="display:grid;place-items:center;min-height:100vh">${text}</div>` : text
  // the page's team images and clips as data: URLs (lib/frame-files.ts), each only if everyone who can read this page
  // can read it too (embedIn); null while they are fetched
  const files = useFrameFiles(page, { folder: path === null ? null : parentPath(path), embedIn: path ?? undefined })
  if (text === null) return null
  const cut = blob.size > MAX_TEXT && <p className="px-4 pb-4 text-xs text-faint">{t('preview.truncated')}</p>
  if (kind === 'markdown') {
    // a leading YAML block (a SKILL.md's name and description): a quiet fields block above the page, not its first line
    const { body: md, ...fields } = splitFrontMatter(text)
    const shown = Object.entries(fields).filter(([, v]) => v)
    return (
      <div className="mx-auto min-h-full max-w-3xl bg-surface p-6">
        {shown.length > 0 && (
          <dl className="mb-5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-b border-line pb-4 text-xs" data-testid="md-front-matter">
            {shown.map(([k, v]) => (
              <Fragment key={k}>
                <dt className="font-mono text-faint">{k}</dt>
                <dd className="min-w-0 text-muted">{v}</dd>
              </Fragment>
            ))}
          </dl>
        )}
        {/* a room file or one from this computer is not in the team folder: a team picture it names is a link, not loaded */}
        <Markdown text={md} teamImagesAsLinks={path === null} />
        {cut}
      </div>
    )
  }
  if (framed && scripts === null) return null
  if (framed && !files)
    return (
      <p className="flex items-center gap-2 p-6 text-sm text-faint">
        <Loader2 size={14} className="animate-spin" aria-hidden /> {t('common.loading')}
      </p>
    )
  if (framed && files) {
    const frame = scripts
      ? <SandboxFrame html={wrapHtml(files.html, location.origin, kind === 'html' ? { gutter: true } : {})} title={name} className="h-full min-h-[70vh] w-full border-0 bg-white" />
      : <StaticFrame html={files.html} title={name} gutter={kind === 'html'} className="min-h-[70vh] w-full flex-1 border-0 bg-white" />
    if (!files.external) return frame
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ExternalImagesNote count={files.external} />
        {frame}
      </div>
    )
  }
  if (kind === 'csv') {
    const rows = Papa.parse<string[]>(text, { skipEmptyLines: true, delimiter: name.toLowerCase().endsWith('.tsv') ? '\t' : '' }).data.slice(0, 2000)
    const numbers = numberColumns(rows)
    return (
      <div className="overflow-auto p-4">
        <table className="border-collapse bg-surface text-xs">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={i === 0 ? 'bg-subtle font-semibold' : ''}>
                {r.map((c, j) => (
                  <td key={j} className={clsx('border border-line px-2.5 py-1.5 whitespace-nowrap', numbers.has(j) && 'text-right tabular-nums')}>
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
        <pre className="m-0 min-h-full overflow-auto bg-surface p-4 font-mono text-code-file leading-5 whitespace-pre-wrap text-ink">{text}</pre>
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
