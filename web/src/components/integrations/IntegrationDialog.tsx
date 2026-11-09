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
// scopes, and the redirect address to register at the service. On a template it is the team's app; members never see it.
import clsx from 'clsx'
import { Check, ChevronRight, Copy, TriangleAlert, UserPlus } from 'lucide-react'
import { useId, useRef, useState, type ReactNode } from 'react'
import type { Group, Integration, IntegrationAccess, IntegrationKind, IntegrationTemplate, IntegrationTemplatePatch, User, WritePolicy } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import type { Connector } from '../../lib/connectors'
import {
  appInput, appPatch, authOf, CLIENT_ID_MAX, CLIENT_SECRET_MAX, covers, dropsSecret, emptyForm, formFrom, formFromTemplate, isEmptyAccess, methodsFor, normalAccess, NOBODY, NOTES_MAX, sameAccess, SCOPE_MAX, serverFieldErrors, toInput, toPatch, URL_MAX, usesApp, validate, withKind,
  type FormErrors, type FormField, type IntegrationForm, type SignInMethod,
} from '../../lib/integrations'
import { mobileApp } from '../../lib/mobile'
import { useLocale, useT } from '../../i18n'
import { useMeStrict } from '../../store/session'
import { useLoad } from '../../pages/admin/common'
import { Button, Field, Modal, inputCls, useCopy } from '../ui'
import { Tooltip } from '../Tooltip'
import type { OAuthClientView } from '@mycel/shared/api'
import { reserveSignInWindow } from './IntegrationRow'

const POLICIES: WritePolicy[] = ['ask', 'allow', 'deny']
/** the fields inside Advanced (it opens when one of them needs fixing): an MCP server's own app is there, an API's not */
const advancedFields = (f: IntegrationForm): FormField[] =>
  ['method', 'notes', 'writePolicy', 'access', ...(f.kind === 'mcp' ? ['clientId', 'clientSecret', 'scope', 'authUrl', 'tokenUrl'] as FormField[] : [])]
/** Admin: a connection for the team with one key, or a template each member connects with their own */
type Who = 'team' | 'template'

