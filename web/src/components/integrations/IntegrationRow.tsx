// One external-service connection in a list (Settings > External services, Admin > External services): name, kind,
// state and why it failed, the stored key or signed-in account (never the key itself), last use, the MCP server's
// tools; and, for people who manage it, check again / sign in / edit / delete. Signing in (MCP OAuth) opens the
// service's page in a window reserved during the click and polls the flow until the server has the tokens.
import clsx from 'clsx'
import { ChevronDown, ChevronRight, Globe, LogIn, Pencil, RefreshCw, Trash2, Waypoints } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { Integration, IntegrationFlow } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { authorizationUrl, canSignIn, STATUS_TONE } from '../../lib/integrations'
import { mobileApp } from '../../lib/mobile'
import { useLocale, useT } from '../../i18n'
import { toast } from '../../store/ui'
import { Badge, Button, IconButton, confirmDialog } from '../ui'

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
          setS((x) => (x && x.flowId === flowId ? { ...x, state: f.state, reason: f.reason } : x))
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
  const refresh = async (i: Integration) => {
    setChecking(i.id)
    try {
      const r = await api.call(API.refreshIntegration, { params: { id: i.id }, body: {} })
      replace(r)
      toast(r.status === 'connected' ? { level: 'success', text: t('integrations.checked') } : { level: 'warn', text: t('integrations.checkFailed') })
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
  return { checking, refresh, remove, signIn, saved }
}

export type IntegrationActions = ReturnType<typeof useIntegrationActions>

export function IntegrationRow({ i, actions, onEdit, teamBadge, extra }: {
  i: Integration
  actions: IntegrationActions
  onEdit: () => void
  /** mark team connections (Settings lists them under one's own) */
  teamBadge?: boolean
  /** more lines under the details (Admin: who may use it) */
  extra?: ReactNode
}) {
  const t = useT()
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  const toolsId = useId()
  const flow = actions.signIn.state?.id === i.id ? actions.signIn.state : null
  const checking = actions.checking === i.id
  const phone = !!mobileApp()
  const KindIcon = i.kind === 'mcp' ? Waypoints : Globe
  const meta: string[] = []
  if (i.auth === 'bearer' || i.auth === 'header') meta.push(t(i.hasSecret ? 'integrations.keySaved' : 'integrations.keyMissing'))
  if (i.auth === 'oauth' && i.hasSecret) meta.push(i.account ? t('integrations.account', { account: i.account }) : t('integrations.signedIn'))
  meta.push(i.lastUsedAt ? t('integrations.lastUsed', { date: formatDateTime(i.lastUsedAt, locale) }) : t('integrations.neverUsed'))
  return (
    <li className="px-4 py-3" data-testid="integration-row" data-name={i.name} data-scope={i.scope} data-status={i.status}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <KindIcon size={16} className="mt-0.5 shrink-0 text-faint" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="font-medium break-words">{i.name}</span>
            <span className="text-xs text-muted">{t(i.kind === 'mcp' ? 'integrations.kind.mcp' : 'integrations.kind.http')}</span>
            <Badge tone={STATUS_TONE[i.status]}>{t(`integrations.status.${i.status}`)}</Badge>
            {teamBadge && i.scope === 'team' && <Badge tone="accent">{t('integrations.teamBadge')}</Badge>}
            {i.writePolicy === 'allow' && <Badge tone="warn">{t('integrations.write.allow')}</Badge>}
            {i.writePolicy === 'deny' && <Badge>{t('integrations.write.deny')}</Badge>}
          </p>
          <p className="mt-0.5 text-xs break-all text-faint">{i.url}</p>
          {i.lastError && i.status !== 'connected' && (
            <p className="mt-1 text-xs break-words text-danger" data-testid="integration-error">
              {i.lastError}
            </p>
          )}
          <p className="mt-1 text-xs text-muted" data-testid="integration-meta">
            {meta.join(' · ')}
          </p>
          {canSignIn(i) && phone && <p className="mt-1 text-xs text-muted">{t('integrations.signIn.phone')}</p>}
          {extra}
        </div>
        {i.canManage && (
          <div className="flex flex-wrap items-center gap-1 max-sm:w-full max-sm:pl-7">
            {canSignIn(i) && !phone && !flow && (
              <Button size="sm" variant={i.status === 'needs_auth' ? 'primary' : 'secondary'} onClick={() => void actions.signIn.start(i.id)} data-testid="integration-signin-start">
                <LogIn size={14} aria-hidden /> {t(i.hasSecret ? 'integrations.signInAgain' : 'integrations.signIn')}
              </Button>
            )}
            <Button size="sm" disabled={checking} onClick={() => void actions.refresh(i)} data-testid="integration-refresh">
              <RefreshCw size={14} className={clsx(checking && 'animate-spin')} aria-hidden /> {t('integrations.refresh')}
            </Button>
            <IconButton label={t('integrations.edit', { name: i.name })} onClick={onEdit} data-testid="integration-edit">
              <Pencil size={15} />
            </IconButton>
            <IconButton label={t('integrations.delete', { name: i.name })} className="hover:text-danger" onClick={() => void actions.remove(i)} data-testid="integration-delete">
              <Trash2 size={15} />
            </IconButton>
          </div>
        )}
      </div>
      {flow && <SignInPanel flow={flow} onRetry={() => void actions.signIn.start(i.id)} onCancel={actions.signIn.cancel} />}
      {i.kind === 'mcp' && (i.tools.length > 0 || i.status === 'connected') && (
        <div className="mt-2 pl-7">
          <button type="button" aria-expanded={open} aria-controls={toolsId} onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 rounded text-xs font-medium text-accent-text hover:underline" data-testid="integration-tools-toggle">
            {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
            {t('integrations.tools', { n: i.tools.length })}
          </button>
          {open && (
            <div id={toolsId} className="mt-2">
              {!i.tools.length ? (
                <p className="text-xs text-faint">{t('integrations.noTools')}</p>
              ) : (
                <ul className="divide-y divide-line rounded-lg border border-line" data-testid="integration-tools">
                  {i.tools.map((x) => (
                    <li key={x.name} className="px-3 py-2 text-xs" data-testid="integration-tool" data-read-only={x.readOnly ? 'true' : 'false'}>
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-medium break-all text-ink">{x.title || x.name}</span>
                        {x.title && x.title !== x.name && <code className="break-all text-faint">{x.name}</code>}
                        {x.readOnly && <Badge tone="ok">{t('integrations.readOnly')}</Badge>}
                      </p>
                      {x.description && <p className="mt-0.5 line-clamp-3 break-words text-muted">{x.description}</p>}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1.5 text-xs text-faint">
                {t('integrations.toolsHint')}
                {i.toolsUpdatedAt && ` ${t('integrations.toolsChecked', { date: formatDateTime(i.toolsUpdatedAt, locale) })}`}
              </p>
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
    <div className="mt-3 ml-7 space-y-2 rounded-xl border border-line bg-subtle p-3 text-sm" data-testid="integration-signin">
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
