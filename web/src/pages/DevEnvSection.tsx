// Dev environment section of a project (EXPERIMENT, docs/DECISIONS.md "Dev environment (experiment)"). Hidden when the
// server answers 404 (the feature flag is off). Admins turn it on after the warning; people who can write the folder
// see the box; people who can read it open previews and see the activity.
import { Play, RotateCcw, Square, TerminalSquare } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DevEnvActivity, DevEnvProjectResponse, Group, Project } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { formatRelative } from '../lib/format'
import { useLocale, useT } from '../i18n'
import { toast } from '../store/ui'
import { Badge, Button, Field, Modal, inputCls } from '../components/ui'

export function DevEnvSection({ project }: { project: Project }) {
  const t = useT()
  const locale = useLocale()
  const [d, setD] = useState<DevEnvProjectResponse | null>(null)
  const [hidden, setHidden] = useState(false)
  const [activity, setActivity] = useState<DevEnvActivity[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [editing, setEditing] = useState(false)
  const [port, setPort] = useState('5173')
  const [busy, setBusy] = useState(false)

  const load = () =>
    api.call(API.devEnv, { params: { id: project.id } }).then(
      (x) => {
        setD(x)
        api.call(API.devEnvActivity, { params: { id: project.id } }).then((r) => setActivity(r.items.slice(0, 15)), () => setActivity([]))
      },
      (e) => (isApiError(e, 'not_found') ? setHidden(true) : setD(null)),
    )
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])
  useEffect(() => {
    if (d?.mayManage) api.call(API.listGroups).then((r) => setGroups(r.items), () => setGroups([]))
  }, [d?.mayManage])

  if (hidden || !d) return null
  const on = d.setting.enabled && d.setting.consent?.warningVersion === d.warningVersion
  const fail = (e: unknown) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
  const box = async (action: 'stop' | 'restart') => {
    setBusy(true)
    try { setD(await api.call(API.devEnvBox, { params: { id: project.id }, body: { action } })) } catch (e) { fail(e) } finally { setBusy(false) }
  }
  const preview = async () => {
    try {
      const r = await api.call(API.devEnvPreview, { params: { id: project.id }, body: { port: Number(port) } })
      window.open(r.url, '_blank', 'noopener,noreferrer')
    } catch (e) { fail(e) }
  }
  const stateLabel = d.box ? t(`devEnv.state.${d.box.state}`) : t('devEnv.state.none')

  return (
    <section aria-labelledby="pj-devenv">
      <h2 id="pj-devenv" className="mb-2 flex items-center justify-between gap-2 text-sm font-semibold">
        <span className="flex items-center gap-1.5">
          <TerminalSquare size={15} className="text-accent-text" aria-hidden /> {t('devEnv.title')} <Badge tone="warn">{t('devEnv.experiment')}</Badge>
        </span>
        {d.mayManage && (
          <button type="button" className="text-xs font-normal text-accent-text hover:underline" onClick={() => setEditing(true)}>
            {t('common.edit')}
          </button>
        )}
      </h2>
      <div className="space-y-3 rounded-xl border border-line bg-surface p-3 text-sm">
        {!d.availability.available && <p className="text-faint">{t('devEnv.unavailable')}</p>}
        <p className="flex items-center gap-2">
          <Badge tone={on ? 'ok' : 'neutral'}>{on ? t('devEnv.on') : t('devEnv.off')}</Badge>
          {on && <span className="text-faint">{d.mayUse ? t('devEnv.youCanUse') : t('devEnv.readOnly')}</span>}
        </p>
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
              <Button size="sm" onClick={() => void preview()} disabled={Number(port) < 1024}><Play size={13} aria-hidden /> {t('devEnv.openPreview')}</Button>
            </div>
          </>
        )}
        {activity.length > 0 && (
          <div>
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
      {editing && <DevEnvForm project={project} d={d} groups={groups} onClose={() => setEditing(false)} onSaved={(x) => { setD(x); setEditing(false); void load() }} />}
    </section>
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
  const save = async () => {
    setBusy(true)
    try {
      onSaved(await api.call(API.updateDevEnv, { params: { id: project.id }, body: { enabled, scope: { mode, groupIds: mode === 'selected' ? groupIds : [], userIds: [] }, network, ...(needsWarning && accept ? { acceptWarning: d.warningVersion } : {}) } }))
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally { setBusy(false) }
  }
  return (
    <Modal open onClose={onClose} title={t('devEnv.title')} width={520}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} disabled={needsWarning && !accept} onClick={() => void save()}>{t('common.save')}</Button></>}>
      <div className="space-y-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {t('devEnv.turnOn')}</label>
        <fieldset className="space-y-1">
          <legend className="mb-1 font-medium">{t('devEnv.who')}</legend>
          <label className="flex items-center gap-2"><input type="radio" checked={mode === 'writers'} onChange={() => setMode('writers')} /> {t('devEnv.scopeWriters')}</label>
          <label className="flex items-center gap-2"><input type="radio" checked={mode === 'selected'} onChange={() => setMode('selected')} /> {t('devEnv.scopeSelected')}</label>
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
            <option value="open">{t('devEnv.netOpen')}</option>
            <option value="offline">{t('devEnv.netOffline')}</option>
          </select>
        </Field>
        {needsWarning && (
          <div className="rounded-lg border border-warn/40 bg-warn/10 p-3">
            <p className="mb-2 font-medium">{t('devEnv.warningTitle')}</p>
            <p className="mb-2 whitespace-pre-line text-xs">{t('devEnv.warningBody')}</p>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} /> {t('devEnv.accept')}</label>
          </div>
        )}
      </div>
    </Modal>
  )
}
