// The welcome steps for the owner who just made the team (docs/DECISIONS.md "W — Welcome steps", "X — Lean
// onboarding", "W2 — AI connection first", "D2 — The first result is the company's intro deck", "K — 내 스킬
// 가져오기", "W5 — Onboarding v5"): AI 연결 (only while no AI answers the owner) → 회사 소개 → 내 스킬 가져오기 → 팀 파일
// 가져오기 → 팀원 초대 → 준비 끝났어요. The intro deck is no step: 회사 소개's "저장하고 계속" starts it once per team (POST
// /api/onboarding/welcome/first-result makes and records its chat, the page attaches the files and sends "/intro-deck"
// as the owner, like any message), and it builds on the server as an ordinary chat, "우리 회사 소개서", found by its row
// in the sidebar's chat list, named as its heading names it (lib/welcome.ts historyName; the sidebar beside the steps
// from 768px; its marker says how it goes). Nothing about it is on the
// later steps; one line under 회사 소개's button says it starts, about how long, and where it will be. 회사 소개 needs AI,
// so without it the AI step opens in its place, never in front of the later steps; "나중에 하기" there leaves the steps
// (Home shows its connect card, the sidebar's setup row says "AI 연결하기"). Every step can be put off; the progress is
// kept on the server (store/welcome.ts), so the steps resume where they stopped, on any device, from the setup row in
// the sidebar (components/onboarding/SetupRow.tsx) or a landing (W4). The end screen shows once.
//
// Leaving the first step sets up every team once (the general pack and a group named after the team with its folders,
// POST /api/onboarding/welcome/team); the server keeps every guarantee: once, never restoring deleted skills, blocked.
import clsx from 'clsx'
import { ArrowLeft, Check, CircleAlert, ExternalLink, Loader2, Paperclip } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { DECK_TIER_MINUTES, DEFAULT_DECK_TIER, FIRST_RESULT_FILES_MAX, deckMessageId, skillLabel, uuidv7, type CompanyProfile, type FirstResultStarted, type WelcomeProgress, type WelcomeStep, type WelcomeStepState } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { markBusy } from '../lib/busy'
import { joinPath } from '../lib/paths'
import { setupSite } from '../lib/setupLink'
import { skillRunLink } from '../lib/skillForm'
import { rememberChat } from '../lib/teamAttach'
import { uploadFile, type UploadProgress } from '../lib/upload'
import { countedSteps, historyName, inviteSkill, markStepsSeen, needsAi, nextStep, prevStep, resumeStep, skillNameOf, wantsTeam } from '../lib/welcome'
import { useLocale, useT, type MessageKey } from '../i18n'
import { useAiAccess } from '../store/aiAccess'
import { useChats } from '../store/chats'
import { canChooseEngine, isOwner, useMeStrict } from '../store/session'
import { toast } from '../store/ui'
import { useWelcome } from '../store/welcome'
import { ConnectAiButton, ConnectAiPanel } from '../components/onboarding/ConnectAi'
import { InviteStep, sharedForInvite } from '../components/onboarding/InviteStep'
import ProfileStep, { shortUrl } from '../components/onboarding/ProfileStep'
import { SkillsStep } from '../components/onboarding/SkillsStep'
import { TeamFilesStep } from '../components/onboarding/TeamFilesStep'
import { UploadLabel } from '../components/UploadLabel'
import { Button, ErrorNote, Modal, Skeleton, useMediaQuery } from '../components/ui'

export default function Welcome() {
  const me = useMeStrict()
  // the owner made the team and walks through these; anyone else goes Home
  if (!isOwner(me)) return <Navigate to="/" replace />
  return <WelcomeSteps />
}

/** What the page shows: a step, or the end screen ("준비 끝났어요", once). */
type Screen = WelcomeStep | 'done'

const STEP_LABEL: Partial<Record<WelcomeStep, MessageKey>> = { ai: 'welcome.progress.ai', profile: 'welcome.progress.profile', skills: 'welcome.progress.skills', files: 'welcome.progress.files', invite: 'welcome.progress.invite' }

/** A phone: skills live on a computer (내 스킬 가져오기 shows its phone version and can be put off for a computer). */
export const PHONE_QUERY = '(max-width: 767.98px)'

/** At most this many intro files on 회사 소개 ("소개 자료가 있으면 같이 넣기"): a company intro or a deck is enough, and each
 * goes up on its own (the server takes as many: FIRST_RESULT_FILES_MAX). */
