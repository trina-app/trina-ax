// Team settings: name, default language, update channel and window, retention periods, whether people may turn on
// "Allow all websites" in the desktop app's in-app browser (each team decides; the desktop app enforces it), whether
// members may add their own external-service connections (Settings > External services), and the team logo (the tab
// icon and the home-screen app icon; shared/src/team-icon.ts).
import { useEffect, useRef, useState } from 'react'
import { RotateCcw, Upload } from 'lucide-react'
import { teamIconUrl, TEAM_ICON_TYPES } from '@mycel/shared'
import { TeamSettings, type Locale } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { LOCALES, useLocale, useT } from '../../i18n'
import { isOwner, useMeStrict, useSession } from '../../store/session'
import { toast } from '../../store/ui'
import { Button, confirmDialog, Field, inputCls, Switch } from '../../components/ui'
import { Card, Loadable, useAction, useLoad } from './common'
import { timeZoneOptions } from '../../lib/time-zones'
import { checkIconFile } from '../../lib/team-icon'

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
  const windowOk = TeamSettings.shape.updateWindow.safeParse(f?.updateWindow).success
  const save = async () => {
    if (!f || !state.data || !windowOk) return
    setBusy(true)
    const changed = Object.fromEntries(Object.entries(f).filter(([k, v]) => state.data![k as keyof TeamSettings] !== v))
    const r = await act(() => api.call(API.updateSettings, { body: changed }), t('common.saved'))
    setBusy(false)
    if (r) state.setData(r)
    // people who follow the team default (maybe this admin) now see the new language: refresh the own view at once
    if (r && changed.defaultLocale) await api.call(API.me).then(signedIn, () => {})
  }
  return (
    <>
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
                <BrowserPolicySwitch value={f.browserAllowAll} onChange={(v) => setF({ ...f, browserAllowAll: v })} />
                <PersonalIntegrationsSwitch value={f.personalIntegrations} onChange={(v) => setF({ ...f, personalIntegrations: v })} />
              </div>
              <Button variant="primary" className="mt-4" busy={busy} disabled={!windowOk || !f.teamName.trim()} onClick={save}>
                {t('common.save')}
              </Button>
            </Card>
          )
        }
      </Loadable>
      <TeamIconCard />
    </>
  )
}

/**
 * The team logo: the tab icon of everyone's browser, the sign-in page's icon and the home-screen app icon. Uploaded
 * at once when chosen (PNG, JPEG or WebP; checked here first, the server checks again), removed back to the default
 * mark. Previews at the sizes browsers and phones show it, on a light and a dark background.
 */
