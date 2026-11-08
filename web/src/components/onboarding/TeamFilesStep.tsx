// 팀 파일 (docs/DECISIONS.md "W6 — Onboarding v6: 팀 파일 recommendations"; FLOW v6 §3): the owner picks a folder, the
// page lists its documents without reading them (lib/teamFiles.ts), the AI picks from names, folders, types, sizes and
// dates only (POST /api/onboarding/files/rank), the person confirms one checked list, and only then do the files go up.
//   F1 start: [폴더 고르기] (Chrome, Edge and the desktop app: the folder window with a handle; Safari, Firefox and the Mac
//      App Store build: <input webkitdirectory>), the hint for the folders the browser will not open (not in the desktop
//      app, which opens them), "파일 직접 올리기", "나중에 하기".
//   F2 looking: the count, then the AI's pick, [그만 보기] (the list so far, unticked).
//   F3 the list: the AI's top picks ticked with their reason word; "이미 있어요"; the personal-looking files (never sent to
//      the AI, never ticked by default; a ticked one says who will see it); "다른 파일도 보기" (search over 30 rows, the
//      50 MB line); "폴더 더 고르기" merges; "넣을 곳" only with more than one place; at most 100 ticked.
//   F4 uploading, F5 done: a folder upload run of the file screen (components/FolderUploads.tsx) tagged with the step, so
//      it goes on across pages and guards a reload; the step reopens on its newest run, never on F1. Hand-picked and
//      dropped files run the same way, skipping what is already there (no "(1)" copies). The run's first landed file
//      records 팀 파일 done on the server (POST /api/onboarding/files/landed), whoever of the owners and admins started it.
// A phone has no folder: [파일 직접 올리기] only. The list, the AI's answer and the ticks live in this tab while it stays
// open (← 이전 and back, another page and back: no second AI call). The Files screen offers the same steps in a dialog to
// owners and admins while the team folder holds no file (TeamFilesEntry).
import clsx from 'clsx'
import { Check, ChevronDown, CircleAlert, FolderOpen, Loader2, Search, Upload } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { create } from 'zustand'
import { TEAM_FILES_LIMITS, type TeamFileReason, type TreeResponse, type WelcomeProgress } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { answersFileInputs, isDesktop } from '../../lib/desktop'
import { onFolderUploadsForgotten, taggedRun, useRuns, type Run } from '../../lib/folderRuns'
import type { FolderPlan } from '../../lib/folderUpload'
import { formatSize, intlTag } from '../../lib/format'
import { baseName } from '../../lib/paths'
import { canPickHandle, canPickInput } from '../../lib/skillScan'
import { allPersonal, dirFromEntry, dirFromFiles, dirFromHandle, findAlready, findDocs, forAi, groupDocs, mergeDocs, newPicks, rankEntries, tick, walkFolder, type DirEntryLike, type DirHandleLike, type LocalDoc, type WalkDir } from '../../lib/teamFiles'
import { teamReach } from '../../lib/welcome'
import { currentLocale, t as tNow, useLocale, useT, type MessageKey } from '../../i18n'
import { useMeStrict } from '../../store/session'
import { toast } from '../../store/ui'
import { useWelcome } from '../../store/welcome'
import { retryFolderUpload, startFolderUpload, stopFolderUpload, useFolderUploadsSettled } from '../FolderUploads'
import { Button, ErrorNote, Modal, useMediaQuery } from '../ui'

const L = TEAM_FILES_LIMITS
const TAG = 'welcome-files' as const
/** a group longer than this gets "파일 이름으로 찾기" */
const SEARCH_FROM = 30
/** rows drawn per group at most (the rest: found by name) */
const ROWS_SHOWN = 200
const quietLink = 'font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink disabled:opacity-50'

/** A group folder the files can go to: the team's own first, then the other groups' folders. */
interface Place { groupId: string; name: string; folder: string }

// ---------------------------------------------------------------- the step's state in this tab

type Note = 'noAi' | 'zero' | 'allPersonal' | null
interface Draft {
  /** what the step shows when it opens: its start, the list, or its upload run */
  screen: 'start' | 'list' | 'run'
  /** F2 in progress (kept across pages: a walk or the AI's pick goes on while the person is elsewhere) */
  phase: 'idle' | 'reading' | 'looking' | 'ranking'
  count: number
  docs: LocalDoc[]
  /** the AI's picks, best first (null: no AI answer) */
  picks: Map<string, TeamFileReason> | null
  note: Note
  already: Set<string>
  ticks: Set<string>
  /** what came ticked: the primary says "추천 N개 올리기" while the ticks are these */
  baseline: Set<string>
  cut: boolean
  tooBig: number
  /** the last pick held no document */
  empty: boolean
  placeId: string | null
}
const EMPTY: Draft = { screen: 'start', phase: 'idle', count: 0, docs: [], picks: null, note: null, already: new Set(), ticks: new Set(), baseline: new Set(), cut: false, tooBig: 0, empty: false, placeId: null }
const useDraft = create<Draft>(() => ({ ...EMPTY }))
const patch = (p: Partial<Draft>) => useDraft.setState(p)
/** moves on whenever a pick starts or is let go: an answer for an older one is dropped (no late answer) */
let generation = 0
/** moves on when the folder input answers (files or a cancel): a focus that comes after it changes nothing */
let inputAsk = 0
/** [그만 보기] while the folder input was read: its files, when they come, are not looked at */
let ignoreInput = false
let stopLooking = false
let rankAbort: AbortController | null = null
/** sign-out: nothing of the last person's folder stays */
onFolderUploadsForgotten(() => { generation++; rankAbort?.abort(); useDraft.setState({ ...EMPTY, already: new Set(), ticks: new Set(), baseline: new Set() }) })

/** "이미 있어요" reads the target folder through the file API (one listing per folder that is there). */
const listFolder = async (path: string) => {
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
}

/** The files of the step's runs into `base`, by their path in it, that went or are on their way (not a failed one, nor one a
 * stopped run never sent). */
