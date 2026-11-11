// A built-in connector's own page (/connectors/<id>: Google Drive, Gmail, Google Calendar, Google Docs, Google Sheets),
// in the style of an app store's page: "Connectors › Gmail" on top, the logo, the name and one line ("By Google · Read
// and manage Gmail") with the main action on the right, then three things to try (each starts a new chat with it), About,
// what the AI can do, Information, and the tools behind "Show all tools". What the person does with it (Connect, the
// account to confirm, Try in chat, Settings, ⋯) comes from the caller: GoogleAppConnector.tsx and pages/Connectors.tsx.
import { ChevronRight, ExternalLink, Eye, MessageSquare, PenLine } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useT } from '../../i18n'
import { LogoTile } from './ConnectorsView'

export interface AppTool { name: string; title: string; description?: string; changes: boolean }

const h2 = 'mb-2 text-base font-semibold tracking-tight'

export function AppDetail({ testId, state, logo, name, byLine, actions, status, examples, onExample, about, canChange, asks, developer, category, links, tools }: {
  testId: string
  /** for tests: what the page shows (connected, disconnected, flow-pending, …) */
  state: string
  logo: string
  name: string
  byLine: string
  /** the main action(s) on the right of the name */
  actions?: ReactNode
  /** lines under the header: the account, a sign-in under way, why it cannot be connected */
  status?: ReactNode
  examples: string[]
  onExample: (text: string) => void
  about: string
  /** the AI may change or send something with it (else it only reads) */
  canChange: boolean
  /** with canChange: whether it asks first ("ask"), or the person chose Always allow */
  asks?: 'ask' | 'allow'
  developer: string
  category: string
  links?: { privacy: string; terms: string }
  tools: AppTool[]
}) {
  const t = useT()
  const titleId = useId()
  const toolsId = useId()
  const [allTools, setAllTools] = useState(false)
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <article aria-labelledby={titleId} className={`mx-auto w-full max-w-4xl space-y-8 px-4 pt-4 pb-10 sm:px-6 sm:pt-6`} data-testid={testId} data-state={state}>
        <div>
          {/* phones: the top bar names the list and has its way back */}
          <nav aria-label={t('gapps.breadcrumb')} className="mb-5 flex min-w-0 items-center gap-1 text-sm text-muted max-md:hidden" data-testid="app-breadcrumb">
            <Link to="/connectors" className="rounded hover:text-ink hover:underline" data-testid="app-breadcrumb-connectors">{t('integrations.title')}</Link>
            <ChevronRight size={14} aria-hidden className="shrink-0 text-faint" />
            <span aria-current="page" className="truncate text-ink">{name}</span>
          </nav>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <LogoTile src={logo} className="size-16 rounded-2xl p-3" />
            <div className="min-w-0 flex-[1_1_12rem]">
              <h1 id={titleId} className="truncate text-2xl font-semibold tracking-tight">{name}</h1>
              <p className="mt-0.5 text-sm text-muted" data-testid="app-by">{byLine}</p>
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2 max-sm:w-full max-sm:[&>button:first-child]:flex-1" data-testid="app-actions">{actions}</div>}
          </div>
          {status && <div className="mt-4 space-y-2">{status}</div>}
        </div>

        <section aria-label={t('gapps.tryTitle')} className="rounded-2xl bg-subtle p-4 sm:p-5" data-testid="app-examples">
          <h2 className="mb-3 text-sm font-medium text-muted">{t('gapps.tryTitle')}</h2>
          <ul className="grid gap-2 sm:grid-cols-3 sm:gap-3">
            {examples.map((x) => (
              <li key={x}>
                <button type="button" onClick={() => onExample(x)} className="flex h-full w-full items-center justify-between gap-3 rounded-xl border border-line bg-surface p-3 text-left text-sm leading-snug transition hover:border-field-border hover:bg-hover sm:flex-col sm:items-start" data-testid="app-example">
                  <span>{x}</span>
                  <MessageSquare size={14} className="shrink-0 text-faint" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className={h2}>{t('gapps.about')}</h2>
          <p className="max-w-3xl text-sm leading-relaxed text-ink/90" data-testid="app-about">{about}</p>
        </section>

        <section>
          <h2 className={h2}>{t('gapps.canDo')}</h2>
          <div className="flex items-start gap-3 rounded-xl border border-line p-3" data-testid="app-abilities" data-can-change={canChange ? 'yes' : 'no'}>
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-subtle text-muted">
              {canChange ? <PenLine size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t(canChange ? 'gapps.readChange' : 'gapps.readOnly')}</span>
              <span className="mt-0.5 block text-xs text-muted">
                {!canChange ? t('gapps.readOnlyLine') : asks === 'allow' ? t('gapps.changeAllowLine') : t('gapps.changeAskLine')}
              </span>
            </span>
          </div>
        </section>

        <section>
          <h2 className={h2}>{t('gapps.info')}</h2>
          <dl className="divide-y divide-line rounded-xl border border-line text-sm" data-testid="app-info">
            <InfoRow label={t('gapps.developer')}>{developer}</InfoRow>
            <InfoRow label={t('gapps.category')}>{category}</InfoRow>
            {links && (
              <>
                <InfoRow label={t('gapps.privacy')}><ExtLink href={links.privacy}>{t('gapps.privacyLink')}</ExtLink></InfoRow>
                <InfoRow label={t('gapps.terms')}><ExtLink href={links.terms}>{t('gapps.termsLink')}</ExtLink></InfoRow>
              </>
            )}
          </dl>
          {tools.length > 0 && (
            <div className="mt-4">
              <button type="button" className="text-sm font-medium text-accent-text hover:underline" aria-expanded={allTools} aria-controls={toolsId} onClick={() => setAllTools((v) => !v)} data-testid="app-tools-toggle">
                {allTools ? t('gapps.hideTools') : t('gapps.showTools', { count: tools.length })}
              </button>
              <ul id={toolsId} hidden={!allTools} className="mt-3 divide-y divide-line rounded-xl border border-line" data-testid="app-tools">
                {tools.map((x) => (
                  <li key={x.name} className="px-3 py-2.5" data-testid="app-tool" data-name={x.name}>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{x.title || x.name}</span>
                      {x.changes && <span className="rounded-full bg-warn-soft px-1.5 py-px text-micro font-medium text-warn" data-testid="app-tool-changes">{t('gapps.changesTag')}</span>}
                    </span>
                    {x.description && <span className="mt-0.5 line-clamp-3 block text-xs text-muted">{x.description}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </article>
    </div>
  )
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2.5">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-right max-sm:text-left">{children}</dd>
    </div>
  )
}

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-text hover:underline">
      {children} <ExternalLink size={12} aria-hidden />
    </a>
  )
}
