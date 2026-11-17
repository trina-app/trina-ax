// Admin › Members › Guests (docs/DECISIONS.md "Guests: only what they were invited to"): the people from outside the
// team, each in one group chat and one project at most, who take no seat. A row says who, where they are and their AI; its "…" changes the
// AI (PATCH /api/admin/users/:id/guest-ai), resets their password (a guest has no e-mail: Members' dialog, a temporary
// password to hand over; the sign-in page tells a guest to ask whoever invited them), makes them a team member (POST
// /api/admin/users/:id/convert-guest: takes a seat, 409 plan_limit reason seat_limit when none is free) or removes them
// (their account is turned off: PATCH status disabled; a removed guest's "…" deletes the account for good, as for a
// member). Guests are invited from a room's or a project's "Add people", not here. The members table above leaves them
// out. ?member=<id> marks and scrolls to a guest's row too (a refused "add to a second place" opens it: GuestInvite.tsx).
// Over the list, one team setting: the largest file a guest may upload (GuestFileLimit; 100 MB or 1 GB, never above a member's 1 GB).
// Removed guests stay out of sight behind "Show removed (N)". "Make team member" reads the seats before its dialog
// (GET /api/guest-invites/limit): with every seat taken the dialog says so, with "See plans", and has nothing to confirm.
// Its words say that their AI then follows the team's settings, like any member's (the guest AI choice ends).
// The title says how many guests there are against the plan's cap ("3 of 10 guests", GET /api/guest-invites/limit; "3
// guests" with no cap), in the warning colour with one plain line when a lowered plan has fewer places than guests
// (nobody is removed: only new invites wait). A removed guest's "…" switches them back on while their place is there
// (their row says why not otherwise: left it, its project in the trash, or gone), makes them a team member (switched on
// with it) or deletes the account. A switch-on the server refuses (409 guest_no_place) says why, with Make team member.
// Guests who left on their own read "Left" and those taken out or removed "Removed" (User.guest.leftThemselves), and
// the toggle names which of the two it shows. A guest whose project is in the trash stays with the active ones, with
// Restore project (restoring brings them back); the count beside the title is the active ones, as the plan counts them.
import { ArrowUpCircle, Bot, KeyRound, RotateCcw, Trash2, UserRoundX } from 'lucide-react'
import clsx from 'clsx'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { GUEST_FILE_DEFAULT, GUEST_FILE_MAX, type Credential, type GuestAiChoice, type GuestFileMax, type Locale, type User } from '@mycel/shared/api'
import { api, API, isApiError } from '../../lib/api'
import { GUEST_NO_PLACE, guestRowState, trashedProjectOf, userGuest, type GuestPlaceOut, type GuestPlaceOutView, type GuestPlaceView } from '../../lib/guests'
import { useLocale, useT } from '../../i18n'
import { isAdmin, useMeStrict } from '../../store/session'
import { toast } from '../../store/ui'
import { Avatar } from '../../components/Avatar'
import { ListRow } from '../../components/list/List'
import { Button, Modal, Skeleton, confirmDialog, inputCls } from '../../components/ui'
import { formatMonthDay, formatNumber, formatSize, formatUsd } from '../../lib/format'
import { aiChoiceReady, ConvertGuestDialog, GuestAiChoices, guestErrorText, useGuestLimit, useTeamConnections } from '../../components/GuestInvite'
import { MemberMenu, type MemberMenuItem } from './RowMenu'
import { OneLine, useAction } from './common'

/** A removed guest's row is dimmed; while its "…" menu is open (focus inside) it is not, and sits above the rows after
 * it: a dimmed row is a stacking context of its own, which the next row's covered the menu with. */
const REMOVED_ROW = 'opacity-60 focus-within:relative focus-within:z-10 focus-within:opacity-100'

