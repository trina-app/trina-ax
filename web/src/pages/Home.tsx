// New chat. First-time members see which folders their AI can see and three example questions (filled with
// their folder names, no engine call); the owner sees a setup checklist until it is done (tab 5 "상태별 화면").
import { CheckCircle2, Circle, Folder, Lock, Pencil, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import type { Attachment, FileEntry, Project } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { useT, type MessageKey } from '../i18n'
import { useChats } from '../store/chats'
import { useEngines } from '../store/engines'
import { isAdmin, isOwner, useMeStrict } from '../store/session'
import Composer, { type EngineChoice } from '../components/chat/Composer'

export default function Home() {
  const t = useT()
  const me = useMeStrict()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const projectId = params.get('project')
  const prompt = params.get('prompt') ?? undefined
  const chats = useChats((s) => s.chats)
  const chatsLoaded = useChats((s) => s.chatsLoaded)
  const send = useChats((s) => s.send)
  const upsertChat = useChats((s) => s.upsertChat)
  const models = useEngines((s) => s.models)
  const loadEngines = useEngines((s) => s.load)
  const [engine, setEngine] = useState<EngineChoice>({ engine: me.user.prefs.engine, model: me.user.prefs.model ?? null })
  const [project, setProject] = useState<Project | null>(null)
  const created = useRef<Promise<string> | null>(null)
  const [preset, setPreset] = useState<{ text: string; n: number } | null>(prompt ? { text: prompt, n: 0 } : null)

  useEffect(() => {
    if (isAdmin(me)) void loadEngines()
  }, [me, loadEngines])
  useEffect(() => {
    if (!projectId) return setProject(null)
    let live = true
    api.call(API.getProject, { params: { id: projectId } }).then((p) => live && setProject(p), () => live && setProject(null))
    return () => {
      live = false
    }
  }, [projectId])

  const ensureChat = () =>
    (created.current ??= api
      .call(API.createChat, { body: { projectId: projectId ?? null, engine: engine.engine, model: engine.model ?? undefined } })
      .then((c) => {
        upsertChat(c)
        return c.id
      })
      .catch((e) => {
        created.current = null
        throw e
      }))

  const onSend = async (text: string, attachments: Attachment[]) => {
    const chatId = created.current ? await created.current : null
    const r = await send({ chatId, content: text, attachments, author: { id: me.user.id, name: me.user.name }, projectId, engine: engine.engine, model: engine.model })
    navigate(`/c/${r.chatId}`)
  }

  const firstTime = chatsLoaded && chats.length === 0
  const draftId = projectId ? `project:${projectId}` : 'new'

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
            onEngine={setEngine}
            models={models}
            initialText={preset?.text}
            autoFocus
          />
          {firstTime && !projectId && <FirstTime onExample={(text) => setPreset({ text, n: (preset?.n ?? 0) + 1 })} />}
        </div>
      </div>
      <p className="px-4 pb-3 text-center text-[11px] text-faint">{t('chat.footer')}</p>
    </div>
  )
}

const EXAMPLES: MessageKey[] = ['home.example1', 'home.example2', 'home.example3']

/** "내 AI가 볼 수 있는 폴더" + example questions (translated templates, filled with the person's folder names). */
function FirstTime({ onExample }: { onExample: (text: string) => void }) {
  const t = useT()
  const [folders, setFolders] = useState<FileEntry[] | null>(null)
  useEffect(() => {
    let live = true
    api.call(API.tree, { query: { path: '', limit: 50 } }).then(
      (r) => live && setFolders(r.entries.filter((e) => e.type === 'folder' && e.access !== 'none')),
      () => live && setFolders([]),
    )
    return () => {
      live = false
    }
  }, [])
  const names = useMemo(() => (folders ?? []).map((f) => f.name), [folders])
  if (!folders) return null
  return (
    <div className="mt-6 space-y-4">
      <section className="rounded-2xl border border-line bg-surface p-4" aria-labelledby="ft-folders">
        <h2 id="ft-folders" className="mb-2 text-sm font-semibold">
          {t('home.foldersTitle')}
        </h2>
        {folders.length ? (
          <ul className="flex flex-wrap gap-2">
            {folders.map((f) => (
              <li key={f.path} className="inline-flex items-center gap-1.5 rounded-lg bg-subtle px-2.5 py-1.5 text-sm">
                <Folder size={14} className="text-accent-text" aria-hidden />
                {f.name}
                <span className="inline-flex items-center gap-0.5 text-xs text-faint">
                  {f.access === 'write' ? <Pencil size={11} aria-hidden /> : <Lock size={11} aria-hidden />}
                  {t(f.access === 'write' ? 'files.canWrite' : 'files.readOnly')}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">{t('home.noFolders')}</p>
        )}
      </section>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {EXAMPLES.map((k, i) => {
          const text = t(k, { folder: names[i % Math.max(1, names.length)] ?? t('files.root') })
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
        folders: f.status === 'fulfilled' && f.value.items.length > 0,
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
