// "Find work files on this computer" (docs/DECISIONS.md "Find work files on this computer"; plan
// docs/AGENTS/plan/20261115-0330-find-work-files.md). The desktop app asks in its own window, then looks through
// Documents, Desktop and Downloads (lib/workFiles.ts, the bridge's workFiles); this screen shows what it found and adds
// only what the person ticks.
//   asking   the app's own window is up (the page draws no consent of its own: a page script could fake it)
//   looking  "Looking through Documents · 1,240 files checked · Nothing has been uploaded" + Stop (the list so far)
//   ranking  the AI's pick from names, folders, types, sizes and dates (never a personal-looking name, never content)
//   list     two groups: "Looks like work" (the AI's picks with their reason, or the name rules' order without AI) and
//            "May be personal" (folded, "Not sent to AI"), a search over everything found, NOTHING ticked, "Select all"
//            (never a personal-looking file, at most 100), at most 1 GB per add; a line for each folder macOS kept the
//            app out of ("… can't see Downloads · Allow in Settings"), a cut folder, files over 50 MB, a folder left out
// Nothing is read before Add: the files' contents are read by the upload, one by one (LocalDoc.open → workFiles.read).
// Two places use it: My files (FindWorkFilesEntry: the files go to My files › From this computer, the member's own AI
// turn; the result has Open and Undo) and the setup's 팀 파일 step on the desktop app (TeamFilesStep: the owner's files go
// to the team home as before, the team pick, then the step's own run and folder plan).
import clsx from 'clsx'
import { FolderSearch, Loader2, Undo2 } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import { TEAM_FILES_LIMITS, type TeamFileReason, type TreeResponse } from '@mycel/shared/api'
import type { WorkFileScan, WorkRootId, WorkRootResult } from '@mycel/shared'
import { api, API, errorText } from '../../lib/api'
import { desktop } from '../../lib/desktop'
import type { FolderPlan, FolderUpload } from '../../lib/folderUpload'
import { taggedRun, useRuns, type Run } from '../../lib/folderRuns'
import { formatSize, intlTag } from '../../lib/format'
import { findAlready, findDocs, forAi, rankEntries, tick, type LocalDoc } from '../../lib/teamFiles'
import { docsFromScan, FROM_COMPUTER, overBytes, ROOT_FOLDER, rootNotes, runFolder, selectAll, undoRun, WorkFileReadError, workFilesBridge, type RunMade, type WorkFilesBridge } from '../../lib/workFiles'
import { useFolderWords } from '../../lib/folderLabels'
import { currentLocale, t as tNow, useLocale, useT, type MessageKey } from '../../i18n'
import { useMeStrict } from '../../store/session'
import { isGuestMe } from '../../lib/guests'
import { toast } from '../../store/ui'
import { startFolderUpload, stopFolderUpload } from '../FolderUploads'
import { Button, ErrorNote, Modal, useMediaQuery } from '../ui'
import { storagePlansAction } from '../StoragePlansLink'
import { TickFold, TickRow, TickSearch } from './TickList'

const L = TEAM_FILES_LIMITS
const TAG = 'find-work-files' as const
/** rows drawn per group at most (the rest: found by name) */
const ROWS_SHOWN = 200
/** the Mac guide (docs/site/use/find-work-files.md): the app's question, macOS's question per folder, turning access on */
export const FIND_WORK_FILES_GUIDE = 'https://ax.trina.app/docs/use/find-work-files/'
const quietLink = 'font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink disabled:opacity-50'

const ROOT_WORD: Record<WorkRootId, MessageKey> = { documents: 'files.findWork.root.documents', desktop: 'files.findWork.root.desktop', downloads: 'files.findWork.root.downloads' }
const ROOT_OF: Record<string, WorkRootId> = Object.fromEntries(Object.entries(ROOT_FOLDER).map(([id, name]) => [name, id as WorkRootId]))
const REASON: Record<TeamFileReason, MessageKey> = {
  form: 'welcome.teamFiles.reason.form', intro: 'welcome.teamFiles.reason.intro', report: 'welcome.teamFiles.reason.report', minutes: 'welcome.teamFiles.reason.minutes',
  brand: 'welcome.teamFiles.reason.brand', policy: 'welcome.teamFiles.reason.policy', training: 'welcome.teamFiles.reason.training', proposal: 'welcome.teamFiles.reason.proposal',
}

