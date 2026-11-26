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
// Three places use it: My files (useFindWorkFilesEntry) and an invited person's welcome card on Home (its optional "Bring
// work files from this computer" row), both through useMyWorkFiles (the files go to My files › From this computer, the
// member's own AI turn; then the share step, ShareFoundFiles.tsx: which of them to share with whom, nothing ticked, Not
// now; the result has Open and Undo), and the setup's 팀 파일 step on the desktop app (TeamFilesStep: the owner's files go
// to the team home as before, the team pick, then the step's own run and folder plan).
import clsx from 'clsx'
import { FolderSearch, Loader2, Undo2 } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import { TEAM_FILES_LIMITS, type TeamFileReason, type TreeResponse } from '@mycel/shared/api'
import type { WorkFileScan, WorkFolderId, WorkRootId, WorkRootResult } from '@mycel/shared'
import { api, API, errorText } from '../../lib/api'
import { desktop } from '../../lib/desktop'
import type { FolderPlan, FolderUpload } from '../../lib/folderUpload'
import { taggedRun, useRuns, type Run } from '../../lib/folderRuns'
import { formatSize, intlTag } from '../../lib/format'
import { findAlready, findDocs, rankEntries, tick, type LocalDoc } from '../../lib/teamFiles'
import { carried, carryOver, pickUp, companyMatch, confirmAdd, isStale, lookAgainHelps, STALE_MS, workReadReason, type CarriedFile, docsFromScan, fullDiskLater, setFullDiskLater, FIND_WORK_FILES_GUIDE, forAiRecent, FROM_COMPUTER, lookWords, offersWide, overBytes, personalList, ROOT_FOLDER, rootNotes, runFolder, selectAll, touched, undoRun, WorkFileReadError, workFilesBridge, workList, type CompanyWordsLike, type RunMade, type WorkFilesBridge } from '../../lib/workFiles'
import { takeResume } from '../../lib/workFilesResume'
import { FullDiskAccess } from './FullDiskAccess'
import { useFolderWords } from '../../lib/folderLabels'
import { currentLocale, t as tNow, useLocale, useT, type MessageKey } from '../../i18n'
import { useMe, useMeStrict } from '../../store/session'
import { isGuestMe } from '../../lib/guests'
import { toast } from '../../store/ui'
import { startFolderUpload, stopFolderUpload } from '../FolderUploads'
import { Tooltip } from '../Tooltip'
import { FromCloudLine } from '../FromCloud'
import { Button, ErrorNote, Modal, ProgressBar, Skeleton, useMediaQuery } from '../ui'
import { storagePlansAction } from '../StoragePlansLink'
import { TickFold, TickRow, TickSearch } from './TickList'
import { ShareFoundFiles, type SharedResult } from './ShareFoundFiles'

const L = TEAM_FILES_LIMITS
const TAG = 'find-work-files' as const
/** rows drawn per group at most (the rest: found by name) */
const ROWS_SHOWN = 200
export { FIND_WORK_FILES_GUIDE } from '../../lib/workFiles'
const quietLink = 'font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink disabled:opacity-50'

const ROOT_WORD: Record<WorkFolderId, MessageKey> = { documents: 'files.findWork.root.documents', desktop: 'files.findWork.root.desktop', downloads: 'files.findWork.root.downloads' }
const ROOT_OF: Record<string, WorkFolderId> = Object.fromEntries(Object.entries(ROOT_FOLDER).map(([id, name]) => [name, id as WorkFolderId]))
const REASON: Record<TeamFileReason, MessageKey> = {
  form: 'welcome.teamFiles.reason.form', intro: 'welcome.teamFiles.reason.intro', report: 'welcome.teamFiles.reason.report', minutes: 'welcome.teamFiles.reason.minutes',
  brand: 'welcome.teamFiles.reason.brand', policy: 'welcome.teamFiles.reason.policy', training: 'welcome.teamFiles.reason.training', proposal: 'welcome.teamFiles.reason.proposal',
}

const isFolder = (id: WorkRootId): id is WorkFolderId => id === 'documents' || id === 'desktop' || id === 'downloads'

/** A place in words (part 5): "OneDrive – Acme", "Projects", "KakaoTalk downloads", "Home folder", "D:". */
function usePlaceName() {
  const t = useT()
  return (p: { kind: WorkRootId; label: string }) =>
    p.kind === 'home' ? t('files.findWork.place.home') : p.kind === 'messenger' ? t('files.findWork.place.messenger', { name: p.label }) : p.label
}

/** A root in words: "Documents", "Documents (OneDrive)", or a place's name. */
function useRootName() {
  const t = useT()
  const placeName = usePlaceName()
  return (r: Pick<WorkRootResult, 'id' | 'oneDrive' | 'place'>) => {
    if (!isFolder(r.id)) return placeName({ kind: r.id, label: r.place ?? '' })
    return r.oneDrive ? t('files.findWork.root.oneDrive', { folder: t(ROOT_WORD[r.id]) }) : t(ROOT_WORD[r.id])
  }
}

const NO_WORDS: CompanyWordsLike = { names: [], domains: [], people: [] }
/** How long the AI's pick usually takes (one turn of the smallest model over names): the bar's measure for that stage */
const RANK_USUAL_MS = 10_000
/** "3 days ago", "last month" in the person's language */
function relative(at: number, locale: string): string {
  // a date ahead of now (a clock off, a file from another zone) reads as now
  at = Math.min(at, Date.now())
  const days = Math.round((at - Date.now()) / 86_400_000)
  const f = new Intl.RelativeTimeFormat(intlTag(locale as never), { numeric: 'auto' })
  if (Math.abs(days) < 1) return f.format(Math.round((at - Date.now()) / 3_600_000), 'hour')
  if (Math.abs(days) < 30) return f.format(days, 'day')
  return f.format(Math.round(days / 30), 'month')
}

/** Only one look at a time in this tab (a second mount while one runs waits for the same answer). */
let scanning: Promise<WorkFileScan> | null = null
const scanOnce = (b: WorkFilesBridge, ask?: { wide: boolean; words: string[] }) => (scanning ??= (ask?.wide ? b.scan(ask) : b.scan()).finally(() => { scanning = null }))

