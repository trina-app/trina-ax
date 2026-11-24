// What the AI did while answering ("파일 검색 중", web search, browser, artifacts): a compact list under the answer.
// While streaming the last few steps show; afterwards it folds into "작업 N단계" that opens on click.
// Web search results are plain links (no favicons: an external image would load by itself). A team path names the
// team's well-known folders in words (stepPlace: "파일 읽기 · 브랜드 이미지 폴더 › 홈페이지-6.jpg"), the path in the tooltip.
// A step the per-answer time limit cut off (Step.paused) shows as paused like the answer, not as a failure; one the
// person's Stop cut off (Step.stopped) shows as stopped, like Claude Code's "Interrupted": a grey icon and the words
// next to the label ("Paused here", "Stopped here"), for sighted readers as well as screen readers (QA 0.2.12 N3).
// A failed step the AI got past is not red (docs/DECISIONS.md "A failed step the AI got past is not red"): a file name
// it guessed wrong and then the right file get a quiet mark whose tooltip says so ("안 됐지만 트리나가 다른 방법으로 이어
// 갔어요"); red, on the row and on the folded list, stays for a failure nothing got past (stepMark).
// A sub-task (Claude Code's Agent tool, docs/DECISIONS.md "Sub-agents") is one row like Claude Code's "Agent(...)": its
// sub-agent's steps (Step.parentId) open under it, and while it works its latest step shows beneath it.
// An answer that ran a team skill on team files (Message.receipt) says so in place of "작업 N단계": "팀 스킬 '할 일 정리'
// · 팀 파일 2개" (docs/DECISIONS.md "M — One meeting note, everyone's own tasks"), the receipt of a shared skill on shared
// files; it still opens the step list.
// A dev environment command or job that waits in the team queue (Step.devEnvRun) shows "Waiting for the dev
// environment… #2 in line" under its row, with the live place (lib/devEnvQueue.ts) and a Cancel button, until it
// starts; a command that waited too long says the dev environment is full. A dev server the AI started with a port
// (Step.devEnvRun kind server) shows a Preview button: it asks for a short-lived link on the separate preview origin
// (docs/DECISIONS.md "Dev environment on srt: preview") and opens it in a new tab.
// A post the AI made to a room (post_to_room, Step.posted) has 보기, like the button's sent line: the room at the message
// or the thread at the reply. A side chat gives its own way there (StepPostView: its column, a phone's panel).
// Like Claude Code, each call says what it did: its line names the key input (a query, an address, a path: the server
// writes it, step-key-input.ts) and a few words beside it say what came back ("10 results", "Declined", "Didn't work";
// Step.outcome), never only an icon. Three or more calls in a row of the same tool fold into one row ("Bright Data ·
// Search Engine · 12 calls") that opens to each call's input (docs/decisions/20261124-step-key-input.md).
import clsx from 'clsx'
import { AudioLines, Brain, Check, ChevronDown, ChevronRight, CircleAlert, CircleDashed, CircleMinus, CirclePause, CircleStop, Clock, FileSearch, Film, Globe, Info, Loader2, MessageCircleQuestion, Monitor, Presentation, Shapes, Workflow, Wrench } from 'lucide-react'
import { createContext, useContext, useState } from 'react'
import { api, API, ApiError, errorText } from '../../lib/api'
import { refreshQueue, useQueuePlace } from '../../lib/devEnvQueue'
import { toast } from '../../store/ui'
import { chatPlaceWords, localizeStep, mediaStepKind, READ_ONLY_TOOLS, REMOVED_READ_ONLY_TOOLS, slidesStep, stepPlace, unansweredStep } from '@mycel/shared'
import type { Memory, Message, Step } from '@mycel/shared/api'
import { useSkillTitle } from '../../lib/skillTitles'
import { useLocale, useT } from '../../i18n'
import { openExternal, safeHref } from '../../lib/safeLinks'
import { aiName } from '../../lib/tabs'
import { navigateTo } from '../../lib/nav'
import { TeamImage } from '../LazyMarkdown'
import { stepImages } from '../../lib/stepImages'
import { usePlaceViewer } from '../../lib/teamPlace'
import { Tooltip } from '../Tooltip'

type TFunction = ReturnType<typeof useT>
const ICON = { tool: Wrench, thinking: Brain, web_search: Globe, browser: Monitor, artifact: Shapes, ask_user: MessageCircleQuestion } as const
const FILE_TOOLS = new Set(['read', 'grep', 'glob', 'list', 'write', 'edit', 'edit_files'])

/** "12 tool uses · 1m 20s" of a sub-task (either part may be unknown yet) */
export function subtaskStats(sub: Step['subtask'], t: TFunction): string {
  if (!sub) return ''
  const parts: string[] = []
  if (sub.toolUses !== undefined) parts.push(t('steps.subtaskToolUses', { n: sub.toolUses }))
  if (sub.ms !== undefined) {
    const s = Math.round(sub.ms / 1000)
    parts.push(s < 60 ? t('steps.secs', { s }) : t('steps.minSecs', { m: Math.floor(s / 60), s: s % 60 }))
  }
  return parts.join(' · ')
}

