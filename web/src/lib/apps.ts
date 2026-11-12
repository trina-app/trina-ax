// Settings › Apps (components/settings/AppList.tsx): which apps are listed and what each row offers. The edition's
// store listings and download page are APP_DOWNLOADS (shared/src/app-downloads.ts, from editions/<name>/branding/
// apps.json; '' = none); the team server's own installers come from /downloads/index.json (lib/downloads.ts).
import type { AppDownloads } from '@mycel/shared'
import type { DownloadItem } from './downloads'
import type { Platform } from './pwa'

export type AppOs = 'iphone' | 'android' | 'mac' | 'windows'
/** one action per row: a store listing, the edition's download page (a web page), or the team server's installer
 * files (one per kind of Mac, or older versions kept with --keep) */
export type AppAction = { kind: 'store'; href: string } | { kind: 'page'; href: string } | { kind: 'files'; items: DownloadItem[] }
export interface AppRow {
  os: AppOs
  action: AppAction | null
  /** this row is the app this page runs in (the desktop app or the phone app) */
  thisApp: boolean
  /** this row is for the device this page is open on */
  thisDevice: boolean
}
/** where this page runs: a web browser, the desktop app or the phone app; `here` is the device; `store`: a Mac App Store
 * or Microsoft Store build of the desktop app (lib/desktop.ts storeApp) */
export interface AppClient { kind: 'web' | 'desktop' | 'mobile'; here: Platform; store: boolean }

const PHONE: Partial<Record<Platform, AppOs>> = { ios: 'iphone', android: 'android' }

/** The edition's store listing, else its download page, else nothing. An Apple build (the Mac App Store build, the
 * iPhone app) links another platform's store only through the page: an Apple app may not name another mobile platform
 * or app marketplace (App Review Guideline 2.3.10). */
export function linkFor(links: AppDownloads, os: AppOs, apple = false): AppAction | null {
  const store = apple && (os === 'android' || os === 'windows') ? '' : links[os]
  return store ? { kind: 'store', href: store } : links.page ? { kind: 'page', href: links.page } : null
}

/** the Mac App Store build or the iPhone app */
export const appleBuild = (c: AppClient) => (c.store && c.kind === 'desktop' && c.here === 'mac') || (c.kind === 'mobile' && c.here === 'ios')

/**
 * The phone apps. In the phone app: one row, "This app". In a phone's browser: only that phone's row. On a computer: the
 * iPhone and Android rows, and `qr`: the download page, for one small QR code (without a page each row shows its own).
 * The Mac App Store build leaves Android out: an Apple app may not name another mobile platform (App Review Guideline
 * 2.3.10); its QR code still leads to the page that has it. Rows with nothing to offer are left out.
 */
export function phoneApps(links: AppDownloads, c: AppClient): { rows: AppRow[]; qr: string | null } {
  const mine = PHONE[c.here]
  if (c.kind === 'mobile') return { rows: mine ? [{ os: mine, action: null, thisApp: true, thisDevice: true }] : [], qr: null }
  const oses: AppOs[] = mine ? [mine] : appleBuild(c) ? ['iphone'] : ['iphone', 'android']
  const rows = oses.flatMap((os): AppRow[] => {
    const action = linkFor(links, os)
    return action ? [{ os, action, thisApp: false, thisDevice: !!mine }] : []
  })
  return { rows, qr: !mine && rows.length && links.page ? links.page : null }
}

/**
 * The desktop apps, Mac then Windows. A Mac with the edition's App Store listing gets only the App Store, everywhere
 * (also on the desktop app from the team server's own row): no installer file from the team server, which is unsigned,
 * brings a macOS security warning and does not update by itself (owner, 2026-11-11). Otherwise a row offers the team
 * server's installers, else the edition's store listing, else its download page. A store build offers no installer
 * file at all (lib/downloads.ts offeredDownloads; the other computer's row is the listing or the page) and its own row
 * is "This app" with the store's line instead of an action. Without a Mac App Store listing (another edition, a
 * self-hosted build) the desktop app from the team server marks its own row "This app" and offers the server's
 * installers there. A browser on a Mac or a Windows PC, and the desktop app, keep this computer's row even with nothing
 * to get (it says the server has no such app). Other rows with nothing to offer are left out; with nothing to get at
 * all the page shows the empty state.
 */
export function computerApps(links: AppDownloads, c: AppClient, files: DownloadItem[]): AppRow[] {
  return (['mac', 'windows'] as const).flatMap((os): AppRow[] => {
    const thisDevice = c.kind !== 'mobile' && c.here === os
    const thisApp = thisDevice && c.kind === 'desktop'
    const listing = c.store && thisApp ? null : linkFor(links, os, appleBuild(c))
    if (os === 'mac' && listing?.kind === 'store') return [{ os, action: listing, thisApp, thisDevice }]
    const items = c.store ? [] : files.filter((d) => d.platform === os)
    const action: AppAction | null = items.length ? { kind: 'files', items } : thisApp ? null : listing
    return action || thisDevice ? [{ os, action, thisApp, thisDevice }] : []
  })
}

/** nothing to get for a computer (only a row saying so): the page shows the server's empty state (and the owner's hint)
 * instead. A store build's own row is something: the store's line. */
export const noComputerApps = (rows: AppRow[], c: Pick<AppClient, 'store'>) => rows.every((r) => !r.action && !(r.thisApp && c.store))