/** "Team AI · up to 5M tokens a month · 3.2M left · Main Claude", "No AI", "Their own sign-in"; Team AI whose account was
 * deleted says so. A guest given Team AI before tokens: "up to $20 a month", as it is until an admin changes it. Used up:
 * the row says "AI limit used up" right after where they are (never cut on a phone), and no "left". */
function aiWords(t: ReturnType<typeof useT>, locale: Locale, g: NonNullable<ReturnType<typeof userGuest>>, connections: readonly Credential[] | null | undefined): string | null {
  const ai = g.ai
  if (g.aiGone) return t('guest.admin.aiGone')
  if (!ai) return null
  if (ai.mode !== 'team') return t(`guest.ai.${ai.mode}`)
  const label = connections?.find((c) => c.id === ai.credentialId)?.label
  // rounded down: 4.96M left never reads "5M left" next to "up to 5M"
  const compact = (n: number) => formatNumber(n, locale, { notation: 'compact', maximumFractionDigits: 1, roundingMode: 'floor' })
  const limit = ai.limitTokens ? t('guest.admin.upTo', { amount: compact(ai.limitTokens) }) : ai.limitUsd ? t('guest.admin.upToUsd', { amount: formatUsd(ai.limitUsd, locale) }) : null
  const left = g.aiUsedUp ? null : ai.limitTokens && g.aiUse ? t('guest.admin.left', { n: compact(Math.max(0, ai.limitTokens - g.aiUse.usedTokens)) }) : null
  // the limit and what is left before the account's name: a phone's row shows two lines, and the account is the part
  // that may be cut (QA TC-3310)
  return [t('guest.ai.team'), limit, left, label].filter(Boolean).join(' · ')
}

/** The largest file a guest may upload, in a chat, their project's folder or an AI chat (TeamSettings.guestFileMax; docs/decisions/
 * 20261116-guest-room-file-limit.md): 100 MB unless the owner or an admin picks more, saved as it is picked. Members
 * are not held to it. One line over the guests' list, the team's only setting about all guests. */
export function GuestFileLimit() {
  const t = useT()
  const locale = useLocale()
  const act = useAction()
  const [value, setValue] = useState<GuestFileMax | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let alive = true
    void api.call(API.settings).then((s) => { if (alive) setValue(s.guestFileMax ?? GUEST_FILE_DEFAULT) }, () => {})
    return () => { alive = false }
  }, [])
  if (value === null) return null
  const pick = async (next: GuestFileMax) => {
    if (saving) return
    const before = value
    setValue(next)
    setSaving(true)
    const r = await act(() => api.call(API.updateSettings, { body: { guestFileMax: next } }), t('common.saved'))
    setSaving(false)
    if (!r) setValue(before)
  }
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm" data-testid="guest-file-limit">
      <label htmlFor="guest-file-max">{t('guest.admin.fileLimit')}</label>
      <select id="guest-file-max" className={clsx(inputCls, 'w-auto min-w-28')} value={value} aria-busy={saving || undefined} onChange={(e) => void pick(e.target.value as GuestFileMax)} data-testid="guest-file-max">
        {(Object.keys(GUEST_FILE_MAX) as GuestFileMax[]).map((k) => <option key={k} value={k}>{formatSize(GUEST_FILE_MAX[k], locale)}</option>)}
      </select>
    </div>
  )
}

