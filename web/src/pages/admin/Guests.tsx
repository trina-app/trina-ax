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
import { ArrowUpCircle, Bot, Trash2, UserRoundX } from 'lucide-react'
import clsx from 'clsx'
import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Credential, GuestAiChoice, User } from '@mycel/shared/api'
import { api, API, isApiError } from '../../lib/api'
import { userGuest } from '../../lib/guests'
import { useLocale, useT } from '../../i18n'
import { isAdmin, useMeStrict } from '../../store/session'
import { toast } from '../../store/ui'
import { Avatar } from '../../components/Avatar'
import { ListRow } from '../../components/list/List'
import { Button, Modal, Skeleton, confirmDialog } from '../../components/ui'
import { aiChoiceReady, GuestAiChoices, guestErrorText, useGuestLimit, useTeamConnections } from '../../components/GuestInvite'
import { MemberMenu, type MemberMenuItem } from './RowMenu'
import { OneLine, useAction } from './common'

/** "Team AI · Main Claude · up to $20 a month", "No AI", "Their own sign-in" */
function aiWords(t: ReturnType<typeof useT>, ai: GuestAiChoice | null, connections: readonly Credential[] | null | undefined): string | null {
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
  // removed guests (their account off) are out of sight until asked for; the one an inbox entry points at shows anyway
  const [showRemoved, setShowRemoved] = useState(false)
  const scrolled = useRef<string | null>(null)
  const focusRow = useCallback((el: HTMLElement | null) => {
    if (!el || scrolled.current === focusId) return
    scrolled.current = focusId
    el.scrollIntoView?.({ block: 'center' })
  }, [focusId])
  if (!isAdmin(me)) return null

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
    : [{ label: t('common.delete'), icon: <Trash2 size={14} aria-hidden />, onSelect: () => onDelete(u), danger: true, testId: `guest-delete-${u.username}` }]

  const removedCount = guests.filter((u) => u.status !== 'active' && u.id !== focusId).length
  const sorted = [...guests]
    .filter((u) => showRemoved || u.status === 'active' || u.id === focusId)
    .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || a.name.localeCompare(b.name))
  return (
    <section id="guests" className="mb-8 scroll-mt-16" aria-labelledby="guests-title" data-testid="guests-section">
      <h2 id="guests-title" className="text-title-sm font-semibold">{t('guest.admin.title')}</h2>
      <OneLine className="mt-0.5 mb-2 text-xs text-muted">{t('guest.admin.desc')}</OneLine>
      {!sorted.length ? (
        <p className="border-y border-line py-4 text-sm text-faint" data-testid="guests-none">{filtered ? t('members.noMatch') : removedCount ? t('guest.admin.noneActive') : t('guest.admin.none')}</p>
      ) : (
        <ul data-testid="guests-list">
          {sorted.map((u) => {
            const g = userGuest(u)
            const where = g?.place?.name ? t(g.place.kind === 'room' ? 'guest.admin.room' : 'guest.admin.project', { place: g.place.name }) : null
            const meta = [where, aiWords(t, g?.ai ?? null, connections), u.status === 'disabled' ? t('members.disabled') : null].filter(Boolean).join(' · ')
            return (
              <ListRow
                key={u.id}
                face
                scale="page"
                icon={<Avatar user={u} size="fill" />}
                name={u.name}
                meta={meta || u.username}
                testId={`guest-row-${u.username}`}
                li={{ ref: u.id === focusId ? focusRow : undefined, className: clsx(u.status === 'disabled' && 'opacity-60', u.id === focusId && 'rounded-lg bg-accent-soft') }}
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
      {converting && <ConvertDialog user={converting} onClose={() => setConverting(null)} onDone={onChanged} />}
    </section>
  )
}

/** "AI for Alex": the same three choices as the invite, saved at once. */
function GuestAiDialog({ user, onClose, onSaved }: { user: User; onClose: () => void; onSaved: () => Promise<void> | void }) {
  const t = useT()
  const locale = useLocale()
  const [ai, setAi] = useState<GuestAiChoice>(() => userGuest(user)?.ai ?? { mode: 'none' })
  // read at once: without a team AI account, Team AI is off before anyone picks it
  const connections = useTeamConnections(true)
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
        <GuestAiChoices value={ai} onChange={setAi} admin connections={connections} legend={false} />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  )
}

/** "Make Alex a team member?": the seats are read first; with every seat taken it says so, with "See plans" (when the
 * server names a plan page), and there is nothing to confirm. A refusal after Confirm (the last seat taken meanwhile)
 * turns it into the same. */
function ConvertDialog({ user, onClose, onDone }: { user: User; onClose: () => void; onDone: () => Promise<void> | void }) {
  const t = useT()
  const locale = useLocale()
  const limit = useGuestLimit()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refused, setRefused] = useState(false)
  const full = refused || !!limit?.seatsFull
  const plans = limit?.manageUrl
  const convert = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.call(API.convertGuest, { params: { id: user.id } })
      toast({ level: 'success', text: t('guest.admin.converted', { name: user.name }) })
      onClose()
      await onDone()
      // their row is in the members' list now
      navigate(`/admin/members?member=${encodeURIComponent(user.id)}`, { replace: true })
    } catch (e) {
      if (isApiError(e, 'plan_limit') && e.body.params?.reason === 'seat_limit') setRefused(true)
      else setError(guestErrorText(e, locale, t))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={t('guest.admin.convertTitle', { name: user.name })} width={440}
      footer={full ? (
        <>
          <Button variant={plans ? 'ghost' : 'primary'} onClick={onClose}>{t('common.close')}</Button>
          {plans && (
            <a href={plans} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center justify-center rounded-lg bg-accent px-3.5 text-sm font-medium text-accent-ink hover:bg-accent-hover max-md:min-h-11" data-testid="guest-convert-plans">
              {t('guest.seePlans')}
            </a>
          )}
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={busy} disabled={limit === undefined} onClick={() => void convert()} data-testid="guest-convert-confirm">{t('guest.makeMember')}</Button>
        </>
      )}>
      <div className="space-y-2 text-sm leading-6 break-keep" data-testid="guest-convert-dialog">
        {limit === undefined ? <Skeleton lines={2} /> : full ? (
          <p role="status" className="text-ink" data-testid="guest-convert-full">{t('guest.admin.seatsFull')}</p>
        ) : (
          <>
            <p className="text-ink">{t('guest.admin.convertBody')}</p>
            <p className="text-muted" data-testid="guest-convert-ai">{t('guest.admin.convertAi')}</p>
          </>
        )}
        {error && <p role="alert" className="text-danger">{error}</p>}
      </div>
    </Modal>
  )
}
