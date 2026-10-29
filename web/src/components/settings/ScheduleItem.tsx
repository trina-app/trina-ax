// One row of Settings › Scheduled tasks. A finished or expired one-time task keeps its switch visible but disabled,
// with the reason next to it (aria-describedby), instead of a "Resume" that does nothing. The last run's result
// (succeeded / finished with problems / failed) is shown with the result link (server/src/chat/schedule-outcome.ts).
import { Trash2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Schedule } from '@mycel/shared/api'
import { formatDateTime } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { Badge, Button } from '../ui'

type Tone = 'muted' | 'warn' | 'danger'
/** How a last-run result reads: a clean success stays quiet, problems and failures stand out. */
export function outcomeTone(o: Schedule['lastOutcome']): Tone {
  if (o === 'problems') return 'warn'
  if (o === 'error' || o === 'stopped' || o === 'interrupted' || o === 'budget_exceeded' || o === 'user_unavailable') return 'danger'
  return 'muted'
}
const toneCls: Record<Tone, string> = { muted: 'text-muted', warn: 'text-warn', danger: 'text-danger' }

export function ScheduleItem({ s, tz, when, onToggle, onRemove }: { s: Schedule; tz: string | null; when: string; onToggle: () => void; onRemove: () => void }) {
  const t = useT(), locale = useLocale()
  const blocked = !s.enabled ? s.resumeBlockedReason ?? null : null
  const hintId = `schedule-${s.id}-blocked`
  return (
    <li className="flex items-start gap-3 px-4 py-3 text-sm" data-testid="schedule-item">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 font-medium">
          {s.templateId === 'daily-file-index' || s.templateId === 'weekly-summary' ? t(`scheduleTemplates.${s.templateId}`) : s.title}
          {!s.enabled && <Badge>{t(blocked ? `schedules.${blocked}` : 'schedules.paused')}</Badge>}
        </span>
        <span className="mt-0.5 block text-xs text-muted">{when}</span>
        <span className="mt-1 line-clamp-2 block text-xs text-faint">{s.templateId ? `${s.sourcePath} → ${s.outputPath}` : s.prompt}</span>
        {blocked && <span id={hintId} className="mt-1 block text-xs text-muted" data-testid="schedule-blocked-hint">{t(`schedules.${blocked}Hint`)}</span>}
        {s.pendingDueAt && <span className="mt-1 block text-xs text-muted">{t('scheduleTemplates.deferred', { time: formatDateTime(s.retryAt ?? s.pendingDueAt, locale, tz || undefined) })}</span>}
        {s.lastOutcome && <span className={`mt-1 block text-xs ${toneCls[outcomeTone(s.lastOutcome)]}`} data-testid="schedule-outcome" data-outcome={s.lastOutcome}>{t(`scheduleTemplates.outcome.${s.lastOutcome}`)}</span>}
        <span className="mt-1 block text-xs text-faint">
          {s.enabled && s.nextRunAt && t('schedules.next', { time: formatDateTime(s.nextRunAt, locale, tz || undefined) })}
          {s.lastChatId && (
            <>
              {s.enabled && s.nextRunAt && ' · '}
              <Link to={`/c/${s.lastChatId}`} className="text-accent-text hover:underline"
                title={s.lastOutcome ? t(`scheduleTemplates.outcome.${s.lastOutcome}`) : undefined}>{t('schedules.lastRun')}</Link>
            </>
          )}
        </span>
      </span>
      <Button size="sm" disabled={!!blocked} aria-describedby={blocked ? hintId : undefined} onClick={blocked ? undefined : onToggle}>
        {s.enabled ? t('schedules.pause') : t('schedules.resume')}
      </Button>
      <button type="button" aria-label={t('schedules.delete')} title={t('schedules.delete')} className="rounded p-1 text-faint hover:bg-hover hover:text-danger" onClick={onRemove}>
        <Trash2 size={15} />
      </button>
    </li>
  )
}
