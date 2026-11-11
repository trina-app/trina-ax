// Folder uploads on the file screen: one row per folder with files done, bytes and failures, and "try again" for the
// failed files. The runs stay here, not in the page: an upload of many files goes on when the person opens another page,
// and the row is there when they come back. The work itself is lib/folderUpload.ts.
import { FolderUp, Loader2, X } from 'lucide-react'
import { UPLOAD_SESSION_MAX } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { FolderUpload, type FolderFailure, type FolderPlan, type FolderUploadCalls } from '../lib/folderUpload'
import { useRuns, type Run } from '../lib/folderRuns'
import { formatSize } from '../lib/format'
import { useFolderWords } from '../lib/folderLabels'
import { baseName } from '../lib/paths'
import { cancelUpload, uploadFile, uploadLabel } from '../lib/upload'
import { useLocale, useT } from '../i18n'
import { Button, IconButton } from './ui'

/** one failed path per line, at most this many; the rest are counted */
const FAILURES_SHOWN = 5
/** a finished run stays this long, as a finished file does */
const DONE_SHOWN_MS = 4000

/** Runs live in this tab, and a run started again sends the finished files a second time. The guard is here and not in a
 * page: a run goes on when the person opens another page. */
const stay = (e: BeforeUnloadEvent) => e.preventDefault()
let guarded = false
useRuns.subscribe((s) => {
  const on = s.runs.some((r) => r.view.status === 'running')
  if (on === guarded || typeof window === 'undefined') return
  guarded = on
  if (on) window.addEventListener('beforeunload', stay)
  else window.removeEventListener('beforeunload', stay)
})

const target = (path: string) => ({ kind: 'path', path, onExists: 'rename' }) as const

const calls: FolderUploadCalls = {
  maxFileSize: UPLOAD_SESSION_MAX,
  mkdir: (path, signal) => api.call(API.mkdir, { body: { path }, signal }),
  isFolder: (path, signal) => api.call(API.tree, { query: { path, limit: 1 }, signal }).then(() => true, () => false),
  upload: (file, path, signal, onProgress) => uploadFile(file, target(path), { client: api, signal, onProgress }),
  discard: (file, path) => cancelUpload(file, target(path), api),
}

const remove = (id: number) => useRuns.setState((s) => ({ runs: s.runs.filter((r) => r.run.id !== id) }))

/** The run ended (all sent, stopped or cancelled): the listing is read again once. */
function settle(run: FolderUpload, ended: Promise<void>) {
  void ended.then(() => {
    useRuns.setState((s) => ({ settled: s.settled + 1 }))
    const item = useRuns.getState().runs.find((r) => r.run === run)
    if (!item) return
    if (item.view.status === 'stopped') item.onRefused(item.view)
    if (item.view.status === 'done') setTimeout(() => remove(run.id), DONE_SHOWN_MS)
  })
}

/** Start a folder upload into `base`. `tag`: a screen that comes back to it (folderRuns.ts RunTag); `onLanded`: each file
 * the server took, with where it is now (the welcome step records itself done with the first). */
export function startFolderUpload(plan: FolderPlan, base: string, onRefused: Run['onRefused'], o: { tag?: Run['tag']; onLanded?: (path: string) => void } = {}): Run {
  const own: FolderUploadCalls = o.onLanded
    ? { ...calls, upload: async (file, path, signal, onProgress) => {
      const r = await calls.upload(file, path, signal, onProgress) as Awaited<ReturnType<typeof uploadFile>>
      if (r.kind === 'path') { try { o.onLanded!(r.entry.path) } catch { /* the upload itself went */ } }
      return r
    } }
    : calls
  const run: FolderUpload = new FolderUpload(plan, base, own, () =>
    useRuns.setState((s) => {
      const tagged = o.tag && s.tagged[o.tag]?.run === run ? { ...s.tagged, [o.tag]: { ...s.tagged[o.tag]!, view: run.view } } : s.tagged
      return { runs: s.runs.map((r) => (r.run === run ? { ...r, view: run.view } : r)), tagged }
    }),
  )
  const item: Run = { run, view: run.view, onRefused, ...(o.tag ? { tag: o.tag } : {}) }
  useRuns.setState((s) => {
    // the tag's run before, over: its row goes (what it left is this run's now, or was let go)
    const prev = o.tag ? s.tagged[o.tag] : undefined
    const runs = prev && prev.view.status !== 'running' ? s.runs.filter((r) => r.run !== prev.run) : s.runs
    return { runs: [...runs, item], tagged: o.tag ? { ...s.tagged, [o.tag]: item } : s.tagged }
  })
  settle(run, run.start())
  return item
}

/** "다시" for a run whose files failed (not stopped): they go again on the same run, its row back on the file screen. */
export const retryFolderUpload = (item: Run) => {
  if (!useRuns.getState().runs.some((r) => r.run === item.run)) useRuns.setState((s) => ({ runs: [...s.runs, item] }))
  settle(item.run, item.run.retry())
}

/** [그만 올리기]: the run stops, what went up stays, the server drops the unfinished files. */
export const stopFolderUpload = (item: Run) => item.run.cancel()

