// A listed service's page (Notion, Higgsfield, Figma…) and a connection's page (the person's own, a team connection, one
// added by its address), in Settings › Connectors and Admin › Connectors, laid out like the Google connectors' pages
// (AppDetail.tsx, QA TC-197): "Connectors › Higgsfield" / logo, name, one line, and on the right the one status or action
// (Connected ✓, Sign in, Error) and ⋯ / a sign-in under way / one short line when it does not work, with what to do next /
// About / one line on what the AI may do / its tools as chips / a small details block (Made by, Sign-in, Privacy, Terms,
// Help, Last used). What a connection's row used to offer is in ⋯ for whoever manages it (Check again, Sign in again,
// Edit, Ask every time, Delete; the phone app: no Edit and no sign-in, as before), and "Turn tools on or off" under the
// tools opens their switches. The caller adds what is its own: Settings' ask-an-admin line, Admin's Team settings.
import clsx from 'clsx'
import { Check } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { Integration } from '@mycel/shared/api'
import { CONNECTOR_DOCS, connectorFor, connectorLogo, type Connector } from '../../lib/connectors'
import { formatDateTime } from '../../lib/format'
import { canSignIn, lastCheckNote, toolsShortfall } from '../../lib/integrations'
import { mobileApp } from '../../lib/mobile'
import { useLocale, useT } from '../../i18n'
import { Badge, Button, Modal, Switch } from '../ui'
import { AppDetail, Detail, ExtLink } from './AppDetail'
import { CardMenu, type CardMenuItem } from './AppConnectorCard'
import { Note } from './GoogleAppConnector'
import { SignInPanel, type IntegrationActions } from './IntegrationRow'

/** Where the page sits: Settings (its h2 under the dialog's title, `inSettings`), Admin (its own way back, `list`). */
interface Place { list?: { to: string; name: string }; inSettings?: boolean }

/** How many tools a listed service's page shows before it is connected; "Show all" shows the rest in place. */
export const LISTED_TOOLS = 12

/** A connection's or a listed service's address without the path: what a page shows for one added by its address. */
const hostOf = (url: string) => { try { return new URL(url).host } catch { return url } }

/** The service's own pages (privacy, terms, help) as details rows. */
function docsRows(t: ReturnType<typeof useT>, name: string, c: Connector | undefined) {
  const docs = c ? CONNECTOR_DOCS[c.id] : undefined
  return {
    links: docs ? { by: name, privacy: docs.privacy, terms: docs.terms } : undefined,
    help: docs ? (
      <Detail label={t('connectors.page.help')} testId="connector-help">
        <ExtLink href={docs.docs} name={t('connectors.linkDocsName', { name })} testId="connector-docs-link">{name}</ExtLink>
      </Detail>
    ) : null,
  }
}

/** A listed service before it is connected (or connected only as a team template): what it is, the tools it lists on
 * its own page, its links. `actions`: Connect (or Ask admin, or Connected) on the right of the name. */
export function ListedServicePage({ c, actions, status, about, state, ...place }: Place & {
  c: Connector
  actions?: ReactNode
  status?: ReactNode
  about: string
  state: string
}) {
  const t = useT()
  const [all, setAll] = useState(false)
  const docs = CONNECTOR_DOCS[c.id]
  const listed = docs?.tools ?? []
  const shown = all ? listed : listed.slice(0, LISTED_TOOLS)
  const { links, help } = docsRows(t, c.name, c)
  return (
    <AppDetail embedded inSettings={place.inSettings} list={place.list} testId="connector-detail" state={state} logo={connectorLogo(c)} name={c.name}
      byLine={t('connectors.byLine', { name: c.name, line: t(`integrations.catalog.${c.id}`) })}
      actions={actions} status={status} about={about} canChange asks="ask"
      developer={c.name} links={links} more={help}
      tools={shown.map((x) => ({ name: x, title: x, changes: false }))}
      toolsNote={listed.length ? (
        (listed.length > LISTED_TOOLS || docs?.toolsUrl) && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {listed.length > LISTED_TOOLS && (
              <button type="button" aria-expanded={all} onClick={() => setAll((v) => !v)}
                className="touch-hit font-medium text-accent-text hover:underline max-md:min-h-11" data-testid="connector-tools-more">
                {all ? t('connectors.showLess') : t('connectors.toolsShowAll', { count: listed.length })}
              </button>
            )}
            {docs?.toolsUrl && <ExtLink href={docs.toolsUrl} name={t('connectors.toolsAll', { name: c.name })} testId="connector-tools-link">{t('connectors.toolsAll', { name: c.name })}</ExtLink>}
          </p>
        )
      ) : <span data-testid="connector-tools-note">{t('connectors.toolsAfter')}</span>} />
  )
}

