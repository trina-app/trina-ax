// A chat's project in the chat header: the project's own name, linked to its page, before the chat's title (like
// Claude; on a phone a short chip with a folder icon, so the person still sees that the chat is in a project), and the dialog that the title menu's "Move to project…" opens:
// it moves the chat into a project or out of it (PATCH /api/chats/:id {projectId}; the server checks that the person
// can see the project). When the chosen project shares its new chats, one switch, off by default, "프로젝트 멤버와
// 공유": with it on, the chat is shared right after the move (components/chat/ShareChat.tsx: the server's check, and a
// confirm when one comes back; cancelling it leaves the chat moved and private). The name comes from
// store/projects.ts, so a rename saved anywhere in this window shows at once;
// it is asked again when the window comes back to the front (a rename on another device). A project the person cannot
// see (404: no read access any more, or its folder in the trash) shows nothing.
import { FolderKanban } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Chat, Project } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { useProjects } from '../../store/projects'
import { useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { Button, Modal, Skeleton, Switch } from '../ui'
import { mayShareChat, ShareChatFlow } from './ShareChat'

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
  const hintId = useId()
  const safeOps = !!useMe()?.server.allChatsConfidential
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [selected, setSelected] = useState<string | null>(chat.projectId)
  const [share, setShare] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // moved, and to be shared now: the share's own steps take the dialog's place
  const [sharing, setSharing] = useState<string | null>(null)
  const movedText = useRef('')
  const shared = useRef(false)
  useEffect(() => {
    let live = true
    api.call(API.listProjects).then((r) => { useProjects.getState().put(...r.items); if (live) setProjects(r.items) }, (e) => { if (live) { setProjects([]); setError(errorText(e, locale, t('error.network'))) } })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const target = projects?.find((p) => p.id === selected)
  // the switch: only for a chat of mine (every chat that can move is) going into a project whose new chats are shared
  const canShare = !!target && selected !== chat.projectId && mayShareChat(chat, target, safeOps)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const c = await api.call(API.updateChat, { params: { id: chat.id }, body: { projectId: selected } })
      const to = projects?.find((p) => p.id === selected)
      movedText.current = to ? t('chat.project.moved', { name: to.name }) : t('chat.project.removed')
      onMoved(c)
      // to be shared: the share's own toast says it all; its confirm is not covered by this one (a phone's sheet), and
      // the move is told when the chat ends up not shared
      if (canShare && share) setSharing(c.id)
      else {
        toast({ level: 'success', text: movedText.current })
        onClose()
      }
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(false)
    }
  }
  if (sharing)
    return (
      <ShareChatFlow
        chatId={sharing}
        onShared={(c) => { shared.current = true; onMoved(c) }}
        onClose={() => {
          if (!shared.current) toast({ level: 'success', text: movedText.current })
          onClose()
        }}
      />
    )
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
      {canShare && (
        <div className="mt-4 border-t border-line pt-4" data-testid="chat-project-share">
          <Switch checked={share} onChange={setShare} label={t('chat.shareChat.switch')} testId="chat-project-share-toggle" describedBy={hintId} />
          {/* what it does (the switch's own width + gap: under its words) */}
          <p id={hintId} className="mt-1 pl-11 text-xs leading-5 break-keep text-faint" data-testid="chat-project-share-hint">
            {t('chat.shareChat.note')}
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </Modal>
  )
}
