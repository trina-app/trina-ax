// New chat. First-time members see which folders their AI can see and three example questions (filled with
// their folder names, no engine call). Owners and admins get ONE thing at the top: the welcome steps' "continue" row
// while they are unfinished, else the 7-day goal card (docs/DECISIONS.md "Y — Home shows one thing at a time"); the
// owner's setup checklist is on Admin › Home. On a demo server (`bun run demo:trina`) a demo person sees only their
// one line and their questions (components/demo/Demo.tsx).
// Two moments of the meeting-notes start (docs/DECISIONS.md "M — One meeting note, everyone's own tasks") show here as
// one line each, with nothing else added:
//   - a member who just joined with a link that carries the lead's files (lib/starter.ts): "민지님이 이번 주 팀 회의록
//     2개를 올려 뒀어요" above the box, the box holding the skill as a chip ("할 일 정리") and "내 할 일 정리해 줘", the
//     files attached,
//     the box's own send button as the one action, and who sees the chat under it; nothing else on Home until it is sent;
//   - the owner who ended the welcome steps without files: "회의록이 생기면 {팀} 폴더에 놓아 주세요".
import { Folder, Lock, Pencil } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { useRealNavigationType } from '../lib/realPath'
import type { FileEntry, JoinStarter, Project } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { clearStarter, heldStarter, markStarterAttached, starterAttached } from '../lib/starter'
import { sendToComposer } from '../lib/teamAttach'
import { visibleFolders } from '../lib/visibleFolders'
import { useT, type MessageKey } from '../i18n'
import { useChats } from '../store/chats'
import { isAdmin, isOwner, useMeStrict } from '../store/session'
import { useWelcome } from '../store/welcome'
import { readNotesHint, showResume, type NotesHint } from '../lib/welcome'
import { NewChatComposer } from '../components/chat/NewChatComposer'
import { FrequentQuestions } from '../components/FrequentQuestions'
import { PopularSkills } from '../components/PopularSkills'
import { WelcomeResume } from '../components/onboarding/WelcomeResume'
import { HomeGoal } from '../components/onboarding/GoalCard'
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
  const notes = readNotesHint(useLocation().state)
  const [preset, setPreset] = useState<{ text: string; n: number } | null>(() => (starter ? { text: starterQuestion(starter, t), n: 0 } : prompt ? { text: prompt, n: 0 } : null))
  useEffect(() => {
    if (!starter || starterAttached(me.user.id)) return
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

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-10">
        <div className="w-full max-w-[720px]">
          {extras && isAdmin(me) && !starter && <HomeTop owner={isOwner(me)} />}
          {project && (
            <p className="mb-2 text-center text-sm text-muted">
              <Link to={`/projects/${project.id}`} className="font-medium text-accent-text hover:underline">
                {project.name}
              </Link>{' '}
              · {t('home.inProject')}
            </p>
          )}
          {demo && !projectId ? <DemoIntro persona={demo.persona} /> : <h1 className="mb-6 text-center text-[26px] font-semibold tracking-tight sm:text-[28px]">{t('home.greeting', { name: me.user.name })}</h1>}
          {extras && (starter ? <StarterLine starter={starter} /> : notes && !projectId && <NotesLine notes={notes} />)}
          <NewChatComposer
            projectId={projectId}
            initialText={preset?.text}
            resetKey={preset?.n ?? 0}
            // Only in-app PUSH navigation or a chosen preset requests focus; a document load keeps the skip link first.
            autoFocus={navigationType === 'PUSH' || (preset?.n ?? 0) > 0}
            onSent={starter ? () => clearStarter(me.user.id) : undefined}
            skill={starter ? { name: starter.skill.name, title: starter.skill.title } : undefined}
          />
          {demo && !projectId && <DemoQuestions info={demo.info} persona={demo.persona} />}
          {extras && starter && (
            <p className="mt-2 text-center text-xs text-faint" data-testid="starter-private">
              {starter.by ? t('starter.privateBy', { name: me.user.name, by: starter.by }) : t('starter.private', { name: me.user.name })}
            </p>
          )}
          {extras && firstTime && !projectId && !starter && <FirstTime onExample={(text) => setPreset({ text, n: (preset?.n ?? 0) + 1 })} />}
          {extras && !projectId && !starter && <FrequentQuestions key={me.user.id} onChoose={(text) => setPreset({ text, n: (preset?.n ?? 0) + 1 })} />}
          {/* B-W7-7: the team's top skills, once two or more were used. A different key from FrequentQuestions: same-key
              siblings render twice */}
          {extras && !projectId && !starter && <PopularSkills key={`skills-${me.user.id}`} limit={3} min={2} className="mt-6" onChoose={(text) => setPreset({ text, n: (preset?.n ?? 0) + 1 })} />}
        </div>
      </div>
      <p className="px-4 pb-3 text-center text-[11px] text-faint">{t('chat.footer')}</p>
    </div>
  )
}