/** One connection's page. `readOnly`: nothing to manage here even for whoever may (a team connection in Settings: an
 * admin manages it in Admin › Connectors). `alert`: a warning line under the header (Admin: nobody may use it).
 * `children`: under the details (Admin's Team settings, Settings' note on keys). */
export function ConnectionPage({ i, actions, onEdit, readOnly, about, alert, children, ...place }: Place & {
  i: Integration
  actions: IntegrationActions
  onEdit: () => void
  readOnly?: boolean
  about: string
  alert?: ReactNode
  children?: ReactNode
}) {
  const t = useT()
  const locale = useLocale()
  const [toolsOpen, setToolsOpen] = useState(false)
  // a big service (Higgsfield's 186 tools): the first chips, "Show all" shows the rest in place
  const [allChips, setAllChips] = useState(false)
  const c = connectorFor(i.url)
  const manage = i.canManage && !readOnly
  const phone = !!mobileApp()
  const flow = actions.signIn.state?.id === i.id ? actions.signIn.state : null
  const checking = actions.checking === i.id
  const failing = !!i.lastError && i.status !== 'connected'
  const note = lastCheckNote(i)
  const short = toolsShortfall(i)
  const off = i.tools.filter((x) => x.enabled === false).length
  const allowed = i.writePolicy === 'allow' || !!i.alwaysAllowedByMe
  // the person's own Always allow (a write card's choice), which "Ask every time" ends (QA TC-130); a team's "Run
  // without asking" is the admin's rule, changed in Edit
  const ownAllow = !!i.alwaysAllowedByMe || (i.scope === 'personal' && i.writePolicy === 'allow')
  const signInHere = manage && canSignIn(i) && !phone
  const items: CardMenuItem[] = [
    ...(manage ? [{ label: t('integrations.refresh'), onSelect: () => void actions.refresh(i), disabled: checking, testId: 'integration-refresh' }] : []),
    ...(signInHere && i.status !== 'needs_auth' && !flow ? [{ label: t(i.hasSecret ? 'integrations.signInAgain' : 'integrations.signIn'), onSelect: () => void actions.signIn.start(i.id), testId: 'integration-signin-again' }] : []),
    ...(manage && !phone ? [{ label: t('common.edit'), onSelect: onEdit, testId: 'integration-edit' }] : []),
    ...(ownAllow && (i.alwaysAllowedByMe || manage) ? [{ label: t('integrations.alwaysAllow.stop'), onSelect: () => void actions.askAgain(i), testId: 'integration-always-allow-stop' }] : []),
    ...(manage ? [{ label: t('common.delete'), onSelect: () => void actions.remove(i), danger: true, testId: 'integration-delete' }] : []),
  ]
  const status = i.status === 'connected' ? (
    <span className="flex items-center gap-1 text-xs text-ok" data-testid="connection-status" data-state="connected"><Check size={14} aria-hidden />{t('integrations.status.connected')}</span>
  ) : i.status === 'needs_auth' && signInHere ? (
    flow ? null : <Button variant="primary" onClick={() => void actions.signIn.start(i.id)} data-testid="integration-signin-start">{t(i.hasSecret ? 'integrations.signInAgain' : 'integrations.signIn')}</Button>
  ) : (
    <span className={clsx('text-xs', i.status === 'error' ? 'text-danger' : 'text-warn')} data-testid="connection-status" data-state={i.status}>{t(`integrations.status.${i.status}`)}</span>
  )
  // what to do next, after what happened: whoever manages it checks or edits it (or signs in again), anyone else asks
  const next = i.status === 'needs_auth'
    ? (signInHere ? t('connectors.page.signInFix') : manage ? t('integrations.signIn.phone') : t('connectors.page.errorAsk'))
    : manage ? t(phone ? 'connectors.page.errorFixPhone' : 'connectors.page.errorFix') : t('connectors.page.errorAsk')
  const signInLine = i.auth === 'oauth'
    ? (i.hasSecret ? (i.account ? t('integrations.account', { account: i.account }) : t('integrations.signedIn')) : t('connectors.page.notSignedIn'))
    : i.auth === 'none' ? t('connectors.page.signInNone') : t(i.hasSecret ? 'integrations.keySaved' : 'integrations.keyMissing')
  const lastUsed = i.lastUsedAt ? formatDateTime(i.lastUsedAt, locale) : t('integrations.neverUsed')
  const name = c?.name ?? i.name
  const { links, help } = docsRows(t, name, c)
  // before its tools are known (not signed in, not answering), it may change things: the line says it asks first
  const canChange = i.writePolicy !== 'deny' && (!i.tools.length || i.tools.some((x) => !x.readOnly && x.enabled !== false))
  const toolsNote = i.kind !== 'mcp' ? null : (
    <>
      {!i.tools.length && <span className="block">{t(i.status === 'connected' ? 'integrations.noTools' : 'connectors.toolsAfter')}</span>}
      {short && <span className="block" data-testid="integration-tools-capped">{t(short, { n: i.tools.length, total: i.toolsTotal! })}</span>}
      {i.tools.length > 0 && (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {i.tools.length > LISTED_TOOLS && (
            <button type="button" aria-expanded={allChips} onClick={() => setAllChips((v) => !v)}
              className="touch-hit font-medium text-accent-text hover:underline max-md:min-h-11" data-testid="connector-tools-more">
              {allChips ? t('connectors.showLess') : t('connectors.toolsShowAll', { count: i.tools.length })}
            </button>
          )}
          {off > 0 && <span data-testid="integration-tools-off">{t('integrations.toolsOff', { n: off })}</span>}
          <button type="button" aria-haspopup="dialog" onClick={() => setToolsOpen(true)} className="touch-hit font-medium text-accent-text hover:underline max-md:min-h-11" data-testid="integration-tools-toggle">
            {t(manage ? 'connectors.page.toolsSwitch' : 'connectors.page.toolsAll')}
          </button>
        </span>
      )}
    </>
  )
  return (
    <>
      <AppDetail embedded inSettings={place.inSettings} list={place.list} testId="connector-detail" state={flow ? `flow-${flow.state}` : i.status}
        logo={c ? connectorLogo(c) : '/favicon.svg'} name={i.name}
        byLine={c ? t('connectors.byLine', { name: c.name, line: t(`integrations.catalog.${c.id}`) }) : hostOf(i.url)}
        actions={(status || items.length > 0) && (
          <>
            {status}
            {/* a phone: the header's actions are a line of their own, ⋯ at its right end so its menu opens inside the screen */}
            {items.length > 0 && <div className="max-sm:ml-auto"><CardMenu label={t('appConnectors.more', { name: i.name })} testId="connection-menu" items={items} /></div>}
          </>
        )}
        status={(flow || failing || note || alert) ? (
          <>
            {flow && <SignInPanel flow={flow} onRetry={() => void actions.signIn.start(i.id)} onCancel={actions.signIn.cancel} />}
            {failing && !flow && <Note tone="warn" testId="integration-error">{i.lastError} {next}</Note>}
            {note && <Note tone="warn" testId="integration-check-failed">{t(note.key, { reason: note.reason, date: note.date ? formatDateTime(note.date, locale) : '' })}</Note>}
            {alert}
          </>
        ) : undefined}
        about={about}
        canChange={canChange} asks={allowed ? 'allow' : 'ask'}
        abilities={canChange && i.scope === 'team' && i.writePolicy === 'allow' ? t('connectors.page.teamAllowLine') : undefined}
        developer={c?.name} signIn={signInLine} links={links}
        more={<>
          {help}
          {/* a call that failed counts as tried: while it is failing, "Last tried" (QA retest 2026-11-12) */}
          <Detail label={t(failing && i.lastUsedAt ? 'connectors.page.lastTried' : 'connectors.page.lastUsed')} testId="integration-meta">{lastUsed}</Detail>
          {!c && <Detail label={t('connectors.page.address')} testId="connector-address"><span className="break-all">{i.url}</span></Detail>}
        </>}
        tools={(allChips ? i.tools : i.tools.slice(0, LISTED_TOOLS)).map((x) => ({ name: x.name, title: x.title || x.name, description: x.description || undefined, changes: !x.readOnly, off: x.enabled === false }))}
        toolsNote={toolsNote}>
        {children}
      </AppDetail>
      {toolsOpen && <ToolsDialog i={i} manage={manage} actions={actions} onClose={() => setToolsOpen(false)} />}
    </>
  )
}

