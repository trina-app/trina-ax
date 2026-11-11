// Settings › Apps: the phone apps and the desktop apps, one row each with its name and one way to get it (lib/apps.ts
// decides which rows and which action). The edition's store listings and download page are APP_DOWNLOADS
// (shared/src/app-downloads.ts); the team server's installers come from /downloads/index.json. A build with neither shows
// only what the team server has (and its empty state).
import { Download, ExternalLink, Laptop, Monitor, Smartphone } from 'lucide-react'
import { RELEASE_CHANNEL, type AppDownloads } from '@mycel/shared'
import type { Me } from '@mycel/shared/api'
import { computerApps, noComputerApps, phoneApps, type AppClient, type AppOs, type AppRow } from '../../lib/apps'
import { archNote, installSteps, showSteps, type DownloadItem } from '../../lib/downloads'
import { formatSize } from '../../lib/format'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { Badge, Skeleton } from '../ui'
import QrCode from '../QrCode'

// product and store names: the same in every language
const NAME: Record<AppOs, string> = { iphone: 'iPhone', android: 'Android', mac: 'Mac', windows: 'Windows' }
const STORE: Record<AppOs, string> = { iphone: 'App Store', android: 'Google Play', mac: 'App Store', windows: 'Microsoft Store' }
const ICON: Record<AppOs, typeof Smartphone> = { iphone: Smartphone, android: Smartphone, mac: Laptop, windows: Monitor }
const actionCls = 'inline-flex min-h-9 items-center gap-2 rounded-lg border border-field-border px-3 py-1.5 text-sm text-ink hover:bg-hover'

/** One app: its icon and name (and a note under it) on the left, its one action on the right; on a narrow screen the
 * action wraps under the name. `after`: full-width lines under the row (install steps). */
