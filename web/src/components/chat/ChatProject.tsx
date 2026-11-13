// A chat's project in the chat header: the project's own name, linked to its page, before the chat's title (like
// Claude; on a phone a short chip with a folder icon, so the person still sees that the chat is in a project), and the dialog that the title menu's "Move to project" opens:
// it moves the chat into a project or out of it (PATCH /api/chats/:id {projectId}; the server checks that the person
// can see the project). Its first row "+ 새 프로젝트" makes a project named after the chat (NewProjectDialog.tsx: the name
// only, mine alone) and moves the chat in, with 되돌리기 in the toast (docs/DECISIONS.md "Making a project"). Each
// project says who sees it ("나만", "4명"), not its folder. A chat moved into a team project arrives private, with no
// switch here (QA TC-1075): the project page's "chats only you see" line is the one place to share it. The name comes from
// store/projects.ts, so a rename saved anywhere in this window shows at once;
// it is asked again when the window comes back to the front (a rename on another device). A project the person cannot
// see (404: no read access any more, or its folder in the trash) shows nothing.
import { FolderKanban, Plus } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Chat, Project } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { aiName } from '../../lib/tabs'
import { useProjects } from '../../store/projects'
import { toast } from '../../store/ui'
import { Button, Modal, Skeleton } from '../ui'
import { changeChat } from './chatActions'
import { NewProjectDialog } from '../NewProjectDialog'
import { whoSeesProject } from '../projectWho'

/** The chat's project as this window knows it (store/projects.ts), asked from the server for this chat and again when
 * the window gets the focus back; undefined while unknown or not to be seen. Only the latest answer counts: a slow 200
 * that arrives after a newer 404 does not bring the name back. */
export function useChatProject(projectId: string | null): Project | undefined {
  const project = useProjects((s) => (projectId ? s.byId[projectId] : undefined))
  const asked = useRef(0)
  const refresh = useCallback(() => {
    if (!projectId) return
    const mine = ++asked.current
    api.call(API.getProject, { params: { id: projectId } }).then(
      (p) => { if (mine === asked.current) useProjects.getState().put(p) },
      (e) => { if (mine === asked.current && isApiError(e, 'not_found')) useProjects.getState().drop(projectId) },
    )
  }, [projectId])
  useEffect(() => {
    refresh()
    if (typeof window === 'undefined' || !window.addEventListener) return
    const again = () => { if (document.visibilityState !== 'hidden') refresh() }
    window.addEventListener('focus', again)
    return () => window.removeEventListener('focus', again)
  }, [refresh])
  return project
}

/** "Project /" before the chat's title in the header: the project's name, linked to its page; nothing for a chat
 * outside a project or in one the person cannot see. Below "sm" it is a narrow chip (folder icon and a cut name) and
 * the title keeps most of the room. A project whose
 * folder is in the trash (only admins see it) says so after its name: no turn of the chat gets it. */
export function ChatProjectCrumb({ projectId }: { projectId: string | null }) {
  const t = useT()
  const project = useChatProject(projectId)
  if (!project) return null
  return (
    <>
      <Link
        to={`/projects/${project.id}`}
        title={t('chat.project.open', { name: project.name })}
        className="flex max-w-[35%] shrink-0 items-center gap-1 rounded-md bg-subtle px-1.5 py-1 text-xs text-muted hover:text-ink sm:max-w-[40%] sm:bg-transparent sm:text-sm"
        data-testid="chat-project"
      >
        <FolderKanban size={13} className="shrink-0 sm:hidden" aria-hidden />
        <span className="truncate">{project.name}</span>
      </Link>
      {project.inTrash && (
        <span className="hidden shrink-0 text-xs text-warn sm:inline" data-testid="chat-project-in-trash">
          {t('chat.project.inTrash')}
        </span>
      )}
      <span className="hidden text-faint sm:inline" aria-hidden>
        /
      </span>
    </>
  )
}

/**
 * The choices of the move dialog: no project, then each project the person can see (name and folder). The chat's own
 * project when it is not among them (its folder can no longer be read, or it is in the trash) is a choice of its own,
 * said as such: picking another one moves the chat out of it for good.
 */
export function ProjectChoices({ projects, selected, current, onSelect }: { projects: readonly Project[]; selected: string | null; current?: string | null; onSelect: (id: string | null) => void }) {
  const t = useT()
  const row = 'flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm hover:bg-hover'
  const hidden = current && !projects.some((p) => p.id === current) ? current : null
  return (
    <div role="radiogroup" aria-label={t('chat.project.title')} className="space-y-0.5" data-testid="chat-project-choices">
      {hidden && (
        <label className={row} data-testid="chat-project-hidden">
          <input type="radio" name="chat-project" checked={selected === hidden} onChange={() => onSelect(hidden)} />
          <FolderKanban size={14} className="shrink-0 text-faint" aria-hidden />
          <span className="min-w-0 flex-1 text-muted">{t('chat.project.hidden')}</span>
        </label>
      )}
      <label className={row}>
        <input type="radio" name="chat-project" checked={selected === null} onChange={() => onSelect(null)} />
        <span className="text-muted">{t('chat.project.none')}</span>
      </label>
      {projects.map((p) => (
        <label key={p.id} className={row} data-testid={p.inTrash ? 'chat-project-choice-in-trash' : undefined}>
          {/* a project whose folder is in the trash (only admins see it) takes no chat: the server refuses it */}
          <input type="radio" name="chat-project" checked={selected === p.id} disabled={!!p.inTrash} onChange={() => onSelect(p.id)} />
          <FolderKanban size={14} className={p.inTrash ? 'shrink-0 text-faint' : 'shrink-0 text-accent-text'} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{p.name}</span>
            {/* who sees it, in 프로젝트's words ("나만", "멤버 4명"), never a folder path */}
            <span className="block truncate text-xs text-faint" data-testid="chat-project-choice-who">{p.inTrash ? t('chat.project.inTrash') : p.folderPath.startsWith('users/') || (p.audience !== undefined && (p.audience <= 1 || !!p.alone)) ? t('projects.meta.me') : whoSeesProject(t, p, 'projects.whoMembers') ?? ''}</span>
          </span>
        </label>
      ))}
    </div>
  )
}