function inRuns(base: string): Map<string, number> {
  const out = new Map<string, number>()
  const s = useRuns.getState()
  for (const r of new Set([...s.runs.filter((x) => x.tag === TAG), ...(s.tagged[TAG] ? [s.tagged[TAG]!] : [])])) {
    if (r.view.base !== base) continue
    // what went or is going: a file a stopped run never sent is not taken
    const going = r.view.status === 'running'
    for (const row of r.run.rows()) if (row.state === 'done' || row.state === 'active' || (row.state === 'queued' && going)) out.set(row.rel.normalize('NFC'), row.size)
  }
  return out
}

/** The list's "이미 있어요": taken in the folder, or in a run of the step, with the same size. */
async function alreadyFor(docs: readonly LocalDoc[], base: string): Promise<Set<string>> {
  const there = await findAlready(docs, base, listFolder)
  const running = inRuns(base)
  for (const d of docs) if (running.get(`${d.pick}/${d.rel}`) === d.size) there.add(d.key)
  return there
}

/** A picked or dropped folder: walked (F2), then the AI's pick, then the list (F3). `add`: "폴더 더 고르기" (merged). */
async function lookAt(dir: WalkDir, base: string, add: boolean) {
  const g = ++generation
  stopLooking = false
  rankAbort?.abort()
  const before = useDraft.getState()
  patch({ phase: 'looking', count: before.docs.length && add ? before.docs.length : 0, empty: false })
  const walked = await walkFolder(dir, { stopped: () => stopLooking, onProgress: (n) => { if (g === generation) patch({ count: (add ? before.docs.length : 0) + n }) } })
  if (g !== generation) return
  const docs = add ? mergeDocs(before.docs, walked.docs) : walked.docs
  const tooBig = (add ? before.tooBig : 0) + walked.tooBig
  if (!walked.docs.length && !walked.stopped) {
    // nothing here: the start again (or the list as it was) with "이 폴더엔 문서가 없어요"
    patch({ phase: 'idle', empty: true, ...(add && before.docs.length ? {} : { screen: 'start', tooBig: walked.tooBig }) })
    return
  }
  const already = await alreadyFor(docs, base)
  if (g !== generation) return
  const keep = (s: ReadonlySet<string>) => new Set([...s].filter((k) => docs.some((d) => d.key === k) && !already.has(k)))
  const common = { docs, already, cut: (add && before.cut) || walked.cut, tooBig, phase: 'idle' as const, screen: 'list' as const, placeId: before.placeId }
  // [그만 보기] while it walked: the list so far, unticked, no AI
  if (walked.stopped || stopLooking) {
    patch({ ...common, ...unranked(add, before), ticks: keep(add ? before.ticks : new Set()), baseline: add ? keep(before.baseline) : new Set() })
    return
  }
  // everything is in the folder already: nothing to ask the AI about
  if (docs.every((d) => already.has(d.key))) {
    patch({ ...common, picks: null, note: null, ticks: new Set(), baseline: new Set() })
    return
  }
  // every file looks personal (an HR or finance owner picked 인사): nothing goes to the AI, that group opens
  if (allPersonal(docs, already)) {
    patch({ ...common, picks: null, note: 'allPersonal', ticks: keep(add ? before.ticks : new Set()), baseline: new Set() })
    return
  }
  patch({ phase: 'ranking', count: docs.length })
  const sent = forAi(docs.filter((d) => !already.has(d.key)))
  const { entries, keyOf } = rankEntries(sent)
  const ctl = new AbortController()
  rankAbort = ctl
  const timer = setTimeout(() => ctl.abort(), L.rankMs)
  let picks: Map<string, TeamFileReason> | null = null
  try {
    const r = entries.length ? await api.call(API.rankTeamFiles, { body: { entries }, signal: ctl.signal }) : { ai: 'done' as const, picks: [] }
    if (r.ai === 'done') picks = new Map(r.picks.flatMap((p) => { const k = keyOf.get(p.id); return k ? [[k, p.reason] as const] : [] }))
  } catch { picks = null } finally { clearTimeout(timer) }
  // a late answer (그만 보기, another pick, sign-out) is dropped
  if (g !== generation || ctl.signal.aborted) {
    if (g === generation) patch({ ...common, ...unranked(add, before), ticks: keep(add ? before.ticks : new Set()), baseline: add ? keep(before.baseline) : new Set() })
    return
  }
  // no answer for an added folder: the first folder's picks stay
  if (!picks && add && before.picks) {
    patch({ ...common, ...unranked(add, before), ticks: keep(before.ticks), baseline: keep(before.baseline) })
    return
  }
  const grouped = groupDocs(docs, picks, already)
  // the first pick: the AI's top ones ticked; another one keeps the person's ticks, its new picks unticked
  const ticks = add ? keep(before.ticks) : new Set(grouped.recommended.map((d) => d.key))
  const baseline = add ? keep(before.baseline) : new Set(ticks)
  patch({ ...common, picks, note: !picks ? 'noAi' : grouped.recommended.length ? null : 'zero', ticks, baseline })
}

/** [그만 보기] while Safari or Firefox read the folder: the page stops waiting (files that still arrive are let go). */
function stopReading() {
  inputAsk++
  ignoreInput = true
  patch({ phase: 'idle' })
}

/** No AI answer for this pick: "AI 없이 살펴봤어요"; an added folder keeps the picks the list had (its new files under "다른
 * 파일도 보기", unticked). */
const unranked = (add: boolean, before: Draft): Pick<Draft, 'picks' | 'note'> => ({ picks: add ? before.picks : null, note: 'noAi' })

/** [그만 보기]: the walk stops (its list so far shows), or the AI's answer is let go. */
function stopNow() {
  stopLooking = true
  rankAbort?.abort()
}