/** A step that only looked something up (a read, a search, a web search; a removed search tool's step in an older chat):
 * its failure changed nothing. */
const lookedUp = (s: Step) => s.kind === 'web_search' || s.kind === 'thinking' || (s.kind === 'tool' && !!s.tool && (READ_ONLY_TOOLS.has(s.tool) || REMOVED_READ_ONLY_TOOLS.has(s.tool)))
/** Tools that save a file: one that worked makes up for another that failed. */
const SAVE_TOOLS = new Set(['write', 'edit', 'edit_files', 'make_file', 'edit_hwp', 'edit_office', 'stamp_pdf', 'edit_pdf', 'merge_pdfs', 'split_pdf', 'resize_images', 'unzip_file', 'make_zip', 'query_data', 'change_banner_text'])
/** What a later step must have done to make up for a failed one that changed something: the same tool (a save tool for a
 * save, a browser step for a browser step). */
const family = (s: Step) => (s.tool && SAVE_TOOLS.has(s.tool) ? 'save' : s.kind !== 'tool' ? `kind:${s.kind}` : `tool:${s.tool ?? ''}`)

/** Failed steps the AI went on past. A failed look-up: any later step of the same agent, or of the main AI, ended well,
 * or the sub-agent it belongs to finished its sub-task. A failed step that would have changed something (a save, a
 * send, a video): only a later call of the same kind that ended well (a failed save, then an unrelated read, is not
 * made up for). Steps are kept in the order they started. Thinking and attached-file notes are no work done. */
export function stepsGotPast(steps: Step[]): Set<string> {
  const subtasks = new Map(steps.filter((s) => s.tool === 'agent').map((s) => [s.id, s]))
  const groupOf = (s: Step) => (s.parentId && subtasks.has(s.parentId) ? s.parentId : null)
  const past = new Set<string>()
  steps.forEach((s, i) => {
    if (s.status !== 'error') return
    const group = groupOf(s)
    const look = lookedUp(s)
    if (look && group && subtasks.get(group)!.status === 'ok') past.add(s.id)
    else if (steps.slice(i + 1).some((x) => x.status === 'ok' && x.kind !== 'thinking' && x.tool !== 'attachment' && (groupOf(x) === null || groupOf(x) === group) && (look || family(x) === family(s)))) past.add(s.id)
  })
  return past
}

/** What decides a failed step's mark: the answer still runs (`live`), the answer itself failed (`answerFailed`: status
 * 'error', an interrupted answer too), and the failed steps the AI went on past (stepsGotPast). */
/** Where a post's 보기 goes (a room's side chat passes its own; elsewhere the room's or the thread's page). */
export const StepPostView = createContext<((p: NonNullable<Step['posted']>) => void) | null>(null)
export const postPath = (p: NonNullable<Step['posted']>) => (p.threadRootId ? `/rooms/${p.roomId}/t/${p.threadRootId}?m=${p.messageId}` : `/rooms/${p.roomId}?m=${p.messageId}`)

export interface MarkContext { live: boolean; answerFailed: boolean; gotPast: ReadonlySet<string> }

/** What a step's mark shows (docs/DECISIONS.md "A failed step the AI got past is not red"). A step that ended in an
 * error is the AI's own trial and error, shown with a quiet mark and never an alarm, when the AI went on past it (a
 * file name it guessed wrong, then the right file; a call that failed, then one of the same kind that worked:
 * stepsGotPast), also in an answer that failed later for another reason; while the answer still runs (it may still get past it); and, under an answer that
 * did not fail, when it only looked something up. Red: a failure nothing got past (a save, a send or a change that
 * stayed undone, a step the failing answer ended on), and a dev environment command that did not run because the
 * environment was full (the line under it says so, and the AI was told not to try again). A command the person
 * cancelled is theirs, no failure. A step the time limit or Stop cut off says so (paused, stopped); an attached
 * file's note is neither. A card that ran out without an answer (a question, remember's "may I keep this?") is no
 * success either: a quiet mark with "답하지 않음" beside the line (unanswered). */
export type StepMark = 'running' | 'note' | 'paused' | 'stopped' | 'cancelled' | 'failed' | 'retried' | 'unanswered' | 'done'
export function stepMark(step: Step, o: MarkContext): StepMark {
  if (step.status === 'running' && o.live) return 'running'
  if (step.tool === 'attachment') return 'note'
  if (step.paused) return 'paused'
  if (step.stopped) return 'stopped'
  if (step.status !== 'error') return unansweredStep(step) ? 'unanswered' : 'done'
  if (step.devEnvRun?.state === 'expired') return 'failed'
  if (step.devEnvRun?.state === 'cancelled') return 'cancelled'
  if (o.gotPast.has(step.id) || o.live || (!o.answerFailed && lookedUp(step))) return 'retried'
  return 'failed'
}

/** The folded list's red "some steps failed" mark: a step whose mark is red (not one the AI got past, the limit or Stop
 * cut off). */
