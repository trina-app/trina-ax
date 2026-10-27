// Team settings: name, default language, update channel and window, retention periods.
import { useEffect, useState } from 'react'
import type { Locale, TeamSettings } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { LOCALES, useT } from '../../i18n'
import { isOwner, useMeStrict, useSession } from '../../store/session'
import { Button, Field, inputCls } from '../../components/ui'
import { Card, Loadable, useAction, useLoad } from './common'
import { timeZoneOptions } from '../../lib/time-zones'

export default function TeamSettingsPage() {
  const t = useT()
  const me = useMeStrict()
  const signedIn = useSession((s) => s.signedIn)
  const act = useAction()
  const state = useLoad(() => api.call(API.settings))
  const [f, setF] = useState<TeamSettings | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (state.data) setF(state.data)
  }, [state.data])
  const num = (k: keyof TeamSettings, min: number, max: number) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => (x ? { ...x, [k]: Math.max(min, Math.min(max, Math.floor(Number(e.target.value) || min))) } : x))
  const windowOk = !f?.updateWindow || /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(f.updateWindow)
  const save = async () => {
    if (!f || !state.data) return
    setBusy(true)
    const changed = Object.fromEntries(Object.entries(f).filter(([k, v]) => state.data![k as keyof TeamSettings] !== v))
    const r = await act(() => api.call(API.updateSettings, { body: changed }), t('common.saved'))
    setBusy(false)
    if (r) state.setData(r)
    // people who follow the team default (maybe this admin) now see the new language: refresh the own view at once
    if (r && changed.defaultLocale) await api.call(API.me).then(signedIn, () => {})
  }
  return (
    <Loadable state={state}>
      {() =>
        f && (
          <Card title={t('admin.settings')}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('setup.teamName')} hint={isOwner(me) ? t('teamSettings.nameHint') : t('teamSettings.nameOwnerOnly')}>
                <input className={inputCls} value={f.teamName} disabled={!isOwner(me)} onChange={(e) => setF({ ...f, teamName: e.target.value })} maxLength={100} />
              </Field>
              <Field label={t('teamSettings.defaultLocale')} hint={t('teamSettings.defaultLocaleHint')}>
                <select className={inputCls} value={f.defaultLocale} onChange={(e) => setF({ ...f, defaultLocale: e.target.value as Locale })} data-testid="team-default-locale">
                  {LOCALES.map((l) => (
                    <option key={l.id} value={l.id} lang={l.id}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('teamSettings.timeZone')} hint={t('teamSettings.timeZoneHint')}>
                <select className={inputCls} value={f.timeZone} onChange={(e) => setF({ ...f, timeZone: e.target.value })} data-testid="team-time-zone">
                  {timeZoneOptions(f.timeZone).map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('teamSettings.updateChannel')}>
                <select className={inputCls} value={f.updateChannel} onChange={(e) => setF({ ...f, updateChannel: e.target.value as TeamSettings['updateChannel'] })}>
                  <option value="stable">{t('teamSettings.stable')}</option>
                  <option value="beta">{t('teamSettings.beta')}</option>
                </select>
              </Field>
              <Field label={t('teamSettings.updateWindow')} hint={t('teamSettings.updateWindowHint')} error={windowOk ? null : t('teamSettings.updateWindowBad')}>
                <input className={inputCls} placeholder="02:00-05:00" value={f.updateWindow ?? ''} onChange={(e) => setF({ ...f, updateWindow: e.target.value.trim() || null })} />
              </Field>
              <Field label={t('teamSettings.auditDays')}>
                <input className={inputCls} type="number" min={7} max={3650} value={f.auditRetentionDays} onChange={num('auditRetentionDays', 7, 3650)} />
              </Field>
              <Field label={t('teamSettings.historyDays')}>
                <input className={inputCls} type="number" min={1} max={3650} value={f.fileHistoryRetentionDays} onChange={num('fileHistoryRetentionDays', 1, 3650)} />
              </Field>
              <Field label={t('teamSettings.trashDays')}>
                <input className={inputCls} type="number" min={1} max={365} value={f.trashRetentionDays} onChange={num('trashRetentionDays', 1, 365)} />
              </Field>
              <Field label={t('teamSettings.chatTrashDays')}>
                <input className={inputCls} type="number" min={1} max={365} value={f.chatTrashRetentionDays} onChange={num('chatTrashRetentionDays', 1, 365)} />
              </Field>
            </div>
            <Button variant="primary" className="mt-4" busy={busy} disabled={!windowOk || !f.teamName.trim()} onClick={save}>
              {t('common.save')}
            </Button>
          </Card>
        )
      }
    </Loadable>
  )
}