/** Goes up by one each time a run ends. */
export const useFolderUploadsSettled = () => useRuns((s) => s.settled)

export default function FolderUploads({ here }: { here: string }) {
  const t = useT()
  const runs = useRuns((s) => s.runs)
  if (!runs.length) return null
  return (
    <ul className="mx-4 mb-2 space-y-2 rounded-xl border border-line bg-surface p-2 sm:mx-6" aria-label={t('files.folderUpload.label')} data-testid="folder-uploads">
      {runs.map((r) => (
        <FolderRow key={r.run.id} item={r} here={here} />
      ))}
    </ul>
  )
}

function FolderRow({ item, here }: { item: Run; here: string }) {
  const t = useT()
  const words = useFolderWords()
  const locale = useLocale()
  const { run, view: v } = item
  const running = v.status === 'running'
  const whole = v.bytesTotal || v.total
  const pct = whole ? Math.round(((v.bytesTotal ? v.bytesDone : v.done) / whole) * 100) : 100
  const now = v.active[0]
  const title = v.name ?? t('files.drag.count', { n: v.items })
  const failed = t('files.folderUpload.failed', { n: v.failed })
  // the row says the end and each failure aloud (a refusal has its own alert below)
  const said = running ? (v.failed ? `${title}: ${failed}` : '') : `${title}: ${t('files.folderUpload.ended', { done: v.done, total: v.total })}${v.failed ? ` ${failed}` : ''}`
  const reason = (f: FolderFailure) => {
    if (f.local === 'unreadable') return t('files.folderUpload.unreadable')
    if (f.local === 'tooLarge') return t('files.folderUpload.tooLarge', { size: formatSize(UPLOAD_SESSION_MAX, locale) })
    if (f.local) return t(`files.name.${f.local}`)
    return errorText(f.error, locale, t('error.network'))
  }
  const close = () => {
    remove(run.id)
    void (running ? run.cancel() : run.discard())
  }
  return (
    <li className="space-y-1 text-xs" data-testid="folder-upload">
      <span role="status" className="sr-only" data-testid="folder-upload-said">{said}</span>
      {/* a phone: the counts go to a line of their own, so 다시 시도 and ✕ stay on the row (QA TC-223: the counts pushed
          다시 시도 off a 390 px screen) */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {running ? <Loader2 size={13} className="shrink-0 animate-spin text-accent-text" aria-hidden /> : v.status === 'done' ? <span className="text-ok">✓</span> : <FolderUp size={13} className="shrink-0 text-danger" aria-hidden />}
        <span className="min-w-0 flex-1 truncate font-medium">
          {v.base !== here && <span className="font-normal text-faint">{words.name(v.base, baseName(v.base)) || t('files.root')}/</span>}
          {title}
        </span>
        <span className="shrink-0 text-faint max-sm:order-last max-sm:basis-full max-sm:pl-5" data-testid="folder-upload-counts">
          {t('files.folderUpload.files', { done: v.done, total: v.total })} · {t('files.folderUpload.bytes', { done: formatSize(v.bytesDone, locale), total: formatSize(v.bytesTotal, locale) })}
        </span>
        {v.failed > 0 && <span className="shrink-0 text-danger max-sm:order-last max-sm:pl-5" data-testid="folder-upload-failed">{t('files.folderUpload.failed', { n: v.failed })}</span>}
        {v.canRetry && (
          <Button size="sm" onClick={() => settle(run, run.retry())} data-testid="folder-upload-retry">
            {t('common.retry')}
          </Button>
        )}
        <IconButton label={running ? t('common.cancel') : t('common.close')} onClick={close} data-testid="folder-upload-close">
          <X size={13} />
        </IconButton>
      </div>
      {running && (
        <div className="h-1 overflow-hidden rounded bg-subtle" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={v.name ?? t('files.folderUpload.label')}>
          <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      )}
      {running && now && (
        <p className="truncate text-faint">
          {now.name} · {uploadLabel(now, t)}
        </p>
      )}
      {v.skipped > 0 && <p className="text-faint">{t('files.folderUpload.skipped', { n: v.skipped })}</p>}
      {v.refusal !== null && (
        <p className="text-danger" role="alert" data-testid="folder-upload-refusal">
          {errorText(v.refusal, locale, t('error.network'))} {t('files.folderUpload.stopped', { n: v.waiting })}
        </p>
      )}
      {v.failures.length > 0 && (
        <ul className="space-y-0.5" data-testid="folder-upload-failures">
          {v.failures.slice(0, FAILURES_SHOWN).map((f) => (
            <li key={f.path} className="flex gap-2">
              <span className="min-w-0 flex-1 truncate">{f.path}</span>
              <span className="max-w-[50%] truncate text-danger" title={reason(f)}>{reason(f)}</span>
            </li>
          ))}
          {v.failures.length > FAILURES_SHOWN && <li className="text-faint">{t('files.bulk.more', { n: v.failures.length - FAILURES_SHOWN })}</li>}
        </ul>
      )}
    </li>
  )
}