export function showsFailures(steps: Step[], answerFailed: boolean, gotPast: ReadonlySet<string> = stepsGotPast(steps)): boolean {
  const o = { live: false, answerFailed, gotPast }
  return steps.some((s) => stepMark(s, o) === 'failed')
}

/** The waiting state of a dev environment run under its step (only the person of the chat sees the chat). */
function QueueLine({ step }: { step: Step }) {
  const t = useT()
  const locale = useLocale()
  const run = step.devEnvRun!
  // a command's ticket goes with its call: once the step ended there is nothing to watch
  const watching = run.state === 'waiting' && !run.why && (run.kind === 'job' || step.status === 'running')
  const place = useQueuePlace(watching ? run.id : null)
  const [busy, setBusy] = useState(false)
  if (run.state === 'expired') return <p className="ml-6 px-1 text-xs text-danger" data-testid="devenv-queue-full">{t('devEnvQueue.full')}</p>
  if (run.state === 'cancelled') return <p className="ml-6 px-1 text-xs text-muted" data-testid="devenv-queue-cancelled">{t('devEnvQueue.cancelled')}</p>
  // waiting for another command of the same project: no place in line and no Cancel (it holds no slot)
  if (run.state === 'waiting' && run.why === 'project' && step.status === 'running') return <p className="ml-6 px-1 text-xs text-muted" data-testid="devenv-queue-project" role="status">{t('devEnvQueue.waitingProject')}</p>
  if (!watching || place === 'gone') return null
  const n = typeof place === 'number' ? place : run.position
  const cancel = async () => {
    setBusy(true)
    try { await api.call(API.stopMyDevEnvRun, { params: { runId: run.id } }) } catch (e) { toast({ level: 'error', text: errorText(e, locale, t('error.network')) }) } finally { setBusy(false); refreshQueue() }
  }
  return (
    <div className="ml-6 flex items-center gap-2 px-1 text-xs text-muted" data-testid="devenv-queue" role="status">
      <Clock size={12} className="shrink-0 text-faint" aria-hidden />
      <span className="min-w-0 flex-1">{n ? t('devEnvQueue.waiting', { n }) : t('devEnvQueue.waitingNoPlace')}</span>
      <button type="button" disabled={busy} onClick={() => void cancel()} className="touch-hit shrink-0 rounded px-1.5 py-0.5 text-xs text-accent-text hover:bg-hover disabled:opacity-50" data-testid="devenv-queue-cancel">
        {t('devEnvQueue.cancel')}
      </button>
    </div>
  )
}

/** The Preview button of a dev server step. The run may have ended since: then the button says so and goes. */
function PreviewLine({ step }: { step: Step }) {
  const t = useT()
  const locale = useLocale()
  const run = step.devEnvRun!
  const [busy, setBusy] = useState(false)
  const [ended, setEnded] = useState(false)
  if (!run.port) return null
  if (ended) return <p className="ml-6 px-1 text-xs text-muted" data-testid="devenv-preview-ended">{t('devEnvPreview.ended')}</p>
  const open = async () => {
    // open the tab now (a tab opened after a wait is blocked as a pop-up), then send it to the link
    const tab = window.open('', '_blank')
    if (tab) tab.opener = null
    setBusy(true)
    try {
      const r = await api.call(API.previewMyDevEnvRun, { params: { runId: run.id }, body: { port: run.port! } })
      if (tab) tab.location.href = r.url
      else openExternal(r.url)
    } catch (e) {
      tab?.close()
      const reason = e instanceof ApiError ? e.body.params?.reason : undefined
      if (reason === 'dev_env_preview_not_running') setEnded(true)
      else toast({ level: 'error', text: reason === 'dev_env_preview_not_configured' ? t('devEnvPreview.notSetUp') : errorText(e, locale, t('error.network')) })
    } finally { setBusy(false) }
  }
  return (
    <div className="ml-6 flex items-center gap-2 px-1 text-xs text-muted" data-testid="devenv-preview">
      <Monitor size={12} className="shrink-0 text-faint" aria-hidden />
      <span className="min-w-0 flex-1">{t('devEnvPreview.line', { port: run.port })}</span>
      <button type="button" disabled={busy} onClick={() => void open()} className="touch-hit shrink-0 rounded px-1.5 py-0.5 text-xs text-accent-text hover:bg-hover disabled:opacity-50" data-testid="devenv-preview-open">
        {t('devEnvPreview.open')}
      </button>
    </div>
  )
}

/** The person's memories as they are now (their own list, newest first; a few pages at most): for 되돌리기. */
async function currentMemories(): Promise<Memory[]> {
  const out: Memory[] = []
  let cursor: string | undefined
  for (let i = 0; i < 5; i++) {
    const r = await api.call(API.listMemories, { query: { limit: 100, ...(cursor ? { cursor } : {}) } })
    out.push(...r.items)
    if (!r.nextCursor) break
    cursor = r.nextCursor
  }
  return out
}

