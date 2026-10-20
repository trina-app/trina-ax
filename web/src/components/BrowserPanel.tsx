// The "Browser" entry of the side panel. In the desktop app the in-app browser is a pane the desktop app draws next
// to this page (its own tabs, address bar and site prompts, lib/desktop.ts), so this panel only exists outside it:
// it explains where the browser tools work.
import { X } from 'lucide-react'
import { useEffect } from 'react'
import { desktop } from '../lib/desktop'
import { useT } from '../i18n'
import { IconButton } from './ui'

export default function BrowserPanel({ onClose }: { onClose: () => void }) {
  const t = useT()
  const app = desktop()
  useEffect(() => {
    // in the desktop app: open the real pane instead and get out of the way
    if (app) {
      app.pane.open()
      onClose()
    }
  }, [app, onClose])
  if (app) return null
  return (
    <aside className="flex h-full flex-col bg-surface">
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-sm font-semibold">{t('browser.title')}</span>
        <IconButton label={t('common.close')} onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      <p className="p-6 text-sm text-muted">{t('browser.desktopOnly')}</p>
    </aside>
  )
}
