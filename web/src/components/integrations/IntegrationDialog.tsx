// Add or edit an external-service connection: kind (MCP server / API), name, address, how it signs in (OAuth / key /
// none) and which header carries a key, the key (write-only: editing shows only that one is saved, with replace /
// remove), usage notes for an API, what the AI may change there (ask / allow / refuse), and for a team connection who
// may use it. Checked here like the contract; the server's field errors are shown at their fields.
import clsx from 'clsx'
import { TriangleAlert, UserPlus } from 'lucide-react'
import { useId, useRef, useState, type ReactNode } from 'react'
import type { Group, Integration, IntegrationAccess, IntegrationKind, User, WritePolicy } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import {
  covers, dropsSecret, emptyForm, formFrom, isEmptyAccess, methodsFor, NOTES_MAX, serverFieldErrors, toInput, toPatch, validate, withKind,
  type FormField, type IntegrationForm, type SignInMethod,
} from '../../lib/integrations'
import { mobileApp } from '../../lib/mobile'
import { useLocale, useT } from '../../i18n'
import { useMeStrict } from '../../store/session'
import { useLoad } from '../../pages/admin/common'
import { Button, Field, Modal, inputCls } from '../ui'
import { reserveSignInWindow } from './IntegrationRow'

const POLICIES: WritePolicy[] = ['ask', 'allow', 'deny']

