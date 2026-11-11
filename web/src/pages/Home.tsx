// New chat. Under the box, one block at a time: "팀에 준비된 것" (components/onboarding/TeamPrepared.tsx,
// docs/DECISIONS.md "W6.3 — What a new member sees first": the team's skills until the person ran one or has 5 chats,
// the team's files while they have no chats, else one ready question; a member's one filled button is there, an
// owner's or admin's block is all quiet), else what people of my group (or team) often ask (components/OftenAsked.tsx,
// docs/DECISIONS.md "Home: what my group often asks": 3 lines, More shows up to 10, a click fills the box). While no AI
// answers a member, the block shows read-only under the no-AI card (owners and admins: the card alone). Owners and
// admins get ONE thing at the top: on a phone the welcome steps'
// "continue" row while they are unfinished, else the 7-day goal card (docs/DECISIONS.md "Y — Home shows one thing at a
// time"); on a computer the sidebar's setup row stands for the welcome steps (components/onboarding/SetupRow.tsx,
// docs/DECISIONS.md "W5"), so the top is the goal card there. The owner's setup checklist is on Admin › Home. While no
// AI answers the person (GET /api/me/ai-access), everyone gets ONE card instead (components/onboarding/ConnectAi.tsx NoAiCard: the owner connects, anyone else hears that the owner
// does), in place of that row, the suggestions (which would all fail) and the line above the box; the welcome steps'
// row comes back once AI answers, so it never leads back to the AI step it was put off at. On a demo server (`bun run
// demo:company`) a demo person sees only their one line and their questions (components/demo/Demo.tsx).
// Phones (below 768px): Home is the 트리나 tab, where the app opens. No cards; the greeting and the box come first, the
// "one thing" (the setup row, the goal) is the first quiet row under the box (the goal opens its next step in place),
// then the three latest AI chats as plain rows ("트리나 기록"; the whole history is behind ☰ in the top bar). The greeting and the box sit a third of
// the way down and the rows hang below them, so opening a row moves nothing above it. A project's new
// chat ("/?project=") shows neither: the goal and the setup row are about the team.
// The owner whose lead link someone joined with gets that card as the one thing at the top instead (components/handover/
// HandoverCard.tsx, docs/DECISIONS.md "W6"), on a phone the first row under the box.
// The owner who ended the welcome steps without files gets one line (docs/DECISIONS.md "M — One meeting note,
// everyone's own tasks"): "회의록이 생기면 {팀} 폴더에 놓아 주세요". (The member's start from a link's files, "M", went
// with 할 일 정리: docs/DECISIONS.md "DS3".)
import clsx from 'clsx'
import { ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { useRealNavigationType } from '../lib/realPath'
import type { Chat, Project } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { useT } from '../i18n'
import { useMediaQuery } from '../components/ui'
import { useAiAccess } from '../store/aiAccess'
import { useChats } from '../store/chats'
import { isAdmin, isOwner, useMeStrict } from '../store/session'
import { useWelcome } from '../store/welcome'
import { isLanding, LANDING_STATE, readNotesHint, showResume, type NotesHint } from '../lib/welcome'
import { aiName, landingPath } from '../lib/tabs'
import { NewChatComposer } from '../components/chat/NewChatComposer'
import { isUnused, SessionMarker, useChatMarker } from '../components/chat/ChatState'
import { needsMe } from '../lib/sessionMarkers'
import { OftenAsked } from '../components/OftenAsked'
import { SkillsOnComputer, useResumeOnLanding, WelcomeResume } from '../components/onboarding/WelcomeResume'
import { HomeGoal } from '../components/onboarding/GoalCard'
import { NoAiCard } from '../components/onboarding/ConnectAi'
import { HandoverCard, useLeadCard } from '../components/handover/HandoverCard'
import { DemoIntro, DemoQuestions, useDemoPersona } from '../components/demo/Demo'
import { TeamPrepared } from '../components/onboarding/TeamPrepared'

export default function Home() {
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
  const notes = readNotesHint(location.state)
  const phone = useMediaQuery('(max-width: 767.98px)')
  // a phone opened on Home while the app opens on another tab (lib/tabs.ts START_TAB): that tab's list instead
  const elsewhere = phone && isLanding(location) && landingPath(true) !== '/'
  // the owner who left the welcome steps unfinished lands on them, once per tab session (never a link elsewhere)
  const resuming = useResumeOnLanding(isLanding(location) && !elsewhere)
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
  const admin = isAdmin(me)
  /** a suggestion chosen: into the box (focused, the caret after it), never sent */
  const choose = (text: string, waits?: string) => setPreset({ text, n: (preset?.n ?? 0) + 1, waits })
  // whether "팀에 준비된 것" shows anything (null: not known yet): what the group often asks waits for the answer and
  // stays out while it does, so one block sits under the box at a time
  const [prepared, setPrepared] = useState<boolean | null>(null)
  // a project's new chat is about that project: the team's goal and setup row stay on Home itself
  const top = !noAi && extras && admin && !projectId && ai.loaded && <HomeTop owner={isOwner(me)} />
  // someone joined with the owner's lead link (docs/DECISIONS.md "W6"): while its card shows, it is the one thing at the
  // top, in place of the setup row or the goal and of the no-AI card
  const lead = useLeadCard(extras && !projectId)
  const leadCard = lead && <HandoverCard card={lead} />

  if (elsewhere) return <Navigate to={landingPath(true)} state={LANDING_STATE} replace />
  if (resuming) return <div className="h-full" data-testid="home-resuming" />
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 max-md:min-h-0">
        {/* phones: the greeting and the box at one place (a third of the way down) and the rows under the box hanging
            below them, so opening one (the goal's next step) moves nothing above it and a long list scrolls. From 768px
            one centred column (the wrappers are display: contents there) */}
        <div className="w-full max-w-[720px] max-md:grid max-md:min-h-0 max-md:flex-1 max-md:grid-cols-1 max-md:grid-rows-[minmax(0,1fr)_auto_minmax(0,2fr)]" data-testid="home-column">
          <div className="md:hidden" aria-hidden />
          <div className="md:contents" data-testid="home-head">
            {leadCard ? !phone && leadCard : noAi ? <NoAiCard /> : !phone && top}
            {project && (
              <p className="mb-2 text-center text-sm text-muted">
                <Link to={`/projects/${project.id}`} className="font-medium text-accent-text hover:underline">
                  {project.name}
                </Link>{' '}
                · {t('home.inProject')}
              </p>
            )}
            {demo && !projectId ? <DemoIntro persona={demo.persona} /> : <h1 className="mb-6 text-center text-[1.625rem] font-semibold tracking-tight text-balance sm:text-[1.75rem]">{t('home.greeting', { name: me.user.name })}</h1>}
            {extras && notes && !projectId && <NotesLine notes={notes} />}
            <NewChatComposer
              projectId={projectId}
              project={project}
              initialText={preset?.text}
              resetKey={preset?.n ?? 0}
              // Only in-app PUSH navigation or a chosen preset requests focus; a document load keeps the skip link first.
              autoFocus={navigationType === 'PUSH' || (preset?.n ?? 0) > 0}
              aiLine={!noAi}
              waitsFor={preset?.waits ? { text: preset.text, hint: preset.waits } : undefined}
            />
          </div>
          <div className="max-md:pb-6 md:contents" data-testid="home-tail">
            {demo && !projectId && <DemoQuestions info={demo.info} persona={demo.persona} />}
            {/* phones: the top row is the first row under the box */}
            {phone && (leadCard || top) && <div className="mt-3">{leadCard || top}</div>}
            {phone && extras && !projectId && <RecentChats />}
            {/* "팀에 준비된 것" (W6.3), once the chats are known (the files row and the ready question are for no chats);
                read-only under a member's no-AI card */}
            {(suggest || (noAi && !admin && !projectId)) && chatsLoaded && <TeamPrepared key={`prepared-${me.user.id}`} firstTime={firstTime} chats={chats.length} readOnly={noAi} onCompose={choose} onShown={setPrepared} />}
            {/* what my group often asks, in the same place once "팀에 준비된 것" has nothing (one block at a time) */}
            {suggest && chatsLoaded && prepared === false && <OftenAsked key={`asked-${me.user.id}`} onChoose={choose} />}
          </div>
        </div>
      </div>
      <p className="px-4 pb-3 text-center text-micro text-faint max-md:hidden">{t('chat.footer')}</p>
    </div>
  )
}

