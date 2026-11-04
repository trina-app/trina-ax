// "Dev environment" in Team settings (EXPERIMENT, docs/research/srt-dev-env.md 3.2): the team setting devEnv.team
// (GET and PUT /api/admin/dev-env). Hidden when the feature flag is off (Me.server.devEnv) or the API answers 404. On the srt runner the
// setting is the whole team's: on or off, who may use it, network, limits per run, extra sites, and the warning to accept
// when it is turned on. A team with no projects turns it on here (the project page's modal saves the same setting). On
// the box runner each project turns it on in its own settings, so only the extra sites are here. Its own Save: the
// page's Save sends the other team settings to another endpoint.
import { TerminalSquare } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DevEnvTeamResponse, Group } from '@mycel/shared/api'
import { api, API, isApiError } from '../../lib/api'
import { clampLimit, draftOf, limitMax, LIMIT_RANGE, needsWarning, teamBody, type DevEnvTeamDraft, type LimitKey } from '../../lib/dev-env-team'
import { useT } from '../../i18n'
import { Badge, Button, Field, inputCls, Switch } from '../../components/ui'
import { useMeStrict } from '../../store/session'
import { Card, useAction } from './common'
import { GroupChecks } from './people-choices'

/** Only on a server with the experiment on (Me.server.devEnv): a server without it would answer 404. */
export function DevEnvTeamCard() {
  const me = useMeStrict()
  return me.server.devEnv ? <DevEnvTeamForm /> : null
}

function DevEnvTeamForm() {
  const t = useT()
  const act = useAction()
  const [r, setR] = useState<DevEnvTeamResponse | null>(null)
  const [hidden, setHidden] = useState(false)
  const [d, setD] = useState<DevEnvTeamDraft | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [accept, setAccept] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api.call(API.devEnvTeam).then((x) => { setR(x); setD(draftOf(x.setting)) }, (e) => { if (isApiError(e, 'not_found')) setHidden(true) })
    api.call(API.listGroups).then((x) => setGroups(x.items), () => setGroups([]))
  }, [])
  if (hidden || !r || !d) return null
  const srt = r.runner === 'srt'
  const warn = needsWarning(r, d)
  const body = teamBody(r, d, accept)
  const dirty = Object.keys(body).some((k) => k !== 'acceptWarning')
  const save = async () => {
    setBusy(true)
    const x = await act(() => api.call(API.updateDevEnvTeam, { body }), t('common.saved'))
    setBusy(false)
    if (x) { setR(x); setD(draftOf(x.setting)); setAccept(false) }
  }
  const limit = (k: LimitKey, label: string, step: number) => (
    <Field label={label}>
      <input className={inputCls} type="number" min={LIMIT_RANGE[k].min} max={limitMax(k, r.plan)} step={step} value={d[k]} data-testid={`dev-env-team-${k}`}
        onChange={(e) => setD({ ...d, [k]: Number(e.target.value) })} onBlur={() => setD({ ...d, [k]: clampLimit(k, d[k], r.plan) })} />
    </Field>
  )
  const planOffline = !!r.plan && r.plan.network !== 'open'
  return (
    <Card title={<span className="inline-flex items-center gap-2"><TerminalSquare size={16} aria-hidden /> {t('devEnv.title')} <Badge tone="warn">{t('devEnv.experiment')}</Badge></span>}
      desc={t(srt ? 'devEnvTeam.desc' : 'devEnvTeam.descBox')}>
      {/* disabled while a save runs: the form takes the saved setting from the answer, which would erase an edit made
          before the answer came */}
      <fieldset disabled={busy} className="m-0 min-w-0 space-y-4 border-0 p-0 text-sm" data-testid="dev-env-team" data-on={srt && r.setting.enabled ? 'true' : 'false'}>
        {r.availability && !r.availability.available && <p className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs" data-testid="dev-env-team-unavailable">{t('devEnv.unavailable')}</p>}
        {srt && (
          <>
            <Switch checked={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} label={t('devEnvTeam.turnOn')} testId="dev-env-team-enabled" />
            <fieldset className="space-y-1">
              <legend className="mb-1 font-medium">{t('devEnv.who')}</legend>
              <label className="flex items-center gap-2"><input type="radio" name="dev-env-team-scope" checked={d.mode === 'writers'} onChange={() => setD({ ...d, mode: 'writers' })} /> {t('devEnv.scopeEveryoneSrt')}</label>
              <label className="flex items-center gap-2"><input type="radio" name="dev-env-team-scope" checked={d.mode === 'selected'} onChange={() => setD({ ...d, mode: 'selected' })} data-testid="dev-env-team-selected" /> {t('devEnv.scopeSelectedSrt')}</label>
              {d.mode === 'selected' && (
                <div className="ml-6 space-y-1">
                  <GroupChecks groups={groups} value={d.groupIds} onChange={(v) => setD({ ...d, groupIds: v })} />
                  {d.userIds.length > 0 && <p className="text-xs text-faint">{t('devEnvTeam.people', { n: d.userIds.length })}</p>}
                </div>
              )}
            </fieldset>
            <Field label={t('devEnv.network')} hint={planOffline ? t('devEnvTeam.planOffline') : undefined}>
              <select className={inputCls} value={d.network} onChange={(e) => setD({ ...d, network: e.target.value as 'open' | 'offline' })} data-testid="dev-env-team-network">
                <option value="open">{t('devEnv.netAllowlist')}</option>
                <option value="offline">{t('devEnv.netOffline')}</option>
              </select>
            </Field>
            <fieldset>
              <legend className="mb-1 font-medium">{t('devEnvTeam.limits')}</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {limit('cpus', t('devEnvTeam.cpus'), 0.25)}
                {limit('memoryMiB', t('devEnvTeam.memory'), 256)}
                {limit('pids', t('devEnvTeam.pids'), 64)}
                {limit('idleStopMin', t('devEnvTeam.idle'), 5)}
              </div>
              {r.plan && <p className="mt-1 text-xs text-faint" data-testid="dev-env-team-plan">{t('devEnvTeam.planCaps', { cpus: r.plan.cpus, memory: r.plan.memoryMiB, pids: r.plan.pids, running: r.plan.maxRunning })}</p>}
              <p className="mt-1 text-xs text-faint">{t('devEnvTeam.stopNote')}</p>
            </fieldset>
          </>
        )}
        <Field label={t('devEnvTeam.sites')} hint={t('devEnvTeam.sitesHint', { n: r.defaultDomains.length })}>
          <textarea className={inputCls + ' min-h-24 font-mono'} spellCheck={false} value={d.sites} placeholder="api.example.com" onChange={(e) => setD({ ...d, sites: e.target.value })} data-testid="dev-env-team-sites" />
        </Field>
        {warn && (
          <div className="rounded-lg border border-warn/40 bg-warn/10 p-3" data-testid="dev-env-team-warning">
            <p className="mb-2 font-medium">{t('devEnv.warningTitle')}</p>
            <p className="mb-2 whitespace-pre-line text-xs">{t('devEnv.warningBodySrt')}</p>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} data-testid="dev-env-team-accept" /> {t('devEnvTeam.accept')}</label>
          </div>
        )}
        <Button variant="primary" busy={busy} disabled={!dirty || (warn && !accept)} onClick={() => void save()} data-testid="dev-env-team-save">
          {t('common.save')}
        </Button>
      </fieldset>
    </Card>
  )
}
