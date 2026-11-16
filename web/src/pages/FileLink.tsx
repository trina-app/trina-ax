// /f/:id — a file's link (QA TC-3093, docs/DECISIONS.md "A member shares their own files"; plan
// docs/AGENTS/plan/20261115-1407-file-share-links.md "UI" 3). GET /api/files/shared/:id says what this person gets:
// - open: the file as the preview panel shows it (its bytes from /api/files/shared/:id/download, read here and drawn by
//   FileBody), its name, "Shared by Mina" for someone who has it by a share, and Download. No path, no folder.
// - no_access: nothing about the file (no name, type or owner): "You need access", a note and [Ask for access]; after
//   it "Request sent", and back while it waits "You asked on Nov 15". No asking possible (a guest, sharing turned off):
//   one line, no button. An unknown link: the same kind of line.
// - trashed (its owner only): it is in the trash, with the way to Files › Trash.
// A centered card like the chat's "not found" page (pages/Chat.tsx), full width on a phone.
// Opened from Files › Shared with me (router state `from`, pages/SharedFiles.tsx): "‹ Shared with me" goes back there
// (a phone: the phone's bar; a computer: a quiet link above the page). Opened from anywhere else (Slack, Activity), no
// such way back shows.
import { Tooltip } from '../components/Tooltip'
import { ChevronLeft, Download, Lock, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { FILE_REQUEST_NOTE_MAX, type SharedFileView } from '@mycel/shared/api'
import { api, API, ApiError, errorText, isApiError, startDownload } from '../lib/api'
import { formatDate, formatSize } from '../lib/format'
import { previewKind, previewLimit } from '../lib/preview'
import { useLocale, useT } from '../i18n'
import FileBody, { type FileBlob } from '../components/FileBody'
import { Button, ErrorNote, Skeleton, inputCls, useMediaQuery } from '../components/ui'
import { PhonePageBar } from '../components/phone/PhonePageBar'
import { useBackLink, useGoBack } from '../lib/back'
import { FILES_SHARED as SHARED_WITH_ME } from '../lib/nav'
import { newChatPath } from '../lib/newChat'
import { aiName } from '../lib/tabs'
import { AiMark } from '../components/rooms/AiFace'

type View = SharedFileView | { status: 'guest' }

export default function FileLink() {
  // only the list's own address is a way back (the state is the app's, but it is never taken as any address)
  const from = (useLocation().state as { from?: unknown } | null)?.from === SHARED_WITH_ME ? SHARED_WITH_ME : null
  if (!from) return <LinkPage />
  return (
    <div className="flex h-full flex-col" data-testid="file-link-from-shared">
      <BackToShared />
      <div className="min-h-0 flex-1">
        <LinkPage />
      </div>
    </div>
  )
}

/** "‹ Shared with me": the phone's bar, or a quiet link on a computer (back in history when the list is the entry
 * before, else the list in place of this page) */
function BackToShared() {
  const t = useT()
  const phone = useMediaQuery('(max-width: 767.98px)')
  const back = useGoBack(SHARED_WITH_ME)
  const backLink = useBackLink()
  if (phone) return <PhonePageBar onBack={back} backLabel={t('fileLink.backToShared')} title="" backTestId="file-link-back" />
  return (
    <div className="mx-auto w-full max-w-5xl px-6 pt-3">
      <Link to={SHARED_WITH_ME} replace onClick={backLink} className="-ml-1 inline-flex min-h-8 items-center gap-0.5 rounded text-sm text-muted hover:text-ink pointer-coarse:min-h-11" data-testid="file-link-back">
        <ChevronLeft size={16} aria-hidden />
        {t('fileLink.backToShared')}
      </Link>
    </div>
  )
}

function LinkPage() {
  const { id = '' } = useParams()
  const t = useT()
  const locale = useLocale()
  const [view, setView] = useState<View | null>(null)
  const [error, setError] = useState<unknown>(null)
  const load = () => {
    setError(null)
    api.call(API.sharedFile, { params: { id } }).then(setView, (e) => {
      // a guest: no file is theirs by a link (the server answers 403); a link of the wrong shape: unknown
      if (isApiError(e, 'forbidden')) setView({ status: 'guest' })
      else if (isApiError(e, 'not_found') || isApiError(e, 'validation')) setView({ status: 'unknown' })
      else setError(e)
    })
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [id])

  if (error) return <Centered><ErrorNote onRetry={load}>{errorText(error, locale, t('error.network'))}</ErrorNote></Centered>
  if (!view) return <Centered><Skeleton lines={3} className="w-full" /></Centered>
  if (view.status === 'open') return <OpenFile id={id} view={view} />
  if (view.status === 'trashed')
    return (
      <Centered testId="file-link-trashed">
        <Trash2 size={28} className="text-faint" aria-hidden />
        <p className="text-title-sm font-semibold text-ink">{t('fileLink.trashed')}</p>
        <Link to="/files?view=trash" className="font-medium text-accent-text underline" data-testid="file-link-open-trash">{t('fileLink.openTrash')}</Link>
      </Centered>
    )
  if (view.status === 'no_access' && view.canAsk) return <AskAccess id={id} askedAt={view.askedAt} stoppedBy={view.stoppedBy} />
  return (
    <Centered testId="file-link-closed" state={view.status}>
      <Lock size={28} className="text-faint" aria-hidden />
      {view.status === 'no_access' && view.stoppedBy && <p className="text-title-sm font-semibold text-ink" data-testid="file-link-stopped">{t('fileLink.stoppedBy', { name: view.stoppedBy })}</p>}
      <p className="text-sm break-keep text-muted" data-testid="file-link-closed-line">{t(view.status === 'unknown' ? 'fileLink.unknown' : 'fileLink.cantAsk')}</p>
    </Centered>
  )
}

/** the card in the middle of the page (a phone: the whole width, the page's gutter) */
function Centered({ children, testId, state }: { children: ReactNode; testId?: string; state?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 py-12" data-testid="file-link-page">
      <div className="flex w-full max-w-md flex-col items-center gap-3 text-center" data-testid={testId} data-state={state}>
        {children}
      </div>
    </div>
  )
}

function AskAccess({ id, askedAt: asked, stoppedBy }: { id: string; askedAt: string | null; stoppedBy?: string }) {
  const t = useT()
  const locale = useLocale()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [askedAt, setAskedAt] = useState(asked)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ask = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.call(API.requestFileAccess, { params: { id }, body: note.trim() ? { message: note.trim() } : {} })
      setAskedAt(r.askedAt)
      setSent(r.status === 'sent')
    } catch (e) {
      // too many asks (429), sharing turned off meanwhile (403): the server's words
      setError(e instanceof ApiError ? errorText(e, locale, t('error.network')) : t('error.network'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Centered testId="file-link-ask">
      <Lock size={28} className="text-faint" aria-hidden />
      {/* someone took the viewer off this file: who (nothing about the file); asking again stays possible */}
      <p className="text-title-sm font-semibold text-ink" data-testid={stoppedBy ? 'file-link-stopped' : undefined}>{stoppedBy ? t('fileLink.stoppedBy', { name: stoppedBy }) : t('fileLink.needAccess')}</p>
      {askedAt ? (
        <p role="status" className="text-sm break-keep text-muted" data-testid={sent ? 'file-link-sent' : 'file-link-waiting'}>
          {sent ? t('fileLink.sent') : t('fileLink.asked', { date: formatDate(askedAt, locale) })}
        </p>
      ) : (
        <>
          <p className="text-sm break-keep text-muted">{t('fileLink.needAccessBody')}</p>
          <textarea
            className={`${inputCls} mt-1 h-auto min-h-20 resize-y py-2 text-left max-md:resize-none`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={FILE_REQUEST_NOTE_MAX}
            placeholder={t('fileLink.note')}
            aria-label={t('fileLink.note')}
            data-testid="file-link-note"
          />
          {error && <p role="alert" className="text-sm break-keep text-danger" data-testid="file-link-error">{error}</p>}
          <Button variant="primary" busy={busy} onClick={() => void ask()} className="max-sm:w-full" data-testid="file-link-ask-button">{t('fileLink.ask')}</Button>
        </>
      )}
    </Centered>
  )
}

/** The file, as the preview panel shows it: its bytes read here (up to the preview's limit for its kind), drawn by
 * FileBody; a file too large to show here, or of a kind with no viewer, gets FileBody's card with Download. */
function OpenFile({ id, view }: { id: string; view: Extract<SharedFileView, { status: 'open' }> }) {
  const t = useT()
  const locale = useLocale()
  const url = (disposition: 'inline' | 'attachment') => api.url(API.sharedFileDownload, { params: { id }, query: { disposition } })
  const kind = previewKind(view.name)
  const fits = !!kind && kind !== 'hwp' && view.size <= previewLimit(kind).max
  const [blob, setBlob] = useState<Blob | null>(null)
  const [failed, setFailed] = useState(false)
  const [rev, setRev] = useState(0)
  useEffect(() => {
    if (!fits) return
    const ctrl = new AbortController()
    setBlob(null)
    setFailed(false)
    fetch(url('inline'), { credentials: 'same-origin', signal: ctrl.signal })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => setBlob(view.mime ? new Blob([b], { type: view.mime }) : b), () => { if (!ctrl.signal.aborted) setFailed(true) })
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, rev, fits])
  const loaded: FileBlob = { kind: fits ? kind : null, blob, error: failed ? { kind: 'other', text: t('error.network') } : null, downloadOnly: false }
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(720)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const download = () => startDownload(url('attachment'), view.name)
  // "Ask Trina": a new chat of my own with this file's link ready in the box, so the AI reads exactly this file (its
  // read opens a /f/ link; docs/decisions/20261116-ai-screen-and-shared-tools.md). The link, never a path: this page
  // knows none.
  const navigate = useNavigate()
  const askAi = () => navigate(newChatPath({ prompt: t('fileLink.askPrompt', { name: view.name, link: `${window.location.origin}/f/${id}` }) }))
  return (
    <div className="mx-auto flex h-full w-full max-w-5xl min-w-0 flex-col gap-3 px-6 py-5 max-md:px-4 max-md:py-3" data-testid="file-link-page" data-state="open">
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-title font-semibold text-ink" title={view.name} data-testid="file-link-name">{view.name}</h1>
          <p className="truncate text-sm text-muted" data-testid="file-link-meta">
            {[view.sharedBy ? t('fileLink.sharedBy', { name: view.sharedBy }) : view.formerSharer ? t('fileLink.sharedByFormer') : null, formatSize(view.size, locale)].filter(Boolean).join(' · ')}
          </p>
        </div>
        <Tooltip label={t('files.askAi', { name: aiName(t) })}>
          <Button variant="secondary" onClick={askAi} className="shrink-0" data-testid="file-link-ask-ai">
            <AiMark place="nav" /> <span>{t('files.askAiShort', { name: aiName(t) })}</span>
          </Button>
        </Tooltip>
        <Tooltip label={t('common.download')}>
          <Button variant="secondary" onClick={download} className="shrink-0" data-testid="file-link-download">
            <Download size={16} aria-hidden /> <span className="max-sm:sr-only">{t('common.download')}</span>
          </Button>
        </Tooltip>
      </div>
      <div ref={box} className="min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-surface" data-testid="file-link-body">
        <FileBody file={{ source: 'local', name: view.name, blob: blob ?? new Blob() }} loaded={loaded} width={width} download={download} onRetry={() => setRev((n) => n + 1)} />
      </div>
    </div>
  )
}
