// In the desktop app a download goes straight into the computer's Downloads folder, with no save window (the desktop
// app's main/downloads.ts, docs/decisions/20261117-desktop-direct-downloads.md). This page says so with its usual
// notice: "Saved to Downloads" + the name, and one action, "Show in folder" (the app opens the folder; the page gives
// the download's number, never a path). A download that failed says so. The app saves this way only once the page
// listens here; in a browser, the Mac App Store build or an older desktop app nothing changes.
import { t } from '../i18n'
import { toast } from '../store/ui'
import { desktop, type DesktopBridge } from './desktop'

export function initDesktopDownloads(bridge: DesktopBridge | null = desktop()): () => void {
  const downloads = bridge?.downloads
  if (!downloads) return () => {}
  return downloads.onDone((d) => {
    const name = String(d?.name ?? '').slice(0, 300)
    if (d?.ok) toast({ level: 'info', text: t('desktopDownload.saved'), detail: name, ms: 8000, action: { label: t('desktopDownload.show'), run: () => downloads.show(d.id) } })
    else toast({ level: 'error', text: t('desktopDownload.failed', { name }) })
  })
}
