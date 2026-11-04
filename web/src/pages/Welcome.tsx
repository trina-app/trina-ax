// The welcome steps for the owner who just made the team (docs/DECISIONS.md "W — Welcome steps"): 1/3 팀 유형 → 2/3 회사
// 소개 → 3/3 첫 결과, then the team invite. A first useful result in about ten minutes without uploading a file or
// connecting an AI (a hosted trial answers on its credit): the marketing pack's ad copy, filled in from the company
// profile. Running it opens the chat with the answer; that chat offers the invite (components/onboarding/
// WelcomeInviteBar.tsx). Every step can be put off ("나중에 하기"); the progress is kept on the server
// (store/welcome.ts), so the steps resume where they stopped, on any device, from the entry on Home.
import clsx from 'clsx'
import { ArrowLeft, Briefcase, Handshake, Megaphone, Shapes } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { TEAM_TYPE_PACK, TEAM_TYPES, WELCOME_COUNTED, WELCOME_STEPS, type CompanyProfile, type SkillPackInstallResult, type TeamType, type WelcomeProgress, type WelcomeStep, type WelcomeStepState } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { setupSite } from '../lib/setupLink'
import { nextStep, prevStep, resumeStep } from '../lib/welcome'
import { useLocale, useT, type MessageKey } from '../i18n'
import { useAiAccess } from '../store/aiAccess'
import { isOwner, useMeStrict } from '../store/session'
import { toast } from '../store/ui'
import { useWelcome } from '../store/welcome'
import AiAccessBanner from '../components/chat/AiAccessBanner'
import { InviteStep } from '../components/onboarding/InviteStep'
import ProfileStep from '../components/onboarding/ProfileStep'
import { SkillForm } from '../components/skills/SkillForm'
import { Button, ErrorNote, Skeleton } from '../components/ui'

export default function Welcome() {
  const me = useMeStrict()
  // the owner made the team and walks through these; anyone else goes Home
  if (!isOwner(me)) return <Navigate to="/" replace />
  return <WelcomeSteps />
}

const TEAM_ICON = { marketing: Megaphone, sales: Handshake, operations: Briefcase, other: Shapes } as const
const STEP_LABEL: Record<(typeof WELCOME_COUNTED)[number], MessageKey> = { team: 'welcome.progress.team', profile: 'welcome.progress.profile', result: 'welcome.progress.result' }

/** "마케팅 스킬 7개와 팀 폴더를 넣었어요" */
const installedText = (t: ReturnType<typeof useT>, r: SkillPackInstallResult) => t('welcome.team.installed', { n: r.skills.filter((s) => s.status !== 'blocked').length })

