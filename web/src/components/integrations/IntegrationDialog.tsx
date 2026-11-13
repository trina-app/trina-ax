// Add or edit an external-service connection: kind (MCP server / API), name, address, how it signs in (OAuth / key /
// none) and which header carries a key, the key (write-only: editing shows only that one is saved, with replace /
// remove), usage notes for an API, what the AI may change there (ask / allow / refuse), and for a team connection who
// may use it. Checked here like the contract; the server's field errors are shown at their fields. Adding a service
// from Discover (`connector`) leaves out what the list already answers: kind, name, address and how it signs in.
// In Admin a new connection is either for the team with one key, or a template: each member it is for connects it with
// their own key or sign-in (no key here, no write rule: those are each member's). A member's connection made from a
// template shows only what is theirs to change: their key or sign-in, and the write rule.
// Sign-in at a service that does not register apps itself (Google's MCP servers; an API such as NAVER WORKS, always)
// goes through your own app there (AppSection): its client ID and secret, an API's sign-in and token addresses, the
// scopes, and the redirect address to register at the service. On a template it is the team's app; members never see
// its secret. A stored secret stays only where it went before (storedSecretStays, the server's rule).
// Laid out like Team settings (QA TC-187): each field a row with its words and one short line on the left and the field,
// a select or a switch on the right; an error shows after Save or after leaving a field one typed in. A team connection's
// "For: … · Change" and the sign-in note share one quiet line; Change opens who may use it under that line (not again
// inside Advanced). Admin's Add first lists the Discover apps (`choices`, QA TC-189), a custom app by its address last;
// a picked app is then like one added from Discover: its icon and name in the title, its address one small line.
// In the phone app a new connection of one's own is made on a computer (its sign-in has no way back to the app, and
// its key and advanced settings are a computer's work): the dialog is then one line that says so, with no form.
import clsx from 'clsx'
import { Check, ChevronRight, Copy, Plus, Search, TriangleAlert, UserPlus } from 'lucide-react'
import { useId, useRef, useState, type ReactNode } from 'react'
import type { Group, Integration, IntegrationAccess, IntegrationKind, IntegrationTemplate, IntegrationTemplatePatch, User, WritePolicy } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { connectorLogo, type Connector } from '../../lib/connectors'
import {
  appInput, appPatch, authOf, storedSecretStays, CLIENT_ID_MAX, CLIENT_SECRET_MAX, covers, dropsSecret, emptyForm, formFrom, formFromTemplate, isEmptyAccess, methodsFor, normalAccess, NOBODY, NOTES_MAX, sameAccess, SCOPE_MAX, serverFieldErrors, toInput, toPatch, URL_MAX, usesApp, validate, withKind,
  type FormErrors, type FormField, type IntegrationForm, type SignInMethod,
} from '../../lib/integrations'
import { mobileApp } from '../../lib/mobile'
import { useLocale, useT } from '../../i18n'
import { useMeStrict } from '../../store/session'
import { SettingRow, useLoad } from '../../pages/admin/common'
import { Button, Field, Modal, Switch, inputCls, useCopy } from '../ui'
import { Tooltip } from '../Tooltip'
import type { OAuthClientView } from '@mycel/shared/api'
import { reserveSignInWindow } from './IntegrationRow'

const POLICIES: WritePolicy[] = ['ask', 'allow', 'deny']
/** the fields inside Advanced (it opens when one of them needs fixing): an MCP server's own app is there, an API's not */
const advancedFields = (f: IntegrationForm): FormField[] =>
  ['method', 'notes', 'writePolicy', ...(f.kind === 'mcp' ? ['clientId', 'clientSecret', 'scope', 'authUrl', 'tokenUrl'] as FormField[] : [])]
/** Admin: a connection for the team with one key, or a template each member connects with their own */
type Who = 'team' | 'template'

/** Who a new team connection or template is for until the admin chooses: the whole team. */
export const TEAM_DEFAULT_ACCESS: IntegrationAccess = { everyone: true, groups: [], users: [] }

