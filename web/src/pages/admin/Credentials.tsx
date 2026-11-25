// The accounts the team's AI answers with (docs/DECISIONS.md "AI 연결" 3.13) — Claude subscription tokens, API keys,
// ChatGPT sign-ins — shown inside each provider's row in Admin › AI providers (pages/admin/Engines.tsx; it was a page of
// its own, Admin > AI connections, and /admin/credentials leads there): their state, who uses them, this month's use and
// the order they are tried in. The owner and admins alike add, replace, order, assign, limit,
// switch off, remove and re-check them (adding and replacing need no password: every kind has a fixed provider address). Tokens and keys are sealed in the browser
// before they are sent (lib/seal.ts) and never shown again. Settings › AI providers (MyCredentials) is a member's own
// accounts by provider, when the team allows it. A Claude subscription and a ChatGPT plan connect with a sign-in in
// the browser (one button; docs/DECISIONS.md "Claude 구독 연결: 브라우저에서"); the old terminal paste for Claude stays
// folded under a small disclosure.
import { ExternalLink, GripVertical, Loader2, MoreHorizontal, Plug, Plus, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { DuplicateCredentialParams, LoginBusyParams, type Credential, type EngineId, type CredentialAssignment, type CredentialKind, type CredentialLogin, type CredentialLoginKind, type CredentialsResponse, type Group, type User } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../../lib/api'
import { canSeal, sealSecret } from '../../lib/seal'
import { dropIndex, moveItem, priorityPatches } from '../../lib/reorder'
import { formatDateTime, formatNumber, formatUsd } from '../../lib/format'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { isAdmin, isOwner, useMe, useMeStrict } from '../../store/session'
import { isGuestMe } from '../../lib/guests'
import { credentialLogin } from '../../store/live'
import { toast } from '../../store/ui'
import { Badge, Button, CopyButton, Field, IconButton, Modal, SignInLinks, confirmDialog, inputCls, useAnnounce, useMediaQuery } from '../../components/ui'
import { Card, Loadable, useAction, useActionOk, useLoad } from './common'
import { CREDENTIAL_PROBLEMS } from './overview'
import { LogoTile } from '../../components/integrations/ConnectorsView'
import { useAdminGroups, useAdminRead, useAdminUsers } from '../../store/adminPeople'

const FAMILY: Record<'claude' | 'codex', CredentialKind[]> = { claude: ['anthropic-oauth', 'anthropic-api-key'], codex: ['chatgpt', 'openai-api-key'] }
const SUBSCRIPTION = new Set<CredentialKind>(['anthropic-oauth', 'chatgpt'])
const familyOf = (kind: CredentialKind): Family => (FAMILY.claude.includes(kind) ? 'claude' : 'codex')
/** the team's accounts of one provider, in the order the list shows them (the server's: priority, then date added) */
const teamOfFamily = (fam: Family) => (x: Credential) => x.scope === 'team' && FAMILY[fam].includes(x.kind)
/** Company API keys lead the team form; personal subscriptions lead a member's form (D1). */
const KIND_ORDER: CredentialKind[] = ['anthropic-api-key', 'anthropic-oauth', 'openai-api-key', 'chatgpt']
const PERSONAL_KIND_ORDER: CredentialKind[] = ['anthropic-oauth', 'anthropic-api-key', 'chatgpt', 'openai-api-key']
const TONE: Record<Credential['state'], 'ok' | 'warn' | 'danger' | 'neutral'> = {
  ok: 'ok', unverified: 'neutral', expiring: 'warn', expired: 'danger', invalid: 'danger', needs_reconnect: 'danger', no_credit: 'danger', limited: 'warn', over_limit: 'warn', disabled: 'neutral', kind_off: 'neutral', sharing_off: 'warn',
}
const CLAUDE_TOKEN_RE = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,1000}$/
/** the code the Claude page shows after approval (server/src/credentials/login.ts CLAUDE_LOGIN_CODE_RE) */
const CLAUDE_CODE_RE = /^[A-Za-z0-9._~-]{1,512}#[A-Za-z0-9._~-]{1,512}$/
const FINISHED: CredentialLogin['state'][] = ['done', 'failed', 'expired', 'cancelled']
const ANTHROPIC_KEY_RE = /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,300}$/
const OPENAI_KEY_RE = /^sk-[A-Za-z0-9_-]{20,300}$/
/** a key of the server's Anthropic-compatible gateway (server/src/credentials/validate.ts GATEWAY_KEY_RE), never an Anthropic one */
const GATEWAY_KEY_RE = /^[A-Za-z0-9._-]{20,300}$/
/** the server's Anthropic-compatible gateway (server.json engine.anthropicGateway), when it has one */
type Gateway = { label: string } | null | undefined
/** the name the simple form gives a connection (components/onboarding/ConnectAi.tsx): the kind's, renamed on Admin */
const simpleLabel = (kind: CredentialKind, gateway?: Gateway) =>
  kind === 'anthropic-oauth' ? 'Claude' : kind === 'chatgpt' ? 'ChatGPT' : kind === 'openai-api-key' ? 'OpenAI API' : gateway ? gateway.label : 'Claude API'
const formatOk = (kind: CredentialKind, s: string, gateway?: Gateway) => kind === 'anthropic-oauth' ? CLAUDE_TOKEN_RE.test(s)
  : kind === 'anthropic-api-key' ? (gateway ? GATEWAY_KEY_RE.test(s) && !/^sk-ant-/i.test(s) : ANTHROPIC_KEY_RE.test(s))
  : kind === 'openai-api-key' ? OPENAI_KEY_RE.test(s) && !s.startsWith('sk-ant-') : true

/** The engines whose accounts are listed here: an engine's provider row in Admin › AI providers shows its family. */
export const ENGINE_FAMILY: Partial<Record<EngineId, 'claude' | 'codex'>> = { 'claude-code': 'claude', codex: 'codex' }
export type Family = 'claude' | 'codex'

/** The team's AI accounts for Admin › AI providers (pages/admin/Engines.tsx): the list, what an owner and an admin may
 * do with each, and the dialogs. Each provider row shows its own family (ProviderAccounts); the settings for members'
 * own accounts are in the Team provider settings tab (Engines.tsx MemberAccounts). */
export const loadTeamCredentials = () => api.call(API.listCredentials)

