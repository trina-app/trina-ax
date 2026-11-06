// Settings › App connectors: the apps this server's AI can use with the person's own account, as cards
// (lib/connectors.ts APP_CONNECTORS): for now Google Drive (components/integrations/DriveConnector.tsx), whose Connect goes
// straight to Google. Outside AI apps that use this server (Claude, Claude Code) are a section of their own: Settings ›
// AI apps (pages/AiApps.tsx). ?drive=1 (the old /settings/drive, a notice) brings the Drive card into view.
import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { APP_CONNECTORS } from '../lib/connectors'
import { useT } from '../i18n'
import { DriveCard } from '../components/integrations/DriveConnector'
import { useDriveConnection } from '../components/settings/DriveConnection'
import { SlackAccount } from '../components/settings/SlackAccount'

export default function ConnectorConnections() {
  const t = useT()
  const drive = useDriveConnection()
  const grid = useRef<HTMLUListElement>(null)
  const [params, setParams] = useSearchParams()
  useEffect(() => {
    // wait for the card's state, so its Connect (or Reconnect) is there to focus
    if (params.get('drive') !== '1' || (!drive.connection && !drive.loadFailed)) return
    const card = grid.current?.querySelector<HTMLElement>('[data-testid="drive-card"]')
    card?.scrollIntoView({ block: 'nearest' })
    card?.querySelector<HTMLElement>('button:not([disabled])')?.focus()
    setParams((p) => { p.delete('drive'); return p }, { replace: true })
  }, [params, setParams, drive.connection, drive.loadFailed])

  return (
    <section className="space-y-4" data-testid="connector-connections">
      <div><h2 className="text-base font-semibold">{t('connectors.title')}</h2><p className="mt-1 text-sm text-muted">{t('connectors.description')}</p></div>
      <ul ref={grid} className="grid gap-3 sm:grid-cols-2" data-testid="app-connectors">
        {APP_CONNECTORS.map((a) => (a.id === 'google-drive' ? <DriveCard key={a.id} s={drive} /> : null))}
      </ul>
      {/* Slack (main's Slack connector): the person's own Slack link, under the app cards; its sign-in comes back here (?slack=) */}
      <SlackAccount />
    </section>
  )
}