/** The step's upload run into `base` (F4/F5). The first file that lands records 팀 파일 done, once per run. */
function startStepRun(plan: FolderPlan, base: string): Run {
  let reported = false
  const run = startFolderUpload(plan, base, (view) => toast({ level: 'error', text: `${errorText(view.refusal, currentLocale(), tNow('error.network'))} ${tNow('files.folderUpload.stopped', { n: view.waiting })}` }), {
    tag: TAG,
    onLanded: (path) => {
      if (reported) return
      reported = true
      api.call(API.teamFilesLanded, { body: { path } }).then(
        (r) => { if (r.recorded && useWelcome.getState().loaded) void useWelcome.getState().load(true).catch(() => {}) },
        () => { reported = false },
      )
    },
  })
  patch({ screen: 'run' })
  return run
}

/** Hand-picked or dropped files: straight up (the person chose each), minus what is already there. */
async function sendPicked(files: readonly File[], base: string): Promise<{ skipped: number; cut: number; started: boolean }> {
  const taken = new Map<string, number>()
  for (const e of (await listFolder(base)) ?? []) if (e.type === 'file') taken.set(e.name.normalize('NFC'), e.size)
  for (const [rel, size] of inRuns(base)) if (!rel.includes('/')) taken.set(rel, size)
  const r = newPicks(files, taken)
  if (r.files.length) startStepRun({ files: r.files.map((f) => ({ rel: f.name.normalize('NFC'), file: f })), folders: [], unreadable: [], skipped: 0 }, base)
  return { skipped: r.skipped, cut: r.cut, started: r.files.length > 0 }
}

// ---------------------------------------------------------------- how this browser picks a folder

type FolderWindow = 'handle' | 'input' | null
/** Chrome, Edge and the desktop app (its folder window takes File System Access, docs/DECISIONS.md "W6 — Desktop"): the
 * folder window with a handle (read lazily). Safari, Firefox: the folder input. The Mac App Store build answers the
 * page's folder input with its own window and never opens the folder window. */
function folderWindow(): FolderWindow {
  if (answersFileInputs()) return canPickInput() ? 'input' : null
  if (canPickHandle()) return 'handle'
  return canPickInput() ? 'input' : null
}
type PickerWindow = { showDirectoryPicker?: (o: { id?: string; mode?: 'read' | 'readwrite'; startIn?: string }) => Promise<DirHandleLike> }
const windows = () => typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)

// ---------------------------------------------------------------- the step

export interface TeamFilesStepProps {
  progress: WelcomeProgress
  busy: boolean
  /** the primary once files went in ("다음: 도구 연결"): the caller's step plan names the next step */
  nextLabel: string
  onDone: (n: number) => void
  onSkip: () => void
  /** in the Files screen's dialog: no "나중에 하기" there, the primary closes */
  dialog?: boolean
}