/** 되돌리기 on a memory step (remember, a change, forget), through the memory routes the person has in Settings (no
 * route of its own): a new memory is deleted, a change put back, a forgotten one kept again. One that is gone, or that
 * changed since the step, is left as it is, with a line saying so. */
function MemoryUndo({ memory }: { memory: NonNullable<Step['memory']> }) {
  const t = useT()
  const locale = useLocale()
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  if (state === 'done') return <span className="shrink-0 text-xs text-faint" data-testid="step-memory-undone">{t('steps.memoryUndone')}</span>
  const undo = async () => {
    setState('busy')
    try {
      const now = await currentMemories()
      const it = now.find((m) => m.id === memory.id)
      if (memory.change === 'forgotten') {
        if (it || now.some((m) => m.text === memory.text)) { toast({ level: 'info', text: t('memory.undoBack') }); setState('done'); return }
        await api.call(API.createMemory, { body: { text: memory.text } })
      } else {
        if (!it) { toast({ level: 'info', text: t('memory.undoGone') }); setState('done'); return }
        if (it.text !== memory.text) { toast({ level: 'info', text: t('memory.undoChanged') }); setState('idle'); return }
        if (memory.change === 'created') await api.call(API.deleteMemory, { params: { id: memory.id } })
        else if (memory.before !== undefined) await api.call(API.updateMemory, { params: { id: memory.id }, body: { text: memory.before } })
      }
      setState('done')
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) { toast({ level: 'info', text: t('memory.undoGone') }); setState('done'); return }
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      setState('idle')
    }
  }
  return (
    <button type="button" disabled={state === 'busy'} onClick={() => void undo()}
      className="touch-hit shrink-0 rounded-sm text-xs font-medium text-ink underline-offset-2 hover:underline disabled:opacity-50" data-testid="step-memory-undo">
      {t('steps.memoryUndo')}
    </button>
  )
}

/** The words beside a step's line for what it came back with (Step.outcome), or for a mark that is no success. */
export function outcomeWords(step: Step, mark: StepMark, t: TFunction): string {
  const end = step.outcome?.end
  // a failure the AI went on past reads as the quiet mark says ("Didn't work"), not as a red "Failed"
  if (end && !(end === 'failed' && mark === 'retried')) return t(END_KEY[end])
  if (mark === 'retried') return t('steps.retriedShort')
  if (mark === 'failed') return t('steps.failed')
  if (step.outcome?.count !== undefined && mark === 'done') return t('steps.results', { n: step.outcome.count })
  return ''
}
const END_KEY = { declined: 'steps.endDeclined', unanswered: 'steps.endUnanswered', skipped: 'steps.endSkipped', refused: 'steps.endRefused', failed: 'steps.failed' } as const

/** A call's line inside a folded run: what is left after the run's shared start ("Bright Data · Search Engine"), the
 * whole line when nothing is. */
export function runRest(label: string, head: string): string {
  if (!head || !label.startsWith(head)) return label
  const rest = label.slice(head.length).replace(/^\s*·\s*/, '').trim()
  return rest || label
}

