// New chat. Under the box, one block at a time: "팀에 준비된 것" (components/onboarding/TeamPrepared.tsx,
// docs/DECISIONS.md "W6.3 — What a new member sees first": the team's skills until the person ran one or has 5 chats,
// the team's files while they have no chats, else one ready question; a member's one filled button is there, an
// owner's or admin's block is all quiet), else what people of my group (or team) often ask (components/OftenAsked.tsx,
// docs/DECISIONS.md "Home: what my group often asks": 3 lines, More shows up to 10, a click fills the box). While no AI
// answers a member, the block shows read-only under the no-AI card (owners and admins: the card alone). Owners and
// admins get ONE thing at the top: on a phone the welcome steps'
// "continue" row while they are unfinished, else the 7-day goal card (docs/DECISIONS.md "Y — Home shows one thing at a
// time"); on a computer the list panel's setup row stands for the welcome steps (components/onboarding/SetupRow.tsx,
// docs/DECISIONS.md "W5"), so the top is the goal card there. The owner's setup checklist is on Admin › Home. While no
// AI answers the person (GET /api/me/ai-access), everyone gets ONE card instead (components/onboarding/ConnectAi.tsx NoAiCard: the owner connects, anyone else hears that the owner
// does), in place of that row, the suggestions (which would all fail) and the line above the box; the welcome steps'
// row comes back once AI answers, so it never leads back to the AI step it was put off at. On a demo server (`bun run
// demo:company`) a demo person sees only their one line and their questions (components/demo/Demo.tsx).
// Phones (below 768px): Home is the 트리나 tab, where the app opens, laid out like an AI app (QA TC-253, TC-391): the
// "one thing" (the setup row, the goal, the welcome or lead card, the no-AI card) at the top, without a frame; Trina's
// mark and the greeting in the middle of the space left; the one row of suggestions (the block under the box on a
// computer, as chips that scroll sideways) and the box at the bottom, the box docked there so it stays in sight while
// the rest scrolls. The box is one card (components/chat/Composer.tsx `card`): the text on top, + · the engine picker
// · mic · send in a row inside it, nothing under it. A touch screen never focuses it by itself (Composer focuses only
// with a fine pointer: not on opening, not coming back from another tab or a chat): the keyboard comes up only when
// the person taps the box, so the tab bar stays until
// then (the owner, 11-12: "채팅이 보고싶은 걸 수도 있는데"); with the keyboard up the card sits on it. No list of the AI's
// chats here: the whole history is behind ☰ in the top bar. A project's new chat ("/?project=") shows no goal and no
// setup row: they are about the team.
// Someone who joined with a team link, an invite or "Add directly" gets the welcome card as the one thing at the top while
// it shows (components/onboarding/MemberWelcome.tsx, docs/DECISIONS.md "A welcome for invited people"): in place of the
// no-AI card (its last row is the no-AI way out), the goal card and "Ready in your team".
// The owner whose lead link someone joined with gets that card as the one thing at the top instead (components/handover/
// HandoverCard.tsx, docs/DECISIONS.md "W6").
// On a phone this page is the 트리나 tab itself, as the AI apps have it, with the history behind ☰ (components/phone/
// TrinaDrawer.tsx; docs/DECISIONS.md "Phones: Home like the AI apps, the history behind ☰"). `/new` (an old link) comes
// back to `/` with its question (lib/newChat.ts homeRoute).
// The owner who ended the welcome steps without files gets one line (docs/DECISIONS.md "M — One meeting note,
// everyone's own tasks"): "회의록이 생기면 {팀} 폴더에 놓아 주세요". (The member's start from a link's files, "M", went
// with 할 일 정리: docs/DECISIONS.md "DS3".)
import { Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { useRealNavigationType } from '../lib/realPath'
import { PRODUCT_NAMED_AFTER_AI, type Project } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { useT } from '../i18n'
import { useMediaQuery } from '../components/ui'
import { useAiAccess } from '../store/aiAccess'
import { useChats } from '../store/chats'
import { isAdmin, isOwner, useMeStrict } from '../store/session'
import { useWelcome } from '../store/welcome'
import { isLanding, LANDING_STATE, readNotesHint, showResume, type NotesHint } from '../lib/welcome'
import { landingPath } from '../lib/tabs'
import { homeRoute } from '../lib/newChat'
import { NewChatComposer } from '../components/chat/NewChatComposer'
import { OftenAsked } from '../components/OftenAsked'
import { SkillsOnComputer, useResumeOnLanding, WelcomeResume } from '../components/onboarding/WelcomeResume'
import { HomeGoal } from '../components/onboarding/GoalCard'
import { NoAiCard } from '../components/onboarding/ConnectAi'
import { HandoverCard, useLeadCard } from '../components/handover/HandoverCard'
import { DemoIntro, DemoQuestions, useDemoPersona } from '../components/demo/Demo'
import { TeamPrepared } from '../components/onboarding/TeamPrepared'
import { MemberWelcomeCard } from '../components/onboarding/MemberWelcome'
import { useMemberWelcome } from '../store/memberWelcome'
import { TrinaStar } from '../components/TrinaStar'
import { FileDropZone } from '../components/FileDropZone'

// Files from this computer dropped anywhere on Home (a new chat, also a project's: ?project=) go into the box, as on a
// chat's page (pages/Chat.tsx): the same overlay, the box's own checks (QA TC-071).
export default function Home() {
  const location = useLocation()
  const phone = useMediaQuery('(max-width: 767.98px)')
  const route = homeRoute(location.pathname, location.search, phone)
  if ('to' in route) return <Navigate to={route.to} state={location.state} replace />
  return (
    <FileDropZone className="h-full" data-testid="home-drop">
      <HomePage />
    </FileDropZone>
  )
}

function HomePage() {
  const t = useT()
  const me = useMeStrict()
  const navigationType = useRealNavigationType()
  const [params] = useSearchParams()
  const projectId = params.get('project')
  const prompt = params.get('prompt') ?? undefined
  const chats = useChats((s) => s.chats)
  const chatsLoaded = useChats((s) => s.chatsLoaded)
  const [project, setProject] = useState<Project | null>(null)
  const location = useLocation()
  // asked for again while Home is on show (트리나에게 묻기, ⇧⌘O): the same address is a REPLACE, not a PUSH, and Home stays
  // mounted; a new entry of it (not Back) takes the focus too
  const firstKey = useRef(location.key).current
  const again = location.key !== firstKey && navigationType !== 'POP'
  const notes = readNotesHint(location.state)
  const phone = useMediaQuery('(max-width: 767.98px)')
  // a phone opened on Home while the app opens on another tab (lib/tabs.ts START_TAB): that tab's list instead
  const elsewhere = phone && isLanding(location) && landingPath(true) !== '/'
  // the owner who left the welcome steps unfinished lands on them, once per tab session (never a link elsewhere); not
  // while the lead link's card waits here (QA TC-477): that comes first
  const resuming = useResumeOnLanding(isLanding(location) && !elsewhere, true)
  // `waits`: the line under the box while it holds only `text` (a request that needs the person's own text after it)
  const [preset, setPreset] = useState<{ text: string; n: number; waits?: string } | null>(() => (prompt ? { text: prompt, n: 0 } : null))

  useEffect(() => {
    if (!projectId) return setProject(null)
    let live = true
    api.call(API.getProject, { params: { id: projectId } }).then((p) => live && setProject(p), () => live && setProject(null))
    return () => {
      live = false
    }
  }, [projectId])

  const firstTime = chatsLoaded && chats.length === 0
  // a demo server's person gets the demo's screen; nothing else shows until it is known whether this is one
  const { ready: demoKnown, demo } = useDemoPersona()
  const extras = demoKnown && !demo
  // nothing answers this person: one card, no suggestions, no line above the box; the suggestions wait for the answer
  const ai = useAiAccess()
  useEffect(() => { void useAiAccess.getState().load() }, [])
  const noAi = extras && ai.loaded && !ai.usable
  const suggest = extras && !projectId && ai.loaded && ai.usable
  // an invited person's welcome card (docs/DECISIONS.md "A welcome for invited people"): read each time Home opens; while
  // it shows it is the one thing at the top, in place of the no-AI card, the goal card and "Ready in your team" (its
  // last row is the no-AI way out). The rest waits for the answer, so nothing flashes first
  const welcomeLoaded = useMemberWelcome((s) => s.loaded)
  const welcome = useMemberWelcome((s) => s.welcome)
  useEffect(() => { void useMemberWelcome.getState().load() }, [])
  const welcomeKnown = welcomeLoaded || !extras
  const welcomeCard = extras && !projectId && welcome && <MemberWelcomeCard welcome={welcome} />
  const admin = isAdmin(me)
  /** a suggestion chosen: into the box (focused, the caret after it), never sent */
  const choose = (text: string, waits?: string) => setPreset({ text, n: (preset?.n ?? 0) + 1, waits })
  // whether "팀에 준비된 것" shows anything (null: not known yet): what the group often asks waits for the answer and
  // stays out while it does, so one block sits under the box at a time
  const [prepared, setPrepared] = useState<boolean | null>(null)
  // a project's new chat is about that project: the team's goal and setup row stay on Home itself
  const top = !noAi && extras && admin && !projectId && ai.loaded && welcomeKnown && !welcomeCard && <HomeTop owner={isOwner(me)} />
  // someone joined with the owner's lead link (docs/DECISIONS.md "W6"): while its card shows, it is the one thing at the
  // top, in place of the setup row or the goal and of the no-AI card
  const lead = useLeadCard(extras && !projectId)
  const leadCard = lead && <HandoverCard card={lead} />

  if (elsewhere) return <Navigate to={landingPath(true)} state={LANDING_STATE} replace />
  if (resuming) return <div className="h-full" data-testid="home-resuming" />
  // the box: on a computer under the greeting, before the suggestions; on a phone after them, held at the bottom of the
  // screen, so the order things are read and reached in is the order they are seen. With a phone's keyboard up (the tab
  // bar gone) the card sits right on the keyboard
  const dock = (
    <div className="max-md:sticky max-md:bottom-0 max-md:z-10 max-md:bg-canvas max-md:pt-2 max-md:pb-3 max-md:in-[.keyboard-open]:pb-1 md:contents" data-testid="home-dock">
      <NewChatComposer
        projectId={projectId}
        project={project}
        initialText={preset?.text}
        resetKey={preset?.n ?? 0}
        // Only in-app PUSH navigation or a chosen preset requests focus; a document load keeps the skip link first. A
        // touch screen never takes it (Composer: a fine pointer only), so a phone's keyboard does not come up by itself
        autoFocus={navigationType === 'PUSH' || (preset?.n ?? 0) > 0 || again}
        focusKey={location.key}
        card
        aiLine={!noAi}
        waitsFor={preset?.waits ? { text: preset.text, hint: preset.waits } : undefined}
      />
    </div>
  )
  // the one thing at the top (the lead link's card, the welcome card, the no-AI card, else the setup row or the goal)
  const oneThing = leadCard ? leadCard : welcomeCard ? welcomeCard : noAi ? welcomeKnown && <NoAiCard /> : top
  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="home-scroll">
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 max-md:justify-start max-md:pt-4 max-md:pb-0">
        {/* phones: the one thing at the top; the mark and the greeting in the middle of what is left; the suggestions'
            one row and the box at the bottom, the box docked there (it stays in sight while the rest scrolls), as AI
            apps have it. From 768px one centred column, the box under the greeting and the suggestions under the box
            (the wrappers are display: contents there) */}
        <div className="w-full max-w-[720px] max-md:flex max-md:flex-1 max-md:flex-col" data-testid="home-column">
          <div className="md:contents" data-testid="home-top">
            {oneThing}
          </div>
          <div className="max-md:flex max-md:flex-1 max-md:flex-col max-md:items-center max-md:justify-center max-md:py-6 md:contents" data-testid="home-head">
            {/* not under a welcome or lead card: they fill the top, and the mark would sit alone over the box */}
            {!leadCard && !welcomeCard && <HomeMark />}
            {project && (
              <p className="mb-2 text-center text-sm text-muted">
                <Link to={`/projects/${project.id}`} className="font-medium text-accent-text hover:underline">
                  {project.name}
                </Link>{' '}
                · {t('home.inProject')}
              </p>
            )}
            {demo && !projectId ? <DemoIntro persona={demo.persona} /> : <h1 className="mb-6 text-center text-[1.625rem] font-semibold tracking-tight text-balance max-md:mb-0 sm:text-[1.75rem]">{t('home.greeting', { name: me.user.name })}</h1>}
            {extras && notes && !projectId && <NotesLine notes={notes} />}
          </div>
          {!phone && dock}
          <div className="md:contents" data-testid="home-tail">
            {demo && !projectId && <DemoQuestions info={demo.info} persona={demo.persona} />}
            {/* "팀에 준비된 것" (W6.3), once the chats are known (the files row and the ready question are for no chats);
                read-only under a member's no-AI card */}
            {(suggest || (noAi && !admin && !projectId)) && chatsLoaded && welcomeKnown && !welcomeCard && <TeamPrepared key={`prepared-${me.user.id}`} firstTime={firstTime} chats={chats.length} readOnly={noAi} onCompose={choose} onShown={setPrepared} />}
            {/* what my group often asks, in the same place once "팀에 준비된 것" has nothing (one block at a time) */}
            {suggest && chatsLoaded && prepared === false && <OftenAsked key={`asked-${me.user.id}`} onChoose={choose} />}
          </div>
          {phone && dock}
        </div>
      </div>
      <p className="px-4 pb-3 text-center text-micro text-faint max-md:hidden">{t('chat.footer')}</p>
    </div>
  )
}

