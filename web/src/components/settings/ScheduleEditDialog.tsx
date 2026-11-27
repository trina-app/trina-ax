// "수정" of a scheduled task (Settings › Scheduled tasks). A free-text task: its title, instruction, schedule and the
// project it runs in; "Check and save" asks the server for the same schedule card as when the AI creates a task
// (server/src/chat/schedule-edit.ts: the whole instruction, its addresses, an address with a long query listed apart,
// the "allow" connections), shown here in place of the form, and only an answer on that card saves. "Don't change"
// comes back to the form. The save folder (where runs put new files without asking, server/src/chat/schedule-scope.ts)
// can be another folder or none, and the places whose content may go there can be taken away (×); the card shows them
// as they will be. A template: its time (and weekday) and folders, saved directly (checked like at creation).
import { useEffect, useRef, useState } from 'react'
import { ChevronRight, X } from 'lucide-react'
import clsx from 'clsx'
import type { Project, Schedule, ScheduleReviewCard, ScheduleTaskEdit } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../../lib/api'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { zoneDay } from '../../lib/format'
import { intervalUnit, sourceName } from '../../lib/scheduleText'
import { useTeamPlace } from '../../lib/teamPlace'
import { useMeStrict } from '../../store/session'
import AskCard from '../chat/AskCard'
import FolderPicker from '../FolderPicker'
import { Button, ErrorNote, Field, IconButton, Modal, inputCls } from '../ui'

const REPEATS = ['once', 'daily', 'weekdays', 'weekly', 'monthly', 'interval', 'cron'] as const
const UNITS = { minutes: 1, hours: 60, days: 1440 } as const
type Unit = keyof typeof UNITS
/** the days of the week in the order the week is read (Monday first; 0 = Sunday last) */
const WEEK = [1, 2, 3, 4, 5, 6, 0]

/** The form's fields (every kind's, so switching the repeat keeps what was picked). */
export interface TaskForm {
  title: string; prompt: string; repeat: Schedule['repeat']; time: string
  /** weekly: one or more days (0 = Sunday) */
  weekdays: number[]
  day: number | 'last'; date: string
  /** interval: every `every` `unit` */
  every: number; unit: Unit
  cron: string
  projectId: string
}

/** The form's fields as the server takes them (only the fields the repeat uses are sent). `save`: the save folder (null:
 * none) and the keys of the places kept, for a task that has or gets one. */
export function taskEdit(f: TaskForm, save?: { folder: string | null; sources: string[] }): ScheduleTaskEdit {
  const days = [...new Set(f.weekdays)].sort((a, b) => a - b)
  return {
    kind: 'task', title: f.title, prompt: f.prompt, repeat: f.repeat, time: f.repeat === 'cron' ? '' : f.time,
    weekday: f.repeat === 'weekly' && days.length === 1 ? days[0]! : null,
    weekdays: f.repeat === 'weekly' && days.length > 1 ? days : null,
    day: f.repeat === 'monthly' ? f.day : null,
    date: f.repeat === 'once' || f.repeat === 'interval' ? f.date : null,
    everyMinutes: f.repeat === 'interval' ? Math.max(1, Math.round(f.every)) * UNITS[f.unit] : null,
    cron: f.repeat === 'cron' ? f.cron.trim() : null,
    projectId: f.projectId || null,
    ...(save ? { saveFolder: save.folder, saveSources: save.sources } : {}),
  }
}

/** A task as the form starts: its own fields, and a sensible value for each kind it does not use. */
export function formOf(s: Schedule, today: string): TaskForm {
  const every = intervalUnit(s.everyMinutes ?? 60)
  return {
    title: s.title, prompt: s.prompt, repeat: s.repeat, time: s.repeat === 'cron' ? '09:00' : s.time,
    weekdays: s.weekdays?.length ? s.weekdays : [s.weekday ?? 1], day: s.day ?? 1, date: s.date ?? today,
    every: every.n, unit: every.unit, cron: s.cron ?? '0 9 * * 1-5', projectId: s.projectId ?? '',
  }
}

