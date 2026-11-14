// What every external-service connection's page needs (ConnectionPage.tsx; Settings › Connectors and Admin ›
// Connectors): signing in at the service (MCP OAuth: the service's page opens in a window reserved during the click, and
// the flow is polled until the server has the tokens), check again, delete, a tool on or off, the person's own Always
// allow ended, what follows a save (useIntegrationActions); who may use a team connection as one chip (AudienceChip);
// and the panel of a sign-in under way (SignInPanel). The connection's own line in a list was ConnectorsView.tsx
// ConnectorRow; its page with these actions is ConnectionPage.tsx (until 2026-11-13 an expandable row here).
import { useEffect, useRef, useState } from 'react'
import type { Group, Integration, IntegrationAccess, IntegrationFlow, User } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../../lib/api'
import { audienceOf, authorizationUrl, flowReasonKey } from '../../lib/integrations'
import { openSignInWindow, reserveSignInWindow as reserveWindow, signInPlace } from '../../lib/driveSignIn'
import { useLocale, useT } from '../../i18n'
import { useWaitLimit } from '../../lib/signInWait'
import { optimistic, optimisticPending, optimisticPendingKeys } from '../../lib/optimistic'
import { toast } from '../../store/ui'
import { Badge, Button, LinkButton, confirmDialog } from '../ui'

/** A blank window opened during the click (a window opened later, after the server answers, is blocked as a popup).
 * The phone app has no sign-in return yet: no window there. Nor in the desktop app, whose window handler refuses a blank
 * window: there the sign-in page opens in the system browser once its address is known (lib/driveSignIn.ts). */
export function reserveSignInWindow(): Window | null {
  return reserveWindow(signInPlace())
}

export interface SignInState {
  id: string
  flowId: string | null
  url: string | null
  state: IntegrationFlow['state'] | 'starting'
  /** why it failed, in words for the person (never the server's code) */
  reason: string | null
  /** the person came back to this page while it was still waiting (the window may have been closed): the panel says
   * it has not finished, with 다시 시도 and 취소, instead of "finish in the new window" (QA TC-205). Not from
   * window.closed: a sign-in page with a Cross-Origin-Opener-Policy makes an open window read as closed. */
  away?: boolean
}

const WAITING = new Set<SignInState['state']>(['starting', 'pending', 'exchanging'])

/** Signing in at one connection's service at a time: start (with a window reserved during the click), poll, cancel.
 * `onGone`: the connection is not there any more (404: its template changed or went while the page was open); the
 * row's failed state is not kept, the caller reads the list again. */
export function useSignIn(onCompleted: (id: string) => void, onGone?: () => void) {
  const t = useT()
  const locale = useLocale()
  const [s, setS] = useState<SignInState | null>(null)
  const popup = useRef<Window | null>(null)
  const generation = useRef(0)
  const done = useRef(onCompleted)
  done.current = onCompleted
  const goneRef = useRef(onGone)
  goneRef.current = onGone
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
    // back on this page with the sign-in not done: it may have been closed (the poll goes on: one finished late completes)
    const back = () => setS((x) => (x && x.flowId === flowId && WAITING.has(x.state) && !x.away ? { ...x, away: true } : x))
    window.addEventListener('focus', back)
    return () => {
      active = false
      clearTimeout(timer)
      window.removeEventListener('focus', back)
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
      openSignInWindow(signInPlace(), popup.current, url)
    } catch (e) {
      if (g !== generation.current) return
      popup.current?.close()
      popup.current = null
      if (isApiError(e, 'not_found') && goneRef.current) {
        setS(null)
        goneRef.current()
        return
      }
      setS({ id, flowId: null, url: null, state: 'failed', reason: errorText(e, locale, t('error.network')) })
    }
  }

  /** the flow on the server too, while it still waits: a window left open cannot finish it afterwards (QA TC-1417) */
  // One the service already answered (being exchanged) is not stopped by it: the flow is read again after, and one that
  // ended connected says so (the list reads it again) instead of the screen saying cancelled or timed out.
  const drop = (flowId: string | null | undefined, id: string | undefined) => {
    if (!flowId) return
    void (async () => {
      try { await api.call(API.cancelIntegrationFlow, { params: { id: flowId } }) } catch { /* it expires there by itself */ }
      try {
        const f = await api.call(API.integrationFlow, { params: { id: flowId } })
        if (f.state === 'completed' && id) { setS((x) => (x && x.flowId === flowId ? null : x)); done.current(id) }
      } catch { /* gone: nothing more to say */ }
    })()
  }
  const cancel = () => {
    generation.current++
    popup.current?.close()
    popup.current = null
    if (s && WAITING.has(s.state)) drop(s.flowId, s.id)
    setS(null)
  }
  // waiting too long (the window was closed, or left): the wait ends as timed out, with Try again and Close
  useWaitLimit(waiting, s?.flowId, () => {
    if (!s?.flowId) return
    generation.current++
    popup.current?.close()
    popup.current = null
    drop(s.flowId, s.id)
    setS((x) => (x && x.flowId === s.flowId ? { ...x, state: 'expired', reason: null } : x))
  })

  return { state: s, start, cancel }
}