/** Phones: the AI's mark over the greeting (QA TC-391), the one it has everywhere (rooms/AiFace.tsx): Trina's star where
 * the product is named after its AI, else the sparkle. Decorative: the greeting says it. While the keyboard is up it
 * goes, so the suggestions keep their room above the card. Computers keep the greeting alone. */
function HomeMark() {
  return (
    <span aria-hidden className="mb-4 flex md:hidden in-[.keyboard-open]:hidden" data-testid="home-mark">
      {PRODUCT_NAMED_AFTER_AI ? <TrinaStar size={48} /> : <Sparkles size={40} className="text-accent-text" aria-hidden />}
    </span>
  )
}

/** "회의록이 생기면 {팀} 폴더에 놓아 주세요", the folder a link to the file screen. */
function NotesLine({ notes }: { notes: NotesHint }) {
  const t = useT()
  const MARK = '\u0000'
  const [before, after] = t('welcome.files.homeLine', { folder: MARK }).split(MARK)
  return (
    <p className="mb-3 text-center text-sm text-muted" data-testid="welcome-notes-line">
      {before}
      <Link to={`/files?path=${encodeURIComponent(notes.folder)}`} className="font-medium text-accent-text hover:underline" data-testid="welcome-notes-folder">
        {t('welcome.files.homeFolder', { team: notes.team })}
      </Link>
      {after}
    </p>
  )
}

