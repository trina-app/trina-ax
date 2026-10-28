// Settings > Browser (only inside the desktop app): the in-app browser's site setting for this team on this computer,
// the same value as ⚙ in the browser panel (the clinic pilot: nobody found the setting there). The value lives in the
// desktop app; this page reads and changes it through the desktop bridge (shared/src/desktop-bridge.ts
// DesktopBrowserSettings), and every change, here or in the panel, arrives back as an event.
// The page can only make the browser stricter on its own (ask for each new site, remove a site, clear the list):
// "Allow all websites" is a request, and the desktop app asks the person in its own window before it changes anything.
// When the team turned that choice off (Admin > Team settings), the choice is disabled with the reason, and the desktop
// app refuses it and turns it back to asking by itself.
import clsx from 'clsx'
import { Globe, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocale, useT } from '../i18n'
import type { BrowserSettingsBridge, DesktopAccessOutcome, DesktopBrowserSettings } from '../lib/desktop'
import { errorText } from '../lib/api'
import { useMeStrict } from '../store/session'
import { toast } from '../store/ui'
import { Badge, Button, Skeleton, confirmDialog } from '../components/ui'

export interface BrowserSettingsViewProps {
  settings: DesktopBrowserSettings | null
  /** the team server says people may not turn on "all" (Me.team.browserAllowAll === false), whatever the app heard last */
  serverPolicyOff?: boolean
  /** "all" was asked for: the desktop app's own confirmation window is open */
  confirming?: boolean
  onAccess(v: 'ask' | 'all'): void
  onRemove(host: string): void
  onClear(): void
}

/** "Allow all websites" may be chosen: the desktop app's policy and the team server's both allow it. */
export const allowAllPermitted = (s: DesktopBrowserSettings, serverPolicyOff = false) => s.teamAllowsAll && !serverPolicyOff

export function BrowserSettingsView({ settings: s, serverPolicyOff = false, confirming = false, onAccess, onRemove, onClear }: BrowserSettingsViewProps) {
  const t = useT()
  if (!s) return <Skeleton lines={3} />
  const permitted = allowAllPermitted(s, serverPolicyOff)
  const rows = [...s.always.map((host) => ({ host, office: s.privateAlways.includes(host) })), ...s.privateAlways.filter((h) => !s.always.includes(h)).map((host) => ({ host, office: true }))]
  const choice = (value: 'ask' | 'all', label: string, hint: string, disabled = false) => (
    <label className={clsx('flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm', s.siteAccess === value ? 'border-accent bg-accent-soft' : 'border-line', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-hover')}>
      <input type="radio" name="browser-access" className="mt-1" value={value} checked={s.siteAccess === value} disabled={disabled || confirming} onChange={() => onAccess(value)} data-testid={`browser-access-${value}`} />
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        <span className="mt-0.5 block text-xs text-muted">{hint}</span>
      </span>
    </label>
  )
  return (
    <div data-testid="browser-settings">
      <section className="mb-8">
        <h2 className="mb-1 flex items-center gap-2 text-base font-semibold">
          {t('settings.browser.access')}
          {s.siteAccess === 'all' && (
            <span data-testid="browser-all-on">
              <Badge tone="warn" className="text-xs">
                <Globe size={12} aria-hidden /> {t('settings.browser.allOn')}
              </Badge>
            </span>
          )}
        </h2>
        <p className="mb-3 text-sm text-muted">{t('settings.browser.desc')}</p>
        <fieldset className="space-y-2" aria-label={t('settings.browser.access')}>
          {choice('ask', t('settings.browser.ask'), t('settings.browser.askHint'))}
          {choice('all', t('settings.browser.all'), t('settings.browser.allHint'), !permitted && s.siteAccess !== 'all')}
        </fieldset>
        {confirming && (
          <p role="status" className="mt-2 text-sm text-accent-text" data-testid="browser-confirming">
            {t('settings.browser.confirmInApp')}
          </p>
        )}
        {!permitted && (
          <p className="mt-2 rounded-lg bg-subtle px-3 py-2 text-sm text-muted" data-testid="browser-policy-off">
            {t('settings.browser.policyOff')}
          </p>
        )}
      </section>
      <section className="mb-8">
        <h2 className="mb-1 text-base font-semibold">{t('settings.browser.sites')}</h2>
        <p className="mb-3 text-sm text-muted">{t('settings.browser.sitesHint')}</p>
        {rows.length ? (
          <>
            <ul className="divide-y divide-line rounded-xl border border-line" data-testid="browser-sites">
              {rows.map((r) => (
                <li key={r.host} className="flex items-center gap-3 px-4 py-2.5 text-sm" data-testid="browser-site">
                  <span className="min-w-0 flex-1 break-all">{r.host}</span>
                  {r.office && <Badge>{t('settings.browser.office')}</Badge>}
                  <button type="button" aria-label={`${t('settings.browser.remove')} ${r.host}`} title={t('settings.browser.remove')} className="rounded p-1 text-faint hover:bg-hover hover:text-danger" onClick={() => onRemove(r.host)} data-testid="browser-site-remove">
                    <Trash2 size={15} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
            {rows.length > 1 && (
              <Button size="sm" variant="danger" className="mt-3" onClick={onClear} data-testid="browser-sites-clear">
                {t('settings.browser.clear')}
              </Button>
            )}
          </>
        ) : (
          <p className="text-sm text-faint" data-testid="browser-sites-none">
            {t('settings.browser.sitesNone')}
          </p>
        )}
      </section>
    </div>
  )
}

/** The section with the desktop app behind it (Settings.tsx shows it only when browserSettingsBridge() is there). */
export function BrowserSettings({ bridge }: { bridge: BrowserSettingsBridge }) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const serverPolicyOff = me.team.browserAllowAll === false
  const [s, setS] = useState<DesktopBrowserSettings | null>(null)
  const [confirming, setConfirming] = useState(false)
  // read again when the team's policy changes (the realtime notice refreshes Me): the app then re-reads it itself
  useEffect(() => {
    let live = true
    const off = bridge.onChange((x) => live && setS(x))
    bridge.get().then((x) => live && x && setS(x), () => {})
    return () => {
      live = false
      off()
    }
  }, [bridge, serverPolicyOff])
  const fail = (e: unknown) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
  const onAccess = async (v: 'ask' | 'all') => {
    if (v === 'all') setConfirming(true)
    let r: DesktopAccessOutcome
    try {
      r = await bridge.setAccess(v)
    } catch (e) {
      fail(e)
      return
    } finally {
      setConfirming(false)
    }
    if (r === 'not-allowed') toast({ level: 'warn', text: t('settings.browser.policyOff') })
    else if (r === 'busy') toast({ level: 'info', text: t('settings.browser.busy') })
    else if (r === 'changed') toast({ level: 'success', text: v === 'all' ? t('settings.browser.allChanged') : t('common.saved') })
    // whatever happened, show what the app has now (a cancelled dialog leaves "ask" selected)
    bridge.get().then((x) => x && setS(x), () => {})
  }
  const onRemove = (host: string) =>
    bridge.removeSite(host).then((x) => x && setS(x), fail)
  const onClear = async () => {
    if (!(await confirmDialog({ title: t('settings.browser.clearTitle'), body: t('settings.browser.clearBody'), confirm: t('settings.browser.clear'), danger: true }))) return
    bridge.clearSites().then((x) => x && setS(x), fail)
  }
  return <BrowserSettingsView settings={s} serverPolicyOff={serverPolicyOff} confirming={confirming} onAccess={(v) => void onAccess(v)} onRemove={(h) => void onRemove(h)} onClear={() => void onClear()} />
}
