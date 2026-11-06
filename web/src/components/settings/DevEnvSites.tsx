// Settings > Dev environment sites (srt runner, docs/DECISIONS.md "Dev environment: sites a person allows"): the sites
// this person allowed "always" from a chat's site card, with Remove, and her own Full internet switch (off by default;
// turning it on asks first, with the warning). Only her own commands use them. With the team's No network there is
// nothing to allow: the section says so and shows nothing else. The dialog shows this section only while the server
// says the dev environment is on for her (GET /api/dev-env/sites state is not 'off').
import { Globe, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DevEnvMySites } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { toast } from '../../store/ui'
import { ErrorNote, IconButton, Skeleton, Switch, confirmDialog } from '../ui'

export function DevEnvSites() {
  const t = useT()
  const locale = useLocale()
  const [r, setR] = useState<DevEnvMySites | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = () => api.call(API.myDevEnvSites).then((x) => { setR(x); setError(null) }, (e) => setError(errorText(e, locale, t('error.network'))))
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const act = async (fn: () => Promise<DevEnvMySites>) => {
    setBusy(true)
    try { setR(await fn()) } catch (e) { toast({ level: 'error', text: errorText(e, locale, t('error.network')) }) } finally { setBusy(false) }
  }
  const remove = async (host: string) => {
    if (!await confirmDialog({ title: t('devEnvSites.removeTitle', { host }), body: t('devEnvSites.removeBody'), confirm: t('devEnvSites.removeConfirm'), danger: true })) return
    await act(() => api.call(API.removeMyDevEnvSite, { body: { host } }))
  }
  const full = async (on: boolean) => {
    if (!r) return
    if (on) {
      const ok = await confirmDialog({
        title: t('devEnvSites.fullTitle'),
        body: <div className="space-y-2" data-testid="dev-env-full-warning"><p className="font-semibold text-danger">{t('devEnvSites.fullWarning')}</p><p>{t('devEnvSites.fullWarningMore')}</p></div>,
        confirm: t('devEnvSites.fullTurnOn'), danger: true,
      })
      if (!ok) return
    }
    await act(() => api.call(API.setMyDevEnvFullInternet, { body: on ? { on, acceptWarning: r.fullWarningVersion } : { on } }))
  }

  return (
    <section className="space-y-5" data-testid="dev-env-sites">
      <div>
        <h2 className="text-base font-semibold">{t('settings.devEnvSites')}</h2>
        <p className="mt-1 text-sm text-muted">{t('devEnvSites.intro')}</p>
      </div>
      {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
      {!r && !error && <Skeleton lines={3} />}
      {r?.state === 'no_network' && <p className="rounded-xl border border-line p-4 text-sm" data-testid="dev-env-sites-no-network">{t('devEnvSites.noNetwork')}</p>}
      {r?.state === 'on' && (
        <>
          <div>
            <h3 className="mb-2 text-sm font-semibold">{t('devEnvSites.mine', { count: r.sites.length, max: r.maxSites })}</h3>
            {!r.sites.length && <p className="text-sm text-muted" data-testid="dev-env-sites-empty">{t('devEnvSites.empty')}</p>}
            <ul className="divide-y divide-line" data-testid="dev-env-sites-list">
              {r.sites.map((s) => (
                <li key={s.host} className="flex items-center gap-3 py-2" data-testid="dev-env-site">
                  <Globe size={16} className="shrink-0 text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="break-all font-mono text-sm">{s.host}</p>
                    <p className="text-xs text-faint">{formatDateTime(s.createdAt, locale)}</p>
                  </div>
                  <IconButton label={t('devEnvSites.remove', { host: s.host })} disabled={busy} onClick={() => void remove(s.host)} data-testid="dev-env-site-remove">
                    <Trash2 size={16} />
                  </IconButton>
                </li>
              ))}
            </ul>
          </div>
          {r.fullAvailable && (
            <div className="space-y-2 rounded-xl border border-line p-4" data-testid="dev-env-full">
              <div className="flex items-center gap-3">
                <label htmlFor="dev-env-full-switch" className="flex-1 text-sm font-medium">{t('devEnvSites.full')}</label>
                <Switch id="dev-env-full-switch" external checked={r.fullInternet} disabled={busy} label={t('devEnvSites.full')} onChange={(v) => void full(v)} testId="dev-env-full-switch" />
              </div>
              <p className="text-xs text-muted">{t('devEnvSites.fullHint')}</p>
              {r.fullInternet && <p role="status" className="rounded-lg bg-warn-soft px-3 py-2 text-xs font-medium text-warn" data-testid="dev-env-full-on">{t('devEnvSites.fullOn')}</p>}
            </div>
          )}
          <details className="text-sm">
            <summary className="cursor-pointer text-muted">{t('devEnvSites.team')}</summary>
            <ul className="mt-2 space-y-0.5 font-mono text-xs text-faint" data-testid="dev-env-team-sites">
              {r.teamSites.map((h) => <li key={h} className="break-all">{h}</li>)}
            </ul>
          </details>
        </>
      )}
    </section>
  )
}
