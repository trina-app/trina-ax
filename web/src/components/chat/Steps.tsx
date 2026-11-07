// What the AI did while answering ("파일 검색 중", web search, browser, artifacts): a compact list under the answer.
// While streaming the last few steps show; afterwards it folds into "작업 N단계" that opens on click.
// Web search results are plain links (no favicons: an external image would load by itself). A team path names the
// team's well-known folders in words (stepPlace: "파일 읽기 · 브랜드 이미지 폴더 › 홈페이지-6.jpg"), the path in the tooltip.
// A step the per-answer time limit cut off (Step.paused) shows as paused like the answer, not as a failure; one the
// person's Stop cut off (Step.stopped) shows as stopped, like Claude Code's "Interrupted": a grey icon and the words
// next to the label ("Paused here", "Stopped here"), for sighted readers as well as screen readers (QA 0.2.12 N3).
// A step that failed is red only when the answer itself failed (docs/DECISIONS.md "A failed step the AI got past is
// not red"): otherwise the AI got past it (a file name it guessed wrong, then the right file), and it gets a quiet
// "went another way" mark whose tooltip says so; the folded list's red mark too only for a failed answer (stepMark).
// A sub-task (Claude Code's Agent tool, docs/DECISIONS.md "Sub-agents") is one row like Claude Code's "Agent(...)": its
// sub-agent's steps (Step.parentId) open under it, and while it works its latest step shows beneath it.
// An answer that ran a team skill on team files (Message.receipt) says so in place of "작업 N단계": "팀 스킬 '할 일 정리'
// · 팀 파일 2개" (docs/DECISIONS.md "M — One meeting note, everyone's own tasks"), the receipt of a shared skill on shared
// files; it still opens the step list.
// A dev environment command or job that waits in the team queue (Step.devEnvRun) shows "Waiting for the dev
// environment… #2 in line" under its row, with the live place (lib/devEnvQueue.ts) and a Cancel button, until it
// starts; a command that waited too long says the dev environment is full.
import clsx from 'clsx'
import { AudioLines, Brain, Check, ChevronDown, ChevronRight, CircleAlert, CirclePause, CircleStop, Clock, CornerDownRight, FileSearch, Film, Globe, Info, Loader2, MessageCircleQuestion, Monitor, Shapes, Workflow, Wrench } from 'lucide-react'
import { useState } from 'react'
import { api, API, errorText } from '../../lib/api'
import { refreshQueue, useQueuePlace } from '../../lib/devEnvQueue'
import { toast } from '../../store/ui'
import { localizeStep, mediaStepKind, stepPlace } from '@mycel/shared'
import type { Message, Step } from '@mycel/shared/api'
import { useSkillTitle } from '../../lib/skillTitles'
import { useLocale, useT } from '../../i18n'
import { safeHref } from '../../lib/safeLinks'
import { aiName } from '../../lib/tabs'
import { TeamImage } from '../Markdown'
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

/** What a step's mark shows (docs/DECISIONS.md "A failed step the AI got past is not red"). A step that ended in an
 * error is a failure (red) only when the answer itself failed (`answerFailed`: status 'error', an interrupted answer
 * too). While the answer runs, and once it is done or the person stopped it, the AI went on past it: its own trial and
 * error (a file name it guessed wrong, a call it then made another way), shown with a quiet mark, never an alarm. If
 * the running answer then fails, the same step turns red. A step the time limit or Stop cut off says so (paused,
 * stopped); an attached file's note is neither. The step data has no reason code that would say the person must act
 * (a connection to make goes through its card, a usage limit ends the answer as an error), so the answer decides. */
export type StepMark = 'running' | 'note' | 'paused' | 'stopped' | 'failed' | 'retried' | 'done'
export function stepMark(step: Step, o: { live: boolean; answerFailed: boolean }): StepMark {
  if (step.status === 'running' && o.live) return 'running'
  if (step.tool === 'attachment') return 'note'
  if (step.paused) return 'paused'
  if (step.stopped) return 'stopped'
  if (step.status === 'error') return o.answerFailed ? 'failed' : 'retried'
  return 'done'
}

/** The folded list's red "some steps failed" mark: only on a failed answer, for a step that failed (not one the limit
 * or Stop cut off). */
export function showsFailures(steps: Step[], answerFailed: boolean): boolean {
  return answerFailed && steps.some((s) => stepMark(s, { live: false, answerFailed }) === 'failed')
}

