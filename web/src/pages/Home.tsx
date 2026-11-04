// New chat. First-time members see which folders their AI can see and three example questions (filled with
// their folder names, no engine call). Owners and admins get ONE thing at the top: the welcome steps' "continue" row
// while they are unfinished, else the 7-day goal card (docs/DECISIONS.md "Y — Home shows one thing at a time"); the
// owner's setup checklist is on Admin › Home.
import { Folder, Lock, Pencil } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useRealNavigationType } from '../lib/realPath'
import type { FileEntry, Project } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { visibleFolders } from '../lib/visibleFolders'
import { useT, type MessageKey } from '../i18n'
import { useChats } from '../store/chats'
import { isAdmin, isOwner, useMeStrict } from '../store/session'
import { useWelcome } from '../store/welcome'
import { showResume } from '../lib/welcome'
import { NewChatComposer } from '../components/chat/NewChatComposer'
import { FrequentQuestions } from '../components/FrequentQuestions'
import { PopularSkills } from '../components/PopularSkills'
import { WelcomeResume } from '../components/onboarding/WelcomeResume'
import { HomeGoal } from '../components/onboarding/GoalCard'

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
  const [preset, setPreset] = useState<{ text: string; n: number } | null>(prompt ? { text: prompt, n: 0 } : null)

  useEffect(() => {
    if (!projectId) return setProject(null)
    let live = true
    api.call(API.getProject, { params: { id: projectId } }).then((p) => live && setProject(p), () => live && setProject(null))
    return () => {
      live = false
    }
  }, [projectId])

  const firstTime = chatsLoaded && chats.length === 0

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-10">
        <div className="w-full max-w-[720px]">
          {isAdmin(me) && <HomeTop owner={isOwner(me)} />}
          {project && (
            <p className="mb-2 text-center text-sm text-muted">
              <Link to={`/projects/${project.id}`} className="font-medium text-accent-text hover:underline">
                {project.name}
              </Link>{' '}
              · {t('home.inProject')}
            </p>
          )}
          <h1 className="mb-6 text-center text-[26px] font-semibold tracking-tight sm:text-[28px]">{t('home.greeting', { name: me.user.name })}</h1>
          <NewChatComposer
            projectId={projectId}
            initialText={preset?.text}
            resetKey={preset?.n ?? 0}
            // Only in-app PUSH navigation or a chosen preset requests focus; a document load keeps the skip link first.
            autoFocus={navigationType === 'PUSH' || (preset?.n ?? 0) > 0}
          />
          {firstTime && !projectId && <FirstTime onExample={(text) => setPreset({ text, n: (preset?.n ?? 0) + 1 })} />}
          {!projectId && <FrequentQuestions key={me.user.id} onChoose={(text) => setPreset({ text, n: (preset?.n ?? 0) + 1 })} />}
          {/* B-W7-7: the team's top skills, once two or more were used. A different key from FrequentQuestions: same-key
              siblings render twice */}
          {!projectId && <PopularSkills key={`skills-${me.user.id}`} limit={3} min={2} className="mt-6" onChoose={(text) => setPreset({ text, n: (preset?.n ?? 0) + 1 })} />}
        </div>
      </div>
      <p className="px-4 pb-3 text-center text-[11px] text-faint">{t('chat.footer')}</p>
    </div>
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
