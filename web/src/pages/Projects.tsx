// Projects: a folder of the team folder + instructions, one project per folder. Chats opened inside a project use both
// as their default context. List (projects whose folder the person can read), create (folder they can write; the
// dialog is components/ProjectForm.tsx, also opened from a folder on the Files page), project home: a box that
// starts a chat in the project and the person's chats in it, with the instructions and the folder's files as short
// lines beside them (like Claude's project page). No dev environment line: on the srt runner that setting is the team's,
// in Team settings, and a chat shows its own runs (docs/DECISIONS.md "Dev environment: no line on the project page").
// Shared project chats (docs/DECISIONS.md "Shared project chats"): the setting is in the edit dialog (ProjectForm), the
// list is "채팅" (my chats there and every shared chat of the project I can see, those with the people icon and the
// faces of who wrote in them: ProjectChatRow; it follows chat events, so another person's new chat shows at once), the
// box says who sees a new chat, and deleting the project says its shared chats go to their creators' trash. My pinned
// chats there come first, the most recently pinned first, with the sidebar's pin before the title (docs/DECISIONS.md
// "Pinned chats"; pinning is the sidebar row's "···").
// Each card on the list has a "…" (the rooms lists' row menu): 이름 바꾸기 and 삭제 for people who may edit the project
// (the same rename prompt as a chat's, the same delete confirm as on the project page), 링크 복사 for everyone.
import { FileText, FolderKanban, Folder, Link2, Pencil, Pin, Plus, ScrollText, Share2, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { Chat, FileEntry, Project, ProjectParticipant } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { formatRelative } from '../lib/format'
import { firstParagraph } from '../lib/markdown'
import { openTeamFile } from '../lib/sidePanel'
import { aiName } from '../lib/tabs'
import { useLocale, useT } from '../i18n'
import { toast } from '../store/ui'
import { useChats } from '../store/chats'
import { chatChanged } from '../store/live'
import { chatTrashDays } from '../lib/chat-trash'
import { useProjects } from '../store/projects'
import { isAdmin, useMe } from '../store/session'
import { Markdown } from '../components/Markdown'
import { DisclosureRow } from '../components/DisclosureRow'
import { TitleMenu } from '../components/TitleMenu'
import { NewChatComposer } from '../components/chat/NewChatComposer'
import { ChatFaces, SharedIcon } from '../components/chat/SharedChat'
import { MenuButton, type MenuItem } from '../components/rooms/MenuButton'
import { ProjectForm } from '../components/ProjectForm'
import { AccessSummary, ParticipantPicker, participantKey, summaryNames, useAccessCount, useParticipantOptions } from '../components/ProjectParticipants'
import { ProjectTrashNote } from '../components/ProjectTrashNote'
import { Button, EmptyState, ErrorNote, Field, Modal, PageHeader, Skeleton, StickyHeader, confirmDialog, menuOpener, pageColumn, promptDialog, useCopy } from '../components/ui'
import { useFocusAfterRemove } from './admin/common'
import { useFolderWords } from '../lib/folderLabels'

/** A project's chats as its page lists them: my pinned ones first (the most recently pinned first, as the server's first
 * page has them), then the newest. */
const chatOrder = (a: Chat, b: Chat) =>
  a.pinnedAt || b.pinnedAt
    ? (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? '')
    : a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? 1 : -1

/** The address of a project's page (the app's own route; someone who cannot see the project gets "not found"). */
const projectLink = (id: string) => `${typeof location === 'undefined' ? '' : location.origin}/projects/${id}`

/** Deleting a project, from its page and from its card on the list: one confirm (its shared chats go to their creators'
 * trash, by its name in the sidebar: said when it has any, by the count the server gives now, not the one the page
 * loaded with) and one call. True when it is gone (also when someone else deleted it first). */
function useDeleteProject() {
  const t = useT()
  const locale = useLocale()
  const days = chatTrashDays(useMe())
  const words = useFolderWords()
  const deleted = (id: string) => {
    useProjects.getState().drop(id)
    // the server took the project off its private chats (its shared chats go to the trash with their own event): the
    // history must not offer "프로젝트 바꾸기…" for a project that is not there any more
    useChats.setState((s) => ({ chats: s.chats.map((c) => (c.projectId === id && !c.shared ? { ...c, projectId: null } : c)) }))
  }
  // not found: deleted by someone else, or no longer mine to see (then my chats keep it, as the server does)
  const missing = (id: string) => {
    useProjects.getState().drop(id)
    toast({ level: 'info', text: t('projects.missing') })
  }
  return async (p: Project): Promise<boolean> => {
    // the menu is gone once the count below has arrived: the keyboard goes back to its button
    const opener = menuOpener() ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    let now = p
    try {
      now = await api.call(API.getProject, { params: { id: p.id } })
    } catch (e) {
      if (isApiError(e, 'not_found')) {
        missing(p.id)
        return true
      }
    }
    // the person left the page while it was asked: no confirm on another page
    if (opener && !opener.isConnected) return false
    opener?.focus()
    const text = now.sharedChats ? t('projects.deleteBodyShared', { days, trash: t('sidebar.trash') }) : t('projects.deleteBody')
    // a team project's own folder in projects/ may go to the files trash with it (its creator could not trash a folder
    // that carries rules otherwise); off unless ticked
    let trashFolder = false
    const offerTrash = /^projects\/[^/]+$/.test(now.folderPath) && !now.inTrash
    const body = offerTrash ? (
      <div className="space-y-3">
        <p>{text}</p>
        <label className="flex items-start gap-2 text-ink">
          <input type="checkbox" className="mt-1" onChange={(e) => { trashFolder = e.target.checked }} data-testid="project-delete-trash-folder" />
          <span className="break-keep">{t('projects.deleteTrashFolder', { folder: words.path(now.folderPath) })}</span>
        </label>
      </div>
    ) : text
    if (!(await confirmDialog({ title: t('projects.deleteTitle', { name: now.name }), body, confirm: t('common.delete'), danger: true }))) return false
    try {
      await api.call(API.deleteProject, { params: { id: p.id }, query: trashFolder ? { trashFolder: '1' } : {} })
      deleted(p.id)
      return true
    } catch (e) {
      if (isApiError(e, 'not_found')) {
        missing(p.id)
        return true
      }
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      return false
    }
  }
}

/** A card's "…" on the list (components/rooms/MenuButton.tsx: arrow keys, Esc, a bottom sheet on phones). On a computer
 * it shows on hover and keyboard focus, on a touch screen always. */
function ProjectCardMenu({ project: p, onRenamed, onDeleted }: { project: Project; onRenamed: (p: Project) => void; onDeleted: () => void }) {
  const t = useT()
  const locale = useLocale()
  const { copy } = useCopy()
  const remove = useDeleteProject()
  // the item goes with the menu: the keyboard waits on "…", and a dialog an item opens gives it back there
  const more = useRef<HTMLButtonElement>(null)
  const select = (fn: () => unknown) => () => {
    more.current?.focus()
    void fn()
  }
  const rename = async () => {
    const name = await promptDialog({ title: t('chat.rename'), label: t('projects.name'), initial: p.name, confirm: t('common.save') })
    if (!name || name === p.name) return
    try {
      const r = await api.call(API.updateProject, { params: { id: p.id }, body: { name } })
      useProjects.getState().put(r)
      onRenamed(r)
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }
  const copyLink = async () => {
    await copy(projectLink(p.id))
    toast({ level: 'success', text: t('rooms.menu.linkCopied') })
  }
  const items: MenuItem[] = [
    ...(p.canEdit ? [{ label: t('chat.rename'), icon: <Pencil size={14} aria-hidden />, onSelect: select(rename), testId: 'project-card-rename' }] : []),
    { label: t('rooms.menu.copyLink'), icon: <Link2 size={14} aria-hidden />, onSelect: select(copyLink), testId: 'project-card-copy-link' },
    ...(p.canEdit ? [{ label: t('common.delete'), icon: <Trash2 size={14} aria-hidden />, danger: true, onSelect: select(() => remove(p).then((gone) => gone && onDeleted())), testId: 'project-card-delete' }] : []),
  ]
  return (
    <MenuButton
      label={t('rooms.menu.rowLabel', { name: p.name })}
      tip={t('rooms.menu.label')}
      items={items}
      sheetTitle={p.name}
      // in line with the name's first line, its right edge at the card's padding
      className="absolute top-3.5 right-2.5"
      // phones: taps from a 44 px box around it
      buttonClassName="touch-hit pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-has-[:focus-visible]:opacity-100 aria-expanded:opacity-100 focus-visible:opacity-100"
      buttonRef={more}
      testId="project-card-menu"
    />
  )
}

export function ProjectList() {
  const t = useT()
  const locale = useLocale()
  const [items, setItems] = useState<Project[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // ?new=1 (from Search's "New project") opens the form at once; closing it drops the parameter
  const [params, setParams] = useSearchParams()
  const [creating, setCreatingState] = useState(params.get('new') === '1')
  const setCreating = (v: boolean) => {
    setCreatingState(v)
    if (!v && params.has('new')) setParams((p) => { p.delete('new'); return p }, { replace: true })
  }
  const navigate = useNavigate()
  // a card deleted from its menu: the keyboard goes on to the next card (or "New project" after the last one)
  const { box, removed } = useFocusAfterRemove(items, () => document.querySelector<HTMLElement>('[data-testid="project-new"]'))
  const load = async () => {
    try {
      const items = (await api.call(API.listProjects)).items
      useProjects.getState().put(...items)
      setItems(items)
      setError(null)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader
        title={t('projects.title')}
        desc={t('projects.desc')}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)} data-testid="project-new">
            <Plus size={15} aria-hidden /> {t('projects.new')}
          </Button>
        }
      />
      <div ref={box} className={`${pageColumn} p-4 sm:p-6`}>
        {error && <ErrorNote onRetry={load}>{error}</ErrorNote>}
        {!items && !error && <Skeleton lines={4} />}
        {items && !items.length && <EmptyState icon={<FolderKanban size={28} />} title={t('projects.empty')} />}
        <ul className="grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items?.map((p, i) => (
            <li key={p.id} className="group relative" data-testid="project-card">
              {/* the card stays marked while its "…" menu is open */}
              <Link to={`/projects/${p.id}`} className="block h-full rounded-2xl border border-line bg-surface p-4 transition group-has-[[aria-expanded=true]]:bg-hover hover:bg-hover" data-row-focus>
                {/* clear of the "…" in the card's corner; the icon stays on the first line of a long name */}
                <span className="flex items-start gap-2 pr-8 font-medium">
                  <FolderKanban size={16} className="mt-1 shrink-0 text-accent-text" aria-hidden /> <span className="min-w-0 break-words">{p.name}</span>
                </span>
                <span className="mt-1 block truncate text-xs text-faint">{p.folderPath || t('files.root')}</span>
                {/* plain text of the first paragraph, at most 2 lines ('block' would cancel line-clamp's display) */}
                {p.instructions && <span className="mt-2 line-clamp-2 text-sm text-muted">{firstParagraph(p.instructions)}</span>}
              </Link>
              <ProjectCardMenu
                project={p}
                onRenamed={(r) => setItems((xs) => xs && xs.map((x) => (x.id === r.id ? { ...x, ...r } : x)))}
                onDeleted={() => {
                  removed(i)
                  setItems((xs) => xs && xs.filter((x) => x.id !== p.id))
                }}
              />
            </li>
          ))}
        </ul>
      </div>
      {creating && <ProjectForm onClose={() => setCreating(false)} onSaved={(p) => navigate(`/projects/${p.id}`)} />}
    </div>
  )
}

