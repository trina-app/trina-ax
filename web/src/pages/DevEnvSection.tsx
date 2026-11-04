// Dev environment line of a project's page (EXPERIMENT, docs/DECISIONS.md "Dev environment (experiment)"). Hidden when
// the server answers 404 (the feature flag is off). Closed, it says whether it is on and how the box is; opened, the
// box, its jobs, the preview and the activity. On the srt runner (the response asks for warning version 2) there is no
// box: the page lists the runs of this project's chats (commands, jobs, dev servers) and the jobs that wait in the
// queue, each with Stop. On srt the setting is the team's (any chat can use it), so the settings modal saves the team
// setting. Admins turn it on after the warning; people who can write the folder see the box; people who can read it
// open previews and see the activity.
import { Play, RotateCcw, Square, TerminalSquare } from 'lucide-react'
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { DEV_ENV_SRT_WARNING_VERSION, type DevEnvActivity, type DevEnvProjectResponse, type DevEnvRun, type Group, type Project } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { formatRelative } from '../lib/format'
import { useLocale, useT } from '../i18n'
import { toast } from '../store/ui'
import { Badge, Button, Field, Modal, inputCls } from '../components/ui'
import { DisclosureRow } from '../components/DisclosureRow'

export function DevEnvRow({ project }: { project: Project }) {
  const t = useT()
  const locale = useLocale()
  const [d, setD] = useState<DevEnvProjectResponse | null>(null)
  const [hidden, setHidden] = useState(false)
  const [activity, setActivity] = useState<DevEnvActivity[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [editing, setEditing] = useState(false)
  const [port, setPort] = useState('5173')
  const [busy, setBusy] = useState(false)

  // a failed read keeps what the page shows: a server that restarts must not end the poll or close an open form
  const load = () =>
    api.call(API.devEnv, { params: { id: project.id } }).then(
      (x) => {
        setD(x)
        api.call(API.devEnvActivity, { params: { id: project.id } }).then((r) => setActivity(r.items.slice(0, 15)), () => {})
      },
      (e) => { if (isApiError(e, 'not_found')) setHidden(true) },
    )
  useEffect(() => {
    setD(null)
    setActivity([])
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])
  // a running job's last log line is its progress: the page follows it while one runs, and looks less often for a job
  // that a chat starts while this page is open
  const pollMs = hidden ? 0 : d?.jobs.length || d?.runs.running.length || d?.runs.waiting.length ? 10_000 : d?.setting.enabled && (d.mayUse || d.mayManage) ? 30_000 : 0
  useEffect(() => {
    if (!pollMs) return
    const timer = setInterval(() => void load(), pollMs)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollMs, project.id])
  useEffect(() => {
    if (d?.mayManage) api.call(API.listGroups).then((r) => setGroups(r.items), () => setGroups([]))
  }, [d?.mayManage])

  if (hidden || !d) return null
  const on = d.setting.enabled && d.setting.consent?.warningVersion === d.warningVersion
  const srt = d.warningVersion === DEV_ENV_SRT_WARNING_VERSION
  const fail = (e: unknown) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
  const box = async (action: 'stop' | 'restart') => {
    setBusy(true)
    try { setD(await api.call(API.devEnvBox, { params: { id: project.id }, body: { action } })) } catch (e) { fail(e); void load() } finally { setBusy(false) }
  }
  const stopRun = async (r: DevEnvRun) => {
    setBusy(true)
    try { setD(await api.call(API.devEnvRunStop, { params: { id: project.id, runId: r.id } })) } catch (e) { fail(e); void load() } finally { setBusy(false) }
  }
  const preview = async () => {
    try {
      const r = await api.call(API.devEnvPreview, { params: { id: project.id }, body: { port: Number(port) } })
      window.open(r.url, '_blank', 'noopener,noreferrer')
    } catch (e) { fail(e) }
  }
  const stateLabel = d.box ? t(`devEnv.state.${d.box.state}`) : t('devEnv.state.none')
  const stopped = !!d.box && d.box.state !== 'running' && (d.box.stopCode === 'disk' || d.box.stopCode === 'busy_max')
  // closed, the line says the one thing to know: off, or how the box is
  const status = !on ? t('devEnv.off') : srt ? (d.runs.running.length ? t('devEnv.running') : t('devEnv.on')) : d.box && d.box.state !== 'none' ? stateLabel : t('devEnv.on')
  const mayStop = d.mayUse || d.mayManage

  return (
    <>
      <DisclosureRow
        testId="dev-env"
        icon={<TerminalSquare size={16} />}
        label={t('devEnv.title')}
        badge={<Badge tone="warn">{t('devEnv.experiment')}</Badge>}
        meta={<span className={clsx('block first-letter:uppercase', (stopped || !d.availability.available) && 'text-warn', on && (d.box?.state === 'running' || (srt && d.runs.running.length > 0)) && 'text-ok')}>{status}</span>}
      >
        <div className="space-y-3">
          {!d.availability.available && <p className="text-faint">{t('devEnv.unavailable')}</p>}
          {(on || d.mayManage) && (
            <p className="flex items-start gap-2">
              <span className="min-w-0 flex-1 text-xs text-faint">{on && (d.mayUse ? t(srt ? 'devEnv.youCanUseSrt' : 'devEnv.youCanUse') : t('devEnv.readOnly'))}</span>
              {d.mayManage && (
                <button type="button" className="inline-flex min-h-6 shrink-0 items-center rounded-md px-2 text-xs text-muted hover:bg-hover hover:text-ink" onClick={() => setEditing(true)} data-testid="dev-env-edit">
                  {t('common.edit')}
                </button>
              )}
            </p>
          )}
          {on && srt && (
            <>
              <RunList testId="dev-env-running" title={t('devEnv.running')} runs={d.runs.running} busy={busy} onStop={mayStop ? (r) => void stopRun(r) : null} stopLabel={t('devEnv.stop')} />
              <RunList testId="dev-env-waiting" title={t('devEnv.waiting')} runs={d.runs.waiting} busy={busy} onStop={mayStop ? (r) => void stopRun(r) : null} stopLabel={t('devEnv.cancel')} />
              <p className="text-xs text-faint">{t('devEnv.noPreview')}</p>
            </>
          )}
          {on && d.box && (
            <>
              <p className="flex flex-wrap items-center gap-2">
                <span>{t('devEnv.box', { state: stateLabel })}</span>
                {d.box.memoryMiB !== null && <span className="text-xs text-faint">{t('devEnv.memory', { n: Math.round(d.box.memoryMiB) })}</span>}
                {(d.mayUse || d.mayManage) && d.box.state === 'running' && (
                  <span className="ml-auto flex gap-1">
                    <Button size="sm" variant="ghost" busy={busy} onClick={() => void box('restart')}><RotateCcw size={13} aria-hidden /> {t('devEnv.restart')}</Button>
                    <Button size="sm" variant="ghost" busy={busy} onClick={() => void box('stop')}><Square size={13} aria-hidden /> {t('devEnv.stop')}</Button>
                  </span>
                )}
              </p>
              {stopped && (
                <p className="rounded-lg border border-warn/40 bg-warn/10 p-2 text-xs" data-testid="dev-env-stop-reason">{t(`devEnv.stopped.${d.box.stopCode as 'disk' | 'busy_max'}`)}</p>
              )}
              {d.jobs.length > 0 && (
                <div data-testid="dev-env-jobs">
                  <p className="mb-1 text-xs font-medium">{t('devEnv.jobs')}</p>
                  <ul className="space-y-0.5 text-xs">
                    {d.jobs.map((j) => (
                      <li key={j.id} className="flex gap-2">
                        <span className="shrink-0 font-mono">{j.name}</span>
                        <span className="shrink-0 text-faint">{formatRelative(j.startedAt, locale)}</span>
                        <span className="min-w-0 truncate font-mono text-faint" title={j.lastLine}>{j.lastLine}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {d.box.processes.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium">{t('devEnv.processes')}</p>
                  <ul className="space-y-0.5 font-mono text-xs text-faint">
                    {d.box.processes.slice(0, 8).map((p) => <li key={p.pid} className="truncate" title={p.command}>{p.command}</li>)}
                  </ul>
                </div>
              )}
              <div className="flex items-end gap-2">
                <Field label={t('devEnv.port')}>
                  <input className={inputCls + ' w-24'} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} />
                </Field>
                <Button size="sm" onClick={() => void preview()} disabled={Number(port) < 1024} data-testid="dev-env-preview"><Play size={13} aria-hidden /> {t('devEnv.openPreview')}</Button>
              </div>
            </>
          )}
          {activity.length > 0 && (
            <div data-testid="dev-env-activity">
              <p className="mb-1 text-xs font-medium">{t('devEnv.activity')}</p>
              <ul className="space-y-0.5 text-xs">
                {activity.map((a, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="shrink-0 text-faint">{formatRelative(a.at, locale)}</span>
                    <span className="shrink-0">{a.by?.name ?? '—'}</span>
                    <span className={'min-w-0 truncate' + (a.kind === 'command' ? ' font-mono' : '')} title={a.text}>{a.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </DisclosureRow>
      {editing && <DevEnvForm project={project} d={d} groups={groups} onClose={() => setEditing(false)} onSaved={(x) => { setD(x); setEditing(false); void load() }} />}
    </>
  )
}

function DevEnvForm({ project, d, groups, onClose, onSaved }: { project: Project; d: DevEnvProjectResponse; groups: Group[]; onClose: () => void; onSaved: (x: DevEnvProjectResponse) => void }) {
  const t = useT()
  const locale = useLocale()
  const [enabled, setEnabled] = useState(d.setting.enabled)
  const [mode, setMode] = useState(d.setting.scope.mode)
  const [groupIds, setGroupIds] = useState<string[]>(d.setting.scope.groupIds)
  const [network, setNetwork] = useState(d.setting.network)
  const [accept, setAccept] = useState(false)
  const [busy, setBusy] = useState(false)
  const needsWarning = enabled && d.setting.consent?.warningVersion !== d.warningVersion
  const srt = d.warningVersion === DEV_ENV_SRT_WARNING_VERSION
  const save = async () => {
    setBusy(true)
    try {
      // the people chosen by name in Team settings stay (this form edits groups only)
      const body = { enabled, scope: { mode, groupIds: mode === 'selected' ? groupIds : [], userIds: mode === 'selected' ? d.setting.scope.userIds : [] }, network, ...(needsWarning && accept ? { acceptWarning: d.warningVersion } : {}) }
      // srt: one setting for the whole team (any chat, with or without a project); the page then reads it again
      if (srt) { await api.call(API.updateDevEnvTeam, { body }); onSaved(await api.call(API.devEnv, { params: { id: project.id } })) }
      else onSaved(await api.call(API.updateDevEnv, { params: { id: project.id }, body }))
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally { setBusy(false) }
  }
  return (
    <Modal open onClose={onClose} title={t('devEnv.title')} width={520}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} disabled={needsWarning && !accept} onClick={() => void save()}>{t('common.save')}</Button></>}>
      <div className="space-y-4 text-sm">
        {srt && <p className="text-xs text-muted" data-testid="dev-env-team-wide">{t('devEnv.teamWideSrt')}</p>}
        <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {t('devEnv.turnOn')}</label>
        <fieldset className="space-y-1">
          <legend className="mb-1 font-medium">{t('devEnv.who')}</legend>
          <label className="flex items-center gap-2"><input type="radio" checked={mode === 'writers'} onChange={() => setMode('writers')} /> {t(srt ? 'devEnv.scopeEveryoneSrt' : 'devEnv.scopeWriters')}</label>
          <label className="flex items-center gap-2"><input type="radio" checked={mode === 'selected'} onChange={() => setMode('selected')} /> {t(srt ? 'devEnv.scopeSelectedSrt' : 'devEnv.scopeSelected')}</label>
          {mode === 'selected' && (
            <div className="ml-6 flex flex-wrap gap-x-4 gap-y-1">
              {groups.map((g) => (
                <label key={g.id} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={groupIds.includes(g.id)} onChange={(e) => setGroupIds(e.target.checked ? [...groupIds, g.id] : groupIds.filter((x) => x !== g.id))} /> {g.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <Field label={t('devEnv.network')}>
          <select className={inputCls} value={network} onChange={(e) => setNetwork(e.target.value as 'open' | 'offline')}>
            <option value="open">{t(srt ? 'devEnv.netAllowlist' : 'devEnv.netOpen')}</option>
            <option value="offline">{t('devEnv.netOffline')}</option>
          </select>
        </Field>
        <p className="text-xs text-faint">{t(srt ? 'devEnv.diskNoteSrt' : 'devEnv.diskNote')}</p>
        {enabled && d.needsFolder && <p className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs">{t('devEnv.needsFolder')}</p>}
        {needsWarning && (
          <div className="rounded-lg border border-warn/40 bg-warn/10 p-3">
            <p className="mb-2 font-medium">{t('devEnv.warningTitle')}</p>
            <p className="mb-2 whitespace-pre-line text-xs">{t(srt ? 'devEnv.warningBodySrt' : 'devEnv.warningBody')}</p>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} /> {t('devEnv.accept')}</label>
          </div>
        )}
      </div>
    </Modal>
  )
}

/** srt runner: what runs now, or what waits in the queue (position 1 starts next). Stop on a waiting one cancels it. */
function RunList({ testId, title, runs, busy, onStop, stopLabel }: { testId: string; title: string; runs: DevEnvRun[]; busy: boolean; onStop: ((r: DevEnvRun) => void) | null; stopLabel: string }) {
  const t = useT()
  const locale = useLocale()
  if (!runs.length) return null
  return (
    <div data-testid={testId}>
      <p className="mb-1 text-xs font-medium">{title}</p>
      <ul className="space-y-1 text-xs">
        {runs.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5" data-testid="dev-env-run">
            <span className="shrink-0 text-faint">{r.position !== null ? t('devEnv.position', { n: r.position }) : t(`devEnv.kind.${r.kind}`)}</span>
            <span className="min-w-0 max-w-[16rem] truncate font-mono" title={r.name}>{r.name}</span>
            <span className="shrink-0 text-faint">{r.by?.name ?? '—'} · {formatRelative(r.runAt ?? r.startedAt, locale)}</span>
            {r.memoryMiB !== null && <span className="shrink-0 text-faint">{t('devEnv.memory', { n: Math.round(r.memoryMiB) })}</span>}
            {onStop && (
              <Button size="sm" variant="ghost" className="ml-auto" busy={busy} onClick={() => onStop(r)} data-testid="dev-env-run-stop"><Square size={13} aria-hidden /> {stopLabel}</Button>
            )}
            {r.lastLine && <span className="basis-full truncate font-mono text-faint" title={r.lastLine}>{r.lastLine}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