export function useTeamCredentials() {
  const t = useT()
  const me = useMeStrict()
  // the owner and admins change the team's AI connections alike (docs/DECISIONS.md "Admins connect the team's AI too")
  const owner = isAdmin(me)
  const act = useAction()
  const actOk = useActionOk()
  const state = useAdminRead('credentials', loadTeamCredentials)
  const groups = useAdminGroups(owner)
  const users = useAdminUsers(owner)
  /** the family whose Add account dialog is open */
  const [adding, setAdding] = useState<Family | null>(null)
  const [editing, setEditing] = useState<Credential | null>(null)
  const [replacing, setReplacing] = useState<Credential | null>(null)
  const [checking, setChecking] = useState<string | null>(null)

  const update = (c: Credential) => state.data && state.setData({ ...state.data, items: state.data.items.map((x) => (x.id === c.id ? c : x)) })
  /** "Check again": the row's badge turns while it runs (the menu it starts from closes), then one toast says what the
   * provider answered: connected, still refused (why, and the way to fix it) or no clear answer (try again later) */
  const check = async (c: Credential) => {
    setChecking(c.id)
    const r = await act(() => api.call(API.checkCredential, { params: { id: c.id } }))
    setChecking(null)
    if (!r) return
    const { check: found, ...row } = r
    update(row)
    // the reason in the person's language (QA TC-9061): the known one, else the row's own line; the provider's own
    // words (found.reason) stay in the opened row's details, never in the toast
    const plain = found?.why ? t(`credentials.why.${found.why}` as MessageKey) : null
    const reason = plain ?? (found?.outcome === 'refused' ? row.detail : null)
    if (!found || found.outcome === 'ok') toast({ level: 'success', text: t('credentials.checkResult.ok') })
    else if (found.outcome === 'refused') {
      // the owner and admins fix a team account here; a member's own is theirs to fix
      const fix = row.scope === 'team' && owner
      toast({ level: 'error', text: reason ? t('credentials.checkResult.refused', { reason }) : t('credentials.checkResult.refusedPlain'),
        ...(fix ? { action: { label: t(SUBSCRIPTION.has(row.kind) ? 'credentials.checkResult.reconnect' : 'credentials.checkResult.replace'), run: () => setReplacing(row), primary: true } } : {}) })
    } else toast({ level: 'warn', text: t('credentials.checkResult.unclear'), ...(reason ? { detail: reason } : {}) })
  }
  const patch = async (c: Credential, body: { disabled?: boolean; priority?: number }) => {
    const r = await act(() => api.call(API.updateCredential, { params: { id: c.id }, body }))
    if (r) void state.reload()
    return r
  }
  const remove = async (c: Credential) => {
    const body = c.kind === 'chatgpt' ? t('credentials.deleteChatgptNote') : undefined
    if (!(await confirmDialog({ title: t('credentials.deleteConfirm', { label: c.label }), body, confirm: t('common.delete'), danger: true }))) return
    if (await actOk(() => api.call(API.deleteCredential, { params: { id: c.id } }))) void state.reload()
  }
  /** while a new order is being saved (the handles wait) */
  const [ordering, setOrdering] = useState(false)
  /** put a team connection at position `to` of its provider's list: the list shows the new order at once, then saves it
   * as priorities 10, 20, 30 … (lib/reorder.ts), one PATCH per row whose number changes, and reads the list again.
   * Dragging a row and Move up / Move down both come here. */
  const reorder = async (d: CredentialsResponse, c: Credential, to: number) => {
    const inList = teamOfFamily(familyOf(c.kind))
    const list = d.items.filter(inList)
    const from = list.findIndex((x) => x.id === c.id)
    if (from < 0 || to < 0 || to >= list.length || to === from) return
    const patches = priorityPatches(moveItem(list, from, to))
    const pr = new Map(patches.map((x) => [x.id, x.priority]))
    const next = moveItem(list, from, to).map((x) => (pr.has(x.id) ? { ...x, priority: pr.get(x.id)! } : x))
    let k = 0
    state.setData({ ...d, items: d.items.map((x) => (inList(x) ? next[k++]! : x)) })
    setOrdering(true)
    try {
      for (const x of patches) if (!(await act(() => api.call(API.updateCredential, { params: { id: x.id }, body: { priority: x.priority } })))) break
    } finally {
      setOrdering(false)
      void state.reload()
    }
  }
  /** move a team connection one place up / down within its provider (the ⋯ menu) */
  const move = async (d: CredentialsResponse, c: Credential, dir: -1 | 1) => {
    const i = d.items.filter(teamOfFamily(familyOf(c.kind))).findIndex((x) => x.id === c.id)
    if (i >= 0) await reorder(d, c, i + dir)
  }
  const target = (c: Credential) => c.scope === 'personal' ? t('credentials.target.personal', { name: c.owner?.name ?? '' })
    : !c.assignments.length ? t('credentials.target.team') : c.assignments.map((a) => a.name).join(', ')
  const d = state.data
  const dialogs = d && (
    <>
      {adding && (
        <AddCredential allowedKinds={d.allowedKinds} family={adding} gateway={d.anthropicGateway} sharedSubscriptions={d.sharedSubscriptions} groups={groups.data ?? []} users={users.data ?? []} onClose={() => setAdding(null)} onDone={() => { setAdding(null); void state.reload() }} />
      )}
      {replacing && (
        <AddCredential allowedKinds={d.allowedKinds} gateway={d.anthropicGateway} sharedSubscriptions={d.sharedSubscriptions} groups={[]} users={[]} replace={replacing} onClose={() => setReplacing(null)} onDone={() => { setReplacing(null); void state.reload() }} />
      )}
      {editing && <EditCredential c={editing} groups={groups.data ?? []} users={users.data ?? []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void state.reload() }} />}
    </>
  )
  return { me, owner, users, state, act, check, patch, remove, move, reorder, ordering, target, checking, setAdding, setEditing, setReplacing, dialogs }
}
export type TeamCredentials = ReturnType<typeof useTeamCredentials>

/** Whether an account of this provider needs a look (a phone keeps the accounts shown under a closed row then). */
export function accountsNeedLook(tc: TeamCredentials, fam: Family): boolean {
  return !!tc.state.data?.items.some((x) => x.scope === 'team' && FAMILY[fam].includes(x.kind) && !x.disabled && CREDENTIAL_PROBLEMS.includes(x.state))
}

/** No team account of this provider yet, and Add account is right below on this page (Admin › AI providers): the
 * owner's line says so in the web's words (QA TC-2838); the server's line says "below" too (#944). */
export function addAccountBelow(tc: TeamCredentials, fam: Family): boolean {
  const d = tc.state.data
  return !!d && tc.owner && !d.items.some((x) => x.scope === 'team' && FAMILY[fam].includes(x.kind)) && d.allowedKinds.some((k) => FAMILY[fam].includes(k))
}

/** One provider's accounts inside its row in Admin › AI providers, in the order they are used, with Add account
 * (the owner; it opens the same dialog as before, for this provider's kinds only). Admins see and re-check them.
 * The owner and admins change the order by dragging a row's handle (mouse or touch), with the keyboard on the handle
 * (Space picks the row up, the arrow keys move it, Space drops it, Escape puts it back), or with Move up / Move down in
 * the ⋯ menu; every way saves through tc.reorder. Under a list of two or more, one plain line says how the order is used. */
