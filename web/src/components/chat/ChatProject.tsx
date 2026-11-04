// A chat's project in the chat header: the project's own name, linked to its page, before the chat's title (like
// Claude; from the "sm" width up, as the header has room), and the dialog that the title menu's "Move to project…" opens:
// it moves the chat into a project or out of it (PATCH /api/chats/:id {projectId}; the server checks that the person
// can see the project). The name comes from store/projects.ts, so a rename saved anywhere in this window shows at once;
// it is asked again when the window comes back to the front (a rename on another device). A project the person cannot
// see (404: no read access any more, or its folder in the trash) shows nothing.
import { FolderKanban } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Chat, Project } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { useProjects } from '../../store/projects'
import { toast } from '../../store/ui'
import { Button, Modal, Skeleton } from '../ui'

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
 * outside a project or in one the person cannot see. Hidden below "sm": a phone's header keeps the title. A project whose
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
        className="hidden max-w-[40%] shrink-0 truncate rounded-md px-1.5 py-1 text-muted hover:text-ink sm:block"
        data-testid="chat-project"
      >
        {project.name}
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
            <span className="block truncate text-xs text-faint">{p.inTrash ? t('chat.project.inTrash') : p.folderPath || t('files.root')}</span>
          </span>
        </label>
      ))}
    </div>
  )
}

export function MoveToProjectDialog({ chat, onClose, onMoved }: { chat: Chat; onClose: () => void; onMoved: (c: Chat) => void }) {
  const t = useT()
  const locale = useLocale()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [selected, setSelected] = useState<string | null>(chat.projectId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api.call(API.listProjects).then((r) => { useProjects.getState().put(...r.items); if (live) setProjects(r.items) }, (e) => { if (live) { setProjects([]); setError(errorText(e, locale, t('error.network'))) } })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const c = await api.call(API.updateChat, { params: { id: chat.id }, body: { projectId: selected } })
      const to = projects?.find((p) => p.id === selected)
      toast({ level: 'success', text: to ? t('chat.project.moved', { name: to.name }) : t('chat.project.removed') })
      onMoved(c)
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
      title={t('chat.project.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} disabled={!projects || selected === chat.projectId} onClick={save} data-testid="chat-project-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">{t('chat.project.hint')}</p>
      {!projects && <Skeleton lines={3} />}
      {projects && <ProjectChoices projects={projects} selected={selected} current={chat.projectId} onSelect={setSelected} />}
      {projects && !projects.length && !chat.projectId && !error && <p className="mt-2 text-sm text-faint">{t('chat.project.empty')}</p>}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </Modal>
  )
}
