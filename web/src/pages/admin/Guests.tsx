// Admin › Members › Guests (docs/DECISIONS.md "Guests: only what they were invited to"): the people from outside the
// team, each in one room or project, who take no seat. A row says who, where they are and their AI; its "…" changes the
// AI (PATCH /api/admin/users/:id/guest-ai), makes them a team member (POST
// /api/admin/users/:id/convert-guest: takes a seat, 409 plan_limit reason seat_limit when none is free) or removes them
// (their account is turned off: PATCH status disabled; a removed guest's "…" deletes the account for good, as for a
// member). Guests are invited from a room's or a project's "Add people", not here. The members table above leaves them
// out. ?member=<id> marks and scrolls to a guest's row too (a refused "add to a second place" opens it: GuestInvite.tsx).
// Removed guests stay out of sight behind "Show removed (N)". "Make team member" reads the seats before its dialog
// (GET /api/guest-invites/limit): with every seat taken the dialog says so, with "See plans", and has nothing to confirm.
// Its words say that their AI then follows the team's settings, like any member's (the guest AI choice ends).
// The title says how many guests there are against the plan's cap ("3 of 10 guests", GET /api/guest-invites/limit; "3
// guests" with no cap), in the warning colour with one plain line when a lowered plan has fewer places than guests
// (nobody is removed: only new invites wait). A removed guest's "…" switches them back on while their place is there
// (their row says why not otherwise: left it, its project in the trash, or gone), makes them a team member (switched on
// with it) or deletes the account. A switch-on the server refuses (409 guest_no_place) says why, with Make team member.
import { ArrowUpCircle, Bot, RotateCcw, Trash2, UserRoundX } from 'lucide-react'
import clsx from 'clsx'
import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Credential, GuestAiChoice, User } from '@mycel/shared/api'
import { api, API, isApiError } from '../../lib/api'
import { GUEST_NO_PLACE, userGuest, type GuestPlaceOut } from '../../lib/guests'
import { useLocale, useT } from '../../i18n'
import { isAdmin, useMeStrict } from '../../store/session'
import { toast } from '../../store/ui'
import { Avatar } from '../../components/Avatar'
import { ListRow } from '../../components/list/List'
import { Button, Modal, confirmDialog } from '../../components/ui'
import { aiChoiceReady, ConvertGuestDialog, GuestAiChoices, guestErrorText, useGuestLimit, useTeamConnections } from '../../components/GuestInvite'
import { MemberMenu, type MemberMenuItem } from './RowMenu'
import { OneLine, useAction } from './common'

/** A removed guest's row is dimmed; while its "…" menu is open (focus inside) it is not, and sits above the rows after
 * it: a dimmed row is a stacking context of its own, which the next row's covered the menu with. */
const REMOVED_ROW = 'opacity-60 focus-within:relative focus-within:z-10 focus-within:opacity-100'

/** "Team AI · Main Claude · up to $20 a month", "No AI", "Their own sign-in"; Team AI whose account was deleted says so */
function aiWords(t: ReturnType<typeof useT>, ai: GuestAiChoice | null, connections: readonly Credential[] | null | undefined, aiGone = false): string | null {
  if (aiGone) return t('guest.admin.aiGone')
  if (!ai) return null
  if (ai.mode !== 'team') return t(`guest.ai.${ai.mode}`)
  const label = connections?.find((c) => c.id === ai.credentialId)?.label
  return [t('guest.ai.team'), label, `$${ai.limitUsd}`].filter(Boolean).join(' · ')
}

