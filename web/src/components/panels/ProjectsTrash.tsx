// The Projects list's Trash (docs/decisions/20261121-projects-trash-out-of-list.md; the owner, 2026-11-21: "지운 게
// 저렇게 보여야해?"): a team project in the trash is no row of any group in the list; one quiet "Trash" row with a count
// sits at the bottom instead, as Drive and Notion have it. It shows only to someone who can restore at least one of
// them (Project.canRestore: the owner and admins, its creator while a member) and opens a dialog (a bottom sheet on a
// phone) of the trashed projects the list already gives them (GET /api/projects?manage=1): its name, who moved it there
// and when (the in-the-trash note's words), and Restore where they may. Nothing new is read: every row is one the
// person saw before (as a "in the trash" row, or in Files › Trash). A link to a trashed project still opens its note.
import { ArchiveRestore, Trash2 } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import type { Project } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { readManagedList } from '../../store/projects'
import { trashProject } from '../projectActions'
import { useTrashLines } from '../ProjectTrashNote'
import { Button, Modal } from '../ui'
import { ListIcon } from '../list/List'
import { panelRow } from './PanelFrame'

/** The trashed projects of the manage=1 list the person may see there: a member's (wasMember) or one they may restore
 * (canRestore), its folder still in the trash (`trashed`; one deleted for good from Files › Trash is not restorable) */
export function trashedProjects(list: readonly Project[] | null | undefined): Project[] {
  return (list ?? [])
    .filter((p) => p.inTrash && !!p.trashed && (!!p.wasMember || !!p.canRestore))
    .sort((a, b) => (b.trashed?.at ?? '').localeCompare(a.trashed?.at ?? '') || a.id.localeCompare(b.id))
}

/** The Trash row shows when at least one of them is the person's to restore */
export const showsProjectsTrash = (trashed: readonly Project[]) => trashed.some((p) => !!p.canRestore)

export function ProjectsTrash({ managed }: { managed: readonly Project[] | null }) {
  const t = useT()
  const trashed = useMemo(() => trashedProjects(managed), [managed])
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  return (
    <>
      {showsProjectsTrash(trashed) && (
        <div className="mt-3 border-t border-line pt-2">
          <button
            ref={button}
            type="button"
            onClick={() => setOpen(true)}
            className={clsx(panelRow, 'text-muted')}
            aria-label={t('projectsPanel.trashLabel', { n: trashed.length })}
            data-testid="projects-trash-row"
          >
            <ListIcon><Trash2 /></ListIcon>
            <span className="min-w-0 flex-1 truncate">{t('projectsPanel.trash')}</span>
            <span className="shrink-0 text-meta text-faint tabular-nums" data-testid="projects-trash-count">{trashed.length}</span>
          </button>
        </div>
      )}
      {/* stays open while its last project is restored (it says the trash is empty then) */}
      <Modal open={open} onClose={() => setOpen(false)} title={t('projectsPanel.trashTitle')} returnTo={button.current}>
        <div data-testid="projects-trash-dialog">
          {trashed.length ? (
            <ul className="divide-y divide-line">
              {trashed.map((p) => <TrashedProject key={p.id} project={p} onOpen={() => setOpen(false)} />)}
            </ul>
          ) : (
            <p className="py-2 text-sm text-faint" data-testid="projects-trash-empty">{t('projectsPanel.trashEmpty')}</p>
          )}
        </div>
      </Modal>
    </>
  )
}

/** One trashed project: its name (its page, the in-the-trash note), who moved it there and when, and Restore for whoever
 * may (the project's page's own restore: lib/optimistic.ts, so it leaves this list and is back in its group at once) */
function TrashedProject({ project: p, onOpen }: { project: Project; onOpen: () => void }) {
  const t = useT()
  const { moved } = useTrashLines(p)
  const [busy, setBusy] = useState(false)
  const restore = async () => {
    if (busy) return
    setBusy(true)
    const r = await trashProject(p, false, true)
    setBusy(false)
    // refused (its folder deleted for good from Files › Trash meanwhile, say): the server's words are shown; the list
    // as the server has it now
    if (!r.ok) void readManagedList({ fresh: true }).catch(() => {})
  }
  return (
    <li className="flex items-center gap-3 py-3 first:pt-0 last:pb-0" data-testid="projects-trash-item">
      <div className="min-w-0 flex-1">
        <Link to={`/projects/${p.id}`} onClick={onOpen} className="block truncate text-sm font-medium text-ink hover:underline" title={p.name} data-testid="projects-trash-name">
          {p.name}
        </Link>
        {moved && <p className="mt-0.5 text-meta text-muted break-keep" data-testid="projects-trash-moved">{moved}</p>}
      </div>
      {p.canRestore && (
        <Button size="sm" busy={busy} onClick={() => void restore()} data-testid="projects-trash-restore">
          <ArchiveRestore size={14} aria-hidden /> {t('common.restore')}
        </Button>
      )}
    </li>
  )
}
