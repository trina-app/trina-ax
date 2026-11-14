// "Invite a guest" (docs/DECISIONS.md "Guests: only what they were invited to"): the row at the top of a group chat's
// and a project's "Add people" lists, and the small dialog it opens: their name, the AI choice (off by default; the
// owner and admins also see "Team AI", a team AI account with a monthly limit), "Create link", then the one-time link
// with Copy. POST /api/guest-invites; the server checks who may invite into this place and the plan's guest cap (409
// plan_limit reason guest_limit: "Guests: up to N", never a word about seats).
// The AI choice (GuestAiChoices) is the same control Admin › Members › Guests uses to change it later.
import { UserRoundPlus } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { Credential, GuestAiChoice } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { GUEST_LIMIT, GUEST_ONE_PLACE, type PlaceKind } from '../lib/guests'
import { useLocale, useT } from '../i18n'
import { useNavigate } from 'react-router-dom'
import { isAdmin, useMe } from '../store/session'
import { Button, CopyButton, Field, inputCls, Modal } from './ui'
import { ListRow } from './list/List'
import { LocalLinkNote } from './LocalLinkNote'
import { absoluteUrl } from './handover/LeadInvite'

export interface InvitePlace { kind: PlaceKind; id: string; name: string }

/** The row of an "Add people" list that opens the dialog (a ListRow, face box, like the room info's 초대하기). */
export function InviteGuestRow({ place, onOpen }: { place: PlaceKind; onOpen: () => void }) {
  const t = useT()
  return (
    <ListRow
      onClick={onOpen}
      face
      icon={<UserRoundPlus />}
      name={<span className="text-ink">{t('guest.invite.row')}</span>}
      meta={t(place === 'room' ? 'guest.invite.rowRoom' : 'guest.invite.rowProject')}
      testId="invite-guest-row"
    />
  )
}

/** The guest's AI, as an invite starts it and as an admin changes it: none (default), team (admins), own. `connections`:
 * the team's AI accounts (for team; null while they load). */
export function GuestAiChoices({ value, onChange, admin, connections }: { value: GuestAiChoice; onChange: (v: GuestAiChoice) => void; admin: boolean; connections: Credential[] | null }) {
  const t = useT()
  const id = useId()
  const modes = (admin ? ['none', 'team', 'own'] : ['none', 'own']) as GuestAiChoice['mode'][]
  const pick = (mode: GuestAiChoice['mode']) => {
    if (mode === value.mode) return
    if (mode === 'team') onChange({ mode, credentialId: connections?.[0]?.id ?? '', limitUsd: 20 })
    else onChange({ mode })
  }
  // Team AI picked before the accounts were read: the first one, once they are (the list shows it chosen)
  const missing = value.mode === 'team' && !value.credentialId ? connections?.[0]?.id : undefined
  useEffect(() => { if (missing && value.mode === 'team') onChange({ ...value, credentialId: missing }) }, [missing]) // eslint-disable-line react-hooks/exhaustive-deps
  const hint: Record<GuestAiChoice['mode'], string> = { none: t('guest.ai.noneHint'), team: t('guest.ai.teamHint'), own: t('guest.ai.ownHint') }
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-ink">{t('guest.invite.ai')}</legend>
      <div role="radiogroup" className="flex flex-col gap-1" data-testid="guest-ai">
        {modes.map((m) => (
          <label key={m} className="flex cursor-pointer items-start gap-2.5 rounded-lg px-1 py-1.5 hover:bg-hover">
            <input type="radio" name={`${id}-ai`} value={m} checked={value.mode === m} onChange={() => pick(m)} className="mt-0.5 size-4 shrink-0" data-testid={`guest-ai-${m}`} />
            <span className="min-w-0">
              <span className="block text-sm text-ink">{t(`guest.ai.${m}`)}</span>
              <span className="block text-xs leading-5 text-muted">{hint[m]}</span>
            </span>
          </label>
        ))}
      </div>
      {value.mode === 'team' && (
        <div className="mt-2 grid gap-3 pl-7 sm:grid-cols-[minmax(0,1fr)_9rem]" data-testid="guest-ai-team-fields">
          {connections && !connections.length ? (
            <p className="text-sm break-keep text-muted sm:col-span-2" data-testid="guest-ai-no-account">{t('guest.ai.noAccount', { path: t('admin.providers') })}</p>
          ) : (
            <>
              <label className="block min-w-0">
                <span className="mb-1 block text-xs font-medium text-muted">{t('guest.ai.account')}</span>
                <select className={inputCls} value={value.credentialId} onChange={(e) => onChange({ ...value, credentialId: e.target.value })} disabled={!connections} data-testid="guest-ai-account">
                  {(connections ?? []).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">{t('guest.ai.limit')}</span>
                <input type="number" inputMode="decimal" min={1} step={1} className={inputCls} value={Number.isFinite(value.limitUsd) ? value.limitUsd : ''}
                  onChange={(e) => onChange({ ...value, limitUsd: Number(e.target.value) })} data-testid="guest-ai-limit" />
              </label>
            </>
          )}
        </div>
      )}
    </fieldset>
  )
}

/** A team mode choice that can be sent: an account picked and a limit above 0. */
export const aiChoiceReady = (v: GuestAiChoice) => v.mode !== 'team' || (!!v.credentialId && v.limitUsd > 0)

