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
// A shared folder (folder sharing, docs/AGENTS/plan/20261116-1330-folder-share-web.md): its name, "Shared by Mina · View
// only", breadcrumbs that start at the shared folder (never anything above it), and one level of names, sizes and dates
// (GET /api/files/shared/:id/list). A folder inside opens /f/<id>?p=<path inside>; a file inside opens /f/<id>?f=<path
// inside> as the file view above (its bytes by the link and the path inside). No upload, new, rename, search or versions.
// It reads again when shares change (file_shares_changed): a share that stops turns into the closed card. Someone it
// does not open for, and everyone while it is paused, gets the closed card with nothing about the folder.
import { Tooltip } from '../components/Tooltip'
import { ChevronLeft, ChevronRight, Download, Folder, Lock, Trash2 } from 'lucide-react'
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { FILE_REQUEST_NOTE_MAX, fileLinkUrl, type SharedFileView, type SharedFolderEntry, type SharedFolderList } from '@mycel/shared/api'
import { api, API, ApiError, errorText, isApiError, startDownload } from '../lib/api'
import { formatDate, formatSize } from '../lib/format'
import { previewKind, previewLimit } from '../lib/preview'
import { useLocale, useT } from '../i18n'
import FileBody, { type FileBlob } from '../components/FileBody'
import { Button, ErrorNote, Skeleton, inputCls, useMediaQuery } from '../components/ui'
import { PhonePageBar } from '../components/phone/PhonePageBar'
import { useBackLink, useGoBack } from '../lib/back'
import { FILES_SHARED as SHARED_WITH_ME } from '../lib/nav'
import { ListRow } from '../components/list/List'
import { FileKindIcon } from '../components/chat/TeamFilePicker'
import { EmptyState } from '../components/ui'
import { fileSharesChanged } from '../store/live'

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
  // a share that changes (stopped, paused, Remove all): read again, so a page that no longer opens says so
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => fileSharesChanged.on(load), [id])

  if (error) return <Centered><ErrorNote onRetry={load}>{errorText(error, locale, t('error.network'))}</ErrorNote></Centered>
  if (!view) return <Centered><Skeleton lines={3} className="w-full" /></Centered>
  if (view.status === 'open' && view.kind === 'folder') return <OpenFolder id={id} view={view} />
  if (view.status === 'open') return <OpenFile id={id} view={view} />
  if (view.status === 'trashed')
    return (
      <Centered testId="file-link-trashed">
        <Trash2 size={28} className="text-faint" aria-hidden />
        <p className="text-title-sm font-semibold text-ink">{t('fileLink.trashed')}</p>
        <Link to="/files?view=trash" className="font-medium text-accent-text underline" data-testid="file-link-open-trash">{t('fileLink.openTrash')}</Link>
      </Centered>
    )
  if (view.status === 'no_access' && view.canAsk) return <AskAccess id={id} askedAt={view.askedAt} />
  return (
    <Centered testId="file-link-closed" state={view.status}>
      <Lock size={28} className="text-faint" aria-hidden />
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

function AskAccess({ id, askedAt: asked }: { id: string; askedAt: string | null }) {
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
      <p className="text-title-sm font-semibold text-ink">{t('fileLink.needAccess')}</p>
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
function OpenFile({ id, view, sub, above }: { id: string; view: { name: string; size: number; mime: string | null; sharedBy: string | null; formerSharer?: true }; sub?: string; above?: ReactNode }) {
  const t = useT()
  const locale = useLocale()
  const url = (disposition: 'inline' | 'attachment') => api.url(API.sharedFileDownload, { params: { id }, query: sub !== undefined ? { disposition, sub } : { disposition } })
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
  }, [id, sub, rev, fits])
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
  return (
    <div className="mx-auto flex h-full w-full max-w-5xl min-w-0 flex-col gap-3 px-6 py-5 max-md:px-4 max-md:py-3" data-testid="file-link-page" data-state="open">
      {above}
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-title font-semibold text-ink" title={view.name} data-testid="file-link-name">{view.name}</h1>
          <p className="truncate text-sm text-muted" data-testid="file-link-meta">
            {[view.sharedBy ? t('fileLink.sharedBy', { name: view.sharedBy }) : view.formerSharer ? t('fileLink.sharedByFormer') : null, formatSize(view.size, locale)].filter(Boolean).join(' · ')}
          </p>
        </div>
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

type FolderOpen = Extract<SharedFileView, { status: 'open'; kind: 'folder' }>
/** the address of a place inside the shared folder: a folder (?p=) or a file (?f=); '' is the shared folder itself */
const placeUrl = (id: string, sub: string, file = false) => (sub ? `${fileLinkUrl(id)}?${file ? 'f' : 'p'}=${encodeURIComponent(sub)}` : fileLinkUrl(id))

/** The way up inside a shared folder: its own name first, never anything above it. The last one is where we are. */
function FolderCrumbs({ id, names, file = false }: { id: string; names: readonly string[]; file?: boolean }) {
  const t = useT()
  const state = useLocation().state
  return (
    <nav aria-label={t('fileLink.folderPath')} className="flex min-w-0 flex-wrap items-center gap-x-1 text-sm text-muted" data-testid="file-link-crumbs">
      {names.map((n, i) => {
        const last = i === names.length - 1 && !file
        return (
          <Fragment key={i}>
            {i > 0 && <ChevronRight size={14} className="shrink-0 text-faint" aria-hidden />}
            {last ? (
              <span className="max-w-60 truncate text-ink" aria-current="page" title={n}>{n}</span>
            ) : (
              <Link to={placeUrl(id, names.slice(1, i + 1).join('/'))} state={state} className="max-w-60 truncate rounded hover:text-ink hover:underline" title={n} data-testid="file-link-crumb">{n}</Link>
            )}
          </Fragment>
        )
      })}
    </nav>
  )
}

/** "Shared by Mina · View only" (the owner's own folder: "View only" is not said; nothing at all) */
function folderMeta(t: ReturnType<typeof useT>, v: Pick<FolderOpen, 'sharedBy' | 'formerSharer' | 'mine'>): string {
  if (v.mine) return ''
  return [v.sharedBy ? t('fileLink.sharedBy', { name: v.sharedBy }) : v.formerSharer ? t('fileLink.sharedByFormer') : null, t('fileLink.viewOnly')].filter(Boolean).join(' · ')
}

/** A shared folder: one level at a time (?p=), or a file inside it (?f=). */
function OpenFolder({ id, view }: { id: string; view: FolderOpen }) {
  const [params] = useSearchParams()
  const file = params.get('f')
  if (file) return <FolderFile key={file} id={id} view={view} sub={file} />
  return <FolderList key={params.get('p') ?? ''} id={id} view={view} sub={params.get('p') ?? ''} />
}

function FolderList({ id, view, sub }: { id: string; view: FolderOpen; sub: string }) {
  const t = useT()
  const locale = useLocale()
  const state = useLocation().state
  const [list, setList] = useState<SharedFolderList | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [gone, setGone] = useState(false)
  const [more, setMore] = useState(false)
  const read = useCallback(async (cursor?: string) => {
    try {
      const r = await api.call(API.sharedFolderList, { params: { id }, query: { sub, ...(cursor ? { cursor } : {}) } })
      setList((l) => (cursor && l ? { ...r, items: [...l.items, ...r.items] } : r))
      setError(null)
    } catch (e) {
      // a folder inside that is gone or no longer opens: the closed card, nothing about why
      if (isApiError(e, 'not_found')) setGone(true)
      else setError(e)
    }
  }, [id, sub])
  useEffect(() => { void read() }, [read])
  useEffect(() => fileSharesChanged.on(() => void read()), [read])
  if (gone) return <Closed />
  const crumbs = list?.crumbs ?? [view.name, ...(sub ? sub.split('/') : [])]
  const here = crumbs[crumbs.length - 1] ?? view.name
  const meta = folderMeta(t, view)
  return (
    <div className="mx-auto flex h-full w-full max-w-5xl min-w-0 flex-col gap-3 px-6 py-5 max-md:px-4 max-md:py-3" data-testid="file-link-page" data-state="open" data-kind="folder">
      {crumbs.length > 1 && <FolderCrumbs id={id} names={crumbs} />}
      <div className="min-w-0">
        <h1 className="flex min-w-0 items-center gap-2 text-title font-semibold text-ink" data-testid="file-link-name">
          <Folder size={20} className="shrink-0 text-accent-text" aria-hidden />
          <span className="truncate" title={here}>{here}</span>
        </h1>
        {meta && <p className="truncate text-sm text-muted" data-testid="file-link-meta">{meta}</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="file-link-folder">
        {error ? <ErrorNote onRetry={() => void read()}>{errorText(error, locale, t('error.network'))}</ErrorNote> : null}
        {!list && !error && <Skeleton lines={4} />}
        {list && !list.items.length && <EmptyState title={t('fileLink.folderEmpty')} />}
        {list && list.items.length > 0 && (
          <ul data-testid="file-link-items">
            {list.items.map((x) => {
              const inner = sub ? `${sub}/${x.name}` : x.name
              return (
                <ListRow
                  key={x.name}
                  to={placeUrl(id, inner, !x.dir)}
                  state={state}
                  icon={x.dir ? <Folder size={18} className="text-accent-text" aria-hidden /> : <FileKindIcon name={x.name} />}
                  name={x.name}
                  nameTitle={x.name}
                  meta={[x.dir ? null : x.size !== null ? formatSize(x.size, locale) : null, formatDate(x.modifiedAt, locale)].filter(Boolean).join(' · ')}
                  scale="page"
                  testId={x.dir ? 'file-link-folder-row' : 'file-link-file-row'}
                  nameTestId="file-link-item-name"
                />
              )
            })}
          </ul>
        )}
        {list?.truncated && <p className="py-2 text-sm text-muted" data-testid="file-link-truncated">{t('fileLink.folderTruncated')}</p>}
        {list?.next && (
          <div className="py-3">
            <Button className="w-full" busy={more} onClick={() => { setMore(true); void read(list.next!).finally(() => setMore(false)) }} data-testid="file-link-more">{t('common.loadMore')}</Button>
          </div>
        )}
      </div>
    </div>
  )
}

/** A file inside a shared folder: the file view, with the way back up the folder above it. */
function FolderFile({ id, view, sub }: { id: string; view: FolderOpen; sub: string }) {
  const t = useT()
  const locale = useLocale()
  const [entry, setEntry] = useState<SharedFolderEntry | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [gone, setGone] = useState(false)
  const read = useCallback(() => {
    setError(null)
    api.call(API.sharedFolderEntry, { params: { id }, query: { sub } }).then(setEntry, (e) => (isApiError(e, 'not_found') ? setGone(true) : setError(e)))
  }, [id, sub])
  useEffect(read, [read])
  useEffect(() => fileSharesChanged.on(read), [read])
  if (gone) return <Closed />
  if (error) return <Centered><ErrorNote onRetry={read}>{errorText(error, locale, t('error.network'))}</ErrorNote></Centered>
  if (!entry) return <Centered><Skeleton lines={3} className="w-full" /></Centered>
  const names = [view.name, ...sub.split('/')]
  return <OpenFile id={id} sub={sub} view={{ ...entry, sharedBy: view.mine ? null : view.sharedBy, ...(view.formerSharer ? { formerSharer: true as const } : {}) }} above={<FolderCrumbs id={id} names={names.slice(0, -1)} file />} />
}

/** the closed card: nothing about what it was */
function Closed() {
  const t = useT()
  return (
    <Centered testId="file-link-closed" state="no_access">
      <Lock size={28} className="text-faint" aria-hidden />
      <p className="text-sm break-keep text-muted" data-testid="file-link-closed-line">{t('fileLink.cantAsk')}</p>
    </Centered>
  )
}
