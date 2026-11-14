// "Invite a guest" (docs/DECISIONS.md "Guests: only what they were invited to"): the row at the top of a group chat's
// and a project's "Add people" lists, and the small dialog it opens: their name, the AI choice (off by default; the
// owner and admins also see "Team AI", a team AI account with a monthly limit), "Create link", then the one-time link
// with Copy. POST /api/guest-invites; the server checks who may invite into this place and the plan's guest cap (409
// plan_limit reason guest_limit: "Guests: up to N", never a word about seats). The cap is read when the dialog opens
// (GET /api/guest-invites/limit): a full plan says so at the top in place of the form, with "See plans" for the owner
// and admins and "Ask an admin" for members.
// The AI choice (GuestAiChoices) is the same control Admin › Members › Guests uses to change it later. Team AI's own
// fields (the account, the monthly limit) sit right under it; without a team AI account it is off, with "Add an AI
// account".
// A guest already in another place is greyed out in the add lists (GuestElsewhere: "In 'Quote prep'", no tick), with
// "Make team member" for the owner and admins.
import { UserRoundPlus } from 'lucide-react'
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { Credential, GuestAiChoice, GuestInviteLimit, Person } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { GUEST_LIMIT, GUEST_ONE_PLACE, type GuestPlaceView, type PlaceKind } from '../lib/guests'
import { noPurchaseLinks } from '../lib/desktop'
import { useLocale, useT } from '../i18n'
import { useNavigate } from 'react-router-dom'
import { isAdmin, useMe } from '../store/session'
import { usePeopleList } from '../store/people'
import { Button, Field, inputCls, Modal, Skeleton, useCopy } from './ui'
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
 * the team's AI accounts (for team; null while they load). Team AI's account and monthly limit sit right under it; with
 * no team AI account it cannot be picked and says where to add one. `legend`: false where the dialog's title already
 * says it ("AI for Alex"). */
