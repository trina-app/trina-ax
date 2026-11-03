// A chat's project in the chat header: the project's own name, linked to its page (on phones too), and a dialog that
// moves the chat into a project or out of it (PATCH /api/chats/:id {projectId}; the server checks that the person can
// read the project's folder).
import { FolderKanban } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Chat, Project } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { toast } from '../../store/ui'
import { Button, Modal, Skeleton } from '../ui'

/** The project's name, linked to its page. It gives way to the chat title on a narrow screen, never disappears. */
export function ChatProjectLink({ project }: { project: Pick<Project, 'id' | 'name'> }) {
  const t = useT()
  return (
    <Link
      to={`/projects/${project.id}`}
      title={t('chat.project.open', { name: project.name })}
      className="inline-flex max-w-[45%] min-w-0 shrink items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-hover hover:text-ink"
      data-testid="chat-project"
    >
      <FolderKanban size={13} className="shrink-0" aria-hidden />
      <span className="truncate">{project.name}</span>
    </Link>
  )
}

/** The choices of the move dialog: no project, then each project the person can see (name and folder). */
export function ProjectChoices({ projects, selected, onSelect }: { projects: readonly Project[]; selected: string | null; onSelect: (id: string | null) => void }) {
  const t = useT()
  const row = 'flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm hover:bg-hover'
  return (
    <div role="radiogroup" aria-label={t('chat.project.title')} className="space-y-0.5" data-testid="chat-project-choices">
      <label className={row}>
        <input type="radio" name="chat-project" checked={selected === null} onChange={() => onSelect(null)} />
        <span className="text-muted">{t('chat.project.none')}</span>
      </label>
      {projects.map((p) => (
        <label key={p.id} className={row}>
          <input type="radio" name="chat-project" checked={selected === p.id} onChange={() => onSelect(p.id)} />
          <FolderKanban size={14} className="shrink-0 text-accent-text" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{p.name}</span>
            <span className="block truncate text-xs text-faint">{p.folderPath || t('files.root')}</span>
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
    api.call(API.listProjects).then((r) => live && setProjects(r.items), (e) => { if (live) { setProjects([]); setError(errorText(e, locale, t('error.network'))) } })
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
      {projects && <ProjectChoices projects={projects} selected={selected} onSelect={setSelected} />}
      {projects && !projects.length && !error && <p className="mt-2 text-sm text-faint">{t('chat.project.empty')}</p>}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </Modal>
  )
}
