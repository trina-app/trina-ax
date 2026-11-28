// Settings › Browser › "Your browsers" (docs/decisions/20261128-trina-in-chrome.md): the AI's browser in the person's own
// Chrome, Edge or Brave through the <app> extension. On computers only (never a phone: settingsTabs.ts chromeLinkHere).
// Each browser profile the person linked is one row (a person may link several, one per identity: work mail, personal):
// its name (the pencil renames it in place), online or when it was last used, and Disconnect (no question: Connect again
// is one click in that profile). "Sites" under a row opens what the AI may use there without asking, as removable chips,
// a field to add one, and one switch "Only these sites" (anything else is refused in that profile, never asked). No link:
// how to connect; with links, one line on connecting another profile. Inside the desktop app, while one is linked: one
// switch for where the AI's browser runs (PUT /api/chrome/target). The list is read again every 10 s while the page is
// visible and when the window gets focus. The extension's own Connect opens /connect-chrome (pages/ConnectChrome.tsx).
import { ChevronDown, Pencil, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { PRODUCT } from '@mycel/shared'
import { ChromeLinkLabel, ChromeSite, type BrowserTarget, type ChromeLink } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { api, API, errorText, isApiError } from '../../lib/api'
import { isDesktop } from '../../lib/desktop'
import { formatRelative } from '../../lib/format'
import { toast } from '../../store/ui'
import { Button, IconButton, Skeleton, Switch, inputCls } from '../ui'
import { SettingRow } from './SettingRow'

export const CHROME_REFRESH_MS = 10_000

export interface ChromeLinkData { links: ChromeLink[]; target: BrowserTarget }
/** one change to a profile (PATCH /api/chrome/links/:id) */
export type ChromeLinkPatch = { label?: string; onlyListed?: boolean; addSite?: string; removeSite?: string }

/** What the person typed as a site, as the server keeps it: "https://www.naver.com/news" → "www.naver.com"; null when it
 * is no site name. */
export function siteOf(typed: string): string | null {
  let s = typed.trim().toLowerCase()
  if (!s) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try { s = new URL(s).hostname } catch { return null }
  } else s = s.split(/[/?#]/)[0]!.replace(/:\d+$/, '')
  s = s.replace(/\.$/, '')
  return s.includes('.') && ChromeSite.safeParse(s).success ? s : null
}

export interface ChromeLinkViewProps {
  /** null while the first read is under way */
  data: ChromeLinkData | null
  /** inside the desktop app: the "Use my Chrome" switch (while a profile is linked) */
  inApp: boolean
  /** the team's address as the person sees it (location.host) */
  host: string
  /** what is being saved: a link's id, or 'target' */
  busy?: string | null
  onDisconnect(link: ChromeLink): void
  onTarget(target: BrowserTarget): void
  /** resolves true when the change was kept */
  onPatch(link: ChromeLink, patch: ChromeLinkPatch): Promise<boolean>
  /** rows whose sites start open (tests, screenshots) */
  openIds?: string[]
  now?: number
}

export function ChromeLinkView({ data, inApp, host, busy = null, onDisconnect, onTarget, onPatch, openIds = [], now = Date.now() }: ChromeLinkViewProps) {
  const t = useT()
  const product = PRODUCT.displayName
  return (
    <section className="mb-8" data-testid="chrome-link" aria-labelledby="chrome-link-title">
      <h2 id="chrome-link-title" className="mb-1 text-title-sm font-semibold">{t('settings.chrome.title')}</h2>
      <p className="mb-3 text-sm text-muted">{t('settings.chrome.intro')}</p>
      {!data ? (
        <Skeleton lines={2} />
      ) : data.links.length === 0 ? (
        <p className="text-sm text-muted" data-testid="chrome-link-how">{t('settings.chrome.how', { product, host })}</p>
      ) : (
        <>
          <ul className="divide-y divide-line md:rounded-xl md:border md:border-line" data-testid="chrome-links">
            {data.links.map((l) => <LinkRow key={l.id} link={l} busy={busy} startOpen={openIds.includes(l.id)} now={now} onDisconnect={onDisconnect} onPatch={onPatch} />)}
          </ul>
          <p className="mt-3 text-sm text-muted" data-testid="chrome-link-another">{t('settings.chrome.another', { product, host })}</p>
          <p className="mt-1 text-sm text-faint" data-testid="chrome-link-tip">{t('settings.chrome.oneEach')}</p>
          {inApp && (
            <div className="mt-2" data-testid="chrome-target">
              <SettingRow inline id="chrome-target-switch" title={t('settings.chrome.use')} desc={t(data.target === 'chrome' ? 'settings.chrome.useOn' : 'settings.chrome.useOff')}
                control={<Switch id="chrome-target-switch" external describedBy="chrome-target-switch-desc" checked={data.target === 'chrome'} disabled={busy === 'target'} label={t('settings.chrome.use')} onChange={(v) => onTarget(v ? 'chrome' : 'app')} testId="chrome-target-switch" />} />
            </div>
          )}
        </>
      )}
    </section>
  )
}

/** One linked profile: its name (renamed in place), its state, Disconnect, and its sites behind "Sites". */
function LinkRow({ link: l, busy, startOpen, now, onDisconnect, onPatch }: { link: ChromeLink; busy: string | null; startOpen: boolean; now: number; onDisconnect(l: ChromeLink): void; onPatch(l: ChromeLink, p: ChromeLinkPatch): Promise<boolean> }) {
  const t = useT()
  const locale = useLocale()
  const [open, setOpen] = useState(startOpen)
  const [name, setName] = useState<string | null>(null)
  const [site, setSite] = useState('')
  const [siteError, setSiteError] = useState(false)
  const saving = busy === l.id || busy === `unlink:${l.id}`
  const sitesId = `chrome-sites-${l.id}`
  const rename = async (e?: FormEvent) => {
    e?.preventDefault()
    if (name === null) return
    const label = ChromeLinkLabel.safeParse(name)
    if (!label.success || label.data === l.label) return setName(null)
    if (await onPatch(l, { label: label.data })) setName(null)
  }
  const add = async (e: FormEvent) => {
    e.preventDefault()
    const s = siteOf(site)
    if (!s) return setSiteError(true)
    setSiteError(false)
    if (l.sites.includes(s) || (await onPatch(l, { addSite: s }))) setSite('')
  }
  return (
    <li className="py-3 text-sm md:px-4" data-testid="chrome-link-row">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          {name === null ? (
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate font-medium text-ink" data-testid="chrome-link-label">{l.label}</span>
              <IconButton compact label={`${t('settings.chrome.rename')} ${l.label}`} onClick={() => setName(l.label)} data-testid="chrome-link-rename">
                <Pencil size={14} aria-hidden />
              </IconButton>
            </span>
          ) : (
            <form className="flex items-center gap-2" onSubmit={(e) => void rename(e)}>
              <input
                className={`${inputCls} h-8 max-w-64 py-1`}
                aria-label={t('settings.chrome.nameLabel')}
                value={name}
                maxLength={60}
                autoFocus
                disabled={saving}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setName(null) } }}
                onBlur={() => void rename()}
                data-testid="chrome-link-name"
              />
            </form>
          )}
          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted" data-testid="chrome-link-state">
            <span className={l.online ? 'size-2 shrink-0 rounded-full bg-ok' : 'size-2 shrink-0 rounded-full border border-faint'} aria-hidden />
            {l.online ? t('settings.chrome.online') : l.lastSeenAt ? t('settings.chrome.lastUsed', { when: formatRelative(l.lastSeenAt, locale, now) }) : t('settings.chrome.offline')}
          </span>
        </div>
        <Button size="sm" variant="ghost" className="shrink-0" aria-expanded={open} aria-controls={sitesId} onClick={() => setOpen(!open)} data-testid="chrome-link-sites-toggle">
          {t('settings.chrome.sites', { n: l.sites.length })}
          <ChevronDown size={14} aria-hidden className={open ? 'rotate-180 transition' : 'transition'} />
        </Button>
        <Button size="sm" variant="secondary" className="shrink-0" busy={busy === `unlink:${l.id}`} disabled={!!busy} onClick={() => onDisconnect(l)} aria-label={`${t('settings.chrome.disconnect')} ${l.label}`} data-testid="chrome-link-disconnect">
          {t('settings.chrome.disconnect')}
        </Button>
      </div>
      {open && (
        <div id={sitesId} className="mt-3 space-y-3 rounded-lg bg-subtle px-3 py-3" data-testid="chrome-link-sites">
          {l.sites.length ? (
            <ul className="flex flex-wrap gap-1.5" aria-label={t('settings.chrome.sitesLabel', { name: l.label })}>
              {l.sites.map((s) => (
                <li key={s} className="flex items-center gap-0.5 rounded-full border border-line bg-surface py-0.5 ps-2.5 pe-0.5 text-xs text-ink" data-testid="chrome-link-site">
                  <span className="break-all">{s}</span>
                  <IconButton compact className="p-0.5" label={`${t('settings.chrome.removeSite')} ${s}`} disabled={saving} onClick={() => void onPatch(l, { removeSite: s })} data-testid="chrome-link-site-remove">
                    <X size={12} aria-hidden />
                  </IconButton>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted" data-testid="chrome-link-sites-none">{t(l.onlyListed ? 'settings.chrome.sitesNoneOnly' : 'settings.chrome.sitesNone')}</p>
          )}
          <form className="flex items-start gap-2" onSubmit={(e) => void add(e)}>
            <div className="min-w-0 flex-1">
              <input
                className={`${inputCls} h-8 py-1`}
                aria-label={t('settings.chrome.addSite')}
                aria-invalid={siteError || undefined}
                placeholder="example.com"
                value={site}
                disabled={saving}
                onChange={(e) => { setSite(e.target.value); setSiteError(false) }}
                data-testid="chrome-link-site-input"
              />
              {siteError && <p role="alert" className="mt-1 text-xs text-danger" data-testid="chrome-link-site-error">{t('settings.chrome.badSite')}</p>}
            </div>
            <Button size="sm" type="submit" disabled={saving || !site.trim()} data-testid="chrome-link-site-add">{t('settings.chrome.addSite')}</Button>
          </form>
          <SettingRow inline id={`chrome-only-${l.id}`} title={t('settings.chrome.onlyListed')} desc={t('settings.chrome.onlyListedHint')}
            control={<Switch id={`chrome-only-${l.id}`} external describedBy={`chrome-only-${l.id}-desc`} checked={l.onlyListed} disabled={saving} label={t('settings.chrome.onlyListed')} onChange={(v) => void onPatch(l, { onlyListed: v })} testId="chrome-link-only" />} />
        </div>
      )}
    </li>
  )
}

/** The section with its reads: nothing at all when this server has no Chrome links (an older server: 404). */
export function ChromeLinkSettings() {
  const t = useT()
  const locale = useLocale()
  const [data, setData] = useState<ChromeLinkData | null>(null)
  const [absent, setAbsent] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const live = useRef(true)
  const read = useCallback(async () => {
    try {
      const r = await api.call(API.chromeLinks)
      if (!live.current) return
      setData(r)
      setNow(Date.now())
    } catch (e) {
      // an older server without browser links: no section. Anything else (offline, a restart): what is shown stays, and
      // the next read tries again
      if (live.current && isApiError(e, 'not_found')) setAbsent(true)
    }
  }, [])
  useEffect(() => {
    live.current = true
    void read()
    const tick = () => { if (document.visibilityState === 'visible') void read() }
    const timer = window.setInterval(tick, CHROME_REFRESH_MS)
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', tick)
    return () => {
      live.current = false
      window.clearInterval(timer)
      window.removeEventListener('focus', tick)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [read])
  if (absent) return null
  const fail = (e: unknown) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
  const onDisconnect = async (l: ChromeLink) => {
    setBusy(`unlink:${l.id}`)
    try {
      await api.call(API.chromeUnlink, { params: { id: l.id } })
      toast({ level: 'success', text: t('settings.chrome.disconnected', { label: l.label }) })
    } catch (e) {
      // gone already (disconnected in that browser): the list read below shows it
      if (!isApiError(e, 'not_found')) fail(e)
    } finally {
      setBusy(null)
      void read()
    }
  }
  const onPatch = async (l: ChromeLink, patch: ChromeLinkPatch): Promise<boolean> => {
    setBusy(l.id)
    try {
      const next = await api.call(API.chromeUpdateLink, { params: { id: l.id }, body: patch })
      setData((d) => (d ? { ...d, links: d.links.map((x) => (x.id === next.id ? next : x)) } : d))
      return true
    } catch (e) {
      if (isApiError(e, 'not_found')) void read()
      else fail(e)
      return false
    } finally {
      setBusy(null)
    }
  }
  const onTarget = async (target: BrowserTarget) => {
    if (!data) return
    const before = data.target
    setData({ ...data, target })
    setBusy('target')
    try {
      await api.call(API.chromeTarget, { body: { target } })
    } catch (e) {
      setData((d) => (d ? { ...d, target: before } : d))
      fail(e)
    } finally {
      setBusy(null)
    }
  }
  return <ChromeLinkView data={data} inApp={isDesktop()} host={window.location.host} busy={busy} now={now} onDisconnect={(l) => void onDisconnect(l)} onTarget={(v) => void onTarget(v)} onPatch={onPatch} />
}