/** The member's own question ("내 할 일 정리해 줘"); the link's skill goes with it as the box's chip ("할 일 정리"), and
 * sending runs "/meeting-tasks 내 할 일 정리해 줘". */
export function starterQuestion(s: JoinStarter, t: ReturnType<typeof useT>): string {
  return t(s.kind === 'brief' ? 'starter.askBrief' : 'starter.askTasks')
}

/** "민지님이 이번 주 팀 회의록 2개를 올려 뒀어요" (the files are in the box below). */
function StarterLine({ starter }: { starter: JoinStarter }) {
  const t = useT()
  const n = starter.files.length
  const key: MessageKey = starter.kind === 'brief' ? (starter.by ? 'starter.briefBy' : 'starter.brief') : starter.by ? 'starter.tasksBy' : 'starter.tasks'
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
 * The one thing at the top of Home for owners and admins: the owner's "시작 설정 이어하기 (n/2)" while the welcome
 * steps are unfinished (started, neither finished nor hidden), else the goal card. The owner's waits for the steps'
 * progress so the goal card never shows for a moment first; a failed read counts as "nothing to continue".
 * Exported for its test.
 */
export function HomeTop({ owner }: { owner: boolean }) {
  const loaded = useWelcome((s) => s.loaded)
  const progress = useWelcome((s) => s.progress)
  useEffect(() => {
    if (owner) void useWelcome.getState().load().catch(() => {})
  }, [owner])
  if (!owner) return <HomeGoal />
  if (!loaded) return null
  return showResume(progress) ? <WelcomeResume /> : <HomeGoal />
}

const EXAMPLES: MessageKey[] = ['home.example1', 'home.example2', 'home.example3']

/**
 * "내 AI가 볼 수 있는 폴더" + example questions (translated templates, filled with the person's folder names).
 * Folders reached through a group or project rule (groups/마케팅, projects/x) are listed by their path.
 * users/ itself is only a way to reach personal folders, so the card shows the person's own folder (users/<id>,
 * where the AI saves by default) in its place, and the examples name team folders first.
 */
function FirstTime({ onExample }: { onExample: (text: string) => void }) {
  const t = useT()
  const me = useMeStrict()
  const [folders, setFolders] = useState<FileEntry[] | null>(null)
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
  const shown: { key: string; name: string; title?: string; write: boolean }[] = [
    ...folders.map((f) => ({ key: f.path, name: f.path, write: f.access === 'write' })),
    { key: 'me', name: myFolder, title: `users/${me.user.id}`, write: true },
  ]
  return (
    <div className="mt-6 space-y-4">
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
        {!folders.length && <p className="mt-2 text-sm text-muted">{t('home.noFolders')}</p>}
      </section>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {EXAMPLES.map((k, i) => {
          const text = t(k, { folder: names[i % names.length]! })
          return (
            <button key={k} type="button" onClick={() => onExample(text)} className="rounded-xl border border-line px-3.5 py-3 text-left text-sm text-muted transition hover:bg-hover hover:text-ink" data-testid="example">
              {text}
            </button>
          )
        })}
      </div>
    </div>
  )
}
