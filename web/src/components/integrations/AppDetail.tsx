// A built-in connector's own page (/connectors/<id>: Google Drive, Gmail, Google Calendar, Google Docs, Google Sheets),
// kept simple like Claude's connector page: "Connectors › Gmail" on top, the logo, the name and one line ("By Google ·
// Read and manage Gmail") with the one status or action and ⋯ on the right, the sign-in line under it while one is under
// way, then the About text, one line on what the AI may do, every tool as a chip, and a small details block (made by,
// category, sign-in, privacy). Fewer boxes, the same facts. What the person does with it (Connect, the account to
// confirm, ⋯ with Settings, Reconnect, Disconnect) comes from the caller: GoogleAppConnector.tsx and pages/Connectors.tsx.
// Admin › Connectors shows the same page (GoogleAdminPage.tsx) inside its own column (`embedded`), its way back to
// Admin's list (`list`), and the team's settings under the details (`children`).
import { ChevronRight, ExternalLink, PenLine } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useT } from '../../i18n'
import { Tooltip } from '../Tooltip'
import { LogoTile } from './ConnectorsView'

export interface AppTool { name: string; title: string; description?: string; changes: boolean }

const label = 'text-micro font-semibold tracking-wide text-faint uppercase'

export function AppDetail({ testId, state, logo, name, byLine, actions, status, about, canChange, asks, developer, category, signIn, links, tools, list, embedded, children }: {
  testId: string
  /** for tests: what the page shows (connected, disconnected, flow-pending, …) */
  state: string
  logo: string
  name: string
  byLine: string
  /** the status or action on the right of the name, and ⋯ */
  actions?: ReactNode
  /** lines under the header: the account, a sign-in under way, why it cannot be connected */
  status?: ReactNode
  about: string
  /** the AI may change or send something with it (else it only reads) */
  canChange: boolean
  /** with canChange: whether it asks first ("ask"), or the person chose Always allow */
  asks?: 'ask' | 'allow'
  developer: string
  category: string
  /** the account the person signs in with ("Google") */
  signIn: string
  /** the sign-in's owner and its privacy policy and terms (what the person agrees to at its sign-in) */
  links?: { by: string; privacy: string; terms: string }
  tools: AppTool[]
  /** the list it belongs to, for the way back (default: Connectors) */
  list?: { to: string; name: string }
  /** inside a page that has its own column and scrolling (Admin) */
  embedded?: boolean
  /** under the details: Admin's team settings */
  children?: ReactNode
}) {
  const t = useT()
  const titleId = useId()
  const toolsId = useId()
  const page = (
      <article aria-labelledby={titleId} className={embedded ? 'w-full max-w-3xl space-y-6 pb-10' : 'mx-auto w-full max-w-3xl space-y-6 px-4 pt-4 pb-10 sm:px-6 sm:pt-6'} data-testid={testId} data-state={state}>
        <div>
          {/* phones: the top bar names the list and has its way back */}
          <nav aria-label={t('gapps.breadcrumb')} className="mb-5 flex min-w-0 items-center gap-1 text-sm text-muted max-md:hidden" data-testid="app-breadcrumb">
            <Link to={list?.to ?? '/connectors'} className="rounded hover:text-ink hover:underline" data-testid="app-breadcrumb-connectors">{list?.name ?? t('integrations.title')}</Link>
            <ChevronRight size={14} aria-hidden className="shrink-0 text-faint" />
            <span aria-current="page" className="truncate text-ink">{name}</span>
          </nav>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <LogoTile src={logo} className="size-14 rounded-2xl p-2.5" />
            <div className="min-w-0 flex-[1_1_12rem]">
              <h1 id={titleId} className="truncate text-2xl font-semibold tracking-tight">{name}</h1>
              <p className="mt-0.5 text-sm text-muted" data-testid="app-by">{byLine}</p>
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2 max-sm:w-full max-sm:[&>button:first-child]:flex-1" data-testid="app-actions">{actions}</div>}
          </div>
          {status && <div className="mt-4 space-y-2">{status}</div>}
        </div>

        <div className="space-y-2">
          <p className="text-sm leading-relaxed text-ink/90" data-testid="app-about">{about}</p>
          <p className="text-sm text-muted" data-testid="app-abilities" data-can-change={canChange ? 'yes' : 'no'}>
            {!canChange ? t('gapps.readOnlyLine') : asks === 'allow' ? t('gapps.changeAllowLine') : t('gapps.changeAskLine')}
          </p>
        </div>

        {tools.length > 0 && (
          <section aria-labelledby={toolsId}>
            <h2 id={toolsId} className="mb-2.5 text-sm font-semibold">{t('gapps.tools')}</h2>
            <ul className="flex flex-wrap gap-2" data-testid="app-tools">
              {tools.map((x) => {
                // what it does, and that it changes things: the tooltip on hover and on keyboard focus (the chip takes
                // focus when it has one), and screen-reader text inside the chip (touch has no tooltip)
                const tip = [x.changes ? t('gapps.changesTag') : '', x.description ?? ''].filter(Boolean).join(' · ')
                const chip = (
                  <span tabIndex={tip ? 0 : undefined} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-subtle px-3 py-1 text-label" data-testid="app-tool-chip">
                    <span className="truncate">{x.title || x.name}</span>
                    {x.changes && (
                      <span className="inline-flex shrink-0 text-warn" data-testid="app-tool-changes">
                        <PenLine size={12} aria-hidden />
                        <span className="sr-only">{t('gapps.changesTag')}</span>
                      </span>
                    )}
                    {x.description && <span className="sr-only" data-testid="app-tool-description">{x.description}</span>}
                  </span>
                )
                return (
                  <li key={x.name} className="flex max-w-full" data-testid="app-tool" data-name={x.name}>
                    {tip ? <Tooltip label={tip} description>{chip}</Tooltip> : chip}
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-5 text-sm" data-testid="app-info">
          <Detail label={t('gapps.developer')}>{developer}</Detail>
          <Detail label={t('gapps.category')}>{category}</Detail>
          <Detail label={t('gapps.signIn')}>{signIn}</Detail>
          {links && (
            <Detail label={t('gapps.privacy')}>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <ExtLink href={links.privacy} name={t('gapps.privacyName', { by: links.by })} testId="app-privacy">{links.by}</ExtLink>
                <span aria-hidden className="text-faint">·</span>
                <ExtLink href={links.terms} name={t('gapps.termsName', { by: links.by })} testId="app-terms">{t('gapps.terms')}</ExtLink>
              </span>
            </Detail>
          )}
        </dl>

        {children}
      </article>
  )
  return embedded ? page : <div className="flex h-full flex-col overflow-y-auto">{page}</div>
}

function Detail({ label: name, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={label}>{name}</dt>
      <dd className="mt-1 min-w-0 break-words">{children}</dd>
    </div>
  )
}

/** a phone: a 44 px tap, still a text link (QA TC-262). `name`: what a screen reader says it opens ("Google privacy
 * policy"), as the visible words alone ("Google", "Terms") do not. */
function ExtLink({ href, name, testId, children }: { href: string; name: string; testId: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={name} className="inline-flex items-center gap-1 text-accent-text hover:underline max-md:min-h-11 max-md:min-w-11" data-testid={testId}>
      {children} <ExternalLink size={12} aria-hidden />
    </a>
  )
}
