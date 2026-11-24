// A listed service's page (Notion, Higgsfield, Figma…) and a connection's page (the person's own, a team connection, one
// added by its address), in Settings › Connectors and Admin › Connectors, laid out like the Google connectors' pages
// (AppDetail.tsx, QA TC-197): "Connectors › Higgsfield" / logo, name, one line, and on the right the one status or action
// (Connected ✓, Sign in, Error) and ⋯ / a sign-in under way / one short line when it does not work, with what to do next /
// About / one line on what the AI may do / its tools as chips / a small details block (Made by, Sign-in, Privacy, Terms,
// Help, Last used). What a connection's row used to offer is in ⋯ for whoever manages it (Check again, Sign in again,
// Edit, Ask every time, Delete; the phone app: no Edit and no sign-in, as before), and "Turn tools on or off" under the
// tools opens their switches. The caller adds what is its own: Settings' ask-an-admin line, Admin's Team settings.
import clsx from 'clsx'
import { Check, RefreshCw } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { Integration, IntegrationList } from '@mycel/shared/api'
import { CONNECTOR_DOCS, connectorFor, connectorLogo, type Connector } from '../../lib/connectors'
import { formatDateTime } from '../../lib/format'
import { awayFromComputer, computerSignIn, lastCheckNote, signInOffered, toolsShortfall } from '../../lib/integrations'
import { signsInOnComputer } from '../../lib/desktop'
import { mobileApp } from '../../lib/mobile'
import { useLocale, useT } from '../../i18n'
import { useMe } from '../../store/session'
import { Badge, Button, Modal, Switch } from '../ui'
import { AppDetail, Detail, ExtLink } from './AppDetail'
import { CardMenu, type CardMenuItem } from './AppConnectorCard'
import { Note } from './GoogleAppConnector'
import { SignInPanel, type IntegrationActions } from './IntegrationRow'
import { LocalAppDetails, LocalAppWhere, localAppsBridge } from './LocalApp'
import { localAppLogo, localAppOf } from '../../lib/localApps'
import { readIntegrations, SHARED, useCachedRead } from '../../store/listCache'

/** Where the page sits: Settings (its h2 under the dialog's title, `inSettings`), Admin (its own way back, `list`). */
interface Place { list?: { to: string; name: string }; inSettings?: boolean }

/** How many tools a listed service's page shows before it is connected; "Show all" shows the rest in place. */
export const LISTED_TOOLS = 12

/** What kind of trouble a check's reason code is (server/src/integrations/connections/text.ts Reason): the page says it
 * in one line of its own words with the one next step for its reader. A code not here (or an older server's connection
 * without one) shows the server's own words, which carry their own next step. */
const REASON_KIND: Record<string, 'address' | 'notMcp' | 'redirect' | 'key' | 'scope' | 'notSignedIn' | 'slow' | 'service'> = {
  unreachable: 'address', private_address: 'address', blocked_port: 'address',
  // the address answered: not as a connector, or by sending us elsewhere (QA TC-2939); its fix is still the address
  not_mcp: 'notMcp', redirect: 'redirect',
  // the oauth_unsupported / oauth_no_registration / oauth_approved_apps_only codes need another way to connect (or none),
  // not a new key: the server's words
  refused: 'key', no_secret: 'key', sign_in: 'key', oauth_failed: 'key',
  // signed in, but without an access the service needs (403 insufficient_scope): sign in again and allow it. Not here:
  // no_access (any other 403: this account may not use the service), whose server words carry what it said and that its
  // owner turns it on (signing in again cannot fix it)
  scope: 'scope',
  timeout: 'slow', list_timeout: 'slow', call_idle: 'slow',
  http_status: 'service', too_large: 'service', tls: 'service',
}

/** Why a connection does not work, and the one thing this reader can do about it, in one line. `manage`: they manage it
 * here; `elsewhere`: they manage it, in Admin › Connectors (an admin on a team connection in Settings); `phone`: the
 * phone app (Edit and sign-in are a computer's); `signIn`: Sign in is on this page; `computer`: this window is an app
 * on the computer that a service taking only such an app signs in from (lib/desktop.ts signsInOnComputer). */
