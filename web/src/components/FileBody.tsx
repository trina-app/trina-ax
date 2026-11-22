// A file's body, drawn by its kind: PDF, Word, PowerPoint, Excel/CSV, Markdown, text/code, HTML/SVG (isolated frame),
// pictures (a click on one opens the image viewer, components/ImageViewer.tsx), audio/video, a Hangul file's pages, and
// the card of a file with no preview here. The side panel (FilePanel) draws it under its header; the room file viewer
// that comes next is to draw it on its own stage (docs/DECISIONS.md "FileBody").
// useFileBlob reads the bytes: a team file from /api/files/download (always an attachment with a sandbox CSP on the
// server side), a HEIC photo as the server's JPEG (/api/files/preview), a file sent in a team chat room from
// /api/rooms/:id/files/:fileId (its members only; a page or script type as text with the sandbox CSP); a file from this
// computer is already here. Audio, video and a PDF past what is read whole (lib/preview.ts previewLimit `stream`) are
// not read here: the player or pdf.js reads them from the same address in parts (HTTP Range, the same session), so no
// size is "too large" for them (docs/decisions/20261118-audit2-web-limits.md). HTML/SVG only run in the sandbox frame (SandboxFrame, /sandbox/frame), never as srcdoc or a
// blob: page of this origin. A room file is not in a team folder, so a page pulls in no team images (HTML and SVG
// resolve none, Markdown shows a team picture as a link to open). A Hangul file (HWP, HWPX) is drawn from the server's
// page pictures (viewers/HwpView: the HWP Preview plugin), a team file's by its path and, while the preview is on here
// (Me.server.hwpPreview), a room file's through the room (/api/rooms/:id/files/:fileId/hwp-preview).
import clsx from 'clsx'
import { Download } from 'lucide-react'
import Papa from 'papaparse'
import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { chatFileUrl, fetchChatFileBlob, fetchFileBlob, fetchRoomFileBlob, fetchServerPreview, fileUrl, isApiError, PreviewTooLargeError, roomFileUrl, errorText } from '../lib/api'
import { wrapHtml } from '../lib/artifacts'
import { useFrameScripts } from '../lib/confidential'
import { formatSize } from '../lib/format'
import { splitFrontMatter } from '../lib/markdown'
import { parentPath } from '../lib/paths'
import { PAGE_FIT_QUERY } from '../lib/pageFit'
import { decodePreviewText, languageOf, numberColumns, previewKind, previewLimit, PREVIEW_TEXT_MAX, roomHwpPreview, serverPreview, type PreviewKind, type PreviewLimit } from '../lib/preview'
import type { PreviewFile } from '../lib/sidePanel'
import type { SourceLoc } from '@mycel/shared/api'
import { useLocale, useT } from '../i18n'
import { aiName } from '../lib/tabs'
import { CodeBlock, Markdown } from './LazyMarkdown'
import SandboxFrame, { StaticFrame } from './SandboxFrame'
import ExternalImagesNote, { FrameNotes, hasFrameNotes } from './ExternalImagesNote'
import { useFrameFiles } from '../lib/useFrameFiles'
import { useMe } from '../store/session'
import { fileRead, keptFile, sameBytes } from '../store/teamFiles'
import { Button, PreviewLoading, useMediaQuery } from './ui'
import { Tooltip } from './Tooltip'
import { useViewerItem } from './ImageViewer'
import { ChatFileAsk } from './ChatFileAsk'
import { FileMoved } from './FileMoved'

const HwpView = lazy(() => import('./viewers/HwpView'))
const PdfView = lazy(() => import('./viewers/PdfView'))
const DocxView = lazy(() => import('./viewers/OfficeView').then((m) => ({ default: m.DocxView })))
const PptxView = lazy(() => import('./viewers/OfficeView').then((m) => ({ default: m.PptxView })))
const SheetView = lazy(() => import('./viewers/OfficeView').then((m) => ({ default: m.SheetView })))

const MAX_TEXT = PREVIEW_TEXT_MAX

/** Why the bytes are not here. 'unsupported': the server could not convert the file (no converter, a damaged photo) or
 * it is download-only: the card. 'busy': too many conversions now, "try again". */
export type FileBlobError = { kind: 'missing' | 'large' | 'unsupported' | 'busy' | 'other'; text: string }

