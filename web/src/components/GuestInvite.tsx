// "Invite a guest" (docs/DECISIONS.md "Guests: only what they were invited to"): the row at the top of a group chat's
// and a project's "Add people" lists, and the small dialog it opens: their name, the AI choice (off by default; the
// owner and admins also see "Team AI", a team AI account with a monthly limit), "Create link", then the one-time link
// with Copy. POST /api/guest-invites; the server checks who may invite into this place and the plan's guest cap (409
// plan_limit reason guest_limit: "Guests: up to N", never a word about seats). The cap is read when the dialog opens
// (GET /api/guest-invites/limit): a full plan says so at the top in place of the form, with "See plans" for the owner
// and admins and "Ask an admin" for members.
// The AI choice (GuestAiChoices) is the same control Admin › Members › Guests uses to change it later. Team AI's own
// fields (the account, the monthly limit in tokens: a few presets or another amount, with "about N answers" next to
// it) sit right under it; without a team AI account it is off, with "Add an AI account".
// A guest already in another place is greyed out in the add lists (GuestElsewhere: "In 'Quote prep'", no tick), with
// "Make team member" for the owner and admins.
import { Check, Copy, UserRoundPlus } from 'lucide-react'
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { GUEST_TOKENS_MAX, type Credential, type GuestAiChoice, type GuestAiChoiceBody, type GuestInviteLimit, type Locale, type Person } from '@mycel/shared/api'
import { DEFAULT_TOKENS_PER_ANSWER, GUEST_TOKEN_PRESETS, GUEST_TOKENS_DEFAULT, answersFor } from '@mycel/shared'
import { api, API, errorText, isApiError } from '../lib/api'
import { GUEST_LIMIT, GUEST_ONE_PLACE, type GuestPlaceView, type PlaceKind } from '../lib/guests'
import { noPurchaseLinks } from '../lib/desktop'
import { formatDateTime, formatNumber, formatUsd } from '../lib/format'
import { useLocale, useT } from '../i18n'
import { useNavigate } from 'react-router-dom'
import { isAdmin, useMe } from '../store/session'
import { usePeople, usePeopleList } from '../store/people'
import { Button, Field, inputCls, Modal, Skeleton, useCopy } from './ui'
import { projectSkillsOn } from '../lib/bulkFiles'
import { aiName } from '../lib/tabs'
import { useProjects } from '../store/projects'
import { toast } from '../store/ui'
import { ListRow } from './list/List'
import { LocalLinkNote } from './LocalLinkNote'
import { absoluteUrl } from './handover/LeadInvite'
import { namedProduct } from '../lib/tabs'

/** `personal`: one of my personal projects (GuestInviteChoice.tsx mayShareForGuest), shared before the link is made.
 * `privateChannel`: a room with a name of its own (lib/rooms.ts isPrivateChannel), worded as a private channel; a room
 * without one is a group DM, worded as a group chat (`name` is then its people's names). */
export interface InvitePlace { kind: PlaceKind; id: string; name: string; personal?: true; privateChannel?: boolean }

/** The row of an "Add people" list that opens the dialog (a ListRow, face box, like the room info's 초대하기). `any`: the
 * "New conversation" list's, which picks the place first (GuestInviteChoice.tsx GuestInviteFlow). */
export function InviteGuestRow({ place, onOpen, privateRoom = false }: { place: PlaceKind | 'any'; onOpen: () => void; privateRoom?: boolean }) {
  const t = useT()
  return (
    <ListRow
      onClick={onOpen}
      face
      icon={<UserRoundPlus />}
      name={<span className="text-ink">{t('guest.invite.row')}</span>}
      // `privateRoom`: the room is a private channel (a named group room), and its words say so
      meta={t(place === 'room' ? (privateRoom ? 'guest.invite.rowRoomPrivate' : 'guest.invite.rowRoom') : place === 'project' ? 'guest.invite.rowProject' : 'guest.invite.rowAny')}
      testId="invite-guest-row"
    />
  )
}