export function IntegrationDialog({ scope, existing, template, connector, choices, startAs, onClose, onSaved, onSavedTemplate }: {
  scope: 'personal' | 'team'
  existing?: Integration
  /** editing this template (Admin) */
  template?: IntegrationTemplate
  /** adding this service from Discover */
  connector?: Connector
  /** a new connection: first pick one of these Discover apps, or a custom app by its address (Admin's Add) */
  choices?: Connector[]
  /** Admin: start as a template instead of one team key (a connector page's "As a template") */
  startAs?: Who
  onClose: () => void
  /** saved. `signIn`: sign in at the service next, in the window reserved during the click (null: none could open) */
  onSaved: (i: Integration, signIn: { window: Window | null } | null) => void
  /** a template was made or changed (Admin) */
  onSavedTemplate?: (t: IntegrationTemplate) => void
}) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const team = scope === 'team'
  // a member's own connection made from an admin's template: only the key or sign-in and the write rule are theirs
  const fromTeam = !!existing?.templateId
  const [who, setWho] = useState<Who>(template || startAs === 'template' ? 'template' : 'team')
  const asTemplate = team && who === 'template'
  const [f, setF] = useState<IntegrationForm>(() => {
    if (template) return formFromTemplate(template)
    if (existing) return formFrom(existing)
    // a team connection ("For the team") and a template both start with the whole team; the admin may narrow it under
    // Advanced (QA TC-134 retest: "For the team" with only the admin ticked was not what the button says)
    const blank = emptyForm('mcp', team ? { ...TEAM_DEFAULT_ACCESS } : null)
    return connector ? { ...blank, name: connector.name, url: connector.url } : blank
  })
  // Admin's Add: the list of apps first; a picked one fills the form like one added from Discover
  const [picking, setPicking] = useState(!!choices && !connector && !existing && !template)
  const [picked, setPicked] = useState<Connector | undefined>()
  const [query, setQuery] = useState('')
  const conn = connector ?? picked
  const [touched, setTouched] = useState<Partial<Record<FormField, boolean>>>({})
  // the fields typed in: leaving an empty field one never typed in shows no error (only Save does)
  const [edited, setEdited] = useState<Partial<Record<FormField, boolean>>>({})
  // who may use it, opened under the "For" line by Change
  const [accessOpen, setAccessOpen] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [server, setServer] = useState<Partial<Record<FormField, string | null>>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  // Advanced starts closed, except when what needs fixing is in it
  const [advanced, setAdvanced] = useState(false)
  const advancedId = useId()
  const ids = { name: useId(), url: useId(), who: useId(), kind: useId(), auth: useId(), write: useId() }
  const groups = useLoad(async () => (team ? (await api.call(API.listGroups)).items : []), [team])
  const users = useLoad(async () => (team ? (await api.call(API.listUsers)).items : []), [team])
  // a template takes no key: what is wrong with one is not this form's
  const checked = validate(f, existing, template ? { app: template.oauthClient, url: template.url } : undefined)
  const errors: FormErrors = asTemplate ? (({ secret: _secret, ...rest }: FormErrors) => rest)(checked) : checked
  const phone = !!mobileApp()
  const dropped = dropsSecret(f, existing)
  const signInNext = !asTemplate && f.method === 'oauth' && !phone && (!existing || existing.auth !== 'oauth' || dropped)
  // editing a template: a new address, sign-in method, header or app drops every member's key (they connect again)
  const movesTemplate = !!template && (f.url.trim() !== template.url || authOf(f) !== template.auth || (authOf(f) === 'header' && f.headerName.trim() !== (template.authHeader ?? ''))
    || (authOf(f) === 'oauth' && appPatch(f, template.oauthClient, template.url) !== undefined))
  const methods = methodsFor(f.kind).filter((m) => !asTemplate || m !== 'none')
  // who a new team connection or template is for, in words: everyone, or the groups and people chosen
  const forWho = !f.access ? '' : f.access.everyone ? t('integrations.forEveryone') : [
    ...f.access.groups.map((id) => groups.data?.find((g) => g.id === id)?.name),
    ...f.access.users.map((id) => users.data?.find((u) => u.id === id)?.name),
  ].filter(Boolean).join(', ') || t('integrations.forNobody')
  const errorOf = (k: FormField): string | null => {
    if (k in server) return server[k] ?? t('integrations.error.field')
    const e = errors[k]
    return e && (submitted || touched[k]) ? t(e) : null
  }
  const change = (patch: Partial<IntegrationForm>, ...fields: FormField[]) => {
    setF((x) => ({ ...x, ...patch }))
    if (fields.length) setEdited((x) => ({ ...x, ...Object.fromEntries(fields.map((k) => [k, true])) }))
    if (fields.some((k) => k in server)) setServer((s) => Object.fromEntries(Object.entries(s).filter(([k]) => !fields.includes(k as FormField))))
    setError(null)
  }
  const blur = (k: FormField) => () => { if (edited[k]) setTouched((x) => ({ ...x, [k]: true })) }
  /** an app from the list, or (none) a custom app by its address: a fresh form for it, who it is for kept */
  const pick = (c?: Connector) => {
    setPicked(c)
    setF((x) => {
      const blank = { ...emptyForm('mcp', x.access), writePolicy: x.writePolicy }
      return c ? { ...blank, name: c.name, url: c.url } : blank
    })
    setTouched({})
    setEdited({})
    setSubmitted(false)
    setServer({})
    setError(null)
    setPicking(false)
  }

  const save = async () => {
    if (busy) return
    setSubmitted(true)
    if (Object.keys(errors).length) {
      if (advancedFields(f).some((k) => k in errors)) setAdvanced(true)
      if ('access' in errors) setAccessOpen(true)
      requestAnimationFrame(() => body.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return
    }
    if (asTemplate) return void saveTemplate()
    const patch = existing ? toPatch(f, existing) : null
    if (existing && patch && !Object.keys(patch).length) return onClose()
    // the sign-in window has to open during the click: reserve it now, send it to the service once the server answers
    const win = signInNext ? reserveSignInWindow() : null
    setBusy(true)
    setError(null)
    setServer({})
    try {
      const r = existing && patch
        ? await api.call(API.updateIntegration, { params: { id: existing.id }, body: patch })
        : team ? await api.call(API.createTeamIntegration, { body: toInput(f) }) : await api.call(API.createIntegration, { body: toInput(f) })
      onSaved(r, signInNext ? { window: win } : null)
    } catch (e) {
      win?.close()
      const fields = serverFieldErrors(e)
      setServer(fields)
      if (advancedFields(f).some((k) => k in fields)) setAdvanced(true)
      if ('access' in fields) setAccessOpen(true)
      // from Discover the name and address are not on screen, so an error about them has to say so here
      if (!Object.keys(fields).length || conn) setError(errorText(e, locale, t('error.network')))
      else requestAnimationFrame(() => body.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
    } finally {
      setBusy(false)
    }
  }

  /** a template: the service and who it is for, never a key */
  const saveTemplate = async () => {
    const auth = authOf(f)
    if (auth === 'none') return
    const authHeader = auth === 'header' ? f.headerName.trim() : null
    const notes = f.notes.trim() || null
    const access = normalAccess(f.access ?? NOBODY)
    setBusy(true)
    setError(null)
    setServer({})
    try {
      let r: IntegrationTemplate
      if (template) {
        const p: IntegrationTemplatePatch = {}
        if (f.name.trim() !== template.name) p.name = f.name.trim()
        if (f.url.trim() !== template.url) p.url = f.url.trim()
        if (auth !== template.auth) p.auth = auth
        if (authHeader !== (template.authHeader ?? null)) p.authHeader = authHeader
        if (notes !== (template.notes ?? null)) p.notes = notes
        if (!sameAccess(access, template.access)) p.access = access
        const app = auth === 'oauth' ? appPatch(f, template.oauthClient, template.url) : undefined
        if (app !== undefined) p.oauthClient = app
        if (!Object.keys(p).length) return onClose()
        r = await api.call(API.updateIntegrationTemplate, { params: { id: template.id }, body: p })
      } else {
        r = await api.call(API.createIntegrationTemplate, { body: { kind: f.kind, name: f.name.trim(), url: f.url.trim(), auth, authHeader, notes, access, ...(usesApp(f) ? { oauthClient: appInput(f) } : {}) } })
      }
      onSavedTemplate?.(r)
    } catch (e) {
      const fields = serverFieldErrors(e)
      setServer(fields)
      if ('access' in fields) setAccessOpen(true)
      if (!Object.keys(fields).length || conn) setError(errorText(e, locale, t('error.network')))
      else requestAnimationFrame(() => body.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
    } finally {
      setBusy(false)
    }
  }

  // the phone app: a new connection of my own is made on a computer; here one line says so (no Save, no Advanced)
  if (phone && !team && !existing && !template)
    return (
      <Modal open onClose={onClose} width={420} title={connector ? connector.name : t('integrations.addTitle')}
        footer={<Button variant="primary" onClick={onClose} data-testid="integration-on-computer-done">{t('common.done')}</Button>}>
        <div className="space-y-2 text-sm" data-testid="integration-on-computer">
          <p>{connector ? t('integrations.onComputer', { name: connector.name }) : t('integrations.onComputerNew')}</p>
          <p className="text-muted">{t('integrations.onComputerHint')}</p>
        </div>
      </Modal>
    )
  const title = template ? t('integrations.template.editTitle')
    : existing ? t('integrations.editTitle')
      : conn ? (
        <span className="flex min-w-0 items-center gap-2" data-testid="integration-title-app">
          <img src={connectorLogo(conn)} alt="" width={20} height={20} className="size-5 shrink-0 rounded object-contain" />
          <span className="min-w-0 break-words">{t('integrations.discover.add', { name: conn.name })}</span>
        </span>
      )
        : team ? t('integrations.addTeamTitle') : t('integrations.addTitle')
  // the list of apps (Admin's Add): a search, the apps with their icons, a custom app by its address last
  if (picking) {
    const q = query.trim().toLowerCase()
    const shown = (choices ?? []).filter((c) => !q || c.name.toLowerCase().includes(q))
    const itemCls = 'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm hover:bg-hover max-md:min-h-11'
    return (
      <Modal open onClose={onClose} width={600} title={title}
        footer={<Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>}>
        <div data-testid="integration-pick">
          <div className="relative">
            <Search size={15} aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
            <input type="search" className={clsx(inputCls, 'pl-9')} value={query} placeholder={t('integrations.pick.search')} aria-label={t('integrations.pick.search')}
              onChange={(e) => setQuery(e.target.value)} data-autofocus data-testid="integration-pick-search" />
          </div>
          <ul className="-mx-2 mt-3" aria-label={t('integrations.pick.label')}>
            {shown.map((c) => (
              <li key={c.id}>
                <button type="button" className={itemCls} onClick={() => pick(c)} data-testid={`integration-pick-${c.id}`}>
                  <img src={connectorLogo(c)} alt="" width={20} height={20} className="size-5 shrink-0 rounded object-contain" />
                  <span className="min-w-0 truncate">{c.name}</span>
                </button>
              </li>
            ))}
            {q && !shown.length && <li className="px-2 py-2 text-sm text-muted" data-testid="integration-pick-none">{t('integrations.noMatch', { q: query.trim() })}</li>}
            <li className="mt-1 border-t border-line pt-1">
              <button type="button" className={itemCls} onClick={() => pick()} data-testid="integration-pick-custom">
                <span className="flex size-5 shrink-0 items-center justify-center text-muted"><Plus size={16} aria-hidden /></span>
                <span className="min-w-0">{t('integrations.pick.custom')}</span>
              </button>
            </li>
          </ul>
        </div>
      </Modal>
    )
  }
  // the sign-in note: with a team connection it shares the "For" line
  const signInNote = !asTemplate && f.method === 'oauth' && !dropped && !(existing?.hasSecret && existing.auth === 'oauth')
    ? t(phone ? 'integrations.signIn.phone' : 'integrations.signIn.nextShort') : null
  const forLine = team && !!f.access
  const rows = !fromTeam && !conn
  return (
    <Modal
      open
      onClose={onClose}
      width={600}
      title={title}
      footer={
        <>
          {choices && !connector && !existing && !template && (
            <Button variant="ghost" className="mr-auto" onClick={() => setPicking(true)} data-testid="integration-pick-back">
              {t('integrations.pick.back')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void save()} data-testid="integration-save">
            {signInNext ? t('integrations.saveAndSignIn') : asTemplate && !template ? t('integrations.template.save') : t('common.save')}
          </Button>
        </>
      }
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div ref={body} className="space-y-4">
          {fromTeam && existing ? (
            <div className="space-y-1 text-sm" data-testid="integration-from-team">
              <p className="text-muted">{t('integrations.field.url')}: <span className="font-medium break-all text-ink">{existing.url}</span></p>
              <p className="text-xs text-faint">{t('integrations.template.memberNote')}</p>
            </div>
          ) : conn ? (
            <p className="text-xs break-all text-faint" data-testid="connector-summary">
              {t('connectors.addressLine', { address: conn.url })}
            </p>
          ) : null}
          {(rows || f.method === 'key') && (
            <div className="divide-y divide-line [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
              {rows && (
                <>
                  <Row id={ids.name} label={t('integrations.field.name')} hint={t('integrations.field.nameShort')} error={errorOf('name')}>
                    <input id={ids.name} {...described(ids.name, errorOf('name'))} className={clsx(inputCls, 'md:w-72')} value={f.name} maxLength={80} placeholder={t('integrations.field.namePlaceholder')} onChange={(e) => change({ name: e.target.value }, 'name')} onBlur={blur('name')} data-autofocus={existing ? true : undefined} data-testid="integration-name" />
                  </Row>
                  <Row id={ids.url} label={t('integrations.field.url')} hint={t('integrations.field.urlShort')} error={errorOf('url')}>
                    <input id={ids.url} {...described(ids.url, errorOf('url'))} className={clsx(inputCls, 'md:w-72')} type="url" inputMode="url" autoComplete="off" spellCheck={false} value={f.url} placeholder={f.kind === 'mcp' ? 'https://mcp.example.com/mcp' : 'https://api.example.com/v1'} onChange={(e) => change({ url: e.target.value }, 'url')} onBlur={blur('url')} data-testid="integration-url" />
                  </Row>
                </>
              )}
              {f.method === 'key' && (
                <KeySection f={f} existing={existing} change={change} errorOf={errorOf} blur={blur} noKey={asTemplate} fixedHeader={fromTeam} />
              )}
            </div>
          )}
          {asTemplate && f.method === 'oauth' && (
            <p className="text-sm text-muted" data-testid="integration-template-oauth-note">{t('integrations.template.oauthNote')}</p>
          )}
          {/* an API signs in only with its own app: its fields are required, so they sit with the address (like a key) */}
          {f.method === 'oauth' && f.kind === 'http' && !fromTeam && (
            <AppSection f={f} stored={template ? template.oauthClient : existing?.oauthClient} storedUrl={template?.url ?? existing?.url} change={change} errorOf={errorOf} blur={blur} template={asTemplate} />
          )}
          {/* a team connection: who it is for and, when signing in comes next, that note, as one quiet line; Change opens who may use it */}
          {forLine && f.access && (
            <div>
              <p className="text-sm text-muted" data-testid="integration-for">
                <span className="break-words">{t('integrations.forLine', { who: forWho })}</span>
                {' · '}
                <button type="button" className="touch-hit font-medium text-accent-text hover:underline" aria-label={t('integrations.forChangeLabel')} aria-expanded={accessOpen}
                  onClick={() => {
                    const opening = !accessOpen
                    setAccessOpen(opening)
                    if (opening) requestAnimationFrame(() => body.current?.querySelector<HTMLElement>('[data-testid="integration-access"] input:checked')?.focus())
                  }} data-testid="integration-for-change">
                  {t('integrations.forChange')}
                </button>
                {signInNote && <span data-testid="integration-oauth-note">{' · '}{signInNote}</span>}
              </p>
              {accessOpen && (
                <div className="mt-3">
                  <AccessPicker value={f.access} onChange={(a) => change({ access: a }, 'access')} groups={groups.data ?? []} users={users.data ?? []} me={{ id: me.user.id, groupIds: me.groups.map((g) => g.id) }} error={errorOf('access')} template={asTemplate} />
                </div>
              )}
            </div>
          )}
          {!asTemplate && f.method === 'oauth' && !(forLine && signInNote) && (
            <div className="text-sm" data-testid="integration-oauth-note">
              {existing?.hasSecret && existing.auth === 'oauth' && !dropped ? (
                <p className="text-muted">{existing.account ? t('integrations.account', { account: existing.account }) : t('integrations.signedIn')}</p>
              ) : dropped ? (
                <Warning>{t('integrations.signIn.dropWarning')}</Warning>
              ) : (
                <p className="text-muted">{signInNote}</p>
              )}
            </div>
          )}
          {movesTemplate && template && template.connected > 0 && (
            <div data-testid="integration-template-drop-warning">
              <Warning>{t('integrations.template.dropWarning', { n: template.connected })}</Warning>
            </div>
          )}
          {f.writePolicy === 'allow' && !asTemplate && (
            <div data-testid="integration-allow-warning">
              <Warning>{t('integrations.write.allowWarning')}</Warning>
            </div>
          )}
          {/* the rest is one click away: who connects, type, sign-in, notes and what the AI may change */}
          <div>
            <button type="button" aria-expanded={advanced} aria-controls={advancedId} onClick={() => setAdvanced((v) => !v)}
              className="touch-hit inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-ink max-md:min-h-11" data-testid="integration-advanced">
              <ChevronRight size={15} aria-hidden className={clsx('shrink-0 transition', advanced && 'rotate-90')} />
              {t('integrations.advanced')}
            </button>
            <div id={advancedId} hidden={!advanced} className="mt-2 divide-y divide-line border-t border-line [&>*:last-child]:pb-0">
              {team && !existing && !template && (
                <SelectRow<Who> id={ids.who} label={t('integrations.who')} hint={t('integrations.who.short')} value={who} testId="integration-who"
                  onChange={(w) => {
                    setWho(w)
                    // a template is for a member's own key or sign-in: never "no sign-in"
                    if (w === 'template' && f.method === 'none') change({ method: 'key' }, 'method')
                  }}
                  options={(['team', 'template'] as const).map((w) => ({ value: w, label: t(`integrations.who.${w}`), testId: `integration-who-${w}` }))}
                />
              )}
              {!existing && !conn && !fromTeam && (
                <SelectRow<IntegrationKind> id={ids.kind} label={t('integrations.field.kind')} hint={t('integrations.kind.short')} value={f.kind} testId="integration-kind"
                  onChange={(k) => change(withKind(f, k), 'method')}
                  options={(['mcp', 'http'] as const).map((k) => ({ value: k, label: t(`integrations.kind.${k}`), testId: `integration-kind-${k}` }))}
                />
              )}
              {existing && !fromTeam && (
                <p className="py-4 text-sm text-muted">
                  {t('integrations.field.kind')}: <span className="font-medium text-ink">{t(existing.kind === 'mcp' ? 'integrations.kind.mcp' : 'integrations.kind.http')}</span>
                </p>
              )}
              {!conn && !fromTeam && (
                <SelectRow<SignInMethod> id={ids.auth} label={t('integrations.field.auth')} hint={t('integrations.auth.short')} value={f.method} testId="integration-auth"
                  onChange={(m) => change({ method: m }, 'method', 'secret', 'headerName')}
                  error={errorOf('method')}
                  options={methods.map((m) => ({ value: m, label: t(`integrations.auth.${m}`), testId: `integration-auth-${m}` }))}
                />
              )}
              {/* most MCP servers register an app by themselves: their own app is the exception, one click away */}
              {f.method === 'oauth' && f.kind === 'mcp' && !conn && !fromTeam && (
                <AppSection f={f} stored={template ? template.oauthClient : existing?.oauthClient} storedUrl={template?.url ?? existing?.url} change={change} errorOf={errorOf} blur={blur} template={asTemplate} />
              )}
              {(f.kind === 'http' || asTemplate) && !fromTeam && (
                <div className="py-4">
                  <Field label={t(asTemplate ? 'integrations.template.note' : 'integrations.field.notes')} hint={asTemplate ? t('integrations.template.noteHint') : t('integrations.field.notesHint', { n: NOTES_MAX.toLocaleString(locale) })} error={errorOf('notes')}>
                    <textarea className={clsx(inputCls, 'h-auto min-h-24 py-2')} rows={asTemplate ? 3 : 4} maxLength={NOTES_MAX} value={f.notes} placeholder={asTemplate ? t('integrations.template.notePlaceholder') : t('integrations.field.notesPlaceholder')} onChange={(e) => change({ notes: e.target.value }, 'notes')} onBlur={blur('notes')} data-testid="integration-notes" />
                  </Field>
                </div>
              )}
              {!asTemplate && (
                <SelectRow<WritePolicy> id={ids.write} label={t('integrations.field.write')} hint={t('integrations.write.short')} value={f.writePolicy} testId="integration-write"
                  onChange={(p) => change({ writePolicy: p }, 'writePolicy')}
                  error={errorOf('writePolicy')}
                  // "run without asking" is the team's choice (an admin's), never one person's for their own connection
                  options={POLICIES.filter((p) => team || p !== 'allow' || f.writePolicy === 'allow').map((p) => ({ value: p, label: t(`integrations.write.${p}`), testId: `integration-write-${p}` }))}
                  below={!team ? <p className="mt-1.5 text-xs text-faint" data-testid="integration-allow-team-only">{t('integrations.write.allowTeamOnly')}</p> : undefined}
                />
              )}
            </div>
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger" data-testid="integration-dialog-error">
              {error}
            </p>
          )}
        </div>
        {/* Enter in a text field saves */}
        <button type="submit" hidden tabIndex={-1} aria-hidden />
      </form>
    </Modal>
  )
}

/** the aria attributes of a row's control: its short line, or its error once there is one */
const described = (id: string, error: string | null | undefined) => ({ 'aria-describedby': error ? `${id}-error` : `${id}-desc`, 'aria-invalid': error ? true : undefined })

/** One row like Team settings': the words and one short line (or the error) on the left, the control on the right. */
function Row({ id, label, hint, error, below, children, testId }: { id: string; label: string; hint?: string; error?: string | null; below?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <SettingRow id={id} title={label} desc={error ? undefined : hint} control={children} testId={testId}
      below={(error || below) ? <>{error && <p id={`${id}-error`} role="alert" className="mt-1 text-sm text-danger">{error}</p>}{below}</> : undefined} />
  )
}

/** A row whose control is a select (Team settings' kind of choice, in place of a row of radio pills). Each option keeps
 * its own test id. */
function SelectRow<T extends string>({ id, label, hint, value, onChange, options, error, below, testId }: {
  id: string
  label: string
  hint?: string
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string; testId?: string }[]
  error?: string | null
  below?: ReactNode
  testId?: string
}) {
  return (
    <Row id={id} label={label} hint={hint} error={error} below={below}>
      <select id={id} {...described(id, error)} className={clsx(inputCls, 'md:w-64')} value={value} onChange={(e) => onChange(e.target.value as T)} data-testid={testId}>
        {options.map((o) => <option key={o.value} value={o.value} data-testid={o.testId}>{o.label}</option>)}
      </select>
    </Row>
  )
}

/** Your own app at the service (docs/INTEGRATIONS.md "Your own app"): an MCP server offers it behind a checkbox (most
 * register an app by themselves), an API always shows it. The client secret is write-only like a key. The redirect
 * address is where the service sends the browser back: the one this page is open at, as the server builds it. */
function AppSection({ f, stored, storedUrl, change, errorOf, blur, template }: {
  f: IntegrationForm
  stored?: OAuthClientView | null
  /** the saved address: a stored secret does not follow a new one */
  storedUrl?: string
  change: (patch: Partial<IntegrationForm>, ...fields: FormField[]) => void
  errorOf: (k: FormField) => string | null
  blur: (k: FormField) => () => void
  /** the team's app on a template: members sign in through it without seeing it */
  template?: boolean
}) {
  const t = useT()
  const { copied, copy } = useCopy()
  const switchId = useId()
  const api = f.kind === 'http'
  // what the server builds from this page's address (routes/integrations.ts linkBase)
  const redirect = typeof window !== 'undefined' && window.location ? `${window.location.origin}/api/integrations/oauth/callback` : '/api/integrations/oauth/callback'
  const secretStored = storedSecretStays(f, stored, storedUrl)
  // an MCP server finds its addresses; given ones (set before) stay visible so they can be fixed or cleared
  const addresses = api || !!f.authUrl.trim() || !!f.tokenUrl.trim()
  const fields = (
    <div className={clsx('space-y-4', !api && 'mt-3')} data-testid="integration-app-fields">
      <div className="flex items-center gap-2 rounded-lg bg-hover px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-muted">{t('integrations.app.redirect')}</span>
          <code className="block text-xs break-all" data-testid="integration-app-redirect">{redirect}</code>
        </span>
        <Tooltip label={t('common.copy')}>
          <Button size="sm" variant="ghost" onClick={() => void copy(redirect)} aria-label={t('common.copy')} data-testid="integration-app-copy">
            {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          </Button>
        </Tooltip>
      </div>
      <Field label={t('integrations.field.clientId')} error={errorOf('clientId')}>
        <input className={inputCls} value={f.clientId} maxLength={CLIENT_ID_MAX} autoComplete="off" spellCheck={false} onChange={(e) => change({ clientId: e.target.value }, 'clientId')} onBlur={blur('clientId')} data-testid="integration-app-client-id" />
      </Field>
      {secretStored && f.clientSecretAction === 'keep' ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm" data-testid="integration-app-secret-saved">
          <span className="min-w-0 flex-1">{t('integrations.app.secretSaved')}</span>
          <Button size="sm" onClick={() => change({ clientSecretAction: 'replace', clientSecret: '' }, 'clientSecret')} data-testid="integration-app-secret-replace">
            {t('integrations.app.secretReplace')}
          </Button>
        </div>
      ) : (
        <Field label={t('integrations.field.clientSecret')} hint={t(template ? 'integrations.app.secretHintTemplate' : 'integrations.field.keyHint')} error={errorOf('clientSecret')}>
          <input className={inputCls} type="password" value={f.clientSecret} maxLength={CLIENT_SECRET_MAX} autoComplete="off" spellCheck={false} onChange={(e) => change({ clientSecret: e.target.value }, 'clientSecret')} onBlur={blur('clientSecret')} data-testid="integration-app-client-secret" />
        </Field>
      )}
      {addresses && (
        <>
          <Field label={t('integrations.field.authUrl')} error={errorOf('authUrl')}>
            <input className={inputCls} type="url" inputMode="url" value={f.authUrl} maxLength={URL_MAX} autoComplete="off" spellCheck={false} placeholder="https://auth.example.com/oauth2/authorize" onChange={(e) => change({ authUrl: e.target.value }, 'authUrl')} onBlur={blur('authUrl')} data-testid="integration-app-auth-url" />
          </Field>
          <Field label={t('integrations.field.tokenUrl')} error={errorOf('tokenUrl')}>
            <input className={inputCls} type="url" inputMode="url" value={f.tokenUrl} maxLength={URL_MAX} autoComplete="off" spellCheck={false} placeholder="https://auth.example.com/oauth2/token" onChange={(e) => change({ tokenUrl: e.target.value }, 'tokenUrl')} onBlur={blur('tokenUrl')} data-testid="integration-app-token-url" />
          </Field>
        </>
      )}
      {/* an MCP server with both addresses given looks nothing up: an empty field asks for no scope at all */}
      <Field label={t('integrations.field.scope')} hint={t(api ? 'integrations.field.scopeHint.http' : f.authUrl.trim() && f.tokenUrl.trim() ? 'integrations.field.scopeHint.given' : 'integrations.field.scopeHint.mcp')} error={errorOf('scope')}>
        <input className={inputCls} value={f.scope} maxLength={SCOPE_MAX} autoComplete="off" spellCheck={false} onChange={(e) => change({ scope: e.target.value }, 'scope')} onBlur={blur('scope')} data-testid="integration-app-scope" />
      </Field>
    </div>
  )
  if (api) return fields
  // a row like Team settings': the words on the left, a switch on the right; the app's fields open under it
  return (
    <Row id={switchId} label={t('integrations.app.use')} hint={t('integrations.app.useShort')} testId="integration-app" below={f.ownApp ? fields : undefined}>
      <Switch id={switchId} external describedBy={`${switchId}-desc`} label={t('integrations.app.use')} checked={f.ownApp} onChange={(on) => change({ ownApp: on }, 'clientId', 'clientSecret', 'scope')} testId="integration-app-use" />
    </Row>
  )
}

function KeySection({ f, existing, change, errorOf, blur, noKey, fixedHeader }: {
  f: IntegrationForm
  existing?: Integration
  change: (patch: Partial<IntegrationForm>, ...fields: FormField[]) => void
  errorOf: (k: FormField) => string | null
  blur: (k: FormField) => () => void
  /** a template: where the key goes, never the key (each member adds their own) */
  noKey?: boolean
  /** a member's connection made from a template: the header is the template's */
  fixedHeader?: boolean
}) {
  const t = useT()
  const headerId = useId()
  const headerNameId = useId()
  const keyId = useId()
  const stored = !!existing?.hasSecret && (existing.auth === 'bearer' || existing.auth === 'header') && !dropsSecret(f, existing)
  // rows in the dialog's list (Team settings' layout): the header, its name, then the key
  return (
    <>
      {!fixedHeader && (
        <SelectRow<'bearer' | 'custom'> id={headerId} label={t('integrations.field.header')} hint={t('integrations.field.headerShort')} value={f.header} testId="integration-header"
          onChange={(h) => change({ header: h }, 'headerName')}
          options={[
            { value: 'bearer', label: t('integrations.header.bearer'), testId: 'integration-header-bearer' },
            { value: 'custom', label: t('integrations.header.custom'), testId: 'integration-header-custom' },
          ]}
        />
      )}
      {f.header === 'custom' && !fixedHeader && (
        <Row id={headerNameId} label={t('integrations.field.headerName')} hint={t('integrations.field.headerNameHint')} error={errorOf('headerName')}>
          <input id={headerNameId} {...described(headerNameId, errorOf('headerName'))} className={clsx(inputCls, 'md:w-72')} value={f.headerName} maxLength={64} autoComplete="off" spellCheck={false} placeholder="X-API-Key" onChange={(e) => change({ headerName: e.target.value }, 'headerName')} onBlur={blur('headerName')} data-testid="integration-header-name" />
        </Row>
      )}
      {noKey ? (
        <p className="py-4 text-sm text-muted" data-testid="integration-template-key-note">{t('integrations.template.keyNote')}</p>
      ) : stored && f.keyAction !== 'replace' ? (
        <div className="py-4">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm" data-testid="integration-key-saved">
            <span className="min-w-0 flex-1">{f.keyAction === 'remove' ? t('integrations.key.removing') : t('integrations.key.saved')}</span>
            {f.keyAction === 'keep' ? (
              <>
                <Button size="sm" onClick={() => change({ keyAction: 'replace', secret: '' }, 'secret')} data-testid="integration-key-replace">
                  {t('integrations.key.replace')}
                </Button>
                <Button size="sm" variant="danger" onClick={() => change({ keyAction: 'remove', secret: '' }, 'secret')} data-testid="integration-key-remove">
                  {t('integrations.key.remove')}
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => change({ keyAction: 'keep' }, 'secret')}>
                {t('integrations.key.keep')}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <Row id={keyId} label={t(stored ? 'integrations.field.newKey' : 'integrations.field.key')} hint={t('integrations.field.keyHint')} error={errorOf('secret')}
          below={(existing?.hasSecret && dropsSecret(f, existing)) || (stored && f.keyAction === 'replace') ? (
            <div className="mt-2 space-y-2">
              {existing?.hasSecret && dropsSecret(f, existing) && <Warning>{t('integrations.key.dropWarning')}</Warning>}
              {stored && f.keyAction === 'replace' && (
                <Button size="sm" variant="ghost" onClick={() => change({ keyAction: 'keep', secret: '' }, 'secret')}>
                  {t('integrations.key.keep')}
                </Button>
              )}
            </div>
          ) : undefined}>
          <input id={keyId} {...described(keyId, errorOf('secret'))} className={clsx(inputCls, 'md:w-72')} type="password" autoComplete="off" spellCheck={false} value={f.secret} onChange={(e) => change({ secret: e.target.value }, 'secret')} onBlur={blur('secret')} data-testid="integration-key" />
        </Row>
      )}
    </>
  )
}

/** Radio choices as a row of small pills (a radio dot and the label); the chosen option's one line of explanation sits
 * under them, so the choice stays compact. */
export function Choices<T extends string>({ legend, value, onChange, options, error }: {
  legend: string
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string; desc?: string; testId?: string }[]
  error?: string | null
  compact?: boolean
}) {
  const name = useId()
  const errorId = useId()
  const descId = useId()
  const desc = options.find((o) => o.value === value)?.desc
  return (
    <fieldset aria-describedby={clsx(desc && descId, error && errorId) || undefined}>
      <legend className="mb-1.5 text-label font-medium text-ink">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <label key={o.value} className={clsx('inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm hover:bg-hover', value === o.value ? 'border-accent bg-accent-soft' : 'border-line')}>
            <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} data-testid={o.testId} />
            <span className="font-medium">{o.label}</span>
          </label>
        ))}
      </div>
      {desc && <p id={descId} className="mt-1.5 text-xs text-muted">{desc}</p>}
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
    </fieldset>
  )
}

