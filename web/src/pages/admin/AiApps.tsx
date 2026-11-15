// Admin › AI apps: whether outside AI apps such as Claude can use this server through its MCP connector, its address,
// and the same app rows members see (components/integrations/AiAppConnect.tsx). The connector is turned on in the server
// setup (installer --app-connectors, server.json appConnectors with a public host, or MYCEL_REMOTE_MCP_ORIGIN;
// docs/site/agents/mcp-connector.md), so with it off this page shows those settings. It was part of Admin › App connectors.
// A phone (below 768 px): each app is one row to tap (no outline Connect buttons), and the apps that are set up in a
// terminal on a computer (Claude Code, Codex) say so instead of opening their steps. With the connector off, the server
// setup lines to copy are a computer's: the phone says Off and "컴퓨터에서 설정해요" (QA TC-270, ADM-15).
import clsx from 'clsx'
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
import { ConnectionRow, connectionLogo } from '../../components/integrations/ConnectionRow'
import { AdminPageHeader, Loadable, useLoad } from './common'
import { settingDesc, settingName } from '../../components/settings/SettingRow'

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
              {on && remote.resource ? <ConnectorAddress resource={remote.resource} /> : phone ? (
                <div data-testid="ai-apps-on-computer">
                  <p className={settingName}>{t('admin.onComputer')}</p>
                  <p className={clsx('mt-0.5', settingDesc)}>{t('admin.onComputerAiApps')}</p>
                </div>
              ) : <ConnectorOff admin />}
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
        const status = mine.length > 0 && (
          <span className="inline-flex max-w-32 items-center gap-1 truncate text-xs text-ok" data-testid={`ai-app-connected-${app.id}`}>
            <Check size={14} className="shrink-0" aria-hidden />
            <span className="truncate">{app.name ? t('aiApps.connectedBadge') : t('aiApps.connected', { name: mine.join(', ') })}</span>
          </span>
        )
        const open = on && !computer
        return (
          <ConnectionRow key={app.id} testId={`ai-app-${app.id}`} data={{ 'data-computer': computer ? 'true' : undefined }}
            logo={<AiAppLogo app={app} className={connectionLogo} />} name={appName(app, t)} line={computer ? t('admin.onComputer') : t(`aiApps.${app.id}.desc`)}
            whole onOpen={open ? () => onConnect(app) : undefined} openLabel={t('aiApps.connectTitle', { name: appName(app, t) })} openTestId={`ai-app-connect-${app.id}`}
            end={(status || open) && <>{status}{open && <ChevronRight size={16} className="shrink-0 text-faint" aria-hidden />}</>} />
        )
      })}
    </>
  )
}
