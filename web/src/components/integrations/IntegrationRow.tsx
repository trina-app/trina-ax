// One external-service connection in a list (Settings > External services, Admin > External services): one line with
// the name, kind or what is wrong (it failed, or, connected, its last check failed), its state, and in Admin whether
// nobody or not the admin looking at it may use it. A click opens the
// rest: the address, which tool list the AI keeps using, the stored key or signed-in account (never the key itself),
// last use, the MCP server's tools (with a switch each for whoever manages it, like Claude's connector tools: a tool
// turned off is not offered to the AI, server/src/integrations/connections/tools.ts; tools the service adds later are
// on), and for people who manage it check again / sign in / edit / delete. Signing in stays on the line while it is what
// the connection needs. Signing in (MCP OAuth) opens the service's page in a window reserved during the click and polls
// the flow until the server has the tokens.
import clsx from 'clsx'
import { Check, ChevronDown, ChevronRight, Globe, LogIn, Pencil, RefreshCw, Trash2, Waypoints } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { Group, Integration, IntegrationAccess, IntegrationFlow, User } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { connectorFor } from '../../lib/connectors'
import { formatDateTime } from '../../lib/format'
import { audienceOf, authorizationUrl, canSignIn, flowReasonKey, lastCheckNote, STATUS_TONE, toolsShortfall } from '../../lib/integrations'
import { mobileApp } from '../../lib/mobile'
import { useLocale, useT } from '../../i18n'
import { toast } from '../../store/ui'
import { ConnectorLogo } from './ConnectorsView'
import { Badge, Button, IconButton, Switch, confirmDialog } from '../ui'
import { Tooltip } from '../Tooltip'

/** A blank window opened during the click (a window opened later, after the server answers, is blocked as a popup).
 * The phone app has no sign-in return yet: no window there. */
export function reserveSignInWindow(): Window | null {
  if (mobileApp()) return null
  const w = window.open('about:blank', '_blank')
  if (w) w.opener = null
  return w
}

export interface SignInState {
  id: string
  flowId: string | null
  url: string | null
  state: IntegrationFlow['state'] | 'starting'
  /** why it failed, in words for the person (never the server's code) */
  reason: string | null
}

const WAITING = new Set<SignInState['state']>(['starting', 'pending', 'exchanging'])