export function Warning({ children }: { children: ReactNode }) {
  return (
    <p role="note" className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
      <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
}

/** Who may use a team connection in their chats: the whole team, or chosen groups and people. Admins are not implied.
 * Also who may use a Drive shared with the team (DriveShares.tsx: `legend`, `note`). */
export function AccessPicker({ value, onChange, groups, users, me, error, template, legend, note }: {
  value: IntegrationAccess
  onChange: (a: IntegrationAccess) => void
  groups: Group[]
  users: User[]
  me: { id: string; groupIds: string[] }
  error?: string | null
  /** a template: who sees it to connect with their own key */
  template?: boolean
  /** another heading and note than a connection's */
  legend?: string
  note?: string
}) {
  const t = useT()
  const name = useId()
  const toggle = (list: 'groups' | 'users', id: string) => onChange({ ...value, [list]: value[list].includes(id) ? value[list].filter((x) => x !== id) : [...value[list], id] })
  const active = users.filter((u) => u.status === 'active')
  return (
    <fieldset className="space-y-2" data-testid="integration-access">
      <legend className="mb-1 text-label font-medium text-ink">{legend ?? t(template ? 'integrations.template.access' : 'integrations.access')}</legend>
      <p className="text-xs text-muted">{note ?? t(template ? 'integrations.template.accessNote' : 'integrations.access.adminNote')}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name={name} checked={value.everyone} onChange={() => onChange({ ...value, everyone: true })} data-testid="integration-access-everyone" /> {t('integrations.access.everyone')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name={name} checked={!value.everyone} onChange={() => onChange({ ...value, everyone: false })} data-testid="integration-access-pick" /> {t('integrations.access.pick')}
        </label>
      </div>
      {!value.everyone && (
        <div className="grid gap-3 sm:grid-cols-2">
          <fieldset>
            <legend className="mb-1 text-xs text-faint">{t('integrations.access.groups')}</legend>
            <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-line p-1.5">
              {!groups.length && <p className="px-1.5 py-1 text-xs text-faint">{t('integrations.access.noGroups')}</p>}
              {groups.map((g) => (
                <label key={g.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-hover">
                  <input type="checkbox" checked={value.groups.includes(g.id)} onChange={() => toggle('groups', g.id)} data-testid="integration-access-group" /> <span className="min-w-0 break-words">{g.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-1 text-xs text-faint">{t('integrations.access.people')}</legend>
            <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-line p-1.5">
              {active.map((u) => (
                <label key={u.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-hover">
                  <input type="checkbox" checked={value.users.includes(u.id)} onChange={() => toggle('users', u.id)} data-testid="integration-access-user" />
                  <span className="min-w-0 break-words">
                    {u.name}
                    {u.id === me.id && <span className="text-xs text-faint"> · {t('integrations.access.me')}</span>}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      )}
      {isEmptyAccess(value) ? (
        <Warning>{t('integrations.access.nobody')}</Warning>
      ) : !template && !covers(value, me) ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn" data-testid="integration-access-not-me">
          <TriangleAlert size={14} className="shrink-0" aria-hidden />
          <span className="min-w-0 flex-[1_1_14rem]">{t('integrations.access.notMe')}</span>
          <Button size="sm" onClick={() => onChange({ ...value, users: [...value.users, me.id] })} data-testid="integration-access-add-me">
            <UserPlus size={14} aria-hidden /> {t('integrations.access.addMe')}
          </Button>
        </div>
      ) : null}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </fieldset>
  )
}
