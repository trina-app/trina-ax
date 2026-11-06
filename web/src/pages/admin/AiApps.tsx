// Admin › AI apps: whether outside AI apps such as Claude can use this server through its MCP connector, its address,
// and the same app rows members see (components/integrations/AiAppConnect.tsx). The connector is turned on in the server
// setup (installer --app-connectors, server.json appConnectors with a public host, or MYCEL_REMOTE_MCP_ORIGIN;
// docs/site/agents/mcp-connector.md), so with it off this page shows those settings. It was part of Admin › App connectors.
import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { REMOTE_MCP } from '@mycel/shared/api'
import { api } from '../../lib/api'
import type { AiApp } from '../../lib/connectors'
import { useT } from '../../i18n'
import { Badge } from '../../components/ui'
import { AiAppDialog, AiAppRows, CONNECTOR_GUIDE, ConnectorOff } from '../../components/integrations/AiAppConnect'
import { ConnectorAddress } from '../AiApps'
import { AdminPageHeader, Loadable, useLoad } from './common'

export default function AdminAiApps() {
  const t = useT()
  const [openApp, setOpenApp] = useState<AiApp | null>(null)
  const state = useLoad(() => api.call(REMOTE_MCP.listRemoteConnectors))
  return (
    <>
      <AdminPageHeader title={t('aiApps.title')} desc={t('aiApps.adminDesc')} testId="admin-ai-apps-header" />
      <Loadable state={state} lines={3}>
        {(remote) => {
          const on = remote.configured && !!remote.resource
          return (
            <div className="space-y-3" data-testid="admin-ai-apps" data-on={String(remote.configured)}>
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={remote.configured ? 'ok' : 'neutral'}>{t(remote.configured ? 'appConnectors.on' : 'appConnectors.off')}</Badge>
                <a href={CONNECTOR_GUIDE} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-accent-text hover:underline" data-testid="admin-ai-apps-guide">
                  {t('appConnectors.guide')}<ExternalLink size={12} aria-hidden />
                </a>
              </p>
              {on && remote.resource ? <ConnectorAddress resource={remote.resource} /> : <ConnectorOff admin />}
              <ul className="-mx-2 divide-y divide-line" data-testid="admin-ai-app-list"><AiAppRows on={on} onConnect={setOpenApp} /></ul>
              {openApp && remote.resource && <AiAppDialog app={openApp} resource={remote.resource} known={remote.items.map((x) => x.id)} onClose={() => setOpenApp(null)} />}
            </div>
          )
        }}
      </Loadable>
    </>
  )
}
