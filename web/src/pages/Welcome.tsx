// The welcome steps for the owner who just made the team (docs/DECISIONS.md "W — Welcome steps", "X — Lean
// onboarding", "M — One meeting note, everyone's own tasks", "N — The first result is the company's card news", "W2 —
// AI connection first", "V — The first result is the company's promo video", "D2 — The first result is the company's
// intro deck", "K — 내 스킬 가져오기"): AI 연결 (only while no AI answers the owner) → 회사 소개 → 첫 결과 (the intro deck
// starts and builds on the server) → 내 스킬 가져오기 → 팀 파일 가져오기 → the finished deck (its chat, with [팀에 공유]
// under the answer) → the team invite. The steps after 첫 결과 do not wait for the deck: one quiet line above them says
// how it goes and opens it (components/onboarding/DeckStatus.tsx); reaching the end before it is done shows its live
// progress, and the deck opens by itself when it is. 회사 소개 and 첫 결과 need AI, so without it the AI step opens in
// front of them, never in front of the later steps; "나중에 하기" there leaves the steps (Home shows its connect card). 회사 소개 saves a website reading with a one-line intro by
// itself (ProfileStep autoSave) and goes on; 첫 결과 opens with one line of what was saved, "이렇게 이해했어요: … · 고치기",
// whose 고치기 opens the full review in a dialog. The first result is the company's own intro deck: the lead
// drops a company intro or a team deck into the team's brand folder (groups/<team>/브랜드/), or goes on without one
// ("자료 없이 만들게요": the server writes 회사 소개.md there from the website reading); POST
// /api/onboarding/welcome/first-result makes the chat and says which team files to attach, and the general skill
// "/intro-deck" makes the deck from them in that chat, which opens it beside the chat by itself. Under the answer
// the chat offers to share that skill with the
// team (components/onboarding/WelcomeInviteBar.tsx: the invite with it). Every step can be put off; the progress is
// kept on the server (store/welcome.ts), so the steps resume where they stopped, on any device, from the entry on Home.
//
// Leaving the first step sets up every team once (the general pack and a group named after the team with its folders,
// POST /api/onboarding/welcome/team); the server keeps every guarantee: once, never restoring deleted skills, blocked.
// Nothing is asked about the team for it: the marketing pack is one click on Team skills (components/AvailableSkills.tsx).
import clsx from 'clsx'
import { ArrowLeft, Check, CircleAlert, Loader2, Upload } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { FIRST_RESULT_FILES_MAX, uuidv7, type CompanyProfile, type FirstResultStarted, type SkillShare, type WelcomeProgress, type WelcomeStep, type WelcomeStepState } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { markBusy } from '../lib/busy'
import { joinPath } from '../lib/paths'
import { setupSite } from '../lib/setupLink'
import { rememberChat } from '../lib/teamAttach'
import { uploadFile, type UploadProgress } from '../lib/upload'
import { countedSteps, inviteSkill, markStepsSeen, nextStep, prevStep, resumeStep, skillNameOf, teamReach, wantsTeam } from '../lib/welcome'
import { useLocale, useT, type MessageKey } from '../i18n'
import { useAiAccess } from '../store/aiAccess'
import { useChats } from '../store/chats'
import { canChooseEngine, isOwner, useMeStrict } from '../store/session'
import { toast } from '../store/ui'
import { useWelcome } from '../store/welcome'
import { ConnectAiPanel } from '../components/onboarding/ConnectAi'
import { DeckStatusLine, DeckWait, useDeckRun, useOpenDeck } from '../components/onboarding/DeckStatus'
import { InviteStep, sharedForInvite } from '../components/onboarding/InviteStep'
import ProfileStep from '../components/onboarding/ProfileStep'
import { SkillsStep } from '../components/onboarding/SkillsStep'
import { UploadLabel } from '../components/UploadLabel'
import { Button, ErrorNote, Modal, Skeleton, useMediaQuery } from '../components/ui'

export default function Welcome() {
  const me = useMeStrict()
  // the owner made the team and walks through these; anyone else goes Home
  if (!isOwner(me)) return <Navigate to="/" replace />
  return <WelcomeSteps />
}

const STEP_LABEL: Partial<Record<WelcomeStep, MessageKey>> = { ai: 'welcome.progress.ai', profile: 'welcome.progress.profile', result: 'welcome.progress.result', skills: 'welcome.progress.skills', files: 'welcome.progress.files' }

