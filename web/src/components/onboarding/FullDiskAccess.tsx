// Find work files, part 5 (docs/DECISIONS.md "Find work files, part 5"): a Mac's Full Disk Access, before the wide look.
// Work files are often outside Documents (OneDrive, Google Drive, a project folder); without Full Disk Access macOS would
// ask once for each of them (5–8 questions). The screen says what the person gets (QA TC-3098: the benefit, not the
// mechanics): the files worth sharing with the team (the setup's 팀 파일 step, rank 'team') or their own work files (My
// files and the welcome card, rank 'own', where only they see them); that they choose; then in one short line that the
// look needs Full Disk Access. A small picture of the switch, Open Settings (the Full Disk Access pane), and Not now (the
// three folders, with macOS's question for each, as before). While Settings is open the screen checks every second and
// when the window comes back, and goes on by itself once the app has it (nothing is said about a restart then). Back in
// the window and still off, it offers one button, Restart: macOS may count the switch only after the app restarts. The
// page notes this step first (lib/workFiles.ts saveResume), so the restarted app opens it again by itself.
// The app answers whether it has it (a probe in its main process that reads nothing, the process that also looks); this
// page only asks.
import { Loader2, RotateCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import { FIND_WORK_FILES_GUIDE, type WorkFilesBridge } from '../../lib/workFiles'
import { clearResume, saveResume, type ResumeFrom } from '../../lib/workFilesResume'
import { useT } from '../../i18n'
import { useMeStrict } from '../../store/session'
import { Button } from '../ui'

const quietLink = 'font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink'
/** How often the screen asks the app while Settings is open. */
const POLL_MS = 1000

/** The Full Disk Access screen, or nothing while the app's answer comes (granted: onGo(true) at once). `from`: whose
 * files these are, which decides the words ('team': files for the team; 'own': the person's own My files). */
export function FullDiskAccess({ bridge, onGo, from, phone = false }: { bridge: WorkFilesBridge; onGo: (wide: boolean) => void; from: ResumeFrom; phone?: boolean }) {
  const t = useT()
  const me = useMeStrict()
  const location = useLocation()
  const fd = bridge.fullDisk!
  const [s, setS] = useState<'checking' | 'ask' | 'waiting' | 'restart'>('checking')
  const went = useRef(false)
  const go = (wide: boolean) => { if (!went.current) { went.current = true; clearResume(); onGo(wide) } }
  // the dialog closed on this screen: nothing to open again after a restart (a restart itself unloads the page, and
  // the note stays)
  useEffect(() => () => clearResume(), [])
  // the note is made when Settings opens, not only on Restart: macOS's own "Quit & Reopen" in Settings restarts the
  // app too, and it should land here as well
  const note = () => saveResume(me.user.id, from, location.pathname + location.search)
  const openSettings = () => { note(); fd.openSettings(); setS('waiting') }
  const restart = () => { note(); fd.relaunch() }

  // the first answer: granted goes on at once, anything else shows the screen
  useEffect(() => {
    let live = true
    fd.state().then((x) => { if (live) { if (x === 'granted') go(true); else setS('ask') } }, () => { if (live) setS('ask') })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Settings is open: ask every second, and when the person comes back to the app
  useEffect(() => {
    if (s !== 'waiting' && s !== 'restart') return
    let live = true
    const check = async (back: boolean) => {
      const x = await fd.state().catch(() => 'unknown' as const)
      if (!live) return
      if (x === 'granted') go(true)
      else if (back) setS('restart')
    }
    const iv = setInterval(() => void check(false), POLL_MS)
    const onFocus = () => void check(true)
    window.addEventListener('focus', onFocus)
    return () => { live = false; clearInterval(iv); window.removeEventListener('focus', onFocus) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s])

  if (s === 'checking') {
    return <p className="flex items-center gap-2 text-sm text-muted" role="status" data-testid="find-work-access" data-screen="checking"><Loader2 size={14} className="animate-spin" aria-hidden /> {t('files.findWork.access.checking')}</p>
  }
  const app = PRODUCT.displayName
  return (
    <div className="space-y-4" data-testid="find-work-access" data-screen={s}>
      <div className="space-y-1">
        <h2 className="text-display font-semibold text-ink" data-testid="find-work-access-title">{t(from === 'team' ? 'files.findWork.access.title' : 'files.findWork.access.titleOwn', { app })}</h2>
        <p className="text-sm text-balance text-ink" data-testid="find-work-access-why">{t(from === 'team' ? 'files.findWork.access.why' : 'files.findWork.access.whyOwn', { app })}</p>
        <p className="text-sm text-balance text-muted" data-testid="find-work-access-need">{t('files.findWork.access.need', { app })}</p>
      </div>
      <Toggle app={app} label={t('files.findWork.access.pane')} />
      {s === 'waiting' && (
        <p className="flex items-center gap-2 text-sm text-ink" role="status" data-testid="find-work-access-wait">
          <Loader2 size={14} className="shrink-0 animate-spin text-accent-text" aria-hidden /> {t('files.findWork.access.waiting', { app })}
        </p>
      )}
      {s === 'restart' && (
        <p className="text-sm text-ink" role="status" data-testid="find-work-access-restart">
          {t('files.findWork.access.restart', { app })}{' '}
          <button type="button" className={quietLink} onClick={openSettings} data-testid="find-work-access-reopen-settings">{t('files.findWork.access.openAgain')}</button>
        </p>
      )}
      <p className="text-label text-muted">
        {t('files.findWork.access.never')}{' · '}
        <a className={quietLink} href={FIND_WORK_FILES_GUIDE} target="_blank" rel="noreferrer" data-testid="find-work-access-how">{t('files.findWork.how')}</a>
      </p>
      <div className={phone ? 'flex flex-col-reverse gap-2 [&>*]:w-full' : 'flex flex-wrap items-center justify-end gap-3'}>
        <Button variant="ghost" onClick={() => go(false)} data-testid="find-work-access-later">{t('files.findWork.access.later')}</Button>
        {s === 'restart' ? (
          <Button variant="primary" onClick={restart} data-testid="find-work-access-relaunch"><RotateCw size={14} aria-hidden /> {t('files.findWork.access.relaunch', { app })}</Button>
        ) : (
          <Button variant="primary" onClick={openSettings} data-testid="find-work-access-open">{t('files.findWork.access.open')}</Button>
        )}
      </div>
    </div>
  )
}

/** A small picture of the switch in Settings: the pane's name, the app with its switch on. Drawn, not a screenshot (it
 * follows the light and dark look); the guide has the real pane. */
function Toggle({ app, label }: { app: string; label: string }) {
  return (
    <figure aria-hidden className="mx-auto w-full max-w-sm overflow-hidden rounded-xl border border-line bg-surface" data-testid="find-work-access-picture">
      <figcaption className="border-b border-line px-3 py-2 text-label font-medium text-muted">{label}</figcaption>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <img src="/favicon.svg" alt="" className="size-6 shrink-0 rounded-md" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{app}</span>
        <span className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-accent">
          <span className="absolute right-0.5 size-4 rounded-full bg-white shadow-sm" />
        </span>
      </div>
    </figure>
  )
}