export function GuestAiChoices({ value, onChange, admin, connections, legend = true }: { value: GuestAiChoice; onChange: (v: GuestAiChoice) => void; admin: boolean; connections: Credential[] | null; legend?: boolean }) {
  const t = useT()
  const id = useId()
  const modes = (admin ? ['none', 'team', 'own'] : ['none', 'own']) as GuestAiChoice['mode'][]
  const noAccount = !!connections && !connections.length
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
      <legend className={legend ? 'mb-1.5 text-sm font-medium text-ink' : 'sr-only'}>{t('guest.invite.ai')}</legend>
      {/* no hover fill: on a phone the tapped row kept it and an unpicked choice looked picked */}
      <div role="radiogroup" className="flex flex-col gap-1" data-testid="guest-ai">
        {modes.map((m) => {
          const off = m === 'team' && noAccount
          return (
            <div key={m}>
              <label className={off ? 'flex cursor-not-allowed items-start gap-2.5 px-1 py-1.5' : 'flex cursor-pointer items-start gap-2.5 px-1 py-1.5'}>
                <input type="radio" name={`${id}-ai`} value={m} checked={value.mode === m} disabled={off} onChange={() => pick(m)} className="mt-0.5 size-4 shrink-0 accent-accent disabled:opacity-50" data-testid={`guest-ai-${m}`} />
                <span className="min-w-0">
                  <span className={off ? 'block text-sm text-muted' : 'block text-sm text-ink'}>{t(`guest.ai.${m}`)}</span>
                  <span className="block text-xs leading-5 text-muted">{hint[m]}</span>
                </span>
              </label>
              {/* Team AI's own controls, under it: no account yet (and where to add one), or the account and the limit */}
              {m === 'team' && noAccount && (
                <p className="pb-1.5 pl-7 text-xs leading-5 break-keep text-muted" data-testid="guest-ai-no-account">
                  {t('guest.ai.noAccount')}{' '}
                  <Link to="/admin/providers" className="font-medium text-accent-text underline" data-testid="guest-ai-add-account">{t('guest.ai.addAccount')}</Link>
                </p>
              )}
              {m === 'team' && value.mode === 'team' && !noAccount && (
                <div className="grid gap-3 pt-1 pb-2 pl-7 sm:grid-cols-[minmax(0,1fr)_9rem]" data-testid="guest-ai-team-fields">
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
                </div>
              )}
            </div>
          )
        })}
      </div>
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

/** The plan's guest cap was reached (409 plan_limit reason guest_limit): how many, and the plan page when given. */
export function guestCap(e: unknown): { n: number; manageUrl?: string } | null {
  if (!isApiError(e, 'plan_limit') || e.body.params?.reason !== GUEST_LIMIT || typeof e.body.params.limit !== 'number') return null
  const url = e.body.params.manageUrl
  return { n: e.body.params.limit, ...(typeof url === 'string' && /^https?:\/\//.test(url) ? { manageUrl: url } : {}) }
}

/** Words for a refused guest change: the plan's guest cap in the owner's words, else the server's. */
export function guestErrorText(e: unknown, locale: ReturnType<typeof useLocale>, t: ReturnType<typeof useT>): string {
  if (isApiError(e, 'plan_limit') && e.body.params?.reason === GUEST_LIMIT && typeof e.body.params.limit === 'number') return t('guest.limit', { n: e.body.params.limit })
  return errorText(e, locale, t('error.network'))
}

/** The plan's guest cap now (GET /api/guest-invites/limit), read once when a dialog opens; undefined while it loads,
 * null when it could not be read (the dialog goes on: the server still refuses with 409 guest_limit). A store app never
 * shows a plan page. */
export function useGuestLimit(): GuestInviteLimit | null | undefined {
  const [v, setV] = useState<GuestInviteLimit | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    api.call(API.guestInviteLimit).then((r) => {
      if (!live) return
      const { manageUrl, ...rest } = r
      setV({ ...rest, ...(manageUrl && /^https?:\/\//.test(manageUrl) && !noPurchaseLinks() ? { manageUrl } : {}) })
    }, () => live && setV(null))
    return () => { live = false }
  }, [])
  return v
}

/** The plan's guests are all there: said at the top in place of the form. The owner and admins: what they can do and
 * "See plans" (when the server names a plan page); a member: ask an admin. */
function GuestsFull({ n, admin }: { n: number; admin: boolean }) {
  const t = useT()
  return (
    <div className="space-y-2" role="status" data-testid="guest-invite-full">
      <p className="text-sm leading-6 font-medium break-keep text-ink">{t('guest.full', { n })}</p>
      <p className="text-sm leading-6 break-keep text-muted" data-testid="guest-invite-full-next">{t(admin ? 'guest.fullAdmin' : 'guest.fullMember')}</p>
    </div>
  )
}

/** `onCancel`: Cancel and × before the link is made (back to the add list it was opened from); `onClose`: Done after it. */
export function GuestInviteDialog({ place, onClose, onCancel = onClose }: { place: InvitePlace; onClose: () => void; onCancel?: () => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const admin = isAdmin(me)
  const [name, setName] = useState('')
  const [ai, setAi] = useState<GuestAiChoice>({ mode: 'none' })
  // the team's AI accounts, read at once for the owner and admins: without one, Team AI is off before anyone picks it
  const connections = useTeamConnections(admin)
  const limit = useGuestLimit()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  // the plan's guests are all there: read when the dialog opens, or told by a refused Create link (409 plan_limit
  // reason guest_limit, another invite made meanwhile); the plan page only for the owner and admins (a store app's
  // answer has none: lib/api.ts storeSafeError)
  const [refusedFull, setRefusedFull] = useState<{ n: number; manageUrl?: string } | null>(null)
  const full = refusedFull ?? (limit?.full && limit.limit !== null ? { n: limit.limit, ...(limit.manageUrl ? { manageUrl: limit.manageUrl } : {}) } : null)
  const create = async () => {
    if (busy || !aiChoiceReady(ai) || full) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.call(API.createGuestInvite, { body: { place: { kind: place.kind, id: place.id }, ai, ...(name.trim() ? { name: name.trim() } : {}) } })
      setUrl(absoluteUrl(r.url))
    } catch (e) {
      const cap = guestCap(e)
      if (cap) setRefusedFull({ n: cap.n, ...(cap.manageUrl && !noPurchaseLinks() ? { manageUrl: cap.manageUrl } : {}) })
      else setError(guestErrorText(e, locale, t))
    } finally {
      setBusy(false)
    }
  }
  const who = name.trim()
  if (url) return <GuestLinkReady url={url} who={who} onClose={onClose} />
  // the plan is full: the limit at the top and nothing to fill in
  if (full)
    return (
      <Modal
        open
        onClose={onCancel}
        title={t('guest.invite.title')}
        width={440}
        footer={
          <>
            <Button variant={admin && full.manageUrl ? 'ghost' : 'primary'} onClick={onCancel} data-testid="guest-invite-full-close">{t('common.close')}</Button>
            {admin && full.manageUrl && (
              <a href={full.manageUrl} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center justify-center rounded-lg bg-accent px-3.5 text-sm font-medium text-accent-ink hover:bg-accent-hover max-md:min-h-11" data-testid="guest-invite-plans">
                {t('guest.seePlans')}
              </a>
            )}
          </>
        }
      >
        <GuestsFull n={full.n} admin={admin} />
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
          <Button variant="primary" busy={busy} disabled={!aiChoiceReady(ai) || limit === undefined} onClick={() => void create()} data-testid="guest-invite-create">{t('guest.invite.create')}</Button>
        </>
      }
    >
      {limit === undefined ? <Skeleton lines={4} /> : (
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
      )}
    </Modal>
  )
}

/** The one-time link, made: the address, and "Copy link" as the dialog's main button (Done beside it). */
function GuestLinkReady({ url, who, onClose }: { url: string; who: string; onClose: () => void }) {
  const t = useT()
  const { copied, copy } = useCopy()
  return (
    <Modal
      open
      onClose={onClose}
      title={who ? t('guest.invite.readyFor', { name: who }) : t('guest.invite.ready')}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} data-testid="guest-invite-done">{t('common.done')}</Button>
          <Button variant="primary" onClick={() => void copy(url)} data-testid="guest-invite-copy">{copied ? t('common.copied') : t('members.copyLink')}</Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="guest-invite-ready">
        <code className="block rounded-lg border border-line bg-subtle px-3 py-2 font-mono text-sm break-all select-all" data-testid="guest-invite-url">{url}</code>
        <p className="text-sm break-keep text-muted">{t('guest.invite.once')}</p>
        <LocalLinkNote url={url} />
      </div>
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

/** A guest of the add list who is in another place already (Person.guestPlace): their one place, or null for anyone
 * else and for a guest of `here` (already in it). */
export function guestElsewhere(p: Pick<Person, 'guest' | 'guestPlace'>, here?: { kind: PlaceKind; id: string }): GuestPlaceView | null {
  if (!p.guest || !p.guestPlace) return null
  return here && p.guestPlace.kind === here.kind && p.guestPlace.id === here.id ? null : p.guestPlace
}

/** The words of a greyed-out guest's row: "In the 'Quote prep' room" (or project). */
export function elsewhereText(t: ReturnType<typeof useT>, place: GuestPlaceView): string {
  return place.name ? t(place.kind === 'room' ? 'guest.inRoom' : 'guest.inProject', { place: place.name }) : t('guest.onePlaceShort')
}

/** For the owner and admins, on a greyed-out guest's row: "Make team member", which opens the guest's row in Admin. */
export function MakeMemberButton({ guestId }: { guestId: string }) {
  const t = useT()
  const navigate = useNavigate()
  return (
    <Button size="sm" onClick={() => navigate(guestAdminPath(guestId))} data-testid="guest-elsewhere-convert">
      {t('guest.makeMember')}
    </Button>
  )
}

/** The add list's guests who are in another place already, by participant key (`user:<id>`), for ParticipantPicker's
 * `unavailable`: where they are, and "Make team member" for the owner and admins. */
export function useGuestsElsewhere(here: { kind: PlaceKind; id: string }): ReadonlyMap<string, { text: string; action?: ReactNode }> {
  const t = useT()
  const admin = isAdmin(useMe())
  const people = usePeopleList()
  return useMemo(() => {
    const m = new Map<string, { text: string; action?: ReactNode }>()
    for (const p of people ?? []) {
      const away = guestElsewhere(p, here)
      if (away) m.set(`user:${p.id}`, { text: elsewhereText(t, away), ...(admin ? { action: <MakeMemberButton guestId={p.id} /> } : {}) })
    }
    return m
  }, [people, here.kind, here.id, admin, t]) // eslint-disable-line react-hooks/exhaustive-deps
}
