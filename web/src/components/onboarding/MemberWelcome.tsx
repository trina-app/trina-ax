// "My setup" ("내 설정"), the personal card at the top of Home (docs/DECISIONS.md "A welcome for invited people",
// docs/decisions/20261120-my-setup-card.md; GET/PATCH /api/me/welcome, store/memberWelcome.ts). No wizard, no page, no
// tour: one card while the person joined lately (a new owner or admin: since their first read, the creator's days
// restarting at the team setup's end; docs/decisions/20261128-owner-personal-onboarding.md) and has not finished or
// hidden it, and Home's other top things (the no-AI line, the goal card, "Ready in your team", the setup's own row)
// stay out while it shows ("Y — Home shows one thing at a time").
// - A member or an admin: "Welcome to {team}, {first name}" and one line "{inviter} invited you · {n} people are here ·
//   You're in {rooms}" (the rooms a link to Chats; no inviter: without the first part). The owner ('owner'): "Your turn
//   now, {first name}" and "The team is set up. These are just for you." once the team setup is over; while it is open
//   (`setupOpen`) "Let's get you started, {first name}", "These are just for you." and, first, the setup's way back
//   ("Continue team setup · 2/5", "Start team setup · 1/5" when no step was taken yet, or "Still to do: Team files";
//   on a phone with only 내 스킬 left, "Continue the team setup on your computer"), hidden while no AI answers.
// - Hide at the card's top right, on the title's line (it closes the whole card, on every device, with an undo toast;
//   Settings › Profile can show it again while its days last), then "Get started · {done} of {total} required", a
//   plain label over the rows (an owner with both done while the setup is open: "Your setup is done · the team setup is
//   left"). It counts the required rows only; they come first, and the optional ones ("Optional · …" in their line)
//   after them (owner 2026-11-21: "2 of 3" over five rows read wrong).
// - A demo (`welcome.demo`: the scripted demo build, a free-roam instance) has no row a. and no row e.: neither can be
//   done there (owner 2026-11-21), and tools is not counted.
// - Rows, each with a done / not done circle, in this order (c. after d.):
//   a. "Connect your tools" (counted; MyToolsRow.tsx): the team's recommended tools, then the usual ones, each [연결]
//      with the person's own account, "팀 연결됨" for one the team connected for everyone (all of them the team's:
//      nothing left to connect, done).
//   b. a member's or an admin's "Say hi to the team" ("👋 Hi, I'm {name}" posts that in the everyone room as them; done
//      once they wrote any message in a room; then Open: that room). Never the owner's.
//   c. "Add your photo" (optional, not counted: the photo picker in place, saved at once).
//   d. "Ask {AI} what you can do here" (one tap starts a normal chat with a fixed question, which opens; done once it
//      ran). While no AI answers them, row d is the no-AI way out instead (ConnectAi.tsx): a member "Tell {owner}" once
//      ("Told them" after), in its place; someone who can connect it (the owner, an admin) gets it as the FIRST row,
//      over "Connect your tools", since nothing else in the card works without it: "Connect an AI so {AI} can help you
//      right away" with the team's ways (Home's no-AI line's buttons), or "Connect your AI …" for their own.
//   e. this computer's files (optional, not counted), by where the card is seen: the desktop app (useMyWorkFiles)
//      "Bring work files from this computer", My files' own dialog (done once a file is in My files › From this
//      computer; Undo makes it not done again); a Mac or Windows browser "Open the desktop app" (/open-app, lib/
//      open-app.ts openAppLineShown); nothing on a phone, Linux or a narrow window.
// - Every counted row done: "You're all set" for a few seconds (Close ends it sooner), then gone.
// An admin's "팀 파일 정리하기" is on Admin › Home now (OrganizeTeamFiles.tsx).
// Phones (below 768px): the same card without a frame, under the box like Home's other "one thing"; every control is a
// 44 px target and a row's button wraps under its words when they need the width.
import clsx from 'clsx'
import { ArrowRight, Check, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import { uuidv7, type MemberWelcome as Welcome } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { PHOTO_ACCEPT, squarePhoto } from '../../lib/avatar'
import { aiName } from '../../lib/tabs'
import { useLocale, useT } from '../../i18n'
import { useAiAccess } from '../../store/aiAccess'
import { useChats } from '../../store/chats'
import { useMemberWelcome } from '../../store/memberWelcome'
import { useMeStrict, useSession } from '../../store/session'
import { toast } from '../../store/ui'
import { Button, buttonClass, useMediaQuery } from '../ui'
import { PhonePickButton, useDevicePick } from '../DevicePick'
import { ConnectAiButton, TeamWaysButtons } from './ConnectAi'
import { useWelcome } from '../../store/welcome'
import { setupRowWords, showResume, skillsWaitForComputer } from '../../lib/welcome'
import { useMyWorkFiles } from './FindWorkFiles'
import { runFolder } from '../../lib/workFiles'
import { clientKind } from '../../lib/desktop'
import { isGuestMe } from '../../lib/guests'
import { OPEN_APP_PATH, openAppLineShown, pageOrigin } from '../../lib/open-app'
import { platform } from '../../lib/pwa'
import { CardHide } from './CardHide'
import { MyToolsList } from './MyToolsRow'
import { greetName } from '../../lib/greetName'

/** "Everyone and # Sales" in the person's language (Intl.ListFormat), team rooms with their #. */
export function roomList(rooms: Welcome['rooms'], everyone: string, locale: string): string {
  const names = rooms.map((r) => (r.kind === 'all' ? r.name ?? everyone : `# ${r.name ?? ''}`))
  try { return new Intl.ListFormat(locale, { type: 'conjunction' }).format(names) } catch { return names.join(', ') }
}

/** The rows that count toward "{done} of {total} required": tools and asked, and a member's hi (the photo and the files
 * row are optional). A demo has no tools row. An older server sends no `tools`: its card counts as before (the rooms,
 * done, with hi and asked). */
export function countedSteps(w: Pick<Welcome, 'kind' | 'steps' | 'demo'>): { done: number; total: number } {
  const s = w.steps
  const rows = w.kind === 'owner' ? (w.demo ? [s.asked] : [!!s.tools, s.asked]) : w.demo ? [s.hi, s.asked] : s.tools === undefined ? [s.rooms, s.hi, s.asked] : [s.tools, s.hi, s.asked]
  return { done: rows.filter(Boolean).length, total: rows.length }
}

/** how long "You're all set" stays before the card goes by itself */
export const ALL_SET_SHOW_MS = 5000

const tap = 'max-md:min-h-11'
/** a row's quiet Open link (the rooms, hi and files rows) */
const openLink = clsx('inline-flex h-8 items-center rounded-lg px-2.5 text-label font-medium text-muted hover:bg-hover hover:text-ink', tap)

export function MemberWelcomeCard({ welcome }: { welcome: Welcome }) {
  const t = useT()
  const locale = useLocale()
  const ids = useId()
  const me = useMeStrict()
  const hide = useMemberWelcome((s) => s.hide)
  const drop = useMemberWelcome((s) => s.drop)
  const ai = useAiAccess()
  const name = greetName(me.user.name, locale)
  const owner = welcome.kind === 'owner'
  const demo = !!welcome.demo
  const setupOpen = owner && !!welcome.setupOpen
  // no AI, and this person can connect it (the owner, an admin): the AI row leads, over the tools
  const aiFirst = ai.loaded && !ai.usable && ai.action !== 'ask_owner' && !welcome.steps.asked
  // Hide, with an undo toast (a mis-tap needs no trip to Settings › Profile); a hide the server refused says nothing:
  // the card comes back by itself
  const hideCard = () => void hide().then((ok) => ok && toast({ level: 'info', text: t('homeCards.hiddenMySetup'), action: { label: t('common.undo'), run: () => void useMemberWelcome.getState().show().then((ok) => { if (!ok) toast({ level: 'error', text: t('error.network') }) }) } }))
  const people = t('memberWelcome.people', { n: welcome.people })
  const frame = 'md:rounded-2xl md:border md:border-line md:p-5'
  // "You're all set" a few seconds, then gone (Close ends it sooner)
  useEffect(() => {
    if (!welcome.allSet) return
    const timer = window.setTimeout(drop, ALL_SET_SHOW_MS)
    return () => window.clearTimeout(timer)
  }, [welcome.allSet, drop])

  if (welcome.allSet)
    return (
      <section role="status" className={clsx('mb-6 max-md:mb-0 max-md:px-3', frame)} aria-labelledby={`${ids}-title`} data-testid="member-welcome" data-state="all-set">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink" aria-hidden><Check size={14} /></span>
          <div className="min-w-0 flex-[1_1_12rem]">
            <h2 id={`${ids}-title`} className="text-title-sm font-semibold text-ink">{t('memberWelcome.allSet')}</h2>
            <p className="text-sm text-muted text-balance">{t('memberWelcome.allSetHint', { place: t('tabs.chats'), ai: aiName(t) })}</p>
          </div>
          <Button size="sm" className={tap} onClick={() => void hide()} data-testid="member-welcome-close">{t('common.close')}</Button>
        </div>
      </section>
    )

  const { done, total } = countedSteps(welcome)
  const rooms = welcome.rooms.length > 0 && (
    <Link to="/rooms" className="font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink" data-testid="member-welcome-rooms">
      {t('memberWelcome.rooms', { rooms: roomList(welcome.rooms, t('rooms.all'), locale) })}
    </Link>
  )
  return (
    <section className={clsx('mb-6 max-md:mb-0', frame)} aria-labelledby={`${ids}-title`} data-testid="member-welcome" data-state="open" data-kind={owner ? 'owner' : 'member'}>
      <div className="max-md:px-3">
        {/* Hide closes the whole card: at its top right, on the title's line (a long title wraps before it) */}
        <div className="flex items-start gap-3">
          <h2 id={`${ids}-title`} className="min-w-0 flex-1 text-display font-semibold tracking-tight text-ink text-balance" data-testid="member-welcome-title">
            {owner ? t(setupOpen ? 'memberWelcome.ownerStartTitle' : 'memberWelcome.ownerTitle', { name }) : t('memberWelcome.title', { team: welcome.team, name })}
          </h2>
          <CardHide onClick={hideCard} label={t('memberWelcome.hideLabel')} testId="member-welcome-hide" className="mt-1 max-md:-mr-1.5 max-md:mt-0" />
        </div>
        <p className="mt-0.5 text-sm text-muted" data-testid="member-welcome-line">
          {owner ? t(setupOpen ? 'memberWelcome.ownerStartLine' : 'memberWelcome.ownerLine') : (
            <>
              {welcome.inviter ? t('memberWelcome.invited', { inviter: welcome.inviter.name, n: welcome.people }) : people}
              {rooms && <> · {rooms}</>}
            </>
          )}
        </p>
      </div>
      {setupOpen && <SetupRow />}
      <p className="mt-4 border-b border-line pb-2 text-xs font-medium text-muted max-md:mt-3 max-md:px-3" data-testid="member-welcome-progress">
        {setupOpen && done === total ? t('memberWelcome.ownerSetupLeft') : t('memberWelcome.progress', { done, total })}
      </p>
      {/* the counted rows first, then the optional ones */}
      <ul className="divide-y divide-line" data-testid="member-welcome-rows">
        {aiFirst && <AskRow welcome={welcome} />}
        {!demo && <ToolsRow done={!!welcome.steps.tools} />}
        {!owner && <HiRow welcome={welcome} name={me.user.name.trim()} />}
        {!aiFirst && <AskRow welcome={welcome} />}
        <PhotoRow done={welcome.steps.photo} />
        {!demo && <FilesRow done={!!welcome.steps.files} />}
      </ul>
    </section>
  )
}

/** The team setup's way back, first in an owner's card while it is open (the card's own count is the person's; this
 * one is the team's, so its words say "team"): "Continue team setup · 2/5" (→ /welcome at its step), "Start team setup
 * · 1/5" while no step was taken (a setup made for them and never opened), or one step left named ("Still to do: Team
 * files"). Hidden while no AI answers (the AI row leads instead: the steps would open on the AI step). On a phone with
 * only 내 스킬 left, put off for a computer: "Continue the team setup on your computer", no button. Home's standalone
 * row (WelcomeResume) shows only without a card. */
function SetupRow() {
  const t = useT()
  const loaded = useWelcome((s) => s.loaded)
  const progress = useWelcome((s) => s.progress)
  const aiReady = useAiAccess((s) => s.loaded && s.usable)
  const computer = !useMediaQuery('(max-width: 767.98px)')
  useEffect(() => { void useWelcome.getState().load().catch(() => {}) }, [])
  if (!loaded || !progress || !aiReady) return null
  const line = 'mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-subtle px-3 py-2 max-md:mx-3'
  if (!showResume(progress, computer)) {
    if (!skillsWaitForComputer(progress)) return null
    return (
      <p className={clsx(line, 'min-h-11 text-sm text-muted')} data-testid="member-welcome-setup" data-state="computer">
        <ArrowRight size={15} className="shrink-0 text-accent-text" aria-hidden />{t('memberWelcome.setupOnComputer')}
      </p>
    )
  }
  const words = setupRowWords(t, progress, aiReady, computer)
  const fresh = Object.values(progress.steps).every((v) => v == null)
  const text = words.count === null ? words.text : t(fresh ? 'memberWelcome.setupStart' : 'memberWelcome.setupResume')
  return (
    <div className={line} data-testid="member-welcome-setup" data-state={fresh ? 'start' : 'resume'}>
      <p className="flex min-w-0 flex-[1_1_12rem] items-center gap-2 text-sm font-medium text-ink" data-testid="member-welcome-setup-text">
        <ArrowRight size={15} className="shrink-0 text-accent-text" aria-hidden />
        <span>{text}{words.count && <> <span className="font-normal text-faint tabular-nums"><span aria-hidden>· </span>{words.count}</span></>}</span>
      </p>
      <Link to="/welcome" className={buttonClass({ size: 'sm', className: tap })} data-testid="member-welcome-setup-button">
        {t(fresh ? 'memberWelcome.setupStartButton' : 'memberWelcome.setupResumeButton')}
      </Link>
    </div>
  )
}

/** One row: the circle, the words, and its action at the end (under the words when they need the width). */
function Row({ id, done, title, hint, children, optional, below }: { id: string; done: boolean; title: ReactNode; hint?: ReactNode; children?: ReactNode; optional?: boolean; below?: ReactNode }) {
  const t = useT()
  return (
    <li className="flex items-start gap-3 py-3 max-md:px-3" data-testid={`member-welcome-${id}`} data-done={done || undefined} data-optional={optional || undefined}>
      <span className={clsx('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border', done ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong')} aria-hidden>
        {done && <Check size={12} strokeWidth={3} />}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-[1_1_14rem]">
          <p className={clsx('text-sm font-medium', done ? 'text-muted' : 'text-ink')}>
            {title}
            <span className="sr-only"> · {t(done ? 'memberWelcome.done' : 'memberWelcome.todo')}</span>
          </p>
          {hint && <p className="text-label text-muted">{hint}</p>}
        </div>
        {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
        {below && <div className="basis-full">{below}</div>}
      </div>
    </li>
  )
}

/** "Connect your tools": the tools under the words, each [연결] with the person's own account (MyToolsRow.tsx). */
function ToolsRow({ done }: { done: boolean }) {
  const t = useT()
  const mark = useMemberWelcome((s) => s.mark)
  // one of theirs works now: done at once, and the server's answer (all set?) follows
  const mine = useCallback(() => {
    if (useMemberWelcome.getState().welcome?.steps.tools) return
    mark('tools')
    void useMemberWelcome.getState().load()
  }, [mark])
  // every tool offered is the team's for everyone: nothing left to connect, recorded done
  const covered = useCallback(() => { if (!useMemberWelcome.getState().welcome?.steps.tools) void useMemberWelcome.getState().toolsCovered() }, [])
  return <Row id="tools" done={done} title={t('memberWelcome.tools')} hint={t('memberWelcome.toolsHint', { ai: aiName(t) })} below={<MyToolsList onMine={mine} onCovered={covered} />} />
}

/** "👋 Hi, I'm {name}" in the everyone room, as the person (the room's own send; a second tap is the same message).
 * `name`: the whole display name, as written: the team reads it, so never the greeting's short name ("Hi, I'm Dr."). */
function HiRow({ welcome, name }: { welcome: Welcome; name: string }) {
  const t = useT()
  const locale = useLocale()
  const mark = useMemberWelcome((s) => s.mark)
  const [busy, setBusy] = useState(false)
  const everyone = welcome.rooms.find((r) => r.kind === 'all') ?? null
  const room = everyone?.name ?? t('rooms.all')
  const text = t('memberWelcome.hiButton', { name })
  const say = async () => {
    if (!everyone || busy) return
    setBusy(true)
    try {
      await api.call(API.sendRoomMessage, { params: { id: everyone.id }, body: { body: text, mentions: [], clientMessageId: uuidv7() } })
      mark('hi')
      // the server says whether that was the last row ("You're all set" without opening Home again)
      void useMemberWelcome.getState().load()
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Row id="hi" done={welcome.steps.hi} title={t('memberWelcome.hi')} hint={t('memberWelcome.hiHint', { room })}>
      {welcome.steps.hi ? (
        everyone && <Link to={`/rooms/${everyone.id}`} className={openLink} data-testid="member-welcome-hi-open">{t('memberWelcome.roomsOpen')}</Link>
      ) : (
        everyone && <Button size="sm" className={tap} busy={busy} onClick={() => void say()} data-testid="member-welcome-hi-button">{text}</Button>
      )}
    </Row>
  )
}

/** The profile photo, picked and saved in place (Settings › Profile's own way: a square, metadata left out). */
function PhotoRow({ done }: { done: boolean }) {
  const t = useT()
  const locale = useLocale()
  const mark = useMemberWelcome((s) => s.mark)
  const signedIn = useSession((s) => s.signedIn)
  const pick = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const choose = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    try {
      const p = await squarePhoto(file)
      if (!p) return toast({ level: 'warn', text: t('profile.photoProblem') })
      URL.revokeObjectURL(p.url)
      await api.call(API.putMyAvatar, { query: { type: p.type }, body: p.blob })
      signedIn(await api.call(API.me))
      mark('photo')
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(false)
    }
  }
  // a phone: our sheet's device rows first (components/DevicePick.tsx), never iOS's raw menu
  const phone = useMediaQuery('(max-width: 767.98px)')
  const device = useDevicePick({ onFiles: (f) => void choose(f[0]), accept: PHOTO_ACCEPT, testIds: 'member-welcome-photo', off: busy })
  return (
    <Row id="photo" done={done} optional title={t('memberWelcome.photo')} hint={t('memberWelcome.photoHint')}>
      {!done && (phone ? (
        <PhonePickButton pick={device} label={t('memberWelcome.photoButton')} heading={t('profile.photo')} className={buttonClass({ size: 'sm', busy, className: tap })} disabled={busy} testId="member-welcome-photo-button">
          {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}{t('memberWelcome.photoButton')}
        </PhonePickButton>
      ) : (
        <>
          <Button size="sm" className={tap} busy={busy} onClick={() => pick.current?.click()} data-testid="member-welcome-photo-button">{t('memberWelcome.photoButton')}</Button>
          <input ref={pick} type="file" accept={PHOTO_ACCEPT} className="hidden" tabIndex={-1} aria-hidden data-testid="member-welcome-photo-input" onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = '' }} />
        </>
      ))}
    </Row>
  )
}

/** This computer's files (optional, not counted), by where the card is seen. The desktop app: "Bring work files from
 * this computer", My files' own dialog (useMyWorkFiles), the files to My files › From this computer; a new file up
 * marks it at once; closing the dialog, and Undo, read the card again (the server looks in the folder, so Undo makes it
 * not done). A Mac or Windows browser: "Open the desktop app" (/open-app). Nothing on a phone, Linux or an older app. */
function FilesRow({ done }: { done: boolean }) {
  const t = useT()
  const me = useMeStrict()
  const mark = useMemberWelcome((s) => s.mark)
  const f = useMyWorkFiles({ onChange: () => void useMemberWelcome.getState().load(), onLanded: () => mark('files') })
  if (!f.available) {
    if (!openAppLineShown({ platform: platform(), client: clientKind(), origin: pageOrigin(), guest: isGuestMe(me) })) return null
    return (
      <Row id="files" done={false} optional title={t('memberWelcome.openApp')} hint={t('memberWelcome.openAppHint', { app: PRODUCT.displayName })}>
        <Link to={OPEN_APP_PATH} state={{ openAppBack: true }} className={buttonClass({ size: 'sm', className: tap })} data-testid="member-welcome-open-app">{t('memberWelcome.openAppButton')}</Link>
      </Row>
    )
  }
  const folder = runFolder(f.own)
  return (
    <>
      {/* a narrow window, as My files' line: no row; the dialog keeps its place in the tree, so one already open stays as it is */}
      {!f.narrow && (
        <Row id="files" done={done} optional title={t('memberWelcome.files')} hint={t('memberWelcome.filesHint', { app: PRODUCT.displayName, place: t('files.findWork.myPlace') })}>
          {done ? (
            <Link to={`/files?path=${encodeURIComponent(folder)}`} className={openLink} data-testid="member-welcome-files-open">{t('memberWelcome.roomsOpen')}</Link>
          ) : (
            <Button size="sm" className={tap} onClick={f.start} data-testid="member-welcome-files-button">{t('memberWelcome.filesButton')}</Button>
          )}
        </Row>
      )}
      {f.dialog}
    </>
  )
}

/** "Ask {AI} what you can do here", or, while no AI answers the person, the no-AI way out in its place. */
function AskRow({ welcome }: { welcome: Welcome }) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const navigate = useNavigate()
  const ai = useAiAccess()
  const send = useChats((s) => s.send)
  const asked = useMemberWelcome((s) => s.asked)
  const [busy, setBusy] = useState(false)
  const name = aiName(t)
  const noAi = ai.loaded && !ai.usable
  if (noAi && !welcome.steps.asked) {
    if (ai.action === 'ask_owner') {
      // a third person, named to the member: the whole display name, never the greeting's short name
      const owner = welcome.owner ? welcome.owner.name.trim() || null : null
      return (
        <Row id="ask" done={false} title={t('memberWelcome.noAiAsk', { ai: name })} hint={owner ? t('memberWelcome.noAiAskHint', { owner }) : t('aiConnect.member')}>
          {ai.requested ? (
            <span className="text-label font-medium text-muted" data-testid="member-welcome-told">{t('aiAccess.asked')}</span>
          ) : (
            <Button size="sm" className={tap} busy={ai.sending} onClick={() => void ai.ask()} data-testid="member-welcome-tell" data-action="ask_owner">
              {owner ? t('memberWelcome.tell', { name: owner }) : t('aiAccess.askOwner')}
            </Button>
          )}
          {ai.failed && <span role="alert" className="text-xs text-danger">{t('aiAccess.askFailed')}</span>}
        </Row>
      )
    }
    // the team's AI (the owner, an admin): the team's words and Home's no-AI buttons; one's own: "Connect your AI"
    if (ai.action === 'connect_team')
      return (
        <Row id="ask" done={false} title={t('memberWelcome.noAiTeam', { ai: name })}>
          <span className="flex flex-wrap items-center gap-2" data-testid="member-welcome-connect" data-action="connect_team"><TeamWaysButtons small /></span>
        </Row>
      )
    return (
      <Row id="ask" done={false} title={t('memberWelcome.noAiOwn', { ai: name })}>
        <ConnectAiButton personal={ai.action === 'connect_own'} data-testid="member-welcome-connect" data-action={ai.action} />
      </Row>
    )
  }
  const ask = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await send({ chatId: null, content: t('memberWelcome.askQuestion'), attachments: [], author: { id: me.user.id, name: me.user.name }, projectId: null })
      void asked()
      navigate(`/c/${r.chatId}`)
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      setBusy(false)
    }
  }
  return (
    <Row id="ask" done={welcome.steps.asked} title={t('memberWelcome.ask', { ai: name })} hint={t('memberWelcome.askHint')}>
      {!welcome.steps.asked && (
        <Button size="sm" variant="primary" className={tap} busy={busy} disabled={!ai.loaded} onClick={() => void ask()} data-testid="member-welcome-ask-button">{t('memberWelcome.askButton')}</Button>
      )}
    </Row>
  )
}