/**
 * The one thing at the top of Home for owners and admins while AI answers them: on a phone the owner's quiet "설정
 * 이어서 하기 · 2/4" while the welcome steps are unfinished (started, neither finished nor hidden), else the goal card;
 * on a computer always the goal card, since the list panel's setup row stands for the steps there (docs/DECISIONS.md
 * "W5"). The owner's waits for the steps' progress so the goal card never shows for a moment first on a phone; a failed
 * read counts as "nothing to continue". Exported for its test.
 */
export function HomeTop({ owner }: { owner: boolean }) {
  const loaded = useWelcome((s) => s.loaded)
  const progress = useWelcome((s) => s.progress)
  const aiReady = useAiAccess((s) => s.loaded && s.usable)
  const computer = !useMediaQuery('(max-width: 767.98px)')
  useEffect(() => {
    if (owner) void useWelcome.getState().load().catch(() => {})
  }, [owner])
  // the AI step was shown and put off, and AI answers now (Home's card, a chat, Admin, another tab): recorded done, as
  // the steps themselves do on opening, so the row counts it and leads on to 회사 소개
  const aiPutOff = owner && aiReady && !!progress && !progress.finishedAt && progress.steps.ai === 'skipped'
  useEffect(() => {
    if (aiPutOff) void useWelcome.getState().update({ step: { id: 'ai', state: 'done' } }).catch(() => {})
  }, [aiPutOff])
  if (!owner || computer) return <HomeGoal />
  if (!loaded) return null
  if (showResume(progress, false)) return <WelcomeResume />
  // 내 스킬 put off for a computer: the phone keeps the step's promise in one quiet line, above the goal
  return <><SkillsOnComputer /><HomeGoal /></>
}