/** A chat on a project's page: its title and when it last changed. A shared chat has the people icon before the title
 * and the faces of the people who wrote in it before the time (ChatFaces: one person with the name); a chat of mine
 * has neither. The title gives way first: the faces and the time keep their room. */
export function ProjectChatRow({ chat: c }: { chat: Chat }) {
  const t = useT()
  const locale = useLocale()
  // the row's keyboard focus shows the names on the faces (they take no focus of their own inside the link)
  const row = useRef<HTMLAnchorElement>(null)
  return (
    <Link ref={row} to={`/c/${c.id}`} className="group -mx-2 flex items-center gap-4 rounded-md px-2 py-3 text-sm hover:bg-hover" data-shared={c.shared ? 'true' : undefined} data-testid="project-chat">
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {c.pinnedAt && <Pin size={12} role="img" aria-label={t('chat.pinned')} className="shrink-0 text-faint" data-testid="chat-pin-icon" />}
        {c.shared && <SharedIcon className="text-faint" />}
        <span className="truncate">{c.title || t('chat.untitled')}</span>
      </span>
      <span className="flex max-w-[45%] shrink-0 items-center gap-1.5 text-xs text-faint">
        {c.shared && (
          <>
            <ChatFaces shared={c.shared} focusFrom={row} />
            <span aria-hidden>·</span>
          </>
        )}
        <span className="shrink-0">{formatRelative(c.updatedAt, locale)}</span>
      </span>
    </Link>
  )
}