export function GuestsSection({ guests, filtered = false, connections, focusId, onChanged, onDelete }: {
  guests: User[]
  /** the page's search narrowed `guests`: "No match" instead of "No guests yet" */
  filtered?: boolean
  /** the team's AI accounts (Members reads them already), for a team AI's name */
  connections: readonly Credential[] | null | undefined
  focusId: string | null
  onChanged: () => Promise<void> | void
  /** delete a removed guest's account for good (Members' own delete, with its confirm or password) */
  onDelete: (u: User) => void
}) {
  const t = useT()
  const me = useMeStrict()
  const act = useAction()
  const [aiFor, setAiFor] = useState<User | null>(null)
  const [converting, setConverting] = useState<User | null>(null)
  const [noPlace, setNoPlace] = useState<{ user: User; out: GuestPlaceOut } | null>(null)
  const locale = useLocale()
  // the plan's guest cap and how many are active now, for the title (owner and admins: GuestInviteLimit.used)
  const limit = useGuestLimit()
  const navigate = useNavigate()
  // removed guests (their account off) are out of sight until asked for; the one an inbox entry points at shows anyway
  const [showRemoved, setShowRemoved] = useState(false)
  const scrolled = useRef<string | null>(null)
  const focusRow = useCallback((el: HTMLElement | null) => {
    if (!el || scrolled.current === focusId) return
    scrolled.current = focusId
    el.scrollIntoView?.({ block: 'center' })
  }, [focusId])
  if (!isAdmin(me)) return null

  const switchOn = async (u: User) => {
    try {
      await api.call(API.updateUser, { params: { id: u.id }, body: { status: 'active' } })
      toast({ level: 'success', text: t('guest.admin.switchedOn', { name: u.name }) })
      await onChanged()
    } catch (e) {
      // nothing to bring them back to (their place went meanwhile): why, and the way that works
      if (isApiError(e, 'conflict') && e.body.params?.reason === GUEST_NO_PLACE) {
        const out = e.body.params.placeOut
        setNoPlace({ user: u, out: out === 'left' || out === 'trashed' ? out : 'gone' })
      } else toast({ level: 'error', text: guestErrorText(e, locale, t) })
    }
  }
  const remove = async (u: User) => {
    if (!(await confirmDialog({ title: t('guest.admin.removeTitle', { name: u.name }), body: t('guest.admin.removeBody'), confirm: t('guest.admin.remove'), danger: true }))) return
    if (await act(() => api.call(API.updateUser, { params: { id: u.id }, body: { status: 'disabled' } }), t('guest.admin.removed', { name: u.name }))) await onChanged()
  }
  const items = (u: User): MemberMenuItem[] => u.status === 'active'
    ? [
        { label: t('guest.admin.changeAi'), icon: <Bot size={14} aria-hidden />, onSelect: () => setAiFor(u), testId: `guest-ai-${u.username}` },
        { label: t('guest.makeMember'), icon: <ArrowUpCircle size={14} aria-hidden />, onSelect: () => setConverting(u), testId: `guest-convert-${u.username}` },
        { label: t('guest.admin.remove'), icon: <UserRoundX size={14} aria-hidden />, onSelect: () => void remove(u), danger: true, testId: `guest-remove-${u.username}` },
      ]
    : [
        // only while there is a place to come back to (the row says why not otherwise)
        ...(userGuest(u)?.out ? [] : [{ label: t('guest.admin.switchOn'), icon: <RotateCcw size={14} aria-hidden />, onSelect: () => void switchOn(u), testId: `guest-on-${u.username}` }]),
        { label: t('guest.makeMember'), icon: <ArrowUpCircle size={14} aria-hidden />, onSelect: () => setConverting(u), testId: `guest-convert-${u.username}` },
        { label: t('common.delete'), icon: <Trash2 size={14} aria-hidden />, onSelect: () => onDelete(u), danger: true, testId: `guest-delete-${u.username}` },
      ]

  const removedCount = guests.filter((u) => u.status !== 'active' && u.id !== focusId).length
  const sorted = [...guests]
    .filter((u) => showRemoved || u.status === 'active' || u.id === focusId)
    .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || a.name.localeCompare(b.name))
  // "3 of 10 guests" (or "3 guests" with no cap): the active ones, as the plan counts them; more than the plan allows
  // (a lowered plan) in the warning colour, with what that means
  const used = limit?.used ?? guests.filter((u) => u.status === 'active').length
  const cap = limit ? limit.limit : undefined
  const over = typeof cap === 'number' && used > cap
  return (
    <section id="guests" className="mb-8 scroll-mt-16" aria-labelledby="guests-title" data-testid="guests-section">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h2 id="guests-title" className="text-title-sm font-semibold">{t('guest.admin.title')}</h2>
        {limit !== undefined && !filtered && (
          <span className={clsx('text-sm tabular-nums', over ? 'font-medium text-warn' : 'text-muted')} data-testid="guests-count" data-over={over || undefined}>
            {typeof cap === 'number' ? t('guest.admin.countOf', { n: used, m: cap }) : t('guest.admin.count', { n: used })}
          </span>
        )}
      </div>
      <OneLine className="mt-0.5 mb-2 text-xs text-muted">{t('guest.admin.desc')}</OneLine>
      {over && <p className="mb-2 text-sm leading-6 break-keep text-warn" role="status" data-testid="guests-over">{t('guest.admin.over', { m: cap })}</p>}
      {!sorted.length ? (
        <p className="border-y border-line py-4 text-sm text-faint" data-testid="guests-none">{filtered ? t('members.noMatch') : removedCount ? t('guest.admin.noneActive') : t('guest.admin.none')}</p>
      ) : (
        <ul data-testid="guests-list">
          {sorted.map((u) => {
            const g = userGuest(u)
            const where = placeWords(t, g?.place ?? null, g?.out ?? null)
            const meta = [where, aiWords(t, g?.ai ?? null, connections, g?.aiGone), u.status === 'disabled' ? t('members.disabled') : null].filter(Boolean).join(' · ')
            return (
              <ListRow
                key={u.id}
                face
                scale="page"
                icon={<Avatar user={u} size="fill" />}
                name={u.name}
                meta={meta || u.username}
                testId={`guest-row-${u.username}`}
                li={{ ref: u.id === focusId ? focusRow : undefined, className: clsx(u.status === 'disabled' && REMOVED_ROW, u.id === focusId && 'rounded-lg bg-accent-soft') }}
                end={<MemberMenu name={u.name} items={items(u)} />}
              />
            )
          })}
        </ul>
      )}
      {removedCount > 0 && (
        <Button size="sm" variant="ghost" className="mt-1 -ml-2.5" onClick={() => setShowRemoved((v) => !v)} aria-expanded={showRemoved} data-testid="guests-show-removed">
          {showRemoved ? t('guest.admin.hideRemoved') : t('guest.admin.showRemoved', { n: removedCount })}
        </Button>
      )}
      {aiFor && <GuestAiDialog user={aiFor} onClose={() => setAiFor(null)} onSaved={onChanged} />}
      {converting && <ConvertGuestDialog guest={converting} onClose={() => setConverting(null)} onDone={async () => { await onChanged(); navigate(`/admin/members?member=${encodeURIComponent(converting.id)}`, { replace: true }) }} />}
      {noPlace && <NoPlaceDialog user={noPlace.user} out={noPlace.out} onClose={() => setNoPlace(null)} onConvert={() => { setConverting(noPlace.user); setNoPlace(null) }} />}
    </section>
  )
}

