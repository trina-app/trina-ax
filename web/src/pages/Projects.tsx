// Projects: a folder of the team folder + instructions. Chats opened inside a project use both as their default
// context. List (projects whose folder the person can read), create (folder they can write), project home: a box that
// starts a chat in the project and the person's chats in it, with the dev environment, the instructions and the
// folder's files as short lines beside them (like Claude's project page).
import { FileText, FolderKanban, Folder, Pencil, Plus, ScrollText, Share2, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { Chat, FileEntry, Group, Project, ProjectParticipant, User } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { formatRelative } from '../lib/format'
import { firstParagraph } from '../lib/markdown'
import { openTeamFile } from '../lib/sidePanel'
import { useLocale, useT } from '../i18n'
import { toast } from '../store/ui'
import { isAdmin, useMe } from '../store/session'
import FolderPicker from '../components/FolderPicker'
import { Markdown } from '../components/Markdown'
import { DisclosureRow } from '../components/DisclosureRow'
import { TitleMenu } from '../components/TitleMenu'
import { NewChatComposer } from '../components/chat/NewChatComposer'
import { Button, EmptyState, ErrorNote, Field, Modal, PageHeader, Skeleton, StickyHeader, confirmDialog, inputCls } from '../components/ui'
import { DevEnvRow } from './DevEnvSection'

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
  const load = async () => {
    try {
      setItems((await api.call(API.listProjects)).items)
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
      <div className="p-4 sm:p-6">
        {error && <ErrorNote onRetry={load}>{error}</ErrorNote>}
        {!items && !error && <Skeleton lines={4} />}
        {items && !items.length && <EmptyState icon={<FolderKanban size={28} />} title={t('projects.empty')} />}
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items?.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`} className="block h-full rounded-2xl border border-line bg-surface p-4 transition hover:bg-hover">
                <span className="flex items-center gap-2 font-medium">
                  <FolderKanban size={16} className="text-accent-text" aria-hidden /> {p.name}
                </span>
                <span className="mt-1 block truncate text-xs text-faint">{p.folderPath || t('files.root')}</span>
                {p.instructions && <span className="mt-2 line-clamp-2 block text-sm text-muted">{p.instructions}</span>}
              </Link>
            </li>
          ))}
        </ul>
      </div>
      {creating && <ProjectForm onClose={() => setCreating(false)} onSaved={(p) => navigate(`/projects/${p.id}`)} />}
    </div>
  )
}

function ProjectForm({ project, onClose, onSaved }: { project?: Project; onClose: () => void; onSaved: (p: Project) => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  // an existing project's folder is changed by admins only (the server refuses it for anyone else)
  const folderLocked = !!project && !isAdmin(me)
  // new project (design tab 5): on an existing folder, a personal one (users/<me>/projects/), or, for admins, a new
  // team folder projects/<slug> with the groups / people who work in it
  const [mode, setMode] = useState<'existing' | 'personal' | 'team'>('existing')
  const [groups, setGroups] = useState<Group[]>([])
  const [people, setPeople] = useState<User[]>([])
  const [participants, setParticipants] = useState<ProjectParticipant[]>([])
  useEffect(() => {
    if (project || mode !== 'team' || !isAdmin(me)) return
    api.call(API.listGroups).then((r) => setGroups(r.items), () => setGroups([]))
    api.call(API.listUsers).then((r) => setPeople(r.items.filter((u) => u.status === 'active')), () => setPeople([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])
  const toggle = (x: ProjectParticipant) =>
    setParticipants((cur) => (cur.some((y) => y.subjectType === x.subjectType && y.subjectId === x.subjectId) ? cur.filter((y) => !(y.subjectType === x.subjectType && y.subjectId === x.subjectId)) : [...cur, x]))
  const picked = (x: ProjectParticipant) => participants.some((y) => y.subjectType === x.subjectType && y.subjectId === x.subjectId)
  const [name, setName] = useState(project?.name ?? '')
  const [folder, setFolder] = useState(project?.folderPath ?? '')
  const [instructions, setInstructions] = useState(project?.instructions ?? '')
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const p = project
        ? await api.call(API.updateProject, { params: { id: project.id }, body: { name: name.trim(), instructions, ...(folder !== project.folderPath ? { folderPath: folder } : {}) } })
        : await api.call(API.createProject, {
            body:
              mode === 'personal' ? { name: name.trim(), scope: 'personal', instructions, participants: [] }
              : mode === 'team' ? { name: name.trim(), scope: 'team', instructions, participants }
              : { name: name.trim(), scope: 'team', folderPath: folder, instructions, participants: [] },
          })
      onSaved(p)
      onClose()
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={project ? t('projects.edit') : t('projects.new')}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={save} data-testid="project-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('projects.name')}>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} data-autofocus data-testid="project-name" />
        </Field>
        {!project && (
          <Field label={t('projects.kind')}>
            <div className="flex flex-wrap gap-3 text-sm" role="radiogroup">
              {(['existing', 'personal', ...(isAdmin(me) ? ['team' as const] : [])] as const).map((m) => (
                <label key={m} className="flex items-center gap-1.5">
                  <input type="radio" name="project-kind" checked={mode === m} onChange={() => setMode(m)} data-testid={`project-kind-${m}`} /> {t(`projects.kind.${m}`)}
                </label>
              ))}
            </div>
          </Field>
        )}
        {!project && mode === 'team' && (
          <Field label={t('projects.participants')} hint={t('projects.participantsHint')}>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-line p-2 text-sm" data-testid="project-participants">
              {groups.map((g) => (
                <label key={`g:${g.id}`} className="flex items-center gap-2">
                  <input type="checkbox" checked={picked({ subjectType: 'group', subjectId: g.id })} onChange={() => toggle({ subjectType: 'group', subjectId: g.id })} /> {g.name}
                </label>
              ))}
              {people.map((u) => (
                <label key={`u:${u.id}`} className="flex items-center gap-2">
                  <input type="checkbox" checked={picked({ subjectType: 'user', subjectId: u.id })} onChange={() => toggle({ subjectType: 'user', subjectId: u.id })} /> {u.name}
                </label>
              ))}
            </div>
          </Field>
        )}
        {(project || mode === 'existing') && <Field label={t('projects.folder')} hint={t('projects.folderHint')}>
          <div className="flex gap-2">
            <input className={inputCls} value={folder || t('files.root')} readOnly />
            {!folderLocked && <Button onClick={() => setPicking(true)}>{t('common.choose')}</Button>}
          </div>
        </Field>}
        <Field label={t('projects.instructions')} hint={t('projects.instructionsHint')}>
          <textarea className={`${inputCls} h-40 resize-y py-2`} value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={50_000} />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
      <FolderPicker
        open={picking}
        title={t('projects.folder')}
        confirmLabel={t('common.choose')}
        initial={folder}
        onPick={(p) => {
          setFolder(p)
          setPicking(false)
        }}
        onClose={() => setPicking(false)}
      />
    </Modal>
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
  // a personal project (users/<me>/...) is shared by copying its folder into a team folder (design tab 5)
  const personal = !!p && !!me && p.folderPath.startsWith(`users/${me.user.id}/`)
  const shareTo = async (toParent: string) => {
    setSharing(false)
    if (!p) return
    try {
      const dry = await api.call(API.shareProject, { params: { id: p.id }, body: { toParent, dryRun: true } })
      const n = 'viewersAdded' in dry ? dry.viewersAdded : 0
      if (!(await confirmDialog({ title: t('projects.shareTitle'), body: t('projects.shareBody', { n }), confirm: t('files.shareCopy') }))) return
      const r = await api.call(API.shareProject, { params: { id: p.id }, body: { toParent } })
      if ('id' in r) {
        setP(r)
        toast({ level: 'success', text: t('files.shared', { path: r.folderPath }) })
      }
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }

  useEffect(() => {
    let live = true
    setP(null)
    api.call(API.getProject, { params: { id: projectId! } }).then(
      (x) => {
        if (!live) return
        setP(x)
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

  const del = async () => {
    if (!p || !(await confirmDialog({ title: t('projects.deleteTitle', { name: p.name }), body: t('projects.deleteBody'), confirm: t('common.delete'), danger: true }))) return
    try {
      await api.call(API.deleteProject, { params: { id: p.id } })
      navigate('/projects')
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
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
          <Link to="/projects" className="shrink-0 text-muted hover:text-ink">
            {t('projects.title')}
          </Link>
          <span className="text-faint" aria-hidden>
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
        <h1 className="text-[26px] font-semibold tracking-tight break-words sm:text-[30px]">{p.name}</h1>
        {summary && (
          <p className="mt-1.5 line-clamp-2 max-w-3xl text-sm text-muted" data-testid="project-summary">
            {summary}
          </p>
        )}
        {/* phone: the box, then the side lines, then the chats; wide: the chats under the box, the lines beside them */}
        <div className="mt-6 grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-[auto_1fr]">
          <div className="min-w-0 lg:col-start-1">
            <NewChatComposer projectId={p.id} placeholder={t('projects.newChat')} />
          </div>
          <aside aria-label={t('projects.about')} className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
            <div className="divide-y divide-line">
              <DevEnvRow project={p} />
              <DisclosureRow
                testId="project-instructions"
                icon={<ScrollText size={16} />}
                label={t('projects.instructions')}
                action={p.canEdit ? <button type="button" className={sideAction} onClick={() => setEditing(true)}>{t('common.edit')}</button> : undefined}
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
            <p className="mt-3 truncate text-xs text-faint" title={p.folderPath || t('files.root')}>
              {p.folderPath || t('files.root')}
            </p>
          </aside>
          <section aria-labelledby="pj-chats" className="min-w-0 lg:col-start-1" data-testid="project-chats">
            <h2 id="pj-chats" className="mb-1 text-sm text-muted">
              {t('projects.myChats')}
            </h2>
            {!chats && <Skeleton lines={3} />}
            {chats && !chats.length && <p className="py-2 text-sm text-faint">{t('projects.noChats')}</p>}
            <ul className="divide-y divide-line">
              {chats?.map((c) => (
                <li key={c.id}>
                  <Link to={`/c/${c.id}`} className="-mx-2 flex items-center gap-4 rounded-md px-2 py-3 text-sm hover:bg-hover">
                    <span className="min-w-0 flex-1 truncate">{c.title || t('chat.untitled')}</span>
                    <span className="shrink-0 text-xs text-faint">{formatRelative(c.updatedAt, locale)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
      {editing && <ProjectForm project={p} onClose={() => setEditing(false)} onSaved={setP} />}
      <FolderPicker open={sharing} title={t('projects.share')} confirmLabel={t('files.shareHere')} initial="shared" onPick={(x) => void shareTo(x)} onClose={() => setSharing(false)} />
    </div>
  )
}