/** The waiting state of a dev environment run under its step (only the person of the chat sees the chat). */
function QueueLine({ step }: { step: Step }) {
  const t = useT()
  const locale = useLocale()
  const run = step.devEnvRun!
  // a command's ticket goes with its call: once the step ended there is nothing to watch
  const watching = run.state === 'waiting' && (run.kind === 'job' || step.status === 'running')
  const place = useQueuePlace(watching ? run.id : null)
  const [busy, setBusy] = useState(false)
  if (run.state === 'expired') return <p className="ml-6 px-1 text-xs text-danger" data-testid="devenv-queue-full">{t('devEnvQueue.full')}</p>
  if (run.state === 'cancelled') return <p className="ml-6 px-1 text-xs text-muted" data-testid="devenv-queue-cancelled">{t('devEnvQueue.cancelled')}</p>
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

function StepRow({ step, live, answerFailed, kids = [] }: { step: Step; live: boolean; answerFailed: boolean; kids?: Step[] }) {
  const t = useT()
  const locale = useLocale()
  // the label was written in the language the answer ran in: redraw its words in the language on screen, and the
  // team's well-known folders in words ("브랜드 이미지 폴더 › a.jpg"; the path itself in the tooltip)
  const words = localizeStep(step, locale)
  const place = stepPlace(step, words.label, locale)
  const [open, setOpen] = useState(false)
  const subtask = step.tool === 'agent'
  // a read of a video or an audio file ("Watch video · …") shows a film / sound icon
  const media = step.kind === 'tool' ? mediaStepKind(step) : null
  const Icon = subtask ? Workflow : media === 'video' ? Film : media === 'audio' ? AudioLines : step.kind === 'tool' && step.tool && FILE_TOOLS.has(step.tool) ? FileSearch : ICON[step.kind] ?? Wrench
  const hidden = step.subtask?.hidden ?? 0
  const expandable = !!(step.detail || step.sources?.length || step.images?.length || (subtask && (kids.length || hidden)))
  const mark = stepMark(step, { live, answerFailed })
  const running = mark === 'running'
  // a failure the AI went on past: "트리나가 다른 방법으로 다시 했어요" (still "…찾고 있어요" while it answers)
  const retried = mark === 'retried' ? t(live ? 'steps.retrying' : 'steps.retried', { ai: aiName(t) }) : ''
  const stats = subtask ? subtaskStats(step.subtask, t) : ''
  // cut off by the time limit or by Stop: said in words, not only by the icon
  const cut = running || step.tool === 'attachment' ? '' : step.paused ? t('steps.paused') : step.stopped ? t('steps.stopped') : ''
  // while a sub-agent works, its latest step shows under its row (like Claude Code)
  const latest = subtask && running && !open ? kids[kids.length - 1] : undefined
  // a row that opens is a button; one with nothing to open is not a control (a disabled button would also swallow the
  // pointer, and with it the tooltip of its mark)
  const rowClass = clsx('flex w-full items-center gap-2 rounded px-1 py-0.5 text-left', expandable && 'hover:bg-hover')
  const head = (
    <>
      {running ? <Loader2 size={13} className="shrink-0 animate-spin" aria-label={t('steps.running')} /> : mark === 'note' ? (
        // what happened to an attached team file (changed, moved, unavailable): a note, not a success or a failure
        <Info size={13} className="shrink-0 text-faint" aria-hidden />
      ) : mark === 'paused' ? (
        <CirclePause size={13} className="shrink-0 text-muted" aria-hidden data-testid="step-paused" />
      ) : mark === 'stopped' ? (
        <CircleStop size={13} className="shrink-0 text-muted" aria-hidden data-testid="step-stopped" />
      ) : mark === 'retried' ? (
        <Tooltip label={retried}>
          <CornerDownRight size={13} className="shrink-0 text-faint" aria-label={retried} role="img" data-testid="step-retried" />
        </Tooltip>
      ) : mark === 'failed' ? <CircleAlert size={13} className="shrink-0 text-danger" aria-label={t('steps.failed')} data-testid="step-failed" /> : <Check size={13} className="shrink-0 text-ok" aria-label={t('steps.done')} />}
      <Icon size={13} className="shrink-0 text-faint" aria-hidden />
      <span className="min-w-0 flex-1 truncate" title={place.path}>{place.label}</span>
      {cut ? <span className="shrink-0 text-xs text-muted" data-testid="step-cut">{cut}</span> : null}
      {step.sources?.length ? <span className="shrink-0 text-xs text-faint">{t('steps.results', { n: step.sources.length })}</span> : null}
      {stats ? <span className="shrink-0 text-xs text-faint" data-testid="subtask-stats">{stats}</span> : null}
      {expandable && (open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />)}
    </>
  )
  return (
    <li className="text-label text-muted" {...(subtask ? { 'data-testid': 'subtask', 'data-step-id': step.id } : {})}>
      {expandable ? (
        <button type="button" aria-expanded={open} aria-label={subtask ? `${words.label}${cut ? ` · ${cut}` : ''} · ${t('steps.subtaskShow')}` : undefined} onClick={() => setOpen((v) => !v)} className={rowClass}>
          {head}
        </button>
      ) : (
        <div className={rowClass}>{head}</div>
      )}
      {step.devEnvRun && <QueueLine step={step} />}
      {latest && (
        <ul className="ml-6 border-l border-line pl-3" data-testid="subtask-latest">
          <StepRow key={latest.id} step={latest} live={live} answerFailed={answerFailed} />
        </ul>
      )}
      {open && subtask && (
        <ul className="mt-1 mb-2 ml-6 space-y-0.5 border-l border-line pl-3" data-testid="subtask-steps">
          {hidden > 0 && <li className="px-1 text-xs text-faint">{t('steps.subtaskHidden', { n: hidden })}</li>}
          {kids.map((k) => <StepRow key={k.id} step={k} live={live} answerFailed={answerFailed} />)}
        </ul>
      )}
      {open && !subtask && (
        <div className="mt-1 mb-2 ml-6 space-y-1.5 border-l border-line pl-3">
          {words.detail && <p className="text-xs whitespace-pre-wrap text-muted">{words.detail}</p>}
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
          {step.images?.map((im) => <TeamImage key={im.path} path={im.path} alt={im.alt} className="max-h-56 rounded border border-line" />)}
        </div>
      )}
    </li>
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

/** A demo server's replayed answer (server/src/demo/replay.ts) carries this step: not a step of the work, but one small
 * line in the opened list ("데모용으로 미리 준비한 결과예요"), never counted, never in the live tail. */
export const DEMO_REPLAY_STEP = 'demo_replay'

/** `failed`: the answer itself failed (Message.status 'error'): only then is a failed step red (stepMark). */
export default function Steps({ steps: all, streaming, failed = false, receipt }: { steps: Step[]; streaming: boolean; failed?: boolean; receipt?: Message['receipt'] }) {
  const t = useT()
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  // a demo server's replayed answer: its note is no step of the work (shown in the opened list only)
  const note = all.find((s) => s.tool === DEMO_REPLAY_STEP)
  const steps = note ? all.filter((s) => s !== note) : all
  // a team skill on team files, once the answer is done
  const rec = !streaming && receipt && receipt.teamFiles > 0 ? receipt : null
  const skill = useSkillTitle(rec?.skill.path ?? null, rec?.skill.name ?? '')
  // a skill someone else made ("S"): "김지훈님의 팀 스킬 '견적서 쓰기' · 팀 파일 1개"
  const receiptText = rec ? (rec.skill.by ? t('steps.receiptBy', { by: rec.skill.by, skill, n: rec.teamFiles }) : t('steps.receipt', { skill, n: rec.teamFiles })) : null
  if (!steps.length) return receiptText ? <p className="mb-3 px-1 text-label text-faint" data-testid="steps-receipt">{receiptText}</p> : null
  const { top, kids } = groupSteps(steps)
  // images the AI chose to show (shared browser screenshots) stay visible even when the list is folded
  const shown = steps.flatMap((s) => (s.kind === 'browser' ? s.images ?? [] : []))
  if (streaming) {
    const tail = top.slice(-4)
    return (
      <ul className="mb-3 space-y-0.5" aria-label={t('steps.label')} data-testid="steps">
        {top.length > tail.length && <li className="px-1 text-xs text-faint">{t('steps.earlier', { n: top.length - tail.length })}</li>}
        {tail.map((s) => (
          <StepRow key={s.id} step={s} live answerFailed={failed} kids={kids.get(s.id)} />
        ))}
      </ul>
    )
  }
  return (
    <div className="mb-3" data-testid="steps">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="touch-hit flex items-center gap-1 rounded px-1 py-0.5 text-label text-faint hover:bg-hover hover:text-ink">
        {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        {receiptText ? <span data-testid="steps-receipt">{receiptText}</span> : t('steps.summary', { n: top.length })}
        {showsFailures(steps, failed) && <CircleAlert size={13} className="text-danger" aria-label={t('steps.someFailed')} data-testid="steps-failed" />}
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5" aria-label={t('steps.label')}>
          {note && <li className="px-1 text-xs text-faint" data-testid="demo-replay-note">{localizeStep(note, locale).label}</li>}
          {top.map((s) => (
            <StepRow key={s.id} step={s} live={false} answerFailed={failed} kids={kids.get(s.id)} />
          ))}
        </ul>
      )}
      {/* a queued job outlives the answer: its place in line stays in view while the list is folded */}
      {!open && steps.filter((s) => s.devEnvRun?.kind === 'job' && s.devEnvRun.state === 'waiting').map((s) => <QueueLine key={s.id} step={s} />)}
      {!open && shown.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-2">
          {shown.map((im) => (
            <TeamImage key={im.path} path={im.path} alt={im.alt} className="max-h-56 rounded border border-line" />
          ))}
        </div>
      )}
    </div>
  )
}