export function TeamFilesStep({ progress, busy: stepBusy, nextLabel, onDone, onSkip, dialog }: TeamFilesStepProps) {
  const t = useT()
  const narrow = useMediaQuery('(max-width: 767.98px)')
  const how = folderWindow()
  const phone = narrow || how === null
  const team = progress.teamGroup
  const draft = useDraft()
  const run = useRuns((s) => s.tagged[TAG] ?? null)
  // the team's own folder, and other groups' folders (Admin's folder list knows which folder is whose)
  const [places, setPlaces] = useState<Place[]>(() => (team ? [{ groupId: team.id, name: team.name, folder: team.folder }] : []))
  useEffect(() => {
    let live = true
    void Promise.all([api.call(API.listGroups), api.call(API.listFolders)]).then(([groups, folders]) => {
      if (!live) return
      const other = groups.items.filter((g) => g.id !== team?.id).flatMap((g) => {
        const f = folders.items.find((x) => x.groupId === g.id && x.exists)
        return f ? [{ groupId: g.id, name: g.name, folder: f.path }] : []
      })
      setPlaces((p) => [...p.filter((x) => x.groupId === team?.id), ...other])
    }, () => {})
    return () => { live = false }
  }, [team?.id])
  const place = places.find((p) => p.groupId === draft.placeId) ?? places[0] ?? null
  // the run is shown when the step opens with one and nothing else is under way here (F4/F5, never F1)
  useEffect(() => {
    const d = useDraft.getState()
    if (d.screen === 'start' && d.phase === 'idle' && taggedRun(TAG)) patch({ screen: 'run' })
  }, [])

  const input = useRef<HTMLInputElement>(null)
  const filesInput = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [skipped, setSkipped] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const adding = useRef(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const pickFolder = async (add: boolean) => {
    if (!place) return
    setError(null)
    adding.current = add
    if (how === 'handle') {
      let h: DirHandleLike
      try {
        h = await (window as unknown as PickerWindow).showDirectoryPicker!({ id: 'team-files', mode: 'read', startIn: 'documents' })
      } catch (e) {
        // a cancel, a folder the browser refused and "view files? 허용 안 함" all read as AbortError: nothing happens
        if ((e as { name?: string } | null)?.name === 'AbortError') return
        // a browser that has the call but no window for it: the folder input
        input.current?.click()
        return
      }
      void lookAt(dirFromHandle(h), place.folder, add)
      return
    }
    // Safari, Firefox, the desktop app: the browser reads the whole folder before the page hears of it; "폴더를 살펴보는
    // 중…" once the window is gone (focus back) until the files or a cancel arrive (a cancel can come first)
    const asked = ++inputAsk
    ignoreInput = false
    const back = () => setTimeout(() => { if (asked === inputAsk && useDraft.getState().phase === 'idle') patch({ phase: 'reading' }) }, 150)
    window.addEventListener('focus', back, { once: true })
    input.current?.click()
  }
  // the folder window closed without a folder: back to where it was
  useEffect(() => {
    const el = input.current
    if (!el) return
    const cancel = () => { inputAsk++; if (useDraft.getState().phase === 'reading') patch({ phase: 'idle' }) }
    el.addEventListener('cancel', cancel)
    return () => el.removeEventListener('cancel', cancel)
  }, [])
  const onFolderInput = (list: File[]) => {
    inputAsk++
    if (ignoreInput) { ignoreInput = false; return }
    const dir = dirFromFiles(list)
    if (!dir || !place) { if (useDraft.getState().phase === 'reading') patch({ phase: 'idle', empty: !!place && list.length > 0 }); return }
    void lookAt(dir, place.folder, adding.current)
  }
  const pickFiles = async (list: File[]) => {
    if (!list.length || !place) return
    setError(null)
    try {
      const r = await sendPicked(list, place.folder)
      if (mounted.current) setSkipped(r.skipped)
    } catch (e) {
      if (mounted.current) setError(errorText(e, currentLocale(), t('error.network')))
    }
  }
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files')
  const drop = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    setOver(false)
    if (!place || stepBusy || draft.phase !== 'idle') return
    // read now (the browser empties the lists when the event ends): a folder goes to the list, files go straight up
    const items = [...(e.dataTransfer.items ?? [])]
    const entries = items.map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null))
    const folder = entries.find((x) => x?.isDirectory)
    if (folder && !phone) return void lookAt(dirFromEntry(folder as unknown as DirEntryLike), place.folder, draft.screen === 'list')
    void pickFiles([...e.dataTransfer.files].filter((_, i) => !entries[i]?.isDirectory))
  }
  const dropZone = {
    onDragOver: (e: DragEvent) => { if (hasFiles(e) && place && draft.phase === 'idle') { e.preventDefault(); setOver(true) } },
    onDragLeave: (e: DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false) },
    onDrop: drop,
  }

  const inputs = (
    <>
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        {...{ webkitdirectory: '' }}
        onChange={(e) => { const list = [...(e.target.files ?? [])]; e.target.value = ''; onFolderInput(list) }}
        data-testid="welcome-team-files-folder-input"
      />
      <input ref={filesInput} type="file" multiple className="hidden" onChange={(e) => { const list = [...(e.target.files ?? [])]; e.target.value = ''; void pickFiles(list) }} data-testid="welcome-team-files-input" />
    </>
  )
  const later = dialog ? null : (
    <Button variant="ghost" onClick={onSkip} disabled={stepBusy} data-testid="welcome-later">{t('welcome.later')}</Button>
  )
  const notes = (
    <>
      {skipped > 0 && <p className="text-label text-muted" data-testid="welcome-team-files-skipped">{t('welcome.teamFiles.skippedSame', { n: skipped })}</p>}
      {error && <ErrorNote>{error}</ErrorNote>}
    </>
  )

  let body: ReactNode
  if (draft.phase !== 'idle') body = <Looking phase={draft.phase} count={draft.count} />
  else if (draft.screen === 'run' && run) body = <RunView run={run} places={places} nextLabel={nextLabel} busy={stepBusy} phone={phone} onDone={onDone} onMore={phone ? null : () => void pickFolder(false)} />
  else if (draft.screen === 'list' && draft.docs.length) body = <ListView draft={draft} places={places} place={place} phone={phone} busy={stepBusy} later={later} onAddFolder={() => void pickFolder(true)} onOtherFolder={() => void pickFolder(false)} />
  else if (phone) {
    body = (
      <div className="space-y-5">
        <StepHead title={t('welcome.teamFiles.phoneTitle')} desc={t('welcome.teamFiles.phoneDesc')} />
        {place ? <TeamReach team={place.name} groupId={place.groupId} /> : <p className="text-label text-muted">{t('welcome.teamFiles.noFolder')}</p>}
        {notes}
        <div className="space-y-2">
          {place && (
            <Button variant="primary" className="w-full" disabled={stepBusy} onClick={() => filesInput.current?.click()} data-testid="welcome-team-files-pick-files">
              <Upload size={14} aria-hidden /> {t('welcome.teamFiles.pickFiles')}
            </Button>
          )}
          {progress.steps.files === 'done' && !dialog ? (
            <Button variant="ghost" className="w-full" disabled={stepBusy} onClick={() => onDone(0)} data-testid="welcome-team-files-next">{nextLabel}</Button>
          ) : later && <div className="flex justify-center">{later}</div>}
        </div>
      </div>
    )
  } else {
    const done = progress.steps.files === 'done' && !dialog
    body = (
      <div className="space-y-5">
        <StepHead title={t('welcome.teamFiles.title')} desc={t('welcome.teamFiles.desc')} />
        {place ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              {done && <Button variant="primary" className="max-sm:w-full" disabled={stepBusy} onClick={() => onDone(0)} data-testid="welcome-team-files-next">{nextLabel}</Button>}
              <Button variant={done ? 'secondary' : 'primary'} className="max-sm:w-full" disabled={stepBusy} onClick={() => void pickFolder(false)} data-testid="welcome-team-files-pick">
                <FolderOpen size={14} aria-hidden /> {t('welcome.teamFiles.pickFolder')}
              </Button>
            </div>
            {draft.empty && <p className="text-sm text-ink" role="status" data-testid="welcome-team-files-empty">{t('welcome.teamFiles.empty')}</p>}
            {draft.empty && draft.tooBig > 0 && <p className="text-label text-muted" data-testid="team-files-too-big">{t('welcome.teamFiles.tooBig', { n: draft.tooBig })}</p>}
            <p className="text-label text-muted" data-testid="welcome-team-files-hint">{t(how === 'handle' && !isDesktop() ? (windows() ? 'welcome.teamFiles.hintChromeWindows' : 'welcome.teamFiles.hintChrome') : 'welcome.teamFiles.hintInput')}</p>
            <TeamReach team={place.name} groupId={place.groupId} />
            {notes}
          </div>
        ) : <p className="text-label text-muted">{t('welcome.teamFiles.noFolder')}</p>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {place ? (
            <button type="button" className={clsx(quietLink, 'text-sm')} disabled={stepBusy} onClick={() => filesInput.current?.click()} data-testid="welcome-team-files-pick-files">
              {t('welcome.teamFiles.pickFiles')}
            </button>
          ) : <span />}
          {!done && later}
        </div>
      </div>
    )
  }
  // the start shows these in its own place; the list and the run under everything
  const below = draft.phase === 'idle' && ((draft.screen === 'run' && run) || (draft.screen === 'list' && draft.docs.length))
  return (
    <div className={clsx('rounded-xl', over && 'ring-2 ring-accent/30 ring-offset-4 ring-offset-bg')} {...dropZone} data-testid="welcome-team-files" data-screen={draft.phase !== 'idle' ? 'looking' : draft.screen}>
      {inputs}
      {body}
      {below && (skipped > 0 || error) && <div className="mt-3 space-y-2">{notes}</div>}
    </div>
  )
}

