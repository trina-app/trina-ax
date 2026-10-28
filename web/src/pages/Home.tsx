// New chat. First-time members see which folders their AI can see and three example questions (filled with
// their folder names, no engine call); the owner sees a setup checklist until it is done (tab 5 "상태별 화면").
import { CheckCircle2, Circle, Folder, Lock, Pencil, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom'
import type { Attachment, FileEntry, Project } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { draftChat, draftChatIfAny, forgetDraftChat, rememberChat } from '../lib/teamAttach'
import { visibleFolders } from '../lib/visibleFolders'
import { useT, type MessageKey } from '../i18n'
import { useChats } from '../store/chats'
import { useEngines } from '../store/engines'
import { canChooseEngine, isOwner, useMeStrict } from '../store/session'
import Composer, { type EngineChoice } from '../components/chat/Composer'
import { FrequentQuestions } from '../components/FrequentQuestions'

export default function Home() {
  const t = useT()
  const me = useMeStrict()
  const navigate = useNavigate()
  const navigationType = useNavigationType()
  const [params] = useSearchParams()
  const projectId = params.get('project')
  const prompt = params.get('prompt') ?? undefined
  const chats = useChats((s) => s.chats)
  const chatsLoaded = useChats((s) => s.chatsLoaded)
  const send = useChats((s) => s.send)
  const upsertChat = useChats((s) => s.upsertChat)
  const models = useEngines((s) => s.models)
  const engines = useEngines((s) => s.engines)
  const loadEngines = useEngines((s) => s.load)
  // the engine / model are the admin's choice: only people allowed to pick see a picker and send a choice (starting
  // from their own default, Settings); everyone else sends none and gets the team default
  const choose = canChooseEngine(me)
  const [picked, setEngine] = useState<EngineChoice>({ engine: me.user.prefs.engine, model: me.user.prefs.model ?? null })
  const engine: EngineChoice = choose ? picked : { engine: undefined, model: undefined }
  const [project, setProject] = useState<Project | null>(null)
  const [preset, setPreset] = useState<{ text: string; n: number } | null>(prompt ? { text: prompt, n: 0 } : null)

  useEffect(() => {
    if (choose) void loadEngines()
  }, [choose, loadEngines])
  useEffect(() => {
    if (!projectId) return setProject(null)
    let live = true
    api.call(API.getProject, { params: { id: projectId } }).then((p) => live && setProject(p), () => live && setProject(null))
    return () => {
      live = false
    }
  }, [projectId])

  const draftId = projectId ? `project:${projectId}` : 'new'
  // the chat a draft's attachments go into: kept with the draft (lib/teamAttach), so chips kept while the person was
  // on another page are still sent into the chat they were attached to
  const ensureChat = () =>
    draftChat(me.user.id, draftId, () =>
      api.call(API.createChat, { body: { projectId: projectId ?? null, engine: engine.engine, model: engine.model ?? undefined } }).then((c) => {
        upsertChat(c)
        return c.id
      }),
    )

  const onSend = async (text: string, attachments: Attachment[]) => {
    const pending = draftChatIfAny(me.user.id, draftId)
    const chatId = pending ? await pending : null
    const r = await send({ chatId, content: text, attachments, author: { id: me.user.id, name: me.user.name }, projectId, engine: engine.engine, model: engine.model })
    forgetDraftChat(me.user.id, draftId)
    // the current chat from now on, before the (lazily loaded) chat page mounts and says so itself: "Add to …" on the
    // file screen was missing when the person went there that quickly (e2e team-files, flaky)
    rememberChat(me.user.id, r.chatId)
    navigate(`/c/${r.chatId}`)
  }

  const firstTime = chatsLoaded && chats.length === 0

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-10">
        <div className="w-full max-w-[720px]">
          {isOwner(me) && <OwnerChecklist />}
          {project && (
            <p className="mb-2 text-center text-sm text-muted">
              <Link to={`/projects/${project.id}`} className="font-medium text-accent-text hover:underline">
                {project.name}
              </Link>{' '}
              · {t('home.inProject')}
            </p>
          )}
          <h1 className="mb-6 text-center text-[26px] font-semibold tracking-tight sm:text-[28px]">{t('home.greeting', { name: me.user.name })}</h1>
          <Composer
            key={`${draftId}-${preset?.n ?? 0}`}
            draftId={draftId}
            ensureChat={ensureChat}
            running={false}
            onSend={onSend}
            onStop={async () => {}}
            engine={engine}
            onEngine={choose ? setEngine : undefined}
            engines={engines}
            models={models}
            initialText={preset?.text}
            // Only in-app PUSH navigation or a chosen preset requests focus; a document load keeps the skip link first.
            autoFocus={navigationType === 'PUSH' || (preset?.n ?? 0) > 0}
          />
          {firstTime && !projectId && <FirstTime onExample={(text) => setPreset({ text, n: (preset?.n ?? 0) + 1 })} />}
          {!projectId && <FrequentQuestions key={me.user.id} onChoose={(text) => setPreset({ text, n: (preset?.n ?? 0) + 1 })} />}
        </div>
      </div>
      <p className="px-4 pb-3 text-center text-[11px] text-faint">{t('chat.footer')}</p>
    </div>
  )
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

const CHECK_KEY = 'mycel.ownerChecklistHidden'

/** Owner's first screen: AI connection · invite members · folder permissions · backups. Hidden once all done. */
function OwnerChecklist() {
  const t = useT()
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(CHECK_KEY) === '1' } catch { return false }
  })
  const [state, setState] = useState<{ engine: boolean; members: boolean; folders: boolean; backup: boolean } | null>(null)
  useEffect(() => {
    if (hidden) return
    let live = true
    Promise.allSettled([api.call(API.engines), api.call(API.listUsers), api.call(API.listInvites), api.call(API.listFolders), api.call(API.listBackups)]).then(([e, u, i, f, b]) => {
      if (!live) return
      setState({
        engine: e.status === 'fulfilled' && e.value.engines.some((x) => x.enabled && x.status === 'ok'),
        members: (u.status === 'fulfilled' && u.value.items.length > 1) || (i.status === 'fulfilled' && i.value.items.length > 0),
        // the starting rules (shared/ and skills/, updatedBy null) come with every new team: done once someone set one
        folders: f.status === 'fulfilled' && f.value.items.some((x) => x.rules.some((r) => r.updatedBy !== null)),
        backup: b.status === 'fulfilled' && b.value.items.length > 0,
      })
    })
    return () => {
      live = false
    }
  }, [hidden])
  if (hidden || !state || Object.values(state).every(Boolean)) return null
  const items: { done: boolean; label: MessageKey; to: string }[] = [
    { done: state.engine, label: 'owner.check.engine', to: '/admin/engines' },
    { done: state.members, label: 'owner.check.members', to: '/admin/members' },
    { done: state.folders, label: 'owner.check.folders', to: '/admin/folders' },
    { done: state.backup, label: 'owner.check.backup', to: '/admin/system' },
  ]
  return (
    <section className="mb-8 rounded-2xl border border-line bg-surface p-4" aria-labelledby="owner-check" data-testid="owner-checklist">
      <div className="mb-2 flex items-center justify-between">
        <h2 id="owner-check" className="text-sm font-semibold">
          {t('owner.check.title')}
        </h2>
        <button
          type="button"
          aria-label={t('common.hide')}
          className="rounded p-1 text-faint hover:bg-hover"
          onClick={() => {
            try { localStorage.setItem(CHECK_KEY, '1') } catch { /* ignore */ }
            setHidden(true)
          }}
        >
          <X size={15} />
        </button>
      </div>
      <ul className="grid gap-1 sm:grid-cols-2">
        {items.map((it) => (
          <li key={it.label}>
            <Link to={it.to} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-hover">
              {it.done ? <CheckCircle2 size={16} className="text-ok" aria-label={t('common.done')} /> : <Circle size={16} className="text-faint" aria-label={t('common.todo')} />}
              <span className={it.done ? 'text-faint line-through' : ''}>{t(it.label)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
