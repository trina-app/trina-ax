// New chat. First-time members see which folders their AI can see and three example questions (filled with
// their folder names, no engine call). Owners and admins get ONE thing at the top: on a phone the welcome steps'
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
// Two moments of the meeting-notes start (docs/DECISIONS.md "M — One meeting note, everyone's own tasks") show here as
// one line each, with nothing else added:
//   - a member who just joined with a link that carries the lead's files (lib/starter.ts): "민지님이 이번 주 팀 회의록
//     2개를 올려 뒀어요" above the box, the box holding the skill as a chip ("할 일 정리") and "내 할 일 정리해 줘", the
//     files attached,
//     the box's own send button as the one action, and who sees the chat under it; nothing else on Home until it is sent;
//     a team skill a person made without a form ("S"): "지훈님이 만든 팀 스킬이에요", its title as the chip and
//     "이 방식대로 해 줘";
//   - the owner who ended the welcome steps without files: "회의록이 생기면 {팀} 폴더에 놓아 주세요".
import clsx from 'clsx'
import { ArrowUpLeft, ChevronRight, Folder, Lock, Pencil } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { useRealNavigationType } from '../lib/realPath'
import type { Chat, FileEntry, JoinStarter, Project } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { clearStarter, heldStarter, markStarterAttached, starterAttached } from '../lib/starter'
import { sendToComposer } from '../lib/teamAttach'
import { visibleFolders } from '../lib/visibleFolders'
import { useT, type MessageKey } from '../i18n'
import { Modal, useMediaQuery } from '../components/ui'
import { useAiAccess } from '../store/aiAccess'
import { useChats } from '../store/chats'
import { isAdmin, isOwner, useMeStrict } from '../store/session'
import { useWelcome } from '../store/welcome'
import { isLanding, LANDING_STATE, readNotesHint, showResume, type NotesHint } from '../lib/welcome'
import { aiName, landingPath } from '../lib/tabs'
import { NewChatComposer } from '../components/chat/NewChatComposer'
import { isUnused, SessionMarker, useChatMarker } from '../components/chat/ChatState'
import { needsMe } from '../lib/sessionMarkers'
import { FrequentQuestions } from '../components/FrequentQuestions'
import { PopularSkills } from '../components/PopularSkills'
import { SkillsOnComputer, useResumeOnLanding, WelcomeResume } from '../components/onboarding/WelcomeResume'
import { HomeGoal } from '../components/onboarding/GoalCard'
import { NoAiCard } from '../components/onboarding/ConnectAi'
import { DemoIntro, DemoQuestions, useDemoPersona } from '../components/demo/Demo'

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
  // a member who just joined: the lead's files and their question, until the first message is sent
  const starter = useMemo(() => (projectId ? null : heldStarter(me.user.id)), [me.user.id, projectId])
  const location = useLocation()
  const notes = readNotesHint(location.state)
  const phone = useMediaQuery('(max-width: 767.98px)')
  // a phone opened on Home while the app opens on another tab (lib/tabs.ts START_TAB): that tab's list instead
  const elsewhere = phone && isLanding(location) && landingPath(true) !== '/'
  // the owner who left the welcome steps unfinished lands on them, once per tab session (never a link elsewhere)
  const resuming = useResumeOnLanding(isLanding(location) && !elsewhere)
  const [preset, setPreset] = useState<{ text: string; n: number } | null>(() => (starter ? { text: starterQuestion(starter, t), n: 0 } : prompt ? { text: prompt, n: 0 } : null))
  useEffect(() => {
    if (!starter || !starter.files.length || starterAttached(me.user.id)) return
    // once: the box keeps its chips across a reload by itself
    void sendToComposer('new', starter.files.map((f) => f.path)).then((r) => { if (r.added > 0) markStarterAttached(me.user.id) })
  }, [starter, me.user.id])

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
  const noAi = extras && !starter && ai.loaded && !ai.usable
  const suggest = extras && !projectId && !starter && ai.loaded && ai.usable
  // a project's new chat is about that project: the team's goal and setup row stay on Home itself
  const top = !noAi && extras && isAdmin(me) && !starter && !projectId && ai.loaded && <HomeTop owner={isOwner(me)} />

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
            {noAi ? <NoAiCard /> : !phone && top}
            {project && (
              <p className="mb-2 text-center text-sm text-muted">
                <Link to={`/projects/${project.id}`} className="font-medium text-accent-text hover:underline">
                  {project.name}
                </Link>{' '}
                · {t('home.inProject')}
              </p>
            )}
            {demo && !projectId ? <DemoIntro persona={demo.persona} /> : <h1 className="mb-6 text-center text-[26px] font-semibold tracking-tight text-balance sm:text-[28px]">{t('home.greeting', { name: me.user.name })}</h1>}
            {extras && (starter ? <StarterLine starter={starter} /> : notes && !projectId && <NotesLine notes={notes} />)}
            <NewChatComposer
              projectId={projectId}
              initialText={preset?.text}
              resetKey={preset?.n ?? 0}
              // Only in-app PUSH navigation or a chosen preset requests focus; a document load keeps the skip link first.
              autoFocus={navigationType === 'PUSH' || (preset?.n ?? 0) > 0}
              onSent={starter ? () => clearStarter(me.user.id) : undefined}
              skill={starter ? { name: starter.skill.name, title: starter.skill.title } : undefined}
              aiLine={!noAi}
            />
            {extras && starter && (
              <p className="mt-2 text-center text-xs text-faint" data-testid="starter-private">
                {starter.by ? t('starter.privateBy', { name: me.user.name, by: starter.by }) : t('starter.private', { name: me.user.name })}
              </p>
            )}
          </div>
          <div className="max-md:pb-6 md:contents" data-testid="home-tail">
            {demo && !projectId && <DemoQuestions info={demo.info} persona={demo.persona} />}
            {/* phones: the top row is the first row under the box */}
            {phone && top && <div className="mt-3">{top}</div>}
            {phone && extras && !projectId && !starter && <RecentChats />}
            {suggest && firstTime && <FirstTime onExample={(text) => setPreset({ text, n: (preset?.n ?? 0) + 1 })} />}
            {suggest && <FrequentQuestions key={me.user.id} onChoose={(text) => setPreset({ text, n: (preset?.n ?? 0) + 1 })} />}
            {/* B-W7-7: the team's top skills, once two or more were used. A different key from FrequentQuestions: same-key
                siblings render twice */}
            {suggest && <PopularSkills key={`skills-${me.user.id}`} limit={3} min={2} className="mt-6" onChoose={(text) => setPreset({ text, n: (preset?.n ?? 0) + 1 })} />}
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