/** The guest's AI, as an invite starts it and as an admin changes it: none (default), team (admins), own. `connections`:
 * the team's AI accounts (for team; null while they load). Team AI's account and monthly limit sit right under it; with
 * no team AI account it cannot be picked and says where to add one. `legend`: false where the dialog's title already
 * says it ("AI for Alex"). */
export function GuestAiChoices({ value, onChange, admin, connections, noGuestAi = false, legend = true, answerTokens }: { value: GuestAiChoice; onChange: (v: GuestAiChoice) => void; admin: boolean; connections: Credential[] | null
  /** this server runs its AI on its own sign-in (an Office Mac): a guest gets no AI here, so only No AI can be picked */
  noGuestAi?: boolean; legend?: boolean
  /** the team's tokens per answer (GuestInviteLimit.answerTokens), for "about N answers"; absent: the default */
  answerTokens?: GuestInviteLimit['answerTokens'] }) {
  const t = useT()
  const id = useId()
  const modes = (admin ? ['none', 'team', 'own'] : ['none', 'own']) as GuestAiChoice['mode'][]
  const noAccount = !noGuestAi && !!connections && !connections.length
  // no guest AI on this server: No AI stays picked (a guest whose AI was set before shows No AI here)
  useEffect(() => { if (noGuestAi && value.mode !== 'none') onChange({ mode: 'none' }) }, [noGuestAi]) // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (mode: GuestAiChoice['mode']) => {
    if (mode === value.mode) return
    if (mode === 'team') onChange({ mode, credentialId: connections?.[0]?.id ?? '', limitTokens: GUEST_TOKENS_DEFAULT })
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
          const off = (m === 'team' && noAccount) || (noGuestAi && m !== 'none')
          return (
            <div key={m}>
              {/* a choice that cannot be picked reads as off, not only its radio: faded words too */}
              <label className={off ? 'flex cursor-not-allowed items-start gap-2.5 px-1 py-1.5 opacity-50' : 'flex cursor-pointer items-start gap-2.5 px-1 py-1.5'} aria-disabled={off || undefined} data-off={off || undefined}>
                <input type="radio" name={`${id}-ai`} value={m} checked={value.mode === m} disabled={off} onChange={() => pick(m)} className="mt-0.5 size-4 shrink-0 accent-accent" data-testid={`guest-ai-${m}`} />
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
                <div className="grid gap-3 pt-1 pb-2 pl-7" data-testid="guest-ai-team-fields">
                  <label className="block min-w-0">
                    <span className="mb-1 block text-xs font-medium text-muted">{t('guest.ai.account')}</span>
                    <select className={inputCls} value={value.credentialId} onChange={(e) => onChange({ ...value, credentialId: e.target.value })} disabled={!connections} data-testid="guest-ai-account">
                      {(connections ?? []).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                  </label>
                  <TokenLimit value={value} onChange={onChange} answerTokens={answerTokens} />
                </div>
              )}
            </div>
          )
        })}
      </div>
      {/* a member cannot reinstall the server: only the first sentence (the .pkg way is for whoever runs it) */}
      {noGuestAi && <p className="mt-1 pl-1 text-xs leading-5 break-keep text-muted" data-testid="guest-ai-host">{t(admin ? 'guest.ai.hostSignIn' : 'guest.ai.hostSignInMember')}</p>}
    </fieldset>
  )
}

/** A team mode choice that can be sent: an account picked and a token limit above 0 (an older guest's US dollar limit
 * is shown, but changing Team AI picks tokens). */
export const aiChoiceReady = (v: GuestAiChoice): v is GuestAiChoiceBody => v.mode !== 'team' || (!!v.credentialId && Number.isInteger(v.limitTokens) && v.limitTokens! > 0 && v.limitTokens! <= GUEST_TOKENS_MAX)

