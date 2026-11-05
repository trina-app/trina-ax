// Admin › App connectors: whether this server offers each app connector, and what members see. Both are set in the
// server's own setup, not here, so this page shows their state and the guide instead of a switch:
//  - Google Drive needs a Google client (docs/GOOGLE-DRIVE.md); each person then links their own account in
//    Settings › App connectors (GET /api/integrations/google-drive says whether the server has one).
//  - AI apps such as Claude use the server's MCP connector (installer --app-connectors, server.json appConnectors with a
//    public host, or MYCEL_REMOTE_MCP_ORIGIN; docs/site/agents/mcp-connector.md); GET /api/connectors/remote says whether
//    it is on and its address. Per-member counts of connected apps are not in the API, so they are not shown.
import { useState } from 'react'
import { ExternalLink, Plug } from 'lucide-react'
import { REMOTE_MCP } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import type { AiApp } from '../../lib/connectors'
import { useT } from '../../i18n'
import { Badge } from '../../components/ui'
import { DRIVE_SETUP_GUIDE, DriveLogo } from '../../components/integrations/DriveConnector'
import { AiAppDialog, AiAppRows, CONNECTOR_GUIDE, ConnectorOff } from '../../components/integrations/AiAppConnect'
import { ConnectorAddress } from '../ConnectorConnections'
import { AdminPageHeader, Loadable, useLoad } from './common'

export default function AppConnectors() {
  const t = useT()
  const [openApp, setOpenApp] = useState<AiApp | null>(null)
  const state = useLoad(async () => {
    const [remote, drive] = await Promise.all([api.call(REMOTE_MCP.listRemoteConnectors), api.call(API.myDriveConnection)])
    return { remote, drive }
  })
  return (
    <>
      <AdminPageHeader title={t('connectors.title')} desc={t('appConnectors.adminDesc')} testId="app-connectors-header" />
      <Loadable state={state} lines={4}>
        {({ remote, drive }) => (
          <>
            <ul className="-mx-2 divide-y divide-line" data-testid="admin-app-connectors">
              <li className="flex flex-col gap-2 p-2 sm:flex-row sm:items-start sm:gap-3" data-testid="admin-drive" data-on={drive.configured ? 'true' : 'false'}>
                <DriveLogo className="size-9" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    Google Drive
                    <Badge tone={drive.configured ? 'ok' : 'neutral'}>{t(drive.configured ? 'appConnectors.setUp' : 'appConnectors.notSetUp')}</Badge>
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{t('appConnectors.driveMembers')}</p>
                  {!drive.configured && <p className="mt-0.5 text-xs text-muted">{t('appConnectors.driveOff')}</p>}
                </div>
                <Guide href={DRIVE_SETUP_GUIDE} testId="admin-drive-guide" />
              </li>
              <li className="flex flex-col gap-2 p-2 sm:flex-row sm:items-start sm:gap-3" data-testid="admin-ai-apps" data-on={remote.configured ? 'true' : 'false'}>
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-subtle text-muted"><Plug size={16} aria-hidden /></span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {t('appConnectors.appsName')}
                    <Badge tone={remote.configured ? 'ok' : 'neutral'}>{t(remote.configured ? 'appConnectors.on' : 'appConnectors.off')}</Badge>
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{t(remote.configured ? 'appConnectors.appsMembers' : 'appConnectors.appsOff')}</p>
                  {remote.configured && remote.resource && <div className="mt-2"><ConnectorAddress resource={remote.resource} /></div>}
                  {!(remote.configured && remote.resource) && <div className="mt-2"><ConnectorOff admin /></div>}
                  <ul className="mt-2 -mx-2 divide-y divide-line" data-testid="admin-ai-app-list">
                    <AiAppRows on={remote.configured && !!remote.resource} onConnect={setOpenApp} />
                  </ul>
                  {openApp && remote.resource && <AiAppDialog app={openApp} resource={remote.resource} known={remote.items.map((x) => x.id)} onClose={() => setOpenApp(null)} />}
                </div>
                <Guide href={CONNECTOR_GUIDE} testId="admin-ai-apps-guide" />
              </li>
            </ul>
            <p className="mt-4 text-xs text-faint">{t('appConnectors.serverSetup')}</p>
          </>
        )}
      </Loadable>
    </>
  )
}

function Guide({ href, testId }: { href: string; testId: string }) {
  const t = useT()
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 self-start rounded-lg px-2 py-1 text-xs font-medium text-accent-text hover:bg-hover hover:underline sm:ml-auto" data-testid={testId}>
      {t('appConnectors.guide')}
      <ExternalLink size={12} aria-hidden />
    </a>
  )
}