function StepRow({ step, live, marks, kids = [], head: runHead = '' }: { step: Step; live: boolean; marks: Omit<MarkContext, 'live'>; kids?: Step[]; head?: string }) {
  const t = useT()
  const locale = useLocale()
  const viewPost = useContext(StepPostView)
  // the label was written in the language the answer ran in: redraw its words in the language on screen, and the
  // team's well-known folders in words ("브랜드 이미지 폴더 › a.jpg"; the path itself in the tooltip)
  const viewer = usePlaceViewer()
  const words = localizeStep(step, locale)
  // (another person's folder by their name, not "My files": a shared chat's reader is not always its asker, QA TC-8922)
  const placed = stepPlace(step, words.label, locale, viewer)
  const place = runHead ? { ...placed, label: runRest(placed.label, runHead) } : placed
  const [open, setOpen] = useState(false)
  const subtask = step.tool === 'agent'
  // the AI's thinking text (QA AP-033): closed until the person opens it, like claude.ai
  const thinking = step.kind === 'thinking'
  // a read of a video or an audio file ("Watch video · …") shows a film / sound icon
  const media = step.kind === 'tool' ? mediaStepKind(step) : null
  // a look at a deck's slides ("View slides 3–5 · …") a slide icon
  const Icon = step.memory ? Brain : subtask ? Workflow : media === 'video' ? Film : media === 'audio' ? AudioLines : step.kind === 'tool' && slidesStep(step) ? Presentation : step.kind === 'tool' && step.tool && FILE_TOOLS.has(step.tool) ? FileSearch : ICON[step.kind] ?? Wrench
  const hidden = step.subtask?.hidden ?? 0
  const mark = stepMark(step, { live, ...marks })
  // a card that ran out: "답하지 않음" is said beside the line, so the row does not open just to say it again
  const unanswered = mark === 'unanswered'
  // a memory step's detail is the memory's id (the server's record), never words to show; a tool's error text names a
  // chat file by its inner path: in words, never its file id (QA TC-7048)
  const detail = unanswered || step.memory || !words.detail || words.detail.startsWith('memory:') ? undefined : thinking ? words.detail : chatPlaceWords(words.detail, locale)
  const expandable = !!(detail || step.sources?.length || step.images?.length || (subtask && (kids.length || hidden)))
  const running = mark === 'running'
  // a failure the AI went on past: "안 됐지만 트리나가 다른 방법으로 이어 갔어요" ("…찾고 있어요" while it answers and
  // nothing after it worked yet)
  const retried = mark === 'retried' ? t(live && !marks.gotPast.has(step.id) ? 'steps.retrying' : 'steps.retried', { ai: aiName(t) }) : ''
  // a sub-task row's name replaces its contents: its mark's words go into the name
  const markWords = mark === 'retried' ? retried : mark === 'failed' ? t('steps.failed') : ''
  const stats = subtask ? subtaskStats(step.subtask, t) : ''
  // cut off by the time limit or by Stop: said in words, not only by the icon
  const cut = running || step.tool === 'attachment' ? '' : step.paused ? t('steps.paused') : step.stopped ? t('steps.stopped') : unanswered ? words.detail ?? '' : ''
  // what came back, in words beside the line ("10 results", "Declined", "Didn't work"): never only an icon. A sub-task
  // says its mark in its own name; a web search counts its results below
  const came = cut || running || subtask || step.sources?.length ? '' : outcomeWords(step, mark, t)
  // while a sub-agent works, its latest step shows under its row (like Claude Code)
  const latest = subtask && running && !open ? kids[kids.length - 1] : undefined
  // a row that opens is a button; one with nothing to open is not a control (a disabled button would also swallow the
  // pointer, and with it the tooltip of its mark)
  // the key input on its own line under the tool's words on a narrow screen, never cut there (Step.key: the line's end
  // the server marked; a line changed since, or redrawn in other words, stays one line)
  const split = !runHead && step.key && place.label.endsWith(step.key) && place.label.length > step.key.length
    ? { head: place.label.slice(0, -step.key.length), key: step.key.replace(/^ · /, '').trim() } : null
  const rowClass = clsx('flex w-full gap-2 rounded px-1 py-0.5 text-left', runHead ? 'items-start sm:items-center' : 'items-center', expandable && 'hover:bg-hover')
  const head = (
    <>
      {/* a call's line that may wrap (a folded run's call on a narrow screen): its marks stay on the first line */}
      <span className={runHead ? 'flex h-lh shrink-0 items-center gap-2 sm:contents' : 'contents'}>
      {running ? <Loader2 size={13} className="shrink-0 animate-spin" aria-label={t('steps.running')} /> : mark === 'note' ? (
        // what happened to an attached team file (changed, moved, unavailable): a note, not a success or a failure
        <Info size={13} className="shrink-0 text-faint" aria-hidden />
      ) : mark === 'paused' ? (
        <CirclePause size={13} className="shrink-0 text-muted" aria-hidden data-testid="step-paused" />
      ) : mark === 'stopped' ? (
        <CircleStop size={13} className="shrink-0 text-muted" aria-hidden data-testid="step-stopped" />
      ) : unanswered ? (
        // a card nobody answered: neither a success nor a failure (the words beside the line say it)
        <CircleDashed size={13} className="shrink-0 text-muted" aria-hidden data-testid="step-unanswered" />
      ) : mark === 'cancelled' ? (
        // a waiting command the person cancelled: the line under the row says so
        <CircleStop size={13} className="shrink-0 text-muted" aria-hidden data-testid="step-cancelled" />
      ) : mark === 'retried' ? (
        <Tooltip label={retried}>
          <CircleMinus size={13} className="shrink-0 text-faint" aria-label={retried} role="img" data-testid="step-retried" />
        </Tooltip>
      ) : mark === 'failed' ? <CircleAlert size={13} className="shrink-0 text-danger" aria-label={t('steps.failed')} data-testid="step-failed" /> : <Check size={13} className="shrink-0 text-ok" aria-label={t('steps.done')} />}
      <Icon size={13} className="shrink-0 text-faint" aria-hidden />
      </span>
      {step.memory && !expandable ? (
        // a memory step: its words open Settings › Memory (docs/decisions/20261122-auto-memory.md)
        <button type="button" onClick={() => navigateTo('/settings/memory')} title={t('steps.memoryOpen')}
          className="min-w-0 flex-1 truncate text-left hover:underline" data-testid="step-memory-open">{place.label}</button>
      ) : split ? (
        <span className="min-w-0 flex-1 truncate" title={place.path ?? place.label}>
          <span className="hidden sm:inline">{place.label}</span>
          <span className="sm:hidden">{split.head}</span>
        </span>
      ) : <span className={clsx('min-w-0 flex-1', runHead ? '[overflow-wrap:anywhere] sm:truncate' : 'truncate')} title={place.path ?? place.label}>{place.label}</span>}
      {cut ? <span className="shrink-0 text-xs text-muted" data-testid="step-cut">{cut}</span> : null}
      {came ? <span className={clsx('shrink-0 text-xs', mark === 'failed' ? 'text-danger' : 'text-faint')} data-testid="step-outcome">{came}</span> : null}
      {step.sources?.length ? <span className="shrink-0 text-xs text-faint">{t('steps.results', { n: step.sources.length })}</span> : null}
      {stats ? <span className="shrink-0 text-xs text-faint" data-testid="subtask-stats">{stats}</span> : null}
      {step.posted && !expandable ? (
        <button type="button" onClick={() => (viewPost ? viewPost(step.posted!) : navigateTo(postPath(step.posted!)))} aria-label={t('steps.postViewLabel')}
          className="touch-hit shrink-0 rounded-sm text-xs font-medium text-ink underline-offset-2 hover:underline" data-testid="step-post-view">
          {t('steps.postView')}
        </button>
      ) : null}
      {step.memory && !expandable && !running ? <MemoryUndo memory={step.memory} /> : null}
      {expandable && (open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />)}
    </>
  )
  return (
    <li className="text-label text-muted" {...(subtask ? { 'data-testid': 'subtask', 'data-step-id': step.id } : {})}>
      {expandable ? (
        <button type="button" aria-expanded={open} aria-label={subtask ? `${words.label}${cut ? ` · ${cut}` : ''}${markWords ? ` · ${markWords}` : ''} · ${t('steps.subtaskShow')}` : thinking ? `${words.label}${cut ? ` · ${cut}` : ''} · ${t('steps.thinkingShow')}` : undefined}
          onClick={() => setOpen((v) => !v)} className={rowClass} {...(thinking ? { 'data-testid': 'step-thinking' } : {})}>
          {head}
        </button>
      ) : (
        <div className={rowClass}>{head}</div>
      )}
      {/* a narrow screen: the key input on its own dimmer line, under the tool's words, never cut */}
      {split && <p className="ml-11 pr-1 pl-0.5 text-xs text-faint [overflow-wrap:anywhere] sm:hidden" data-testid="step-key">{split.key}</p>}
      {step.devEnvRun && (step.devEnvRun.kind === 'server' ? <PreviewLine step={step} /> : <QueueLine step={step} />)}
      {step.memory?.first && (
        <p className="ml-6 px-1 text-xs text-muted" data-testid="memory-first-line">
          {t('memory.firstLine', { ai: aiName(t) })}{' '}
          <button type="button" onClick={() => navigateTo('/settings/memory')} className="touch-hit text-accent-text hover:underline" data-testid="memory-first-open">{t('memory.firstOpen')}</button>
        </p>
      )}
      {latest && (
        <ul className="ml-6 border-l border-line pl-3" data-testid="subtask-latest">
          <StepRow key={latest.id} step={latest} live={live} marks={marks} />
        </ul>
      )}
      {open && subtask && (
        <ul className="mt-1 mb-2 ml-6 space-y-0.5 border-l border-line pl-3" data-testid="subtask-steps">
          {hidden > 0 && <li className="px-1 text-xs text-faint">{t('steps.subtaskHidden', { n: hidden })}</li>}
          {/* a sub-task's own calls fold the same way (a sub-agent's research is often one tool many times) */}
          {foldRuns(kids).map((it) => ('run' in it
            ? <RunRow key={it.run[0]!.id} run={it.run} live={live} marks={marks} />
            : <StepRow key={it.step.id} step={it.step} live={live} marks={marks} />))}
        </ul>
      )}
      {open && !subtask && (
        <div className="mt-1 mb-2 ml-6 space-y-1.5 border-l border-line pl-3">
          {detail && <p className="text-xs whitespace-pre-wrap text-muted" {...(thinking ? { 'data-testid': 'step-thinking-text' } : {})}>{detail}</p>}
          {step.sources && (
            <ul className="space-y-1" data-testid="search-sources">
              {step.sources.map((s, i) => (
                <li key={`${i}:${s.url}`} className="truncate">
                  {/* search results come from the web: only http(s) addresses become links */}
                  {safeHref(s.url) ? (
                    <a href={safeHref(s.url)!} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" className="text-xs text-accent-text hover:underline">
                      {s.title || s.url}
                    </a>
                  ) : (
                    <span className="text-xs text-muted">{s.title || s.url}</span>
                  )}
                  <span className="ml-1.5 text-micro text-faint">{hostOf(s.url)}</span>
                </li>
              ))}
            </ul>
          )}
          {step.images?.length ? <StepPictures images={step.images} /> : null}
        </div>
      )}
    </li>
  )
}