type Phase = { s: 'asking' } | { s: 'looking'; root: WorkRootId; place?: string; checked: number; docs: number; done?: number } | { s: 'list' } | { s: 'none' } | { s: 'error'; text: string }
/** How this look goes (part 5): wide (the places beyond the three folders: Windows, a Mac with Full Disk Access) or the
 * three folders with macOS's question for each (an older app, or "Not now" on the Mac's Full Disk Access screen). */
type Mode = { wide: boolean }

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
  /** add the ticked files; the caller starts the run. `reasons`: the AI's reason for each of them it picked (by key);
   * `chosen`: the folder the person chose for a file (by key), for a later Look again (rememberRunDocs) */
  onAdd: (docs: LocalDoc[], reasons: ReadonlyMap<string, TeamFileReason>, chosen: ReadonlyMap<string, string>) => void
  /** leave (Cancel, nothing found, the app said no) */
  onClose: () => void
  phone?: boolean
  /** a new look for files the person ticked before (the run's "Look again"): those still there come ticked */
  carry?: Carry
}

/** Ticked files carried into a new look: `stale` the list was over an hour old at Add, `again` the person's Look again. */
export interface Carry { files: CarriedFile[]; why: 'stale' | 'again' }

/** While the app says whether it has Full Disk Access (the same line as the screen's own check) */
function AccessChecking() {
  const t = useT()
  return <p className="flex items-center gap-2 text-sm text-muted" role="status" data-testid="find-work-access" data-screen="checking"><Loader2 size={14} className="animate-spin" aria-hidden /> {t('files.findWork.access.checking')}</p>
}

/** The steps; "Look again" (every folder kept out, after the person let the app in) starts them over with a new look.
 * Part 5: a Mac app that offers the wide look shows the Full Disk Access screen first when the app has none (its
 * "Not now" is the three folders with macOS's question for each); Windows looks wide at once. */
export function FindWorkFiles(props: FindWorkFilesProps) {
  // whose "Not now" (none before sign-in: nothing remembered)
  const uid = useMe()?.user.id ?? ''
  const [round, setRound] = useState(0)
  // the carried ticks belong to the round they were made for (Look in more places starts a round without them)
  const [carry, setCarry] = useState<{ round: number; c: Carry } | undefined>(() => (props.carry ? { round: 0, c: props.carry } : undefined))
  const wide = offersWide(props.bridge)
  const fd = wide ? props.bridge.fullDisk : undefined
  // "Not now" on that screen within 30 days (this team, this person): straight to the three folders, unless the app has
  // Full Disk Access by now (asked first; nothing shows meanwhile)
  const [later, setLater] = useState(() => !!fd && !!uid && fullDiskLater(uid))
  const [mode, setMode] = useState<Mode | null>(() => (!wide ? { wide: false } : fd ? null : { wide: true }))
  // the person was not known yet at the first render: their Not now counts as soon as they are
  useEffect(() => { if (!mode && fd && uid && !later && fullDiskLater(uid)) setLater(true) }, [uid])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!later || mode || !fd) return
    let live = true
    fd.state().then((x) => { if (live) setMode({ wide: x === 'granted' }) }, () => { if (live) setMode({ wide: false }) })
    // an app that does not answer: the three folders after a moment
    const slow = setTimeout(() => { if (live) setMode({ wide: false }) }, 3000)
    return () => { live = false; clearTimeout(slow) }
  }, [later, mode, fd])
  if (!mode) {
    if (later) return <AccessChecking />
    return <FullDiskAccess bridge={props.bridge} onGo={(w) => { if (!w && uid) setFullDiskLater(uid, true); setMode({ wide: w }) }} from={props.rank} phone={props.phone} />
  }
  // the list's quiet "Look in more places (Full Disk Access)": the screen again, the "Not now" forgotten
  const morePlaces = fd && !mode.wide ? () => { if (uid) setFullDiskLater(uid, false); setLater(false); setMode(null); setRound((n) => n + 1) } : undefined
  return <FindWorkFilesRound key={round} {...props} carry={carry?.round === round ? carry.c : undefined} mode={mode} onAgain={(c) => { setCarry(c ? { round: round + 1, c } : undefined); setRound(round + 1) }} onMorePlaces={morePlaces} />
}