/** The steps that need an AI that answers the owner (the AI step stands in for them without one). */
const needsAi = (s: WelcomeStep) => s === 'profile' || s === 'result'

/** A phone: skills live on a computer (내 스킬 가져오기 shows its phone version and can be put off for a computer). */
export const PHONE_QUERY = '(max-width: 767.98px)'

/** At most this many files in one go: a company intro or a deck is enough, and each goes up on its own (the server
 * takes as many: FIRST_RESULT_FILES_MAX). */
export const WELCOME_FILES_MAX = FIRST_RESULT_FILES_MAX

function WelcomeSteps() {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  const me = useMeStrict()
  // the steps were on screen in this tab: a landing on Home does not bring the owner back this session (lib/welcome.ts)
  useEffect(() => { markStepsSeen(me.user.id) }, [me.user.id])
  const progress = useWelcome((s) => s.progress)
  // no AI that answers the owner: the AI step comes first (every later step needs AI)
  const ai = useAiAccess()
  const aiReady = !ai.loaded || ai.usable
  const [step, setStep] = useState<WelcomeStep | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  // the saved company profile as the first result's line shows it (undefined: not read yet)
  const [profile, setProfile] = useState<CompanyProfile | null | undefined>(undefined)
  const region = useRef<HTMLDivElement>(null)
  const computer = !useMediaQuery(PHONE_QUERY)
  // the intro deck building on the server behind the steps after 첫 결과 (its chat), and what it says now
  const deckChat = progress?.steps.result === 'done' ? progress.resultChatId : null
  const openDeck = useOpenDeck()
  // came to the invite through the steps in this tab (not a landing on it): the finished deck opens by itself
  const throughSteps = useRef(false)
  // "먼저 팀원 초대하기": the invite without waiting for the deck
  const [noWait, setNoWait] = useState(false)
  const noWaitRef = useRef(noWait)
  noWaitRef.current = noWait
  const stepRef = useRef(step)
  stepRef.current = step
  const deck = useDeckRun(deckChat, (run) => {
    if (run.state !== 'done' || !deckChat) return
    // waiting on its progress at the end of the steps: the deck opens; anywhere else the line says so with a toast
    if (stepRef.current === 'invite' && throughSteps.current && !noWaitRef.current) openDeck(deckChat)
    else toast({ level: 'success', text: t('welcome.deck.ready'), action: { label: t('welcome.deck.open'), run: () => openDeck(deckChat) } })
  })

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
      const s = resumeStep(p, useAiAccess.getState().usable, !window.matchMedia?.(PHONE_QUERY).matches)
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
  /** on to the next open step; none left after this one: Home (a step put off never comes straight back). The end of the
   * steps with the intro deck started: the deck when it is done (its chat, [팀에 공유] under it), else its live progress
   * on the invite step until it is (DeckWait). */
  const go = (p: WelcomeProgress, from: WelcomeStep) => {
    const n = nextStep(p, from, computer)
    if (n === 'invite' && from !== 'ai') throughSteps.current = true
    if (n === 'invite' && p.steps.result === 'done' && p.resultChatId && deck.state === 'done' && !noWait) return openDeck(p.resultChatId)
    if (n) return setStep(n)
    if (p.finishedAt) toast({ level: 'success', text: t('welcome.finished') })
    navigate('/')
  }
  const mark = (id: WelcomeStep, state: WelcomeStepState) => run(async () => go(await useWelcome.getState().update({ step: { id, state } }), id))
  /** AI answers now (connected in the dialog, in another tab, or a trial credit arrived): recorded once, so the progress
   * keeps the step, then where the steps resume with AI (an open step, else a counted step that was put off: the one
   * the owner came back for), Home when nothing is left */
  const aiConnected = () => run(async () => {
    const p = await useWelcome.getState().update({ step: { id: 'ai', state: 'done' } })
    const s = resumeStep(p, true, computer)
    if (s) setStep(s)
    else go(p, 'ai')
  })
  useEffect(() => {
    if (!ai.loaded || !ai.usable || busy) return
    if (step === 'ai') void aiConnected()
    // AI back while the AI screen stood in for 회사 소개 or 첫 결과: that step shows again, the bar's AI step is done
    else if (progress?.steps.ai === 'skipped') void useWelcome.getState().update({ step: { id: 'ai', state: 'done' } }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, ai.loaded, ai.usable])
  // the AI step on screen: recorded once as needed, so the progress keeps it (1/3) after AI is connected anywhere
  const needAi = !!progress && (progress.steps.ai ?? null) === null && ai.loaded && !ai.usable && step !== null && (step === 'ai' || needsAi(step))
  useEffect(() => {
    if (needAi) void useWelcome.getState().update({ step: { id: 'ai', state: 'skipped' } }).catch(() => {})
  }, [needAi])
  /** Leaving the first step (saved or put off): every team's start (the general pack, the team's group and folders),
   * once; then the next step. When the folder rules kept the pack out, nothing of it is recorded and the step says so;
   * the first result tries the team's start again. */
  const leaveProfile = (state: WelcomeStepState) => run(async () => {
    const w = useWelcome.getState()
    let blocked = false
    // a failure here does not hold the owner on this step: picking files asks again and shows why
    if (wantsTeam(w.progress)) blocked = (await w.setupTeam().catch(() => null))?.outcome === 'blocked'
    go(await w.update({ step: { id: 'profile', state } }), 'profile')
    if (blocked) setError(t('welcome.packBlocked'))
  })
  /** The intro deck started (its message is in, it builds on the server): recorded, and the steps go on at once. Without
   * the record (a failed save) its chat opens instead, as before: the deck is not lost either way. */
  const ran = (chatId: string) => run(async () => {
    const p = await useWelcome.getState().update({ step: { id: 'result', state: 'done' }, resultChatId: chatId }).catch(() => null)
    if (!p) return navigate(`/c/${chatId}`)
    go(p, 'result')
  })
  /** 내 스킬 가져오기 shared something: recorded as done at once (a reload keeps it); the step shows what went in */
  const shared = (_share: SkillShare) => { void useWelcome.getState().update({ step: { id: 'skills', state: 'done' } }).catch(() => {}) }
  /** the phone's "다음": 내 스킬 waits for a computer (Home's row there says so), the steps go on */
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
  // AI went away after the steps started (a key removed, the trial credit used): the AI step holds back the steps that
  // need it
  const gate = step === 'ai' || (!aiReady && needsAi(step))
  // the end of the steps while the deck still builds: its live progress first (not on a landing straight onto the
  // invite: the line above it says how the deck goes)
  const waiting = !gate && step === 'invite' && !!deckChat && throughSteps.current && !noWait && (deck.state === 'building' || deck.state === 'unknown' || deck.state === 'failed')
  const back = gate || waiting ? null : prevStep(step, progress)
  const nextLabel = (from: WelcomeStep) => {
    const n = nextStep(progress, from, computer)
    return t(n === 'files' ? 'welcome.next.files' : n === 'invite' || n === null ? 'welcome.next.invite' : 'welcome.next.step')
  }
  return (
    <Page>
      <h1 className="text-xs font-medium tracking-wide text-accent-text">{t('welcome.eyebrow')}</h1>
      <Progress progress={progress} step={gate ? 'ai' : step} aiReady={aiReady} />
      {deckChat && !gate && !waiting && step !== 'result' && <DeckStatusLine run={deck} chatId={deckChat} />}
      {back && (
        <div className="mt-5 -ml-2.5">
          <Button size="sm" variant="ghost" onClick={() => { setError(null); setStep(back) }} disabled={busy} data-testid="welcome-back">
            <ArrowLeft size={14} aria-hidden /> {t('welcome.back')}
          </Button>
        </div>
      )}
      <div ref={region} tabIndex={-1} className={back ? 'mt-2 outline-none' : 'mt-8 outline-none'} data-step={gate ? 'ai' : waiting ? 'deck' : step}>
        {gate && <AiStep busy={busy} onLater={() => navigate('/')} />}
        {!gate && step === 'profile' && <ProfileWizardStep progress={progress} onDone={(p) => { setProfile(p); void leaveProfile('done') }} onSkip={() => void leaveProfile('skipped')} />}
        {!gate && step === 'result' && <ResultStep progress={progress} busy={busy} profile={profile} onProfile={setProfile} onRan={(id) => void ran(id)} onSkip={() => void mark('result', 'skipped')} />}
        {!gate && step === 'skills' && (
          <SkillsStep team={progress.teamGroup?.name ?? me.team.name} nextLabel={nextLabel('skills')} busy={busy} onApplied={shared}
            onNext={() => void mark('skills', 'done')} onSkip={() => void mark('skills', 'skipped')} onPhoneNext={() => void skillsLater()} />
        )}
        {!gate && step === 'files' && <TeamFilesStep progress={progress} busy={busy} nextLabel={nextLabel('files')} onDone={(n) => void mark('files', n > 0 ? 'done' : 'skipped')} onSkip={() => void mark('files', 'skipped')} />}
        {waiting && deckChat && <DeckWait run={deck} chatId={deckChat} onInvite={() => setNoWait(true)} />}
        {!gate && !waiting && step === 'invite' && <InviteWizardStep progress={progress} onDone={() => void mark('invite', 'done')} onSkip={() => void mark('invite', 'skipped')} />}
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

/** "1/4 회사 소개 · 2/4 첫 결과 · 3/4 내 스킬 · 4/4 팀 파일" ("1/5 AI 연결 · …" for an owner who needed AI first): filled
 * up to the step on screen (all of them on the invite). On a phone only the step on screen is named, under the bars
 * (five names do not fit 390 px); the others stay for screen readers. */
function Progress({ progress, step, aiReady }: { progress: WelcomeProgress; step: WelcomeStep; aiReady: boolean }) {
  const t = useT()
  const list = countedSteps(progress, aiReady)
  // the AI step on screen is on the bar even before it is recorded (gone back from the invite to a step that needs AI)
  const counted = step === 'ai' && !list.includes('ai') ? ['ai' as const, ...list] : list
  const at = step === 'invite' ? counted.length : counted.indexOf(step)
  return (
    <>
      <ol className={clsx('mt-3 grid gap-2', COLS[counted.length] ?? 'grid-cols-4')} aria-label={t('welcome.progress.label')} data-testid="welcome-progress">
        {counted.map((s, i) => {
          const state = progress.steps[s] ?? null
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
      {at < counted.length && (
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

/** 1/2 the company profile (stream D's step), starting from the saved profile or the setup link's website. A website
 * reading with a one-line intro is saved without the review (autoSave): the first result shows it and offers 고치기. */
function ProfileWizardStep({ progress, onDone, onSkip }: { progress: WelcomeProgress; onDone: (p: CompanyProfile) => void; onSkip: () => void }) {
  const t = useT()
  const [saved, setSaved] = useState<CompanyProfile | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    api.call(API.getCompanyProfile).then((r) => live && setSaved(r.profile), () => live && setSaved(null))
    return () => { live = false }
  }, [])
  if (saved === undefined) return <Skeleton lines={4} />
  return (
    <div data-testid="welcome-profile">
      <ProfileStep initial={saved} initialWebsite={progress.site ?? setupSite()} onDone={onDone} onSkip={onSkip} skipLabel={t('welcome.later')} autoSave />
    </div>
  )
}

/** The first result, for every team: the company's intro deck, from the files the lead drops into the team's brand
 * folder or, without any, from the website reading. AI is asked for again here (a run without it would only fail in
 * the chat): without it the AI step comes back (WelcomeSteps' gate). On top, the line of the saved profile. */
function ResultStep({ progress, busy, profile, onProfile, onRan }: { progress: WelcomeProgress; busy: boolean; profile: CompanyProfile | null | undefined; onProfile: (p: CompanyProfile | null) => void; onRan: (chatId: string) => void; onSkip: () => void }) {
  const ai = useAiAccess()
  useEffect(() => { void ai.load(true) }, [ai.load])
  // the profile saved before (another visit, another device): read once; none or a failed read: no line
  useEffect(() => {
    if (profile !== undefined) return
    let live = true
    api.call(API.getCompanyProfile).then((r) => live && onProfile(r.profile), () => live && onProfile(null))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!ai.loaded || profile === undefined) return <Skeleton lines={4} />
  return (
    <>
      {profile && <ProfileLine profile={profile} onSaved={onProfile} />}
      <FilesStep progress={progress} busy={busy} onRan={onRan} />
    </>
  )
}

/**
 * Above the first result, one quiet line of what the company profile says: "이렇게 이해했어요: {한 줄 소개} · 고치기".
 * Here because the website reading went straight on (saved without the review), and the intro deck without files is
 * made from that profile: the owner sees what was kept before anything is made from it. 고치기 opens the full review
 * (the same step as Admin › Team settings) in a dialog; saving there changes the line. No one-line intro: no line.
 */
function ProfileLine({ profile, onSaved }: { profile: CompanyProfile; onSaved: (p: CompanyProfile) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const line = profile.oneLine.trim()
  if (!line) return null
  return (
    <>
      <p className="mb-5 text-sm break-words text-muted" data-testid="welcome-profile-line">
        <span data-testid="welcome-profile-understood">{t('onboarding.profile.understood', { line })}</span>
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

/** "여기 올린 파일은 {팀} n명만 봐요 · 채팅은 각자만 봐요", with the real count (the group's members and the owners and
 * admins), and, when members of the team are not in its group yet, one quiet "지금 있는 팀원 n명도 넣기" that adds them
 * (the owner's choice: nobody is added by itself). Until the count is known, or when it cannot be read, the line
 * without a number. The owner alone reads "지금은 나만 봐요 · 팀원을 초대하면 {팀} 모두가 봐요" ("{팀} 1명만 봐요" read
 * oddly: docs/DECISIONS.md "W3"). */
function TeamReach({ team, groupId }: { team: string; groupId: string | null }) {
  const t = useT()
  const locale = useLocale()
  const [reach, setReach] = useState<{ viewers: number; outside: string[]; memberIds: string[] } | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = async (id: string) => {
    const [users, groups] = await Promise.all([api.call(API.listUsers), api.call(API.listGroups)])
    const group = groups.items.find((g) => g.id === id)
    if (!group) return setReach(null)
    setReach({ ...teamReach(users.items, group.memberIds), memberIds: group.memberIds })
  }
  useEffect(() => {
    if (!groupId) return
    void load(groupId).catch(() => setReach(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId])
  const add = async () => {
    if (!groupId || !reach) return
    setAdding(true)
    setError(null)
    try {
      await api.call(API.updateGroup, { params: { id: groupId }, body: { memberIds: [...new Set([...reach.memberIds, ...reach.outside])] } })
      await load(groupId)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setAdding(false)
    }
  }
  return (
    <div className="space-y-1">
      <p className="text-label leading-5 text-muted" data-testid="welcome-files-who">
        {!reach ? t('welcome.files.who', { team }) : reach.viewers <= 1 ? t('welcome.files.whoAlone', { team }) : t('welcome.files.whoCount', { team, n: reach.viewers })}
      </p>
      {reach && reach.outside.length > 0 && (
        <p className="text-label">
          <button type="button" className={quietLink} disabled={adding} onClick={() => void add()} data-testid="welcome-files-add-members">
            {t('welcome.files.addMembers', { n: reach.outside.length })}
          </button>
        </p>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
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

/** The company's intro deck (docs/DECISIONS.md "D2"; the promo video of "V" and the card news of "N" before it): the
 * files the lead picks go into the team's brand folder (groups/<team>/브랜드/, only this team sees it), then the server
 * starts the first result (POST /api/onboarding/welcome/first-result: its chat, the team files to attach, the skill) and
 * "/intro-deck 우리 회사 소개서 만들어 줘" goes into that chat with the files attached by reference. "자료 없이
 * 만들게요" is the same without files: the server writes 회사 소개.md from the website reading and gives that to attach.
 * One primary action (pick files; a drop works too on a computer), one quiet line on who sees what, one text link
 * without files. */
function FilesStep({ progress, busy: stepBusy, onRan }: { progress: WelcomeProgress; busy: boolean; onRan: (chatId: string) => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const input = useRef<HTMLInputElement>(null)
  const [items, setItemsState] = useState<Picked[]>([])
  const itemsRef = useRef(items)
  const setItems = (next: Picked[]) => { itemsRef.current = next; setItemsState(next) }
  const patch = (id: string, p: Partial<Picked>) => setItems(itemsRef.current.map((x) => (x.id === id ? { ...x, ...p } : x)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cut, setCut] = useState(false)
  const [over, setOver] = useState(false)
  // the first result the server started for these files: a retry after a later failure sends into the same chat
  const started = useRef<{ key: string; r: FirstResultStarted } | null>(null)
  // what "다시 시도" repeats: with the picked files, or without any
  const withFiles = useRef(true)
  const team = progress.teamGroup?.name ?? me.team.name

  /** Up (the ones not up yet), then the first result with them. A failure keeps the files on screen for "다시 시도". */
  const run = async () => {
    setBusy(true)
    setError(null)
    // a reload would lose the picked files: the page does not reload by itself meanwhile
    const release = markBusy('upload')
    try {
      const w = useWelcome.getState()
      let p = w.progress ?? progress
      // an older row, or a start that failed when the first step was left: the team's folders and skills first
      if (wantsTeam(p)) p = (await w.setupTeam()).progress
      const brand = p.teamGroup?.brandFolder
      if (!brand || !p.general) throw new Error(t('welcome.packBlocked'))
      if (withFiles.current) {
        const results = await Promise.allSettled(itemsRef.current.filter((x) => x.status !== 'done').map(async (x) => {
          patch(x.id, { status: 'uploading', progress: null, error: undefined })
          try {
            const r = await uploadFile(x.file, { kind: 'path', path: joinPath(brand, x.file.name), onExists: 'rename' }, { client: api, onProgress: (progress) => patch(x.id, { progress }) })
            if (r.kind !== 'path') throw new Error('unexpected upload result')
            patch(x.id, { status: 'done', path: r.entry.path, progress: null })
          } catch (e) {
            patch(x.id, { status: 'failed', progress: null, error: errorText(e, locale, t('error.network')) })
            throw e
          }
        }))
        const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
        if (failed) throw failed.reason
      }
      const files = withFiles.current ? itemsRef.current.map((x) => x.path!) : []
      const key = files.join('\n')
      // the server makes the chat, the intro when there is no file, and says what
      // to attach; it may refuse with its own words (no profile and no website yet, the skill kept out)
      if (started.current?.key !== key) started.current = { key, r: await api.call(API.startFirstResult, { body: { files } }) }
      const r = started.current.r
      const chatId = r.chatId
      useChats.getState().upsertChat(await api.call(API.getChat, { params: { id: chatId } }))
      // like a skill form's run: the engine of the person's own choice when they may pick one, else the team's
      const choose = canChooseEngine(me)
      const engine = choose ? me.user.prefs.engine : undefined
      const model = choose ? (me.user.prefs.model ?? null) : undefined
      const attachments = await Promise.all(r.files.map((path) => api.call(API.attachTeamFile, { body: { chatId, path } })))
      await useChats.getState().send({ chatId, content: `/${skillNameOf(r.skillPath)} ${t('welcome.deck.question')}`, attachments, author: { id: me.user.id, name: me.user.name }, projectId: null, engine, model })
      rememberChat(me.user.id, chatId)
      onRan(chatId)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      release()
      setBusy(false)
    }
  }
  const pick = (list: File[]) => {
    if (!list.length || busy) return
    withFiles.current = true
    setCut(list.length > WELCOME_FILES_MAX)
    setItems(list.slice(0, WELCOME_FILES_MAX).map((file) => ({ id: uuidv7(), file, status: 'waiting', progress: null, path: null })))
    void run()
  }
  /** "자료 없이 만들게요": files picked before (one that failed, say) are left aside */
  const none = () => {
    if (busy) return
    withFiles.current = false
    setCut(false)
    setItems([])
    void run()
  }
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files')
  const drop = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    setOver(false)
    // read now (the browser empties the lists when the event ends); a folder is a false file here: files only
    const entries = [...(e.dataTransfer.items ?? [])].map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null))
    pick([...e.dataTransfer.files].filter((_, i) => !entries[i]?.isDirectory))
  }

  return (
    <div
      className={clsx('space-y-5 rounded-xl', over && 'ring-2 ring-accent/30')}
      onDragOver={(e) => { if (hasFiles(e) && !busy) { e.preventDefault(); setOver(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false) }}
      onDrop={drop}
      data-testid="welcome-result"
    >
      <StepHead title={t('welcome.cardnews.title')} desc={t('welcome.cardnews.desc')} />
      <div className="space-y-3" data-testid="welcome-files">
        {/* phones pick files, not folders (no webkitdirectory) */}
        <input ref={input} type="file" multiple className="hidden" onChange={(e) => { const list = [...(e.target.files ?? [])]; e.target.value = ''; pick(list) }} data-testid="welcome-files-input" />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" className="max-sm:w-full" busy={busy} disabled={stepBusy} onClick={() => input.current?.click()} data-testid="welcome-files-pick">
            <Upload size={14} aria-hidden /> {t('welcome.files.pick')}
          </Button>
          <span className="text-sm text-faint max-sm:hidden">{t('welcome.files.dropHint')}</span>
        </div>
        <TeamReach team={team} groupId={progress.teamGroup?.id ?? null} />
        {items.length > 0 && (
          <ul className="space-y-1 text-sm" aria-label={t('welcome.cardnews.title')} data-testid="welcome-files-list">
            {items.map((x) => (
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
        {cut && <p className="text-label text-muted" data-testid="welcome-files-cut">{t('welcome.files.max', { n: WELCOME_FILES_MAX })}</p>}
        {error && <ErrorNote onRetry={busy ? undefined : () => void run()}>{error}</ErrorNote>}
      </div>
      <p className="text-sm">
        <button type="button" className={quietLink} disabled={busy || stepBusy} onClick={none} data-testid="welcome-files-none">
          {t('welcome.cardnews.none')}
        </button>
      </p>
    </div>
  )
}

/** Files one pick takes in 팀 파일 가져오기 (each goes up on its own; more in another pick or later in Files). */
export const TEAM_FILES_MAX = 20

/** A group folder the team's files can go to: the team's own first, then the other groups' folders the owner made. */
interface Place { groupId: string; name: string; folder: string }

/**
 * 팀 파일 가져오기 (docs/DECISIONS.md "K"): the team's documents (a company intro, past reports, forms) into the team's
 * own folder, or another group's, while the intro deck builds. The same pieces as the first result's files: one
 * primary (pick files; a drop works too on a computer), each file up on its own through the normal upload into that
 * folder (its folder rules decide; a name already there gets a new one), and the who-sees line of that group
 * (TeamReach). "나중에 하기" goes on; after files went in, the primary is the next step.
 */
function TeamFilesStep({ progress, busy: stepBusy, nextLabel, onDone, onSkip }: { progress: WelcomeProgress; busy: boolean; nextLabel: string; onDone: (n: number) => void; onSkip: () => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const input = useRef<HTMLInputElement>(null)
  const [items, setItemsState] = useState<Picked[]>([])
  const itemsRef = useRef(items)
  const setItems = (next: Picked[]) => { itemsRef.current = next; setItemsState(next) }
  const patch = (id: string, p: Partial<Picked>) => setItems(itemsRef.current.map((x) => (x.id === id ? { ...x, ...p } : x)))
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const [cut, setCut] = useState(false)
  const team = progress.teamGroup
  // the team's own folder, and other groups' folders (Admin's folder list knows which folder is whose)
  const [places, setPlaces] = useState<Place[]>(() => (team ? [{ groupId: team.id, name: team.name, folder: team.folder }] : []))
  const [placeId, setPlaceId] = useState<string | null>(team?.id ?? null)
  useEffect(() => {
    let live = true
    void Promise.all([api.call(API.listGroups), api.call(API.listFolders)]).then(([groups, folders]) => {
      if (!live) return
      const other = groups.items.filter((g) => g.id !== team?.id).flatMap((g) => {
        const f = folders.items.find((x) => x.groupId === g.id && x.exists)
        return f ? [{ groupId: g.id, name: g.name, folder: f.path }] : []
      })
      setPlaces((p) => [...p.filter((x) => x.groupId === team?.id), ...other])
      setPlaceId((id) => id ?? other[0]?.groupId ?? null)
    }, () => {})
    return () => { live = false }
  }, [team?.id])
  const place = places.find((p) => p.groupId === placeId) ?? null
  const done = items.filter((x) => x.status === 'done').length

  const send = async (list: Picked[], folder: string) => {
    setBusy(true)
    const release = markBusy('upload')
    try {
      await Promise.allSettled(list.map(async (x) => {
        patch(x.id, { status: 'uploading', progress: null, error: undefined })
        try {
          const r = await uploadFile(x.file, { kind: 'path', path: joinPath(folder, x.file.name), onExists: 'rename' }, { client: api, onProgress: (progress) => patch(x.id, { progress }) })
          if (r.kind !== 'path') throw new Error('unexpected upload result')
          patch(x.id, { status: 'done', path: r.entry.path, progress: null })
        } catch (e) {
          patch(x.id, { status: 'failed', progress: null, error: errorText(e, locale, t('error.network')) })
        }
      }))
    } finally {
      release()
      setBusy(false)
    }
  }
  const pick = (list: File[]) => {
    if (!list.length || busy || !place) return
    setCut(list.length > TEAM_FILES_MAX)
    const next = list.slice(0, TEAM_FILES_MAX).map((file): Picked => ({ id: uuidv7(), file, status: 'waiting', progress: null, path: null }))
    setItems([...itemsRef.current, ...next])
    void send(next, place.folder)
  }
  const retry = () => { if (place) void send(itemsRef.current.filter((x) => x.status === 'failed'), place.folder) }
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files')
  const drop = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    setOver(false)
    // read now (the browser empties the lists when the event ends); a folder is a false file here: files only
    const entries = [...(e.dataTransfer.items ?? [])].map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null))
    pick([...e.dataTransfer.files].filter((_, i) => !entries[i]?.isDirectory))
  }
  const failed = items.some((x) => x.status === 'failed')

  return (
    <div
      className={clsx('space-y-5 rounded-xl', over && 'ring-2 ring-accent/30')}
      onDragOver={(e) => { if (hasFiles(e) && !busy && place) { e.preventDefault(); setOver(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false) }}
      onDrop={drop}
      data-testid="welcome-team-files"
    >
      <StepHead title={t('welcome.teamFiles.title')} desc={t('welcome.teamFiles.desc')} />
      <div className="space-y-3">
        <input ref={input} type="file" multiple className="hidden" onChange={(e) => { const list = [...(e.target.files ?? [])]; e.target.value = ''; pick(list) }} data-testid="welcome-team-files-input" />
        {places.length > 1 && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <label htmlFor="welcome-team-files-place">{t('welcome.teamFiles.where')}</label>
            <select id="welcome-team-files-place" className="h-8 rounded-lg border border-field-border bg-surface px-2 text-sm text-ink" value={placeId ?? ''} disabled={busy} onChange={(e) => setPlaceId(e.target.value)} data-testid="welcome-team-files-place">
              {places.map((p) => <option key={p.groupId} value={p.groupId}>{t('welcome.files.homeFolder', { team: p.name })}</option>)}
            </select>
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant={done ? 'secondary' : 'primary'} className="max-sm:w-full" busy={busy} disabled={stepBusy || !place} onClick={() => input.current?.click()} data-testid="welcome-team-files-pick">
            <Upload size={14} aria-hidden /> {t(done ? 'welcome.teamFiles.more' : 'welcome.files.pick')}
          </Button>
          <span className="text-sm text-faint max-sm:hidden">{t('welcome.files.dropHint')}</span>
        </div>
        {place ? <TeamReach team={place.name} groupId={place.groupId} /> : <p className="text-label text-muted">{t('welcome.teamFiles.noFolder')}</p>}
        {items.length > 0 && (
          <ul className="space-y-1 text-sm" aria-label={t('welcome.teamFiles.title')} data-testid="welcome-team-files-list">
            {items.map((x) => (
              <li key={x.id} className="flex min-w-0 items-center gap-2" data-testid="welcome-team-file" data-status={x.status}>
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
        {cut && <p className="text-label text-muted" data-testid="welcome-team-files-cut">{t('welcome.files.max', { n: TEAM_FILES_MAX })}</p>}
        {failed && !busy && <ErrorNote onRetry={retry}>{t('welcome.teamFiles.failed')}</ErrorNote>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {done > 0 ? (
          <Button variant="primary" className="max-sm:w-full" disabled={busy || stepBusy} onClick={() => onDone(done)} data-testid="welcome-team-files-next">
            {nextLabel}
          </Button>
        ) : <span />}
        <Later onClick={onSkip} disabled={busy || stepBusy} />
      </div>
      {done > 0 && <p className="sr-only" aria-live="polite">{t('welcome.teamFiles.added', { n: done, folder: place?.name ?? me.team.name })}</p>}
    </div>
  )
}

/** Then the invite (stream E's step) when the steps open on it (the bar under the first result was left for later):
 * people who join land on the first result's skill, the intro deck, as it is (lib/welcome.ts inviteSkill). The link
 * is made as the step opens, so the message and its one copy button are there at once (docs/DECISIONS.md "W2"); once
 * the result was made, an open link that leads elsewhere is changed to that skill (same address). */
function InviteWizardStep({ progress, onDone, onSkip }: { progress: WelcomeProgress; onDone: () => void; onSkip: () => void }) {
  useEffect(() => {
    if (!progress.inviteShownAt) void useWelcome.getState().update({ inviteShown: true }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const skillPath = inviteSkill(progress)
  return <InviteStep skillPath={skillPath} retarget={(progress.steps.result === 'done' || !!progress.shared?.landing) && !!skillPath} shared={sharedForInvite(progress)} prepare onDone={onDone} onSkip={onSkip} />
}