/** Every tool of a connection with what it does, and a switch each for whoever manages it (like Claude's connector tools:
 * a tool turned off is not offered to the AI, server/src/integrations/connections/tools.ts; tools the service adds later
 * are on). */
function ToolsDialog({ i, manage, actions, onClose }: { i: Integration; manage: boolean; actions: IntegrationActions; onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const short = toolsShortfall(i)
  return (
    <Modal open title={t('connectors.page.toolsTitle', { name: i.name })} onClose={onClose} width={560}
      footer={<Button variant="primary" onClick={onClose} data-testid="integration-tools-done">{t('common.done')}</Button>}>
      <ul className="-mx-1 divide-y divide-line" data-testid="integration-tools">
        {i.tools.map((x) => {
          const on = x.enabled !== false
          return (
            <li key={x.name} className="flex items-start gap-3 px-1 py-2.5 text-sm" data-testid="integration-tool" data-read-only={x.readOnly ? 'true' : 'false'} data-enabled={on ? 'true' : 'false'}>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={clsx('font-medium break-all', on ? 'text-ink' : 'text-muted')}>{x.title || x.name}</span>
                  {x.readOnly && <Badge tone="ok">{t('integrations.readOnly')}</Badge>}
                  {!on && !manage && <Badge>{t('integrations.toolOff')}</Badge>}
                </p>
                {x.description && <p className="mt-0.5 line-clamp-3 text-xs break-words text-muted">{x.description}</p>}
              </div>
              {manage && (
                <span className="shrink-0 pt-0.5">
                  {/* never disabled while saving: a disabled control loses keyboard focus (setTool ignores a second click) */}
                  <Switch checked={on} hideLabel label={t('integrations.toolSwitch', { name: x.title || x.name })}
                    onChange={(v) => void actions.setTool(i, x.name, v)} testId="integration-tool-switch" />
                </span>
              )}
            </li>
          )
        })}
      </ul>
      <p className="mt-3 text-xs text-faint">
        {short && <span className="block">{t(short, { n: i.tools.length, total: i.toolsTotal! })}</span>}
        {`${t(manage ? 'integrations.toolsSwitchHint' : 'integrations.toolsManagedHint')} `}
        {t('integrations.toolsHint')}
        {i.toolsUpdatedAt && ` ${t('integrations.toolsChecked', { date: formatDateTime(i.toolsUpdatedAt, locale) })}`}
      </p>
    </Modal>
  )
}