/** A step's pictures (shared browser screenshots, a tool's saved pictures such as change_banner_text's sizes), each
 * once, with its label under it ("1080x1920") when it has one. The chat draws them itself, so the AI never retypes their
 * paths (a mistyped one showed the 1080x1080 banner twice, replay 11-22). */
export function StepPictures({ images }: { images: NonNullable<Step['images']> }) {
  return (
    <div className="mt-1 flex flex-wrap items-end gap-2" data-testid="step-pictures">
      {images.map((im) => im.label ? (
        <figure key={im.path} className="m-0 flex flex-col items-start" data-testid="step-picture">
          <TeamImage path={im.path} alt={im.alt ?? im.label} className="max-h-56 rounded border border-line" />
          <figcaption className="-mt-1 text-xs text-faint tabular-nums" data-testid="step-picture-label">{im.label}</figcaption>
        </figure>
      ) : (
        <TeamImage key={im.path} path={im.path} alt={im.alt} className="max-h-56 rounded border border-line" />
      ))}
    </div>
  )
}

const hostOf = (u: string) => {
  try {
    return new URL(u).host
  } catch {
    return ''
  }
}

/** The answer's own steps, and each sub-task's steps by its id. A step whose sub-task is not in the list stays on top. */
export function groupSteps(steps: Step[]): { top: Step[]; kids: Map<string, Step[]> } {
  const subtasks = new Set(steps.filter((s) => s.tool === 'agent').map((s) => s.id))
  const kids = new Map<string, Step[]>()
  const top: Step[] = []
  for (const s of steps) {
    if (s.parentId && subtasks.has(s.parentId)) kids.set(s.parentId, [...(kids.get(s.parentId) ?? []), s])
    else top.push(s)
  }
  return { top, kids }
}