export function TeamIconCard() {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const refreshMe = useSession((s) => s.refreshMe)
  const version = me.team.iconVersion ?? null
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const upload = async (file: File) => {
    setError(null)
    const ok = await checkIconFile(file)
    if (!ok.ok) return setError(t(`teamIcon.problem.${ok.problem}`))
    setBusy('upload')
    try {
      await api.call(API.putTeamIcon, { query: { type: ok.type }, body: file })
      await refreshMe()
      toast({ level: 'success', text: t('teamIcon.saved') })
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(null)
    }
  }
  const remove = async () => {
    if (!(await confirmDialog({ title: t('teamIcon.removeTitle'), body: t('teamIcon.removeBody'), confirm: t('teamIcon.removeConfirm'), danger: true }))) return
    setError(null)
    setBusy('remove')
    try {
      await api.call(API.deleteTeamIcon)
      await refreshMe()
      toast({ level: 'success', text: t('teamIcon.removed') })
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(null)
    }
  }

  // what each place shows: the logo at every size, or the default mark (the SVG in tabs, the home-screen PNG)
  const tabSrc = version ? teamIconUrl(version) : '/favicon.svg'
  const homeSrc = version ? teamIconUrl(version) : '/icons/apple-touch-icon.png'
  return (
    <Card title={t('teamIcon.title')} desc={t('teamIcon.desc')}>
      <div data-testid="team-icon" data-version={version ?? ''}>
        <p className="text-sm" data-testid="team-icon-status">
          {version ? t('teamIcon.custom') : t('teamIcon.default')}
        </p>
        <h3 className="mt-3 text-xs font-medium text-muted">{t('teamIcon.preview')}</h3>
        <div className="mt-2 flex flex-wrap gap-3">
          {(['light', 'dark'] as const).map((scheme) => (
            <figure key={scheme} className="m-0" data-testid={`team-icon-preview-${scheme}`}>
              <div
                className={`flex flex-wrap items-end gap-4 rounded-xl border p-3 ${scheme === 'light' ? 'border-[#d9d6cf] bg-[#ffffff]' : 'border-[#3a3835] bg-[#1f1e1c]'}`}
              >
                {[16, 32].map((n) => (
                  <div key={n} className="flex flex-col items-center gap-1.5">
                    <img src={tabSrc} alt="" width={n} height={n} style={{ width: n, height: n }} className="object-contain" data-testid={`team-icon-img-${n}`} />
                    <span className={`text-[11px] ${scheme === 'light' ? 'text-[#4a4743]' : 'text-[#c9c5bd]'}`}>{t('teamIcon.sizeTab', { n })}</span>
                  </div>
                ))}
                <div className="flex flex-col items-center gap-1.5">
                  <img
                    src={homeSrc}
                    alt=""
                    width={180}
                    height={180}
                    style={{ width: 180, height: 180, borderRadius: 40 }}
                    className="object-cover"
                    data-testid="team-icon-img-180"
                  />
                  <span className={`text-[11px] ${scheme === 'light' ? 'text-[#4a4743]' : 'text-[#c9c5bd]'}`}>{t('teamIcon.sizeHome', { n: 180 })}</span>
                </div>
              </div>
              <figcaption className="mt-1 text-xs text-muted">{t(scheme === 'light' ? 'teamIcon.light' : 'teamIcon.dark')}</figcaption>
            </figure>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" busy={busy === 'upload'} disabled={busy !== null} onClick={() => input.current?.click()} data-testid="team-icon-upload">
            <Upload size={15} aria-hidden /> {version ? t('teamIcon.replace') : t('teamIcon.upload')}
          </Button>
          {version && (
            <Button busy={busy === 'remove'} disabled={busy !== null} onClick={() => void remove()} data-testid="team-icon-remove">
              <RotateCcw size={15} aria-hidden /> {t('teamIcon.remove')}
            </Button>
          )}
          <input
            ref={input}
            type="file"
            accept={TEAM_ICON_TYPES.join(',')}
            hidden
            data-testid="team-icon-input"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void upload(file)
            }}
          />
        </div>
        <p className="mt-2 text-xs text-faint">{t('teamIcon.hint')}</p>
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger" data-testid="team-icon-error">
            {error}
          </p>
        )}
      </div>
    </Card>
  )
}

/**
 * "Members can turn on 'Allow all websites'" (desktop app's in-app browser), default on. Off: the desktop app refuses the
 * choice and turns it back to "ask for each new site" for anyone who had it on (it reads the policy from GET /api/me).
 */
export function BrowserPolicySwitch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const t = useT()
  return (
    <div className="sm:col-span-2" data-testid="team-browser-allow-all" data-on={value ? 'true' : 'false'}>
      <Switch checked={value} onChange={onChange} label={t('teamSettings.browserAllowAll')} />
      <p className="mt-1 text-xs text-faint">{t('teamSettings.browserAllowAllHint')}</p>
    </div>
  )
}

/** "Members can add their own connections" (Settings > External services), default on. Off: none can be added and the
 * ones there are left out of chats; team connections are not affected. */
export function PersonalIntegrationsSwitch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const t = useT()
  return (
    <div className="sm:col-span-2" data-testid="team-personal-integrations" data-on={value ? 'true' : 'false'}>
      <Switch checked={value} onChange={onChange} label={t('teamSettings.personalIntegrations')} />
      <p className="mt-1 text-xs text-faint">{t('teamSettings.personalIntegrationsHint')}</p>
    </div>
  )
}