/** A file's bytes as read for its body (useFileBlob). */
export interface FileBlob {
  /** its viewer; null: none here (no viewer for the format, or a server preview this file does not have: a HEIC photo
   * outside the team folder, a Hangul file from this computer, a room's while the HWP preview is off) */
  kind: PreviewKind | null
  /** null while it is read, after an error, for a Hangul file (HwpView asks the server for its pages) and when `stream` */
  blob: Blob | null
  /** the file's address on this server that the viewer reads in parts instead of `blob` (audio, video, a large PDF) */
  stream?: string | null
  error: FileBlobError | null
  /** a download-only (quarantined) file: the AI cannot read it either (docs/SAFE-OPS-1A.md "Immutable publication and
   * download-only quarantine") */
  downloadOnly: boolean
}

/** How much of a file a body reads (lib/preview.ts previewLimit: text kinds their first 2 MB, pictures 100 MB, the rest
 * 50 MB); `truncate`: only the beginning is read, never "too large"; `stream`: past `max` it is read from its address. */
export type FileLimit = (kind: PreviewKind) => PreviewLimit

/** Which read of a file's bytes: the same file read with other limits, or as the server's picture, is another copy. */
const blobVariant = (limit: { max: number; truncate: boolean }, viaServer: boolean) => `${viaServer ? 'server' : 'bytes'}:${limit.max}:${limit.truncate ? 'start' : 'all'}`

/** Where a viewer reads a file in parts (FileBlob `stream`): the address its own download uses, inline, with the same
 * cookie session and checks on every request (a team file's read rules, a room's members, whoever sees the chat now).
 * None for a file from this computer (its bytes are here). */
export function streamAddress(file: PreviewFile): string | null {
  switch (file.source) {
    case 'team': return fileUrl(file.path, 'inline')
    case 'room': return roomFileUrl(file.roomId, file.fileId)
    case 'chat': return chatFileUrl(file.chatId, file.fileId, file.version ? { version: file.version } : {})
    default: return null
  }
}

/** Reads a file's bytes for FileBody: `file` is where they are (a team path, a room's file, one from this computer);
 * `rev` reads them again (a retry, a save); `limits`: how much may be read of each kind. */