/** Can the form be checked: a title, an instruction, and what its repeat needs. */
export function formReady(f: TaskForm): boolean {
  if (!f.title.trim() || f.prompt.trim().length < 3) return false
  if (f.repeat === 'cron') return f.cron.trim().split(/\s+/).length === 5 || f.cron.trim().startsWith('@')
  if (!f.time) return false
  if (f.repeat === 'weekly') return f.weekdays.length > 0
  if (f.repeat === 'interval') return Number.isFinite(f.every) && f.every >= 1
  return true
}

export function ScheduleEditDialog({ s, tz, onClose, onSaved }: { s: Schedule; tz: string | null; onClose: () => void; onSaved: (s: Schedule) => void }) {
  return s.templateId ? <TemplateEdit s={s} tz={tz} onClose={onClose} onSaved={onSaved} /> : <TaskEdit s={s} tz={tz} onClose={onClose} onSaved={onSaved} />
}

const fieldErr = (e: unknown, name: string) => (isApiError(e) ? e.body.fields?.[`body.${name}`] ?? null : null)

function TaskEdit({ s, tz, onClose, onSaved }: { s: Schedule; tz: string | null; onClose: () => void; onSaved: (s: Schedule) => void }) {
  const t = useT(), locale = useLocale()
  const place = useTeamPlace()
  const [f, setF] = useState<TaskForm>(() => formOf(s, zoneDay(new Date(), tz)))
  const [projects, setProjects] = useState<Project[] | null>(null)
  // the save folder and its places: only taking places away here (the AI adds them when it makes the task)
  const [saveFolder, setSaveFolder] = useState<string | null>(s.saveFolder ?? null)
  const [kept, setKept] = useState<string[]>((s.saveSources ?? []).map((x) => x.key))
  const [picking, setPicking] = useState(false)
  const hadSave = !!s.saveFolder || !!s.saveSources?.length
  const [card, setCard] = useState<{ body: ScheduleTaskEdit; card: ScheduleReviewCard } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [note, setNote] = useState<string | null>(null)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    api.call(API.listProjects).then((r) => { if (live.current) setProjects(r.items) }, () => { if (live.current) setProjects([]) })
    return () => { live.current = false }
  }, [])
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => { setF((x) => ({ ...x, [k]: v })); setNote(null) }
  const weekdayShort = (n: number) => new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + n)))
  const check = async () => {
    const body = taskEdit(f, hadSave || saveFolder ? { folder: saveFolder, sources: kept } : undefined)
    setBusy(true); setError(null); setNote(null)
    try {
      const c = await api.call(API.scheduleEditCard, { params: { id: s.id }, body })
      if (live.current) setCard({ body, card: c })
    } catch (e) {
      if (live.current) setError(e)
    } finally {
      if (live.current) setBusy(false)
    }
  }
  // an answer on the card: "cancel" comes back to the form; a card that changed meanwhile is shown anew
  const answer = async (requestId: string, value: string | null) => {
    if (!card) return
    if (!value || value === 'cancel') { setCard(null); setNote(t('schedules.notChanged')); return }
    try {
      const saved = await api.call(API.editSchedule, { params: { id: s.id }, body: { ...card.body, requestId, answer: value } })
      onSaved(saved)
    } catch (e) {
      if (isApiError(e, 'conflict') && e.body.params?.reason === 'schedule_card_changed') {
        const fresh = await api.call(API.scheduleEditCard, { params: { id: s.id }, body: card.body })
        if (live.current) setCard({ body: card.body, card: fresh })
      }
      throw e
    }
  }
  const footer = card
    ? <Button variant="ghost" onClick={() => setCard(null)} data-testid="schedule-edit-back">{t('schedules.backToEdit')}</Button>
    : <>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" busy={busy} disabled={!formReady(f)} onClick={() => void check()} data-testid="schedule-edit-check">{t('schedules.check')}</Button>
      </>
  return (
    <Modal open onClose={onClose} title={t('schedules.editTitle')} width={600} footer={footer}>
      {card ? (
        <div data-testid="schedule-edit-card">
          <AskCard key={card.card.request.requestId} req={card.card} onAnswer={(requestId, body) => answer(requestId, body.kind === 'ask_user' ? (Array.isArray(body.answer) ? body.answer[0] ?? null : body.answer) : null)} />
        </div>
      ) : (
        <form className="space-y-4" data-testid="schedule-edit-form" onSubmit={(e) => { e.preventDefault(); void check() }}>
          {error != null && <ErrorNote>{errorText(error, locale, t('error.network'))}</ErrorNote>}
          {note && <p role="status" className="rounded-lg bg-subtle px-3 py-2 text-sm text-muted" data-testid="schedule-edit-note">{note}</p>}
          <Field label={t('schedules.field.title')} error={fieldErr(error, 'title')}>
            <input className={inputCls} value={f.title} maxLength={80} onChange={(e) => set('title', e.target.value)} data-testid="schedule-edit-title" />
          </Field>
          <Field label={t('schedules.field.prompt')} hint={t('schedules.field.promptHint')} error={fieldErr(error, 'prompt')}>
            <textarea className={`${inputCls} h-auto min-h-32 resize-y py-2 max-md:resize-none`} rows={6} value={f.prompt} maxLength={4000} onChange={(e) => set('prompt', e.target.value)} data-testid="schedule-edit-prompt" />
          </Field>
          <div className="flex flex-wrap gap-3">
            {/* a phone: the repeat on its own row, so its longer kinds are read in full */}
            <div className="min-w-40 flex-1 max-sm:basis-full">
              <Field label={t('schedules.field.repeat')} error={fieldErr(error, 'repeat')}>
                <select className={inputCls} value={f.repeat} onChange={(e) => set('repeat', e.target.value as Schedule['repeat'])} data-testid="schedule-edit-repeat">
                  {REPEATS.map((r) => <option key={r} value={r}>{t(`schedules.repeatOpt.${r}` as MessageKey)}</option>)}
                </select>
              </Field>
            </div>
            {f.repeat === 'monthly' && (
              <div className="min-w-40 flex-1">
                <Field label={t('schedules.field.day')} error={fieldErr(error, 'day')}>
                  <select className={inputCls} value={String(f.day)} onChange={(e) => set('day', e.target.value === 'last' ? 'last' : Number(e.target.value))} data-testid="schedule-edit-day">
                    {Array.from({ length: 31 }, (_, i) => <option key={i} value={i + 1}>{t('schedules.dayOpt', { n: i + 1 })}</option>)}
                    <option value="last">{t('schedules.dayLast')}</option>
                  </select>
                </Field>
              </div>
            )}
            {f.repeat === 'once' && (
              <div className="min-w-40 flex-1">
                <Field label={t('schedules.field.date')} error={fieldErr(error, 'date')}>
                  <input type="date" className={inputCls} value={f.date} onChange={(e) => set('date', e.target.value)} data-testid="schedule-edit-date" />
                </Field>
              </div>
            )}
            {/* its own row under the repeat and the start time: the number and the unit side by side stay readable on a phone */}
            {f.repeat === 'interval' && (
              <div className="order-last basis-full">
                <Field label={t('schedules.field.every')} error={fieldErr(error, 'everyMinutes')}>
                  <div className="grid max-w-sm grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
                    <input type="number" inputMode="numeric" min={1} step={1} className={inputCls} value={Number.isFinite(f.every) ? f.every : ''} onChange={(e) => set('every', e.target.valueAsNumber)} aria-label={t('schedules.field.everyCount')} data-testid="schedule-edit-every" />
                    <select className={inputCls} value={f.unit} onChange={(e) => set('unit', e.target.value as Unit)} aria-label={t('schedules.field.everyUnit')} data-testid="schedule-edit-unit">
                      {(Object.keys(UNITS) as Unit[]).map((u) => <option key={u} value={u}>{t(`schedules.unit.${u}` as MessageKey)}</option>)}
                    </select>
                  </div>
                </Field>
              </div>
            )}
            {f.repeat !== 'cron' && (
              <div className="min-w-32 flex-1">
                <Field label={t(f.repeat === 'interval' ? 'schedules.field.startTime' : 'schedules.field.time')} error={fieldErr(error, 'time')}>
                  <input type="time" required className={inputCls} value={f.time} onChange={(e) => set('time', e.target.value)} data-testid="schedule-edit-time" />
                </Field>
              </div>
            )}
          </div>
          {f.repeat === 'weekly' && (
            <Field label={t('schedules.field.weekdays')} error={fieldErr(error, 'weekday') ?? fieldErr(error, 'weekdays')}>
              {/* a phone: the seven days in one row of equal cells (44 px tall to tap) */}
              <div className="grid grid-cols-7 gap-1 sm:flex sm:flex-wrap sm:gap-1.5" role="group" aria-label={t('schedules.field.weekdays')} data-testid="schedule-edit-weekdays">
                {WEEK.map((d) => {
                  const on = f.weekdays.includes(d)
                  return (
                    <button key={d} type="button" aria-pressed={on} onClick={() => set('weekdays', on ? f.weekdays.filter((x) => x !== d) : [...f.weekdays, d])}
                      className={clsx('inline-flex h-11 min-w-0 items-center justify-center rounded-full border text-sm font-medium sm:h-9 sm:min-w-11 sm:px-3', on ? 'border-ink bg-ink text-canvas' : 'border-field-border text-muted hover:bg-hover hover:text-ink')}
                      data-testid={`schedule-edit-weekday-${d}`}>{weekdayShort(d)}</button>
                  )
                })}
              </div>
            </Field>
          )}
          {f.repeat === 'cron' && (
            <Field label={t('schedules.field.cron')} hint={t('schedules.field.cronHint')} error={fieldErr(error, 'cron')}>
              <input className={`${inputCls} font-mono`} value={f.cron} maxLength={200} spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(e) => set('cron', e.target.value)} data-testid="schedule-edit-cron" />
            </Field>
          )}
          <Field label={t('schedules.field.project')} hint={t('schedules.field.projectHint')} error={fieldErr(error, 'projectId')}>
            <select className={inputCls} value={f.projectId} onChange={(e) => set('projectId', e.target.value)} disabled={projects === null} data-testid="schedule-edit-project">
              <option value="">{t('schedules.noProject')}</option>
              {/* a project the list no longer has stays selectable, so the form does not change it silently */}
              {f.projectId && projects && !projects.some((p) => p.id === f.projectId) && <option value={f.projectId}>{f.projectId}</option>}
              {(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label={t('schedules.field.saveFolder')} hint={t('schedules.field.saveFolderHint')} error={fieldErr(error, 'saveFolder')}>
            <div className="flex min-w-0 items-center gap-1" data-testid="schedule-edit-save-folder">
              {/* a phone: a value row with a chevron (it opens the folder picker), not an outline button */}
              <Button onClick={() => setPicking(true)} className="min-w-0 truncate max-md:min-h-11 max-md:flex-1 max-md:justify-between max-md:border-transparent max-md:bg-subtle" data-testid="schedule-edit-save-pick"><span className="truncate" title={saveFolder ?? undefined}>{saveFolder ? place(saveFolder) : t('schedules.saveFolderPick')}</span><ChevronRight size={16} className="shrink-0 text-faint md:hidden" aria-hidden /></Button>
              {saveFolder ? (
                <IconButton label={t('schedules.removeSaveFolder')} onClick={() => { setSaveFolder(null); setNote(null) }} data-testid="schedule-edit-save-remove"><X size={14} /></IconButton>
              ) : <span className="text-xs text-faint">{t('schedules.saveFolderNoneFiles')}</span>}
            </div>
          </Field>
          {saveFolder && !!s.saveSources?.length && (
            <Field label={t('schedules.field.saveSources')} error={fieldErr(error, 'saveSources')}>
              <ul className="flex flex-wrap gap-1.5" data-testid="schedule-edit-save-sources">
                {(s.saveSources ?? []).filter((x) => kept.includes(x.key)).map((x) => (
                  <li key={x.key} className="inline-flex max-w-full items-center gap-0.5 rounded-full bg-subtle py-0.5 pr-0.5 pl-2.5 text-sm" data-testid="schedule-edit-save-source">
                    <span className="truncate">{sourceName(x, t, place)}</span>
                    <IconButton label={t('schedules.removeSource', { name: sourceName(x, t, place) })} compact className="p-0.5" onClick={() => { setKept((k) => k.filter((y) => y !== x.key)); setNote(null) }}><X size={13} /></IconButton>
                  </li>
                ))}
              </ul>
            </Field>
          )}
          {tz && <p className="text-xs text-faint">{t('schedules.timeZone', { tz })}</p>}
          <p className="text-xs text-muted">{t('schedules.checkHint')}</p>
          <button type="submit" hidden aria-hidden tabIndex={-1} />
        </form>
      )}
      <FolderPicker open={picking} title={t('schedules.field.saveFolder')} confirmLabel={t('scheduleTemplates.select')} initial={saveFolder ?? 'shared'} needWrite allowCreate={false} onClose={() => setPicking(false)} onPick={(p) => { setSaveFolder(p); setPicking(false); setNote(null) }} />
    </Modal>
  )
}

