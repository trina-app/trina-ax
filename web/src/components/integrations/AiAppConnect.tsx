// AI apps in Settings › App connectors and Admin › App connectors: one row per app this server's MCP connector can take
// (lib/connectors.ts AI_APPS), each with Connect, which opens numbered steps with the real connector address
// (GET /api/connectors/remote `resource`) and Copy. While the dialog is open it asks the same list again every few seconds
// and says "Connected" when a new app appears there; it stops when the dialog closes.
//
// The steps only name what the server supports (docs/site/agents/mcp-connector.md, server/src/connectors/remote-mcp):
// Streamable HTTP at <origin>/mcp, OAuth with dynamic client registration and PKCE, and sign-in callbacks from claude.ai
// or a loopback http://localhost/…/callback. An app with its own web callback (ChatGPT, for example) cannot sign in yet,
// and the generic card says so. Outside apps' menus are worded generically: their screens change and are not checked here.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, ExternalLink, Loader2, Plug } from 'lucide-react'
import { REMOTE_MCP, type RemoteConnectionInfo } from '@mycel/shared/api'
import { PRODUCT, SOURCE_CODE } from '@mycel/shared'
import { api } from '../../lib/api'
import { AI_APPS, aiAppLogo, type AiApp } from '../../lib/connectors'
import { useT } from '../../i18n'
import { Button, IconButton, Modal } from '../ui'
import { LogoTile } from './ConnectorsView'

export const CONNECTOR_GUIDE = `${SOURCE_CODE.repository}/blob/main/docs/site/agents/mcp-connector.md`
/** The name the app shows for this server (Claude Code: `claude mcp add … <name> <url>`). */
export const CONNECTOR_NAME = PRODUCT.artifactBase.toLowerCase()
const POLL_MS = 4000
const POLL_FOR_MS = 10 * 60_000

export const appName = (a: AiApp, t: ReturnType<typeof useT>) => a.name ?? t('aiApps.other.name')

export function AiAppLogo({ app, className }: { app: AiApp; className?: string }) {
  const src = aiAppLogo(app)
  if (src) return <LogoTile src={src} className={className} />
  return <span className={`flex shrink-0 items-center justify-center rounded-lg border border-line bg-subtle text-muted ${className ?? ''}`}><Plug size={16} aria-hidden /></span>
}

/** The names of my connected apps that belong to one row: a named app by its client name (any case), the generic row
 * every other one (Codex, Cursor, ...). Several connections of one app count once. */
export function connectedTo(app: AiApp, items: readonly Pick<RemoteConnectionInfo, 'clientName'>[]): string[] {
  const named = new Set(AI_APPS.flatMap((a) => (a.name ? [a.name.toLowerCase()] : [])))
  const names = items.map((i) => i.clientName.trim()).filter(Boolean)
  const mine = app.name ? names.filter((n) => n.toLowerCase() === app.name!.toLowerCase()) : names.filter((n) => !named.has(n.toLowerCase()))
  const seen = new Set<string>()
  return mine.filter((n) => (seen.has(n.toLowerCase()) ? false : (seen.add(n.toLowerCase()), true)))
}

/** One row per AI app: logo, name, where it runs, "✓ Connected" when I have a connection of it (QA TC-094: Admin › AI apps
 * showed only Connect, also for apps already connected), and Connect (or, with the connector off, nothing: the section
 * says why). Connect stays: another device or account can connect the same app. */
export function AiAppRows({ on, onConnect, connected = [] }: { on: boolean; onConnect: (app: AiApp) => void; connected?: readonly Pick<RemoteConnectionInfo, 'clientName'>[] }) {
  const t = useT()
  return (
    <>
      {AI_APPS.map((app) => {
        const mine = connectedTo(app, connected)
        return (
        <li key={app.id} className="flex items-center gap-3 p-2" data-testid={`ai-app-${app.id}`}>
          <AiAppLogo app={app} className="size-9" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{appName(app, t)}</span>
            <span className="mt-0.5 block truncate text-xs text-muted">{t(`aiApps.${app.id}.desc`)}</span>
          </span>
          {mine.length > 0 && (
            <span className="inline-flex max-w-[45%] shrink-0 items-center gap-1 truncate text-xs text-ok" data-testid={`ai-app-connected-${app.id}`}>
              <Check size={14} className="shrink-0" aria-hidden />
              <span className="truncate">{app.name ? t('aiApps.connectedBadge') : t('aiApps.connected', { name: mine.join(', ') })}</span>
            </span>
          )}
          {on && <Button size="sm" variant={mine.length > 0 ? 'ghost' : undefined} className="shrink-0 max-md:h-11" onClick={() => onConnect(app)} aria-label={t('aiApps.connectTitle', { name: appName(app, t) })} data-testid={`ai-app-connect-${app.id}`}>{t('aiApps.connect')}</Button>}
        </li>
        )
      })}
    </>
  )
}

/** A line to copy: the connector address, a command or a setting. */
export function CopyLine({ text, label, testId }: { text: string; label?: string; testId?: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1500) } catch { /* the text stays selectable */ }
  }
  return (
    <div className="flex items-center gap-2 rounded-xl border border-line bg-subtle px-3 py-2" data-testid={testId}>
      <span className="min-w-0 flex-1">
        {label && <span className="block text-xs text-muted">{label}</span>}
        <code className="block text-sm break-all">{text}</code>
      </span>
      <IconButton label={copied ? t('common.copied') : t('common.copy')} className="shrink-0" onClick={() => void copy()} data-testid={testId ? `${testId}-copy` : undefined}>
        {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
      </IconButton>
    </div>
  )
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line text-xs text-muted" aria-hidden>{n}</span>
      <div className="min-w-0 flex-1 space-y-2 pt-0.5 text-sm">{children}</div>
    </li>
  )
}