function FindWorkFilesRound({ bridge, rank, alreadyIn, audience, placeName, onAdd, onClose, onAgain, onMorePlaces, mode, carry, phone = false }: FindWorkFilesProps & { onAgain: (carry?: Carry) => void; onMorePlaces?: () => void; mode: Mode }) {
  const t = useT()
  const locale = useLocale()
  const ids = useId()
  const rootName = useRootName()
  const placeWord = usePlaceName()
  const [phase, setPhase] = useState<Phase>({ s: 'asking' })
  const [docs, setDocs] = useState<LocalDoc[]>([])
  const [roots, setRoots] = useState<WorkRootResult[]>([])
  const [stopped, setStopped] = useState(false)
  const [picks, setPicks] = useState<Map<string, TeamFileReason> | null>(null)
  /** the files the AI was shown: its answer decides for them (a file it left out is not shown) */
  const [sentKeys, setSentKeys] = useState<Set<string> | null>(null)
  const [noAi, setNoAi] = useState(false)
  const [already, setAlready] = useState(0)
  const [ticks, setTicks] = useState<Set<string>>(() => new Set())
  const [capped, setCapped] = useState(false)
  // Add: the ticked files are named to the desktop app first, which reads nothing else (TC-3300, confirmAdd)
  const [adding, setAdding] = useState(false)
  const [refused, setRefused] = useState(false)
  /** when the app's look ended (0: not yet); the app reads its files for an hour after it */
  const lookedAt = useRef(0)
  /** the list is old enough that Add looks again first (TC-219) */
  const [stale, setStale] = useState(false)
  /** carried ticks (a new look): the ones changed since, the names of the ones the app said are no longer on this
   * computer, and the ones the new look does not list (a chosen folder, now too big or too old): ticked once a pick
   * lists them */
  const [changedKeys, setChangedKeys] = useState<Set<string>>(() => new Set())
  const [gone, setGone] = useState<string[]>([])
  const [pending, setPending] = useState<CarriedFile[]>([])
  /** carried ticks left unticked by the per-upload limit */
  const [overCap, setOverCap] = useState(0)
  /** the folder the person chose for a file ("Choose a folder…", "Choose it yourself"): said again after a new look */
  const chosenFrom = useRef(new Map<string, string>())
  const lookAgain = (why: Carry['why']) => onAgain({ files: [...carried(docs.filter((d) => ticks.has(d.key)), { chosen: chosenFrom.current }), ...pending], why })
  /** a picked folder's files joined the list: the carried ones among them are ticked again */
  const pickedUp = (added: readonly LocalDoc[], label: string) => {
    for (const d of added) chosenFrom.current.set(d.key, label)
    if (!pending.length) return
    const r = pickUp(pending, added, ticks)
    setTicks(r.ticks)
    setChangedKeys((prev) => new Set([...prev, ...r.changed]))
    setPending(r.left)
    if (r.capped) setOverCap((n) => n + r.capped)
  }
  const addTicked = async () => {
    const picked = docs.filter((d) => ticks.has(d.key))
    // over an hour old: the files may have changed and the app would refuse them; a new look first, the ticks kept
    if (isStale(lookedAt.current)) return lookAgain('stale')
    setAdding(true)
    setRefused(false)
    const r = await confirmAdd(bridge, picked).finally(() => setAdding(false))
    if (r === 'added') onAdd(picked, new Map(picked.flatMap((d) => { const why = picks?.get(d.key); return why ? [[d.key, why] as const] : [] })), new Map(chosenFrom.current))
    else if (r === 'refused') setRefused(true)
  }
  useEffect(() => {
    if (phase.s !== 'list' || !lookedAt.current || stale) return
    const left = lookedAt.current + STALE_MS - Date.now()
    if (left <= 0) { setStale(true); return }
    const timer = setTimeout(() => setStale(true), left)
    return () => clearTimeout(timer)
  }, [phase.s, stale])
  const [q, setQ] = useState('')
  const [openPersonal, setOpenPersonal] = useState(false)
  const [words, setWords] = useState<CompanyWordsLike>(NO_WORDS)
  const [picking, setPicking] = useState<WorkRootId | 'any' | null>(null)
  /** the folder the person picked with "Choose a folder…": its files show until they search or press Show all */
  const [chosen, setChosen] = useState<{ label: string; keys: Set<string> } | null>(null)
  /** the AI's pick under way while the list already shows: how many names it got, since when */
  const [aiWait, setAiWait] = useState<{ n: number; at: number } | null>(null)
  // the AI's step has no progress of its own: the bar moves with the time it usually takes
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!aiWait) return
    const iv = setInterval(() => setTick((n) => n + 1), 250)
    return () => clearInterval(iv)
  }, [aiWait])
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
    // the company's words (names, domains, people); none when they cannot be read. A wide look gives the app the names
    // first (they name the home folder's work folders: "Acme", "Globex"), so it waits for them (a second at most)
    const wordsP = api.call(API.companyWords).catch((): CompanyWordsLike => NO_WORDS)
    void (async () => {
      let r: WorkFileScan
      const ask = mode.wide ? { wide: true, words: lookWords(await Promise.race([wordsP, new Promise<CompanyWordsLike>((ok) => setTimeout(() => ok(NO_WORDS), 1000))])) } : undefined
      if (!live.current) return
      try { r = await scanOnce(bridge, ask) } catch { r = { state: 'unavailable' } }
      if (!live.current) return
      // the app is still busy with a question or a look (asked again too soon): said, nothing else happens
      if (r.state === 'busy') return setPhase({ s: 'error', text: t('files.findWork.busy') })
      // the person said no in the app's own window (Not now, Esc, closing it: the app answers the same), or no app: the
      // page closes, and says it was cancelled and nothing was added (TC-3491; also true when a team switch stopped a look)
      if (r.state !== 'done') {
        // (a Look again from a run's result goes back to it: what it added stays, so no "nothing was added")
        if (r.state === 'cancelled' && carry?.why !== 'again') toast({ level: 'info', text: t('files.findWork.cancelled') })
        return onClose()
      }
      lookedAt.current = Date.now()
      setRoots(r.roots)
      setStopped(r.stopped)
      const all = docsFromScan(r.files, bridge.read)
      const there = await alreadyIn(all).catch(() => new Set<string>())
      if (!live.current) return
      const found = all.filter((d) => !there.has(d.key))
      setAlready(all.length - found.length)
      // a new look for files ticked before: those still here come ticked, the changed and the gone are said
      if (carry) {
        const c = carryOver(carry.files, all, found)
        setTicks(c.ticks)
        setChangedKeys(c.changed)
        setGone(c.missing)
        setPending(c.notListed)
        setOverCap(c.capped)
        // a carried tick on a personal-looking file shows (its group opens)
        if (found.some((d) => d.personal && c.ticks.has(d.key))) setOpenPersonal(true)
      }
      setDocs(found)
      const w = await wordsP
      if (!live.current) return
      setWords(w)
      if (!found.length) return setPhase({ s: rootNotes(r.roots).none ? 'none' : 'list' })
      // the AI picks from names only: the best recent ones by the rules, never a personal-looking one; nothing ticked
      const sent = forAiRecent(found, w)
      if (!sent.length) { setNoAi(true); return setPhase({ s: 'list' }) }
      // the list shows now (the company's files by the rules); the AI's picks join it when they come (one turn of the
      // smallest model: 8–12 s measured 2026-11-15, its engine's start-up about 5 s of it)
      setPhase({ s: 'list' })
      setAiWait({ n: sent.length, at: Date.now() })
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
      // the AI's picks decide for the files it was shown (its no is a no; an answer with no pick: the rules, workList)
      setSentKeys(got ? new Set(sent.map((d) => d.key)) : null)
      setPicks(got)
      setNoAi(!got)
      setAiWait(null)
    })()
    return off
    // one look per mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const notes = rootNotes(roots)
  /** Looks like work (docs/DECISIONS.md part 4): recent, and the company's or the AI's pick; the best 50 */
  // ticked files stay in the list (the AI's late picks never push one out of sight); recomputed with the AI's answer
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const list = useMemo(() => workList(docs, words, picks, Date.now(), ticks, sentKeys ?? undefined), [docs, words, picks, sentKeys])
  const work = list.shown
  const personal = useMemo(() => personalList(docs), [docs])
  /** looked at but in neither group: found by name */
  const rest = docs.length - work.length - personal.length
  const found = q ? findDocs(docs, q) : chosen ? docs.filter((d) => chosen.keys.has(d.key)) : null
  const pad = phone ? 'px-0' : 'px-4'
  const frame = phone ? 'border-y border-line' : 'rounded-xl border border-line bg-surface'
  const tooMuch = overBytes(docs, ticks)

  const toggle = (key: string, on: boolean) => {
    const r = tick(ticks, key, on)
    setCapped(r.refused)
    setTicks(r.ticks)
  }
  /** why it is shown, in plain words: the AI's reason, the company ("Mentions Acme", "From acme.slack.com", "By Bo"),
   * where it is, and when it was last opened or changed ("Opened 3 days ago") */
  const meta = (d: LocalDoc) => {
    const reason = picks?.get(d.key)
    const m = companyMatch(d, words)
    const root = ROOT_OF[d.pick]
    // each row names its place: "OneDrive – Acme › Clients", "KakaoTalk downloads", "Documents › Plans"
    const top = d.place ? placeWord(d.place) : root ? t(ROOT_WORD[root]) : d.pick
    const where = [top, ...(d.folder ? d.folder.split('/') : [])].join(' › ')
    const when = touched(d)
    const ago = relative(when.at, locale)
    const matchText = !m ? null : m.kind === 'name' ? t('files.findWork.match.name', { name: m.word }) : m.kind === 'from' ? t('files.findWork.match.from', { host: m.host }) : t('files.findWork.match.by', { name: m.who })
    return [reason ? t(REASON[reason]) : null, matchText, t(when.opened ? 'files.findWork.opened' : 'files.findWork.changed', { when: ago }), where, d.cloud ? t('files.findWork.inCloud') : null].filter(Boolean).join(' · ')
  }
  const personalNote = (d: LocalDoc) => (
    <>
      {changedKeys.has(d.key) && <span className="mt-0.5 block text-label text-muted" data-testid="find-work-row-changed">{t('files.findWork.why.changed')}</span>}
      {d.personal && ticks.has(d.key) && <span className="mt-0.5 block text-label text-warn" data-testid="find-work-personal-ticked">{audience === 'me' ? t('files.findWork.personalTickedMe') : t('welcome.teamFiles.personalTicked', { team: audience })}</span>}
    </>
  )
  const row = (d: LocalDoc, i: number) => (
    <TickRow key={d.key} id={`${ids}-${d.key}`} rowKey={d.key} name={d.name} meta={meta(d)} first={i === 0} pad={pad} checked={ticks.has(d.key)} onChange={(v) => toggle(d.key, v)} note={personalNote(d)} testId="find-work-row" checkTestId="find-work-check" />
  )
  const rows = (list: readonly LocalDoc[]) => (
    <>
      {list.slice(0, ROWS_SHOWN).map(row)}
      {list.length > ROWS_SHOWN && <li className={clsx('border-t border-line py-2.5 text-label text-faint', pad)}>{t('welcome.teamFiles.moreRows', { n: list.length - ROWS_SHOWN })}</li>}
    </>
  )

  if (phase.s === 'asking' || phase.s === 'looking') {
    const title = phase.s === 'asking' ? t('files.findWork.asking') : t('files.findWork.looking', { folder: isFolder(phase.root) ? t(ROOT_WORD[phase.root]) : placeWord({ kind: phase.root, label: phase.place ?? '' }) })
    // the folders' stages as the app measures them (the AI's pick runs while the list already shows)
    const value = phase.s === 'looking' ? (phase.done ?? 0) : 0
    return (
      <div className="space-y-4" data-testid="find-work" data-screen={phase.s}>
        <h2 className="flex items-center gap-2 text-display font-semibold text-ink" role="status" data-testid="find-work-title">
          <Loader2 size={16} className="shrink-0 animate-spin text-accent-text" aria-hidden /> {title}
        </h2>
        {phase.s !== 'asking' && <ProgressBar value={value} label={title} testId="find-work-progress" />}
        {phase.s === 'looking' && <p className="text-sm text-muted" data-testid="find-work-count">{t('files.findWork.lookingCount', { n: phase.checked, docs: phase.docs })}</p>}
        <p className="text-sm text-muted">{phase.s === 'asking' ? t('files.findWork.askingHint', { app: PRODUCT.displayName }) : t('files.findWork.lookingHint')}</p>
        <div className="flex flex-wrap gap-3">
          {phase.s === 'looking' && <Button onClick={() => bridge.stop()} data-testid="find-work-stop">{t('files.findWork.stop')}</Button>}
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

  /** "Choose it yourself": the system's folder window opens at the folder macOS kept the app out of; the pick is the
   * person's permission (no trip to System Settings, where a refused app may not even be listed). Its files join the
   * list. An app without it (older) offers Settings. */
  const choose = async (id: WorkFolderId) => {
    if (!bridge.pickRoot || picking) return
    setPicking(id)
    try {
      const r = await bridge.pickRoot(id)
      if (!live.current || r.state !== 'done') return
      const all = docsFromScan(r.files, bridge.read)
      const there = await alreadyIn(all).catch(() => new Set<string>())
      const added = all.filter((d) => !there.has(d.key))
      setDocs((prev) => { const keys = new Set(prev.map((d) => d.key)); return [...prev, ...added.filter((d) => !keys.has(d.key))] })
      setRoots((prev) => prev.map((x) => (x.id === id ? { ...x, ...(r.roots[0] ?? {}), id } : x)))
      pickedUp(added, rootName({ id, oneDrive: r.roots[0]?.oneDrive ?? false, place: r.roots[0]?.place }))
      setPhase((x) => (x.s === 'none' ? { s: 'list' } : x))
    } catch { /* the window closed or the app could not look: the line stays */ } finally {
      if (live.current) setPicking(null)
    }
  }
  /** "Choose a folder…" (MAN-057): the person points the app at one folder the look missed; the system's folder window
   * is their permission (an app without it: no link). The folder's files join the list and show at once. */
  const chooseFolder = async () => {
    if (!bridge.pickFolder || picking) return
    setPicking('any')
    try {
      const r = await bridge.pickFolder()
      if (!live.current || r.state !== 'done') return
      const all = docsFromScan(r.files, bridge.read)
      const there = await alreadyIn(all).catch(() => new Set<string>())
      if (!live.current) return
      const added = all.filter((d) => !there.has(d.key))
      setDocs((prev) => { const keys = new Set(prev.map((d) => d.key)); return [...prev, ...added.filter((d) => !keys.has(d.key))] })
      setRoots((prev) => [...prev.filter((x) => !r.roots.some((y) => y.id === x.id && (y.place ?? '') === (x.place ?? '') && !isFolder(y.id))), ...r.roots.filter((y) => !isFolder(y.id))])
      // the picked folder's own name (the app says it as the root's place, inside one of the three folders too)
      const top = r.roots[0]
      const label = top?.place || (top ? rootName(top) : '')
      pickedUp(added, label)
      setQ('')
      // every file of the pick (one listed before under the same name is shown too; one already in the target is not)
      setChosen({ label, keys: new Set(all.map((d) => d.key)) })
      setPhase((x) => (x.s === 'none' ? { s: 'list' } : x))
    } catch { /* the window closed or the app could not look: nothing changes */ } finally {
      if (live.current) setPicking(null)
    }
  }
  // while the window is up and the folder is looked through, the link says so (no panel of its own)
  const chooseLink = !bridge.pickFolder ? null : picking === 'any' ? (
    <span className="inline-flex items-center gap-1.5 text-label text-muted" role="status" data-testid="find-work-choosing"><Loader2 size={12} className="animate-spin" aria-hidden /> {t('files.findWork.choosing')}</span>
  ) : (
    <button type="button" className={clsx(quietLink, 'text-label')} disabled={!!picking} onClick={() => void chooseFolder()} data-testid="find-work-choose-folder">{t('files.findWork.chooseFolder')}</button>
  )
  const allow = (id: WorkRootId | null) => (
    <>
      {bridge.pickRoot && id && isFolder(id) ? (
        <button type="button" className={quietLink} disabled={!!picking} onClick={() => void choose(id)} data-testid="find-work-choose" data-root={id}>{t('files.findWork.chooseYourself')}</button>
      ) : (
        <button type="button" className={quietLink} onClick={() => bridge.openSettings()} data-testid="find-work-settings">{t('files.findWork.allowInSettings')}</button>
      )}
      {' · '}
      <a className={quietLink} href={FIND_WORK_FILES_GUIDE} target="_blank" rel="noreferrer" data-testid="find-work-guide">{t('files.findWork.how')}</a>
    </>
  )
  const names = (list: readonly string[]) => list.slice(0, 3).join(', ') + (list.length > 3 ? ', …' : '')
  /** the folders the not-listed files were chosen from, once each */
  const chosenAgain = [...new Set(pending.flatMap((c) => (c.chosen ? [c.chosen] : [])))]
  // every folder kept out: the title says so, and the way to let the app in is said once
  const allBlocked = phase.s === 'none' && notes.blocked.length > 0
  const lines = (
    <div className="space-y-1.5" data-testid="find-work-notes">
      {notes.blocked.map((r) => (
        <p key={`${r.id}:${r.place ?? ''}`} className="text-sm text-ink" role="status" data-testid="find-work-blocked" data-root={r.id}>
          {t('files.findWork.blocked', { app: PRODUCT.displayName, folder: rootName(r) })}{' · '}{allow(r.id)}
        </p>
      ))}
      {notes.cut.map((r) => <p key={`${r.id}:${r.place ?? ''}`} className="text-label text-muted" data-testid="find-work-cut" data-root={r.id}>{t('files.findWork.cut', { folder: rootName(r) })}</p>)}
      {notes.left.map((r) => <p key={`${r.id}:${r.place ?? ''}`} className="text-label text-muted" data-testid="find-work-left" data-root={r.id}>{t('files.findWork.leftOut', { folder: rootName(r) })}</p>)}
      {stopped && <p className="text-label text-muted" data-testid="find-work-stopped">{t('files.findWork.stopped')}</p>}
      {notes.tooBig > 0 && <p className="text-label text-muted" data-testid="find-work-too-big">{t('welcome.teamFiles.tooBig', { n: notes.tooBig })}</p>}
      {already > 0 && <p className="text-label text-muted" data-testid="find-work-already">{t('files.findWork.already', { n: already, place: placeName })}</p>}
      {carry?.why === 'stale' && <p className="text-sm text-ink" role="status" data-testid="find-work-looked-again">{t('files.findWork.lookedAgain')}</p>}
      {gone.length > 0 && <p className="text-sm text-warn" role="status" data-testid="find-work-gone">{t('files.findWork.gone', { n: gone.length, names: names(gone) })}</p>}
      {overCap > 0 && <p className="text-sm text-warn" role="status" data-testid="find-work-carry-capped">{t('files.findWork.carryCapped', { n: overCap, max: L.perUpload })}</p>}
      {pending.length > 0 && (
        <p className="text-sm text-ink" role="status" data-testid="find-work-not-listed">
          {t('files.findWork.notListed', { n: pending.length, names: names(pending.map((c) => c.name)) })}
          {bridge.pickFolder && (
            <>
              {' · '}
              <button type="button" className={quietLink} disabled={!!picking} onClick={() => void chooseFolder()} data-testid="find-work-choose-again">
                {chosenAgain.length ? t('files.findWork.chooseAgain', { folder: chosenAgain.join(', ') }) : t('files.findWork.chooseFolder')}
              </button>
            </>
          )}
        </p>
      )}
    </div>
  )

  // nothing to look at (every folder blocked or left out) or nothing found
  if (phase.s === 'none' || !docs.length) {
    return (
      <div className="space-y-4" data-testid="find-work" data-screen={phase.s === 'none' ? 'none' : 'empty'}>
        <h2 className="text-display font-semibold text-ink" data-testid="find-work-title">{phase.s === 'none' ? t('files.findWork.noneTitle', { app: PRODUCT.displayName }) : t('files.findWork.emptyTitle')}</h2>
        {lines}
        {chooseLink && <p>{chooseLink}</p>}
        <div className="flex flex-wrap justify-end gap-3">
          <Button onClick={onClose} data-testid="find-work-close">{t('common.close')}</Button>
          {allBlocked && <Button variant="primary" onClick={() => onAgain()} data-testid="find-work-again">{t('files.findWork.again')}</Button>}
        </div>
      </div>
    )
  }

  const title = work.length ? t('files.findWork.title', { n: work.length }) : t('files.findWork.emptyWork')
  return (
    <div className="space-y-4" data-testid="find-work" data-screen="list">
      <div className="space-y-1">
        <h2 className="text-display font-semibold text-ink" data-testid="find-work-title">{title}</h2>
        <p className="text-sm text-balance text-muted">{audience === 'me' ? t('files.findWork.descMe', { place: placeName }) : t('files.findWork.descTeam', { place: placeName })}</p>
        {!work.length && <p className="text-sm text-muted" data-testid="find-work-search-hint">{t('files.findWork.searchHint', { n: docs.length })}</p>}
        {(onMorePlaces || chooseLink) && (
          <p className="flex flex-wrap gap-x-4 gap-y-1">
            {onMorePlaces && <button type="button" className={clsx(quietLink, 'text-label')} onClick={onMorePlaces} data-testid="find-work-more-places">{t('files.findWork.morePlaces')}</button>}
            {chooseLink}
          </p>
        )}
      </div>
      {lines}
      <TickSearch value={q} onChange={(v) => { setQ(v); setChosen(null) }} placeholder={t('welcome.teamFiles.search')} pad="px-0" testId="find-work-search" />
      {chosen && !q && (
        <p className="text-label text-muted" role="status" data-testid="find-work-chosen">
          {t('files.findWork.chosen', { n: found?.length ?? 0, folder: chosen.label })}{' · '}
          <button type="button" className={quietLink} onClick={() => setChosen(null)} data-testid="find-work-show-all">{t('files.findWork.showAll')}</button>
        </p>
      )}
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
      {aiWait ? (
        <div className="space-y-1.5" data-testid="find-work-ai-wait">
          <p className="flex items-center gap-2 text-label text-muted" role="status">
            {t('files.findWork.aiPicking', { n: aiWait.n })}
            <button type="button" className={quietLink} onClick={() => rankAbort.current?.abort()} data-testid="find-work-ai-stop">{t('files.findWork.stop')}</button>
          </p>
          <ProgressBar value={Math.min(0.95, (Date.now() - aiWait.at) / RANK_USUAL_MS)} label={t('files.findWork.aiPicking', { n: aiWait.n })} />
        </div>
      ) : <p className="text-label text-muted" data-testid="find-work-ai">{noAi ? t('files.findWork.noAi') : picks ? t('files.findWork.byAi') : t('files.findWork.byNames')}</p>}
      {capped && <p className="text-label text-warn" role="status" data-testid="find-work-cap">{t('welcome.teamFiles.cap', { n: L.perUpload })}</p>}
      {tooMuch && <p className="text-label text-warn" role="status" data-testid="find-work-bytes">{t('files.findWork.bytes')}</p>}
      {refused && (
        <p className="text-label text-warn" role="status" data-testid="find-work-add-refused">
          {t('files.findWork.addRefused')}{' '}
          <button type="button" className={quietLink} onClick={() => lookAgain('again')} data-testid="find-work-refused-again">{t('files.findWork.again')}</button>
        </p>
      )}
      {stale && !refused && <p className="text-label text-muted" role="status" data-testid="find-work-stale">{t('files.findWork.stale')}</p>}
      <div className={phone ? 'space-y-2' : 'flex flex-wrap items-center justify-end gap-3'}>
        <Button variant="ghost" className={phone ? 'w-full' : undefined} onClick={onClose} data-testid="find-work-cancel">{t('common.cancel')}</Button>
        <Button variant="primary" className={phone ? 'w-full' : undefined} disabled={!ticks.size || tooMuch} busy={adding} onClick={() => void addTicked()} data-testid="find-work-add">
          {ticks.size ? t('files.findWork.add', { n: ticks.size }) : t('files.findWork.addNone')}
        </Button>
      </div>
    </div>
  )
}

/** Why a file of a run did not go: the desktop app's reason for a refused read (moved or changed since the look, the look
 * too old or replaced, its limits), else the file screen's words. */
export function failedReason(r: { local?: string; error?: unknown }, t: ReturnType<typeof useT>, locale: ReturnType<typeof useLocale>): string {
  const why = workReadReason(r.error, t)
  if (why) return why
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
/** the same runs: the AI's reason for each file it picked, by the path it was added at (the share step's hint) */
const reasonsOf = new WeakMap<FolderUpload, Map<string, TeamFileReason>>()
const runRel = (d: Pick<LocalDoc, 'pick' | 'rel'>) => `${FROM_COMPUTER}/${d.pick}/${d.rel}`

/** A run's files found on this computer, by their path inside the run, and the folder the person chose for each: a file
 * of it that failed changed or gone goes to a new look ("Look again", lookAgainOf). My files' runs and the setup step's. */
const runDocs = new WeakMap<FolderUpload, { docs: Map<string, LocalDoc>; chosen: ReadonlyMap<string, string> }>()
export function rememberRunDocs(run: FolderUpload, docs: readonly LocalDoc[], relOf: (d: LocalDoc) => string, chosen: ReadonlyMap<string, string>) {
  runDocs.set(run, { docs: new Map(docs.map((d) => [relOf(d), d])), chosen })
}
/** The run's failed files a new look would help (changed or gone since the look, the look too old), to carry into it:
 * the app's 'missing' said as such. Empty for a run not of found files. */
export function lookAgainOf(run: FolderUpload): CarriedFile[] {
  const given = runDocs.get(run)
  if (!given) return []
  const failed = run.rows().filter((r) => r.state === 'failed' && lookAgainHelps(r.error))
  const docs = failed.flatMap((r) => { const d = given.docs.get(r.rel); return d ? [d] : [] })
  const missing = new Set(failed.flatMap((r) => { const d = given.docs.get(r.rel); return d && r.error instanceof WorkFileReadError && r.error.reason === 'missing' ? [d.key] : [] }))
  return carried(docs, { missing, chosen: given.chosen })
}

/**
 * The My files dialog of "Find work files on this computer": the steps above, the files to My files › From this computer
 * (only the person sees them), as the person's own AI turn; then the run's result with Open and Undo. Two places open
 * it: the toolbar button on My files (useFindWorkFilesEntry) and the invited person's welcome card on Home (MemberWelcome.tsx,
 * the optional "Bring work files from this computer" row). `available` is false in a browser, on a phone's app, in the
 * Mac App Store build, in a desktop app without the bridge's version, and for guests: nothing to show then.
 * `onChange`: the dialog closed or a run's Undo ended (the card reads its rows again); `onLanded`: a new file is up.
 */
export function useMyWorkFiles(o: { onChange?: () => void; onLanded?: () => void } = {}) {
  const t = useT()
  const me = useMeStrict()
  const narrow = useMediaQuery('(max-width: 767.98px)')
  const bridge = workFilesBridge(desktop())
  const own = `users/${me.user.id}`
  const [open, setOpen] = useState(false)
  const [run, setRun] = useState<Run | null>(null)
  /** "Look again" on a run's result: its files that did not go, for the new look */
  const [carry, setCarry] = useState<Carry | undefined>(undefined)
  /** the run whose result the Look again came from: leaving the new look (the app's window cancelled, Cancel) goes back
   * to it, its result and Undo */
  const [from, setFrom] = useState<Run | null>(null)
  /** back on a run's result from a Look again: its share step is not asked again */
  const [back, setBack] = useState(false)
  const available = !!bridge && !isGuestMe(me)
  const close = () => { setOpen(false); setRun(null); setCarry(undefined); setFrom(null); setBack(false); o.onChange?.() }
  const lookAgain = (files: CarriedFile[]) => { setCarry({ files, why: 'again' }); setFrom(run); setRun(null) }
  const backToRun = () => { setRun(from); setFrom(null); setCarry(undefined); setBack(true) }
  // a run of this screen still going (the dialog was closed while it uploaded): its progress, then its result and Undo
  const start = () => {
    const going = taggedRun(TAG)
    setRun(going && going.view.status === 'running' && made.has(going.run) ? going : null)
    setCarry(undefined)
    setFrom(null)
    setBack(false)
    setOpen(true)
  }
  // back from "Restart <product>" on the Full Disk Access screen (lib/workFiles.ts saveResume): the same dialog again,
  // on the page it was opened from (My files' line or the welcome card), which goes on by itself once the app has it
  const location = useLocation()
  useEffect(() => {
    if (available && takeResume(me.user.id, 'own', location.pathname + location.search)) start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, me.user.id, location.pathname, location.search])
  const add = (docs: LocalDoc[], reasons: ReadonlyMap<string, TeamFileReason>, chosen: ReadonlyMap<string, string>) => {
    const record: RunMade = { files: [], folders: [] }
    const plan: FolderPlan = { files: docs.map((d) => ({ rel: runRel(d), size: d.size, open: d.open })), folders: [], unreadable: [], skipped: 0 }
    const why = new Map(docs.flatMap((d) => { const r = reasons.get(d.key); return r ? [[`${own}/${FROM_COMPUTER}/${d.pick}/${d.rel}`, r] as const] : [] }))
    const r = startFolderUpload(plan, own, (view) => toast({ level: 'error', text: `${errorText(view.refusal, currentLocale(), tNow('error.network'))} ${tNow('files.folderUpload.stopped', { n: view.waiting })}`, ...storagePlansAction(view.refusal) }), {
      tag: TAG,
      // a file of the person's that was there already (kept, nothing new made) is not the run's to take back
      onLanded: (p, kept) => { if (!kept) { record.files.push(p); o.onLanded?.() } },
      onMade: (p) => record.folders.push(p),
    })
    made.set(r.run, record)
    reasonsOf.set(r.run, why)
    rememberRunDocs(r.run, docs, runRel, chosen)
    setCarry(undefined)
    setFrom(null)
    setBack(false)
    setRun(r)
  }
  const dialog = bridge && available ? (
    <Modal open={open} onClose={close} title={t('files.findWork.dialogTitle')} width={640}>
      {run ? <RunResult run={run} onClose={close} onUndone={o.onChange} onLookAgain={lookAgain} skipShare={back} phone={narrow} />
        : <FindWorkFiles bridge={bridge} rank="own" audience="me" phone={narrow} carry={carry} placeName={t('files.findWork.myPlace')} alreadyIn={(docs) => alreadyThere(docs.map((d) => ({ ...d, pick: `${FROM_COMPUTER}/${d.pick}` })), own)} onAdd={add} onClose={from ? backToRun : close} />}
    </Modal>
  ) : null
  return { available, narrow, open, start, dialog, own }
}

/**
 * My files on the desktop app (Windows, the Mac app from the website): the toolbar button "Find work files", for anyone
 * but guests, and the dialog it opens. Not in a browser, on a phone, in the Mac App Store build or an older desktop app
 * (no matching bridge). The page calls this once and puts `button` in its computer toolbar and `dialog` outside its
 * phone/computer branches (QA TC-3504): the Files page draws a different header at phone width, so a dialog that lived
 * in the toolbar closed, and its look stopped, when the window was made that narrow. The dialog is the app's Modal
 * (a bottom sheet at phone width), as from the welcome card.
 */
export function useFindWorkFilesEntry(here: string): { button: ReactNode; dialog: ReactNode } {
  const t = useT()
  const f = useMyWorkFiles()
  const shown = f.available && (here === f.own || here === runFolder(f.own))
  // the button: beside Upload (icon only on a narrow page, like them); not at phone width
  const button = shown && !f.narrow ? (
    <Tooltip label={t('files.findWork.entryButton')}>
      <Button size="sm" variant="ghost" onClick={f.start} aria-label={t('files.findWork.entryButton')} data-testid="files-find-work-entry">
        <FolderSearch size={15} aria-hidden /> <span className="@max-2xl:hidden">{t('files.findWork.entryButton')}</span>
      </Button>
    </Tooltip>
  ) : null
  // the dialog: the same at every width and whatever folder is on screen
  return { button, dialog: f.dialog }
}

/** A file the run added, its place in words: "Documents › Sales", "OneDrive – Acme › Clients" (under From this computer). */
function useLandedPlace(base: string) {
  const t = useT()
  const top = `${base}/${FROM_COMPUTER}/`
  return (path: string) => {
    const segs = (path.startsWith(top) ? path.slice(top.length) : path).split('/').slice(0, -1)
    const root = segs[0] ? ROOT_OF[segs[0]] : undefined
    return (root ? [t(ROOT_WORD[root]), ...segs.slice(1)] : segs).join(' › ')
  }
}

/** The run's progress, then the share step (docs/decisions/20261116-find-files-share-step.md: the files it
 * added, nothing ticked, Share or Not now; skipped when the person may not share), then "Added 6 files to My files › From
 * this computer" with Open and Undo, the share's line, and "Share with your team" back to the step. */
function RunResult({ run: start, onClose, onUndone, onLookAgain, skipShare = false, phone }: { run: Run; onClose: () => void; onUndone?: () => void; onLookAgain?: (files: CarriedFile[]) => void; skipShare?: boolean; phone: boolean }) {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  const words = useFolderWords()
  const place = useLandedPlace(start.view.base)
  const run = useRuns((s) => s.runs.find((r) => r.run === start.run) ?? (s.tagged[TAG]?.run === start.run ? s.tagged[TAG] : null)) ?? start
  const v = run.view
  const running = v.status === 'running'
  const [undo, setUndo] = useState<{ s: 'idle' } | { s: 'busy' } | { s: 'done'; n: number; until: string | null; failed: number } | { s: 'error'; text: string }>({ s: 'idle' })
  const folder = runFolder(start.view.base)
  const failed = run.run.rows().filter((r) => r.state === 'failed')
  // the files a new look would help (changed or gone since the look, the look too old): "Look again", them ticked again
  const again = lookAgainOf(start.run)
  // the share step: asked once the run is done (may this person share their files: the team's switch), then shown first
  const landed = made.get(start.run)?.files ?? []
  const [stage, setStage] = useState<'check' | 'share' | 'result'>('check')
  const [mayShare, setMayShare] = useState(false)
  const [shared, setShared] = useState<SharedResult | null>(null)
  useEffect(() => {
    if (running || stage !== 'check') return
    const first = landed[0]
    if (!first) return setStage('result')
    let live = true
    api.call(API.fileShares, { query: { path: first } }).then(
      (r) => { if (!live) return; setMayShare(r.canShare); setStage(r.canShare && !skipShare ? 'share' : 'result') },
      () => { if (live) setStage('result') },
    )
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, stage])
  const addedLine = t('files.findWork.added', { n: v.done, place: words.path(folder, ' › ') })
  if (!running && stage === 'check') return <div data-testid="find-work-run" data-status={v.status} data-stage="check"><Skeleton lines={3} /></div>
  if (!running && stage === 'share') {
    return (
      <div data-testid="find-work-run" data-status={v.status} data-stage="share">
        <ShareFoundFiles paths={landed} reasons={reasonsOf.get(start.run) ?? new Map()} where={place} phone={phone} added={addedLine}
          onShared={(r) => { setShared(r); setStage('result') }} onSkip={() => setStage('result')} />
      </div>
    )
  }
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
      onUndone?.()
    } catch (e) {
      setUndo({ s: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }
  const until = (iso: string | null) => (iso ? new Intl.DateTimeFormat(intlTag(locale), { month: 'long', day: 'numeric' }).format(new Date(iso)) : null)
  return (
    <div className="space-y-4" data-testid="find-work-run" data-status={v.status} data-stage={running ? 'running' : 'result'}>
      <h2 className="text-display font-semibold text-ink" role="status" data-testid="find-work-run-title">
        {undo.s === 'done' && undo.n > 0 ? t('files.findWork.undone', { n: undo.n }) : undo.s === 'done' ? t('files.findWork.undoFailed', { n: undo.failed }) : running ? t('welcome.teamFiles.uploading', { k: v.done, n: v.total }) : addedLine}
      </h2>
      {running && <FromCloudLine active={v.active} />}
      {undo.s === 'done' && undo.until && <p className="text-sm text-muted" data-testid="find-work-undone-until">{t('files.findWork.undoneUntil', { date: until(undo.until)! })}</p>}
      {undo.s === 'done' && undo.n > 0 && undo.failed > 0 && <ErrorNote>{t('files.findWork.undoFailed', { n: undo.failed })}</ErrorNote>}
      {undo.s === 'error' && <ErrorNote>{undo.text}</ErrorNote>}
      {!running && undo.s !== 'done' && failed.length > 0 && (
        <ErrorNote>
          {t('files.findWork.notAdded', { n: failed.length })}
          <ul className="mt-1 space-y-0.5" data-testid="find-work-failed">
            {failed.slice(0, 5).map((r) => <li key={r.rel} className="truncate">{r.rel.split('/').pop()} · {failedReason(r, t, locale)}</li>)}
          </ul>
          {onLookAgain && again.length > 0 && (
            <p className="mt-2 text-sm">
              <button type="button" className={quietLink} onClick={() => onLookAgain(again)} data-testid="find-work-look-again">{t('files.findWork.again')}</button>
              {' · '}{t('files.findWork.lookAgainHint')}
            </p>
          )}
        </ErrorNote>
      )}
      {shared && undo.s !== 'done' && shared.shared.length > 0 && <p className="text-sm text-ink" role="status" data-testid="find-work-shared">{t('files.findWork.share.done', { n: shared.shared.length, names: shared.names })}</p>}
      {shared && undo.s !== 'done' && shared.failed.length > 0 && (
        <ErrorNote>
          {t('files.findWork.share.failed', { n: shared.failed.length })}
          <ul className="mt-1 space-y-0.5" data-testid="find-work-share-failed">
            {shared.failed.slice(0, 5).map((f) => <li key={f.path} className="truncate">{f.path.split('/').pop()} · {f.message}</li>)}
          </ul>
        </ErrorNote>
      )}
      {undo.s !== 'done' && !running && <p className="text-label text-muted">{t('files.findWork.originalsStay')}</p>}
      {mayShare && undo.s !== 'done' && !running && landed.length > 0 && (
        <button type="button" className={clsx(quietLink, 'text-sm')} onClick={() => setStage('share')} data-testid="find-work-share-again">{t('files.findWork.share.again')}</button>
      )}
      <div className={phone ? 'flex flex-col-reverse gap-2 [&>*]:w-full' : 'flex flex-wrap items-center justify-end gap-3'}>
        {running ? (
          <Button onClick={() => void stopFolderUpload(run)} data-testid="find-work-stop-upload">{t('welcome.teamFiles.stopUpload')}</Button>
        ) : (
          <>
            {undo.s !== 'done' && v.done > 0 && (
              <Button variant="ghost" busy={undo.s === 'busy'} onClick={() => void takeBack()} data-testid="find-work-undo"><Undo2 size={14} aria-hidden /> {t('common.undo')}</Button>
            )}
            {undo.s !== 'done' && v.done > 0 && <Button onClick={() => { onClose(); navigate(`/files?path=${encodeURIComponent(folder)}`) }} data-testid="find-work-open">{t('files.findWork.open')}</Button>}
            <Button variant="primary" onClick={onClose} data-testid="find-work-done">{t('common.close')}</Button>
          </>
        )}
      </div>
    </div>
  )
}