function StepHead({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="space-y-1">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      {desc && <p className="text-sm text-balance text-muted">{desc}</p>}
    </div>
  )
}

/** F2: the count while the walk runs, then the AI's pick; [그만 보기]. "폴더를 살펴보는 중…" while Safari or Firefox
 * read the folder before the page hears of it (no count yet, nothing to stop from here). */
function Looking({ phase, count }: { phase: Draft['phase']; count: number }) {
  const t = useT()
  return (
    <div className="space-y-4" data-testid="welcome-team-files-looking">
      {phase === 'ranking' && (
        <p className="flex items-center gap-1.5 text-sm text-muted"><Check size={14} className="text-ok" aria-hidden /> {t('welcome.teamFiles.looking', { n: count })}</p>
      )}
      <h2 className="flex items-center gap-2 text-lg font-semibold text-ink" role="status" data-testid="welcome-team-files-looking-title">
        <Loader2 size={16} className="shrink-0 animate-spin text-accent-text" aria-hidden />
        {phase === 'reading' ? t('welcome.teamFiles.reading') : phase === 'looking' ? t('welcome.teamFiles.looking', { n: count }) : t('welcome.teamFiles.ranking', { n: count })}
      </h2>
      <p className="text-sm text-muted">{t('welcome.teamFiles.lookingHint')}</p>
      <Button onClick={phase === 'reading' ? stopReading : stopNow} data-testid="welcome-team-files-stop">{t('welcome.teamFiles.stopLooking')}</Button>
    </div>
  )
}

const NOTE: Record<NonNullable<Note>, MessageKey> = { noAi: 'welcome.teamFiles.noAi', zero: 'welcome.teamFiles.zero', allPersonal: 'welcome.teamFiles.allPersonal' }
const REASON: Record<TeamFileReason, MessageKey> = {
  form: 'welcome.teamFiles.reason.form', intro: 'welcome.teamFiles.reason.intro', report: 'welcome.teamFiles.reason.report', minutes: 'welcome.teamFiles.reason.minutes',
  brand: 'welcome.teamFiles.reason.brand', policy: 'welcome.teamFiles.reason.policy', training: 'welcome.teamFiles.reason.training', proposal: 'welcome.teamFiles.reason.proposal',
}