export function useFileBlob(file: PreviewFile, rev = 0, limits: FileLimit = previewLimit): FileBlob {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  // a HEIC photo needs the server's JPEG (and a Hangul file its pages), made from team files, so a local one (not
  // uploaded yet) and a room file have no preview; but a room's Hangul file gets its pages while the HWP preview is on
  const viaServer = serverPreview(file.name)
  const kind = file.source !== 'team' && viaServer && !(file.source === 'room' && roomHwpPreview(file.name, me)) ? null : previewKind(file.name)
  /** a small team file this window showed a moment ago (store/teamFiles.ts): drawn at once, read again behind it */
  const kept = (): Blob | null => {
    if (file.source !== 'team' || !kind || kind === 'hwp' || limits(kind).max === 0) return null
    return keptFile(file.path, blobVariant(limits(kind), viaServer))
  }
  const [blob, setBlob] = useState<Blob | null>(() => (file.source === 'local' ? file.blob : kept()))
  const [stream, setStream] = useState<string | null>(null)
  const [error, setError] = useState<FileBlobError | null>(null)
  const [downloadOnly, setDownloadOnly] = useState(false)
  /** the file and `rev` the last read was for: another `rev` of the same file (a retry, a save) never starts from the
   * kept bytes */
  const readFor = useRef<{ file: PreviewFile; rev: number } | null>(null)

  useEffect(() => {
    if (file.source === 'local') return
    let live = true
    const ctrl = new AbortController()
    const again = readFor.current?.file === file && readFor.current.rev !== rev
    const shown = again ? null : kept()
    readFor.current = { file, rev }
    setBlob(shown)
    setStream(null)
    setError(null)
    setDownloadOnly(false)
    if (!kind || kind === 'hwp') return
    const limit = limits(kind)
    // audio and video play from the address at once; a PDF does when its bytes are past `max` (below)
    const address = limit.stream && !viaServer ? streamAddress(file) : null
    if (address && limit.max === 0) return void setStream(address)
    const variant = blobVariant(limit, viaServer)
    // a team file's bytes are kept for a return (store/teamFiles.ts: not when the file changed while they were read)
    const keep = file.source === 'team' ? fileRead(file.path, variant) : null
    const load = file.source === 'room'
      ? fetchRoomFileBlob(file.roomId, file.fileId, limit.max, ctrl.signal, { truncate: limit.truncate })
      : file.source === 'chat' ? fetchChatFileBlob(file.chatId, file.fileId, limit.max, ctrl.signal, { truncate: limit.truncate, ...(file.version ? { version: file.version } : {}) })
      : viaServer ? fetchServerPreview(file.path, limit.max, ctrl.signal) : fetchFileBlob(file.path, limit.max, ctrl.signal, { truncate: limit.truncate })
    load.then(
      (b) => {
        keep?.(b)
        if (!live) return
        // the same bytes as shown: the viewer stays as it is (no second drawing of a PDF)
        if (shown) void sameBytes(shown, b).then((same) => live && !same && setBlob(b))
        else setBlob(b)
      },
      (e: unknown) => {
        // (a read stopped because the preview moved on is no reason to forget what was kept)
        if (!live) return keep?.()
        keep?.(null)
        if (shown) setBlob(null)
        // too many conversions now, or a wait over the server's limit: "busy, try again", not "cannot preview"
        if (isApiError(e, 'unavailable') && e.body.params?.reason === 'quarantined') {
          setDownloadOnly(true)
          setError({ kind: 'unsupported', text: e.message })
        }
        else if (viaServer && isApiError(e, 'unavailable') && e.body.params?.reason === 'busy') setError({ kind: 'busy', text: t('preview.photoBusy') })
        else if (viaServer && isApiError(e, 'unavailable')) setError({ kind: 'unsupported', text: t('preview.photoUnavailable') })
        else if (e instanceof PreviewTooLargeError && address) setStream(address)
        else if (e instanceof PreviewTooLargeError) setError({ kind: 'large', text: t('preview.tooLarge', { size: formatSize(e.size, locale) }) })
        else if (isApiError(e, 'not_found')) setError({ kind: 'missing', text: t('preview.notFound') })
        else setError({ kind: 'other', text: errorText(e, locale, t('error.network')) })
      },
    )
    return () => {
      live = false
      ctrl.abort()
    }
    // `limits` is read with the file: new limits for the same file take a new `rev`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, rev])

  return { kind, blob, stream, error, downloadOnly }
}

/** What FileBody draws, in this order: the card when nothing here shows the file (no viewer for its format, a server
 * conversion that cannot be made, a download-only file), "busy, try again", another error (missing, too large, the
 * network), a Hangul file's server pages, "loading" until the bytes are read, then the viewer of its kind. */
export type BodyRenderer = 'card' | 'busy' | 'error' | 'hwp' | 'loading' | ViewerRenderer
/** the viewers drawn from the bytes read */
type ViewerRenderer = 'pdf' | 'docx' | 'pptx' | 'sheet' | 'picture' | 'media' | 'text'

export function bodyRenderer({ kind, blob, error, stream = null }: Pick<FileBlob, 'kind' | 'blob' | 'error' | 'stream'>): BodyRenderer {
  if (!kind || error?.kind === 'unsupported') return 'card'
  if (error?.kind === 'busy') return 'busy'
  if (error) return 'error'
  // a Hangul file's pages come from the server, not from bytes read here (a team file's, or a room file's while the HWP
  // preview is on: useFileBlob's kind)
  if (kind === 'hwp') return 'hwp'
  if (!blob && !stream) return 'loading'
  switch (kind) {
    case 'pdf':
    case 'docx':
    case 'pptx':
    case 'sheet':
      return kind
    case 'image':
      return 'picture'
    case 'audio':
    case 'video':
      return 'media'
    default:
      return 'text'
  }
}

export interface FileBodyProps {
  /** where the file is: a team path (with the place to open it at), a room's file, or one from this computer */
  file: PreviewFile
  /** its bytes, from useFileBlob */
  loaded: FileBlob
  /** the width the viewers fit (a PDF's pages, a deck's slides) */
  width: number
  download: () => void
  /** "busy, try again": read the bytes again (useFileBlob's `rev`) */
  onRetry: () => void
  /** a click on a picture; by default it opens alone in the image viewer, with `download` (PanelPicture) */
  openPicture?: () => void
  /** where a PDF's page thumbnails go, beside the body's scroll box (the room file viewer, on computers); none in the
   * side panel (viewers/PdfView) */
  thumbnails?: HTMLElement | null
  /** drawn on the room file viewer's dark stage (ViewerDocument): a picture is centred both ways and as large as fits,
   * as a video and a sound are everywhere (MediaView) */
  stage?: boolean
}

export default function FileBody({ file, loaded, width, download, onRetry, openPicture, thumbnails, stage }: FileBodyProps) {
  const t = useT()
  const { kind, blob, stream, error, downloadOnly } = loaded
  const renderer = bodyRenderer(loaded)
  if (renderer === 'card')
    // No viewer for this format (HWP, HWPX, ZIP, ...) or no server conversion (HEIC without a converter): the notice and
    // a download button, never an automatic download
    return (
      <DownloadNotice text={error?.kind === 'unsupported' ? error.text : t('preview.unsupported')} download={download} testId="preview-unsupported">
        {downloadOnly && file.source === 'team' && <p className="text-sm text-muted" data-testid="preview-download-only-ai">{t('files.askAiDownloadOnly', { name: aiName(t) })}</p>}
      </DownloadNotice>
    )
  if (renderer === 'busy')
    return (
      <div className="flex flex-col items-start gap-3 p-6" data-testid="preview-busy">
        <p className="text-sm text-muted" role="status">{error?.text}</p>
        <Button variant="secondary" onClick={onRetry} data-testid="preview-busy-retry">
          {t('common.retry')}
        </Button>
      </div>
    )
  // a file link of a chat shared with people that does not open for me: maybe its creator can add it to the chat
  if (renderer === 'error' && error?.kind === 'missing' && file.source === 'team' && file.chatId)
    return <ChatFileAsk chatId={file.chatId} path={file.path} fallback={error.text} />
  // a team file someone moved or put in the trash: where it went (QA TC-r2b-02)
  if (renderer === 'error' && error?.kind === 'missing' && file.source === 'team')
    return <FileMoved path={file.path} fallback={error.text} />
  if (renderer === 'error')
    return (
      <p className={error?.kind === 'other' ? 'p-6 text-sm text-danger' : 'p-6 text-sm text-muted'} role="alert">
        {error?.text}
      </p>
    )
  if (renderer === 'hwp' && file.source === 'team')
    return <Suspense fallback={<PreviewLoading label={t('common.loading')} />}><HwpView key={file.path} source={{ kind: 'team', path: file.path }} download={download} startPage={file.at?.kind === 'page' ? file.at.page : undefined} /></Suspense>
  if (renderer === 'hwp' && file.source === 'room')
    return <Suspense fallback={<PreviewLoading label={t('common.loading')} />}><HwpView key={file.fileId} source={{ kind: 'room', roomId: file.roomId, fileId: file.fileId }} download={download} /></Suspense>
  const source = stream ?? blob
  if (renderer === 'hwp' || renderer === 'loading' || !source || !kind)
    return (
      <PreviewLoading label={t('common.loading')} />
    )
  return (
    <Suspense fallback={<PreviewLoading label={t('common.loading')} />}>
      <Viewer renderer={renderer} kind={kind} source={source} width={width} name={file.name} at={file.source === 'team' ? file.at : undefined} path={file.source === 'team' ? file.path : null} download={download} file={file} openPicture={openPicture} thumbnails={thumbnails} stage={stage} />
    </Suspense>
  )
}

/** `at`: the place to open the file at (an answer's source, a link): a PDF page, a slide, a sheet and its range. Word
 * and Hangul previews have no such place and open at the top. */
function Viewer({ renderer, kind, source, width, name, at, path, download, file, openPicture, thumbnails, stage }: { renderer: ViewerRenderer; kind: PreviewKind; source: Blob | string; width: number; name: string; at?: SourceLoc; path: string | null; download: () => void; file: PreviewFile; openPicture?: () => void; thumbnails?: HTMLElement | null; stage?: boolean }) {
  // (an address only for a PDF or a player: useFileBlob `stream`)
  if (renderer === 'pdf')
    // `download`: a PDF that pdf.js cannot read shows a Download button in place of the pages
    return <PdfView source={source} width={width} startPage={at?.kind === 'page' ? at.page : undefined} download={download} thumbnails={thumbnails} />
  if (renderer === 'media')
    return <MediaView kind={kind === 'audio' ? 'audio' : 'video'} source={source} name={name} download={download} ask={file.source === 'team' && file.chatId ? { chatId: file.chatId, path: file.path } : undefined} />
  if (typeof source === 'string') return null
  const blob = source
  switch (renderer) {
    case 'docx':
      return <DocxView blob={blob} width={width} />
    case 'pptx':
      return <PptxView blob={blob} width={width} startSlide={at?.kind === 'slide' ? at.slide : undefined} />
    case 'sheet':
      return <SheetView blob={blob} startSheet={at?.kind === 'sheet' ? at.sheet : undefined} range={at?.kind === 'sheet' ? at.range : undefined} />
    case 'picture':
      return stage ? <StagePicture blob={blob} name={file.name} /> : <PanelPicture blob={blob} file={file} download={download} openPicture={openPicture} />
    default:
      return <TextKinds kind={kind} blob={blob} name={name} path={path} />
  }
}

/** The body's picture, from the bytes it read: a click opens it in the image viewer, alone (zoom, the whole window),
 * with the body's own download; a team or room file's original can open in a new tab there too. The panel stays.
 * `openPicture`: the click is the caller's instead, and the picture is not registered with the image viewer. */
function PanelPicture({ blob, file, download, openPicture }: { blob: Blob; file: PreviewFile; download: () => void; openPicture?: () => void }) {
  const t = useT()
  const url = useMemo(() => URL.createObjectURL(blob), [blob])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  const href = file.source === 'team' ? (serverPreview(file.name) ? null : fileUrl(file.path, 'inline')) : file.source === 'room' ? roomFileUrl(file.roomId, file.fileId) : file.source === 'chat' ? chatFileUrl(file.chatId, file.fileId, file.version ? { version: file.version } : {}) : null
  const key = file.source === 'team' ? `team:${file.path}` : file.source === 'room' ? `room:${file.roomId}:${file.fileId}` : file.source === 'chat' ? `chat:${file.chatId}:${file.fileId}${file.version ? `@${file.version}` : ''}` : `local:${file.name}`
  const viewer = useViewerItem(openPicture ? null : () => ({ key, name: file.name, original: null, blob, download: file.source === 'local' ? undefined : download, href }))
  return (
    <div className="flex justify-center p-4">
      <Tooltip label={t('md.openImage', { name: file.name })}>
        <button type="button" ref={viewer.ref} onClick={openPicture ?? viewer.open} aria-label={t('md.openImage', { name: file.name })} className="max-w-full cursor-zoom-in rounded" data-testid="file-panel-image">
          <img src={url} alt={file.name} className="max-w-full rounded shadow-sm" />
        </button>
      </Tooltip>
    </div>
  )
}

/** The picture on the room file viewer's dark stage (a picture sent as a file the viewer cannot draw on its own picture
 * stage, such as a HEIC photo the server converts): centred both ways, as large as fits up to its own size. */
function StagePicture({ blob, name }: { blob: Blob; name: string }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  return (
    <div className="flex h-full w-full items-center justify-center bg-[#0d0d0c] p-4 sm:p-6" data-testid="media-stage" data-kind="image">
      <img src={url} alt={name} className="max-h-full max-w-full object-contain" data-testid="file-panel-image" />
    </div>
  )
}

/** What the body says in place of a file it does not show, and Download (`testId`, its button `${testId}-download`). */
function DownloadNotice({ text, download, testId, children }: { text: string; download: () => void; testId: string; children?: ReactNode }) {
  const t = useT()
  return (
    <div className="flex flex-col items-start gap-3 p-6" data-testid={testId}>
      <p className="text-sm text-muted">{text}</p>
      {children}
      <Button variant="primary" onClick={download} data-testid={`${testId}-download`}>
        <Download size={16} aria-hidden /> {t('common.download')}
      </Button>
    </div>
  )
}

/** A player, from the file's address (it asks for the parts it plays: no size limit) or a local file's bytes. One it
 * cannot play (a format this browser has no decoder for, the address refused) shows the notice and Download.
 * Both sit on a dark stage that fills the body, as in Slack, Google Drive or Quick Look (QA TC-5367): never on the
 * paper a document is drawn on. A video is centred both ways and as large as fits, keeping its shape: its width is the
 * smaller of the stage's and the stage's height times its shape (container units of the stage's inner box), so the
 * player's own controls stay on the picture; a sound's player is centred, as wide as a readable bar. */
function MediaView({ kind, source, name, download, ask }: { kind: 'audio' | 'video'; source: Blob | string; name: string; download: () => void; ask?: { chatId: string; path: string } }) {
  const t = useT()
  // the player failed on an address: asked once whether the address itself refuses me (gone, or not mine to open: a file
  // of a shared chat's creator, QA TC-7261), so the notice never offers a Download that fails the same way
  const [refused, setRefused] = useState(false)
  const url = useMemo(() => (typeof source === 'string' ? source : URL.createObjectURL(source)), [source])
  useEffect(() => (typeof source === 'string' ? undefined : () => URL.revokeObjectURL(url)), [url])
  const [failed, setFailed] = useState(false)
  // the video's width / height, once its first data says it
  const [shape, setShape] = useState<number | null>(null)
  useEffect(() => {
    setFailed(false)
    setRefused(false)
    setShape(null)
  }, [url])
  useEffect(() => {
    if (!failed || typeof source !== 'string') return
    let live = true
    fetch(url, { headers: { range: 'bytes=0-0' }, credentials: 'same-origin' }).then((r) => { if (live && (r.status === 403 || r.status === 404)) setRefused(true) }, () => {})
    return () => { live = false }
  }, [failed, source, url])
  if (failed && refused)
    return ask ? <ChatFileAsk chatId={ask.chatId} path={ask.path} fallback={t('preview.mediaMissing')} /> : <p className="p-6 text-sm text-muted" role="alert" data-testid="preview-media-missing">{t('preview.mediaMissing')}</p>
  if (failed)
    return (
      <DownloadNotice text={t('preview.cantPlay')} download={download} testId="preview-cant-play" />
    )
  return (
    <div className="flex h-full min-h-48 w-full bg-[#0d0d0c] p-4 [color-scheme:dark] sm:p-6" data-testid="media-stage" data-kind={kind}>
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center [container-type:size]">
        {kind === 'audio' ? (
          <audio controls src={url} onError={() => setFailed(true)} className="w-full max-w-xl" aria-label={name} data-testid="preview-audio" />
        ) : (
          <video
            controls
            playsInline
            src={url}
            onError={() => setFailed(true)}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget
              if (v.videoWidth > 0 && v.videoHeight > 0) setShape(v.videoWidth / v.videoHeight)
            }}
            className="block max-h-full max-w-full rounded-sm bg-black object-contain"
            style={shape ? { width: `min(100cqw, ${shape} * 100cqh)`, aspectRatio: String(shape) } : undefined}
            aria-label={name}
            data-testid="preview-video"
          />
        )}
      </div>
    </div>
  )
}