/** A root in words: "Documents", "Documents (OneDrive)". */
function useRootName() {
  const t = useT()
  return (r: Pick<WorkRootResult, 'id' | 'oneDrive'>) => (r.oneDrive ? t('files.findWork.root.oneDrive', { folder: t(ROOT_WORD[r.id]) }) : t(ROOT_WORD[r.id]))
}

/** Only one look at a time in this tab (a second mount while one runs waits for the same answer). */
let scanning: Promise<WorkFileScan> | null = null
const scanOnce = (b: WorkFilesBridge) => (scanning ??= b.scan().finally(() => { scanning = null }))

type Phase = { s: 'asking' } | { s: 'looking'; root: WorkRootId; checked: number; docs: number } | { s: 'ranking'; n: number } | { s: 'list' } | { s: 'none' } | { s: 'error'; text: string }

export interface FindWorkFilesProps {
  bridge: WorkFilesBridge
  /** whose AI picks: 'own' (anyone but guests, for My files) or 'team' (the owner's setup, for the team home) */
  rank: 'own' | 'team'
  /** what is already in the target, the same name and size (never offered twice) */
  alreadyIn: (docs: readonly LocalDoc[]) => Promise<Set<string>>
  /** who sees the files where they go: "me" (My files), or the team's name */
  audience: 'me' | string
  /** where they go, in words (for the list's line) */
  placeName: string
  /** add the ticked files; the caller starts the run */
  onAdd: (docs: LocalDoc[]) => void
  /** leave (Cancel, nothing found, the app said no) */
  onClose: () => void
  phone?: boolean
}

/** The steps; "Look again" (every folder kept out, after the person let the app in) starts them over with a new look. */
export function FindWorkFiles(props: FindWorkFilesProps) {
  const [round, setRound] = useState(0)
  return <FindWorkFilesRound key={round} {...props} onAgain={() => setRound((n) => n + 1)} />
}