/** F3: one checked list, one confirm. */
function ListView({ draft, places, place, phone, busy, later, onAddFolder, onOtherFolder }: { draft: Draft; places: Place[]; place: Place | null; phone: boolean; busy: boolean; later: ReactNode; onAddFolder: () => void; onOtherFolder: () => void }) {
  const t = useT()
  const locale = useLocale()
  const ids = useId()
  const g = useMemo(() => groupDocs(draft.docs, draft.picks, draft.already), [draft.docs, draft.picks, draft.already])
  const [open, setOpen] = useState<Record<'already' | 'personal' | 'more', boolean>>(() => ({ already: false, personal: draft.note === 'allPersonal', more: draft.note === 'zero' || draft.note === 'noAi' }))
  // a list without picks opens where the files are (another folder added without the AI's answer)
  useEffect(() => {
    if (draft.note === 'zero' || draft.note === 'noAi') setOpen((o) => ({ ...o, more: true }))
    if (draft.note === 'allPersonal') setOpen((o) => ({ ...o, personal: true }))
  }, [draft.note])
  const [capped, setCapped] = useState(false)
  const [q, setQ] = useState('')
  const ticks = draft.ticks
  const folderName = place ? t('welcome.files.homeFolder', { team: place.name }) : ''
  const toggle = (key: string, on: boolean) => {
    const r = tick(ticks, key, on)
    setCapped(r.refused)
    patch({ ticks: r.ticks })
  }
  // 넣을 곳 changed: what is already there is read again for that folder
  const choosePlace = (id: string) => {
    const p = places.find((x) => x.groupId === id)
    if (!p) return
    patch({ placeId: id })
    const docs = useDraft.getState().docs
    void alreadyFor(docs, p.folder).then((already) => {
      if (useDraft.getState().docs !== docs || useDraft.getState().placeId !== id) return
      patch({ already, ticks: new Set([...useDraft.getState().ticks].filter((k) => !already.has(k))) })
    })
  }
  const upload = () => {
    if (!place || !ticks.size) return
    const chosen = draft.docs.filter((d) => ticks.has(d.key) && !draft.already.has(d.key))
    startStepRun({ files: chosen.map((d) => ({ rel: `${d.pick}/${d.rel}`, file: d.file })), folders: [], unreadable: [], skipped: 0 }, place.folder)
  }
  const same = ticks.size > 0 && ticks.size === draft.baseline.size && [...ticks].every((k) => draft.baseline.has(k))
  const primary = ticks.size === 0 ? t('welcome.teamFiles.otherFolder') : same ? t('welcome.teamFiles.uploadPicked', { n: ticks.size }) : t('welcome.teamFiles.upload', { n: ticks.size })
  const pad = phone ? 'px-0' : 'px-4'
  const frame = phone ? 'border-y border-line' : 'rounded-xl border border-line bg-surface'

  const meta = (d: LocalDoc) => {
    const reason = draft.picks?.get(d.key)
    const where = [d.pick, ...(d.folder ? d.folder.split('/') : [])].join(' › ')
    const date = new Intl.DateTimeFormat(intlTag(locale), { month: 'short', day: 'numeric' }).format(new Date(d.modified))
    return [reason ? t(REASON[reason]) : null, where, formatSize(d.size, locale), date].filter(Boolean).join(' · ')
  }
  const row = (d: LocalDoc, i: number, o: { check?: boolean; personal?: boolean } = {}) => {
    const id = `${ids}-${d.key}`
    const on = ticks.has(d.key)
    return (
      <li key={d.key} className={clsx('flex items-start gap-3 border-line py-2.5', pad, i > 0 && 'border-t')} data-testid="team-file-row" data-key={d.key} data-checked={o.check === false ? undefined : String(on)}>
        {o.check === false ? <Check size={16} className="mt-0.5 shrink-0 text-faint" aria-hidden /> : (
          <input id={id} type="checkbox" checked={on} onChange={(e) => toggle(d.key, e.target.checked)} disabled={busy} className="touch-hit mt-0.5 size-4.5 shrink-0 accent-[var(--c-accent)] dark:[color-scheme:dark]" data-testid="team-file-check" />
        )}
        <label htmlFor={o.check === false ? undefined : id} className={clsx('min-w-0 flex-1', o.check !== false && 'cursor-pointer')}>
          <span className="block truncate text-sm font-medium text-ink">{d.name}</span>
          <span className="mt-0.5 block truncate text-label text-muted">{meta(d)}</span>
          {o.personal && on && place && <span className="mt-0.5 block text-label text-warn" data-testid="team-file-personal-ticked">{t('welcome.teamFiles.personalTicked', { team: place.name })}</span>}
        </label>
      </li>
    )
  }
  const fold = (key: 'already' | 'personal' | 'more', label: string) => (
    <button type="button" className={clsx('flex min-h-11 w-full items-center gap-1.5 border-t border-line py-2.5 text-left text-sm', pad, !phone && 'hover:bg-hover')}
      aria-expanded={open[key]} aria-controls={`${ids}-${key}`} onClick={() => setOpen({ ...open, [key]: !open[key] })} data-testid={`team-files-${key}-toggle`}>
      <span className="min-w-0 font-medium text-ink">{label}</span>
      <ChevronDown size={16} className={clsx('ml-auto shrink-0 text-faint transition', open[key] && 'rotate-180')} aria-hidden />
    </button>
  )
  const moreRows = findDocs(g.more, q)
  const [qPersonal, setQPersonal] = useState('')
  const personalRows = findDocs(g.personal, qPersonal)
  const search = (value: string, set: (v: string) => void, testId: string) => (
    <label className={clsx('flex items-center gap-2 py-2', pad)}>
      <Search size={14} className="shrink-0 text-faint" aria-hidden />
      <input type="search" value={value} onChange={(e) => set(e.target.value)} placeholder={t('welcome.teamFiles.search')} aria-label={t('welcome.teamFiles.search')}
        className="h-8 min-w-0 flex-1 rounded-md border border-field-border bg-surface px-2 text-sm text-ink" data-testid={testId} />
    </label>
  )
  const capRows = (list: LocalDoc[], render: (d: LocalDoc, i: number) => ReactNode) => (
    <>
      {list.slice(0, ROWS_SHOWN).map(render)}
      {list.length > ROWS_SHOWN && <li className={clsx('border-t border-line py-2.5 text-label text-faint', pad)}>{t('welcome.teamFiles.moreRows', { n: list.length - ROWS_SHOWN })}</li>}
    </>
  )
  const title = draft.picks && g.recommended.length ? t('welcome.teamFiles.listTitle', { n: g.recommended.length }) : t('welcome.teamFiles.listTitleNone', { n: draft.docs.length })
  return (
    <div className="space-y-4" data-testid="welcome-team-files-list">
      <StepHead title={title} desc={folderName ? t('welcome.teamFiles.listDesc', { folder: folderName }) : undefined} />
      {draft.note && <p className="text-sm text-ink" role="status" data-testid="welcome-team-files-note" data-note={draft.note}>{t(NOTE[draft.note])}</p>}
      {draft.empty && <p className="text-sm text-ink" role="status" data-testid="welcome-team-files-empty">{t('welcome.teamFiles.empty')}</p>}
      {draft.cut && <p className="text-label text-muted" data-testid="welcome-team-files-cut">{t('welcome.teamFiles.cut', { n: draft.docs.length })}</p>}
      <div className={frame}>
        {g.recommended.length > 0 && <ul aria-label={title} data-testid="team-files-recommended">{g.recommended.map((d, i) => row(d, i))}</ul>}
        {g.already.length > 0 && (
          <>
            {fold('already', t('welcome.teamFiles.already', { n: g.already.length }))}
            {open.already && <ul id={`${ids}-already`} className="border-t border-line" data-testid="team-files-already">{capRows(g.already, (d, i) => row(d, i, { check: false }))}</ul>}
          </>
        )}
        {g.personal.length > 0 && (
          <>
            {fold('personal', t('welcome.teamFiles.personal', { n: g.personal.length }))}
            {open.personal && (
              <div id={`${ids}-personal`} className="border-t border-line" data-testid="team-files-personal">
                {g.personal.length > SEARCH_FROM && search(qPersonal, setQPersonal, 'team-files-personal-search')}
                <ul className={clsx(g.personal.length > SEARCH_FROM && 'border-t border-line')}>{capRows(personalRows, (d, i) => row(d, i, { personal: true }))}</ul>
                {qPersonal && !personalRows.length && <p className={clsx('py-2.5 text-label text-faint', pad)}>{t('welcome.teamFiles.searchNone')}</p>}
              </div>
            )}
          </>
        )}
        {(g.more.length > 0 || draft.tooBig > 0) && (
          <>
            {fold('more', t('welcome.teamFiles.more', { n: g.more.length }))}
            {open.more && (
              <div id={`${ids}-more`} className="border-t border-line" data-testid="team-files-more">
                {g.more.length > SEARCH_FROM && search(q, setQ, 'team-files-search')}
                <ul className={clsx(g.more.length > SEARCH_FROM && 'border-t border-line')}>{capRows(moreRows, (d, i) => row(d, i))}</ul>
                {q && !moreRows.length && <p className={clsx('py-2.5 text-label text-faint', pad)}>{t('welcome.teamFiles.searchNone')}</p>}
                {draft.tooBig > 0 && <p className={clsx('border-t border-line py-2.5 text-label text-muted', pad)} data-testid="team-files-too-big">{t('welcome.teamFiles.tooBig', { n: draft.tooBig })}</p>}
              </div>
            )}
          </>
        )}
      </div>
      <p className="text-sm">
        <button type="button" className={quietLink} disabled={busy} onClick={onAddFolder} data-testid="welcome-team-files-add-folder">{t('welcome.teamFiles.addFolder')}</button>
      </p>
      {places.length > 1 && place && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <label htmlFor={`${ids}-place`}>{t('welcome.teamFiles.where')}</label>
          <select id={`${ids}-place`} className="h-8 rounded-lg border border-field-border bg-surface px-2 text-sm text-ink" value={place.groupId} disabled={busy} onChange={(e) => choosePlace(e.target.value)} data-testid="welcome-team-files-place">
            {places.map((p) => <option key={p.groupId} value={p.groupId}>{t('welcome.files.homeFolder', { team: p.name })}</option>)}
          </select>
        </p>
      )}
      {place && <TeamReach team={place.name} groupId={place.groupId} />}
      {capped && <p className="text-label text-warn" role="status" data-testid="welcome-team-files-cap">{t('welcome.teamFiles.cap', { n: L.perUpload })}</p>}
      <div className={phone ? 'space-y-2' : 'flex flex-wrap items-center justify-between gap-3'}>
        <Button variant="primary" className={phone ? 'w-full' : undefined} disabled={busy || !place} onClick={ticks.size ? upload : onOtherFolder} data-testid="welcome-team-files-upload">{primary}</Button>
        {later && <div className={phone ? 'flex justify-center' : undefined}>{later}</div>}
      </div>
    </div>
  )
}