/** Move a chat into a project or out of it (null), at once on every list of this window and in `onMoved` (a page's own
 * copy), then on the server (lib/optimistic.ts). Into a project it leaves its list folder, as the server does. */
export function moveChat(chat: Chat, projectId: string | null, onMoved?: (c: Chat) => void, failText?: string) {
  type Place = { projectId: string | null; folderId?: string; updatedAt: string }
  return changeChat<Place>({
    chat,
    field: 'project',
    from: { projectId: chat.projectId, folderId: chat.folderId, updatedAt: chat.updatedAt },
    to: { projectId, folderId: projectId ? undefined : chat.folderId, updatedAt: new Date().toISOString() },
    apply: (c, v) => {
      const { folderId: _f, ...rest } = c
      return { ...rest, projectId: v.projectId, updatedAt: v.updatedAt, ...(v.folderId ? { folderId: v.folderId } : {}) }
    },
    send: () => api.call(API.updateChat, { params: { id: chat.id }, body: { projectId } }),
    confirmed: (c) => ({ projectId: c.projectId, folderId: c.folderId, updatedAt: c.updatedAt }),
    onShown: onMoved,
    failText,
  })
}

/** 되돌리기 after "+ 새 프로젝트": the chat goes back, then the project made in that step goes too while it is still as
 * it was made (the server checks: no chats, files, instructions or other members; DELETE ifEmpty). Anything else, or
 * a failure, leaves the project as it is: it is just there in 프로젝트. */
export async function undoMadeAndMove(chat: Chat, before: string | null, madeId: string, onMoved?: (c: Chat) => void) {
  const back = await moveChat(chat, before, onMoved)
  if (!back.ok) return
  try {
    await api.call(API.deleteProject, { params: { id: madeId }, query: { ifEmpty: '1' } })
    useProjects.getState().drop(madeId, true)
  } catch {
    // kept (409 project_not_empty) or not reached: the project stays
  }
}

export function MoveToProjectDialog({ chat, onClose, onMoved }: { chat: Chat; onClose: () => void; onMoved: (c: Chat) => void }) {
  const t = useT()
  const locale = useLocale()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [selected, setSelected] = useState<string | null>(chat.projectId)
  const [error, setError] = useState<string | null>(null)
  // "+ 새 프로젝트": the name-only dialog (its name the chat's title), then the chat moves in
  const [making, setMaking] = useState(false)
  const madeAndMove = async (p: Project) => {
    setMaking(false)
    onClose()
    const before = chat.projectId
    const r = await moveChat(chat, p.id, onMoved, t('chat.project.moveFailed'))
    if (!r.ok || !r.newest) return
    toast({
      level: 'success',
      text: t('chat.project.moved', { name: p.name }),
      action: { label: t('chat.project.undo'), run: () => void undoMadeAndMove(r.reply, before, p.id, onMoved) },
    })
  }
  useEffect(() => {
    let live = true
    api.call(API.listProjects).then((r) => { useProjects.getState().put(...r.items); if (live) setProjects(r.items) }, (e) => { if (live) { setProjects([]); setError(errorText(e, locale, t('error.network'))) } })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const save = async () => {
    const to = projects?.find((p) => p.id === selected)
    const text = to ? t('chat.project.moved', { name: to.name }) : t('chat.project.removed')
    // the row moves and the dialog closes at once; a refusal puts the chat back with the server's words in a toast
    onClose()
    const r = await moveChat(chat, selected, onMoved)
    if (r.ok && r.newest) toast({ level: 'success', text })
  }
  if (making) return <NewProjectDialog initialName={chat.title ?? ''} onClose={() => setMaking(false)} onMade={(p) => void madeAndMove(p)} />
  return (
    <Modal
      open
      onClose={onClose}
      title={t('chat.project.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!projects || selected === chat.projectId} onClick={() => void save()} data-testid="chat-project-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">{t('chat.project.hint', { ai: aiName(t) })}</p>
      {/* a new project for this chat, made and filled in one go */}
      <button type="button" onClick={() => setMaking(true)} className="mb-1 flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm font-medium hover:bg-hover max-md:min-h-11" data-testid="chat-project-new">
        <Plus size={16} className="shrink-0 text-muted" aria-hidden /> {t('projects.new')}
      </button>
      {!projects && <Skeleton lines={3} />}
      {projects && <ProjectChoices projects={projects} selected={selected} current={chat.projectId} onSelect={setSelected} />}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </Modal>
  )
}