export function GuestsSection({ guests, filtered = false, connections, focusId, onChanged, onDelete, onResetPassword, deletionRequested = [], deletionDue = {} }: {
  guests: User[]
  /** the page's search narrowed `guests`: "No match" instead of "No guests yet" */
  filtered?: boolean
  /** the team's AI accounts (Members reads them already), for a team AI's name */
  connections: readonly Credential[] | null | undefined
  focusId: string | null
  onChanged: () => Promise<void> | void
  /** delete a removed guest's account for good (Members' own delete, with its confirm or password) */
  onDelete: (u: User) => void
  /** reset an active guest's password (Members' own dialog: a temporary password to hand over; a guest has no e-mail to ask by) */
  onResetPassword: (u: User) => void
  /** ids who asked to delete their account, and when it happens (GET /api/admin/users): said in the row, like the red mark of a member */
  deletionRequested?: readonly string[]
  deletionDue?: Record<string, string>
}) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const act = useAction()
  const [aiFor, setAiFor] = useState<User | null>(null)
  const [converting, setConverting] = useState<User | null>(null)
  const [noPlace, setNoPlace] = useState<{ user: User; out: GuestPlaceOut } | null>(null)
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
  // their project back from the trash (POST /api/projects/:id/restore, the owner or an admin): the server switches
  // the guest on with it (admin/guests.ts returnGuestsWithPlace), within the plan's guests
  const restore = async (projectId: string, place: string) => {
    if (await act(() => api.call(API.restoreProject, { params: { id: projectId } }), t('guest.admin.projectRestored', { place }))) await onChanged()
  }
  const remove = async (u: User) => {
    if (!(await confirmDialog({ title: t('guest.admin.removeTitle', { name: u.name }), body: t('guest.admin.removeBody'), confirm: t('guest.admin.remove'), danger: true }))) return
    if (await act(() => api.call(API.updateUser, { params: { id: u.id }, body: { status: 'disabled' } }), t('guest.admin.removed', { name: u.name }))) await onChanged()
  }
  // who asked to delete their account (the member row's red mark, as words in the second line: a phone row has no room for a badge)
  const asked = (u: User) => !deletionRequested.includes(u.id) ? null : deletionDue[u.id] ? t('accountDeletion.badgeDue', { date: formatMonthDay(deletionDue[u.id]!, locale) }) : t('accountDeletion.badge')
  const items = (u: User): MemberMenuItem[] => u.status === 'active'
    ? [
        { label: t('guest.admin.changeAi'), icon: <Bot size={14} aria-hidden />, onSelect: () => setAiFor(u), testId: `guest-ai-${u.username}` },
        { label: t('members.reset'), icon: <KeyRound size={14} aria-hidden />, onSelect: () => onResetPassword(u), testId: `guest-reset-${u.username}` },
        { label: t('guest.makeMember'), icon: <ArrowUpCircle size={14} aria-hidden />, onSelect: () => setConverting(u), testId: `guest-convert-${u.username}` },
        { label: t('guest.admin.remove'), icon: <UserRoundX size={14} aria-hidden />, onSelect: () => void remove(u), danger: true, testId: `guest-remove-${u.username}` },
      ]
    : [
        // only while there is a place to come back to (the row says why not otherwise)
        ...(userGuest(u)?.out ? [] : [{ label: t('guest.admin.switchOn'), icon: <RotateCcw size={14} aria-hidden />, onSelect: () => void switchOn(u), testId: `guest-on-${u.username}` }]),
        { label: t('guest.makeMember'), icon: <ArrowUpCircle size={14} aria-hidden />, onSelect: () => setConverting(u), testId: `guest-convert-${u.username}` },
        { label: t('common.delete'), icon: <Trash2 size={14} aria-hidden />, onSelect: () => onDelete(u), danger: true, testId: `guest-delete-${u.username}` },
      ]

  // behind the toggle: who left on their own and who was taken out or removed (a trashed project's guests stay listed)
  const hidden = (u: User) => { const st = guestRowState(u); return st === 'left' || st === 'removed' }
  const hiddenOnes = guests.filter((u) => hidden(u) && u.id !== focusId)
  const removedCount = hiddenOnes.length
  const anyLeft = hiddenOnes.some((u) => guestRowState(u) === 'left')
  const anyRemoved = hiddenOnes.some((u) => guestRowState(u) === 'removed')
  const toggleKind = anyLeft && anyRemoved ? 'LeftRemoved' : anyLeft ? 'Left' : 'Removed'
  const sorted = [...guests]
    .filter((u) => showRemoved || !hidden(u) || u.id === focusId)
    .sort((a, b) => Number(hidden(a)) - Number(hidden(b)) || a.name.localeCompare(b.name))
  // "3 of 10 guests" (or "3 guests" with no cap): the active ones, as the plan counts them; more than the plan allows
  // (a lowered plan) in the warning colour, with what that means
  // counted from the list on the screen, not from the cap read when the page opened: removing, switching on or
  // converting a guest changes it at once (QA TC-2191)
  const used = guests.filter((u) => u.status === 'active').length
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
      {!filtered && <GuestFileLimit />}
      {!sorted.length ? (
        <p className="border-y border-line py-4 text-sm text-faint" data-testid="guests-none">{filtered ? t('members.noMatch') : removedCount ? t('guest.admin.noneActive') : t('guest.admin.none')}</p>
      ) : (
        <ul data-testid="guests-list">
          {sorted.map((u) => {
            const g = userGuest(u)
            // their group chat and their project, each in its own words (a removed guest's: why they are out of it)
            const where = placesWords(t, g?.places ?? [], g?.out ?? null, g?.leftThemselves ?? false)
            const trashed = trashedProjectOf(g)
            // a removed guest: where they are (or why not) and that they are off, no AI (they cannot use it); the line may
            // take two lines on a phone so the status is never cut
            const state = guestRowState(u)
            const removed = state === 'left' || state === 'removed'
            // their project is in the trash: put it back from here, which brings them back with it
            const restoreBtn = state === 'trashed' && trashed?.id
              ? (suffix: string) => <Button size="sm" variant="secondary" onClick={() => void restore(trashed.id!, trashed.name ?? '')} data-testid={`guest-restore-${u.username}${suffix}`}>{t('guest.admin.restoreProject')}</Button>
              : null
            // a trashed project's guest: where they are and that it is in the trash (no AI: they cannot use it now); one
            // who left on their own: "Left 'Quote prep'" says it all; one taken out or removed: where, then "Removed"
            const active = state === 'active'
            const meta = [where, active && g?.aiUsedUp ? t('guest.admin.aiUsedUp') : null, active && g ? aiWords(t, locale, g, connections) : null, state === 'removed' ? t('guest.admin.removedTag') : null, asked(u)].filter(Boolean).join(' · ')
            return (
              <ListRow
                key={u.id}
                face
                scale="page"
                icon={<Avatar user={u} size="fill" />}
                name={u.name}
                meta={
                  // two lines at most and never cut sideways (a phone's narrow row), and on a phone Restore project
                  // under it: beside the words it left them no room
                  <>
                    <span className="line-clamp-2 whitespace-normal break-words" data-testid={`guest-meta-${u.username}`}>{meta || u.username}</span>
                    {restoreBtn && <span className="mt-1 block p-0.5 md:hidden">{restoreBtn('-mobile')}</span>}
                  </>
                }
                testId={`guest-row-${u.username}`}
                li={{ ref: u.id === focusId ? focusRow : undefined, className: clsx(removed && REMOVED_ROW, u.id === focusId && 'rounded-lg bg-accent-soft') }}
                rowClass={restoreBtn ? 'max-md:items-start' : undefined}
                end={
                  <span className="flex shrink-0 items-center gap-1 self-center">
                    {restoreBtn && <span className="max-md:hidden">{restoreBtn('')}</span>}
                    <MemberMenu name={u.name} items={items(u)} />
                  </span>
                }
              />
            )
          })}
        </ul>
      )}
      {removedCount > 0 && (
        <Button size="sm" variant="ghost" className="mt-1 -ml-2.5" onClick={() => setShowRemoved((v) => !v)} aria-expanded={showRemoved} data-testid="guests-show-removed">
          {showRemoved ? t(`guest.admin.hide${toggleKind}`) : t(`guest.admin.show${toggleKind}`, { n: removedCount })}
        </Button>
      )}
      {aiFor && <GuestAiDialog user={aiFor} onClose={() => setAiFor(null)} onSaved={onChanged} />}
      {converting && <ConvertGuestDialog guest={converting} onClose={() => setConverting(null)} onDone={async () => { await onChanged(); navigate(`/admin/members?member=${encodeURIComponent(converting.id)}`, { replace: true }) }} />}
      {noPlace && <NoPlaceDialog user={noPlace.user} out={noPlace.out} onClose={() => setNoPlace(null)} onConvert={() => { setConverting(noPlace.user); setNoPlace(null) }} />}
    </section>
  )
}

