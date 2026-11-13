// A built-in connector's own page (/settings/connectors/<id>, inside Settings: Google Drive, Gmail, Google Calendar,
// Google Docs, Google Sheets), kept simple like Claude's connector page: "Connectors › Gmail" on top (the way back to
// Settings › Connectors), the logo, the name and one line ("By Google ·
// Read and manage Gmail") with the one status or action and ⋯ on the right, the sign-in line under it while one is under
// way, then the About text, one line on what the AI may do, every tool as a chip, and a small details block (made by,
// category, sign-in, privacy). Fewer boxes, the same facts. What the person does with it (Connect, the account to
// confirm, ⋯ with Settings, Reconnect, Disconnect) comes from the caller: GoogleAppConnector.tsx and pages/Connectors.tsx.
// Admin › Connectors shows the same page (GoogleAdminPage.tsx) inside its own column (`embedded`), its way back to
// Admin's list (`list`), and the team's settings under the details (`children`). In Settings (`inSettings`) the page is
// under the dialog's own title: its name is an h2 (Tools an h3), and it takes the keyboard when it opens (the card that
// opened it is gone), as ConnectorDetail's way back does. Slack's page in Admin (pages/admin/Slack.tsx) has only the
// header: no About, tools or details (`about` and `developer` left out), its own settings as `children`.
// A listed service's page and a connection's page (ConnectionPage.tsx: Notion, Higgsfield, one added by its address) use
// it too: a tool can be off (`off`), a note under the tools (`toolsNote`), more rows in the details (`more`), and their
// own line on what the AI may do (`abilities`, a team's "Run without asking").
import { ChevronRight, ExternalLink, PenLine } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CONNECTORS_HOME } from '../../lib/connectors'
import { useT } from '../../i18n'
import { Tooltip } from '../Tooltip'
import { LogoTile } from './ConnectorsView'

/** `off`: turned off for the AI on this connection (shown muted) */
export interface AppTool { name: string; title: string; description?: string; changes: boolean; off?: boolean }

const label = 'text-micro font-semibold tracking-wide text-faint uppercase'

