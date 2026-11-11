// Settings > Browser: the sites the AI can open.
// - The desktop app's in-app browser (only inside the desktop app): its site setting for this team on this computer,
//   the same value as ⚙ in the browser panel (the clinic pilot: nobody found the setting there). The value lives in the
//   desktop app; this page reads and changes it through the desktop bridge (shared/src/desktop-bridge.ts
//   DesktopBrowserSettings), and every change, here or in the panel, arrives back as an event. The page can only make
//   that browser stricter on its own (ask for each new site, remove a site, clear the list): "Allow all websites" is a
//   request, and the desktop app asks the person in its own window before it changes anything. When the team turned
//   that choice off (Admin > Team settings), the choice is disabled with the reason, and the desktop app refuses it and
//   turns it back to asking by itself.
// - "Allow all websites" for the AI's web reads (docs/DECISIONS.md "Allow all websites covers the AI's web reads"), on
//   every client while the team allows it (Me.team.webAllowAll): then the one choice is the person's value on the
//   server (Me.user.webAllowAll, PUT /api/me/web-access). Turning it on shows the risk sentence first (shared
//   WEB_ALLOW_ALL_RISK): inside the desktop app in the app's own window (which also turns on this computer's browser),
//   elsewhere in the page's confirm. The server can make the desktop's browser stricter, never wider, so a value turned
//   on elsewhere (an address card, another device) leaves this computer's browser asking: one line says so, with
//   [Allow here too] (the app's window).
import clsx from 'clsx'
import { Globe, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { WEB_ALLOW_ALL_RISK, WEB_ALLOW_ALL_WARNING_VERSION } from '@mycel/shared'
import { useLocale, useT } from '../i18n'
import type { BrowserSettingsBridge, DesktopAccessOutcome, DesktopBrowserSettings } from '../lib/desktop'
import { api, API, errorText, isApiError } from '../lib/api'
import { useMeStrict, useSession } from '../store/session'
import { toast } from '../store/ui'
import { Badge, Button, Skeleton, confirmDialog } from '../components/ui'
import { Tooltip } from '../components/Tooltip'

export interface BrowserSettingsViewProps {
  /** the desktop app's in-app browser setting; null while the app answers; undefined outside the desktop app */
  settings: DesktopBrowserSettings | null | undefined
  /** the team lets members allow all websites for the AI's web reads: the choice is the person's server value */
  web?: { on: boolean }
  /** the team server says people may not turn on "all" (Me.team.browserAllowAll === false), whatever the app heard last */
  serverPolicyOff?: boolean
  /** "all" was asked for: the desktop app's own confirmation window is open (or the change is being saved) */
  confirming?: boolean
  onAccess(v: 'ask' | 'all'): void
  onRemove(host: string): void
  onClear(): void
  /** server value on, this computer's browser still asking: open the app's window for it */
  onAllowHere?(): void
}

/** "Allow all websites" may be chosen: the desktop app's policy and the team server's both allow it. */
export const allowAllPermitted = (s: DesktopBrowserSettings, serverPolicyOff = false) => s.teamAllowsAll && !serverPolicyOff

export function BrowserSettingsView({ settings: s, web, serverPolicyOff = false, confirming = false, onAccess, onRemove, onClear, onAllowHere }: BrowserSettingsViewProps) {
  const t = useT()
  const locale = useLocale()
  const desktop = s !== undefined
  if (desktop ? !s : !web) return <Skeleton lines={3} />
  const value: 'ask' | 'all' = web ? (web.on ? 'all' : 'ask') : s!.siteAccess
  // with the web value, the team server allows it already (Me.team.webAllowAll needs browserAllowAll on)
  const permitted = web ? true : allowAllPermitted(s!, serverPolicyOff)
  const rows = s ? [...s.always.map((host) => ({ host, office: s.privateAlways.includes(host) })), ...s.privateAlways.filter((h) => !s.always.includes(h)).map((host) => ({ host, office: true }))] : []
  const choice = (v: 'ask' | 'all', label: string, hint: string, disabled = false) => (
    <label className={clsx('flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm', value === v ? 'border-accent bg-accent-soft' : 'border-line', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-hover')}>
      <input type="radio" name="browser-access" className="mt-1" value={v} checked={value === v} disabled={disabled || confirming} onChange={() => onAccess(v)} data-testid={`browser-access-${v}`} />
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        <span className="mt-0.5 block text-xs text-muted">{hint}</span>
      </span>
    </label>
  )
  const allHint = web ? t('settings.browser.allHintWeb', { risk: WEB_ALLOW_ALL_RISK[locale] }) : t('settings.browser.allHint')
  return (
    <div data-testid="browser-settings">
      <section className="mb-8">
        <h2 className="mb-1 flex items-center gap-2 text-base font-semibold">
          {t('settings.browser.access')}
          {value === 'all' && (
            <span data-testid="browser-all-on">
              <Badge tone="warn" className="text-xs">
                <Globe size={12} aria-hidden /> {t('settings.browser.allOn')}
              </Badge>
            </span>
          )}
        </h2>
        <p className="mb-3 text-sm text-muted">{t(web ? 'settings.browser.descWeb' : 'settings.browser.desc')}</p>
        <fieldset className="space-y-2" aria-label={t('settings.browser.access')}>
          {choice('ask', t('settings.browser.ask'), t(web ? 'settings.browser.askHintWeb' : 'settings.browser.askHint'))}
          {choice('all', t('settings.browser.all'), allHint, !permitted && value !== 'all')}
        </fieldset>
        {confirming && desktop && (
          <p role="status" className="mt-2 text-sm text-accent-text" data-testid="browser-confirming">
            {t('settings.browser.confirmInApp')}
          </p>
        )}
        {!permitted && (
          <p className="mt-2 rounded-lg bg-subtle px-3 py-2 text-sm text-muted" data-testid="browser-policy-off">
            {t('settings.browser.policyOff')}
          </p>
        )}
        {/* the server value is on, this computer's browser still asks (the server never widens it) */}
        {web?.on && s && s.siteAccess === 'ask' && (
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-subtle px-3 py-2 text-sm text-muted" data-testid="browser-here-asks">
            <span className="min-w-0 flex-1">{t('settings.browser.hereAsks')}</span>
            {s.teamAllowsAll && onAllowHere && (
              <Button size="sm" variant="ghost" disabled={confirming} onClick={onAllowHere} data-testid="browser-allow-here">
                {t('settings.browser.allowHere')}
              </Button>
            )}
          </p>
        )}
        {/* this computer's browser was set to "all" before (or on its own): web pages the AI reads still ask */}
        {web && !web.on && s?.siteAccess === 'all' && (
          <p className="mt-2 rounded-lg bg-subtle px-3 py-2 text-sm text-muted" data-testid="browser-here-only">
            {t('settings.browser.hereOnly')}
          </p>
        )}
      </section>
      {s && (
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
                    <Tooltip label={`${t('settings.browser.remove')} ${r.host}`}>
                      <button type="button" aria-label={`${t('settings.browser.remove')} ${r.host}`} className="rounded p-1 text-faint hover:bg-hover hover:text-danger" onClick={() => onRemove(r.host)} data-testid="browser-site-remove">
                        <Trash2 size={15} aria-hidden />
                      </button>
                    </Tooltip>
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
      )}
    </div>
  )
}

/** The page's own confirm before the server value goes on (outside the desktop app, or when the app's window did not
 * open because its browser allows all already): what changes and the risk sentence. */
export function confirmWebAllowAll(t: ReturnType<typeof useT>, locale: keyof typeof WEB_ALLOW_ALL_RISK): Promise<boolean> {
  return confirmDialog({
    title: t('settings.browser.confirmTitle'),
    body: (
      <div className="space-y-2" data-testid="browser-all-warning">
        <p>{t('settings.browser.confirmBody')}</p>
        <p className="font-semibold text-danger">{WEB_ALLOW_ALL_RISK[locale]}</p>
      </div>
    ),
    confirm: t('settings.browser.all'),
    danger: true,
  })
}

/** The section: the desktop app's browser when `bridge` is there, the server value while the team allows it. */
export function BrowserSettings({ bridge }: { bridge: BrowserSettingsBridge | null }) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const serverPolicyOff = me.team.browserAllowAll === false
  const teamWeb = me.team.webAllowAll === true
  const webOn = me.user.webAllowAll === true
  const [s, setS] = useState<DesktopBrowserSettings | null>(null)
  const [confirming, setConfirming] = useState(false)
  // read again when the team's policy or the person's value changes (the realtime notices refresh Me): the app then
  // re-reads GET /api/me itself and follows an off
  useEffect(() => {
    if (!bridge) return
    let live = true
    const off = bridge.onChange((x) => live && setS(x))
    bridge.get().then((x) => live && x && setS(x), () => {})
    return () => {
      live = false
      off()
    }
  }, [bridge, serverPolicyOff, webOn])
  const fail = (e: unknown) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
  const reread = () => {
    void useSession.getState().refreshMe()
    if (bridge) bridge.get().then((x) => x && setS(x), () => {})
  }
  /** the desktop app's own window for "all" on this computer; null when the call failed */
  const desktopAll = async (): Promise<DesktopAccessOutcome | null> => {
    setConfirming(true)
    try {
      return await bridge!.setAccess('all')
    } catch (e) {
      fail(e)
      return null
    } finally {
      setConfirming(false)
    }
  }
  const outcomeToast = (r: DesktopAccessOutcome | null, v: 'ask' | 'all') => {
    if (r === 'not-allowed') toast({ level: 'warn', text: t('settings.browser.policyOff') })
    else if (r === 'busy') toast({ level: 'info', text: t('settings.browser.busy') })
    else if (r === 'changed') toast({ level: 'success', text: v === 'all' ? t('settings.browser.allChanged') : t('common.saved') })
  }

  // ---- the desktop app's browser only (the team does not allow it for web reads): as before ----
  const onDesktopAccess = async (v: 'ask' | 'all') => {
    if (!bridge) return
    let r: DesktopAccessOutcome | null
    if (v === 'all') r = await desktopAll()
    else r = await bridge.setAccess(v).catch((e) => (fail(e), null))
    outcomeToast(r, v)
    // whatever happened, show what the app has now (a cancelled dialog leaves "ask" selected)
    bridge.get().then((x) => x && setS(x), () => {})
  }

  // ---- the server value (Me.user.webAllowAll) ----
  const putWeb = async (on: boolean): Promise<boolean> => {
    try {
      await api.call(API.setMyWebAccess, { body: on ? { on, acceptWarning: WEB_ALLOW_ALL_WARNING_VERSION } : { on } })
      return true
    } catch (e) {
      const reason = isApiError(e) ? e.body.params?.reason : undefined
      toast({ level: 'error', text: reason === 'web_allow_all_off' ? t('settings.browser.webPolicyOff') : reason === 'web_allow_all_warning' ? t('settings.browser.warningChanged') : errorText(e, locale, t('error.network')) })
      return false
    }
  }
  const onWebAccess = async (v: 'ask' | 'all') => {
    if (confirming) return
    try {
      if (v === 'ask') {
        const ok = await putWeb(false)
        // this computer's browser goes back to asking too (stricter: no window)
        if (bridge) await bridge.setAccess('ask').catch(() => null)
        if (ok) toast({ level: 'success', text: t('common.saved') })
        return
      }
      let pane: DesktopAccessOutcome | null = null
      // the app's own window shows the current risk sentence only in a desktop app that says so (riskVersion); an older
      // app's window does not, so the page's confirm comes first there
      const appShowsRisk = s?.riskVersion === WEB_ALLOW_ALL_WARNING_VERSION
      let pageConfirmed = false
      if (bridge && !appShowsRisk) {
        if (!(await confirmWebAllowAll(t, locale))) return
        pageConfirmed = true
      }
      if (bridge) {
        pane = await desktopAll()
        if (pane === null || pane === 'cancelled') return
        if (pane === 'not-allowed' || pane === 'busy') return outcomeToast(pane, 'all')
        // 'unavailable' (no browser in this window) or 'unchanged' (it allows all already): no window was shown
      }
      // the risk sentence was shown in the app's own window only when it changed this computer's browser
      if (!pageConfirmed && (pane !== 'changed' || !appShowsRisk) && !(await confirmWebAllowAll(t, locale))) return
      setConfirming(true)
      const ok = await putWeb(true)
      setConfirming(false)
      // the server refused: this computer's browser does not stay wider than the switch says
      if (!ok && pane === 'changed') await bridge!.setAccess('ask').catch(() => null)
      if (ok) toast({ level: 'success', text: t('settings.browser.allChanged') })
    } finally {
      setConfirming(false)
      reread()
    }
  }
  const onAllowHere = async () => {
    if (!bridge || confirming) return
    outcomeToast(await desktopAll(), 'all')
    reread()
  }

  const onRemove = (host: string) => bridge?.removeSite(host).then((x) => x && setS(x), fail)
  const onClear = async () => {
    if (!bridge) return
    if (!(await confirmDialog({ title: t('settings.browser.clearTitle'), body: t('settings.browser.clearBody'), confirm: t('settings.browser.clear'), danger: true }))) return
    bridge.clearSites().then((x) => x && setS(x), fail)
  }
  return (
    <BrowserSettingsView
      settings={bridge ? s : undefined}
      web={teamWeb ? { on: webOn } : undefined}
      serverPolicyOff={serverPolicyOff}
      confirming={confirming}
      onAccess={(v) => void (teamWeb ? onWebAccess(v) : onDesktopAccess(v))}
      onRemove={(h) => void onRemove(h)}
      onClear={() => void onClear()}
      onAllowHere={() => void onAllowHere()}
    />
  )
}