/** The team's AI accounts a guest may be given (Admin › AI accounts, team ones): read only for the owner and admins. */
export function useTeamConnections(enabled: boolean): Credential[] | null {
  const [list, setList] = useState<Credential[] | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    api.call(API.listCredentials).then((r) => live && setList(r.items.filter((c) => c.scope === 'team')), () => live && setList([]))
    return () => { live = false }
  }, [enabled])
  return list
}

/** Words for a refused guest change: the plan's guest cap in the owner's words, else the server's. */
export function guestErrorText(e: unknown, locale: ReturnType<typeof useLocale>, t: ReturnType<typeof useT>): string {
  if (isApiError(e, 'plan_limit') && e.body.params?.reason === GUEST_LIMIT && typeof e.body.params.limit === 'number') return t('guest.limit', { n: e.body.params.limit })
  return errorText(e, locale, t('error.network'))
}

/** `onCancel`: Cancel and × before the link is made (back to the add list it was opened from); `onClose`: Done after it. */
export function GuestInviteDialog({ place, onClose, onCancel = onClose }: { place: InvitePlace; onClose: () => void; onCancel?: () => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const admin = isAdmin(me)
  const [name, setName] = useState('')
  const [ai, setAi] = useState<GuestAiChoice>({ mode: 'none' })
  const connections = useTeamConnections(admin && ai.mode === 'team')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const create = async () => {
    if (busy || !aiChoiceReady(ai)) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.call(API.createGuestInvite, { body: { place: { kind: place.kind, id: place.id }, ai, ...(name.trim() ? { name: name.trim() } : {}) } })
      setUrl(absoluteUrl(r.url))
    } catch (e) {
      setError(guestErrorText(e, locale, t))
    } finally {
      setBusy(false)
    }
  }
  const who = name.trim()
  if (url)
    return (
      <Modal open onClose={onClose} title={who ? t('guest.invite.readyFor', { name: who }) : t('guest.invite.ready')} width={440} footer={<Button variant="primary" onClick={onClose}>{t('common.done')}</Button>}>
        <div className="space-y-3" data-testid="guest-invite-ready">
          <div className="flex items-center gap-2 rounded-lg border border-line bg-subtle px-3 py-2">
            <code className="min-w-0 flex-1 font-mono text-sm break-all select-all" data-testid="guest-invite-url">{url}</code>
            <CopyButton text={url} label={t('members.copyLink')} showLabel className="shrink-0 border border-line" />
          </div>
          <p className="text-sm break-keep text-muted">{t('guest.invite.once')}</p>
          <LocalLinkNote url={url} />
        </div>
      </Modal>
    )
  return (
    <Modal
      open
      onClose={onCancel}
      title={t('guest.invite.title')}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={busy} disabled={!aiChoiceReady(ai)} onClick={() => void create()} data-testid="guest-invite-create">{t('guest.invite.create')}</Button>
        </>
      }
    >
      <form className="space-y-4" data-testid="guest-invite-dialog" onSubmit={(e) => { e.preventDefault(); void create() }}>
        <p className="text-sm leading-6 break-keep text-muted" data-testid="guest-invite-where">
          {t(place.kind === 'room' ? 'guest.invite.whereRoom' : 'guest.invite.whereProject', { place: place.name })}
        </p>
        <Field label={t('guest.invite.name')}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder={t('guest.invite.namePlaceholder')} className={inputCls} data-testid="guest-invite-name" />
        </Field>
        <GuestAiChoices value={ai} onChange={setAi} admin={admin} connections={connections} />
        {error && <p role="alert" className="text-sm break-keep text-danger" data-testid="guest-invite-error">{error}</p>}
      </form>
    </Modal>
  )
}

/** A guest put into a second place was refused (409 conflict, reason guest_one_place): who it was when known (the
 * caller's `guestId`, else the server's params.userId), or null for any other error. */
export function onePlaceOf(e: unknown, guestId?: string): { guestId?: string } | null {
  if (!isApiError(e, 'conflict') || e.body.params?.reason !== GUEST_ONE_PLACE) return null
  const fromServer = e.body.params?.userId
  const id = guestId ?? (typeof fromServer === 'string' ? fromServer : undefined)
  return id ? { guestId: id } : {}
}

/** The refusal in place, under the guest's row (or the list): the owner's words, and for the owner and admins "Make
 * team member" on its own line, which opens the guest's row in Admin › Members. */
export function OnePlaceNote({ guestId, admin, className }: { guestId?: string; admin: boolean; className?: string }) {
  const t = useT()
  const navigate = useNavigate()
  return (
    <div role="alert" className={['text-sm leading-6 break-keep text-ink', className].filter(Boolean).join(' ')} data-testid="guest-one-place">
      <p>{t('guest.onePlace')}</p>
      {admin && (
        <Button size="sm" className="mt-1.5" onClick={() => navigate(guestAdminPath(guestId))} data-testid="guest-one-place-convert">
          {t('guest.makeMember')}
        </Button>
      )}
    </div>
  )
}

/** Admin › Members at the Guests section (and the guest's row, when known). */
export const guestAdminPath = (id?: string) => `/admin/members${id ? `?member=${encodeURIComponent(id)}` : ''}#guests`