/** Signing in at one connection's service at a time: start (with a window reserved during the click), poll, cancel. */
export function useSignIn(onCompleted: (id: string) => void) {
  const t = useT()
  const locale = useLocale()
  const [s, setS] = useState<SignInState | null>(null)
  const popup = useRef<Window | null>(null)
  const generation = useRef(0)
  const done = useRef(onCompleted)
  done.current = onCompleted
  useEffect(() => () => {
    generation.current++
    popup.current?.close()
  }, [])
  const waiting = !!s?.flowId && (s.state === 'pending' || s.state === 'exchanging')
  useEffect(() => {
    if (!waiting || !s?.flowId) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const g = generation.current, flowId = s.flowId, id = s.id
    const poll = async () => {
      try {
        const f = await api.call(API.integrationFlow, { params: { id: flowId } })
        if (!active || g !== generation.current) return
        if (f.state === 'completed') {
          popup.current?.close()
          popup.current = null
          setS(null)
          done.current(id)
          return
        }
        if (f.state === 'failed' || f.state === 'expired') {
          popup.current?.close()
          popup.current = null
          // the server's reason is a code: shown in words (never the code itself)
          setS((x) => (x && x.flowId === flowId ? { ...x, state: f.state, reason: f.state === 'failed' ? t(flowReasonKey(f.reason)) : null } : x))
          return
        }
        setS((x) => (x && x.flowId === flowId && x.state !== f.state ? { ...x, state: f.state } : x))
      } catch (e) {
        if (!active || g !== generation.current) return
        setS((x) => (x && x.flowId === flowId ? { ...x, state: 'failed', reason: errorText(e, locale, t('error.network')) } : x))
        return
      }
      if (active && g === generation.current) timer = setTimeout(poll, 1500)
    }
    timer = setTimeout(poll, 1000)
    return () => {
      active = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.flowId, waiting])

  /** call during the click (or pass the window reserved during it) */
  const start = async (id: string, reserved?: Window | null) => {
    const g = ++generation.current
    if (popup.current && popup.current !== reserved) popup.current.close()
    popup.current = reserved !== undefined ? reserved : reserveSignInWindow()
    setS({ id, flowId: null, url: null, state: 'starting', reason: null })
    try {
      const r = await api.call(API.authorizeIntegration, { params: { id }, body: {} })
      if (g !== generation.current) return
      let url: string
      try {
        url = authorizationUrl(r.authorizationUrl)
      } catch {
        popup.current?.close()
        popup.current = null
        setS({ id, flowId: null, url: null, state: 'failed', reason: t('integrations.signIn.badUrl') })
        return
      }
      setS({ id, flowId: r.flowId, url, state: 'pending', reason: null })
      if (popup.current && !popup.current.closed) popup.current.location.replace(url)
    } catch (e) {
      if (g !== generation.current) return
      popup.current?.close()
      popup.current = null
      setS({ id, flowId: null, url: null, state: 'failed', reason: errorText(e, locale, t('error.network')) })
    }
  }

  const cancel = () => {
    generation.current++
    popup.current?.close()
    popup.current = null
    setS(null)
  }

  return { state: s, start, cancel }
}

/** Check again, delete, sign in, and what follows a save, for a list of connections (`add` / `replace`: one is new or
 * came back changed; `reload`: fetch the list again). */
export function useIntegrationActions({ add, replace, reload }: { add: (i: Integration) => void; replace: (i: Integration) => void; reload: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [checking, setChecking] = useState<string | null>(null)
  // one tool on or off for the AI (a second click while its request is on its way is ignored)
  const switching = useRef(new Set<string>())
  const setTool = async (i: Integration, name: string, enabled: boolean) => {
    const key = `${i.id}\n${name}`
    if (switching.current.has(key)) return
    switching.current.add(key)
    try {
      replace(await api.call(API.setIntegrationTool, { params: { id: i.id }, body: { name, enabled } }))
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      switching.current.delete(key)
    }
  }
  const refresh = async (i: Integration) => {
    setChecking(i.id)
    try {
      const r = await api.call(API.refreshIntegration, { params: { id: i.id }, body: {} })
      replace(r)
      // connected with a reason: the check failed, the tools saved before stay (the row says so)
      toast(r.status === 'connected' && !r.lastError ? { level: 'success', text: t('integrations.checked') } : { level: 'warn', text: t('integrations.checkFailed') })
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setChecking(null)
    }
  }
  const remove = async (i: Integration) => {
    const ok = await confirmDialog({ title: t('integrations.deleteTitle', { name: i.name }), body: t(i.scope === 'team' ? 'integrations.deleteBodyTeam' : 'integrations.deleteBody'), confirm: t('common.delete'), danger: true })
    if (!ok) return
    try {
      await api.call(API.deleteIntegration, { params: { id: i.id } })
      toast({ level: 'success', text: t('integrations.deleted') })
      reload()
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }
  const signIn = useSignIn(() => {
    toast({ level: 'success', text: t('integrations.signIn.done') })
    reload()
  })
  /** the dialog saved `i`: show it, then sign in at the service (in the window reserved during the click) or say how
   * the check went: connected, sign-in still to do, or saved but failing (the row says why) */
  const saved = (i: Integration, next: { window: Window | null } | null, created: boolean) => {
    if (created) add(i)
    else replace(i)
    if (next && i.status === 'needs_auth') return void signIn.start(i.id, next.window)
    next?.window?.close()
    if (i.status === 'error') toast({ level: 'warn', text: t('integrations.savedWithError') })
    else if (i.status === 'needs_auth') toast({ level: 'info', text: t('integrations.savedNeedsSignIn') })
    else toast({ level: 'success', text: created ? t('integrations.connected') : t('common.saved') })
  }
  return { checking, refresh, remove, signIn, saved, setTool }
}

export type IntegrationActions = ReturnType<typeof useIntegrationActions>

/** Admin › Connectors: who may use a team connection or template, as one quiet chip after its name ("Everyone",
 * "Design +2", "3 people"), every name in its tip. Nothing when nobody may (the row warns instead), or until the
 * groups and people have loaded. */
export function AudienceChip({ access, groups, users }: { access: IntegrationAccess; groups: Group[] | null; users: User[] | null }) {
  const t = useT()
  if (!groups || !users) return null
  const a = audienceOf(access, groups, users)
  if (!a) return null
  const label = a.kind === 'everyone' ? t('integrations.audience.everyone')
    : a.kind === 'people' ? t('integrations.audience.people', { n: a.n })
    : a.more ? t('integrations.audience.more', { name: a.name, n: a.more }) : a.name
  return (
    <span className="inline-flex min-w-0" title={a.kind === 'everyone' ? undefined : t('integrations.users', { who: a.all })} data-testid="integration-audience">
      <Badge className="max-w-48"><span className="min-w-0 truncate">{label}</span></Badge>
    </span>
  )
}

export function IntegrationRow({ i, actions, onEdit, readOnly, state, audience, alert, extra }: {
  i: Integration
  actions: IntegrationActions
  onEdit: () => void
  /** no managing here, even for whoever may (Settings' "From <team>": an admin manages them in Admin › Connectors) */
  readOnly?: boolean
  /** what this person gets, on the right instead of the connection's state (Settings' "From <team>": Ready, Off for you) */
  state?: ReactNode
  /** right after the name (Admin: who may use it, AudienceChip) */
  audience?: ReactNode
  /** a warning that stays on the line, not in the details (Admin: nobody may use it, or not the admin looking at it) */
  alert?: ReactNode
  /** more lines under the details (Admin: who may use it) */
  extra?: ReactNode
}) {
  const t = useT()
  const locale = useLocale()
  const [details, setDetails] = useState(false)
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const toolsId = useId()
  const manage = i.canManage && !readOnly
  const flow = actions.signIn.state?.id === i.id ? actions.signIn.state : null
  const checking = actions.checking === i.id
  const phone = !!mobileApp()
  const KindIcon = i.kind === 'mcp' ? Waypoints : Globe
  const listed = connectorFor(i.url)
  // the line under the name: what a known service does ("Search, read and update your pages…"), the kind ("MCP server",
  // "API") only for one added by its address, which only owners and admins add (docs/DECISIONS.md "Plain words for
  // members")
  const kindLabel = listed ? t(`integrations.catalog.${listed.id}`) : t(i.kind === 'mcp' ? 'integrations.kind.mcp' : 'integrations.kind.http')
  const off = i.tools.filter((x) => x.enabled === false).length
  const short = toolsShortfall(i)
  const note = lastCheckNote(i)
  const failing = !!i.lastError && i.status !== 'connected'
  const meta: string[] = []
  if (i.auth === 'bearer' || i.auth === 'header') meta.push(t(i.hasSecret ? 'integrations.keySaved' : 'integrations.keyMissing'))
  if (i.auth === 'oauth' && i.hasSecret) meta.push(i.account ? t('integrations.account', { account: i.account }) : t('integrations.signedIn'))
  meta.push(i.lastUsedAt ? t('integrations.lastUsed', { date: formatDateTime(i.lastUsedAt, locale) }) : t('integrations.neverUsed'))
  const signInButton = manage && canSignIn(i) && !phone && !flow && (
    <Button size="sm" variant={i.status === 'needs_auth' ? 'primary' : 'secondary'} className="shrink-0" onClick={() => void actions.signIn.start(i.id)} data-testid="integration-signin-start">
      <LogIn size={14} aria-hidden /> {t(i.hasSecret ? 'integrations.signInAgain' : 'integrations.signIn')}
    </Button>
  )
  return (
    <li className="py-1" data-testid="integration-row" data-name={i.name} data-scope={i.scope} data-status={i.status}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={details}
          aria-controls={details ? detailsId : undefined}
          onClick={() => setDetails((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-2 text-left hover:bg-hover"
          data-testid="integration-toggle"
        >
          {listed ? <ConnectorLogo c={listed} className="size-9" /> : (
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-subtle text-muted">
              <KindIcon size={16} aria-hidden />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="max-w-full truncate text-sm font-medium" title={i.name}>{i.name}</span>
              {audience}
              {i.writePolicy === 'allow' && <Badge tone="warn">{t('integrations.write.allow')}</Badge>}
              {alert}
            </span>
            <span className={clsx('mt-0.5 block truncate text-xs', failing ? 'text-danger' : note ? 'text-warn' : 'text-muted')} title={i.lastError ?? undefined}>
              {i.lastError ?? kindLabel}
            </span>
          </span>
          {state ?? (i.status === 'connected' ? (
            <Tooltip label={t('integrations.status.connected')}>
              <span className="flex shrink-0 items-center text-ok">
                <Check size={16} aria-hidden />
                <span className="sr-only">{t('integrations.status.connected')}</span>
              </span>
            </Tooltip>
          ) : (
            // beside a sign-in button a phone's width goes to the name: the button says the same
            <Badge tone={STATUS_TONE[i.status]} className={clsx('shrink-0', signInButton && 'max-sm:hidden')}>{t(`integrations.status.${i.status}`)}</Badge>
          ))}
          <ChevronDown size={15} className={clsx('shrink-0 text-faint transition-transform', details && 'rotate-180')} aria-hidden />
        </button>
        {i.status === 'needs_auth' && signInButton}
      </div>
      {flow && <SignInPanel flow={flow} onRetry={() => void actions.signIn.start(i.id)} onCancel={actions.signIn.cancel} />}
      {details && (
        <div id={detailsId} className="pr-2 pb-3 pl-2 sm:pl-14" data-testid="integration-details">
          <p className="text-xs break-all text-faint">{i.url}</p>
          {failing && (
            <p className="mt-1 text-xs break-words text-danger" data-testid="integration-error">
              {i.lastError}
            </p>
          )}
          {note && (
            <p className="mt-1 text-xs break-words text-warn" data-testid="integration-check-failed">
              {t(note.key, { reason: note.reason, date: note.date ? formatDateTime(note.date, locale) : '' })}
            </p>
          )}
          <p className="mt-1 text-xs text-muted" data-testid="integration-meta">
            {meta.join(' · ')}
          </p>
          {i.writePolicy === 'deny' && <p className="mt-1"><Badge>{t('integrations.write.deny')}</Badge></p>}
          {manage && canSignIn(i) && phone && <p className="mt-1 text-xs text-muted">{t('integrations.signIn.phone')}</p>}
          {extra}
          {manage && (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {i.status !== 'needs_auth' && signInButton}
              <Button size="sm" disabled={checking} onClick={() => void actions.refresh(i)} data-testid="integration-refresh">
                <RefreshCw size={14} className={clsx(checking && 'animate-spin')} aria-hidden /> {t('integrations.refresh')}
              </Button>
              <IconButton label={t('integrations.edit', { name: i.name })} onClick={onEdit} data-testid="integration-edit">
                <Pencil size={15} />
              </IconButton>
              <IconButton label={t('integrations.delete', { name: i.name })} danger onClick={() => void actions.remove(i)} data-testid="integration-delete">
                <Trash2 size={15} />
              </IconButton>
            </div>
          )}
          {i.kind === 'mcp' && (i.tools.length > 0 || i.status === 'connected') && (
            <div className="mt-2">
              <button type="button" aria-expanded={open} aria-controls={toolsId} onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 rounded text-xs font-medium text-accent-text hover:underline" data-testid="integration-tools-toggle">
                {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                {short ? t(short === 'integrations.toolsCappedMore' ? 'integrations.toolsOfMore' : 'integrations.toolsOf', { n: i.tools.length, total: i.toolsTotal! }) : t('integrations.tools', { n: i.tools.length })}
                {off > 0 && <span className="font-normal text-muted" data-testid="integration-tools-off"> · {t('integrations.toolsOff', { n: off })}</span>}
              </button>
              {open && (
                <div id={toolsId} className="mt-2">
                  {!i.tools.length ? (
                    <p className="text-xs text-faint">{t('integrations.noTools')}</p>
                  ) : (
                    <ul className="divide-y divide-line rounded-lg border border-line" data-testid="integration-tools">
                      {i.tools.map((x) => {
                        const on = x.enabled !== false
                        return (
                          <li key={x.name} className="flex items-start gap-3 px-3 py-2 text-xs" data-testid="integration-tool" data-read-only={x.readOnly ? 'true' : 'false'} data-enabled={on ? 'true' : 'false'}>
                            <div className="min-w-0 flex-1">
                              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <span className={clsx('font-medium break-all', on ? 'text-ink' : 'text-muted')}>{x.title || x.name}</span>
                                {x.title && x.title !== x.name && <code className="break-all text-faint">{x.name}</code>}
                                {x.readOnly && <Badge tone="ok">{t('integrations.readOnly')}</Badge>}
                                {!on && !manage && <Badge>{t('integrations.toolOff')}</Badge>}
                              </p>
                              {x.description && <p className="mt-0.5 line-clamp-3 break-words text-muted">{x.description}</p>}
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
                  )}
                  <p className="mt-1.5 text-xs text-faint">
                    {short && <span className="block" data-testid="integration-tools-capped">{t(short, { n: i.tools.length, total: i.toolsTotal! })}</span>}
                    {i.tools.length > 0 && `${t(manage ? 'integrations.toolsSwitchHint' : 'integrations.toolsManagedHint')} `}
                    {t('integrations.toolsHint')}
                    {i.toolsUpdatedAt && ` ${t('integrations.toolsChecked', { date: formatDateTime(i.toolsUpdatedAt, locale) })}`}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  )
}

function SignInPanel({ flow, onRetry, onCancel }: { flow: SignInState; onRetry: () => void; onCancel: () => void }) {
  const t = useT()
  const failed = !WAITING.has(flow.state)
  return (
    <div className="mx-2 mt-1 mb-2 space-y-2 rounded-xl border border-line bg-subtle p-3 text-sm sm:ml-14" data-testid="integration-signin">
      {failed ? (
        <p role="alert" className="text-danger">
          {flow.state === 'expired' ? t('integrations.signIn.expired') : flow.reason || t('integrations.signIn.failed')}
        </p>
      ) : (
        <p role="status">{t('integrations.signIn.waiting')}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!failed && flow.url && (
          <a href={flow.url} target="_blank" rel="noopener noreferrer" className="text-sm text-accent-text underline">
            {t('integrations.signIn.open')}
          </a>
        )}
        {failed && (
          <Button size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {failed ? t('common.close') : t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}