function WelcomeSteps() {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  const progress = useWelcome((s) => s.progress)
  const [step, setStep] = useState<WelcomeStep | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const region = useRef<HTMLDivElement>(null)

  const open = async () => {
    setLoadError(null)
    try {
      const w = useWelcome.getState()
      let p = await w.load(true)
      // the first visit starts the progress, with the setup link's website (the profile step on any device)
      const site = setupSite()
      if (!p || (site && !p.site)) p = await w.update(site ? { site } : {})
      const s = resumeStep(p)
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
  /** on to the next open step; none left after this one: Home (a step put off never comes straight back) */
  const go = (p: WelcomeProgress, from: WelcomeStep) => {
    const n = nextStep(p, from)
    if (n) return setStep(n)
    if (p.finishedAt) toast({ level: 'success', text: t('welcome.finished') })
    navigate('/')
  }
  const mark = (id: WelcomeStep, state: WelcomeStepState) => run(async () => go(await useWelcome.getState().update({ step: { id, state } }), id))
  const chooseTeam = (type: TeamType) => run(async () => {
    const w = useWelcome.getState()
    // the pack once: these steps never install it again by themselves (the server keeps that record as well)
    if (TEAM_TYPE_PACK[type] && !w.progress?.pack) {
      const r = await w.installPack()
      if (r) toast({ level: 'success', text: installedText(t, r) })
    }
    go(await w.update({ teamType: type, step: { id: 'team', state: 'done' } }), 'team')
  })
  const installForResult = () => run(async () => {
    const r = await useWelcome.getState().installPack()
    if (r) toast({ level: 'success', text: installedText(t, r) })
  })
  const ran = (chatId: string) => run(async () => {
    // the chat opens either way; without the record it only lacks the invite bar
    await useWelcome.getState().update({ step: { id: 'result', state: 'done' }, resultChatId: chatId }).catch(() => {})
    navigate(`/c/${chatId}`)
  })

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
  const back = prevStep(step)
  return (
    <Page>
      <h1 className="text-xs font-medium tracking-wide text-accent-text">{t('welcome.eyebrow')}</h1>
      <Progress progress={progress} step={step} />
      {back && (
        <div className="mt-5 -ml-2.5">
          <Button size="sm" variant="ghost" onClick={() => { setError(null); setStep(back) }} disabled={busy} data-testid="welcome-back">
            <ArrowLeft size={14} aria-hidden /> {t('welcome.back')}
          </Button>
        </div>
      )}
      <div ref={region} tabIndex={-1} className={back ? 'mt-2 outline-none' : 'mt-8 outline-none'} data-step={step}>
        {step === 'team' && <TeamStep progress={progress} busy={busy} onChoose={(type) => void chooseTeam(type)} onSkip={() => void mark('team', 'skipped')} />}
        {step === 'profile' && <ProfileWizardStep progress={progress} onDone={() => void mark('profile', 'done')} onSkip={() => void mark('profile', 'skipped')} />}
        {step === 'result' && <ResultStep progress={progress} busy={busy} onRan={(id) => void ran(id)} onInstall={() => void installForResult()} onSkip={() => void mark('result', 'skipped')} />}
        {step === 'invite' && <InviteWizardStep progress={progress} onDone={() => void mark('invite', 'done')} onSkip={() => void mark('invite', 'skipped')} />}
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

/** "1/3 팀 유형 · 2/3 회사 소개 · 3/3 첫 결과": filled up to the step on screen (all three on the invite). */
function Progress({ progress, step }: { progress: WelcomeProgress; step: WelcomeStep }) {
  const t = useT()
  const at = WELCOME_STEPS.indexOf(step)
  return (
    <ol className="mt-3 grid grid-cols-3 gap-2" aria-label={t('welcome.progress.label')} data-testid="welcome-progress">
      {WELCOME_COUNTED.map((s, i) => {
        const state = progress.steps[s]
        return (
          <li key={s} aria-current={i === at ? 'step' : undefined}>
            <span aria-hidden className={clsx('block h-1.5 rounded-full', i <= at ? 'bg-accent' : 'bg-hover')} />
            <span className={clsx('mt-1.5 block text-xs', i === at ? 'font-medium text-ink' : 'text-faint')}>
              {t('welcome.progress.item', { n: i + 1, label: t(STEP_LABEL[s]) })}
              {state && <span className="sr-only"> · {t(state === 'done' ? 'common.done' : 'welcome.progress.skipped')}</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function StepHead({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="space-y-1">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      {desc && <p className="text-sm text-muted">{desc}</p>}
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

/** 1/3 "어떤 팀이에요?": four big choices. Only marketing has a pack today; the others say theirs is coming. */
function TeamStep({ progress, busy, onChoose, onSkip }: { progress: WelcomeProgress; busy: boolean; onChoose: (t: TeamType) => void; onSkip: () => void }) {
  const t = useT()
  const [choice, setChoice] = useState<TeamType | null>(progress.teamType)
  const pack = choice ? TEAM_TYPE_PACK[choice] : undefined
  return (
    <div className="space-y-5" data-testid="welcome-team">
      <StepHead title={t('welcome.team.title')} desc={t('welcome.team.desc')} />
      <div className="grid gap-2 sm:grid-cols-2">
        {TEAM_TYPES.map((type) => {
          const Icon = TEAM_ICON[type]
          const on = choice === type
          return (
            <button
              key={type}
              type="button"
              aria-pressed={on}
              onClick={() => setChoice(type)}
              className={clsx('flex items-start gap-3 rounded-xl border px-4 py-3.5 text-left transition', on ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover')}
              data-testid={`welcome-team-${type}`}
            >
              <Icon size={20} className="mt-0.5 shrink-0 text-accent-text" aria-hidden />
              <span className="min-w-0">
                <span className="block font-medium text-ink">{t(`welcome.team.${type}`)}</span>
                <span className="mt-0.5 block text-[13px] text-muted">{t(TEAM_TYPE_PACK[type] ? 'welcome.team.packDesc' : 'welcome.team.soon')}</span>
              </span>
            </button>
          )
        })}
      </div>
      {choice && !pack && <p role="status" className="text-sm text-muted" data-testid="welcome-team-no-pack">{t('welcome.team.noPack')}</p>}
      {pack && progress.pack && <p className="text-sm text-muted">{t('welcome.team.packThere')}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" busy={busy} disabled={!choice} onClick={() => choice && onChoose(choice)} data-testid="welcome-next">
          {t('welcome.next')}
        </Button>
        <span className="ml-auto"><Later onClick={onSkip} disabled={busy} /></span>
      </div>
    </div>
  )
}

/** 2/3 the company profile (stream D's step), starting from the saved profile or the setup link's website. */
function ProfileWizardStep({ progress, onDone, onSkip }: { progress: WelcomeProgress; onDone: () => void; onSkip: () => void }) {
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
      <ProfileStep initial={saved} initialWebsite={progress.site ?? setupSite()} onDone={onDone} onSkip={onSkip} skipLabel={t('welcome.later')} />
    </div>
  )
}

/** 3/3 the first result: the ad copy form, filled in from the profile. Without a usable AI: A's way to connect one. */
function ResultStep({ progress, busy, onRan, onInstall, onSkip }: { progress: WelcomeProgress; busy: boolean; onRan: (chatId: string) => void; onInstall: () => void; onSkip: () => void }) {
  const t = useT()
  const ai = useAiAccess()
  // asked again here: a run without AI would only fail in the chat
  useEffect(() => { void ai.load(true) }, [ai.load])
  let body: ReactNode
  if (!ai.loaded) body = <Skeleton lines={4} />
  else if (!ai.usable)
    body = (
      <div className="space-y-3" data-testid="welcome-result-no-ai">
        <p className="text-sm text-muted">{t('welcome.result.noAi')}</p>
        <AiAccessBanner />
        <div className="flex justify-end"><Later onClick={onSkip} disabled={busy} /></div>
      </div>
    )
  else if (!progress.pack)
    body = (
      <div className="space-y-3" data-testid="welcome-result-no-pack">
        <p className="text-sm text-muted">{t(progress.teamType && !TEAM_TYPE_PACK[progress.teamType] ? 'welcome.result.noPackOther' : 'welcome.result.noPack')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" busy={busy} onClick={onInstall} data-testid="welcome-result-install">{t('welcome.result.install')}</Button>
          <span className="ml-auto"><Later onClick={onSkip} disabled={busy} /></span>
        </div>
      </div>
    )
  else body = <SkillForm path={progress.pack.skillPath} onDone={onRan} onSkip={onSkip} skipLabel={t('welcome.later')} />
  return (
    <div className="space-y-5" data-testid="welcome-result">
      <StepHead title={t('welcome.result.title')} desc={t('welcome.result.desc')} />
      {body}
    </div>
  )
}

/** Then the invite (stream E's step): with the first result's skill, so people who join land on its form. */
function InviteWizardStep({ progress, onDone, onSkip }: { progress: WelcomeProgress; onDone: () => void; onSkip: () => void }) {
  const t = useT()
  useEffect(() => {
    if (!progress.inviteShownAt) void useWelcome.getState().update({ inviteShown: true }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const skillPath = progress.pack?.skillPath ?? null
  const title = progress.steps.result === 'done' && skillPath ? t('welcome.invite.title', { skill: t('welcome.skillName') }) : undefined
  return <InviteStep title={title} skillPath={skillPath} onDone={onDone} onSkip={onSkip} />
}
