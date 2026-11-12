// Admin › AI apps: whether outside AI apps such as Claude can use this server through its MCP connector, its address,
// and the same app rows members see (components/integrations/AiAppConnect.tsx). The connector is turned on in the server
// setup (installer --app-connectors, server.json appConnectors with a public host, or MYCEL_REMOTE_MCP_ORIGIN;
// docs/site/agents/mcp-connector.md), so with it off this page shows those settings. It was part of Admin › App connectors.
// A phone (below 768 px): each app is one row to tap (no outline Connect buttons), and the apps that are set up in a
// terminal on a computer (Claude Code, Codex) say so instead of opening their steps.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, ChevronRight, ExternalLink } from 'lucide-react'
import { REMOTE_MCP, type RemoteConnectionInfo } from '@mycel/shared/api'
import { api } from '../../lib/api'
import { AI_APPS, type AiApp } from '../../lib/connectors'
import { useT } from '../../i18n'
import { Badge, useMediaQuery } from '../../components/ui'
import { AiAppDialog, AiAppLogo, AiAppRows, appName, CONNECTOR_GUIDE, connectedTo, ConnectorOff } from '../../components/integrations/AiAppConnect'
import { ConnectorAddress } from '../AiApps'
import { AdminPageHeader, Loadable, useLoad } from './common'

export default function AdminAiApps() {
  const t = useT()
  const [openApp, setOpenApp] = useState<AiApp | null>(null)
  const state = useLoad(() => api.call(REMOTE_MCP.listRemoteConnectors))
  const phone = useMediaQuery('(max-width: 767.98px)')
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
                <a href={CONNECTOR_GUIDE} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-accent-text hover:underline max-md:min-h-11" data-testid="admin-ai-apps-guide">
                  {t('appConnectors.guide')}<ExternalLink size={12} aria-hidden />
                </a>
              </p>
              {on && remote.resource ? <ConnectorAddress resource={remote.resource} /> : <ConnectorOff admin />}
              {phone
                ? <ul className="divide-y divide-line border-y border-line" data-testid="admin-ai-app-list"><PhoneAppRows on={on} onConnect={setOpenApp} connected={remote.items} /></ul>
                : <ul className="-mx-2 divide-y divide-line" data-testid="admin-ai-app-list"><AiAppRows on={on} onConnect={setOpenApp} connected={remote.items} /></ul>}
              {/* my own connections: the list with Disconnect stays in Settings › AI apps; here one line says how many */}
              {remote.items.length > 0 && (
                <p className="text-xs text-muted" data-testid="admin-ai-apps-mine">
                  {t('aiApps.mineSummary', { n: remote.items.length, names: [...new Set(remote.items.map((x) => x.clientName))].join(', ') })}{' '}
                  <Link to="/settings/ai-apps" className="text-accent-text hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center" data-testid="admin-ai-apps-manage">{t('aiApps.manage')}</Link>
                </p>
              )}
              {openApp && remote.resource && <AiAppDialog app={openApp} resource={remote.resource} known={remote.items.map((x) => x.id)} onClose={() => setOpenApp(null)} />}
            </div>
          )
        }}
      </Loadable>
    </>
  )
}

/** Apps that connect from a terminal on a computer (a loopback sign-in there): not something to do on a phone. */
const ON_COMPUTER: readonly AiApp['id'][] = ['claude-code', 'codex']

/** A phone's rows: the logo, the name and its line, connected or not; the row opens the app's steps (with the
 * connector on), or says it is set up on a computer. */
function PhoneAppRows({ on, onConnect, connected }: { on: boolean; onConnect: (app: AiApp) => void; connected: readonly Pick<RemoteConnectionInfo, 'clientName'>[] }) {
  const t = useT()
  return (
    <>
      {AI_APPS.map((app) => {
        const mine = connectedTo(app, connected)
        const computer = ON_COMPUTER.includes(app.id)
        const body = (
          <>
            <AiAppLogo app={app} className="size-9" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{appName(app, t)}</span>
              <span className="mt-0.5 block truncate text-xs text-muted">{computer ? t('admin.onComputer') : t(`aiApps.${app.id}.desc`)}</span>
            </span>
            {mine.length > 0 && (
              <span className="inline-flex max-w-[40%] shrink-0 items-center gap-1 truncate text-xs text-ok" data-testid={`ai-app-connected-${app.id}`}>
                <Check size={14} className="shrink-0" aria-hidden />
                <span className="truncate">{app.name ? t('aiApps.connectedBadge') : t('aiApps.connected', { name: mine.join(', ') })}</span>
              </span>
            )}
          </>
        )
        return (
          <li key={app.id} data-testid={`ai-app-${app.id}`} data-computer={computer || undefined}>
            {on && !computer ? (
              <button type="button" className="flex min-h-14 w-full items-center gap-3 py-2 text-left -outline-offset-2 hover:bg-hover" onClick={() => onConnect(app)} aria-label={t('aiApps.connectTitle', { name: appName(app, t) })} data-testid={`ai-app-connect-${app.id}`}>
                {body}
                <ChevronRight size={16} className="shrink-0 text-faint" aria-hidden />
              </button>
            ) : (
              <div className="flex min-h-14 items-center gap-3 py-2">{body}</div>
            )}
          </li>
        )
      })}
    </>
  )
}