/** Check again, delete, sign in, and what follows a save, for a list of connections (`add` / `replace`: one is new or
 * came back changed; `reload`: fetch the list again). */
export function useIntegrationActions({ add, replace, reload }: { add: (i: Integration) => void; replace: (i: Integration) => void; reload: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [checking, setChecking] = useState<string | null>(null)
  /** a connection that is not there any more (404: an admin changed or deleted the template it was made from while
   * this page was open): say so and read the lists again, instead of "not found" on a row that stays */
  const goneNow = () => {
    toast({ level: 'info', text: t('integrations.gone') })
    reload()
  }
  const gone = (e: unknown) => {
    if (!isApiError(e, 'not_found')) return false
    goneNow()
    return true
  }
  // one tool on or off for the AI, at once (lib/optimistic.ts), one queue per tool: a refusal puts back what the server
  // last had for that tool; an answer keeps another tool still on its way as on screen
  const toolKey = (id: string, name: string) => `integration:${id}:tool:${name}`
  // the connection as setTool last put it on screen while one of its tools is on its way, else as the page gives it
  const latest = useRef<Integration | null>(null)
  const setTool = async (i: Integration, name: string, enabled: boolean) => {
    const busy = optimisticPendingKeys((k) => k.startsWith(`integration:${i.id}:tool:`)).length > 0
    if (!busy || latest.current?.id !== i.id) latest.current = i
    const put = (x: Integration, on: (tool: Integration['tools'][number]) => boolean) => {
      const next = { ...x, tools: x.tools.map((tool) => ({ ...tool, enabled: on(tool) })) }
      latest.current = next
      replace(next)
    }
    const shown = (tool: Integration['tools'][number]) => tool.enabled !== false
    const r = await optimistic({
      key: toolKey(i.id, name), from: shown(i.tools.find((x) => x.name === name) ?? { enabled: true } as Integration['tools'][number]), to: enabled,
      show: (v) => put(latest.current?.id === i.id ? latest.current : i, (tool) => (tool.name === name ? v : shown(tool))),
      send: () => api.call(API.setIntegrationTool, { params: { id: i.id }, body: { name, enabled } }),
      confirmed: (x) => x.tools.find((tool) => tool.name === name)?.enabled !== false,
      settle: (x) => {
        const cur = latest.current?.id === i.id ? latest.current : i
        put(x, (tool) => (tool.name !== name && optimisticPending(toolKey(i.id, tool.name)) ? shown(cur.tools.find((y) => y.name === tool.name) ?? tool) : shown(tool)))
      },
      failText: false,
    })
    if (r.ok || !r.newest || gone(r.error)) return
    toast({ level: 'error', text: errorText(r.error, locale, t('error.network')) })
  }
  /** end the person's own Always allow, so the connection's changes ask again: their own connection's write rule back
   * to "ask"; on a team connection only their own choice (never the team's rule) */
  const askAgain = async (i: Integration) => {
    try {
      replace(i.scope === 'team'
        ? await api.call(API.stopAlwaysAllow, { params: { id: i.id } })
        : await api.call(API.updateIntegration, { params: { id: i.id }, body: { writePolicy: 'ask' } }))
      toast({ level: 'success', text: t('integrations.alwaysAllow.stopped', { name: i.name }) })
    } catch (e) {
      if (gone(e)) return
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
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
      if (gone(e)) return
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
      if (gone(e)) return
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }
  const signIn = useSignIn(() => {
    toast({ level: 'success', text: t('integrations.signIn.done') })
    reload()
  }, goneNow)
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
  return { checking, refresh, remove, signIn, saved, setTool, askAgain }
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

export function SignInPanel({ flow, onRetry, onCancel }: { flow: SignInState; onRetry: () => void; onCancel: () => void }) {
  const t = useT()
  const failed = !WAITING.has(flow.state)
  return (
    <div className="space-y-2 rounded-xl border border-line px-3 py-2 text-sm" data-testid="integration-signin">
      {failed ? (
        <p role="alert" className="text-danger">
          {flow.state === 'expired' ? t('integrations.signIn.expired') : flow.reason || t('integrations.signIn.failed')}
        </p>
      ) : (
        <p role="status">{t(flow.away ? 'integrations.signIn.notFinished' : 'integrations.signIn.waiting')}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!failed && flow.url && (
          <LinkButton variant="primary" size="sm" href={flow.url}>
            {t('integrations.signIn.open')}
          </LinkButton>
        )}
        {/* always: a window closed before it finished needs a way back (QA TC-1417) */}
        <Button size="sm" onClick={onRetry} data-testid="integration-signin-retry">
          {t('common.retry')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} data-testid="integration-signin-cancel">
          {failed ? t('common.close') : t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}
