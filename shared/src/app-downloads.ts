// Where people get this product's apps: Settings › Apps (web/src/lib/apps.ts) shows them. An edition with apps of its own
// sets them in editions/<name>/branding/apps.json, and `bun scripts/edition-apps.ts editions/<name>/branding/apps.json
// --apply` writes them here; never by hand. '' means the edition has none: a row falls back to `page`, and with no page
// either it is left out (a self-hosted build shows only its team server's own installers).
// The website's download page keeps its own copy of these links; change both when a store listing changes.
/** each an https address, or '' for none */
export interface AppDownloads { page: string; iphone: string; android: string; mac: string; windows: string }

export const APP_DOWNLOADS: AppDownloads = {
  /** one web page with every app; a computer shows its QR code for phones */
  page: 'https://ax.trina.app/download',
  /** the phone app's App Store listing */
  iphone: 'https://apps.apple.com/app/trina-ax/id6829192435?platform=iphone',
  /** the phone app's Google Play listing (also where the join pages' "Get the app" and Android's "Open in the app"
   * fallback lead: web/src/lib/team-link.ts getAppHref) */
  android: 'https://play.google.com/store/apps/details?id=app.trina.ax',
  /** the desktop app's Mac App Store listing */
  mac: 'https://apps.apple.com/app/trina-ax/id6829192435?platform=mac',
  /** the desktop app's Microsoft Store listing */
  windows: '',
}