export function IntegrationDialog({ scope, existing, onClose, onSaved }: {
  scope: 'personal' | 'team'
  existing?: Integration
  onClose: () => void
  /** saved. `signIn`: sign in at the service next, in the window reserved during the click (null: none could open) */
  onSaved: (i: Integration, signIn: { window: Window | null } | null) => void
}) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const team = scope === 'team'
  const [f, setF] = useState<IntegrationForm>(() => (existing ? formFrom(existing) : emptyForm('mcp', team ? { everyone: false, groups: [], users: [me.user.id] } : null)))
  const [touched, setTouched] = useState<Partial<Record<FormField, boolean>>>({})
  const [submitted, setSubmitted] = useState(false)
  const [server, setServer] = useState<Partial<Record<FormField, string | null>>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const groups = useLoad(async () => (team ? (await api.call(API.listGroups)).items : []), [team])
  const users = useLoad(async () => (team ? (await api.call(API.listUsers)).items : []), [team])
  const errors = validate(f, existing)
  const phone = !!mobileApp()
  const dropped = dropsSecret(f, existing)
  const signInNext = f.kind === 'mcp' && f.method === 'oauth' && !phone && (!existing || existing.auth !== 'oauth' || dropped)

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
    setSubmitted(true)
    if (Object.keys(errors).length) {
      requestAnimationFrame(() => body.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return
    }
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
      if (!Object.keys(fields).length) setError(errorText(e, locale, t('error.network')))
      else requestAnimationFrame(() => body.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={600}
      title={existing ? t('integrations.editTitle') : team ? t('integrations.addTeamTitle') : t('integrations.addTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void save()} data-testid="integration-save">
            {signInNext ? t('integrations.saveAndSignIn') : t('common.save')}
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
          {existing ? (
            <p className="text-sm text-muted">
              {t('integrations.field.kind')}: <span className="font-medium text-ink">{t(existing.kind === 'mcp' ? 'integrations.kind.mcp' : 'integrations.kind.http')}</span>
            </p>
          ) : (
            <Choices<IntegrationKind>
              legend={t('integrations.field.kind')}
              value={f.kind}
              onChange={(k) => change(withKind(f, k), 'method')}
              options={(['mcp', 'http'] as const).map((k) => ({ value: k, label: t(`integrations.kind.${k}`), desc: t(`integrations.kind.${k}.desc`), testId: `integration-kind-${k}` }))}
            />
          )}
          <Field label={t('integrations.field.name')} hint={t('integrations.field.nameHint')} error={errorOf('name')}>
            <input className={inputCls} value={f.name} maxLength={80} placeholder={t('integrations.field.namePlaceholder')} onChange={(e) => change({ name: e.target.value }, 'name')} onBlur={blur('name')} data-autofocus={existing ? true : undefined} data-testid="integration-name" />
          </Field>
          <Field label={t('integrations.field.url')} hint={t(f.kind === 'mcp' ? 'integrations.field.urlHint.mcp' : 'integrations.field.urlHint.http')} error={errorOf('url')}>
            <input className={inputCls} type="url" inputMode="url" autoComplete="off" spellCheck={false} value={f.url} placeholder={f.kind === 'mcp' ? 'https://mcp.example.com/mcp' : 'https://api.example.com/v1'} onChange={(e) => change({ url: e.target.value }, 'url')} onBlur={blur('url')} data-testid="integration-url" />
          </Field>
          <Choices<SignInMethod>
            legend={t('integrations.field.auth')}
            value={f.method}
            onChange={(m) => change({ method: m }, 'method', 'secret', 'headerName')}
            error={errorOf('method')}
            options={methodsFor(f.kind).map((m) => ({ value: m, label: t(`integrations.auth.${m}`), desc: t(`integrations.auth.${m}.desc`), testId: `integration-auth-${m}` }))}
          />
          {f.method === 'key' && (
            <KeySection f={f} existing={existing} change={change} errorOf={errorOf} blur={blur} />
          )}
          {f.method === 'oauth' && (
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
          {f.kind === 'http' && (
            <Field label={t('integrations.field.notes')} hint={t('integrations.field.notesHint', { n: NOTES_MAX.toLocaleString(locale) })} error={errorOf('notes')}>
              <textarea className={clsx(inputCls, 'h-auto min-h-24 py-2')} rows={4} value={f.notes} placeholder={t('integrations.field.notesPlaceholder')} onChange={(e) => change({ notes: e.target.value }, 'notes')} onBlur={blur('notes')} data-testid="integration-notes" />
            </Field>
          )}
          <div>
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
            {f.writePolicy === 'allow' && (
              <div className="mt-2" data-testid="integration-allow-warning">
                <Warning>{t('integrations.write.allowWarning')}</Warning>
              </div>
            )}
          </div>
          {team && f.access && (
            <AccessPicker value={f.access} onChange={(a) => change({ access: a }, 'access')} groups={groups.data ?? []} users={users.data ?? []} me={{ id: me.user.id, groupIds: me.groups.map((g) => g.id) }} error={errorOf('access')} />
          )}
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

function KeySection({ f, existing, change, errorOf, blur }: {
  f: IntegrationForm
  existing?: Integration
  change: (patch: Partial<IntegrationForm>, ...fields: FormField[]) => void
  errorOf: (k: FormField) => string | null
  blur: (k: FormField) => () => void
}) {
  const t = useT()
  const stored = !!existing?.hasSecret && (existing.auth === 'bearer' || existing.auth === 'header') && !dropsSecret(f, existing)
  return (
    <div className="space-y-4">
      <Choices<'bearer' | 'custom'>
        legend={t('integrations.field.header')}
        value={f.header}
        onChange={(h) => change({ header: h }, 'headerName')}
        compact
        options={[
          { value: 'bearer', label: t('integrations.header.bearer'), testId: 'integration-header-bearer' },
          { value: 'custom', label: t('integrations.header.custom'), testId: 'integration-header-custom' },
        ]}
      />
      {f.header === 'custom' && (
        <Field label={t('integrations.field.headerName')} hint={t('integrations.field.headerNameHint')} error={errorOf('headerName')}>
          <input className={inputCls} value={f.headerName} maxLength={64} autoComplete="off" spellCheck={false} placeholder="X-API-Key" onChange={(e) => change({ headerName: e.target.value }, 'headerName')} onBlur={blur('headerName')} data-testid="integration-header-name" />
        </Field>
      )}
      {stored && f.keyAction !== 'replace' ? (
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

/** Radio choices as bordered rows, each with a line of explanation. */
function Choices<T extends string>({ legend, value, onChange, options, error, compact }: {
  legend: string
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string; desc?: string; testId?: string }[]
  error?: string | null
  compact?: boolean
}) {
  const name = useId()
  const errorId = useId()
  return (
    <fieldset aria-describedby={error ? errorId : undefined}>
      <legend className="mb-1.5 text-[13px] font-medium text-ink">{legend}</legend>
      <div className={clsx(compact ? 'flex flex-wrap gap-2' : 'grid gap-2', !compact && options.length === 2 && 'sm:grid-cols-2', !compact && options.length === 3 && 'sm:grid-cols-3')}>
        {options.map((o) => (
          <label key={o.value} className={clsx('flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-sm hover:bg-hover', value === o.value ? 'border-accent bg-accent-soft' : 'border-line')}>
            <input type="radio" className="mt-0.5" name={name} checked={value === o.value} onChange={() => onChange(o.value)} data-testid={o.testId} />
            <span className="min-w-0">
              <span className="block font-medium">{o.label}</span>
              {o.desc && <span className="mt-0.5 block text-xs text-muted">{o.desc}</span>}
            </span>
          </label>
        ))}
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
    </fieldset>
  )
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <p role="note" className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
      <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
}

/** Who may use a team connection in their chats: the whole team, or chosen groups and people. Admins are not implied. */
function AccessPicker({ value, onChange, groups, users, me, error }: {
  value: IntegrationAccess
  onChange: (a: IntegrationAccess) => void
  groups: Group[]
  users: User[]
  me: { id: string; groupIds: string[] }
  error?: string | null
}) {
  const t = useT()
  const name = useId()
  const toggle = (list: 'groups' | 'users', id: string) => onChange({ ...value, [list]: value[list].includes(id) ? value[list].filter((x) => x !== id) : [...value[list], id] })
  const active = users.filter((u) => u.status === 'active')
  return (
    <fieldset className="space-y-2" data-testid="integration-access">
      <legend className="mb-1 text-[13px] font-medium text-ink">{t('integrations.access')}</legend>
      <p className="text-xs text-muted">{t('integrations.access.adminNote')}</p>
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
      ) : !covers(value, me) ? (
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