export function errorLine(t: ReturnType<typeof useT>, i: Pick<Integration, 'lastError' | 'lastErrorReason' | 'auth' | 'hasSecret'>, who: { manage: boolean; elsewhere: boolean; phone: boolean; signIn: boolean; computer?: boolean }): string {
  // a sign-in only an app on the computer can do, read in that app: not signed in yet, and it signs in here (the
  // server's words say to open the desktop app, which is right only elsewhere: QA TC-4794)
  const known = computerSignIn(i, !!who.computer) ? 'notSignedIn' : i.lastErrorReason ? REASON_KIND[i.lastErrorReason] : undefined
  if (!known) return i.lastError ?? ''
  // waiting for a sign-in that was never finished (stopped at the service, cancelled here, or its window closed): the
  // service refused nothing, there is no sign-in it could refuse (QA TC-3859)
  const kind = i.lastErrorReason === 'sign_in' && i.auth === 'oauth' && !i.hasSecret ? 'notSignedIn' : known
  const step = who.elsewhere ? 'inAdmin'
    : !who.manage ? (kind === 'slow' ? 'later' : 'askAdmin')
    : kind === 'slow' || kind === 'service' ? 'checkAgain'
    : who.phone ? 'onComputer'
    : kind === 'address' || kind === 'notMcp' || kind === 'redirect' ? 'editAddress'
    // never signed in: the button there reads "Sign in", not "Sign in again"
    : i.auth === 'oauth' && who.signIn ? (kind === 'notSignedIn' ? 'signInFirst' : kind === 'scope' ? 'signInAllow' : 'signIn') : 'editKey'
  return `${t(`connectors.err.${kind}`)} ${t(`connectors.step.${step}`)}`
}

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
  const failing = !!i.lastError && i.status !== 'connected' && !i.personalOff
  // off by the team: not used, so a failed check is not news (QA TC-2930)
  const note = i.personalOff ? null : lastCheckNote(i)
  const short = toolsShortfall(i)
  const off = i.tools.filter((x) => x.enabled === false).length
  // the team's switch for Always allow is off: a member's own Always allow at a team connection asks (tools.ts gate), and
  // a rule to run without asking asks again after something from outside (QA TC-2944)
  const alwaysOff = useMe()?.team.alwaysAllowOff === true
  const allowed = i.writePolicy === 'allow' || (!!i.alwaysAllowedByMe && !alwaysOff)
  // the person's own Always allow (a write card's choice), which "Ask every time" ends (QA TC-130); a team's "Run
  // without asking" is the admin's rule, changed in Edit
  const ownAllow = !!i.alwaysAllowedByMe || (i.scope === 'personal' && i.writePolicy === 'allow')
  // the team has members' own connections off: kept, not used in chats, not signed in again (QA TC-2930)
  const teamOff = !!i.personalOff
  const computer = signsInOnComputer()
  const signInHere = signInOffered(i, { readOnly, phone, computer })
  const items: CardMenuItem[] = [
    ...(manage ? [{ label: t('integrations.refresh'), onSelect: () => void actions.refresh(i), disabled: checking, testId: 'integration-refresh' }] : []),
    ...(signInHere && i.status !== 'needs_auth' && !flow ? [{ label: t(i.hasSecret ? 'integrations.signInAgain' : 'integrations.signIn'), onSelect: () => void actions.signIn.start(i.id), testId: 'integration-signin-again' }] : []),
    // an app on the computer has no address, key or sign-in to edit (LocalApp.tsx keeps what is its own)
    ...(manage && !phone && i.kind !== 'local' ? [{ label: t('common.edit'), onSelect: onEdit, testId: 'integration-edit' }] : []),
    ...(ownAllow && (i.alwaysAllowedByMe || manage) ? [{ label: t('integrations.alwaysAllow.stop'), onSelect: () => void actions.askAgain(i), testId: 'integration-always-allow-stop' }] : []),
    ...(manage ? [{ label: t('common.delete'), onSelect: () => void actions.remove(i), danger: true, testId: 'integration-delete' }] : []),
  ]
  const status = checking ? (
    // Check again under way: said where the state is, until the answer comes (a toast then says how it went)
    <span role="status" className="flex items-center gap-1 text-xs text-muted" data-testid="connection-status" data-state="checking"><RefreshCw size={14} className="animate-spin" aria-hidden />{t('connectors.page.checking')}</span>
  ) : teamOff ? (
    <span className="text-xs text-muted" data-testid="connection-status" data-state="personal-off">{t('appConnectors.off')}</span>
  ) : awayFromComputer(i) ? (
    // checked from somewhere other than its computer: where it works, never a red "Error" (that is for a real failure)
    <span className="text-xs text-muted" data-testid="connection-status" data-state="elsewhere">{t(localAppsBridge() ? 'localApps.status.otherComputer' : 'localApps.status.desktopOnly')}</span>
  ) : i.status === 'connected' ? (
    <span className="flex items-center gap-1 text-xs text-ok" data-testid="connection-status" data-state="connected"><Check size={14} aria-hidden />{t('integrations.status.connected')}</span>
  ) : i.status === 'needs_auth' && signInHere ? (
    flow ? null : <Button variant="primary" onClick={() => void actions.signIn.start(i.id)} data-testid="integration-signin-start">{t(i.hasSecret ? 'integrations.signInAgain' : 'integrations.signIn')}</Button>
  ) : (
    <span className={clsx('text-xs', i.status === 'error' ? 'text-danger' : 'text-warn')} data-testid="connection-status" data-state={i.status}>{t(`integrations.status.${i.status}`)}</span>
  )
  // what happened and the one thing to do, in one line: whoever manages it here checks, edits or signs in again; an
  // admin reading a team connection in Settings manages it in Admin; anyone else asks an admin
  // (a sign-in Settings offers on a team connection is done here, not in Admin)
  const trouble = failing ? errorLine(t, i, { manage: manage || signInHere, elsewhere: !!readOnly && i.canManage && !signInHere, phone, signIn: signInHere, computer }) : null
  const signInLine = i.auth === 'oauth'
    ? (i.hasSecret ? (i.account ? t('integrations.account', { account: i.account }) : t('integrations.signedIn')) : t('connectors.page.notSignedIn'))
    : i.auth === 'none' ? t('connectors.page.signInNone') : t(i.hasSecret ? 'integrations.keySaved' : 'integrations.keyMissing')
  // an app on a computer, read away from the desktop app: its "works only from the desktop app there" note already says
  // why its check failed there, so the same words do not come twice in a second box
  const elsewhereOnly = awayFromComputer(i) && !localAppsBridge()
  const lastUsed = i.lastUsedAt ? formatDateTime(i.lastUsedAt, locale) : t('integrations.neverUsed')
  const name = c?.name ?? i.name
  // Aside or ego lite (lib/localApps.ts): its own logo and line, like a listed service
  const app = localAppOf(i)
  const { links, help } = docsRows(t, name, c)
  // GitHub: the repositories its app may see are chosen on GitHub, on the app's installation page (an organization's
  // owner installs it there, or a member asks them to); the server knows the page (docs/INTEGRATIONS.md "GitHub")
  const installUrl = useCachedRead<IntegrationList>(c?.id === 'github' ? SHARED.integrations : null, readIntegrations).data?.github?.installUrl ?? null
  // before its tools are known (not signed in, not answering), it may change things: the line says it asks first
  const canChange = i.writePolicy !== 'deny' && (!i.tools.length || i.tools.some((x) => !x.readOnly && x.enabled !== false))
  const toolsNote = i.kind === 'http' ? null : (
    <>
      {!i.tools.length && <span className="block">{t(i.status === 'connected' ? 'integrations.noTools' : i.status === 'error' ? 'connectors.page.toolsWhenWorks' : 'connectors.toolsAfter')}</span>}
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
        logo={c ? connectorLogo(c) : app ? localAppLogo(app) : '/favicon.svg'} name={i.name}
        byLine={c ? t('connectors.byLine', { name: c.name, line: t(`integrations.catalog.${c.id}`) }) : app ? t('connectors.byLine', { name: app.name, line: t(app.line) })
          : i.kind === 'local' ? t('localApps.title') : hostOf(i.url)}
        actions={(status || items.length > 0) && (
          <>
            {status}
            {/* a phone: the header's actions are a line of their own, ⋯ at its right end so its menu opens inside the screen */}
            {items.length > 0 && <div className="max-sm:ml-auto"><CardMenu label={t('appConnectors.more', { name: i.name })} testId="connection-menu" items={items} /></div>}
          </>
        )}
        status={(flow || failing || note || alert || teamOff || i.kind === 'local') ? (
          <>
            {i.kind === 'local' && <LocalAppWhere />}
            {teamOff && <Note tone="warn" testId="integration-personal-off">{t('connectors.page.personalOff')}</Note>}
            {flow && <SignInPanel flow={flow} name={i.name} url={i.url} onRetry={() => void actions.signIn.start(i.id)} onCancel={actions.signIn.cancel} />}
            {trouble && !flow && !elsewhereOnly && <Note tone="warn" testId="integration-error">{trouble}</Note>}
            {note && <Note tone="warn" testId="integration-check-failed">{t(note.key, { reason: note.reason, date: note.date ? formatDateTime(note.date, locale) : '' })}</Note>}
            {alert}
          </>
        ) : undefined}
        about={about}
        canChange={canChange} asks={allowed ? 'allow' : 'ask'}
        abilities={canChange && i.scope === 'team' && i.writePolicy === 'allow' ? t(alwaysOff ? 'connectors.page.teamAllowLineOff' : 'connectors.page.teamAllowLine') : undefined}
        developer={c?.name} signIn={i.kind === 'local' ? undefined : signInLine} links={links}
        more={<>
          {help}
          {/* a call that failed counts as tried: while it is failing, "Last tried" (QA retest 2026-11-12) */}
          <Detail label={t(failing && i.lastUsedAt ? 'connectors.page.lastTried' : 'connectors.page.lastUsed')} testId="integration-meta">{lastUsed}</Detail>
          {installUrl && (
            <Detail label={t('connectors.github.repos')} testId="connector-github-repos">
              <span className="block text-muted">{t('connectors.github.reposLine')}</span>
              <ExtLink href={installUrl} name={t('connectors.github.choose')} testId="connector-github-choose">{t('connectors.github.choose')}</ExtLink>
            </Detail>
          )}
          {!c && i.kind !== 'local' && <Detail label={t('connectors.page.address')} testId="connector-address"><span className="break-all">{i.url}</span></Detail>}
          {i.kind === 'local' && <LocalAppDetails i={i} onChanged={() => void actions.refresh(i)} />}
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
                  {/* never disabled while saving: a disabled control loses keyboard focus (each flip shows at once and goes to the server in order) */}
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
