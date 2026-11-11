// The welcome card for invited people at the top of Home (docs/DECISIONS.md "A welcome for invited people"; GET/PATCH
// /api/me/welcome, store/memberWelcome.ts). No wizard, no page, no tour: one card while the person joined lately and has
// not finished or hidden it, and Home's other top things (the no-AI card, the goal card, "Ready in your team") stay out
// while it shows ("Y — Home shows one thing at a time").
// - "Welcome to {team}, {first name}" and "{inviter} invited you · {n} people are here" (no inviter: the second half).
// - "Get started · {done} of {total}" and Hide (for good, on every device).
// - Rows, each with a done / not done circle: a. "You're in {rooms}" (done from the start; Open: Conversations), b. "Say
//   hi to the team" ("👋 Hi, I'm {name}" posts that in the everyone room as them; done once they wrote any message in a
//   room; then Open: that room), c. "Add your photo" (optional, not counted: the photo picker in place, saved at once),
//   d. "Ask {AI} what you can do here" (one tap starts a normal chat with a fixed question, which opens; done once it
//   ran). While no AI answers them, row d is the no-AI way out instead (components/onboarding/ConnectAi.tsx): connect
//   their own AI (or the team's, for an admin), or "Tell {owner}" once ("Told them" after), with the trial credit's line
//   when that is why; it goes back to the question once AI answers.
// - Every counted row done: "You're all set" with Close, then gone for good.
// Phones (below 768px): the same card without a frame, under the box like Home's other "one thing"; every control is a
// 44 px target and a row's button wraps under its words when they need the width.
import clsx from 'clsx'
import { Check } from 'lucide-react'
import { useId, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { uuidv7, type MemberWelcome as Welcome } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { squarePhoto } from '../../lib/avatar'
import { trialLine } from '../../lib/aiAccess'
import { aiName } from '../../lib/tabs'
import { useLocale, useT } from '../../i18n'
import { useAiAccess } from '../../store/aiAccess'
import { useChats } from '../../store/chats'
import { useMemberWelcome } from '../../store/memberWelcome'
import { useMeStrict, useSession } from '../../store/session'
import { toast } from '../../store/ui'
import { Button, useMediaQuery } from '../ui'
import { ConnectAiButton } from './ConnectAi'

/** The name to greet: the first word of a name with spaces in a script that writes given names first ("Mina Park" →
 * "Mina"); a name without spaces, or in Korean, Japanese or Chinese (family name first), stays whole. */
export function firstName(name: string): string {
  const s = name.trim()
  if (!s || !/\s/.test(s) || /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s)) return s
  return s.split(/\s+/)[0]!
}

/** "Everyone and # Sales" in the person's language (Intl.ListFormat), team rooms with their #. */
export function roomList(rooms: Welcome['rooms'], everyone: string, locale: string): string {
  const names = rooms.map((r) => (r.kind === 'all' ? r.name ?? everyone : `# ${r.name ?? ''}`))
  try { return new Intl.ListFormat(locale, { type: 'conjunction' }).format(names) } catch { return names.join(', ') }
}

/** The rows that count toward "{done} of {total}" (the photo is optional). */
export const countedSteps = (s: Welcome['steps']) => ({ done: [s.rooms, s.hi, s.asked].filter(Boolean).length, total: 3 })

const PHONE = '(max-width: 767.98px)'
const tap = 'max-md:min-h-11'

