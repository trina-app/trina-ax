// A scheduled task the AI made (schedule_create, `Step.scheduled`) in the one card frame of what the AI did for the
// person (ActionCard.tsx). Do then undo (docs/decisions/20261123-do-then-undo.md): a task asked for in the person's own
// words is made without its card, so this card says it was made, when it first runs, and offers Pause and Delete (the
// Scheduled page's own routes). Only the person whose turn it was gets the record (ChatStore.viewSteps).
import { useState } from 'react'
import { API, type Step } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { api, errorText } from '../../lib/api'
import { formatShortDateTime } from '../../lib/format'
import { Button } from '../ui'
import { ActionCard, ActionNote } from './ActionCard'

export default function ScheduledCard({ scheduled }: { scheduled: NonNullable<Step['scheduled']> }) {
  const t = useT()
  const locale = useLocale()
  const [state, setState] = useState<'on' | 'paused' | 'deleted'>('on')
  const [busy, setBusy] = useState<'pause' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (what: 'pause' | 'resume' | 'delete') => {
    setBusy(what === 'delete' ? 'delete' : 'pause')
    setError(null)
    try {
      if (what === 'delete') { await api.call(API.deleteSchedule, { params: { id: scheduled.id } }); setState('deleted') }
      else { await api.call(API.updateSchedule, { params: { id: scheduled.id }, body: { enabled: what === 'resume' } }); setState(what === 'resume' ? 'on' : 'paused') }
    } catch (e) {
      setError(errorText(e, locale, t('scheduledCard.failed')))
    } finally { setBusy(null) }
  }
  const title = state === 'deleted' ? t('scheduledCard.deleted', { title: scheduled.title }) : state === 'paused' ? t('scheduledCard.paused', { title: scheduled.title }) : t('scheduledCard.made', { title: scheduled.title })
  const next = state === 'on' && scheduled.nextRunAt ? t('scheduledCard.next', { when: formatShortDateTime(scheduled.nextRunAt, locale) }) : null
  const footer = state === 'deleted' ? undefined : (
    <>
      {error && <span role="alert" className="mr-auto text-xs break-keep text-danger" data-testid="scheduled-card-error">{error}</span>}
      <Button size="sm" variant="ghost" busy={busy === 'pause'} disabled={busy !== null} onClick={() => void run(state === 'paused' ? 'resume' : 'pause')} data-testid="scheduled-card-pause">{state === 'paused' ? t('scheduledCard.resume') : t('scheduledCard.pause')}</Button>
      <Button size="sm" variant="secondary" busy={busy === 'delete'} disabled={busy !== null} onClick={() => void run('delete')} data-testid="scheduled-card-delete">{t('common.delete')}</Button>
    </>
  )
  return (
    <ActionCard title={title} label={title} testId="scheduled-card" state={state} kind="schedule" footer={footer}>
      {next && <ActionNote testId="scheduled-card-next">{next}</ActionNote>}
    </ActionCard>
  )
}
