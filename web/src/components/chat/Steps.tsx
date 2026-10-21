// What the AI did while answering ("파일 검색 중", web search, browser, artifacts): a compact list under the answer.
// While streaming the last few steps show; afterwards it folds into "작업 N단계" that opens on click.
// Web search results are plain links (no favicons: an external image would load by itself).
import clsx from 'clsx'
import { Brain, Check, ChevronDown, ChevronRight, CircleAlert, FileSearch, Globe, Loader2, MessageCircleQuestion, Monitor, Shapes, Wrench } from 'lucide-react'
import { useState } from 'react'
import { localizeStep } from '@mycel/shared'
import type { Step } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { safeHref } from '../../lib/safeLinks'
import { TeamImage } from '../Markdown'

const ICON = { tool: Wrench, thinking: Brain, web_search: Globe, browser: Monitor, artifact: Shapes, ask_user: MessageCircleQuestion } as const
const FILE_TOOLS = new Set(['read', 'grep', 'glob', 'list', 'write', 'edit'])

function StepRow({ step, live }: { step: Step; live: boolean }) {
  const t = useT()
  // the label was written in the language the answer ran in: redraw its words in the language on screen
  const words = localizeStep(step, useLocale())
  const [open, setOpen] = useState(false)
  const Icon = step.kind === 'tool' && step.tool && FILE_TOOLS.has(step.tool) ? FileSearch : ICON[step.kind]
  const expandable = !!(step.detail || step.sources?.length || step.images?.length)
  const running = step.status === 'running' && live
  return (
    <li className="text-[13px] text-muted">
      <button type="button" disabled={!expandable} aria-expanded={expandable ? open : undefined} onClick={() => setOpen((v) => !v)} className={clsx('flex w-full items-center gap-2 rounded px-1 py-0.5 text-left', expandable && 'hover:bg-hover')}>
        {running ? <Loader2 size={13} className="shrink-0 animate-spin" aria-label={t('steps.running')} /> : step.status === 'error' ? <CircleAlert size={13} className="shrink-0 text-danger" aria-label={t('steps.failed')} /> : <Check size={13} className="shrink-0 text-ok" aria-label={t('steps.done')} />}
        <Icon size={13} className="shrink-0 text-faint" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{words.label}</span>
        {step.sources?.length ? <span className="shrink-0 text-xs text-faint">{t('steps.results', { n: step.sources.length })}</span> : null}
        {expandable && (open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />)}
      </button>
      {open && (
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

export default function Steps({ steps, streaming }: { steps: Step[]; streaming: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  if (!steps.length) return null
  // images the AI chose to show (shared browser screenshots) stay visible even when the list is folded
  const shown = steps.flatMap((s) => (s.kind === 'browser' ? s.images ?? [] : []))
  if (streaming) {
    const tail = steps.slice(-4)
    return (
      <ul className="mb-3 space-y-0.5" aria-label={t('steps.label')} data-testid="steps">
        {steps.length > tail.length && <li className="px-1 text-xs text-faint">{t('steps.earlier', { n: steps.length - tail.length })}</li>}
        {tail.map((s) => (
          <StepRow key={s.id} step={s} live />
        ))}
      </ul>
    )
  }
  return (
    <div className="mb-3" data-testid="steps">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 rounded px-1 py-0.5 text-[13px] text-faint hover:bg-hover hover:text-ink">
        {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        {t('steps.summary', { n: steps.length })}
        {steps.some((s) => s.status === 'error') && <CircleAlert size={13} className="text-danger" aria-label={t('steps.someFailed')} />}
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5" aria-label={t('steps.label')}>
          {steps.map((s) => (
            <StepRow key={s.id} step={s} live={false} />
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