function FindWorkFilesRound({ bridge, rank, alreadyIn, audience, placeName, onAdd, onClose, onAgain, phone = false }: FindWorkFilesProps & { onAgain: () => void }) {
  const t = useT()
  const locale = useLocale()
  const ids = useId()
  const rootName = useRootName()
  const [phase, setPhase] = useState<Phase>({ s: 'asking' })
  const [docs, setDocs] = useState<LocalDoc[]>([])
  const [roots, setRoots] = useState<WorkRootResult[]>([])
  const [stopped, setStopped] = useState(false)
  const [picks, setPicks] = useState<Map<string, TeamFileReason> | null>(null)
  const [noAi, setNoAi] = useState(false)
  const [already, setAlready] = useState(0)
  const [ticks, setTicks] = useState<Set<string>>(() => new Set())
  const [capped, setCapped] = useState(false)
  const [q, setQ] = useState('')
  const [openPersonal, setOpenPersonal] = useState(false)
  const live = useRef(true)
  const rankAbort = useRef<AbortController | null>(null)
  // the page's dialog closed (✕, Escape, another page): a look still running stops, the AI's pick is let go (set again
  // on a mount: React's practice unmount in development runs this once before the real one)
  useEffect(() => {
    live.current = true
    return () => { live.current = false; rankAbort.current?.abort(); bridge.stop() }
  }, [bridge])

  useEffect(() => {
    const off = bridge.onProgress((p) => { if (live.current) setPhase((x) => (x.s === 'asking' || x.s === 'looking' ? { s: 'looking', ...p } : x)) })
    void (async () => {
      let r: WorkFileScan
      try { r = await scanOnce(bridge) } catch { r = { state: 'unavailable' } }
      if (!live.current) return
      // the app is still busy with a question or a look (asked again too soon): said, nothing else happens
      if (r.state === 'busy') return setPhase({ s: 'error', text: t('files.findWork.busy') })
      // the person said no in the app's own window: nothing happened, the page closes
      if (r.state !== 'done') return onClose()
      setRoots(r.roots)
      setStopped(r.stopped)
      const all = docsFromScan(r.files, bridge.read)
      const there = await alreadyIn(all).catch(() => new Set<string>())
      if (!live.current) return
      const found = all.filter((d) => !there.has(d.key))
      setAlready(all.length - found.length)
      setDocs(found)
      if (!found.length) return setPhase({ s: rootNotes(r.roots).none ? 'none' : 'list' })
      // the AI picks from names only, never a personal-looking one; nothing ticked whatever it says
      const sent = forAi(found)
      if (!sent.length) { setNoAi(true); return setPhase({ s: 'list' }) }
      setPhase({ s: 'ranking', n: found.length })
      const { entries, keyOf } = rankEntries(sent)
      const ctl = new AbortController()
      rankAbort.current = ctl
      const timer = setTimeout(() => ctl.abort(), L.rankMs)
      let got: Map<string, TeamFileReason> | null = null
      try {
        const res = await api.call(rank === 'own' ? API.rankOwnFiles : API.rankTeamFiles, { body: { entries }, signal: ctl.signal })
        if (res.ai === 'done') got = new Map(res.picks.flatMap((p) => { const k = keyOf.get(p.id); return k ? [[k, p.reason] as const] : [] }))
      } catch { got = null } finally { clearTimeout(timer) }
      if (!live.current) return
      setPicks(got && got.size ? got : null)
      setNoAi(!got)
      setPhase({ s: 'list' })
    })()
    return off
    // one look per mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const notes = rootNotes(roots)
  const byKey = useMemo(() => new Map(docs.map((d) => [d.key, d])), [docs])
  /** Looks like work: the AI's picks in its order, or (no AI, no pick) the name rules' order */
  const work = useMemo(() => {
    if (picks) return [...picks.keys()].flatMap((k) => { const d = byKey.get(k); return d && !d.personal ? [d] : [] })
    return forAi(docs, Number.POSITIVE_INFINITY)
  }, [picks, byKey, docs])
  const personal = useMemo(() => docs.filter((d) => d.personal), [docs])
  /** found but in neither group (the AI did not pick them): found by name */
  const rest = docs.length - work.length - personal.length
  const found = q ? findDocs(docs, q) : null
  const pad = phone ? 'px-0' : 'px-4'
  const frame = phone ? 'border-y border-line' : 'rounded-xl border border-line bg-surface'
  const tooMuch = overBytes(docs, ticks)

  const toggle = (key: string, on: boolean) => {
    const r = tick(ticks, key, on)
    setCapped(r.refused)
    setTicks(r.ticks)
  }
  const meta = (d: LocalDoc) => {
    const reason = picks?.get(d.key)
    const root = ROOT_OF[d.pick]
    const where = [root ? t(ROOT_WORD[root]) : d.pick, ...(d.folder ? d.folder.split('/') : [])].join(' › ')
    const date = new Intl.DateTimeFormat(intlTag(locale), { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(d.modified))
    return [reason ? t(REASON[reason]) : null, where, formatSize(d.size, locale), date].filter(Boolean).join(' · ')
  }
  const personalNote = (d: LocalDoc) => (d.personal && ticks.has(d.key)
    ? <span className="mt-0.5 block text-label text-warn" data-testid="find-work-personal-ticked">{audience === 'me' ? t('files.findWork.personalTickedMe') : t('welcome.teamFiles.personalTicked', { team: audience })}</span>
    : null)
  const row = (d: LocalDoc, i: number) => (
    <TickRow key={d.key} id={`${ids}-${d.key}`} rowKey={d.key} name={d.name} meta={meta(d)} first={i === 0} pad={pad} checked={ticks.has(d.key)} onChange={(v) => toggle(d.key, v)} note={personalNote(d)} testId="find-work-row" checkTestId="find-work-check" />
  )
  const rows = (list: readonly LocalDoc[]) => (
    <>
      {list.slice(0, ROWS_SHOWN).map(row)}
      {list.length > ROWS_SHOWN && <li className={clsx('border-t border-line py-2.5 text-label text-faint', pad)}>{t('welcome.teamFiles.moreRows', { n: list.length - ROWS_SHOWN })}</li>}
    </>
  )

  if (phase.s === 'asking' || phase.s === 'looking' || phase.s === 'ranking') {
    const title = phase.s === 'asking' ? t('files.findWork.asking') : phase.s === 'looking' ? t('files.findWork.looking', { folder: t(ROOT_WORD[phase.root]) }) : t('files.findWork.ranking', { n: phase.n })
    return (
      <div className="space-y-4" data-testid="find-work" data-screen={phase.s}>
        <h2 className="flex items-center gap-2 text-display font-semibold text-ink" role="status" data-testid="find-work-title">
          <Loader2 size={16} className="shrink-0 animate-spin text-accent-text" aria-hidden /> {title}
        </h2>
        {phase.s === 'looking' && <p className="text-sm text-muted" data-testid="find-work-count">{t('files.findWork.lookingCount', { n: phase.checked, docs: phase.docs })}</p>}
        <p className="text-sm text-muted">{phase.s === 'asking' ? t('files.findWork.askingHint', { app: PRODUCT.displayName }) : t('files.findWork.lookingHint')}</p>
        <div className="flex flex-wrap gap-3">
          {phase.s === 'looking' && <Button onClick={() => bridge.stop()} data-testid="find-work-stop">{t('files.findWork.stop')}</Button>}
          {phase.s === 'ranking' && <Button onClick={() => rankAbort.current?.abort()} data-testid="find-work-stop">{t('files.findWork.stop')}</Button>}
        </div>
      </div>
    )
  }
  if (phase.s === 'error') {
    return (
      <div className="space-y-4" data-testid="find-work" data-screen="error">
        <p className="text-sm text-ink" role="status">{phase.text}</p>
        <div className="flex justify-end"><Button onClick={onClose} data-testid="find-work-close">{t('common.close')}</Button></div>
      </div>
    )
  }

  const allow = (
    <>
      <button type="button" className={quietLink} onClick={() => bridge.openSettings()} data-testid="find-work-settings">{t('files.findWork.allowInSettings')}</button>
      {' · '}
      <a className={quietLink} href={FIND_WORK_FILES_GUIDE} target="_blank" rel="noreferrer" data-testid="find-work-guide">{t('files.findWork.how')}</a>
    </>
  )
  // every folder kept out: the title says so, and the way to let the app in is said once
  const allBlocked = phase.s === 'none' && notes.blocked.length > 0
  const lines = (
    <div className="space-y-1.5" data-testid="find-work-notes">
      {allBlocked ? <p className="text-sm text-ink" data-testid="find-work-blocked-all">{allow}</p> : notes.blocked.map((r) => (
        <p key={r.id} className="text-sm text-ink" role="status" data-testid="find-work-blocked" data-root={r.id}>
          {t('files.findWork.blocked', { app: PRODUCT.displayName, folder: rootName(r) })}{' · '}{allow}
        </p>
      ))}
      {notes.cut.map((r) => <p key={r.id} className="text-label text-muted" data-testid="find-work-cut" data-root={r.id}>{t('files.findWork.cut', { folder: rootName(r) })}</p>)}
      {notes.left.map((r) => <p key={r.id} className="text-label text-muted" data-testid="find-work-left" data-root={r.id}>{t('files.findWork.leftOut', { folder: rootName(r) })}</p>)}
      {stopped && <p className="text-label text-muted" data-testid="find-work-stopped">{t('files.findWork.stopped')}</p>}
      {notes.tooBig > 0 && <p className="text-label text-muted" data-testid="find-work-too-big">{t('welcome.teamFiles.tooBig', { n: notes.tooBig })}</p>}
      {already > 0 && <p className="text-label text-muted" data-testid="find-work-already">{t('files.findWork.already', { n: already, place: placeName })}</p>}
    </div>
  )

  // nothing to look at (every folder blocked or left out) or nothing found
  if (phase.s === 'none' || !docs.length) {
    return (
      <div className="space-y-4" data-testid="find-work" data-screen={phase.s === 'none' ? 'none' : 'empty'}>
        <h2 className="text-display font-semibold text-ink" data-testid="find-work-title">{phase.s === 'none' ? t('files.findWork.noneTitle', { app: PRODUCT.displayName }) : t('files.findWork.emptyTitle')}</h2>
        {lines}
        <div className="flex flex-wrap justify-end gap-3">
          <Button onClick={onClose} data-testid="find-work-close">{t('common.close')}</Button>
          {allBlocked && <Button variant="primary" onClick={onAgain} data-testid="find-work-again">{t('files.findWork.again')}</Button>}
        </div>
      </div>
    )
  }

  const title = work.length ? t('files.findWork.title', { n: work.length }) : t('files.findWork.titleNone', { n: docs.length })
  return (
    <div className="space-y-4" data-testid="find-work" data-screen="list">
      <div className="space-y-1">
        <h2 className="text-display font-semibold text-ink" data-testid="find-work-title">{title}</h2>
        <p className="text-sm text-balance text-muted">{audience === 'me' ? t('files.findWork.descMe', { place: placeName }) : t('files.findWork.descTeam', { place: placeName })}</p>
      </div>
      {lines}
      <TickSearch value={q} onChange={setQ} placeholder={t('welcome.teamFiles.search')} pad="px-0" testId="find-work-search" />
      <div className={frame}>
        {found ? (
          <>
            <ul data-testid="find-work-found">{rows(found)}</ul>
            {!found.length && <p className={clsx('py-2.5 text-label text-faint', pad)}>{t('welcome.teamFiles.searchNone')}</p>}
          </>
        ) : (
          <>
            {work.length > 0 && (
              <>
                <div className={clsx('flex min-h-11 items-center gap-2 py-2.5 text-sm', pad)}>
                  <span className="min-w-0 font-medium text-ink">{t('files.findWork.work', { n: work.length })}</span>
                  <button type="button" className={clsx(quietLink, 'ml-auto shrink-0')} onClick={() => { const r = selectAll(ticks, work); setTicks(r.ticks); setCapped(r.capped) }} data-testid="find-work-select-all">
                    {t('files.findWork.selectAll', { n: Math.min(work.length, L.perUpload) })}
                  </button>
                </div>
                <ul className="border-t border-line" data-testid="find-work-work">{rows(work)}</ul>
                {rest > 0 && <p className={clsx('border-t border-line py-2.5 text-label text-faint', pad)} data-testid="find-work-rest">{t('files.findWork.rest', { n: rest })}</p>}
              </>
            )}
            {personal.length > 0 && (
              <>
                <TickFold label={t('files.findWork.personal', { n: personal.length })} aside={t('files.findWork.notSentToAi')} open={openPersonal} onToggle={() => setOpenPersonal(!openPersonal)} controls={`${ids}-personal`} pad={pad} phone={phone} testId="find-work-personal-toggle" />
                {openPersonal && <ul id={`${ids}-personal`} className="border-t border-line" data-testid="find-work-personal">{rows(personal)}</ul>}
              </>
            )}
          </>
        )}
      </div>
      <p className="text-label text-muted" data-testid="find-work-ai">{noAi ? t('files.findWork.noAi') : picks ? t('files.findWork.byAi') : t('files.findWork.byNames')}</p>
      {capped && <p className="text-label text-warn" role="status" data-testid="find-work-cap">{t('welcome.teamFiles.cap', { n: L.perUpload })}</p>}
      {tooMuch && <p className="text-label text-warn" role="status" data-testid="find-work-bytes">{t('files.findWork.bytes')}</p>}
      <div className={phone ? 'space-y-2' : 'flex flex-wrap items-center justify-end gap-3'}>
        <Button variant="ghost" className={phone ? 'w-full' : undefined} onClick={onClose} data-testid="find-work-cancel">{t('common.cancel')}</Button>
        <Button variant="primary" className={phone ? 'w-full' : undefined} disabled={!ticks.size || tooMuch} onClick={() => onAdd(docs.filter((d) => ticks.has(d.key)))} data-testid="find-work-add">
          {ticks.size ? t('files.findWork.add', { n: ticks.size }) : t('files.findWork.addNone')}
        </Button>
      </div>
    </div>
  )
}

/** Why a file of a run did not go: the desktop app's reason for a refused read (moved or changed since the look, the look
 * too old or replaced, its limits), else the file screen's words. */
export function failedReason(r: { local?: string; error?: unknown }, t: ReturnType<typeof useT>, locale: ReturnType<typeof useLocale>): string {
  if (r.error instanceof WorkFileReadError) {
    if (r.error.reason === 'changed') return t('files.findWork.why.changed')
    if (r.error.reason === 'limit') return t('files.findWork.why.limit')
    return t('files.findWork.why.lookAgain')
  }
  if (r.local === 'unreadable') return t('files.folderUpload.unreadable')
  if (r.local === 'tooLarge') return t('files.folderUpload.tooLarge', { size: formatSize(L.fileBytes, locale) })
  return errorText(r.error, locale, t('error.network'))
}

// ---------------------------------------------------------------- My files

/** "이미 있어요" for a folder: the documents whose path in `base` is taken by a file of the same size. Listed from `base`
 * down, only folders that are there (My files is there; From this computer may not be yet). */
async function alreadyThere(docs: readonly LocalDoc[], base: string): Promise<Set<string>> {
  return findAlready(docs, base, async (path) => {
    try {
      const out: { name: string; type: 'file' | 'folder'; size: number }[] = []
      let cursor: string | null = null
      do {
        const r: TreeResponse = await api.call(API.tree, { query: { path, ...(cursor ? { cursor } : {}) } })
        for (const e of r.entries) out.push({ name: e.name, type: e.type === 'folder' ? 'folder' : 'file', size: e.size ?? 0 })
        cursor = r.nextCursor
      } while (cursor && out.length < 5000)
      return out
    } catch {
      return null
    }
  })
}

/** The runs into My files (by their FolderUpload, which stays the same while the run's store entry is replaced on every
 * change): each file it made and each folder it made, for Undo. */
const made = new WeakMap<FolderUpload, RunMade>()

/**
 * My files on the desktop app (Windows, the Mac app from the website): one quiet line, "Find work files on this computer",
 * for anyone but guests. It opens the steps above in a dialog; the files go to My files › From this computer (only the
 * person sees them), as the person's own AI turn. Not in a browser, on a phone, in the Mac App Store build or an older
 * desktop app (no matching bridge).
 */
export function FindWorkFilesEntry({ here }: { here: string }) {
  const t = useT()
  const me = useMeStrict()
  const narrow = useMediaQuery('(max-width: 767.98px)')
  const bridge = workFilesBridge(desktop())
  const own = `users/${me.user.id}`
  const [open, setOpen] = useState(false)
  const [run, setRun] = useState<Run | null>(null)
  if (!bridge || isGuestMe(me) || (here !== own && here !== runFolder(own))) return null
  const close = () => { setOpen(false); setRun(null) }
  // a run of this screen still going (the dialog was closed while it uploaded): its progress, then its result and Undo
  const reopen = () => {
    const going = taggedRun(TAG)
    setRun(going && going.view.status === 'running' && made.has(going.run) ? going : null)
    setOpen(true)
  }
  const add = (docs: LocalDoc[]) => {
    const record: RunMade = { files: [], folders: [] }
    const plan: FolderPlan = { files: docs.map((d) => ({ rel: `${FROM_COMPUTER}/${d.pick}/${d.rel}`, size: d.size, open: d.open })), folders: [], unreadable: [], skipped: 0 }
    const r = startFolderUpload(plan, own, (view) => toast({ level: 'error', text: `${errorText(view.refusal, currentLocale(), tNow('error.network'))} ${tNow('files.folderUpload.stopped', { n: view.waiting })}`, ...storagePlansAction(view.refusal) }), {
      tag: TAG,
      // a file of the person's that was there already (kept, nothing new made) is not the run's to take back
      onLanded: (p, kept) => { if (!kept) record.files.push(p) },
      onMade: (p) => record.folders.push(p),
    })
    made.set(r.run, record)
    setRun(r)
  }
  return (
    <>
      {/* the line on a computer's width; a dialog already open stays when the window is made narrow */}
      {!narrow && (
        <p className="mx-4 mb-2 text-sm sm:mx-6">
          <button type="button" className={clsx(quietLink, 'inline-flex items-center gap-1.5')} onClick={reopen} data-testid="files-find-work-entry">
            <FolderSearch size={14} className="shrink-0 text-faint" aria-hidden /> {t('files.findWork.entry')}
          </button>
        </p>
      )}
      <Modal open={open} onClose={close} title={t('files.findWork.dialogTitle')} width={640}>
        {run ? <RunResult run={run} onClose={close} phone={narrow} />
          : <FindWorkFiles bridge={bridge} rank="own" audience="me" phone={narrow} placeName={t('files.findWork.myPlace')} alreadyIn={(docs) => alreadyThere(docs.map((d) => ({ ...d, pick: `${FROM_COMPUTER}/${d.pick}` })), own)} onAdd={add} onClose={close} />}
      </Modal>
    </>
  )
}

/** The run's progress, then "Added 6 files to My files › From this computer" with Open and Undo. */
function RunResult({ run: start, onClose, phone }: { run: Run; onClose: () => void; phone: boolean }) {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  const words = useFolderWords()
  const run = useRuns((s) => s.runs.find((r) => r.run === start.run) ?? (s.tagged[TAG]?.run === start.run ? s.tagged[TAG] : null)) ?? start
  const v = run.view
  const running = v.status === 'running'
  const [undo, setUndo] = useState<{ s: 'idle' } | { s: 'busy' } | { s: 'done'; n: number; until: string | null; failed: number } | { s: 'error'; text: string }>({ s: 'idle' })
  const folder = runFolder(start.view.base)
  const failed = run.run.rows().filter((r) => r.state === 'failed')
  const takeBack = async () => {
    const record = made.get(start.run)
    if (!record) return
    setUndo({ s: 'busy' })
    try {
      const r = await undoRun(record, {
        remove: (path) => api.call(API.remove, { query: { path } }),
        isEmpty: async (path) => {
          try { return (await api.call(API.tree, { query: { path, limit: 1 } })).entries.length === 0 } catch { return null }
        },
      })
      setUndo({ s: 'done', n: r.removed.length, until: r.purgeAt, failed: r.failed.length })
    } catch (e) {
      setUndo({ s: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }
  const until = (iso: string | null) => (iso ? new Intl.DateTimeFormat(intlTag(locale), { month: 'long', day: 'numeric' }).format(new Date(iso)) : null)
  return (
    <div className="space-y-4" data-testid="find-work-run" data-status={v.status}>
      <h2 className="text-display font-semibold text-ink" role="status" data-testid="find-work-run-title">
        {undo.s === 'done' && undo.n > 0 ? t('files.findWork.undone', { n: undo.n }) : undo.s === 'done' ? t('files.findWork.undoFailed', { n: undo.failed }) : running ? t('welcome.teamFiles.uploading', { k: v.done, n: v.total }) : t('files.findWork.added', { n: v.done, place: words.path(folder, ' › ') })}
      </h2>
      {undo.s === 'done' && undo.until && <p className="text-sm text-muted" data-testid="find-work-undone-until">{t('files.findWork.undoneUntil', { date: until(undo.until)! })}</p>}
      {undo.s === 'done' && undo.n > 0 && undo.failed > 0 && <ErrorNote>{t('files.findWork.undoFailed', { n: undo.failed })}</ErrorNote>}
      {undo.s === 'error' && <ErrorNote>{undo.text}</ErrorNote>}
      {!running && undo.s !== 'done' && failed.length > 0 && (
        <ErrorNote>
          {t('files.findWork.notAdded', { n: failed.length })}
          <ul className="mt-1 space-y-0.5" data-testid="find-work-failed">
            {failed.slice(0, 5).map((r) => <li key={r.rel} className="truncate">{r.rel.split('/').pop()} · {failedReason(r, t, locale)}</li>)}
          </ul>
        </ErrorNote>
      )}
      {undo.s !== 'done' && !running && <p className="text-label text-muted">{t('files.findWork.originalsStay')}</p>}
      <div className={phone ? 'flex flex-col-reverse gap-2 [&>*]:w-full' : 'flex flex-wrap items-center justify-end gap-3'}>
        {running ? (
          <Button onClick={() => void stopFolderUpload(run)} data-testid="find-work-stop-upload">{t('welcome.teamFiles.stopUpload')}</Button>
        ) : (
          <>
            {undo.s !== 'done' && v.done > 0 && (
              <Button variant="ghost" busy={undo.s === 'busy'} onClick={() => void takeBack()} data-testid="find-work-undo"><Undo2 size={14} aria-hidden /> {t('files.findWork.undo')}</Button>
            )}
            {undo.s !== 'done' && v.done > 0 && <Button onClick={() => { onClose(); navigate(`/files?path=${encodeURIComponent(folder)}`) }} data-testid="find-work-open">{t('files.findWork.open')}</Button>}
            <Button variant="primary" onClick={onClose} data-testid="find-work-done">{t('common.close')}</Button>
          </>
        )}
      </div>
    </div>
  )
}
