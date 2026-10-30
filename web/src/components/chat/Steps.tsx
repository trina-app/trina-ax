// What the AI did while answering ("파일 검색 중", web search, browser, artifacts): a compact list under the answer.
// While streaming the last few steps show; afterwards it folds into "작업 N단계" that opens on click.
// Web search results are plain links (no favicons: an external image would load by itself).
// A step the per-answer time limit cut off (Step.paused) shows as paused like the answer, not as a failure; one the
// person's Stop cut off (Step.stopped) shows as stopped, like Claude Code's "Interrupted".
// A sub-task (Claude Code's Agent tool, docs/DECISIONS.md "Sub-agents") is one row like Claude Code's "Agent(...)": its
// sub-agent's steps (Step.parentId) open under it, and while it works its latest step shows beneath it.
import clsx from 'clsx'
import { Brain, Check, ChevronDown, ChevronRight, CircleAlert, CirclePause, CircleStop, FileSearch, Globe, Info, Loader2, MessageCircleQuestion, Monitor, Shapes, Workflow, Wrench } from 'lucide-react'
import { useState } from 'react'
import { localizeStep } from '@mycel/shared'
import type { Step } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { safeHref } from '../../lib/safeLinks'
import { TeamImage } from '../Markdown'

type TFunction = ReturnType<typeof useT>
const ICON = { tool: Wrench, thinking: Brain, web_search: Globe, browser: Monitor, artifact: Shapes, ask_user: MessageCircleQuestion } as const
const FILE_TOOLS = new Set(['read', 'grep', 'glob', 'list', 'write', 'edit'])

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

function StepRow({ step, live, kids = [] }: { step: Step; live: boolean; kids?: Step[] }) {
  const t = useT()
  // the label was written in the language the answer ran in: redraw its words in the language on screen
  const words = localizeStep(step, useLocale())
  const [open, setOpen] = useState(false)
  const subtask = step.tool === 'agent'
  const Icon = subtask ? Workflow : step.kind === 'tool' && step.tool && FILE_TOOLS.has(step.tool) ? FileSearch : ICON[step.kind] ?? Wrench
  const hidden = step.subtask?.hidden ?? 0
  const expandable = !!(step.detail || step.sources?.length || step.images?.length || (subtask && (kids.length || hidden)))
  const running = step.status === 'running' && live
  const stats = subtask ? subtaskStats(step.subtask, t) : ''
  // while a sub-agent works, its latest step shows under its row (like Claude Code)
  const latest = subtask && running && !open ? kids[kids.length - 1] : undefined
  return (
    <li className="text-[13px] text-muted" {...(subtask ? { 'data-testid': 'subtask', 'data-step-id': step.id } : {})}>
      <button type="button" disabled={!expandable} aria-expanded={expandable ? open : undefined} aria-label={subtask && expandable ? `${words.label} · ${t('steps.subtaskShow')}` : undefined}
        onClick={() => setOpen((v) => !v)} className={clsx('flex w-full items-center gap-2 rounded px-1 py-0.5 text-left', expandable && 'hover:bg-hover')}>
        {running ? <Loader2 size={13} className="shrink-0 animate-spin" aria-label={t('steps.running')} /> : step.tool === 'attachment' ? (
          // what happened to an attached team file (changed, moved, unavailable): a note, not a success or a failure
          <Info size={13} className="shrink-0 text-faint" aria-hidden />
        ) : step.paused ? (
          <CirclePause size={13} className="shrink-0 text-muted" aria-label={t('steps.paused')} data-testid="step-paused" />
        ) : step.stopped ? (
          <CircleStop size={13} className="shrink-0 text-muted" aria-label={t('steps.stopped')} data-testid="step-stopped" />
        ) : step.status === 'error' ? <CircleAlert size={13} className="shrink-0 text-danger" aria-label={t('steps.failed')} /> : <Check size={13} className="shrink-0 text-ok" aria-label={t('steps.done')} />}
        <Icon size={13} className="shrink-0 text-faint" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{words.label}</span>
        {step.sources?.length ? <span className="shrink-0 text-xs text-faint">{t('steps.results', { n: step.sources.length })}</span> : null}
        {stats ? <span className="shrink-0 text-xs text-faint" data-testid="subtask-stats">{stats}</span> : null}
        {expandable && (open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />)}
      </button>
      {latest && (
        <ul className="ml-6 border-l border-line pl-3" data-testid="subtask-latest">
          <StepRow key={latest.id} step={latest} live={live} />
        </ul>
      )}
      {open && subtask && (
        <ul className="mt-1 mb-2 ml-6 space-y-0.5 border-l border-line pl-3" data-testid="subtask-steps">
          {hidden > 0 && <li className="px-1 text-xs text-faint">{t('steps.subtaskHidden', { n: hidden })}</li>}
          {kids.map((k) => <StepRow key={k.id} step={k} live={live} />)}
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
                  <span className="ml-1.5 text-[11px] text-faint">{hostOf(s.url)}</span>
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

export default function Steps({ steps, streaming }: { steps: Step[]; streaming: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  if (!steps.length) return null
  const { top, kids } = groupSteps(steps)
  // images the AI chose to show (shared browser screenshots) stay visible even when the list is folded
  const shown = steps.flatMap((s) => (s.kind === 'browser' ? s.images ?? [] : []))
  if (streaming) {
    const tail = top.slice(-4)
    return (
      <ul className="mb-3 space-y-0.5" aria-label={t('steps.label')} data-testid="steps">
        {top.length > tail.length && <li className="px-1 text-xs text-faint">{t('steps.earlier', { n: top.length - tail.length })}</li>}
        {tail.map((s) => (
          <StepRow key={s.id} step={s} live kids={kids.get(s.id)} />
        ))}
      </ul>
    )
  }
  return (
    <div className="mb-3" data-testid="steps">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 rounded px-1 py-0.5 text-[13px] text-faint hover:bg-hover hover:text-ink">
        {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        {t('steps.summary', { n: top.length })}
        {steps.some((s) => s.status === 'error' && !s.paused && !s.stopped) && <CircleAlert size={13} className="text-danger" aria-label={t('steps.someFailed')} data-testid="steps-failed" />}
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5" aria-label={t('steps.label')}>
          {top.map((s) => (
            <StepRow key={s.id} step={s} live={false} kids={kids.get(s.id)} />
          ))}
        </ul>
      )}
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