/** The steps for one app, the waiting line, and Done. `known` is the connected apps when it opened: a new id in the
 * list is the app that just connected. */
export function AiAppDialog({ app, resource, known, onClose, onConnected }: {
  app: AiApp
  resource: string
  known: string[]
  onClose: () => void
  onConnected?: () => void
}) {
  const t = useT()
  const name = appName(app, t)
  const [connected, setConnected] = useState<RemoteConnectionInfo | null>(null)
  const done = useRef(onConnected)
  done.current = onConnected
  useEffect(() => {
    if (connected) return
    let live = true
    const started = Date.now()
    const before = new Set(known)
    const tick = async () => {
      try {
        const r = await api.call(REMOTE_MCP.listRemoteConnectors)
        const added = r.items.find((x) => !before.has(x.id))
        if (live && added) { setConnected(added); done.current?.() }
      } catch { /* try again on the next tick */ }
    }
    const id = setInterval(() => { if (Date.now() - started > POLL_FOR_MS) clearInterval(id); else void tick() }, POLL_MS)
    return () => { live = false; clearInterval(id) }
    // the known list is read once, when the dialog opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected])
  const command = `claude mcp add --transport http ${CONNECTOR_NAME} ${resource}`
  return (
    <Modal open title={t('aiApps.connectTitle', { name })} onClose={onClose} width={520}
      footer={<div className="flex justify-end"><Button variant={connected ? 'primary' : 'secondary'} onClick={onClose} data-testid="ai-app-done">{t('common.done')}</Button></div>}>
      <div className="space-y-4" data-testid="ai-app-dialog" data-app={app.id}>
        <div className="flex items-start gap-3">
          <AiAppLogo app={app} className="size-10" />
          <p className="text-sm text-muted">{t('aiApps.intro', { name })}</p>
        </div>
        <ol className="space-y-4" data-testid="ai-app-steps">
          {app.id === 'claude' && (
            <>
              <Step n={1}><p>{t('aiApps.claude.step1')}</p><CopyLine text={resource} testId="ai-app-address" /></Step>
              <Step n={2}><p>{t('aiApps.claude.step2')}</p><p className="text-xs text-muted">{t('aiApps.claude.step2Hint')}</p></Step>
              <Step n={3}><p>{t('aiApps.claude.step3')}</p></Step>
            </>
          )}
          {app.id === 'claude-code' && (
            <>
              <Step n={1}><p>{t('aiApps.claude-code.step1')}</p><CopyLine text={command} testId="ai-app-command" /></Step>
              <Step n={2}><p>{t('aiApps.claude-code.step2', { server: CONNECTOR_NAME })}</p><CopyLine text="/mcp" testId="ai-app-mcp" /></Step>
              <Step n={3}><p>{t('aiApps.claude-code.step3')}</p></Step>
            </>
          )}
          {app.id === 'other' && (
            <>
              <Step n={1}><p>{t('aiApps.other.step1')}</p><CopyLine text={resource} testId="ai-app-address" /></Step>
              <Step n={2}><p>{t('aiApps.other.step2')}</p><p className="text-xs text-muted" data-testid="ai-app-limit">{t('aiApps.other.limit')}</p></Step>
            </>
          )}
        </ol>
        <p role="status" aria-live="polite" className="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm" data-testid="ai-app-status" data-state={connected ? 'connected' : 'waiting'}>
          {connected
            ? <><Check size={15} className="shrink-0 text-ok" aria-hidden />{t('aiApps.connected', { name: connected.clientName })}</>
            : <><Loader2 size={15} className="shrink-0 animate-spin text-muted motion-reduce:animate-none" aria-hidden /><span className="text-muted">{t('aiApps.waiting')}</span></>}
        </p>
      </div>
    </Modal>
  )
}

/** The connector is off. Members: one line. Owners and admins: the three ways to turn it on, each with Copy, and the guide. */
export function ConnectorOff({ admin }: { admin: boolean }) {
  const t = useT()
  if (!admin) return <p className="text-xs text-muted" data-testid="ai-apps-off">{t('aiApps.off')}</p>
  return (
    <div className="space-y-2" data-testid="ai-apps-setup">
      <p className="text-xs text-muted">{t('aiApps.offAdmin')}</p>
      <CopyLine label={t('aiApps.setup.installer')} text="--public-host HOST --app-connectors" testId="ai-apps-setup-installer" />
      <CopyLine label={t('aiApps.setup.serverJson')} text={'"appConnectors": true'} testId="ai-apps-setup-json" />
      <CopyLine label={t('aiApps.setup.env')} text={`${PRODUCT.envPrefix}REMOTE_MCP_ORIGIN=https://team.example.com`} testId="ai-apps-setup-env" />
      <a href={CONNECTOR_GUIDE} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-accent-text hover:underline" data-testid="ai-apps-guide">
        {t('appConnectors.guide')}
        <ExternalLink size={12} aria-hidden />
      </a>
    </div>
  )
}