export function IntegrationDialog({ scope, existing, template, connector, startAs, onClose, onSaved, onSavedTemplate }: {
  scope: 'personal' | 'team'
  existing?: Integration
  /** editing this template (Admin) */
  template?: IntegrationTemplate
  /** adding this service from Discover */
  connector?: Connector
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
    // a template starts with the whole team (it carries no key); one team key starts with only you
    const blank = emptyForm('mcp', team ? (startAs === 'template' ? { everyone: true, groups: [], users: [] } : { everyone: false, groups: [], users: [me.user.id] }) : null)
    return connector ? { ...blank, name: connector.name, url: connector.url } : blank
  })
  // the admin picked who it is for: switching between "one team key" and "template" no longer changes it
  const [accessChosen, setAccessChosen] = useState(false)
  const [touched, setTouched] = useState<Partial<Record<FormField, boolean>>>({})
  const [submitted, setSubmitted] = useState(false)
  const [server, setServer] = useState<Partial<Record<FormField, string | null>>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  // Advanced starts closed, except when what needs fixing is in it
  const [advanced, setAdvanced] = useState(false)
  const advancedId = useId()
  const groups = useLoad(async () => (team ? (await api.call(API.listGroups)).items : []), [team])
  const users = useLoad(async () => (team ? (await api.call(API.listUsers)).items : []), [team])
  // a template takes no key: what is wrong with one is not this form's
  const errors: FormErrors = asTemplate ? (({ secret: _secret, ...rest }: FormErrors) => rest)(validate(f, existing)) : validate(f, existing)
  const phone = !!mobileApp()
  const dropped = dropsSecret(f, existing)
  const signInNext = !asTemplate && f.method === 'oauth' && !phone && (!existing || existing.auth !== 'oauth' || dropped)
  // editing a template: a new address, sign-in method, header or app drops every member's key (they connect again)
  const movesTemplate = !!template && (f.url.trim() !== template.url || authOf(f) !== template.auth || (authOf(f) === 'header' && f.headerName.trim() !== (template.authHeader ?? ''))
    || (authOf(f) === 'oauth' && appPatch(f, template.oauthClient) !== undefined))
  const methods = methodsFor(f.kind).filter((m) => !asTemplate || m !== 'none')
  // what Advanced holds, in one line next to it
  const summary = [
    team && !existing && !template ? t(`integrations.who.${who}`) : null,
    t(f.kind === 'mcp' ? 'integrations.kind.mcp' : 'integrations.kind.http'),
    fromTeam ? null : t(`integrations.auth.${f.method}`),
    !fromTeam && f.kind === 'mcp' && usesApp(f) ? t('integrations.app.use') : null,
    asTemplate ? null : t(`integrations.write.${f.writePolicy}`),
    team && f.access ? (f.access.everyone ? t('integrations.access.everyone') : t('integrations.access.pick')) : null,
  ].filter(Boolean).join(' · ')

  const errorOf = (k: FormField): string | null => {
    if (k in server) return server[k] ?? t('integrations.error.field')
    const e = errors[k]
    return e && (submitted || touched[k]) ? t(e) : null
  }
  const change = (patch: Partial<IntegrationForm>, ...fields: FormField[]) => {
    setF((x) => ({ ...x, ...patch }))
    if (fields.some((k) => k in server)) setServer((s) => Object.fromEntries(Object.entries(s).filter(([k]) => !fields.includes(k as FormField))))
    setError(null)
  }
  const blur = (k: FormField) => () => setTouched((x) => ({ ...x, [k]: true }))

  const save = async () => {
    if (busy) return
    setSubmitted(true)
    if (Object.keys(errors).length) {
      if (advancedFields(f).some((k) => k in errors)) setAdvanced(true)
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
      // from Discover the name and address are not on screen, so an error about them has to say so here
      if (!Object.keys(fields).length || connector) setError(errorText(e, locale, t('error.network')))
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
        const app = auth === 'oauth' ? appPatch(f, template.oauthClient) : undefined
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
      if (!Object.keys(fields).length || connector) setError(errorText(e, locale, t('error.network')))
      else requestAnimationFrame(() => body.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
    } finally {
      setBusy(false)
    }
  }

  const title = template ? t('integrations.template.editTitle')
    : existing ? t('integrations.editTitle')
      : connector ? t(team ? 'integrations.discover.addTeam' : 'integrations.discover.add', { name: connector.name })
        : team ? t('integrations.addTeamTitle') : t('integrations.addTitle')
  return (
    <Modal
      open
      onClose={onClose}
      width={600}
      title={title}
      footer={
        <>
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
        className="space-y-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div ref={body} className="space-y-5">
          {fromTeam && existing ? (
            <div className="space-y-1 text-sm" data-testid="integration-from-team">
              <p className="text-muted">{t('integrations.field.url')}: <span className="font-medium break-all text-ink">{existing.url}</span></p>
              <p className="text-xs text-faint">{t('integrations.template.memberNote')}</p>
            </div>
          ) : connector ? (
            <p className="text-sm text-muted" data-testid="connector-summary">
              {t('integrations.field.url')}: <span className="font-medium break-all text-ink">{connector.url}</span>
            </p>
          ) : (
            <>
              <Field label={t('integrations.field.name')} error={errorOf('name')}>
                <input className={inputCls} value={f.name} maxLength={80} placeholder={t('integrations.field.namePlaceholder')} onChange={(e) => change({ name: e.target.value }, 'name')} onBlur={blur('name')} data-autofocus={existing ? true : undefined} data-testid="integration-name" />
              </Field>
              <Field label={t('integrations.field.url')} hint={t(f.kind === 'mcp' ? 'integrations.field.urlHint.mcp' : 'integrations.field.urlHint.http')} error={errorOf('url')}>
                <input className={inputCls} type="url" inputMode="url" autoComplete="off" spellCheck={false} value={f.url} placeholder={f.kind === 'mcp' ? 'https://mcp.example.com/mcp' : 'https://api.example.com/v1'} onChange={(e) => change({ url: e.target.value }, 'url')} onBlur={blur('url')} data-testid="integration-url" />
              </Field>
            </>
          )}
          {f.method === 'key' && (
            <KeySection f={f} existing={existing} change={change} errorOf={errorOf} blur={blur} noKey={asTemplate} fixedHeader={fromTeam} />
          )}
          {asTemplate && f.method === 'oauth' && (
            <p className="text-sm text-muted" data-testid="integration-template-oauth-note">{t('integrations.template.oauthNote')}</p>
          )}
          {/* an API signs in only with its own app: its fields are required, so they sit with the address (like a key) */}
          {f.method === 'oauth' && f.kind === 'http' && !fromTeam && (
            <AppSection f={f} stored={template ? template.oauthClient : existing?.oauthClient} change={change} errorOf={errorOf} blur={blur} template={asTemplate} />
          )}
          {!asTemplate && f.method === 'oauth' && (
            <div className="text-sm" data-testid="integration-oauth-note">
              {existing?.hasSecret && existing.auth === 'oauth' && !dropped ? (
                <p className="text-muted">{existing.account ? t('integrations.account', { account: existing.account }) : t('integrations.signedIn')}</p>
              ) : dropped ? (
                <Warning>{t('integrations.signIn.dropWarning')}</Warning>
              ) : (
                <p className="text-muted">{t(phone ? 'integrations.signIn.phone' : 'integrations.signIn.next')}</p>
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
          {/* the rest is one click away: type, sign-in, notes, what the AI may change, and (Admin) who connects and who may use it */}
          <div className="rounded-xl border border-line">
            <button type="button" aria-expanded={advanced} aria-controls={advancedId} onClick={() => setAdvanced((v) => !v)}
              className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-hover" data-testid="integration-advanced">
              <ChevronRight size={15} aria-hidden className={clsx('shrink-0 text-muted transition', advanced && 'rotate-90')} />
              <span className="font-medium">{t('integrations.advanced')}</span>
              <span className="ml-auto min-w-0 truncate text-xs text-muted" data-testid="integration-advanced-summary">{summary}</span>
            </button>
            <div id={advancedId} hidden={!advanced} className="space-y-5 border-t border-line p-3">
              {team && !existing && !template && (
                <Choices<Who>
                  legend={t('integrations.who')}
                  value={who}
                  onChange={(w) => {
                    setWho(w)
                    // a template is for a member's own key or sign-in: never "no sign-in"
                    if (w === 'template' && f.method === 'none') change({ method: 'key' }, 'method')
                    // a template carries no key, so it starts with the whole team; one team key starts with only you
                    if (!accessChosen) change({ access: w === 'template' ? { everyone: true, groups: [], users: [] } : { everyone: false, groups: [], users: [me.user.id] } }, 'access')
                  }}
                  options={(['team', 'template'] as const).map((w) => ({ value: w, label: t(`integrations.who.${w}`), desc: t(`integrations.who.${w}.desc`), testId: `integration-who-${w}` }))}
                />
              )}
              {!existing && !connector && !fromTeam && (
                <Choices<IntegrationKind>
                  legend={t('integrations.field.kind')}
                  value={f.kind}
                  onChange={(k) => change(withKind(f, k), 'method')}
                  options={(['mcp', 'http'] as const).map((k) => ({ value: k, label: t(`integrations.kind.${k}`), desc: t(`integrations.kind.${k}.desc`), testId: `integration-kind-${k}` }))}
                />
              )}
              {existing && !fromTeam && (
                <p className="text-sm text-muted">
                  {t('integrations.field.kind')}: <span className="font-medium text-ink">{t(existing.kind === 'mcp' ? 'integrations.kind.mcp' : 'integrations.kind.http')}</span>
                </p>
              )}
              {!connector && !fromTeam && (
                <Choices<SignInMethod>
                  legend={t('integrations.field.auth')}
                  value={f.method}
                  onChange={(m) => change({ method: m }, 'method', 'secret', 'headerName')}
                  error={errorOf('method')}
                  options={methods.map((m) => ({ value: m, label: t(`integrations.auth.${m}`), desc: t(`integrations.auth.${m}.desc`), testId: `integration-auth-${m}` }))}
                />
              )}
              {/* most MCP servers register an app by themselves: their own app is the exception, one click away */}
              {f.method === 'oauth' && f.kind === 'mcp' && !connector && !fromTeam && (
                <AppSection f={f} stored={template ? template.oauthClient : existing?.oauthClient} change={change} errorOf={errorOf} blur={blur} template={asTemplate} />
              )}
              {(f.kind === 'http' || asTemplate) && !fromTeam && (
                <Field label={t(asTemplate ? 'integrations.template.note' : 'integrations.field.notes')} hint={asTemplate ? t('integrations.template.noteHint') : t('integrations.field.notesHint', { n: NOTES_MAX.toLocaleString(locale) })} error={errorOf('notes')}>
                  <textarea className={clsx(inputCls, 'h-auto min-h-24 py-2')} rows={asTemplate ? 3 : 4} maxLength={NOTES_MAX} value={f.notes} placeholder={asTemplate ? t('integrations.template.notePlaceholder') : t('integrations.field.notesPlaceholder')} onChange={(e) => change({ notes: e.target.value }, 'notes')} onBlur={blur('notes')} data-testid="integration-notes" />
                </Field>
              )}
              {!asTemplate && <div>
                <Choices<WritePolicy>
                  legend={t('integrations.field.write')}
                  value={f.writePolicy}
                  onChange={(p) => change({ writePolicy: p }, 'writePolicy')}
                  error={errorOf('writePolicy')}
                  // "run without asking" is the team's choice (an admin's), never one person's for their own connection
                  options={POLICIES.filter((p) => team || p !== 'allow' || f.writePolicy === 'allow').map((p) => ({ value: p, label: t(`integrations.write.${p}`), desc: t(`integrations.write.${p}.desc`), testId: `integration-write-${p}` }))}
                />
                {!team && (
                  <p className="mt-1.5 text-xs text-faint" data-testid="integration-allow-team-only">
                    {t('integrations.write.allowTeamOnly')}
                  </p>
                )}
              </div>}
              {team && f.access && (
                <AccessPicker value={f.access} onChange={(a) => { setAccessChosen(true); change({ access: a }, 'access') }} groups={groups.data ?? []} users={users.data ?? []} me={{ id: me.user.id, groupIds: me.groups.map((g) => g.id) }} error={errorOf('access')} template={asTemplate} />
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

/** Your own app at the service (docs/INTEGRATIONS.md "Your own app"): an MCP server offers it behind a checkbox (most
 * register an app by themselves), an API always shows it. The client secret is write-only like a key. The redirect
 * address is where the service sends the browser back: the one this page is open at, as the server builds it. */
function AppSection({ f, stored, change, errorOf, blur, template }: {
  f: IntegrationForm
  stored?: OAuthClientView | null
  change: (patch: Partial<IntegrationForm>, ...fields: FormField[]) => void
  errorOf: (k: FormField) => string | null
  blur: (k: FormField) => () => void
  /** the team's app on a template: members sign in through it without seeing it */
  template?: boolean
}) {
  const t = useT()
  const { copied, copy } = useCopy()
  const api = f.kind === 'http'
  // what the server builds from this page's address (routes/integrations.ts linkBase)
  const redirect = typeof window !== 'undefined' && window.location ? `${window.location.origin}/api/integrations/oauth/callback` : '/api/integrations/oauth/callback'
  const secretStored = !!stored?.hasSecret && stored.clientId === f.clientId.trim()
  const fields = (
    <div className={clsx('space-y-4', !api && 'pl-6')} data-testid="integration-app-fields">
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
            {t('integrations.key.replace')}
          </Button>
        </div>
      ) : (
        <Field label={t('integrations.field.clientSecret')} hint={t(template ? 'integrations.app.secretHintTemplate' : 'integrations.field.keyHint')} error={errorOf('clientSecret')}>
          <input className={inputCls} type="password" value={f.clientSecret} maxLength={CLIENT_SECRET_MAX} autoComplete="off" spellCheck={false} onChange={(e) => change({ clientSecret: e.target.value }, 'clientSecret')} onBlur={blur('clientSecret')} data-testid="integration-app-client-secret" />
        </Field>
      )}
      {api && (
        <>
          <Field label={t('integrations.field.authUrl')} error={errorOf('authUrl')}>
            <input className={inputCls} type="url" inputMode="url" value={f.authUrl} maxLength={URL_MAX} autoComplete="off" spellCheck={false} placeholder="https://auth.example.com/oauth2/authorize" onChange={(e) => change({ authUrl: e.target.value }, 'authUrl')} onBlur={blur('authUrl')} data-testid="integration-app-auth-url" />
          </Field>
          <Field label={t('integrations.field.tokenUrl')} error={errorOf('tokenUrl')}>
            <input className={inputCls} type="url" inputMode="url" value={f.tokenUrl} maxLength={URL_MAX} autoComplete="off" spellCheck={false} placeholder="https://auth.example.com/oauth2/token" onChange={(e) => change({ tokenUrl: e.target.value }, 'tokenUrl')} onBlur={blur('tokenUrl')} data-testid="integration-app-token-url" />
          </Field>
        </>
      )}
      <Field label={t('integrations.field.scope')} hint={t(api ? 'integrations.field.scopeHint.http' : 'integrations.field.scopeHint.mcp')} error={errorOf('scope')}>
        <input className={inputCls} value={f.scope} maxLength={SCOPE_MAX} autoComplete="off" spellCheck={false} onChange={(e) => change({ scope: e.target.value }, 'scope')} onBlur={blur('scope')} data-testid="integration-app-scope" />
      </Field>
    </div>
  )
  if (api) return fields
  return (
    <div className="space-y-3" data-testid="integration-app">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={f.ownApp} onChange={(e) => change({ ownApp: e.target.checked }, 'clientId', 'clientSecret', 'scope')} data-testid="integration-app-use" />
        <span className="min-w-0">
          <span className="font-medium">{t('integrations.app.use')}</span>
          <span className="block text-xs text-muted">{t('integrations.app.useDesc')}</span>
        </span>
      </label>
      {f.ownApp && fields}
    </div>
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
  const stored = !!existing?.hasSecret && (existing.auth === 'bearer' || existing.auth === 'header') && !dropsSecret(f, existing)
  return (
    <div className="space-y-4">
      {!fixedHeader && <Choices<'bearer' | 'custom'>
        legend={t('integrations.field.header')}
        value={f.header}
        onChange={(h) => change({ header: h }, 'headerName')}
        compact
        options={[
          { value: 'bearer', label: t('integrations.header.bearer'), testId: 'integration-header-bearer' },
          { value: 'custom', label: t('integrations.header.custom'), testId: 'integration-header-custom' },
        ]}
      />}
      {f.header === 'custom' && !fixedHeader && (
        <Field label={t('integrations.field.headerName')} hint={t('integrations.field.headerNameHint')} error={errorOf('headerName')}>
          <input className={inputCls} value={f.headerName} maxLength={64} autoComplete="off" spellCheck={false} placeholder="X-API-Key" onChange={(e) => change({ headerName: e.target.value }, 'headerName')} onBlur={blur('headerName')} data-testid="integration-header-name" />
        </Field>
      )}
      {noKey ? (
        <p className="text-xs text-faint" data-testid="integration-template-key-note">{t('integrations.template.keyNote')}</p>
      ) : stored && f.keyAction !== 'replace' ? (
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
      ) : (
        <div className="space-y-2">
          {existing?.hasSecret && dropsSecret(f, existing) && <Warning>{t('integrations.key.dropWarning')}</Warning>}
          <Field label={t(stored ? 'integrations.field.newKey' : 'integrations.field.key')} hint={t('integrations.field.keyHint')} error={errorOf('secret')}>
            <input className={inputCls} type="password" autoComplete="off" spellCheck={false} value={f.secret} onChange={(e) => change({ secret: e.target.value }, 'secret')} onBlur={blur('secret')} data-testid="integration-key" />
          </Field>
          {stored && f.keyAction === 'replace' && (
            <Button size="sm" variant="ghost" onClick={() => change({ keyAction: 'keep', secret: '' }, 'secret')}>
              {t('integrations.key.keep')}
            </Button>
          )}
        </div>
      )}
    </div>
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