/** F4 while the run goes, F5 after: what went up, what did not, and the way on. */
function RunView({ run, places, nextLabel, busy, phone, onDone, onMore }: { run: Run; places: Place[]; nextLabel: string; busy: boolean; phone: boolean; onDone: (n: number) => void; onMore: (() => void) | null }) {
  const t = useT()
  const locale = useLocale()
  const v = run.view
  const rows = run.run.rows()
  const running = v.status === 'running'
  const place = places.find((p) => p.folder === v.base)
  const folder = t('welcome.files.homeFolder', { team: place?.name ?? baseName(v.base) })
  const left = rows.filter((r) => r.state !== 'done')
  const failed = rows.filter((r) => r.state === 'failed')
  const notSent = rows.filter((r) => r.state === 'queued')
  const reason = (r: (typeof rows)[number]) => {
    if (r.state === 'queued') return t('welcome.teamFiles.notSent')
    if (r.local === 'tooLarge') return t('files.folderUpload.tooLarge', { size: formatSize(L.fileBytes, locale) })
    if (r.local === 'unreadable') return t('files.folderUpload.unreadable')
    if (r.local) return t(`files.name.${r.local}`)
    return errorText(r.error, locale, t('error.network'))
  }
  /** 다시: the list again with what did not go ticked (넣을 곳 there), or — hand-picked files — the same files again */
  const again = () => {
    const d = useDraft.getState()
    const keys = new Set(left.map((r) => r.rel.normalize('NFC')))
    const fromList = d.docs.filter((x) => keys.has(`${x.pick}/${x.rel}`))
    if (fromList.length) {
      // what went up is "이미 있어요" now (never a second copy), what did not is ticked
      const went = new Set(rows.filter((r) => r.state === 'done').map((r) => r.rel.normalize('NFC')))
      const already = new Set([...d.already].filter((k) => !keys.has(k)))
      for (const x of d.docs) if (went.has(`${x.pick}/${x.rel}`)) already.add(x.key)
      patch({ screen: 'list', ticks: new Set(fromList.map((x) => x.key)), baseline: new Set(), already })
      return
    }
    if (!notSent.length && v.canRetry) return retryFolderUpload(run)
    const files = left.filter((r) => r.file && !r.local).map((r) => ({ rel: r.rel, file: r.file! }))
    if (files.length) startStepRun({ files, folders: [], unreadable: [], skipped: 0 }, v.base)
  }
  const pct = (r: (typeof rows)[number]) => (r.state === 'done' ? 100 : r.size ? Math.min(99, Math.round((r.loaded / r.size) * 100)) : 0)
  return (
    <div className="space-y-4" data-testid="welcome-team-files-run" data-status={v.status}>
      <h2 className="text-lg font-semibold text-ink" role="status" data-testid="welcome-team-files-run-title">
        {running ? t('welcome.teamFiles.uploading', { k: v.done, n: v.total }) : t('welcome.teamFiles.done', { folder, n: v.done })}
      </h2>
      {(running || left.length > 0) && (
        <ul className="space-y-1.5 text-sm" data-testid="welcome-team-files-run-rows">
          {(running ? rows : left).slice(0, ROWS_SHOWN).map((r) => (
            <li key={r.rel} className="flex min-w-0 items-center gap-2" data-testid="team-file-run-row" data-state={r.state}>
              {r.state === 'done' ? <Check size={14} className="shrink-0 text-ok" aria-hidden /> : r.state === 'failed' ? <CircleAlert size={14} className="shrink-0 text-danger" aria-hidden />
                : r.state === 'active' ? <Loader2 size={14} className="shrink-0 animate-spin text-faint" aria-hidden /> : <span className="size-3.5 shrink-0" aria-hidden />}
              <span className="min-w-0 flex-1 truncate text-ink">{baseName(r.rel)}</span>
              {running && r.state !== 'failed' ? (
                <span className="h-1 w-20 shrink-0 overflow-hidden rounded bg-subtle" aria-hidden><span className="block h-full bg-accent transition-[width]" style={{ width: `${pct(r)}%` }} /></span>
              ) : r.state !== 'done' && <span className="max-w-[50%] shrink-0 truncate text-xs text-danger" title={reason(r)}>{reason(r)}</span>}
            </li>
          ))}
        </ul>
      )}
      {!running && (failed.length > 0 || notSent.length > 0) && <ErrorNote onRetry={again}>{t('welcome.teamFiles.failed')}</ErrorNote>}
      <div className={phone ? 'space-y-2' : 'flex flex-wrap items-center justify-between gap-3'}>
        {running ? (
          <button type="button" className={clsx(quietLink, 'text-sm')} onClick={() => void stopFolderUpload(run)} data-testid="welcome-team-files-stop-upload">{t('welcome.teamFiles.stopUpload')}</button>
        ) : (
          <>
            <Button variant="primary" className={phone ? 'w-full' : undefined} disabled={busy} onClick={() => onDone(v.done)} data-testid="welcome-team-files-next">{nextLabel}</Button>
            {onMore && <button type="button" className={clsx(quietLink, 'text-sm')} disabled={busy} onClick={onMore} data-testid="welcome-team-files-more-folder">{t('welcome.teamFiles.addFolder')}</button>}
          </>
        )}
      </div>
    </div>
  )
}