/** A place name at most this long in a guest's row (a phone's two lines also hold the status after it). */
const PLACE_NAME_MAX = 28
/** a letter counts 1, a Korean / Japanese / Chinese character 2 (it is as wide as two) */
const widthOf = (c: string) => (c.codePointAt(0)! >= 0x2e80 ? 2 : 1)
function clipPlaceName(name: string): string {
  const chars = Array.from(name)
  if (chars.reduce((n, c) => n + widthOf(c), 0) <= PLACE_NAME_MAX) return name
  let used = 0
  const out: string[] = []
  for (const c of chars) {
    if (used + widthOf(c) > PLACE_NAME_MAX - 1) return out.join('').trimEnd() + '…'
    used += widthOf(c)
    out.push(c)
  }
  return name
}

/** Where a guest is ("Room · Quote prep"), or for a removed one why they are not there: left it, its project in the
 * trash, or gone (the name of a deleted place is not known any more). */
/** A guest's places on their row: "Group chat · Quote prep · Project · Launch" (a removed guest's each with why they
 * are out of it; "gone" said once). */
export function placesWords(t: ReturnType<typeof useT>, places: readonly GuestPlaceOutView[], out: GuestPlaceOut | null, self = false): string | null {
  if (!places.length) return out === 'gone' ? t('guest.admin.outGone') : null
  const words = [...new Set(places.map((pl) => placeWords(t, pl, pl.out ?? null, self)).filter((w): w is string => !!w))]
  return words.length ? words.join(' · ') : null
}
function placeWords(t: ReturnType<typeof useT>, place: GuestPlaceView | null, out: GuestPlaceOut | null, self = false): string | null {
  if (out === 'gone') return t('guest.admin.outGone')
  // a group chat with no name of its own (the server sends ''): just "Group chat". Its members are left out on purpose: admins
  // do not learn who talks to whom in group chats (docs/DECISIONS.md). Only while the guest is in it: what they left has no name to say
  if (place?.kind === 'room' && !place.name?.trim()) return out ? null : t('guest.admin.groupChat')
  if (!place?.name) return null
  // a very long name is shortened here, so the words after it ("in the trash", "Disabled") are never the part that is cut
  const name = clipPlaceName(place.name)
  if (out === 'trashed') return t('guest.admin.outTrashed', { place: name })
  if (out === 'left') return t(self ? 'guest.admin.outLeftSelf' : 'guest.admin.outLeft', { place: name })
  return t(place.kind === 'room' ? 'guest.admin.room' : 'guest.admin.project', { place: name })
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
  // the team's tokens per answer, for the limit's "about N answers"
  // read before the choices show, as the invite dialog does: "about N answers" never starts from the default and then
  // jumps to the team's own number (QA TC-3310)
  const limit = useGuestLimit()
  const answerTokens = limit?.answerTokens
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
        {limit === undefined ? <Skeleton lines={4} /> : <GuestAiChoices value={ai} onChange={setAi} admin connections={connections} noGuestAi={noGuestAi} legend={false} answerTokens={answerTokens} />}
        <p className="text-xs leading-5 break-keep text-muted" data-testid="guest-ai-now">{t('guest.admin.aiNow', { name: user.name })}</p>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  )
}