/** Where a guest is ("Room · Quote prep"), or for a removed one why they are not there: left it, its project in the
 * trash, or gone (the name of a deleted place is not known any more). */
function placeWords(t: ReturnType<typeof useT>, place: { kind: 'room' | 'project'; name?: string } | null, out: GuestPlaceOut | null): string | null {
  if (out === 'gone') return t('guest.admin.outGone')
  if (!place?.name) return null
  if (out === 'trashed') return t('guest.admin.outTrashed', { place: place.name })
  if (out === 'left') return t('guest.admin.outLeft', { place: place.name })
  return t(place.kind === 'room' ? 'guest.admin.room' : 'guest.admin.project', { place: place.name })
}

/** A removed guest who cannot be switched on (409 guest_no_place): why, in plain words, and Make team member (a member
 * needs no place). */
function NoPlaceDialog({ user, out, onClose, onConvert }: { user: User; out: GuestPlaceOut; onClose: () => void; onConvert: () => void }) {
  const t = useT()
  return (
    <Modal open onClose={onClose} title={t('guest.admin.noPlaceTitle', { name: user.name })} width={440}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.close')}</Button><Button variant="primary" onClick={onConvert} data-testid="guest-no-place-convert">{t('guest.makeMember')}</Button></>}>
      <p className="text-sm leading-6 break-keep text-ink" role="status" data-testid="guest-no-place">
        {t(out === 'trashed' ? 'guest.admin.noPlaceTrashed' : out === 'left' ? 'guest.admin.noPlaceLeft' : 'guest.admin.noPlaceGone')}
      </p>
    </Modal>
  )
}

/** "AI for Alex": the same three choices as the invite, saved at once. */
function GuestAiDialog({ user, onClose, onSaved }: { user: User; onClose: () => void; onSaved: () => Promise<void> | void }) {
  const t = useT()
  const locale = useLocale()
  const [ai, setAi] = useState<GuestAiChoice>(() => userGuest(user)?.ai ?? { mode: 'none' })
  // read at once: without a team AI account, Team AI is off before anyone picks it
  const { list: connections, noGuestAi } = useTeamConnections(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    if (busy || !aiChoiceReady(ai)) return
    setBusy(true)
    setError(null)
    try {
      await api.call(API.updateGuestAi, { params: { id: user.id }, body: ai })
      toast({ level: 'success', text: t('guest.admin.saved') })
      await onSaved()
      onClose()
    } catch (e) {
      setError(guestErrorText(e, locale, t))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={t('guest.admin.aiTitle', { name: user.name })} width={440}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} disabled={!aiChoiceReady(ai)} onClick={() => void save()} data-testid="guest-ai-save">{t('common.save')}</Button></>}>
      <div className="space-y-3" data-testid="guest-ai-dialog">
        {/* the dialog's title says "AI for Alex": no second heading over the choices */}
        <GuestAiChoices value={ai} onChange={setAi} admin connections={connections} noGuestAi={noGuestAi} legend={false} />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  )
}