function TemplateEdit({ s, tz, onClose, onSaved }: { s: Schedule; tz: string | null; onClose: () => void; onSaved: (s: Schedule) => void }) {
  const t = useT(), locale = useLocale(), me = useMeStrict()
  const privateRoot = `users/${me.user.id}`
  const weekly = s.repeat === 'weekly'
  const [time, setTime] = useState(s.time), [weekday, setWeekday] = useState(s.weekday ?? 1)
  const [source, setSource] = useState(s.sourcePath ?? ''), [output, setOutput] = useState(s.outputPath ?? `${privateRoot}/reports`)
  const [picker, setPicker] = useState<'source' | 'output' | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null)
  const dayName = (n: number) => new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + n)))
  const save = async () => {
    setBusy(true); setError(null)
    try {
      onSaved(await api.call(API.editSchedule, { params: { id: s.id }, body: { kind: 'template', time, weekday: weekly ? weekday : null, sourcePath: source, outputPath: output } }))
    } catch (e) {
      setError(e); setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={t('schedules.editTitle')} width={520} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
      <Button variant="primary" busy={busy} disabled={!source || !time} onClick={() => void save()} data-testid="schedule-edit-save">{t('common.save')}</Button>
    </>}>
      <div className="space-y-4" data-testid="schedule-edit-template">
        {error != null && <ErrorNote>{errorText(error, locale, t('error.network'))}</ErrorNote>}
        <div><p className="mb-1 text-sm">{t('scheduleTemplates.source')}</p><Button onClick={() => setPicker('source')} data-testid="schedule-edit-source">{source || t('scheduleTemplates.chooseSource')}</Button></div>
        <div><p className="mb-1 text-sm">{t('scheduleTemplates.output')}</p><Button onClick={() => setPicker('output')} data-testid="schedule-edit-output">{output}</Button></div>
        <div className="flex flex-wrap gap-3">
          <Field label={t('scheduleTemplates.time')} error={fieldErr(error, 'time')}><input type="time" required className={inputCls} value={time} onChange={(e) => setTime(e.target.value)} data-testid="schedule-edit-time" /></Field>
          {weekly && <Field label={t('scheduleTemplates.weekday')} error={fieldErr(error, 'weekday')}><select className={inputCls} value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} data-testid="schedule-edit-weekday">{Array.from({ length: 7 }, (_, i) => <option key={i} value={i}>{dayName(i)}</option>)}</select></Field>}
        </div>
        {tz && <p className="text-xs text-faint">{t('schedules.timeZone', { tz })}</p>}
      </div>
      <FolderPicker open={picker !== null} title={t(picker === 'output' ? 'scheduleTemplates.output' : 'scheduleTemplates.source')} confirmLabel={t('scheduleTemplates.select')} initial={picker === 'output' ? privateRoot : source} needWrite={picker === 'output'} allowCreate={false} selectableRoot={picker === 'output' ? privateRoot : undefined} onClose={() => setPicker(null)} onPick={(path) => { if (picker === 'output') setOutput(path); else setSource(path); setPicker(null) }} />
    </Modal>
  )
}