/** "여기 올린 파일은 {팀} n명만 봐요 · 채팅은 각자만 봐요", with the real count (the group's members and the owners and
 * admins), and, when members of the team are not in its group yet, one quiet "지금 있는 팀원 n명도 넣기" that adds them
 * (the owner's choice: nobody is added by itself). Until the count is known, or when it cannot be read, the line
 * without a number. The owner alone reads "지금은 나만 봐요 · 팀원을 초대하면 {팀} 모두가 봐요" ("{팀} 1명만 봐요" read
 * oddly: docs/DECISIONS.md "W3"). */
function TeamReach({ team, groupId }: { team: string; groupId: string | null }) {
  const t = useT()
  const locale = useLocale()
  const [reach, setReach] = useState<{ viewers: number; outside: string[]; memberIds: string[] } | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // an answer that comes after the line is gone changes nothing
  const live = useRef(true)
  useEffect(() => () => { live.current = false }, [])
  const load = async (id: string) => {
    const [users, groups] = await Promise.all([api.call(API.listUsers), api.call(API.listGroups)])
    if (!live.current) return
    const group = groups.items.find((g) => g.id === id)
    if (!group) return setReach(null)
    setReach({ ...teamReach(users.items, group.memberIds), memberIds: group.memberIds })
  }
  useEffect(() => {
    if (!groupId) return
    void load(groupId).catch(() => { if (live.current) setReach(null) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId])
  const add = async () => {
    if (!groupId || !reach) return
    setAdding(true)
    setError(null)
    try {
      await api.call(API.updateGroup, { params: { id: groupId }, body: { memberIds: [...new Set([...reach.memberIds, ...reach.outside])] } })
      await load(groupId)
    } catch (e) {
      if (live.current) setError(errorText(e, locale, t('error.network')))
    } finally {
      if (live.current) setAdding(false)
    }
  }
  return (
    <div className="space-y-1">
      <p className="text-label leading-5 text-muted" data-testid="welcome-files-who">
        {!reach ? t('welcome.files.who', { team }) : reach.viewers <= 1 ? t('welcome.files.whoAlone', { team }) : t('welcome.files.whoCount', { team, n: reach.viewers })}
      </p>
      {reach && reach.outside.length > 0 && (
        <p className="text-label">
          <button type="button" className={quietLink} disabled={adding} onClick={() => void add()} data-testid="welcome-files-add-members">
            {t('welcome.files.addMembers', { n: reach.outside.length })}
          </button>
        </p>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  )
}

// ---------------------------------------------------------------- the Files screen's way in

/**
 * After the setup, on a computer's Files screen: one quiet line for owners and admins while the team folder holds no
 * file (its own folders, made by the steps, do not count), "폴더에서 회사 문서 추천받기", which opens the same steps in a
 * dialog. The line shows at the top of the files and in the team folder.
 */
export function TeamFilesEntry({ here }: { here: string }) {
  const t = useT()
  const me = useMeStrict()
  const narrow = useMediaQuery('(max-width: 767.98px)')
  const admin = me.user.role === 'owner' || me.user.role === 'admin'
  const progress = useWelcome((s) => s.progress)
  const settled = useFolderUploadsSettled()
  const [empty, setEmpty] = useState(false)
  const [open, setOpen] = useState(false)
  const folder = progress?.teamGroup?.folder ?? null
  useEffect(() => {
    if (admin && !narrow) void useWelcome.getState().load().catch(() => {})
  }, [admin, narrow])
  useEffect(() => {
    if (!admin || narrow || !folder || (here !== '' && here !== folder)) return
    let live = true
    void listFolder(folder).then((list) => { if (live) setEmpty(!!list && !list.some((e) => e.type === 'file')) })
    return () => { live = false }
  }, [admin, narrow, folder, here, settled, open])
  if (!admin || narrow || !folder || !progress || folderWindow() === null || (here !== '' && here !== folder) || (!empty && !open)) return null
  return (
    <>
      <p className="mx-4 mb-2 text-sm sm:mx-6">
        <button type="button" className={clsx(quietLink, 'inline-flex items-center gap-1.5')} onClick={() => setOpen(true)} data-testid="files-team-files-entry">
          <FolderOpen size={14} className="shrink-0 text-faint" aria-hidden /> {t('welcome.teamFiles.filesEntry')}
        </button>
      </p>
      <Modal open={open} onClose={() => setOpen(false)} title={t('welcome.teamFiles.dialogTitle')} width={640}>
        <TeamFilesStep progress={progress} busy={false} nextLabel={t('common.close')} dialog onDone={() => setOpen(false)} onSkip={() => setOpen(false)} />
      </Modal>
    </>
  )
}