export function AppDetail({ testId, state, logo, name, byLine, actions, status, about, canChange, asks, abilities, developer, category, signIn, links, more, tools, toolsNote, list, embedded, inSettings, children }: {
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
  /** the About text and what the AI may do (left out: neither, Slack's page) */
  about?: string
  /** the AI may change or send something with it (else it only reads) */
  canChange?: boolean
  /** with canChange: whether it asks first ("ask"), or the person chose Always allow */
  asks?: 'ask' | 'allow'
  /** instead of the line made from canChange and asks */
  abilities?: string
  /** the details block (left out: none, Slack's page) */
  developer?: string
  category?: string
  /** the account the person signs in with ("Google") */
  signIn?: string
  /** the sign-in's owner and its privacy policy and terms (what the person agrees to at its sign-in) */
  links?: { by: string; privacy: string; terms: string }
  /** more rows of the details block (Detail) */
  more?: ReactNode
  tools: AppTool[]
  /** under the tools (or in their place while there are none): a short note, a link or a button */
  toolsNote?: ReactNode
  /** the list it belongs to, for the way back (default: Settings › Connectors) */
  list?: { to: string; name: string }
  /** inside a page that has its own column and scrolling (Settings, Admin) */
  embedded?: boolean
  /** a page under Settings › Connectors: an h2 under the dialog's title, focused when it opens */
  inSettings?: boolean
  /** under the details: Admin's team settings */
  children?: ReactNode
}) {
  const t = useT()
  const titleId = useId()
  const toolsId = useId()
  const Title = inSettings ? 'h2' : 'h1'
  const ToolsTitle = inSettings ? 'h3' : 'h2'
  const titleRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (inSettings) titleRef.current?.focus({ preventScroll: true }) }, [inSettings])
  const page = (
      <article aria-labelledby={titleId} className={embedded ? 'w-full max-w-3xl space-y-6 pb-10' : 'mx-auto w-full max-w-3xl space-y-6 px-4 pt-4 pb-10 sm:px-6 sm:pt-6'} data-testid={testId} data-state={state}>
        <div>
          {/* phones: the top bar names the list and has its way back */}
          <nav aria-label={t('gapps.breadcrumb')} className="mb-5 flex min-w-0 items-center gap-1 text-sm text-muted max-md:hidden" data-testid="app-breadcrumb">
            <Link to={list?.to ?? CONNECTORS_HOME} className="rounded hover:text-ink hover:underline" data-testid="app-breadcrumb-connectors">{list?.name ?? t('integrations.title')}</Link>
            <ChevronRight size={14} aria-hidden className="shrink-0 text-faint" />
            <span aria-current="page" className="truncate text-ink">{name}</span>
          </nav>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <LogoTile src={logo} className="size-14 rounded-2xl p-2.5" />
            <div className="min-w-0 flex-[1_1_12rem]">
              {/* a phone: the name wraps, never cut (QA TC-266); the state and ⋯ go on their own line under it */}
              <Title ref={titleRef} id={titleId} tabIndex={inSettings ? -1 : undefined} className="text-display font-semibold tracking-tight break-words outline-none">{name}</Title>
              <p className="mt-0.5 text-sm text-muted" data-testid="app-by">{byLine}</p>
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2 max-sm:w-full max-sm:[&>button:first-child]:flex-1" data-testid="app-actions">{actions}</div>}
          </div>
          {status && <div className="mt-4 space-y-2">{status}</div>}
        </div>

        {about !== undefined && (
          <div className="space-y-2">
            <p className="text-sm leading-relaxed text-ink/90" data-testid="app-about">{about}</p>
            <p className="text-sm text-muted" data-testid="app-abilities" data-can-change={canChange ? 'yes' : 'no'}>
              {abilities ?? (!canChange ? t('gapps.readOnlyLine') : asks === 'allow' ? t('gapps.changeAllowLine') : t('gapps.changeAskLine'))}
            </p>
          </div>
        )}

        {(tools.length > 0 || toolsNote) && (
          <section aria-labelledby={toolsId}>
            <ToolsTitle id={toolsId} className="mb-2.5 text-title-sm font-semibold">{t('gapps.tools')}</ToolsTitle>
            {tools.length > 0 && <ul className="flex flex-wrap gap-2" data-testid="app-tools">
              {tools.map((x) => {
                // what it does, and that it changes things: the tooltip on hover and on keyboard focus (the chip takes
                // focus when it has one), and screen-reader text inside the chip (touch has no tooltip)
                const tip = [x.off ? t('integrations.toolOff') : '', x.changes ? t('gapps.changesTag') : '', x.description ?? ''].filter(Boolean).join(' · ')
                const chip = (
                  <span tabIndex={tip ? 0 : undefined} className={`inline-flex max-w-full items-center gap-1.5 rounded-full border border-line px-3 py-1 text-label ${x.off ? 'border-dashed text-faint' : 'bg-subtle'}`} data-testid="app-tool-chip">
                    <span className={`truncate ${x.off ? 'line-through' : ''}`}>{x.title || x.name}</span>
                    {x.off && <span className="sr-only">{t('integrations.toolOff')}</span>}
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
                  <li key={x.name} className="flex max-w-full" data-testid="app-tool" data-name={x.name} data-off={x.off ? 'true' : undefined}>
                    {tip ? <Tooltip label={tip} description>{chip}</Tooltip> : chip}
                  </li>
                )
              })}
            </ul>}
            {toolsNote && <div className={`text-sm text-muted ${tools.length ? 'mt-2.5' : ''}`} data-testid="app-tools-note">{toolsNote}</div>}
          </section>
        )}

        {(developer !== undefined || more) && <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-5 text-sm" data-testid="app-info">
          {developer !== undefined && <Detail label={t('gapps.developer')}>{developer}</Detail>}
          {category !== undefined && <Detail label={t('gapps.category')}>{category}</Detail>}
          {signIn !== undefined && <Detail label={t('gapps.signIn')}>{signIn}</Detail>}
          {links && (
            <Detail label={t('gapps.privacy')}>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <ExtLink href={links.privacy} name={t('gapps.privacyName', { by: links.by })} testId="app-privacy">{links.by}</ExtLink>
                <span aria-hidden className="text-faint">·</span>
                <ExtLink href={links.terms} name={t('gapps.termsName', { by: links.by })} testId="app-terms">{t('gapps.terms')}</ExtLink>
              </span>
            </Detail>
          )}
          {more}
        </dl>}

        {children}
      </article>
  )
  return embedded ? page : <div className="flex h-full flex-col overflow-y-auto">{page}</div>
}

/** one row of the details block (`more`) */
export function Detail({ label: name, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <dt className={label}>{name}</dt>
      <dd className="mt-1 min-w-0 break-words">{children}</dd>
    </div>
  )
}

/** a phone: a 44 px tap, still a text link (QA TC-262). `name`: what a screen reader says it opens ("Google privacy
 * policy"), as the visible words alone ("Google", "Terms") do not. */
export function ExtLink({ href, name, testId, children }: { href: string; name: string; testId: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={name} className="inline-flex items-center gap-1 text-accent-text hover:underline max-md:min-h-11 max-md:min-w-11" data-testid={testId}>
      {children} <ExternalLink size={12} aria-hidden />
    </a>
  )
}