export function MemberWelcomeCard({ welcome }: { welcome: Welcome }) {
  const t = useT()
  const ids = useId()
  const me = useMeStrict()
  const phone = useMediaQuery(PHONE)
  const hide = useMemberWelcome((s) => s.hide)
  const name = firstName(me.user.name)
  const people = t('memberWelcome.people', { n: welcome.people })
  const frame = 'md:rounded-2xl md:border md:border-line md:p-5'

  if (welcome.allSet)
    return (
      <section role="status" className={clsx('mb-6 max-md:mb-0 max-md:px-3', frame)} aria-labelledby={`${ids}-title`} data-testid="member-welcome" data-state="all-set">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink" aria-hidden><Check size={14} /></span>
          <div className="min-w-0 flex-[1_1_12rem]">
            <h2 id={`${ids}-title`} className="font-semibold text-ink">{t('memberWelcome.allSet')}</h2>
            <p className="text-sm text-muted text-balance">{t('memberWelcome.allSetHint', { place: t(phone ? 'tabs.chats' : 'rooms.title'), ai: aiName(t) })}</p>
          </div>
          <Button size="sm" className={tap} onClick={() => void hide()} data-testid="member-welcome-close">{t('common.close')}</Button>
        </div>
      </section>
    )

  const { done, total } = countedSteps(welcome.steps)
  return (
    <section className={clsx('mb-6 max-md:mb-0', frame)} aria-labelledby={`${ids}-title`} data-testid="member-welcome" data-state="open">
      <div className="max-md:px-3">
        <h2 id={`${ids}-title`} className="text-lg font-semibold tracking-tight text-ink text-balance" data-testid="member-welcome-title">{t('memberWelcome.title', { team: welcome.team, name })}</h2>
        <p className="mt-0.5 text-sm text-muted" data-testid="member-welcome-line">
          {welcome.inviter ? t('memberWelcome.invited', { inviter: welcome.inviter.name, n: welcome.people }) : people}
        </p>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 border-b border-line pb-2 max-md:mt-3 max-md:px-3">
        <p className="text-xs font-medium text-muted" data-testid="member-welcome-progress">{t('memberWelcome.progress', { done, total })}</p>
        <button type="button" onClick={() => void hide()} aria-label={t('memberWelcome.hideLabel')} className={clsx('touch-hit rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-ink', tap)} data-testid="member-welcome-hide">
          {t('common.hide')}
        </button>
      </div>
      <ul className="divide-y divide-line" data-testid="member-welcome-rows">
        <RoomsRow welcome={welcome} phone={phone} />
        <HiRow welcome={welcome} name={name} />
        <PhotoRow done={welcome.steps.photo} />
        <AskRow welcome={welcome} />
      </ul>
    </section>
  )
}

/** One row: the circle, the words, and its action at the end (under the words when they need the width). */
function Row({ id, done, title, hint, children, optional }: { id: string; done: boolean; title: ReactNode; hint?: ReactNode; children?: ReactNode; optional?: boolean }) {
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
      </div>
    </li>
  )
}

function RoomsRow({ welcome, phone }: { welcome: Welcome; phone: boolean }) {
  const t = useT()
  const locale = useLocale()
  return (
    <Row id="rooms" done title={t('memberWelcome.rooms', { rooms: roomList(welcome.rooms, t('rooms.all'), locale) })} hint={t('memberWelcome.roomsHint', { place: t(phone ? 'tabs.chats' : 'rooms.title') })}>
      <Link to="/rooms" className={clsx('inline-flex h-8 items-center rounded-lg px-2.5 text-label font-medium text-muted hover:bg-hover hover:text-ink', tap)} data-testid="member-welcome-rooms-open">
        {t('memberWelcome.roomsOpen')}
      </Link>
    </Row>
  )
}

/** "👋 Hi, I'm {name}" in the everyone room, as the person (the room's own send; a second tap is the same message). */
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
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Row id="hi" done={welcome.steps.hi} title={t('memberWelcome.hi')} hint={t('memberWelcome.hiHint', { room })}>
      {welcome.steps.hi ? (
        everyone && <Link to={`/rooms/${everyone.id}`} className={clsx('inline-flex h-8 items-center rounded-lg px-2.5 text-label font-medium text-muted hover:bg-hover hover:text-ink', tap)} data-testid="member-welcome-hi-open">{t('memberWelcome.roomsOpen')}</Link>
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
  return (
    <Row id="photo" done={done} optional title={t('memberWelcome.photo')} hint={t('memberWelcome.photoHint')}>
      {!done && (
        <>
          <Button size="sm" className={tap} busy={busy} onClick={() => pick.current?.click()} data-testid="member-welcome-photo-button">{t('memberWelcome.photoButton')}</Button>
          <input ref={pick} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" tabIndex={-1} aria-hidden data-testid="member-welcome-photo-input" onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = '' }} />
        </>
      )}
    </Row>
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
    const trial = ai.trial && t(trialLine(ai.trial))
    if (ai.action === 'ask_owner') {
      const owner = welcome.owner ? firstName(welcome.owner.name) : null
      return (
        <Row id="ask" done={false} title={t('memberWelcome.noAiAsk', { ai: name })} hint={trial || (owner ? t('memberWelcome.noAiAskHint', { owner }) : t('aiConnect.member'))}>
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
    return (
      <Row id="ask" done={false} title={t('memberWelcome.noAiOwn', { ai: name })} hint={trial || undefined}>
        <ConnectAiButton personal={ai.action === 'connect_own'} panel={ai.action === 'connect_team'} data-testid="member-welcome-connect" data-action={ai.action} />
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