/** Phones: the three AI chats I used last, as plain rows under the box (the drawer has them all). Nothing until there
 * is one. */
export function RecentChats() {
  const t = useT()
  const chats = useChats((s) => s.chats)
  const recent = useMemo(() => chats.filter((c) => !isUnused(c)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3), [chats])
  if (!recent.length) return null
  return (
    <section className="mt-6" aria-labelledby="home-recents" data-testid="home-recents">
      <h2 id="home-recents" className="px-3 pb-1 text-xs text-muted">
        {t('sidebar.aiChats', { name: aiName(t) })}
      </h2>
      <ul>
        {recent.map((c) => (
          <RecentChat key={c.id} chat={c} />
        ))}
      </ul>
    </section>
  )
}

/** One of them: its session marker (docs/DECISIONS.md "Session markers": "?", a spinner or a dot) at the right end,
 * before the arrow, and its reason in the link's name. */
function RecentChat({ chat }: { chat: Chat }) {
  const t = useT()
  const { marker, reason } = useChatMarker(chat)
  return (
    <li data-marker={marker?.kind}>
      <Link to={`/c/${chat.id}`} className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm text-ink hover:bg-hover" data-testid="home-recent">
        <span className={clsx('min-w-0 flex-1 truncate', needsMe(marker) && 'font-medium')}>{chat.title || t('chat.untitled')}</span>
        {marker && <SessionMarker marker={marker} label={reason} />}
        <ChevronRight size={16} className="shrink-0 text-faint" aria-hidden />
      </Link>
    </li>
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
 * on a computer always the goal card, since the sidebar's setup row stands for the steps there (docs/DECISIONS.md
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