/** Steps that fold into a run when three or more come in a row: plain tool calls, by their tool (or, where the tool's
 * name is not shown, as for a teammate's view of a connection's call, by their line). A step with something of its own
 * to show (a sub-task, a memory, a post, pictures, a dev environment run, a card's record) stays a row. */
const RUN_MIN = 3
const runKey = (s: Step): string | null => {
  if (s.kind !== 'tool' || s.tool === 'agent' || s.tool === 'attachment' || s.memory || s.posted || s.images?.length || s.devEnvRun || s.shared || s.scheduled || s.folders || s.fixes?.length || s.todos) return null
  return s.tool ? `tool:${s.tool}` : `label:${s.label}`
}
export type StepItem = { step: Step } | { run: Step[] }
/** The top steps with runs of the same tool folded (RUN_MIN or more in a row). */
export function foldRuns(top: Step[]): StepItem[] {
  const out: StepItem[] = []
  for (let i = 0; i < top.length;) {
    const key = runKey(top[i]!)
    let j = i + 1
    if (key) while (j < top.length && runKey(top[j]!) === key) j++
    if (key && j - i >= RUN_MIN) out.push({ run: top.slice(i, j) })
    else for (let k = i; k < j; k++) out.push({ step: top[k]! })
    i = j
  }
  return out
}
/** The start every line of a run shares, cut back to where a part of the line ends (" · ", ' "'): its tool's words. */
export function runHead(labels: string[]): string {
  let p = labels[0] ?? ''
  for (const l of labels.slice(1)) { let n = 0; while (n < p.length && n < l.length && p[n] === l[n]) n++; p = p.slice(0, n) }
  if (labels.every((l) => l === p)) return p
  // the last place a part of the line ends that is not inside a quoted query ("a · b" is one query)
  for (let i = p.length; i > 0; i--) {
    if (!(p.startsWith(' · ', i) || p.startsWith(' "', i))) continue
    if (((p.slice(0, i).match(/"/g) ?? []).length % 2) === 0) return p.slice(0, i).replace(/\s*·\s*$/, '')
  }
  return ''
}

/** One row for a run of calls of the same tool: its words, how many calls, how many did not work; opens to each call. */
function RunRow({ run, live, marks }: { run: Step[]; live: boolean; marks: Omit<MarkContext, 'live'> }) {
  const t = useT()
  const locale = useLocale()
  const viewer = usePlaceViewer()
  const [open, setOpen] = useState(false)
  const labels = run.map((s) => stepPlace(s, localizeStep(s, locale).label, locale, viewer).label)
  const head = runHead(labels) || labels[0]!
  const ms = run.map((s) => stepMark(s, { live, ...marks }))
  const running = ms.includes('running')
  const failed = ms.includes('failed')
  const notDone = ms.filter((m) => m === 'failed' || m === 'retried').length
  const first = run[0]!
  const Icon = first.tool && FILE_TOOLS.has(first.tool) ? FileSearch : ICON[first.kind] ?? Wrench
  const calls = t('steps.calls', { n: run.length })
  return (
    <li className="text-label text-muted" data-testid="step-run">
      <button type="button" aria-expanded={open} aria-label={`${head} · ${calls}${notDone ? ` · ${t('steps.runNotDone', { n: notDone })}` : ''} · ${t('steps.runShow')}`}
        onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-hover">
        {running ? <Loader2 size={13} className="shrink-0 animate-spin" aria-hidden /> : failed ? <CircleAlert size={13} className="shrink-0 text-danger" aria-hidden /> : notDone ? <CircleMinus size={13} className="shrink-0 text-faint" aria-hidden /> : <Check size={13} className="shrink-0 text-ok" aria-hidden />}
        <Icon size={13} className="shrink-0 text-faint" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{head}</span>
        <span className="shrink-0 text-xs text-faint tabular-nums" data-testid="step-run-count">{calls}</span>
        {notDone ? <span className={clsx('shrink-0 text-xs tabular-nums', failed ? 'text-danger' : 'text-faint')} data-testid="step-run-notdone">{t('steps.runNotDone', { n: notDone })}</span> : null}
        {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
      </button>
      {open && (
        <ul className="mt-1 mb-2 ml-6 space-y-0.5 border-l border-line pl-3" data-testid="step-run-calls">
          {run.map((s) => <StepRow key={s.id} step={s} live={live} marks={marks} head={head} />)}
        </ul>
      )}
    </li>
  )
}

/** A demo server's replayed answer (server/src/demo/replay.ts) carries this step: not a step of the work, but one small
 * line in the opened list ("데모용으로 미리 준비한 결과예요"), never counted, never in the live tail. */
export const DEMO_REPLAY_STEP = 'demo_replay'

/** `failed`: the answer itself failed (Message.status 'error'; stepMark). */
export default function Steps({ steps: all, streaming, failed = false, receipt }: { steps: Step[]; streaming: boolean; failed?: boolean; receipt?: Message['receipt'] }) {
  const t = useT()
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  // a demo server's replayed answer: its note is no step of the work (shown in the opened list only)
  const note = all.find((s) => s.tool === DEMO_REPLAY_STEP)
  // the to-do list is its own card under the steps (TodoCard.tsx), not a row of them
  const steps = all.filter((s) => s !== note && !s.todos)
  // a team skill on team files, once the answer is done
  const rec = !streaming && receipt && receipt.teamFiles > 0 ? receipt : null
  const skill = useSkillTitle(rec?.skill.path ?? null, rec?.skill.name ?? '')
  // a skill someone else made ("S"): "김지훈님의 팀 스킬 '견적서 쓰기' · 팀 파일 1개"
  const receiptText = rec ? (rec.skill.by ? t('steps.receiptBy', { by: rec.skill.by, skill, n: rec.teamFiles }) : t('steps.receipt', { skill, n: rec.teamFiles })) : null
  if (!steps.length) return receiptText ? <p className="mb-3 px-1 text-label text-faint" data-testid="steps-receipt">{receiptText}</p> : null
  const { top, kids } = groupSteps(steps)
  const marks = { answerFailed: failed, gotPast: stepsGotPast(steps) }
  // pictures the steps show (shared browser screenshots, a tool's saved pictures: change_banner_text's sizes) stay
  // visible even when the list is folded, each once
  const shown = stepImages(steps)
  if (streaming) {
    const tail = top.slice(-4)
    return (
      <ul className="mb-3 space-y-0.5" aria-label={t('steps.label')} data-testid="steps">
        {top.length > tail.length && <li className="px-1 text-xs text-faint">{t('steps.earlier', { n: top.length - tail.length })}</li>}
        {tail.map((s) => (
          <StepRow key={s.id} step={s} live marks={marks} kids={kids.get(s.id)} />
        ))}
      </ul>
    )
  }
  return (
    <div className="mb-3" data-testid="steps">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="touch-hit flex items-center gap-1 rounded px-1 py-0.5 text-label text-faint select-none hover:bg-hover hover:text-ink">
        {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        {receiptText ? <span data-testid="steps-receipt">{receiptText}</span> : t('steps.summary', { n: top.length })}
        {showsFailures(steps, failed, marks.gotPast) && <Tooltip label={t('steps.someFailed')}><CircleAlert size={13} className="text-danger" aria-label={t('steps.someFailed')} role="img" data-testid="steps-failed" /></Tooltip>}
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5" aria-label={t('steps.label')}>
          {note && <li className="px-1 text-xs text-faint" data-testid="demo-replay-note">{localizeStep(note, locale).label}</li>}
          {foldRuns(top).map((it) => ('run' in it
            ? <RunRow key={it.run[0]!.id} run={it.run} live={false} marks={marks} />
            : <StepRow key={it.step.id} step={it.step} live={false} marks={marks} kids={kids.get(it.step.id)} />))}
        </ul>
      )}
      {/* what the AI kept, changed or forgot about the person stays in view, with its 되돌리기, while the list is folded
          (docs/decisions/20261122-auto-memory.md) */}
      {!open && top.some((s) => s.memory) && (
        <ul className="mt-0.5 space-y-0.5" data-testid="steps-memory">
          {top.filter((s) => s.memory).map((s) => <StepRow key={s.id} step={s} live={false} marks={marks} />)}
        </ul>
      )}
      {/* a queued job outlives the answer: its place in line stays in view while the list is folded */}
      {!open && steps.filter((s) => s.devEnvRun?.kind === 'job' && s.devEnvRun.state === 'waiting').map((s) => <QueueLine key={s.id} step={s} />)}
      {!open && shown.length > 0 && <StepPictures images={shown} />}
    </div>
  )
}