/** "5M tokens" / "500만 토큰": a token amount in the reader's words. */
export function tokensText(t: ReturnType<typeof useT>, n: number, locale: Locale): string {
  return t('guest.ai.tokens', { amount: formatNumber(n, locale, { notation: 'compact', maximumFractionDigits: 1 }) })
}

/** "about 60 answers" for `tokens` at the team's tokens per answer (or the default). */
export function answersText(t: ReturnType<typeof useT>, tokens: number, perAnswer: number | undefined): string {
  const n = answersFor(tokens, perAnswer ?? DEFAULT_TOKENS_PER_ANSWER)
  return n > 0 ? t('guest.ai.answers', { n }) : t('guest.ai.answersUnderOne')
}

/** Team AI's monthly limit: the presets and Other (a number of tokens), then "5M tokens · about 60 answers" and what a
 * token is. An older guest's US dollar limit is said as it is, with nothing picked, until a token amount is. */
function TokenLimit({ value, onChange, answerTokens }: { value: Extract<GuestAiChoice, { mode: 'team' }>; onChange: (v: GuestAiChoice) => void; answerTokens?: GuestInviteLimit['answerTokens'] }) {
  const t = useT()
  const locale = useLocale()
  const id = useId()
  const tokens = value.limitTokens
  const [other, setOther] = useState(() => tokens !== undefined && !(GUEST_TOKEN_PRESETS as readonly number[]).includes(tokens))
  const set = (n: number) => onChange({ mode: 'team', credentialId: value.credentialId, limitTokens: n })
  const pick = (v: string) => {
    if (v === 'other') { setOther(true); if (tokens === undefined) set(GUEST_TOKENS_DEFAULT); return }
    setOther(false)
    set(Number(v))
  }
  const ok = tokens !== undefined && Number.isInteger(tokens) && tokens > 0 && tokens <= GUEST_TOKENS_MAX
  return (
    <div className="min-w-0" data-testid="guest-ai-limit-box">
      {value.limitUsd !== undefined && tokens === undefined && (
        <p className="mb-1.5 text-xs leading-5 break-keep text-muted" data-testid="guest-ai-limit-usd">{t('guest.ai.nowUsd', { amount: formatUsd(value.limitUsd, locale) })}</p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block min-w-0">
          <span className="mb-1 block text-xs font-medium text-muted">{t('guest.ai.limit')}</span>
          <select className={inputCls} value={tokens === undefined ? '' : other ? 'other' : String(tokens)} onChange={(e) => pick(e.target.value)} aria-describedby={`${id}-est`} data-testid="guest-ai-limit">
            {tokens === undefined && <option value="" disabled>{'—'}</option>}
            {GUEST_TOKEN_PRESETS.map((n) => <option key={n} value={String(n)}>{tokensText(t, n, locale)}</option>)}
            <option value="other">{t('guest.ai.custom')}</option>
          </select>
        </label>
        {other && (
          <label className="block min-w-0" htmlFor={`${id}-other`}>
            <span className="mb-1 block text-xs font-medium text-muted">{t('guest.ai.customLabel')}</span>
            <input id={`${id}-other`} type="number" inputMode="numeric" min={1} max={GUEST_TOKENS_MAX} step={1} className={inputCls} aria-describedby={`${id}-est`} value={tokens !== undefined && Number.isFinite(tokens) ? tokens : ''}
              onChange={(e) => set(e.target.value === '' ? Number.NaN : Math.round(Number(e.target.value)))} data-testid="guest-ai-limit-other" />
          </label>
        )}
      </div>
      {ok && (
        <p id={`${id}-est`} className="mt-1.5 text-sm text-ink" data-testid="guest-ai-estimate">
          {tokensText(t, tokens, locale)} · {answersText(t, tokens, answerTokens?.tokens)}
        </p>
      )}
      <p className="mt-1 text-xs leading-5 break-keep text-muted" data-testid="guest-ai-limit-hint">
        {t(answerTokens?.from === 'team' ? 'guest.ai.estimateTeam' : 'guest.ai.estimateDefault')} {t('guest.ai.limitHint')}
      </p>
    </div>
  )
}

/** The team's AI accounts a guest may be given (Admin › AI providers, team ones), read only for the owner and admins
 * (`list` null while they load), and `noGuestAi`: this server runs its AI on its own sign-in (an Office Mac, local
 * login), where a guest is never answered (CredentialsResponse.guestAiUnavailable 'host_sign_in'). */
export function useTeamConnections(enabled: boolean): { list: Credential[] | null; noGuestAi: boolean } {
  const [v, setV] = useState<{ list: Credential[] | null; noGuestAi: boolean }>({ list: null, noGuestAi: false })
  useEffect(() => {
    if (!enabled) return
    let live = true
    api.call(API.listCredentials).then(
      (r) => live && setV({ list: r.items.filter((c) => c.scope === 'team'), noGuestAi: r.guestAiUnavailable === 'host_sign_in' }),
      () => live && setV({ list: [], noGuestAi: false }),
    )
    return () => { live = false }
  }, [enabled])
  return v
}

/** The plan's guests are all taken: how many, the plan page when given, and how many open links hold a place
 * (`pending`: each link nobody has used yet counts, guest walkthrough M4). */
export interface GuestCap { n: number; manageUrl?: string; pending?: number }

/** The plan's guest cap was reached (409 plan_limit reason guest_limit): how many, and the plan page when given. */
export function guestCap(e: unknown): GuestCap | null {
  if (!isApiError(e, 'plan_limit') || e.body.params?.reason !== GUEST_LIMIT || typeof e.body.params.limit !== 'number') return null
  const url = e.body.params.manageUrl
  const pending = e.body.params.pending
  return { n: e.body.params.limit, ...(typeof url === 'string' && /^https?:\/\//.test(url) ? { manageUrl: url } : {}), ...(typeof pending === 'number' && pending > 0 ? { pending } : {}) }
}

/** Words for a refused guest change: the plan's guest cap in the owner's words, else the server's. */
export function guestErrorText(e: unknown, locale: ReturnType<typeof useLocale>, t: ReturnType<typeof useT>): string {
  if (isApiError(e, 'plan_limit') && e.body.params?.reason === GUEST_LIMIT && typeof e.body.params.limit === 'number') return t('guest.limit', { n: e.body.params.limit })
  return errorText(e, locale, t('error.network'))
}

/** The plan's guest cap now (GET /api/guest-invites/limit), read once when a dialog opens (`enabled`: once it is first
 * true, Admin's Invite to team when Guest is picked); undefined while it loads, null when it could not be read (the
 * dialog goes on: the server still refuses with 409 guest_limit). A store app never shows a plan page. */
export function useGuestLimit(enabled = true): GuestInviteLimit | null | undefined {
  const [v, setV] = useState<GuestInviteLimit | null | undefined>(undefined)
  const [asked, setAsked] = useState(enabled)
  if (enabled && !asked) setAsked(true)
  useEffect(() => {
    if (!asked) return
    let live = true
    api.call(API.guestInviteLimit).then((r) => {
      if (!live) return
      const { manageUrl, ...rest } = r
      setV({ ...rest, ...(manageUrl && /^https?:\/\//.test(manageUrl) && !noPurchaseLinks() ? { manageUrl } : {}) })
    }, () => live && setV(null))
    return () => { live = false }
  }, [asked])
  return v
}

/** The plan's guests are all there, from the cap's read: how many and the plan page, or null. */
export function guestsFullOf(limit: GuestInviteLimit | null | undefined): GuestCap | null {
  return limit?.full && limit.limit !== null ? { n: limit.limit, ...(limit.manageUrl ? { manageUrl: limit.manageUrl } : {}), ...(limit.pending ? { pending: limit.pending } : {}) } : null
}

/** "See plans", a dialog's main button beside Close when the plan is full (the owner and admins only). */
export function SeePlansLink({ url }: { url: string }) {
  const t = useT()
  return (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center justify-center rounded-lg bg-accent px-3.5 text-sm font-medium text-accent-ink hover:bg-accent-hover max-md:min-h-11" data-testid="guest-invite-plans">
      {t('guest.seePlans')}
    </a>
  )
}

/** The plan's guests are all there: said at the top in place of the form. The owner and admins: what they can do and
 * "See plans" (when the server names a plan page); a member: ask an admin. `pending`: links nobody has used yet hold
 * some of the places (guest walkthrough M4), said in one line, and the owner and admins may cancel one. */
export function GuestsFull({ n, admin, pending }: { n: number; admin: boolean; pending?: number }) {
  const t = useT()
  return (
    <div className="space-y-2" role="status" data-testid="guest-invite-full">
      <p className="text-sm leading-6 font-medium break-keep text-ink">{t(pending ? 'guest.fullLinks' : 'guest.full', { n })}</p>
      {!!pending && <p className="text-sm leading-6 break-keep text-ink" data-testid="guest-invite-full-pending">{t('guest.fullPending', { n: pending })}</p>}
      <p className="text-sm leading-6 break-keep text-muted" data-testid="guest-invite-full-next">{admin && pending ? t('guest.fullAdminLinks', { path: [t('admin.title'), t('admin.members')].join(' › ') }) : t(admin ? 'guest.fullAdmin' : 'guest.fullMember')}</p>
    </div>
  )
}

/** `onCancel`: Cancel and × before the link is made (back to the add list it was opened from); `onClose`: Done after it.
 * `onFull`: Create link was refused because the plan's guests are all there (another invite made meanwhile): the opener
 * shows the limit itself (Admin's Invite to team, whose place list would otherwise offer the same wall again). */
export function GuestInviteDialog({ place, onClose, onCancel = onClose, onFull }: { place: InvitePlace; onClose: () => void; onCancel?: () => void; onFull?: (cap: GuestCap) => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const admin = isAdmin(me)
  const [name, setName] = useState('')
  const [ai, setAi] = useState<GuestAiChoice>({ mode: 'none' })
  // the team's AI accounts, read at once for the owner and admins: without one, Team AI is off before anyone picks it
  const { list: connections, noGuestAi: adminNoGuestAi } = useTeamConnections(admin)
  const limit = useGuestLimit()
  // no guest AI on this server (an Office Mac): read for everyone with the cap (a member cannot read the AI accounts),
  // so a member is never offered "Their own sign-in" for a guest who would then read "AI isn't on for you" (TC-2580)
  const noGuestAi = adminNoGuestAi || limit?.guestAiUnavailable === 'host_sign_in'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  // when a link made now would stop (told before Create link: QA TC-2222), in the team's time zone like the link's own
  const [until] = useState(() => new Date(Date.now() + GUEST_LINK_HOURS * 3600_000).toISOString())
  // the plan's guests are all there: read when the dialog opens, or told by a refused Create link (409 plan_limit
  // reason guest_limit, another invite made meanwhile); the plan page only for the owner and admins (a store app's
  // answer has none: lib/api.ts storeSafeError)
  const [refusedFull, setRefusedFull] = useState<GuestCap | null>(null)
  const full = refusedFull ?? guestsFullOf(limit)
  // one of my personal projects: shared first, with nobody else yet, as its page's "Add people" does (POST
  // /api/projects/:id/share: a team project in projects/<name> that still only I see, so it stays in My projects until
  // the guest joins; docs/DECISIONS.md "Guests into a personal project"). Once only: a Create link refused after it
  // (the plan filled up meanwhile) makes the link alone on the next try
  const [personal, setPersonal] = useState(!!place.personal)
  const share = async (skillsOk = false): Promise<boolean> => {
    try {
      const r = await api.call(API.shareProject, { params: { id: place.id }, body: { participants: [], ...(skillsOk ? { skillsOk } : {}) } })
      if ('id' in r) useProjects.getState().put(r)
      setPersonal(false)
      return true
    } catch (e) {
      // shared meanwhile (another tab, its page's Add people): a team project already, so the link is all that is left
      if (isApiError(e, 'validation') && e.body.fields?.['params.id'] === 'not a personal project') {
        setPersonal(false)
        return true
      }
      // its skills/ holds skills: they switch on in this project's chats. Nothing to choose there (I asked for the link), so
      // it is said in one line with their names and the share goes ahead (docs/decisions/20261123-do-then-undo.md)
      const skills = projectSkillsOn(e)
      if (skills && !skillsOk) {
        toast({ level: 'info', text: t('projects.skillsOnBody', { n: skills.length, names: skills.join(', '), ai: aiName(t) }) })
        return share(true)
      }
      throw e
    }
  }
  const create = async () => {
    if (busy || !aiChoiceReady(ai) || full) return
    setBusy(true)
    setError(null)
    try {
      if (personal && !(await share())) return
      const r = await api.call(API.createGuestInvite, { body: { place: { kind: place.kind, id: place.id }, ai, ...(name.trim() ? { name: name.trim() } : {}) } })
      setUrl(absoluteUrl(r.url))
      setExpiresAt(r.invite.expiresAt)
    } catch (e) {
      const cap = guestCap(e)
      const shown = cap && { n: cap.n, ...(cap.manageUrl && !noPurchaseLinks() ? { manageUrl: cap.manageUrl } : {}), ...(cap.pending ? { pending: cap.pending } : {}) }
      if (shown && onFull) onFull(shown)
      else if (shown) setRefusedFull(shown)
      else setError(guestErrorText(e, locale, t))
    } finally {
      setBusy(false)
    }
  }
  const who = name.trim()
  if (url) return <GuestLinkReady url={url} who={who} place={place} ownAi={ai.mode === 'own'} expiresAt={expiresAt ?? until} onClose={onClose} />
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
            {admin && full.manageUrl && <SeePlansLink url={full.manageUrl} />}
          </>
        }
      >
        <GuestsFull n={full.n} admin={admin} pending={full.pending} />
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
            {t(place.kind === 'room' ? (place.privateChannel ? 'guest.invite.whereRoom' : 'guest.invite.whereRoomGroup') : 'guest.invite.whereProject', { place: place.name })}
          </p>
          {personal && <p className="text-sm leading-6 break-keep text-muted" data-testid="guest-invite-personal">{t('guest.invite.personalProject')} {t('projects.shareConfirmFinal')}</p>}
          <Field label={t('guest.invite.name')}>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder={t('guest.invite.namePlaceholder')} className={inputCls} data-testid="guest-invite-name" />
          </Field>
          <GuestAiChoices value={ai} onChange={setAi} admin={admin} connections={connections} noGuestAi={noGuestAi} answerTokens={limit?.answerTokens} />
          <LinkExpiry iso={until} />
          {error && <p role="alert" className="text-sm break-keep text-danger" data-testid="guest-invite-error">{error}</p>}
        </form>
      )}
    </Modal>
  )
}

/** How long a guest link works: the server's default (CreateGuestInviteBody.expiresInHours), which the dialog keeps. */
const GUEST_LINK_HOURS = 24 * 7

/** "The link works once, for 7 days (until Nov 22, 2026, 14:30)": the end in the team's time zone (Admin's invite list
 * and the server use it too). */
function useUntil(iso: string): string {
  const locale = useLocale()
  const tz = useMe()?.server.timeZone
  return formatDateTime(iso, locale, tz)
}
function LinkExpiry({ iso }: { iso: string }) {
  const t = useT()
  return <p className="text-xs leading-5 break-keep text-muted" data-testid="guest-invite-expiry">{t('guest.invite.expiry', { days: GUEST_LINK_HOURS / 24, date: useUntil(iso) })}</p>
}

/** The message that goes with a guest link, ready to paste in an email or a chat (guest walkthrough S7, like the team
 * link's and the lead link's): who sends it, the one place they will see, their own AI account when that is their AI,
 * and the link with how long it works. In the inviter's language: they write to the guest. */
export function guestLinkMessage(t: ReturnType<typeof useT>, o: { name: string; place: InvitePlace; url: string; until: string; ownAi: boolean }): string {
  const product = namedProduct(t)
  const name = o.name.trim()
  const room = o.place.kind === 'room'
  // a private channel by its kind; a group DM (no name of its own) as a group chat
  const channel = room && !!o.place.privateChannel
  const hello = name
    ? t(channel ? 'guest.invite.msgRoom' : room ? 'guest.invite.msgRoomGroup' : 'guest.invite.msgProject', { ...product, name, place: o.place.name })
    : t(channel ? 'guest.invite.msgRoomNoName' : room ? 'guest.invite.msgRoomGroupNoName' : 'guest.invite.msgProjectNoName', { ...product, place: o.place.name })
  return [hello, o.ownAi && t('teamLink.msg.ownAi'), t('guest.invite.msgJoin', { date: o.until, url: o.url })].filter(Boolean).join('\n')
}

/** The one-time link, made: the message to send with it (ready to paste; the link in it), "Copy message" as the main
 * action and "Copy link" for the address alone (as the lead link's), how long it works, and Done. */
function GuestLinkReady({ url, who, place, ownAi, expiresAt, onClose }: { url: string; who: string; place: InvitePlace; ownAi: boolean; expiresAt: string; onClose: () => void }) {
  const t = useT()
  const me = useMe()
  const until = useUntil(expiresAt)
  const message = guestLinkMessage(t, { name: me?.user.name ?? '', place, url, until, ownAi })
  const at = message.lastIndexOf(url)
  const msg = useCopy()
  const link = useCopy()
  return (
    <Modal
      open
      onClose={onClose}
      title={who ? t('guest.invite.readyFor', { name: who }) : t('guest.invite.ready')}
      width={440}
      footer={<Button variant="ghost" onClick={onClose} data-testid="guest-invite-done">{t('common.done')}</Button>}
    >
      <div className="space-y-3" data-testid="guest-invite-ready">
        <div>
          <p className="text-xs font-medium text-muted">{t('teamLink.messagePreview')}</p>
          <blockquote className="mt-2 border-l-2 border-line pl-3 text-sm leading-6 break-words whitespace-pre-wrap text-ink" data-testid="guest-invite-message">
            {at < 0 ? message : (
              <>
                {message.slice(0, at)}
                <span className="font-mono break-all select-all" data-testid="guest-invite-url">{url}</span>
                {message.slice(at + url.length)}
              </>
            )}
          </blockquote>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="primary" className="mr-1 max-sm:w-full" onClick={() => void msg.copy(message)} data-testid="guest-invite-copy-message">
            {msg.copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {msg.copied ? t('common.copied') : t('teamLink.copyMessage')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void link.copy(url)} data-testid="guest-invite-copy">
            {link.copied ? <Check size={14} className="text-ok" aria-hidden /> : <Copy size={14} aria-hidden />} {link.copied ? t('common.copied') : t('members.copyLink')}
          </Button>
        </div>
        {/* the message says until when; this line only how to send it */}
        <p className="text-sm break-keep text-muted" data-testid="guest-invite-once">{t('guest.invite.once')}</p>
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

/** A guest of the add list who cannot be added to `here` (a group chat or a project; `id` left out: a new group chat):
 * they are in another place of the same kind already (Person.guestPlaces: a guest is in at most one group chat and
 * one project). That place (its name only when the viewer is in it too), or null for anyone else, for a guest of `here`
 * and for a guest in a place of the other kind only. */
export function guestElsewhere(p: Pick<Person, 'guest' | 'guestPlaces'>, here: { kind: PlaceKind; id?: string }): GuestPlaceView | null {
  if (!p.guest) return null
  return p.guestPlaces?.find((pl) => pl.kind === here.kind && (here.id === undefined || pl.id !== here.id)) ?? null
}

/** The words of a greyed-out guest's row: "In the 'Quote prep' private channel" (or project). A room's name here is its
 * own (server auth/guests.ts placeName), so a named room is a private channel; a group DM has none and says the rule. */
export function elsewhereText(t: ReturnType<typeof useT>, place: GuestPlaceView): string {
  return place.name ? t(place.kind === 'room' ? 'guest.inRoom' : 'guest.inProject', { place: place.name }) : t('guest.onePlaceShort')
}

/** For the owner and admins, on a greyed-out guest's row: "Make team member", its dialog right here (the add list and
 * its picks stay); once done the people list is read again, so the row can be ticked. */
export function MakeMemberButton({ guest }: { guest: { id: string; name: string } }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} data-testid="guest-elsewhere-convert">
        {t('guest.makeMember')}
      </Button>
      {open && <ConvertGuestDialog guest={guest} onClose={() => setOpen(false)} onDone={() => usePeople.getState().load(true)} />}
    </>
  )
}

/** The add list's guests who are in another place already, by participant key (`user:<id>`), for ParticipantPicker's
 * `unavailable`: where they are, and "Make team member" for the owner and admins. `here.id` left out: a place still to
 * be made (a new project): only a guest who has one of that kind already. `anyPlace`: every guest who has a place at
 * all (a personal project shared to the team: the server lets no guest in there, auth/guests.ts claimGuestProject). */
export function useGuestsElsewhere(here: { kind: PlaceKind; id?: string }, anyPlace = false): ReadonlyMap<string, { text: string; action?: ReactNode }> {
  const t = useT()
  const admin = isAdmin(useMe())
  const people = usePeopleList()
  return useMemo(() => {
    const m = new Map<string, { text: string; action?: ReactNode }>()
    for (const p of people ?? []) {
      const away = anyPlace ? (p.guest ? p.guestPlaces?.[0] ?? null : null) : guestElsewhere(p, here)
      if (away) m.set(`user:${p.id}`, { text: elsewhereText(t, away), ...(admin ? { action: <MakeMemberButton guest={p} /> } : {}) })
    }
    return m
  }, [people, here.kind, here.id, anyPlace, admin, t]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** "Make Alex a team member?" (Admin › Members › Guests, and a greyed-out guest's row in an add list): the seats are read first; with every seat taken it says so, with "See plans" (when the
 * server names a plan page), and there is nothing to confirm. A refusal after Confirm (the last seat taken meanwhile)
 * turns it into the same. A removed guest is switched on with it (POST .../convert-guest), which the words say. */
export function ConvertGuestDialog({ guest: user, onClose, onDone }: { guest: { id: string; name: string; status?: string }; onClose: () => void; onDone: () => Promise<void> | void }) {
  // a removed guest (account off) is switched on with it, wherever their old place is (a member needs none)
  const removed = user.status !== undefined && user.status !== 'active'
  const t = useT()
  const locale = useLocale()
  const limit = useGuestLimit()
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
            <p className="text-ink">{t(removed ? 'guest.admin.convertBodyRemoved' : 'guest.admin.convertBody')}</p>
            <p className="text-muted" data-testid="guest-convert-ai">{t('guest.admin.convertAi')}</p>
          </>
        )}
        {error && <p role="alert" className="text-danger">{error}</p>}
      </div>
    </Modal>
  )
}
