// Settings → Apps: the desktop installers the team server offers (/downloads/index.json, signed-in people only;
// the owner adds them with `teamax desktop add`, server/src/office/desktop.ts) and what to click while installing.
import type { MessageKey } from '../i18n'
import type { Platform } from './pwa'

export interface DownloadItem { platform: 'mac' | 'windows'; file: string; version: string; size?: number; signed?: boolean; arch?: 'universal' | 'arm64' | 'x64' }

/** index.json's items that can be shown (anything else in the file is ignored) */
export function parseDownloads(raw: unknown): DownloadItem[] {
  const items = (raw as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return []
  return items.filter((i): i is DownloadItem => !!i && typeof i === 'object' && (i.platform === 'mac' || i.platform === 'windows') && typeof i.file === 'string' && i.file !== '' && typeof i.version === 'string')
}

/** this computer's platform first, the server's order otherwise */
export function orderDownloads(items: DownloadItem[], here: Platform): DownloadItem[] {
  return items.map((d, i) => ({ d, i })).sort((a, b) => Number(b.d.platform === here) - Number(a.d.platform === here) || a.i - b.i).map((x) => x.d)
}

/** The install steps under a download. Unless the server verified the signature (`signed`: osslsigncode / Gatekeeper
 * passed, not merely a signature being there) the steps include the one warning the system shows the first time:
 * Windows SmartScreen ("More info → Run anyway"), macOS Gatekeeper (System Settings → Privacy & Security → Open
 * Anyway; macOS 15 no longer offers right-click → Open). */
export function installSteps(d: Pick<DownloadItem, 'platform' | 'signed'>): MessageKey[] {
  if (d.platform === 'windows') return d.signed ? ['apps.winHow'] : ['apps.winHow', 'apps.winSmartScreen']
  return d.signed ? ['apps.macHow'] : ['apps.macHow', 'apps.macGatekeeper']
}

/** A Mac disk image built for one kind of Mac only (the name says -mac-arm64 / -mac-x64): shown next to the button. */
export function archNote(d: Pick<DownloadItem, 'platform' | 'arch' | 'file'>): MessageKey | null {
  if (d.platform !== 'mac') return null
  const arch = d.arch ?? (/arm64|aarch64/i.test(d.file) ? 'arm64' : /(x64|x86_64|intel)/i.test(d.file) && !/universal/i.test(d.file) ? 'x64' : undefined)
  return arch === 'arm64' ? 'apps.macArm64Only' : arch === 'x64' ? 'apps.macIntelOnly' : null
}

/** with several versions of one platform offered (--keep), the steps are shown once, under the first */
export function showSteps(list: Pick<DownloadItem, 'platform' | 'file'>[], d: Pick<DownloadItem, 'platform' | 'file'>): boolean {
  return list.find((x) => x.platform === d.platform)?.file === d.file
}