export function ProjectHome() {
  const t = useT()
  const locale = useLocale()
  const { projectId } = useParams()
  const navigate = useNavigate()
  const [p, setP] = useState<Project | null>(null)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [chats, setChats] = useState<Chat[] | null>(null)
  // failed: the folder could not be read (a network error); the line then says no count rather than a wrong one
  const [files, setFiles] = useState<{ entries: FileEntry[]; more: boolean; failed?: boolean } | null>(null)
  const [editing, setEditing] = useState(false)
  const [sharing, setSharing] = useState(false)
  const me = useMe()
  // a personal project (users/<me>/...) becomes a team project: a new projects/<name> with the people chosen, its files
  // copied there (docs/DECISIONS.md "Projects live only in projects/"); not when the team lets only admins make them
  const personal = !!p && !!me && p.folderPath.startsWith(`users/${me.user.id}/`) && (isAdmin(me) || me.team.projectCreators === 'members')

  useEffect(() => {
    let live = true
    setP(null)
    api.call(API.getProject, { params: { id: projectId! } }).then(
      (x) => {
        if (!live) return
        setP(x)
        useProjects.getState().put(x)
        api.call(API.listChats, { query: { projectId: x.id, limit: 50 } }).then((r) => live && setChats(r.items), () => live && setChats([]))
        api.call(API.tree, { query: { path: x.folderPath, limit: 100 } }).then((r) => live && setFiles({ entries: r.entries, more: !!r.nextCursor }), () => live && setFiles({ entries: [], more: false, failed: true }))
      },
      (e) => {
        if (!live) return
        if (isApiError(e, 'not_found')) setMissing(true)
        else setError(errorText(e, locale, t('error.network')))
      },
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // the list follows chat events (store/live.ts chatChanged; the server sends each person only the chats they see): a
  // chat of this project made, renamed or restored shows, one deleted, moved away or no longer visible to me goes. The
  // faces of who wrote in a shared chat come with the list only, so a row keeps the ones it had
  useEffect(() => chatChanged.on(({ chatId, change, chat }) => {
    setChats((cur) => {
      if (!cur) return cur
      const old = cur.find((c) => c.id === chatId)
      const rest = cur.filter((c) => c.id !== chatId)
      if (change === 'deleted' || change === 'purged' || !chat || chat.deletedAt || chat.projectId !== projectId) return old ? rest : cur
      const next = old?.shared?.people && chat.shared && !chat.shared.people ? { ...chat, shared: { ...chat.shared, people: old.shared.people, peopleCount: old.shared.peopleCount } } : chat
      return [next, ...rest].sort(chatOrder)
    })
  }), [projectId])

  // its shared chats go to their creators' trash: said in the dialog when it has any
  const remove = useDeleteProject()
  const del = async () => {
    if (p && (await remove(p))) navigate('/projects')
  }

  if (missing) return <EmptyState title={t('projects.missing')}><Link to="/projects" className="text-accent-text underline">{t('projects.title')}</Link></EmptyState>
  if (error) return <div className="p-6"><ErrorNote>{error}</ErrorNote></div>
  if (!p) return <Skeleton lines={6} className="p-6" />
  const summary = firstParagraph(p.instructions)
  const folderLink = `/files?path=${encodeURIComponent(p.folderPath)}`
  const sideAction = 'rounded-md px-1.5 py-1 text-muted hover:bg-hover hover:text-ink'
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* like Claude's project page: where you are, with the few things you rarely do behind the name; it stays at the
          top while the page scrolls */}
      <StickyHeader bar className="flex h-12 shrink-0 items-center border-b border-line px-4 sm:px-6" testId="project-topline">
        <nav aria-label={t('files.breadcrumb')} className="flex min-w-0 items-center gap-1.5 text-sm">
          {/* phones: the top bar above says 프로젝트, with its ‹ (components/PhoneTopBar.tsx) */}
          <Link to="/projects" className="shrink-0 text-muted hover:text-ink max-md:hidden">
            {t('projects.title')}
          </Link>
          <span className="text-faint max-md:hidden" aria-hidden>
            /
          </span>
          {p.canEdit ? (
            <TitleMenu
              name={p.name}
              testId="project-menu"
              items={[
                { label: t('common.edit'), icon: <Pencil size={14} aria-hidden />, onSelect: () => setEditing(true), testId: 'project-edit' },
                ...(personal ? [{ label: t('projects.share'), icon: <Share2 size={14} aria-hidden />, onSelect: () => setSharing(true), testId: 'project-share' }] : []),
                { label: t('common.delete'), icon: <Trash2 size={14} aria-hidden />, onSelect: () => void del(), danger: true, testId: 'project-delete' },
              ]}
            />
          ) : (
            <span aria-current="page" className="truncate">
              {p.name}
            </span>
          )}
        </nav>
      </StickyHeader>
      <div className="mx-auto w-full max-w-[1080px] px-4 pt-8 pb-12 sm:px-6 sm:pt-10">
        <h1 className="text-[1.625rem] font-semibold tracking-tight break-words sm:text-[1.875rem]">{p.name}</h1>
        {summary && (
          <p className="mt-1.5 line-clamp-2 max-w-3xl text-sm text-muted" data-testid="project-summary">
            {summary}
          </p>
        )}
        {/* phone: the box, then the side lines, then the chats; wide: the chats under the box, the lines beside them */}
        <div className="mt-6 grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-[auto_1fr]">
          <div className="min-w-0 lg:col-start-1">
            {/* a project whose folder is in the trash (only admins see it) takes no chat: the line says why instead */}
            {p.inTrash ? <ProjectTrashNote project={p} /> : <NewChatComposer projectId={p.id} project={p} placeholder={t('projects.newChat')} />}
          </div>
          <aside aria-label={t('projects.about')} className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
            <div className="divide-y divide-line">
              <DisclosureRow
                testId="project-instructions"
                icon={<ScrollText size={16} />}
                label={t('projects.instructions')}
                // phones: the same 수정 as in the name's menu above, so not a second button here
                action={p.canEdit ? <button type="button" className={`${sideAction} max-md:hidden`} onClick={() => setEditing(true)}>{t('common.edit')}</button> : undefined}
              >
                {p.instructions ? <Markdown text={p.instructions} className="text-sm! leading-6! prose-headings:text-sm!" /> : <p className="text-faint">{t('projects.noInstructions')}</p>}
              </DisclosureRow>
              <DisclosureRow
                testId="project-files"
                icon={<Folder size={16} />}
                label={t('files.title')}
                meta={files && !files.failed && (files.more ? t('projects.itemsMore', { n: files.entries.length }) : t('projects.items', { n: files.entries.length }))}
                action={<Link to={folderLink} className={sideAction}>{t('projects.open')}</Link>}
              >
                {/* phones: the folder's path here, not as a line of its own under the rows */}
                <p className="mb-2 truncate text-xs text-faint md:hidden" title={p.folderPath || t('files.root')}>{p.folderPath || t('files.root')}</p>
                {!files && <Skeleton lines={3} />}
                {files && !files.failed && !files.entries.length && <p className="text-faint">{t('files.emptyReadOnly')}</p>}
                <ul className="-ml-2 space-y-0.5">
                  {files?.entries.slice(0, 30).map((f) => (
                    <li key={f.path}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-hover"
                        onClick={() => (f.type === 'folder' ? navigate(`/files?path=${encodeURIComponent(f.path)}`) : openTeamFile(f.path))}
                      >
                        {f.type === 'folder' ? <Folder size={14} className="shrink-0 text-accent-text" aria-hidden /> : <FileText size={14} className="shrink-0 text-faint" aria-hidden />}
                        <span className="truncate">{f.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {files && (files.more || files.entries.length > 30) && (
                  <Link to={folderLink} className="mt-1 inline-block text-xs text-accent-text hover:underline">
                    {t('projects.openFolder')}
                  </Link>
                )}
              </DisclosureRow>
            </div>
            <p className="mt-3 truncate text-xs text-faint max-md:hidden" title={p.folderPath || t('files.root')}>
              {p.folderPath || t('files.root')}
            </p>
          </aside>
          <section aria-labelledby="pj-chats" className="min-w-0 lg:col-start-1" data-testid="project-chats">
            {/* the sidebar's name for the AI's history ("트리나 기록"): one name for it on every screen */}
            <h2 id="pj-chats" className="mb-1 text-sm text-muted">
              {t('sidebar.aiChats', { name: aiName(t) })}
            </h2>
            {!chats && <Skeleton lines={3} />}
            {chats && !chats.length && <p className="py-2 text-sm text-faint">{t('projects.noChats')}</p>}
            <ul className="divide-y divide-line">
              {chats?.map((c) => (
                <li key={c.id}>
                  <ProjectChatRow chat={c} />
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
      {editing && <ProjectForm project={p} onClose={() => setEditing(false)} onSaved={setP} />}
      {sharing && <ShareProjectDialog project={p} onClose={() => setSharing(false)} onShared={(r) => { setP(r); useProjects.getState().put(r); toast({ level: 'success', text: t('files.shared', { path: r.folderPath }) }) }} />}
    </div>
  )
}

/** "팀 프로젝트로 공유": a personal project becomes a team project in a new projects/<name>, seen by the people chosen
 * here (and me, the owner and admins); its files are copied there and my personal folder stays. */
function ShareProjectDialog({ project, onClose, onShared }: { project: Project; onClose: () => void; onShared: (p: Project) => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const [participants, setParticipants] = useState<ProjectParticipant[]>([])
  const options = useParticipantOptions()
  const fixed = useMemo(() => new Map(me ? [[participantKey({ subjectType: 'user', subjectId: me.user.id }), t('projects.whoMe')]] : []), [me, t])
  const count = useAccessCount(participants, { enabled: true })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const share = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.call(API.shareProject, { params: { id: project.id }, body: { participants } })
      if ('id' in r) onShared(r)
      onClose()
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={t('projects.shareTitle')} width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={busy} onClick={share} data-testid="project-share-confirm">{t('projects.shareConfirm')}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm break-keep text-muted">{t('projects.shareBody')}</p>
        <Field label={t('projects.participants')}>
          <div className="space-y-2">
            <ParticipantPicker options={options} value={participants} onChange={setParticipants} fixed={fixed} />
            <AccessSummary names={summaryNames(t, participants, options, [t('projects.whoMe')])} count={count} />
          </div>
        </Field>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  )
}