/** `path`: the team file (its folder is where the page's relative images are; null for a room file or one from this
 * computer) */
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
  const phoneFit = useMediaQuery(PAGE_FIT_QUERY)
  // (and, in a frame that runs scripts, its team script files: lib/frame-scripts.ts)
  const files = useFrameFiles(page, { folder: path === null ? null : parentPath(path), embedIn: path ?? undefined, scripts: scripts === true })
  if (text === null) return null
  // a 0-byte file: said so, never a blank panel (QA TC-6957)
  if (blob.size === 0) return <p className="p-6 text-sm text-muted" data-testid="preview-empty">{t('preview.empty')}</p>
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
      <PreviewLoading label={t('common.loading')} />
    )
  // on a phone, an HTML page wider than the preview (a quotation drawn as a 794 px page) is fitted to its width, with
  // "실제 크기" above it, and a pinch inside it zooms the page (lib/pageFit.ts; QA TC-259). Computers: as before
  if (framed && files) {
    const fit = kind === 'html' && phoneFit
    const frame = scripts
      ? <SandboxFrame html={wrapHtml(files.html, location.origin, kind === 'html' ? { gutter: true, fit } : {})} fit={fit} title={name} className={clsx('h-full min-h-[70vh] w-full border-0 bg-white', fit && 'flex-1')} />
      : <StaticFrame html={files.html} title={name} gutter={kind === 'html'} fit={fit} className="min-h-[70vh] w-full flex-1 border-0 bg-white" />
    if (scripts ? !hasFrameNotes(files) : !files.external) return frame
    return (
      <div className="flex h-full min-h-0 flex-col">
        {scripts ? <FrameNotes files={files} /> : <ExternalImagesNote count={files.external} />}
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