/** The member's own question ("내 할 일 정리해 줘"); the link's skill goes with it as the box's chip ("할 일 정리"), and
 * sending runs "/meeting-tasks 내 할 일 정리해 줘". */
export function starterQuestion(s: JoinStarter, t: ReturnType<typeof useT>): string {
  return t(s.kind === 'brief' ? 'starter.askBrief' : s.kind === 'skill' ? 'starter.askSkill' : 'starter.askTasks')
}

/** "민지님이 이번 주 팀 회의록 2개를 올려 뒀어요" (the files are in the box below); a team skill without a form
 * (docs/DECISIONS.md "S"): "지훈님이 만든 팀 스킬이에요" (its title is the box's chip). */
function StarterLine({ starter }: { starter: JoinStarter }) {
  const t = useT()
  const n = starter.files.length
  const key: MessageKey = starter.kind === 'skill' ? (starter.by ? 'starter.skillBy' : 'starter.skill')
    : starter.kind === 'brief' ? (starter.by ? 'starter.briefBy' : 'starter.brief') : starter.by ? 'starter.tasksBy' : 'starter.tasks'
  return <p className="mb-3 text-center text-sm text-muted" data-testid="starter-line">{t(key, { n, by: starter.by ?? '' })}</p>
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

const EXAMPLES: MessageKey[] = ['home.example1', 'home.example2', 'home.example3']

type ShownFolder = { key: string; name: string; title?: string; write: boolean }

/** Whether a folder's AI may write, as an icon (the word is the legend's, and for screen readers on each one). */
function Access({ write }: { write: boolean }) {
  const t = useT()
  const label = t(write ? 'files.canWrite' : 'files.readOnly')
  return (
    <span className="inline-flex shrink-0 text-faint" title={label}>
      {write ? <Pencil size={12} aria-hidden /> : <Lock size={12} aria-hidden />}
      <span className="sr-only">{label}</span>
    </span>
  )
}

/** "✎ 쓰기 가능 · 🔒 읽기 전용", once under the folders: only the kinds that are there. */
function AccessLegend({ folders }: { folders: ShownFolder[] }) {
  const t = useT()
  const kinds = [true, false].filter((w) => folders.some((f) => f.write === w))
  return (
    <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-faint" aria-hidden>
      {kinds.map((w) => (
        <span key={String(w)} className="inline-flex items-center gap-1">
          {w ? <Pencil size={12} /> : <Lock size={12} />}
          {t(w ? 'files.canWrite' : 'files.readOnly')}
        </span>
      ))}
    </p>
  )
}

/**
 * "내 AI가 볼 수 있는 폴더" + example questions (translated templates, filled with the person's folder names).
 * Folders reached through a group or project rule (groups/마케팅, projects/x) are listed by their path.
 * users/ itself is only a way to reach personal folders, so the card shows the person's own folder (users/<id>,
 * where the AI saves by default) in its place, and the examples name team folders first.
 * Phones (below 768px): no card, one row "내 AI가 볼 수 있는 폴더 5개 ›" that opens the list in a sheet (whether the AI
 * may write a folder is an icon on it, the words once under the list), and two of the examples as plain rows; from
 * 768px the card with the folders (each with its "쓰기 가능" / "읽기 전용") and the three examples as boxes.
 */
function FirstTime({ onExample }: { onExample: (text: string) => void }) {
  const t = useT()
  const me = useMeStrict()
  const phone = useMediaQuery('(max-width: 767.98px)')
  const [folders, setFolders] = useState<FileEntry[] | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let live = true
    visibleFolders(async (path) => (await api.call(API.tree, { query: { path, limit: 50 } })).entries, { skip: (p) => p === 'users' || p.startsWith('users/') }).then(
      (r) => live && setFolders(r),
      () => live && setFolders([]),
    )
    return () => {
      live = false
    }
  }, [])
  const myFolder = t('home.myFolder')
  // the examples name the path ("users/kim"): "내 폴더 폴더에…" would read badly, and the AI finds it as is
  const names = useMemo(() => [...(folders ?? []).map((f) => f.path), `users/${me.user.id}`], [folders, me.user.id])
  if (!folders) return null
  const shown: ShownFolder[] = [
    ...folders.map((f) => ({ key: f.path, name: f.path, write: f.access === 'write' })),
    { key: 'me', name: myFolder, title: `users/${me.user.id}`, write: true },
  ]
  const none = !folders.length && <p className="mt-2 text-sm text-muted">{t('home.noFolders')}</p>
  return (
    <div className="mt-3 md:mt-6 md:space-y-4">
      {phone ? (
        <section data-testid="first-time-folders">
          <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm text-muted transition hover:bg-hover hover:text-ink" data-testid="first-time-folders-open">
            <Folder size={16} className="shrink-0 text-accent-text" aria-hidden />
            <span className="min-w-0 flex-1">{t('home.foldersCount', { n: shown.length })}</span>
            <ChevronRight size={16} className="shrink-0 text-faint" aria-hidden />
          </button>
          <Modal open={open} onClose={() => setOpen(false)} title={t('home.foldersTitle')}>
            <ul className="-my-2 divide-y divide-line" data-testid="first-time-folders-list">
              {shown.map((f) => (
                <li key={f.key} className="flex min-h-11 items-center gap-2.5 py-2 text-sm" title={f.title}>
                  <Folder size={16} className="shrink-0 text-accent-text" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <Access write={f.write} />
                </li>
              ))}
            </ul>
            {none}
            <AccessLegend folders={shown} />
          </Modal>
        </section>
      ) : (
        <section className="rounded-2xl border border-line bg-surface p-4" aria-labelledby="ft-folders" data-testid="first-time-folders">
          <h2 id="ft-folders" className="mb-2 text-sm font-semibold">
            {t('home.foldersTitle')}
          </h2>
          <ul className="flex flex-wrap gap-2">
            {shown.map((f) => (
              <li key={f.key} className="inline-flex items-center gap-1.5 rounded-lg bg-subtle px-2.5 py-1.5 text-sm" title={f.title}>
                <Folder size={14} className="text-accent-text" aria-hidden />
                {f.name}
                <span className="inline-flex items-center gap-0.5 text-xs text-faint">
                  {f.write ? <Pencil size={11} aria-hidden /> : <Lock size={11} aria-hidden />}
                  {t(f.write ? 'files.canWrite' : 'files.readOnly')}
                </span>
              </li>
            ))}
          </ul>
          {none}
        </section>
      )}
      {/* phones: two plain rows with an arrow up to the box (the first and the third: one to look, one to write); from
          768px three boxes side by side */}
      <div className="grid grid-cols-1 md:grid-cols-3 md:gap-2">
        {EXAMPLES.map((k, i) => {
          const text = t(k, { folder: names[i % names.length]! })
          return (
            <button
              key={k}
              type="button"
              onClick={() => onExample(text)}
              className={clsx('flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-muted transition hover:bg-hover hover:text-ink md:rounded-xl md:border md:border-line md:px-3.5 md:py-3', i === 1 && 'max-md:hidden')}
              data-testid="example"
            >
              <span className="min-w-0 flex-1">{text}</span>
              <ArrowUpLeft size={16} className="shrink-0 text-faint md:hidden" aria-hidden />
            </button>
          )
        })}
      </div>
    </div>
  )
}