export const WELCOME_FILES_MAX = FIRST_RESULT_FILES_MAX

function WelcomeSteps() {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  // the goal card's [팀원 초대] while the steps are unfinished (GoalCard.tsx INVITE_STEP_STATE): the invite step itself,
  // not where the steps would resume (it needs no AI)
  const askedInvite = (useLocation().state as { step?: unknown } | null)?.step === 'invite'
  const me = useMeStrict()
  // the steps were on screen in this tab: a landing on Home does not bring the owner back this session (lib/welcome.ts)
  useEffect(() => { markStepsSeen(me.user.id) }, [me.user.id])
  const progress = useWelcome((s) => s.progress)
  // no AI that answers the owner: the AI step comes first (회사 소개 needs AI)
  const ai = useAiAccess()
  const aiReady = !ai.loaded || ai.usable
  const [step, setStep] = useState<Screen | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const region = useRef<HTMLDivElement>(null)
  const computer = !useMediaQuery(PHONE_QUERY)

  const open = async () => {
    setLoadError(null)
    try {
      const w = useWelcome.getState()
      let p = await w.load(true)
      // the first visit starts the progress, with the setup link's website (the profile step on any device)
      const site = setupSite()
      if (!p || (site && !p.site)) p = await w.update(site ? { site } : {})
      await useAiAccess.getState().load(true)
      // the AI step was shown before and AI answers now (connected from Home, Admin or another tab): done
      if (useAiAccess.getState().usable && p.steps.ai === 'skipped') p = await w.update({ step: { id: 'ai', state: 'done' } })
      const s = askedInvite && !p.finishedAt ? 'invite' : resumeStep(p, useAiAccess.getState().usable, !window.matchMedia?.(PHONE_QUERY).matches)
      if (s) setStep(s)
      else navigate('/', { replace: true })
    } catch (e) {
      setLoadError(e)
    }
  }
  useEffect(() => { void open() }, []) // once, on arrival

  // a new step (not the first): its region takes the focus, so keyboard and screen-reader users hear where they are
  const first = useRef(true)
  useEffect(() => {
    if (!step) return
    if (first.current) { first.current = false; return }
    region.current?.focus()
  }, [step])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try { await fn() } catch (e) { setError(errorText(e, locale, t('error.network'))) } finally { setBusy(false) }
  }
  /** on to the next open step; none left after this one: the end screen the first time, else Home ("설정을 마쳤어요"
   * when that finished the setup: 내 스킬 done on a computer after the phone's end screen) */
  const go = (p: WelcomeProgress, from: WelcomeStep) => {
    const n = nextStep(p, from, computer)
    if (n) return setStep(n)
    if (!p.doneShownAt) return setStep('done')
    if (p.finishedAt) toast({ level: 'success', text: t('welcome.finished') })
    navigate('/')
  }
  const mark = (id: WelcomeStep, state: WelcomeStepState) => run(async () => go(await useWelcome.getState().update({ step: { id, state } }), id))
  /** AI answers now (connected in the dialog, in another tab, or a trial credit arrived): recorded once, so the progress
   * keeps the step, then where the steps resume with AI (an open step, else a counted step that was put off: the one
   * the owner came back for), the end when nothing is left */
  const aiConnected = () => run(async () => {
    const p = await useWelcome.getState().update({ step: { id: 'ai', state: 'done' } })
    const s = resumeStep(p, true, computer)
    if (s) setStep(s)
    else go(p, 'ai')
  })
  useEffect(() => {
    if (!ai.loaded || !ai.usable || busy) return
    if (step === 'ai') void aiConnected()
    // AI back while the AI screen stood in for 회사 소개: that step shows again, the bar's AI step is done
    else if (progress?.steps.ai === 'skipped') void useWelcome.getState().update({ step: { id: 'ai', state: 'done' } }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, ai.loaded, ai.usable])
  // the AI step on screen: recorded once as needed, so the progress keeps it (1/5) after AI is connected anywhere
  const needAi = !!progress && (progress.steps.ai ?? null) === null && ai.loaded && !ai.usable && step !== null && step !== 'done' && (step === 'ai' || needsAi(step))
  useEffect(() => {
    if (needAi) void useWelcome.getState().update({ step: { id: 'ai', state: 'skipped' } }).catch(() => {})
  }, [needAi])
  /** Leaving 회사 소개 (saved, with the intro deck's chat when it started now; or put off): every team's start (the
   * general pack, the team's group and folders), once; then the next step. When the folder rules kept the pack out,
   * nothing of it is recorded and the next step says so. */
  const leaveProfile = (state: WelcomeStepState, chatId: string | null = null) => run(async () => {
    const w = useWelcome.getState()
    let blocked = false
    // a failure here does not hold the owner on this step: the team's files ask again and show why
    if (wantsTeam(w.progress)) blocked = (await w.setupTeam().catch(() => null))?.outcome === 'blocked'
    go(await w.update({ step: { id: 'profile', state }, ...(chatId ? { resultChatId: chatId } : {}) }), 'profile')
    if (blocked) setError(t('welcome.packBlocked'))
  })
  /** 내 스킬 가져오기 shared something: the server recorded the step done (it does for a share applied anywhere); the copy
   * here is read again */
  const applied = () => { void useWelcome.getState().load(true).catch(() => {}) }
  /** the phone's "다음": 내 스킬 waits for a computer (the setup row there says so), the steps go on */
  const skillsLater = () => run(async () => go(await useWelcome.getState().update({ skillsLater: true }), 'skills'))

  if (loadError)
    return (
      <Page>
        <ErrorNote onRetry={() => void open()}>{errorText(loadError, locale, t('error.network'))}</ErrorNote>
      </Page>
    )
  if (!step || !progress)
    return (
      <Page>
        <Skeleton lines={5} />
      </Page>
    )
  // AI went away after the steps started (a key removed, the trial credit used): the AI step holds back 회사 소개
  const gate = step === 'ai' || (!aiReady && step !== 'done' && needsAi(step))
  const back = gate || step === 'done' ? null : prevStep(step)
  const nextLabel = (from: WelcomeStep) => {
    const n = nextStep(progress, from, computer)
    return t(n === 'files' ? 'welcome.next.files' : n === 'invite' ? 'welcome.next.invite' : 'welcome.next.step')
  }
  return (
    <Page>
      <h1 className="text-xs font-medium tracking-wide text-accent-text">{t('welcome.eyebrow')}</h1>
      {step !== 'done' && <Progress progress={progress} step={gate ? 'ai' : step} aiReady={aiReady} />}
      {back && (
        <div className="mt-5 -ml-2.5">
          <Button size="sm" variant="ghost" onClick={() => { setError(null); setStep(back) }} disabled={busy} data-testid="welcome-back">
            <ArrowLeft size={14} aria-hidden /> {t('welcome.back')}
          </Button>
        </div>
      )}
      <div ref={region} tabIndex={-1} className={back ? 'mt-2 outline-none' : 'mt-8 outline-none'} data-step={gate ? 'ai' : step}>
        {gate && <AiStep busy={busy} onLater={() => navigate('/')} />}
        {!gate && step === 'profile' && <ProfileWizardStep progress={progress} busy={busy} onContinue={(chatId) => void leaveProfile('done', chatId)} onSkip={() => void leaveProfile('skipped')} />}
        {!gate && step === 'skills' && (
          <SkillsStep team={progress.teamGroup?.name ?? me.team.name} nextLabel={nextLabel('skills')} busy={busy} onApplied={applied}
            onNext={() => void mark('skills', 'done')} onSkip={() => void mark('skills', 'skipped')} onPhoneNext={() => void skillsLater()} />
        )}
        {!gate && step === 'files' && <TeamFilesStep progress={progress} busy={busy} nextLabel={nextLabel('files')} onDone={(n) => void mark('files', n > 0 ? 'done' : 'skipped')} onSkip={() => void mark('files', 'skipped')} />}
        {!gate && step === 'invite' && <InviteWizardStep progress={progress} onDone={() => void mark('invite', 'done')} onSkip={() => void mark('invite', 'skipped')} />}
        {step === 'done' && <DoneStep progress={progress} aiReady={aiReady} />}
      </div>
      {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
    </Page>
  )
}

/** No frame around the steps: on a phone the page itself is the column. */
function Page({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="welcome">
      <div className="mx-auto w-full max-w-[640px] px-4 pt-6 pb-10 sm:px-6 sm:pt-10">{children}</div>
    </div>
  )
}

/** "1/4 회사 소개 · 2/4 내 스킬 · 3/4 팀 파일 · 4/4 팀원 초대" ("1/5 AI 연결 · …" for an owner who needed AI first):
 * filled up to the step on screen. On a phone only the step on screen is named, under the bars (five names do not fit
 * 390 px); the others stay for screen readers. */
function Progress({ progress, step, aiReady }: { progress: WelcomeProgress; step: WelcomeStep; aiReady: boolean }) {
  const t = useT()
  const list = countedSteps(progress, aiReady)
  // the AI step on screen is on the bar even before it is recorded (gone back to 회사 소개 when AI went away)
  const counted = step === 'ai' && !list.includes('ai') ? ['ai' as const, ...list] : list
  const at = counted.indexOf(step)
  return (
    <>
      <ol className={clsx('mt-3 grid gap-2', COLS[counted.length] ?? 'grid-cols-4')} aria-label={t('welcome.progress.label')} data-testid="welcome-progress">
        {counted.map((s, i) => {
          // the AI step is recorded `skipped` once it was shown (docs/DECISIONS.md "W2"): nothing was put off, it is open
          const state = s === 'ai' && progress.steps.ai === 'skipped' ? null : (progress.steps[s] ?? null)
          return (
            <li key={s} className="min-w-0" aria-current={i === at ? 'step' : undefined} data-progress-step={s}>
              <span aria-hidden className={clsx('block h-1.5 rounded-full', i <= at ? 'bg-accent' : 'bg-hover')} />
              <span className={clsx('mt-1.5 block truncate text-xs max-sm:sr-only', i === at ? 'font-medium text-ink' : 'text-faint')}>
                {t('welcome.progress.item', { n: i + 1, total: counted.length, label: t(STEP_LABEL[s]!) })}
                {state && <span className="sr-only"> · {t(state === 'done' ? 'common.done' : 'welcome.progress.skipped')}</span>}
              </span>
            </li>
          )
        })}
      </ol>
      {at >= 0 && (
        <p aria-hidden className="mt-1.5 text-xs font-medium text-ink sm:hidden" data-testid="welcome-progress-phone">
          {t('welcome.progress.item', { n: at + 1, total: counted.length, label: t(STEP_LABEL[counted[at]!]!) })}
        </p>
      )}
    </>
  )
}

const COLS: Record<number, string> = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4', 5: 'grid-cols-5' }

function StepHead({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="space-y-1">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      {desc && <p className="text-sm text-balance text-muted">{desc}</p>}
    </div>
  )
}

function Later({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  const t = useT()
  return (
    <Button variant="ghost" onClick={onClick} disabled={disabled} data-testid="welcome-later">
      {t('welcome.later')}
    </Button>
  )
}

const quietLink = 'font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink disabled:opacity-50'

/**
 * 회사 소개 (stream D's step, docs/DECISIONS.md "W5"). Without a saved profile: the website (the address typed is kept in
 * the progress as its reading starts, so leaving mid-reading and coming back finds it), its reading (a reading with a
 * one-line intro is saved as it came: autoSave), or the fallbacks; "나중에 하기" puts it off (no deck). A review there
 * (pasted text, the questions, a draft without a one-line intro) asks once: its one button is "저장하고 계속" (saved,
 * then the deck, as below) with the files link above it and the deck line under it. With a saved profile: what was
 * understood ("이렇게 이해했어요: … · 고치기", the review in a dialog, which keeps its plain 저장), the website as a link
 * (a new tab), one quiet "소개 자료가 있으면 같이 넣기" (files into the team's brand folder, for the deck), the one
 * primary "저장하고 계속" and one line under it: the deck starts now, about how long (the team's deck tier), and where it
 * will be (the sidebar's chat list by its heading, historyName; "☰ 메뉴의 …" on a phone, where that list is in the
 * menu). "저장하고 계속" starts the deck once per team: the server answers 409 `deck_started` when one started (saving
 * again only saves) and hands out again a chat it made whose message never went. The line and the files link are gone
 * once a deck started.
 */
function ProfileWizardStep({ progress, busy: stepBusy, onContinue, onSkip }: { progress: WelcomeProgress; busy: boolean; onContinue: (chatId: string | null) => void; onSkip: () => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const phone = useMediaQuery(PHONE_QUERY)
  const [saved, setSaved] = useState<CompanyProfile | null | undefined>(undefined)
  const [minutes, setMinutes] = useState(DECK_TIER_MINUTES[DEFAULT_DECK_TIER])
  useEffect(() => {
    let live = true
    api.call(API.getCompanyProfile).then((r) => live && setSaved(r.profile), () => live && setSaved(null))
    // the team's deck tier says about how long (Admin › Team settings); a failed read keeps the default
    api.call(API.settings).then((s) => live && setMinutes(DECK_TIER_MINUTES[s.introDeckTier] ?? DECK_TIER_MINUTES[DEFAULT_DECK_TIER]), () => {})
    return () => { live = false }
  }, [])
  const files = useIntroFiles(progress)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const started = !!progress.resultChatId

  /** The intro deck, once per team, then on: the server makes the chat (and the intro file without files) and says what
   * to attach; the page sends "/intro-deck …" as the owner, like a skill form's run. Throws what failed. */
  const startDeck = async () => {
    // a reload would lose what is being sent: the page does not reload by itself meanwhile
    const release = markBusy('upload')
    try {
      let r: FirstResultStarted
      try {
        r = await api.call(API.startFirstResult, { body: { files: files.paths } })
      } catch (e) {
        // a deck started already (this tab before, another tab or device): saving again only saves
        if (isApiError(e, 'conflict') && e.body.params?.reason === 'deck_started') { onContinue(null); return }
        throw e
      }
      const chatId = r.chatId
      useChats.getState().upsertChat(await api.call(API.getChat, { params: { id: chatId } }))
      // like a skill form's run: the engine of the person's own choice when they may pick one, else the team's
      const choose = canChooseEngine(me)
      const engine = choose ? me.user.prefs.engine : undefined
      const model = choose ? (me.user.prefs.model ?? null) : undefined
      const attachments = await Promise.all(r.files.map((path) => api.call(API.attachTeamFile, { body: { chatId, path } })))
      // one message id per deck chat: another tab, or a retry here, that got the same chat adds no second message (the
      // server answers with the first one's turn)
      const { sent } = await useChats.getState().send({ chatId, content: `/${skillNameOf(r.skillPath)} ${t('welcome.deck.question')}`, attachments, author: { id: me.user.id, name: me.user.name }, projectId: null, engine, model, clientMessageId: deckMessageId(chatId) })
      // 회사 소개 counts as saved with its deck only once the message is in (the server records the deck then): a send
      // that fails stays here with its reason, and "저장하고 계속" again sends into the same chat
      await sent
      rememberChat(me.user.id, chatId)
      onContinue(chatId)
    } finally {
      release()
    }
  }
  /** the saved state's "저장하고 계속": the deck, its failure in a note with 다시 시도 */
  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      await startDeck()
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(false)
    }
  }
  /** the address typed, kept in the progress as its reading starts (the step opens with it again) */
  const keepSite = (site: string) => {
    if (site !== useWelcome.getState().progress?.site) void useWelcome.getState().update({ site }).catch(() => {})
  }
  // the line right under "저장하고 계속" (the saved state's, and the review's in the steps)
  const deckNote = !started && <p className="text-label leading-5 text-muted" data-testid="welcome-deck-line">{t(phone ? 'welcome.profile.deckLinePhone' : 'welcome.profile.deckLine', { min: minutes, name: historyName(t) })}</p>

  if (saved === undefined) return <Skeleton lines={4} />
  if (!saved)
    return (
      <div data-testid="welcome-profile">
        <ProfileStep initial={null} initialWebsite={progress.site ?? setupSite()} onDone={setSaved} onSkip={onSkip} skipLabel={t('welcome.later')} autoSave onRead={keepSite}
          continueWith={{ label: t('welcome.profile.save'), note: deckNote, extra: !started && <IntroFiles files={files} disabled={stepBusy} />, disabled: stepBusy || files.uploading, onSaved: startDeck }} />
      </div>
    )
  return (
    <div className="space-y-5" data-testid="welcome-profile" data-state="saved">
      <StepHead title={t('onboarding.profile.title')} />
      <div className="space-y-1.5">
        {saved.website && (
          <p className="text-sm">
            <a href={saved.website} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1 text-muted hover:text-ink" data-testid="welcome-profile-site">
              <span className="min-w-0 truncate">{shortUrl(saved.website)}</span>
              <ExternalLink size={13} className="shrink-0" aria-hidden />
            </a>
          </p>
        )}
        <ProfileLine profile={saved} onSaved={setSaved} />
      </div>
      {!started && <IntroFiles files={files} disabled={busy || stepBusy} />}
      {error && <ErrorNote onRetry={busy ? undefined : () => void go()}>{error}</ErrorNote>}
      {/* the line sits right under the button: on a computer 나중에 is beside the button and the line wraps below
          both; on a phone the button, the line, then 나중에 (CSS order, one 나중에 in the page) */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button variant="primary" className="max-sm:w-full" busy={busy} disabled={stepBusy || files.uploading} onClick={() => void go()} data-testid="welcome-profile-continue">
          {t('welcome.profile.save')}
        </Button>
        <span className="ml-auto max-sm:order-3 max-sm:ml-0 max-sm:w-full max-sm:text-center"><Later onClick={onSkip} disabled={busy || stepBusy} /></span>
        {deckNote && <div className="w-full max-sm:order-2">{deckNote}</div>}
      </div>
    </div>
  )
}

/**
 * "이렇게 이해했어요: {한 줄 소개} · 고치기": what the saved company profile says, in one quiet line (the one-line intro,
 * else the first line of what the company sells; with neither: "회사 소개를 저장했어요"). 고치기 opens the full review
 * (the same step as Admin › Team settings) in a dialog; saving there changes the line.
 */
function ProfileLine({ profile, onSaved }: { profile: CompanyProfile; onSaved: (p: CompanyProfile) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const line = profile.oneLine.trim() || (profile.products.split('\n').map((l) => l.trim()).find(Boolean) ?? '')
  return (
    <>
      <p className="text-sm break-words text-muted" data-testid="welcome-profile-line">
        <span data-testid="welcome-profile-understood">{line ? t('onboarding.profile.understood', { line }) : t('welcome.profile.savedPlain')}</span>
        <span aria-hidden> · </span>
        <button type="button" className={quietLink} onClick={() => setOpen(true)} aria-haspopup="dialog" data-testid="welcome-profile-fix">
          {t('onboarding.profile.edit')}
        </button>
      </p>
      <Modal open={open} onClose={() => setOpen(false)} title={t('onboarding.profile.title')} width={640}>
        <ProfileStep initial={profile} onDone={(p) => { onSaved(p); setOpen(false) }} onSkip={() => setOpen(false)} skipLabel={t('onboarding.profile.cancel')} />
      </Modal>
    </>
  )
}

/**
 * AI 연결, only while no AI answers the owner (GET /api/me/ai-access; a hosted trial credit, a managed engine or any
 * working connection skips it). One reason line, then the shared way to connect (components/onboarding/ConnectAi.tsx:
 * "Claude 구독 연결" (추천), "ChatGPT 구독 연결" and "API 키로 연결" at once, and a quiet line to the AI engines page;
 * the same panel is Home's card and the same dialog opens from "AI 연결하기" anywhere). When AI answers, the steps move
 * on by themselves (WelcomeSteps). "나중에
 * 하기" leaves the steps: nothing after this works without AI.
 */
function AiStep({ busy, onLater }: { busy: boolean; onLater: () => void }) {
  const t = useT()
  return (
    <div className="space-y-5" data-testid="welcome-ai">
      <StepHead title={t('welcome.ai.title')} desc={t('welcome.ai.why')} />
      <ConnectAiPanel disabled={busy} />
      <div className="flex justify-end"><Later onClick={onLater} disabled={busy} /></div>
    </div>
  )
}

interface Picked {
  id: string
  file: File
  status: 'waiting' | 'uploading' | 'done' | 'failed'
  progress: UploadProgress | null
  /** where it went (a name already there gets a new one) */
  path: string | null
  error?: string
}

/** 회사 소개's intro files (docs/DECISIONS.md "W5": the first result's file drop before): picked files go up at once into
 * the team's brand folder (groups/<team>/브랜드/, only this team sees it; the team's start first when it is missing),
 * each on its own, a name already there renamed; the deck is made from them. */
function useIntroFiles(progress: WelcomeProgress) {
  const t = useT()
  const locale = useLocale()
  const [items, setItemsState] = useState<Picked[]>([])
  const itemsRef = useRef(items)
  const setItems = (next: Picked[]) => { itemsRef.current = next; setItemsState(next) }
  const patch = (id: string, p: Partial<Picked>) => setItems(itemsRef.current.map((x) => (x.id === id ? { ...x, ...p } : x)))
  const [cut, setCut] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const up = async (list: Picked[]) => {
    setError(null)
    const release = markBusy('upload')
    try {
      const w = useWelcome.getState()
      let p = w.progress ?? progress
      if (wantsTeam(p)) p = (await w.setupTeam()).progress
      const brand = p.teamGroup?.brandFolder
      if (!brand) throw new Error(t('welcome.packBlocked'))
      await Promise.allSettled(list.map(async (x) => {
        patch(x.id, { status: 'uploading', progress: null, error: undefined })
        try {
          const r = await uploadFile(x.file, { kind: 'path', path: joinPath(brand, x.file.name), onExists: 'rename' }, { client: api, onProgress: (progress) => patch(x.id, { progress }) })
          if (r.kind !== 'path') throw new Error('unexpected upload result')
          patch(x.id, { status: 'done', path: r.entry.path, progress: null })
        } catch (e) {
          patch(x.id, { status: 'failed', progress: null, error: errorText(e, locale, t('error.network')) })
        }
      }))
    } catch (e) {
      for (const x of list) patch(x.id, { status: 'failed', progress: null })
      setError(errorText(e, locale, t('error.network')))
    } finally {
      release()
    }
  }
  const pick = (list: File[]) => {
    if (!list.length) return
    const room = WELCOME_FILES_MAX - itemsRef.current.length
    setCut(list.length > room)
    const next = list.slice(0, Math.max(0, room)).map((file): Picked => ({ id: uuidv7(), file, status: 'waiting', progress: null, path: null }))
    if (!next.length) return
    setItems([...itemsRef.current, ...next])
    void up(next)
  }
  const retry = () => void up(itemsRef.current.filter((x) => x.status === 'failed'))
  return {
    items, cut, error, pick, retry,
    uploading: items.some((x) => x.status === 'waiting' || x.status === 'uploading'),
    paths: items.filter((x) => x.status === 'done' && x.path).map((x) => x.path!),
  }
}

/** "소개 자료가 있으면 같이 넣기": one quiet link (the file window; a drop works on a computer too) and what went up. */
function IntroFiles({ files, disabled }: { files: ReturnType<typeof useIntroFiles>; disabled: boolean }) {
  const t = useT()
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files')
  const drop = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    setOver(false)
    if (disabled) return
    // read now (the browser empties the lists when the event ends); a folder is a false file here: files only
    const entries = [...(e.dataTransfer.items ?? [])].map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null))
    files.pick([...e.dataTransfer.files].filter((_, i) => !entries[i]?.isDirectory))
  }
  const failed = files.items.some((x) => x.status === 'failed')
  return (
    <div
      className={clsx('space-y-2 rounded-lg', over && 'ring-2 ring-accent/30 ring-offset-4 ring-offset-bg')}
      onDragOver={(e) => { if (hasFiles(e) && !disabled) { e.preventDefault(); setOver(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false) }}
      onDrop={drop}
      data-testid="welcome-files"
    >
      {/* phones pick files, not folders (no webkitdirectory) */}
      <input ref={input} type="file" multiple className="hidden" onChange={(e) => { const list = [...(e.target.files ?? [])]; e.target.value = ''; files.pick(list) }} data-testid="welcome-files-input" />
      <p className="text-sm">
        <button type="button" className={clsx(quietLink, 'inline-flex items-center gap-1.5')} disabled={disabled} onClick={() => input.current?.click()} data-testid="welcome-files-pick">
          <Paperclip size={14} className="shrink-0 text-faint" aria-hidden /> {t('welcome.profile.files')}
        </button>
      </p>
      {files.items.length > 0 && (
        <ul className="space-y-1 text-sm" aria-label={t('welcome.profile.files')} data-testid="welcome-files-list">
          {files.items.map((x) => (
            <li key={x.id} className="flex min-w-0 items-center gap-2" data-testid="welcome-file" data-status={x.status}>
              {x.status === 'done' ? <Check size={14} className="shrink-0 text-ok" aria-hidden /> : x.status === 'failed' ? <CircleAlert size={14} className="shrink-0 text-danger" aria-hidden /> : <Loader2 size={14} className="shrink-0 animate-spin text-faint" aria-hidden />}
              <span className="min-w-0 truncate text-ink">{x.file.name}</span>
              {x.status === 'uploading' && (
                <span className="shrink-0 text-xs text-faint tabular-nums">
                  <UploadLabel progress={x.progress} busy={t('files.uploadingName', { name: x.file.name })} />
                </span>
              )}
              {x.status === 'done' && <span className="sr-only">{t('files.uploadedName', { name: x.file.name })}</span>}
              {x.status === 'failed' && <span className="min-w-0 truncate text-xs text-danger">{x.error}</span>}
            </li>
          ))}
        </ul>
      )}
      {files.cut && <p className="text-label text-muted" data-testid="welcome-files-cut">{t('welcome.files.max', { n: WELCOME_FILES_MAX })}</p>}
      {(files.error || failed) && <ErrorNote onRetry={files.retry}>{files.error ?? t('welcome.teamFiles.failed')}</ErrorNote>}
    </div>
  )
}

/** The invite (stream E's step): people who join land on the skill everything points at (lib/welcome.ts inviteSkill: the
 * first shared skill; never the intro deck; none: Home), and the message names that one skill. The link is made as
 * the step opens, so the message and its one copy button are there at once (docs/DECISIONS.md "W2"); an open link that
 * leads elsewhere is changed to that skill (same address). */
function InviteWizardStep({ progress, onDone, onSkip }: { progress: WelcomeProgress; onDone: () => void; onSkip: () => void }) {
  useEffect(() => {
    if (!progress.inviteShownAt) void useWelcome.getState().update({ inviteShown: true }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const skillPath = inviteSkill(progress)
  // "들어오면 '{skill}'부터 열려요" also for a landing skill outside the shared list: one option, so no 바꾸기
  const shared = sharedForInvite(progress) ?? (skillPath ? { landing: skillPath, options: [{ path: skillPath, title: '' }], onLanding: () => {} } : null)
  return <InviteStep skillPath={skillPath} retarget={!!skillPath} shared={shared} prepare onDone={onDone} onSkip={onSkip} />
}

/** The end screen's deck line: the server's fact that a deck really started (`deckStarted`: the deck's chat holds the
 * "/intro-deck" message, or a deck build exists), never a recorded chat alone (a first result of a row from before is
 * no deck). An older server without the fact: the recorded chat, as before. */
const deckLine = (p: WelcomeProgress) => p.deckStarted ?? !!p.resultChatId

/**
 * 준비 끝났어요 (docs/DECISIONS.md "W5"), once (`doneShownAt`). When the intro deck started, one line says where it is
 * ("트리나 기록의 '우리 회사 소개서'": the sidebar's heading, historyName; no button: its row has its own marker); without a deck, no line. The one primary is
 * the owner's own run of the skill everything points at ("'{skill}' 먼저 써 보기": the same form a member lands on), or
 * "AI 연결하기" while no AI answers; 홈으로 is a quiet link. With no such skill (nothing shared: docs/DECISIONS.md "DS3")
 * 홈으로 is the one button.
 */
function DoneStep({ progress, aiReady }: { progress: WelcomeProgress; aiReady: boolean }) {
  const t = useT()
  const navigate = useNavigate()
  const phone = useMediaQuery(PHONE_QUERY)
  const path = inviteSkill(progress)
  // never a raw folder name ("quote-maker"): the title, else the name as words (skillLabel)
  const named = (title?: string | null) => (path ? skillLabel({ name: skillNameOf(path), title }) : null)
  const [title, setTitle] = useState<string | null>(() => { const x = progress.shared?.skills.find((s) => s.path === path)?.title; return x ? named(x) : null })
  useEffect(() => {
    if (!progress.doneShownAt) void useWelcome.getState().update({ doneShown: true }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!path || title) return
    let live = true
    api.call(API.listSkills).then((r) => {
      const s = r.items.find((x) => x.path === path)
      if (live) setTitle(s ? skillLabel(s) : named())
    }, () => live && setTitle(named()))
    return () => { live = false }
  }, [path, title])
  const home = () => navigate('/')
  const tryIt = aiReady && !!path
  return (
    <div className="space-y-6" data-testid="welcome-done">
      <StepHead title={t('welcome.done.title')} desc={deckLine(progress) ? t(phone ? 'welcome.done.deckPhone' : 'welcome.done.deck', { name: historyName(t) }) : undefined} />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        {!aiReady ? (
          <ConnectAiButton size="md" panel data-testid="welcome-done-ai" />
        ) : tryIt ? (
          <Button variant="primary" className="max-sm:w-full" disabled={!title} onClick={() => navigate(skillRunLink(path))} data-testid="welcome-done-try">
            {t('welcome.done.try', { skill: title ?? '' })}
          </Button>
        ) : (
          <Button variant="primary" className="max-sm:w-full" onClick={home} data-testid="welcome-done-home">{t('welcome.done.home')}</Button>
        )}
        {(tryIt || !aiReady) && (
          <button type="button" className={clsx(quietLink, 'text-sm max-sm:w-full')} onClick={home} data-testid="welcome-done-home">{t('welcome.done.home')}</button>
        )}
      </div>
    </div>
  )
}