function AppRowView({ row, badge, note, action, after }: { row: AppRow; badge?: string; note?: React.ReactNode; action?: React.ReactNode; after?: React.ReactNode }) {
  const Icon = ICON[row.os]
  return (
    <li className="border-b border-line py-3 last:border-b-0" data-testid={`app-row-${row.os}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 items-start gap-3">
          <Icon size={18} className="mt-px shrink-0 text-muted" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm text-ink">
              {NAME[row.os]}
              {badge && <Badge tone="accent" className="ml-2">{badge}</Badge>}
            </p>
            {note && <div className="mt-0.5 break-keep text-xs text-muted">{note}</div>}
          </div>
        </div>
        {action && <div className="flex min-w-0 flex-wrap items-center gap-2 max-sm:pl-[30px]">{action}</div>}
      </div>
      {after}
    </li>
  )
}

/** a store listing or the download page: a web page, opened outside the app (the desktop and phone apps send it to
 * the system browser) */
function LinkOut({ os, href, store }: { os: AppOs; href: string; store: boolean }) {
  const t = useT()
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={actionCls} data-testid={`app-link-${os}`}>
      <span className="sr-only">{NAME[os]} </span>
      {store ? STORE[os] : t('apps.download')}
      <ExternalLink size={14} className="text-muted" aria-hidden />
    </a>
  )
}

/** Phone app: iPhone and Android, with one small QR code of the download page on a computer; in the phone app only
 * "This app". Nothing at all when the edition has no phone app links (and this is not the phone app). */
export function PhoneApps({ links, client }: { links: AppDownloads; client: AppClient }) {
  const t = useT()
  const { rows, qr } = phoneApps(links, client)
  if (!rows.length) return null
  const computer = client.kind !== 'mobile' && client.here !== 'ios' && client.here !== 'android'
  return (
    <>
      <ul data-testid="apps-phone">
        {rows.map((row) => (
          <AppRowView key={row.os} row={row} badge={row.thisApp ? t('apps.thisApp') : undefined}
            action={row.action && row.action.kind !== 'files' && (
              <>
                {/* no download page: each phone gets its own small code */}
                {computer && !qr && <QrCode text={row.action.href} size={64} label={`${NAME[row.os]}: ${t('apps.qrLabel')}`} />}
                <LinkOut os={row.os} href={row.action.href} store={row.action.kind === 'store'} />
              </>
            )} />
        ))}
      </ul>
      {qr && (
        <div className="mt-3 flex items-center gap-3" data-testid="apps-phone-qr">
          <QrCode text={qr} size={88} label={t('apps.qrLabel')} />
          <p className="break-keep text-xs text-muted">{t('apps.scanQr')}</p>
        </div>
      )}
    </>
  )
}

/** Where the team server's installers come from, for the owner's empty state: an office Mac (`teamax desktop add`), a
 * Linux server that takes the Windows app from the release feed by itself (GET /api/me server.windowsApp 'feed') or
 * one without a feed ('folder': desktop-refresh --from), a hosted tenant that takes it from the feed ('hosted-feed':
 * nothing to run, Diagnostics says why when it is missing) or one that does not ('hosted'). */
export type DownloadsSource = 'office' | 'feed' | 'folder' | 'hosted' | 'hosted-feed'
export const downloadsSourceOf = (server: Pick<Me['server'], 'deployment' | 'windowsApp'>): DownloadsSource =>
  server.deployment === 'hosted' ? (server.windowsApp === 'feed' ? 'hosted-feed' : 'hosted') : server.windowsApp ?? 'office'
const OWNER_HINT: Record<DownloadsSource, MessageKey | null> = { office: 'apps.noDownloadsOwner', feed: 'apps.noDownloadsOwnerFeed', folder: 'apps.noDownloadsOwnerLinux', hosted: null, 'hosted-feed': 'apps.noDownloadsOwnerHosted' }
const FEED_HOST = (() => { try { return new URL(RELEASE_CHANNEL.feed).host } catch { return RELEASE_CHANNEL.feed } })()

/**
 * Desktop app: the Mac and Windows rows (lib/apps.ts computerApps). With the edition's App Store listing the Mac row
 * offers only the App Store, never the team server's installer file. Inside a store build its own row is "This app"
 * with the store's line (App Store on a Mac, Microsoft Store on Windows) and no installer is offered anywhere; the
 * desktop app's own row otherwise says how it updates. A browser on a Mac or a Windows PC marks this computer's row,
 * with the install steps under its installer, or says the server has no such app (and, in a browser that can install
 * the page, points at "Install as an app" below). With nothing to offer at all: the server's empty state, with the
 * owner's hint; with store links but no installer on the server, the owner still gets the hint under the rows.
 */
export function ComputerApps({ links, client, downloads, owner, server = 'office', installHere = false }: { links: AppDownloads; client: AppClient; downloads: DownloadItem[] | null | 'none'; owner: boolean; server?: DownloadsSource; /** a browser tab that can install the page as an app (the guide below is shown) */ installHere?: boolean }) {
  const t = useT()
  const locale = useLocale()
  if (downloads === null && !client.store) return <Skeleton lines={2} />
  const rows = computerApps(links, client, Array.isArray(downloads) ? downloads : [])
  const ownerHint = owner && OWNER_HINT[server] && <p className="mt-2 text-xs text-muted" data-testid="apps-owner-hint">{t(OWNER_HINT[server]!, { feed: FEED_HOST })}</p>
  if (noComputerApps(rows, client))
    return (
      <>
        <p className="text-sm text-muted">{t(!owner ? 'apps.noDownloads' : server === 'feed' || server === 'hosted-feed' ? 'apps.noDownloadsFeed' : 'apps.noDownloadsYet')}</p>
        {ownerHint}
      </>
    )
  const note = (row: AppRow) => {
    const files = row.action?.kind === 'files'
    if (row.thisApp && client.store) return t(row.os === 'windows' ? 'apps.windowsStore' : 'apps.macStore')
    if (row.thisApp && files) return t(row.os === 'windows' ? 'apps.updatesItself' : 'apps.macUpdates')
    if (row.thisDevice && !row.action)
      return (
        <span data-testid="desktop-none-here">
          {t(row.os === 'mac' ? 'apps.noMacApp' : 'apps.noWindowsApp')}
          {installHere && <> {t('apps.installInstead')}</>}
        </span>
      )
    return undefined
  }
  const file = (d: DownloadItem, os: AppOs) => (
    <a key={d.file} href={`/downloads/${encodeURIComponent(d.file)}`} download className={actionCls} data-testid={`app-file-${os}`}>
      <Download size={15} className="text-muted" aria-hidden />
      <span className="sr-only">{NAME[os]} </span>
      {t('apps.download')} · v{d.version}
      {d.size ? ` · ${formatSize(d.size, locale)}` : ''}
      {archNote(d) && <Badge tone="warn">{t(archNote(d)!)}</Badge>}
    </a>
  )
  /** what to click while installing, on the computer the file is for */
  const steps = (row: AppRow, items: DownloadItem[], indent: string) =>
    row.thisDevice && items.filter((d) => showSteps(items, d)).map((d) => (
      <ol key={d.file} className={`mt-2 list-decimal space-y-1 break-keep text-xs text-muted ${indent}`}>
        {installSteps(d).map((k) => (
          <li key={k} className={k === 'apps.winSmartScreen' || k === 'apps.macGatekeeper' ? 'text-warn' : undefined}>{t(k)}</li>
        ))}
      </ol>
    ))
  return (
    <>
      <ul data-testid="apps-computer">
        {rows.map((row) => {
          const a = row.action
          return (
            <AppRowView key={row.os} row={row} note={note(row)}
              badge={row.thisApp ? t('apps.thisApp') : row.thisDevice ? t('apps.thisComputer') : undefined}
              action={a && (a.kind === 'files' ? a.items.map((d) => file(d, row.os)) : <LinkOut os={row.os} href={a.href} store={a.kind === 'store'} />)}
              after={a?.kind === 'files' && steps(row, a.items, 'pl-[50px] max-sm:pl-[46px]')} />
          )
        })}
      </ul>
      {/* the owner of a server with no installer yet: where they come from, even when the rows have store links (the
          Windows app updates only from the team server) */}
      {downloads === 'none' && !client.store && ownerHint}
    </>
  )
}

