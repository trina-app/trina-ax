import { useEffect, useRef, useState } from 'react'
import type { CreateScheduleFromTemplate, Schedule } from '@mycel/shared/api'
import { api, API, ApiError, errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { useMeStrict } from '../../store/session'
import FolderPicker from '../FolderPicker'
import { Button, ErrorNote, Field, inputCls } from '../ui'

/** Templates are dormant until the person explicitly chooses folders and creates one. */
export function ScheduleTemplates({ onCreated }: { onCreated: (schedule: Schedule) => void }) {
  const t = useT(), locale = useLocale(), me = useMeStrict()
  const privateRoot = `users/${me.user.id}`
  const [available, setAvailable] = useState<('daily-file-index' | 'weekly-summary')[]>([])
  const [timeZone, setTimeZone] = useState('')
  const [templateId, setTemplateId] = useState<'daily-file-index' | 'weekly-summary'>('daily-file-index')
  const [source, setSource] = useState('')
  const [output, setOutput] = useState(`${privateRoot}/reports`)
  const [time, setTime] = useState('09:00'), [weekday, setWeekday] = useState(1)
  const [picker, setPicker] = useState<'source' | 'output' | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null)
  const [created, setCreated] = useState(false)
  const life = useRef(0), request = useRef<{ input: string; id: string } | null>(null), pending = useRef(false)
  useEffect(() => {
    const generation = ++life.current
    api.call(API.listScheduleTemplates).then(r => {
      if (generation !== life.current) return
      setAvailable(r.items.map(x => x.id)); setTimeZone(r.timeZone)
    }, e => { if (generation === life.current) setError(e) })
    return () => { life.current++ }
    // Locale does not change the server template list or its time zone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const create = async () => {
    if (pending.current || !source || !available.includes(templateId)) return
    const body = { templateId, version: 1 as const, sourcePath: source, outputPath: output, time, ...(templateId === 'weekly-summary' ? { weekday } : {}) }
    const input = JSON.stringify(body)
    // Reuse after a lost response. Changing the form starts a new explicit intent.
    if (request.current?.input !== input) request.current = { input, id: crypto.randomUUID() }
    const generation = life.current
    pending.current = true; setBusy(true); setError(null); setCreated(false)
    try {
      const schedule = await api.call(API.createScheduleFromTemplate, { body: { ...body, requestId: request.current.id } satisfies CreateScheduleFromTemplate })
      if (generation !== life.current) return
      onCreated(schedule); setCreated(true)
    } catch (e) { if (generation === life.current) setError(e) }
    finally { pending.current = false; if (generation === life.current) setBusy(false) }
  }
  const errorMessage = error instanceof ApiError && error.code === 'conflict' && error.body.params?.reason === 'schedule_limit' && typeof error.body.params.limit === 'number'
    ? t('scheduleTemplates.limit', { n: error.body.params.limit })
    : errorText(error, locale, t('error.network'))
  const dayName = (day: number) => new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + day)))
  return <section className="mb-5 space-y-3 rounded-xl border border-line p-4" data-testid="schedule-templates" aria-labelledby="schedule-templates-title">
    <h3 id="schedule-templates-title" className="text-sm font-semibold">{t('scheduleTemplates.title')}</h3>
    <p className="text-xs text-muted">{t('scheduleTemplates.hint')}</p>
    <fieldset disabled={busy} className="space-y-3">
      <Field label={t('scheduleTemplates.template')}><select className={inputCls} value={templateId} onChange={e => { setTemplateId(e.target.value as typeof templateId); setCreated(false) }} data-testid="template-kind">
        {(['daily-file-index', 'weekly-summary'] as const).map(id => <option key={id} value={id}>{t(`scheduleTemplates.${id}`)}</option>)}
      </select></Field>
      <div><p className="mb-1 text-sm">{t('scheduleTemplates.source')}</p><Button onClick={() => setPicker('source')} data-testid="template-source">{source || t('scheduleTemplates.chooseSource')}</Button></div>
      <div><p className="mb-1 text-sm">{t('scheduleTemplates.output')}</p><Button onClick={() => setPicker('output')} data-testid="template-output">{output}</Button></div>
      <div className="flex flex-wrap gap-3">
        <Field label={t('scheduleTemplates.time')}><input type="time" required className={inputCls} value={time} onChange={e => { setTime(e.target.value); setCreated(false) }} data-testid="template-time" /></Field>
        {templateId === 'weekly-summary' && <Field label={t('scheduleTemplates.weekday')}><select className={inputCls} value={weekday} onChange={e => { setWeekday(Number(e.target.value)); setCreated(false) }} data-testid="template-weekday">{Array.from({ length: 7 }, (_, i) => <option key={i} value={i}>{dayName(i)}</option>)}</select></Field>}
      </div>
      {timeZone && <p className="text-xs text-muted">{t('schedules.timeZone', { tz: timeZone })}</p>}
      <p className="text-xs text-muted">{t('scheduleTemplates.cost')}</p>
      <Button variant="primary" busy={busy} disabled={!source || !time || !available.includes(templateId) || created} onClick={create} data-testid="template-create">{t('scheduleTemplates.create')}</Button>
    </fieldset>
    {error != null && <ErrorNote>{errorMessage}</ErrorNote>}
    {created && <p role="status" className="text-sm text-accent-text">{t('scheduleTemplates.created')}</p>}
    <FolderPicker open={picker !== null} title={t(picker === 'output' ? 'scheduleTemplates.output' : 'scheduleTemplates.source')} confirmLabel={t('scheduleTemplates.select')} initial={picker === 'output' ? privateRoot : source} needWrite={picker === 'output'} allowCreate={false} selectableRoot={picker === 'output' ? privateRoot : undefined} onClose={() => setPicker(null)} onPick={path => { if (picker === 'output') setOutput(path); else setSource(path); setPicker(null); setCreated(false) }} />
  </section>
}