export function ProviderAccounts({ tc, fam }: { tc: TeamCredentials; fam: Family }) {
  const t = useT()
  const announce = useAnnounce()
  const help = useId()
  const ul = useRef<HTMLUListElement>(null)
  /** the row being moved */
  const [drag, setDragState] = useState<Drag | null>(null)
  // the same, read by a blur that comes while the list is redrawn (the moved row's handle loses focus then)
  const dragNow = useRef<Drag | null>(null)
  const setDrag = (v: Drag | null) => { dragNow.current = v; setDragState(v) }
  /** the handle to focus again once the list shows the new order (a keyboard drop) */
  const refocus = useRef<string | null>(null)
  useEffect(() => {
    if (!refocus.current) return
    const el = ul.current?.querySelector<HTMLElement>(`[data-id="${refocus.current}"] [data-testid="credential-drag"]`)
    if (el && document.activeElement !== el) el.focus()
    refocus.current = null
  })
  const d = tc.state.data
  if (!d) return null
  const list = d.items.filter(teamOfFamily(fam))
  const kinds = d.allowedKinds.filter((k) => FAMILY[fam].includes(k))
  const sortable = tc.owner && list.length > 1
  const tiers = list.some((x) => x.assignments.length > 0)
  const total = list.length
  const measure = () => {
    const rows = [...(ul.current?.children ?? [])].map((el) => el.getBoundingClientRect())
    return { heights: rows.map((r) => r.height), mids: rows.map((r) => r.top + r.height / 2) }
  }
  const pick = (c: Credential, from: number, startY: number | null) => {
    setDrag({ id: c.id, from, to: from, dy: startY === null ? null : 0, startY: startY ?? 0, ...measure() })
    if (startY === null) announce(t('credentials.dragPicked', { label: c.label, n: from + 1, total }))
  }
  const drop = (c: Credential) => {
    const drag = dragNow.current
    if (!drag) return
    setDrag(null)
    if (drag.to === drag.from) { announce(t('credentials.dragCancelled', { label: c.label, n: drag.from + 1 })); return }
    announce(t('credentials.dragDropped', { label: c.label, n: drag.to + 1, total }))
    if (drag.dy === null) refocus.current = c.id
    void tc.reorder(d, c, drag.to)
  }
  const cancel = (c: Credential) => {
    const drag = dragNow.current
    if (!drag) return
    setDrag(null)
    announce(t('credentials.dragCancelled', { label: c.label, n: drag.from + 1 }))
  }
  /** how far row i is shifted while another row is moved over it, or the moved row itself */
  const shift = (i: number): number => {
    if (!drag) return 0
    const { from, to, heights } = drag
    if (i === from) {
      if (drag.dy !== null) return drag.dy
      const sum = (a: number, b: number) => heights.slice(a, b).reduce((x, y) => x + y, 0)
      return to > from ? sum(from + 1, to + 1) : -sum(to, from)
    }
    if (from < to && i > from && i <= to) return -heights[from]!
    if (to < from && i >= to && i < from) return heights[from]!
    return 0
  }
  const handle = (c: Credential, i: number): RowHandle | undefined => sortable ? {
    label: t('credentials.dragHandle', { label: c.label }),
    describedBy: help,
    picked: drag?.id === c.id,
    disabled: tc.ordering,
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0 || tc.ordering) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      pick(c, i, e.clientY)
    },
    onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (drag?.id !== c.id || drag.dy === null) return
      const dy = e.clientY - drag.startY
      setDrag({ ...drag, dy, to: dropIndex(drag.mids, drag.from, drag.mids[drag.from]! + dy) })
    },
    onPointerUp: () => { if (drag?.id === c.id && drag.dy !== null) drop(c) },
    onPointerCancel: () => { if (drag?.id === c.id && drag.dy !== null) setDrag(null) },
    onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      const held = drag?.id === c.id && drag.dy === null
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        if (held) drop(c)
        else if (!tc.ordering) pick(c, i, null)
      } else if (held && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        const to = Math.max(0, Math.min(total - 1, drag.to + (e.key === 'ArrowUp' ? -1 : 1)))
        if (to !== drag.to) { setDrag({ ...drag, to }); announce(t('credentials.dragMoving', { label: c.label, n: to + 1, total })) }
      } else if (held && e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation()
        cancel(c)
      }
    },
    // focus leaving a picked-up row puts it back (not the blur of a drop, when the list moves the row)
    onBlur: () => { if (dragNow.current?.id === c.id && dragNow.current.dy === null) cancel(c) },
  } : undefined
  return (
    <div className="mt-3 space-y-2 pl-12 max-md:pl-0" data-testid={`provider-accounts-${fam}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted">{t('providers.accounts')}</p>
        {tc.owner && kinds.length > 0 && (
          <Button size="sm" onClick={() => tc.setAdding(fam)} data-testid={`provider-add-${fam}`}><Plus size={14} aria-hidden /> {t('providers.addAccount')}</Button>
        )}
      </div>
      {!list.length ? <p className="text-xs text-faint" data-testid={`provider-none-${fam}`}>{t('providers.noAccounts')}</p> : (
        <ul ref={ul} className="divide-y divide-line rounded-xl border border-line" data-testid={`credentials-${fam}`} data-dragging={drag ? '' : undefined}>
          {list.map((c, i) => (
            <CredentialRow key={c.id} c={c} target={tc.target(c)} owner={tc.owner} checking={tc.checking === c.id} gateway={d.anthropicGateway} pricesAsOf={d.pricesAsOf}
              onCheck={() => tc.check(c)} onEdit={() => tc.setEditing(c)} onReplace={() => tc.setReplacing(c)} onRemove={() => tc.remove(c)}
              onToggle={() => tc.patch(c, { disabled: !c.disabled })}
              onUp={i > 0 ? () => tc.move(d, c, -1) : undefined} onDown={i < list.length - 1 ? () => tc.move(d, c, 1) : undefined}
              handle={handle(c, i)} shift={drag ? shift(i) : 0} moving={drag?.id === c.id} />
          ))}
        </ul>
      )}
      {sortable && <p id={help} className="sr-only">{t('credentials.dragHelp')}</p>}
      {list.length > 1 && (
        <p className="max-w-prose text-xs leading-relaxed text-faint" data-testid="credentials-order">
          {t('credentials.order')}{tiers && ` ${t('credentials.orderTiers')}`}
        </p>
      )}
    </div>
  )
}

/** The accounts members connected for themselves (a list the owner and admins see, never the keys). */
export function PersonalCredentialList({ tc }: { tc: TeamCredentials }) {
  const d = tc.state.data
  if (!d || !d.items.some((x) => x.scope === 'personal')) return null
  return (
    <ul className="divide-y divide-line rounded-xl border border-line" data-testid="credentials-personal">
      {d.items.filter((x) => x.scope === 'personal').map((c) => (
        // the owner may switch off or remove any; an admin only a member's (not the owner's or another admin's)
        <CredentialRow key={c.id} c={c} target={tc.target(c)} owner={isOwner(tc.me) || tc.users.data?.find((u) => u.id === c.owner?.id)?.role === 'member'} checking={tc.checking === c.id} personal
          onCheck={() => tc.check(c)} onEdit={() => {}} onReplace={() => {}} onRemove={() => tc.remove(c)} onToggle={() => tc.patch(c, { disabled: !c.disabled })} />
      ))}
    </ul>
  )
}

/** Whose mark a provider or an account shows: Claude (Anthropic), OpenAI (ChatGPT, Codex) or a plain plug (the API
 * engine, a gateway's key). The marks are the files Connected apps already uses (web/public/icons/connectors), on a white
 * tile so they read in dark mode too. */
export type ProviderMark = 'claude' | 'openai' | 'api'
export const markOfKind = (kind: CredentialKind, gateway?: Gateway): ProviderMark =>
  kind === 'chatgpt' || kind === 'openai-api-key' ? 'openai' : kind === 'anthropic-api-key' && gateway ? 'api' : 'claude'
export function ProviderLogo({ mark, small }: { mark: ProviderMark; small?: boolean }) {
  const size = small ? 'size-7 !p-1' : 'size-9 !p-1.5'
  if (mark === 'api') return (
    <span className={`flex shrink-0 items-center justify-center rounded-lg border border-line bg-subtle text-muted ${size}`} data-testid="provider-logo" data-mark="api">
      <Plug size={small ? 14 : 16} aria-hidden />
    </span>
  )
  return <span className="contents" data-testid="provider-logo" data-mark={mark}><LogoTile src={`/icons/connectors/${mark === 'claude' ? 'claude.svg' : 'codex.svg'}`} className={size} /></span>
}

/** A row being moved (ProviderAccounts): where it was (`from`), where it would land (`to`), how far the pointer moved
 * it (`dy`; a keyboard move has none) from where it was picked up (`startY`), and each row's height and middle as laid
 * out then. */
type Drag = { id: string; from: number; to: number; dy: number | null; startY: number; heights: number[]; mids: number[] }

/** A row's drag handle: its name, the keyboard help it points to, and the pointer and key handlers (ProviderAccounts). */
type RowHandle = {
  label: string; describedBy: string; picked: boolean; disabled: boolean
  onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void; onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerUp: () => void; onPointerCancel: () => void; onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => void; onBlur: () => void
}

/** The short line under an account with a problem: what to do, as one link for the owner and admins ("Replace the key"),
 * or nothing when the state badge already says it (a limit, Reconnect's own button). */
function fixOf(c: Credential): 'reconnect' | 'replace' | null {
  if (c.disabled || !['expired', 'invalid', 'expiring'].includes(c.state)) return null
  return SUBSCRIPTION.has(c.kind) ? 'reconnect' : 'replace'
}

/** One account: its mark, its name, its plan in short and one state; one short line when something needs doing. The
 * name opens the rest under it (who uses it, this month's use, when it was last used, the server's longer explanation).
 * Check again, move up / down and the rest are in the ⋯ menu. */
export function CredentialRow({ c, target, owner, checking, personal, ownDelete, gateway, pricesAsOf, onCheck, onEdit, onReplace, onRemove, onToggle, onUp, onDown, handle, shift = 0, moving = false }: {
  c: Credential; target: string; owner: boolean; checking: boolean; personal?: boolean
  /** a member's own row (Settings): a delete button instead of the owner's menu */
  ownDelete?: boolean
  /** the server's Anthropic-compatible gateway: its key shows a plain mark, not Claude's */
  gateway?: Gateway
  /** the date of the list prices an API key's cost is estimated with (its details say so) */
  pricesAsOf?: string
  onCheck: () => void; onEdit: () => void; onReplace: () => void; onRemove: () => void; onToggle: () => void; onUp?: () => void; onDown?: () => void
  /** the drag handle, where the order can be changed (ProviderAccounts) */
  handle?: RowHandle
  /** how far the row is moved on the screen while it or another row is dragged; `moving`: this is the row being moved */
  shift?: number; moving?: boolean
}) {
  const t = useT()
  const locale = useLocale()
  const [menu, setMenu] = useState(false)
  const [open, setOpen] = useState(false)
  const details = useId()
  const apiKey = c.kind === 'anthropic-api-key' || c.kind === 'openai-api-key'
  const plan = [c.kind === 'anthropic-api-key' && gateway ? t('credentials.kind.gateway', { label: gateway.label }) : t(`credentials.kindShort.${c.kind}` as MessageKey), c.planType && c.planType.charAt(0).toUpperCase() + c.planType.slice(1)].filter(Boolean).join(' · ')
  const fix = fixOf(c)
  const reconnectButton = !personal && c.state === 'needs_reconnect' && c.kind === 'chatgpt' && owner
  const item = 'block w-full px-3 py-1.5 text-left hover:bg-hover disabled:opacity-50'
  return (
    <li className={`relative px-3 py-2.5 ${moving ? 'z-1 rounded-xl bg-surface shadow-lg ring-1 ring-accent' : ''} ${shift && !moving ? 'transition-transform duration-150' : ''}`}
      style={shift ? { transform: `translateY(${shift}px)` } : undefined} data-testid="credential-row" data-id={c.id} data-kind={c.kind} data-moving={moving ? '' : undefined}>
      <div className={`flex items-center ${handle ? 'gap-2 max-md:gap-1.5' : 'gap-3'}`}>
        {handle && (
          // aria-disabled, not disabled, while a new order is saved: a disabled button would drop the keyboard's focus.
          // no-tooltip: a drag handle; a tooltip would sit over the rows being dragged. The grip says it, its name and help say it to screen readers
          <IconButton label={handle.label} tip={false} compact aria-describedby={handle.describedBy} aria-pressed={handle.picked} aria-disabled={handle.disabled || undefined}
            className={`-ml-1.5 shrink-0 touch-none select-none ${handle.picked ? 'cursor-grabbing text-ink' : 'cursor-grab'}`}
            onPointerDown={handle.onPointerDown} onPointerMove={handle.onPointerMove} onPointerUp={handle.onPointerUp} onPointerCancel={handle.onPointerCancel}
            onKeyDown={handle.onKeyDown} onBlur={handle.onBlur} data-testid="credential-drag">
            <GripVertical size={15} aria-hidden />
          </IconButton>
        )}
        {/* a phone with the handle: the provider's mark goes (the row is under that provider already), the name keeps its room */}
        <span className={handle ? 'contents max-md:hidden' : 'contents'}><ProviderLogo mark={markOfKind(c.kind, gateway)} small /></span>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-baseline gap-x-2 text-sm">
            <button type="button" aria-expanded={open} aria-controls={open ? details : undefined} onClick={() => setOpen(!open)}
              className="touch-hit -ml-1 min-w-0 truncate rounded-md px-1 text-left hover:bg-hover" data-testid="credential-open">
              <span className="font-medium text-ink">{c.label}</span>
            </button>
            {c.hint && <span className="shrink-0 text-xs text-faint">…{c.hint}</span>}
          </p>
          <p className="text-sm text-muted">{plan}</p>
          {fix && (
            <p className="text-xs text-warn" data-testid="credential-fix">
              {owner && !personal
                ? <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={onReplace}>{t(fix === 'reconnect' ? 'credentials.fix.reconnect' : 'credentials.fix.replace')}</button>
                : t(fix === 'reconnect' ? 'credentials.fix.reconnect' : 'credentials.fix.replace')}
              {c.state === 'expiring' && c.expiresAt && ` · ${t('credentials.until', { date: formatDateTime(c.expiresAt, locale) })}`}
            </p>
          )}
        </div>
        {/* while "Check again" runs, here (its menu has closed): a turning mark and "Checking…" */}
        <span role="status" className="contents" data-testid="credential-state" data-checking={checking ? '' : undefined}>
          {checking
            ? <Badge tone="neutral"><span className="inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" aria-hidden />{t('credentials.checking')}</span></Badge>
            : <Badge tone={TONE[c.state]}>{t(`credentials.state.${c.state}` as MessageKey)}</Badge>}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {reconnectButton && <Button size="sm" onClick={onReplace}>{t('credentials.reconnect')}</Button>}
          {!personal && !owner && <Button size="sm" variant="ghost" onClick={onCheck} disabled={checking}>{checking ? t('credentials.checking') : t('credentials.check')}</Button>}
          {ownDelete && <IconButton label={t('common.deleteNamed', { name: c.label })} onClick={onRemove} data-testid="my-credential-delete"><Trash2 size={14} /></IconButton>}
          {owner && (
            <div className="relative">
              <IconButton label={t('credentials.menu')} onClick={() => setMenu((v) => !v)} aria-expanded={menu} data-testid="credential-menu"><MoreHorizontal size={15} /></IconButton>
              {menu && (
                <div role="menu" className="absolute right-0 z-30 mt-1 w-56 rounded-lg border border-line bg-surface py-1 text-sm shadow-lg" onClick={() => setMenu(false)}>
                  {!personal && <button role="menuitem" type="button" className={item} onClick={onCheck} disabled={checking} data-testid="credential-check">{checking ? t('credentials.checking') : t('credentials.check')}</button>}
                  {onUp && <button role="menuitem" type="button" className={item} onClick={onUp}>{t('credentials.moveUp')}</button>}
                  {onDown && <button role="menuitem" type="button" className={item} onClick={onDown}>{t('credentials.moveDown')}</button>}
                  {!personal && <button role="menuitem" type="button" className={item} onClick={onEdit}>{t('credentials.rename')} · {t('credentials.changeTarget')} · {t('credentials.spendLimit')}</button>}
                  {!personal && <button role="menuitem" type="button" className={item} onClick={onReplace}>{SUBSCRIPTION.has(c.kind) ? t('credentials.reconnect') : t('credentials.replace')}</button>}
                  <button role="menuitem" type="button" className={item} onClick={onToggle}>{c.disabled ? t('credentials.enable') : t('credentials.disable')}</button>
                  <button role="menuitem" type="button" className="block w-full px-3 py-1.5 text-left text-danger hover:bg-danger-soft" onClick={onRemove}>{t('common.delete')}</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {open && (
        <div id={details} className={`mt-1.5 space-y-0.5 text-xs text-faint max-md:pl-0 ${handle ? 'pl-16' : 'pl-10'}`} data-testid="credential-details">
          {c.detail && <p className="text-muted" data-testid="credential-detail">{c.detail}</p>}
          {c.providerError && (
            <p className="break-words" data-testid="credential-provider-answer">
              {t('credentials.providerAnswer', { date: formatDateTime(c.providerError.at, locale), answer: [c.providerError.status, c.providerError.type, c.providerError.message].filter((x) => x !== null && x !== '').join(' · ') })}
            </p>
          )}
          <p>
            {target} · {t('credentials.month', { tokens: formatNumber(c.month.tokens, locale) })}
            {apiKey && c.month.usd > 0 && ` · ${t('credentials.monthUsd', { usd: formatUsd(c.month.usd, locale) })}`}
            {apiKey && c.spendLimit.usd !== null && ` / ${formatUsd(c.spendLimit.usd, locale)}`}
          </p>
          {c.lastUsedAt && <p>{t('credentials.lastUsed', { date: formatDateTime(c.lastUsedAt, locale) })}</p>}
          {c.expiresAt && c.state === 'ok' && <p>{t('credentials.until', { date: formatDateTime(c.expiresAt, locale) })}</p>}
          {apiKey && pricesAsOf && <p data-testid="credential-cost-note">{t('credentials.costNote', { date: pricesAsOf })}</p>}
        </div>
      )}
    </li>
  )
}

/** Groups / people a connection is assigned to (empty = the whole team). `pick` is the dialog's: "chosen groups and
 * people" with none ticked would be saved as the whole team (the API has no other way to say it), so the dialog does
 * not save until one is ticked, and the line under the list says so. */
function TargetPicker({ value, onChange, pick, setPick, groups, users }: { value: CredentialAssignment[]; onChange: (v: CredentialAssignment[]) => void; pick: boolean; setPick: (v: boolean) => void; groups: Group[]; users: User[] }) {
  const t = useT()
  const has = (a: CredentialAssignment) => value.some((x) => x.subjectType === a.subjectType && x.subjectId === a.subjectId)
  const toggle = (a: CredentialAssignment) => onChange(has(a) ? value.filter((x) => !(x.subjectType === a.subjectType && x.subjectId === a.subjectId)) : [...value, a])
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium text-muted">{t('credentials.target')}</legend>
      <label className="flex items-center gap-2 text-sm"><input type="radio" checked={!pick} onChange={() => { setPick(false); onChange([]) }} /> {t('credentials.target.team')}</label>
      <label className="flex items-center gap-2 text-sm"><input type="radio" checked={pick} onChange={() => setPick(true)} /> {t('credentials.target.pick')}</label>
      {pick && (
        <div className="grid gap-2 pl-6 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-xs text-faint">{t('credentials.target.groups')}</p>
            {groups.map((g) => <label key={g.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={has({ subjectType: 'group', subjectId: g.id })} onChange={() => toggle({ subjectType: 'group', subjectId: g.id })} /> {g.name}</label>)}
          </div>
          <div>
            <p className="mb-1 text-xs text-faint">{t('credentials.target.people')}</p>
            {users.filter((u) => u.status === 'active').map((u) => <label key={u.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={has({ subjectType: 'user', subjectId: u.id })} onChange={() => toggle({ subjectType: 'user', subjectId: u.id })} /> {u.name}</label>)}
          </div>
        </div>
      )}
      {pick && !value.length && <p className="pl-6 text-xs text-warn" role="status" data-testid="target-pick-none">{t('credentials.target.pickNone')}</p>}
    </fieldset>
  )
}

/**
 * Add a connection (owner: the team's; personal: one's own), or put a new token / key on one (replace), or sign the
 * ChatGPT plan or the Claude subscription in again (replace of a subscription connection). Subscriptions connect with
 * a sign-in in the browser; a Claude token made in a terminal can still be pasted (the folded "in a terminal" part).
 * `simple` is the form "AI 연결" opens outside Admin (components/onboarding/ConnectAi.tsx): for the whole team (no
 * target), named after the kind (no name field), the provider's terms in one line. No password field anywhere
 * here: every kind goes to its provider's fixed address (docs/DECISIONS.md "No password for the team's official AI accounts").
 */
export function AddCredential({ allowedKinds, family, gateway, groups, users, replace, personal, sharedSubscriptions = false, initialKind, onlyKinds, simple, onClose, onDone }: {
  allowedKinds: CredentialKind[]; /** this provider's kinds only (Add account in its row) */ family?: Family; gateway?: Gateway; groups: Group[]; users: User[]; replace?: Credential; personal?: boolean; sharedSubscriptions?: boolean
  /** one way chosen already ("Claude 구독 연결"): the list of ways is not shown (in the simple form, until "다른 방법") */
  initialKind?: CredentialKind
  /** the list shows only these ways ("API 키로 연결": the Claude and OpenAI keys) */
  onlyKinds?: CredentialKind[]
  simple?: boolean
  onClose: () => void; onDone: () => void
}) {
  const t = useT()
  const locale = useLocale()
  // a guest's own account: no word about the company's or the team's keys (only their own answers them, lib/guests.ts)
  const guest = isGuestMe(useMe())
  const [kind, setKind] = useState<CredentialKind | null>(replace?.kind ?? initialKind ?? null)
  const [label, setLabel] = useState(replace?.label ?? '')
  const [secret, setSecret] = useState('')
  const [assignments, setAssignments] = useState<CredentialAssignment[]>([])
  /** the target picker's "chosen groups and people" (TargetPicker) */
  const [pick, setPick] = useState(false)
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** a sign-in is already running (one at a time): how long it can still take; the starter's own (`mine`, their tab may be
   * gone) to stop it and start again; for the owner and an admin whose, to stop any */
  const [busyLogin, setBusyLogin] = useState<LoginBusyParams | null>(null)
  const [login, setLogin] = useState<CredentialLogin | null>(null)
  /** Claude: the terminal fallback is open (paste a setup-token token instead of the sign-in) */
  const [manual, setManual] = useState(false)
  /** Claude: the code the person pastes after approving */
  const [loginCode, setLoginCode] = useState('')
  const [codeBusy, setCodeBusy] = useState(false)
  /** a code is on its way (Enter twice, a double click: one request, the second would only hear "not waiting") */
  const sending = useRef(false)
  /** the token is already a personal connection the owner may move to the team (409 params.movable) */
  const [move, setMove] = useState<DuplicateCredentialParams | null>(null)
  /** the simple form opened on one way: "다른 방법" shows the list of ways */
  const [otherWays, setOtherWays] = useState(false)
  const secure = canSeal()
  const subscription = kind !== null && SUBSCRIPTION.has(kind)
  const sharingBlocked = subscription && !personal && !sharedSubscriptions
  /** a subscription signed in from the browser (ChatGPT always, Claude unless the terminal paste is open) */
  const signIn = kind === 'chatgpt' || (kind === 'anthropic-oauth' && !manual)
  const name = simple && kind && !replace ? simpleLabel(kind, gateway) : label.trim()
  /** the target picker shows, set to chosen groups and people with none ticked: not ready (it would be the whole team) */
  const pickNone = kind !== null && !replace && !personal && !simple && pick && !assignments.length
  const ready = kind !== null && !sharingBlocked && (replace || name.length > 0) && (signIn || formatOk(kind, secret.trim(), gateway)) && (!subscription || replace || ack) && !pickNone

  // sign-in progress: the WebSocket event, and a poll in case the socket is down
  useEffect(() => {
    if (!login || FINISHED.includes(login.state)) return
    const off = credentialLogin.on((l) => { if (l.loginId === login.loginId) setLogin(l) })
    const poll = setInterval(async () => {
      try { setLogin(await api.call(personal ? API.getMyCredentialLogin : API.getCredentialLogin, { params: { id: login.loginId } })) } catch { /* the event will do */ }
    }, 3000)
    return () => { off(); clearInterval(poll) }
  }, [login, personal])

  // the tab closes (or the page goes) while the sign-in runs: it is stopped, so the server's one sign-in slot is free
  // for everyone at once (QA TC-2581; without it the server frees it once the 3-second reads above have stopped for 5
  // minutes and someone asks). A page kept for the back button (persisted) may come back: its reads say it is there.
  useEffect(() => {
    // not while the pasted code is being checked: that sign-in was approved already and finishes by itself
    if (!login || FINISHED.includes(login.state) || login.state === 'checking') return
    const bye = (e: PageTransitionEvent) => {
      if (e.persisted) return
      void api.call(personal ? API.cancelMyCredentialLogin : API.cancelCredentialLogin, { params: { id: login.loginId }, keepalive: true }).catch(() => {})
    }
    window.addEventListener('pagehide', bye)
    return () => window.removeEventListener('pagehide', bye)
  }, [login, personal])

  // the sign-in ended well: say so once (the dialog's own line only says "connected"; the order is the news)
  const toasted = useRef<string | null>(null)
  useEffect(() => {
    if (login?.state !== 'done' || toasted.current === login.loginId) return
    toasted.current = login.loginId
    // the order hint only where an order can be changed: the team's list (not one's own, not the welcome steps)
    toast({ level: 'success', text: replace || personal || simple ? t('credentials.connected') : t('credentials.added') })
  }, [login, replace, personal, simple, t])

  const submit = async () => {
    if (!kind || !ready) return
    setBusy(true); setError(null); setBusyLogin(null)
    try {
      if (signIn) {
        const loginKind = kind as CredentialLoginKind
        const common = { kind: loginKind, label: name || replace?.label || (loginKind === 'chatgpt' ? 'ChatGPT' : 'Claude'), acknowledgedPlanNotice: true as const, ...(replace ? { reconnectId: replace.id } : {}) }
        setLoginCode('')
        setLogin(personal ? await api.call(API.startMyCredentialLogin, { body: common }) : await api.call(API.startCredentialLogin, { body: { ...common, assignments } }))
        return
      }
      const key = await api.call(API.sealingKey)
      if (replace) {
        const sealed = await sealSecret(key, secret.trim(), 'credential.replace')
        await api.call(API.replaceCredentialSecret, { params: { id: replace.id }, body: { sealed } })
        toast({ level: 'success', text: t('credentials.connected') })
      } else {
        const sealed = await sealSecret(key, secret.trim(), 'credential.create')
        const body = { kind: kind as Exclude<CredentialKind, 'chatgpt'>, label: name, sealed, ...(subscription ? { acknowledgedPlanNotice: ack } : {}) }
        const c = personal ? await api.call(API.createMyCredential, { body })
          : await api.call(API.createCredential, { body: { ...body, assignments, ...(move?.credentialId ? { moveFrom: move.credentialId } : {}) } })
        toast({ level: 'success', text: move ? t('credentials.moved') : c.state === 'unverified' ? t('credentials.unverifiedSaved') : t('credentials.connected') })
      }
      setSecret('')
      onDone()
    } catch (e) {
      // another sign-in holds the slot: the busy line below says it in plain words (never the server's raw message)
      const b = isApiError(e, 'busy') ? LoginBusyParams.safeParse(e.body.params) : null
      if (b?.success) setBusyLogin(b.data)
      else setError(errorText(e, locale, t('error.network')))
      // already a personal connection: offer "Move it to the team" (the sealed secret typed again is the proof)
      if (isApiError(e, 'conflict')) {
        const dup = !personal && !replace ? DuplicateCredentialParams.safeParse(e.body.params) : null
        if (dup?.success && dup.data.movable && dup.data.credentialId) { setMove(dup.data) } else setMove(null)
      }
    } finally { setBusy(false) }
  }
  // the slot is someone else's: read it again every few seconds, so Start turns on by itself once it is free (and the
  // minutes left stay true); nothing to start meanwhile
  const waitingOther = !!busyLogin && !busyLogin.mine
  useEffect(() => {
    if (!waitingOther) return
    let live = true
    const check = async () => {
      try {
        const s = await api.call(API.myCredentialLoginSlot)
        if (!live) return
        if (!s.busy) setBusyLogin(null)
        else if (s.expiresAt) setBusyLogin((b) => (b ? { ...b, expiresAt: s.expiresAt } : b))
      } catch { /* the next read will do */ }
    }
    const t = setInterval(() => void check(), 4000)
    return () => { live = false; clearInterval(t) }
  }, [waitingOther])
  /** stop the sign-in that is in the way (the caller's own through its door; any, for the owner or an admin): one's own
   * starts again at once (what they pressed is not lost), someone else's leaves Start to be pressed again */
  const [stopping, setStopping] = useState(false)
  const stopBusy = async () => {
    if (!busyLogin?.loginId || stopping) return
    const id = busyLogin.loginId
    const own = !!busyLogin.mine
    setStopping(true)
    try {
      await api.call(own && busyLogin.personal ? API.cancelMyCredentialLogin : API.cancelCredentialLogin, { params: { id } })
    } catch (e) {
      if (!isApiError(e, 'not_found')) { setError(errorText(e, locale, t('error.network'))); setStopping(false); return }
    }
    setStopping(false)
    setBusyLogin(null); setError(null)
    if (own) void submit()
  }
  /** Claude: the pasted code, sealed like a token, to the sign-in that waits for it */
  const sendCode = async () => {
    if (!login || login.state !== 'code' || sending.current || !CLAUDE_CODE_RE.test(loginCode.trim())) return
    sending.current = true
    setCodeBusy(true); setError(null)
    try {
      const key = await api.call(API.sealingKey)
      const sealed = await sealSecret(key, loginCode.trim(), 'credential.login-code')
      setLogin(await api.call(personal ? API.submitMyCredentialLoginCode : API.submitCredentialLoginCode, { params: { id: login.loginId }, body: { sealed } }))
      setLoginCode('')
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally { setCodeBusy(false); sending.current = false }
  }
  const cancelLogin = async () => {
    // the sign-in finished: closing any way (x, Esc, outside) is Done, so the list shows the new account
    if (login?.state === 'done') { onDone(); return }
    if (login && !FINISHED.includes(login.state)) {
      try { await api.call(personal ? API.cancelMyCredentialLogin : API.cancelCredentialLogin, { params: { id: login.loginId } }) } catch (e) {
        // the new token is being saved right now: the dialog stays and shows how it ends
        if (isApiError(e, 'conflict')) { setError(errorText(e, locale, t('error.network'))); return }
        /* else: gone already */
      }
    }
    onClose()
  }
  const kinds = (personal ? PERSONAL_KIND_ORDER : KIND_ORDER).filter((k) => (!replace || k === replace.kind) && (!family || FAMILY[family].includes(k)) && (!onlyKinds || onlyKinds.includes(k)))
  // moving a member's connection to a team connection picked for other people: that member may be left without AI
  const mover = move?.where === 'personal' && move.ownerId ? users.find((u) => u.id === move.ownerId) : undefined
  const leftOut = !!mover && assignments.length > 0
    && !assignments.some((a) => (a.subjectType === 'user' && a.subjectId === mover.id) || (a.subjectType === 'group' && mover.groupIds.includes(a.subjectId)))
  const finished = login && FINISHED.includes(login.state)
  const claudeWaits = login?.kind === 'anthropic-oauth' && (login.state === 'code' || login.state === 'checking')

  return (
    <Modal open onClose={cancelLogin} width={560} title={replace ? (SUBSCRIPTION.has(replace.kind) ? t('credentials.reconnect') : t('credentials.replace')) : t('providers.addAccount')}
      footer={login ? (
        <>
          {login.state === 'done' ? <Button variant="primary" onClick={onDone}>{t('common.done')}</Button>
            : finished ? <Button variant="primary" onClick={() => { setLogin(null); setError(null) }}>{t('credentials.chatgpt.restart')}</Button>
            : <Button variant="ghost" onClick={cancelLogin}>{t('common.cancel')}</Button>}
          {claudeWaits && (
            <Button variant="primary" busy={codeBusy || login.state === 'checking'} disabled={login.state !== 'code' || !CLAUDE_CODE_RE.test(loginCode.trim())} onClick={sendCode} data-testid="claude-code-submit">
              {login.state === 'checking' ? t('credentials.checking') : t('credentials.connect')}
            </Button>
          )}
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={busy} disabled={!ready || !secure || !!busyLogin} onClick={submit} data-testid="credential-submit">
            {busy ? t('credentials.checking') : kind === 'chatgpt' ? t('credentials.chatgpt.start') : kind === 'anthropic-oauth' && signIn ? t('credentials.claude.start') : move ? t('credentials.moveToTeam') : t('credentials.connect')}
          </Button>
        </>
      )}>
      {!secure ? <p className="text-sm text-warn" data-testid="credential-https-only">{t('credentials.httpsOnly')}</p>
        : login ? (login.kind === 'anthropic-oauth'
          ? <ClaudeProgress l={login} code={loginCode} onCode={(v) => { setLoginCode(v); setError(null) }} onSubmit={sendCode} error={error} />
          : <ChatgptProgress l={login} personal={personal} />)
        : (
          <div className="space-y-4">
            {personal && <p className="text-sm text-muted">{t(guest ? 'credentials.personalFirstGuest' : 'credentials.personalFirst')}</p>}
            {!personal && !sharedSubscriptions && kinds.some((k) => SUBSCRIPTION.has(k)) && <p className="text-sm text-warn" data-testid="shared-subscriptions-off">{t('credentials.sharedSubscriptionsOff')}</p>}
            {!replace && (!initialKind || otherWays) && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{t('credentials.chooseKind')}</legend>
                {kinds.map((k) => {
                  const policyOff = !personal && SUBSCRIPTION.has(k) && !sharedSubscriptions
                  const off = !allowedKinds.includes(k) || policyOff
                  // with a gateway the Claude API key is the gateway's
                  const via = k === 'anthropic-api-key' ? gateway : null
                  return (
                    <label key={k} className={`flex items-start gap-2 rounded-lg border border-line p-2 text-sm ${off ? 'opacity-60' : 'cursor-pointer hover:bg-hover'}`}>
                      <input type="radio" name="kind" disabled={off} checked={kind === k} onChange={() => { setKind(k); setError(null); setMove(null) }} data-testid={`kind-${k}`} />
                      <span>
                        <span className="font-medium">{via ? t('credentials.kind.gateway', { label: via.label }) : t(`credentials.kind.${k}` as MessageKey)}</span>
                        <span className="block text-xs text-muted">{policyOff ? t('credentials.sharedSubscriptionsOff') : off ? t('credentials.kindOff') : via ? t('credentials.kind.gateway.desc', { label: via.label }) : t((guest && (k === 'anthropic-api-key' || k === 'openai-api-key') ? `credentials.kind.${k}.descGuest` : `credentials.kind.${k}.desc`) as MessageKey)}</span>
                      </span>
                    </label>
                  )
                })}
              </fieldset>
            )}
            {kind === 'anthropic-oauth' && !manual && <p className="text-sm text-muted" data-testid="claude-login-how">{t('credentials.claude.how')}</p>}
            {(kind === 'anthropic-api-key' || kind === 'openai-api-key') && (
              <p className="text-sm text-muted">
                {/* a member's own key (Settings › AI providers) is theirs, not a key made for the team */}
                {t(personal ? 'credentials.apiKey.hintOwn' : 'credentials.apiKey.hint')}{' '}
                {!(kind === 'anthropic-api-key' && gateway) && <a className="inline-flex items-center gap-1 text-accent-text underline" href={kind === 'anthropic-api-key' ? 'https://platform.claude.com/settings/keys' : 'https://platform.openai.com/api-keys'} target="_blank" rel="noreferrer noopener">
                  {t(kind === 'anthropic-api-key' ? 'credentials.apiKey.consoleAnthropic' : 'credentials.apiKey.consoleOpenai')} <ExternalLink size={12} aria-hidden />
                </a>}
              </p>
            )}
            {kind && !replace && !simple && (
              <Field label={t('credentials.label')}>
                <input className={inputCls} value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} data-testid="credential-label" />
              </Field>
            )}
            {(kind === 'anthropic-api-key' || kind === 'openai-api-key') && (
              <Field label={t('credentials.apiKey.paste')} error={secret.trim() && !formatOk(kind, secret.trim(), gateway) ? t('credentials.apiKey.invalidFormat') : null}>
                <input className={inputCls} type="password" autoComplete="off" spellCheck={false} value={secret} onChange={(e) => { setSecret(e.target.value); setError(null); if (move) setMove(null) }} data-testid="credential-secret" />
              </Field>
            )}
            {kind && !replace && !personal && !simple && <TargetPicker value={assignments} onChange={setAssignments} pick={pick} setPick={setPick} groups={groups} users={users} />}
            {subscription && !replace && simple && (
              // the provider's terms in one line: the server still needs this yes (acknowledgedPlanNotice, D23)
              <label className="flex items-start gap-2 text-sm" data-testid="plan-notice">
                <input type="checkbox" className="mt-1 shrink-0" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="plan-notice-ack" />
                <span>{t('aiConnect.terms')}</span>
              </label>
            )}
            {subscription && !replace && !simple && (
              <div className="rounded-lg bg-subtle p-3 text-sm" data-testid="plan-notice">
                <p>{t('credentials.planNotice')}</p>
                <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="plan-notice-ack" /> {t('credentials.planNoticeAck')}</label>
              </div>
            )}
            {error && <p className="text-sm text-danger" role="alert" data-testid="dialog-error">{error}</p>}
            {busyLogin && <LoginBusy b={busyLogin} admin={!personal} stopping={stopping} onStop={() => void stopBusy()} />}
            {move && (
              <div className="rounded-lg bg-subtle p-3 text-sm" data-testid="credential-move">
                <p className="font-medium">{t('credentials.moveToTeam')}</p>
                <p className="mt-1 text-muted">{move.where === 'own' ? t('credentials.moveOwnHint', { label: move.label ?? '' }) : t('credentials.moveHint', { name: move.ownerName ?? '', label: move.label ?? '' })}</p>
                {leftOut && <p className="mt-1 text-warn" data-testid="credential-move-left-out">{t('credentials.moveLeftOut', { name: move.ownerName ?? '' })}</p>}
              </div>
            )}
            {kind === 'anthropic-oauth' && (
              // the fallback: a token made with `claude setup-token` on any computer, pasted (folded: the sign-in is the way)
              <details open={manual} onToggle={(e) => { const open = (e.currentTarget as HTMLDetailsElement).open; setManual(open); if (!open) { setSecret(''); setMove(null) } }} data-testid="claude-manual">
                <summary className="cursor-pointer text-xs text-muted select-none">{t('credentials.claude.manual')}</summary>
                <div className="mt-2 space-y-3">
                  <ol className="list-decimal space-y-2 pl-5 text-sm" data-testid="setup-token-steps">
                    <li>{t('credentials.setupToken.steps.1')}
                      <CommandLine text="curl -fsSL https://claude.ai/install.sh | bash" />
                      <span className="text-xs text-muted">{t('credentials.setupToken.steps.1win')}</span> <CommandLine text="irm https://claude.ai/install.ps1 | iex" />
                    </li>
                    <li>{t('credentials.setupToken.steps.2')} <CommandLine text="claude setup-token" /></li>
                    <li>{t('credentials.setupToken.steps.3')}</li>
                    <li>{t('credentials.setupToken.steps.4')}</li>
                  </ol>
                  <Field label={t('credentials.setupToken.paste')} error={secret.trim() && !formatOk(kind, secret.trim(), gateway) ? t('credentials.setupToken.invalidFormat') : null}>
                    <input className={inputCls} type="password" autoComplete="off" spellCheck={false} value={secret} onChange={(e) => { setSecret(e.target.value); setError(null); if (move) setMove(null) }} data-testid="credential-secret" />
                  </Field>
                </div>
              </details>
            )}
            {simple && initialKind && !replace && !otherWays && (
              <button type="button" className="text-xs text-muted underline decoration-line-strong underline-offset-4 hover:text-ink" onClick={() => setOtherWays(true)} data-testid="credential-other-ways">
                {t('welcome.ai.other')}
              </button>
            )}
          </div>
        )}
    </Modal>
  )
}

/** Another sign-in holds the server's one slot (409 busy, LoginBusyParams), in plain words with the real time left:
 * the caller's own (a tab they closed): "Stop it and start again"; for the owner or an admin, whose it is and Stop; for
 * a member, someone on the team, and at most how many minutes it can still take (it ends sooner when its tab goes). */
function LoginBusy({ b, admin, stopping, onStop }: { b: LoginBusyParams; admin: boolean; stopping: boolean; onStop: () => void }) {
  const t = useT()
  const left = b.expiresAt ? Math.max(1, Math.ceil((Date.parse(b.expiresAt) - Date.now()) / 60_000)) : null
  const wait = left !== null ? t('credentials.loginBusyLeft', { n: left }) : null
  const text = b.mine ? t('credentials.loginBusyMine')
    : admin && b.starter !== undefined ? t('credentials.loginBusy', { name: b.starter, kind: t(b.personal ? 'credentials.loginBusyPersonal' : 'credentials.loginBusyTeam') })
    : t('credentials.loginBusyMember')
  const canStop = !!b.loginId && (b.mine || (admin && b.starter !== undefined))
  // on a phone the personal dialog is taller than the screen: the line appears under the fold, behind the button row,
  // and the person only saw the connect button turn off (QA TC-2581 at 390). Bring it into view when it appears.
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { box.current?.scrollIntoView?.({ block: 'nearest' }) }, [])
  return (
    <div ref={box} role="status" className="space-y-2 rounded-lg bg-subtle p-3 text-sm leading-6 break-keep" data-testid="login-busy">
      <p className="text-ink">{text}{!b.mine && wait ? <> <span data-testid="login-busy-left">{wait}</span></> : null}</p>
      {canStop && (
        <Button size="sm" variant="secondary" busy={stopping} onClick={onStop} data-testid="login-busy-stop">{t(b.mine ? 'credentials.loginStopRestart' : 'credentials.loginStop')}</Button>
      )}
    </div>
  )
}

function CommandLine({ text }: { text: string }) {
  return (
    <span className="my-1 flex items-center gap-1 rounded-md bg-subtle px-2 py-1 font-mono text-xs">
      <code className="min-w-0 flex-1 break-all">{text}</code>
      <CopyButton text={text} />
    </span>
  )
}

/** Claude: open the authorize page (a new tab, or copy its link to another browser), paste the code it shows; then
 * the check, then the result */
export function ClaudeProgress({ l, code, onCode, onSubmit, error }: { l: CredentialLogin; code: string; onCode: (v: string) => void; onSubmit: () => void; error: string | null }) {
  const t = useT()
  const [opened, setOpened] = useState(false)
  const codeRef = useRef<HTMLInputElement>(null)
  if (l.state === 'starting') return <p className="text-sm text-muted" data-testid="claude-starting">{t('credentials.claude.starting')}</p>
  if ((l.state === 'code' || l.state === 'checking') && l.url) {
    const bad = code.trim() !== '' && !CLAUDE_CODE_RE.test(code.trim())
    return (
      <div className="space-y-4" data-testid="claude-code">
        {/* Open is the main action until it is used (or a code is in), then Connect is: one primary at a time. Copy
            link: the same link for another browser (the one signed in to Claude) or another device. */}
        <SignInLinks url={l.url} label={t('credentials.claude.open')} copyLabel={t('credentials.claude.copyLink')} primary={!opened && code.trim() === ''}
          testId="claude-open" onOpen={() => { setOpened(true); setTimeout(() => codeRef.current?.focus(), 0) }} />
        <Field label={t('credentials.claude.code')} error={bad ? t('credentials.claude.codeInvalid') : null}>
          <input ref={codeRef} className={inputCls} autoComplete="off" spellCheck={false} value={code} disabled={l.state !== 'code'} data-testid="claude-code-input"
            onChange={(e) => onCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onSubmit() }} />
        </Field>
        {error && <p className="text-sm text-danger" role="alert" data-testid="dialog-error">{error}</p>}
      </div>
    )
  }
  if (l.state === 'done') return <p className="text-sm text-ok" data-testid="claude-done">{l.credential?.state === 'unverified' ? t('credentials.unverifiedSaved') : t('credentials.claude.done')}</p>
  if (l.state === 'expired') return <p className="text-sm text-warn" data-testid="login-expired">{t(l.reason === 'idle' ? 'credentials.loginIdle' : 'credentials.chatgpt.expired')}</p>
  if (l.state === 'cancelled') return <p className="text-sm text-muted">{t('credentials.chatgpt.cancelled')}</p>
  const reason: MessageKey = l.reason === 'bad_code' ? 'credentials.claude.badCode' : l.reason === 'refused' ? 'credentials.claude.refused' : l.reason === 'duplicate' ? 'credentials.claude.duplicate'
    : l.reason === 'token_unreadable' ? 'credentials.claude.tokenUnreadable' : 'credentials.claude.failed'
  return <p className="text-sm text-danger" data-testid="claude-failed">{t(reason)}</p>
}

/** `personal`: a member's own account (Settings › AI providers), not the one the team uses */
function ChatgptProgress({ l, personal }: { l: CredentialLogin; personal?: boolean }) {
  const t = useT()
  if (l.state === 'starting') return <p className="text-sm text-muted">{t('credentials.chatgpt.starting')}</p>
  if (l.state === 'code' && l.url && l.code) return (
    <ol className="list-decimal space-y-3 pl-5 text-sm" data-testid="chatgpt-code">
      <li>{t('credentials.chatgpt.step1')}
        <div className="mt-2"><SignInLinks url={l.url} label={t('credentials.chatgpt.open')} copyLabel={t('credentials.claude.copyLink')} testId="chatgpt-open" /></div>
      </li>
      <li>{t('credentials.chatgpt.step2')}
        <span className="mt-1 flex items-center gap-2"><code className="text-xl font-semibold tracking-widest" data-testid="chatgpt-user-code">{l.code}</code><CopyButton text={l.code} /></span>
      </li>
      <li>{t(personal ? 'credentials.chatgpt.step3Own' : 'credentials.chatgpt.step3')}</li>
      <li className="list-none text-muted">⏳ {t('credentials.chatgpt.waiting')}</li>
    </ol>
  )
  if (l.state === 'done') return <p className="text-sm text-ok" data-testid="chatgpt-done">{t('credentials.chatgpt.done', { plan: l.credential?.planType ?? '' })}</p>
  if (l.state === 'expired') return <p className="text-sm text-warn" data-testid="login-expired">{t(l.reason === 'idle' ? 'credentials.loginIdle' : 'credentials.chatgpt.expired')}</p>
  if (l.state === 'cancelled') return <p className="text-sm text-muted">{t('credentials.chatgpt.cancelled')}</p>
  const reason = l.reason === 'other_account' ? 'credentials.chatgpt.otherAccount' : l.reason === 'same_account' ? 'credentials.chatgpt.sameAccount' : 'credentials.chatgpt.failed'
  return <p className="text-sm text-danger" data-testid="chatgpt-failed">{t(reason)}</p>
}

/** rename, who uses it, monthly limit (owner) */
function EditCredential({ c, groups, users, onClose, onSaved }: { c: Credential; groups: Group[]; users: User[]; onClose: () => void; onSaved: () => void }) {
  const t = useT()
  const act = useAction()
  const [label, setLabel] = useState(c.label)
  const [assignments, setAssignments] = useState<CredentialAssignment[]>(c.assignments.map(({ subjectType, subjectId }) => ({ subjectType, subjectId })))
  const [pick, setPick] = useState(c.assignments.length > 0)
  const [usd, setUsd] = useState(c.spendLimit.usd === null ? '' : String(c.spendLimit.usd))
  const [tokens, setTokens] = useState(c.spendLimit.tokens === null ? '' : String(c.spendLimit.tokens))
  const [action, setAction] = useState(c.spendLimit.action)
  const [busy, setBusy] = useState(false)
  const apiKey = c.kind === 'anthropic-api-key' || c.kind === 'openai-api-key'
  const num = (s: string) => (s.trim() === '' ? null : Math.max(0, Number(s)))
  // "chosen groups and people" with none ticked would save as the whole team: not until one is ticked
  const valid = label.trim().length > 0 && (usd.trim() === '' || Number.isFinite(Number(usd))) && (tokens.trim() === '' || Number.isInteger(Number(tokens))) && !(pick && !assignments.length)
  return (
    <Modal open onClose={onClose} title={c.label} width={520}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" busy={busy} disabled={!valid} onClick={async () => {
          setBusy(true)
          const r = await act(() => api.call(API.updateCredential, { params: { id: c.id }, body: { label: label.trim(), assignments, spendLimit: { usd: apiKey ? num(usd) : null, tokens: num(tokens) === null ? null : Math.round(num(tokens)!), action } } }), t('common.saved'))
          setBusy(false)
          if (r) onSaved()
        }}>{t('common.save')}</Button>
      </>}>
      <div className="space-y-4">
        <Field label={t('credentials.label')}><input className={inputCls} value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} /></Field>
        <TargetPicker value={assignments} onChange={setAssignments} pick={pick} setPick={setPick} groups={groups} users={users} />
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-muted">{t('credentials.spendLimit')}</legend>
          <p className="text-xs text-faint">{t('credentials.spendLimitHint')}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {apiKey && <Field label={t('credentials.spendLimitUsd')}><input className={inputCls} inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} /></Field>}
            <Field label={t('credentials.spendLimitTokens')}><input className={inputCls} inputMode="numeric" value={tokens} onChange={(e) => setTokens(e.target.value)} /></Field>
          </div>
          <select className={inputCls} value={action} onChange={(e) => setAction(e.target.value as 'warn' | 'block')}>
            <option value="block">{t('credentials.spendLimitAction.block')}</option>
            <option value="warn">{t('credentials.spendLimitAction.warn')}</option>
          </select>
        </fieldset>
      </div>
    </Modal>
  )
}

/** Settings › AI providers: one's own accounts, by provider (Claude, Codex), each with Add account while the team allows
 * members their own (shown only then, or while one is still there). */
export function MyCredentials() {
  const t = useT()
  const actOk = useActionOk()
  // a phone: "Add account" is the last row under the provider's accounts, not a button beside its name
  const phone = useMediaQuery('(max-width: 767.98px)')
  const state = useLoad(() => api.call(API.myCredentials))
  const [adding, setAdding] = useState<Family | null>(null)
  // a guest with their own sign-in: only their own account answers them, never the team's (lib/guests.ts)
  const guest = isGuestMe(useMe())
  return (
    <Loadable state={state}>
      {(d) => (
        // a phone: Settings' bar says "AI providers", so the card has no frame and its title is for screen readers
        <Card flat title={<span className="max-md:sr-only">{t('settings.providers')}</span>} desc={t(guest ? 'settings.credentials.descGuest' : 'settings.credentials.desc')}>
          <div className="space-y-5" data-testid="my-providers">
            {(['claude', 'codex'] as const).map((fam) => {
              const kinds = d.allowedKinds.filter((k) => FAMILY[fam].includes(k))
              const list = d.items.filter((c) => FAMILY[fam].includes(c.kind))
              if (!kinds.length && !list.length) return null
              return (
                <section key={fam} aria-labelledby={`my-cred-${fam}`} data-testid={`my-provider-${fam}`}>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h3 id={`my-cred-${fam}`} className="text-title-sm font-semibold">{t(`credentials.group.${fam}`)}</h3>
                    {d.allowed && kinds.length > 0 && !phone && (
                      <Button size="sm" onClick={() => setAdding(fam)} data-testid={`my-credential-add-${fam}`}><Plus size={14} aria-hidden /> {t('providers.addAccount')}</Button>
                    )}
                  </div>
                  {!list.length && phone && d.allowed && kinds.length > 0 ? null : !list.length ? <p className="text-sm text-faint">{t('providers.noAccounts')}</p> : (
                    <ul className="divide-y divide-line rounded-xl border border-line" data-testid="my-credentials">
                      {list.map((c) => (
                        <CredentialRow key={c.id} c={c} target={t('credentials.target.personal', { name: c.owner?.name ?? '' })} owner={false} checking={false} personal ownDelete
                          onCheck={() => {}} onEdit={() => {}} onReplace={() => {}} onToggle={() => {}}
                          onRemove={async () => {
                            if (!(await confirmDialog({ title: t('credentials.deleteConfirm', { label: c.label }), confirm: t('common.delete'), danger: true }))) return
                            if (await actOk(() => api.call(API.deleteMyCredential, { params: { id: c.id } }))) void state.reload()
                          }} />
                      ))}
                    </ul>
                  )}
                  {d.allowed && kinds.length > 0 && phone && (
                    <button type="button" onClick={() => setAdding(fam)} className="flex min-h-12 w-full items-center gap-3 rounded-lg px-1 text-left text-sm text-accent-text hover:bg-hover" data-testid={`my-credential-add-${fam}`}>
                      <Plus size={16} className="shrink-0" aria-hidden /> {t('providers.addAccount')}
                    </button>
                  )}
                </section>
              )
            })}
          </div>
          {adding && <AddCredential personal allowedKinds={d.allowedKinds} family={adding} gateway={d.anthropicGateway} groups={[]} users={[]} onClose={() => setAdding(null)} onDone={() => { setAdding(null); void state.reload() }} />}
        </Card>
      )}
    </Loadable>
  )
}
