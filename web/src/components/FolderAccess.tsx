// "Who can open it" on the Files page (docs/DECISIONS.md "Who can see a folder, in place" and "Who can open it, like
// Drive's Share"): a chip at the end of the breadcrumbs for the folder on screen, and a panel (the chip, or a folder
// row's ⋯ menu). What a member learns is the server's answer (GET /api/files/audience: a count only where they can
// write) or a team project's own count (Project.audience); their own folder says "only you" by its path. The owner and
// admins' chip says the people by its rules ("3명"; the server's split, never sent to members). An admin's panel is
// Drive's Share dialog in our words (pages/admin/FolderSharing.tsx, loaded only for admins): the people and groups who
// can open it, one general access setting, changed in place. A team project's folder and everything inside it are shown,
// not changed, and asked of no admin endpoint (their people follow the project's members). Nothing here decides access.
import { ChevronLeft, UserRound, Users } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Access, AccessTreeNode, FolderAudience, Project } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { adminsOnly, chipLabel, chipOf, chipPlace, chipText, panelByRole, panelHeadline, type ChipPlace } from '../lib/folder-access'
import { hasPanel, inProjects } from '../lib/folder-sharing'
import { useFolderName, useFolderWords } from '../lib/folderLabels'
import { useLocale, useT } from '../i18n'
import { accessChanged } from '../store/live'
import { isAdmin, useMeStrict } from '../store/session'
import { Button, ErrorNote, Modal, Skeleton } from './ui'

const FolderSharing = lazy(() => import('../pages/admin/FolderSharing'))

/** An admin's tree row of the folder (who sees it, grouped) and how many people rules decide for. */
export interface AdminSelf { self: AccessTreeNode; members: number }

/**
 * The answers a folder's chip and panel need: the server's count where the caller can write (`ask`), and for an admin
 * the tree's row of the folder (for "owner and admins only" and the panel's words; never for their own folder, which
 * the admin endpoints refuse). Asked again when the path changes and when the caller's access changes.
 */
export function useFolderAccess(path: string | null, place: ChipPlace | null, admin: boolean) {
  const t = useT()
  const locale = useLocale()
  const [audience, setAudience] = useState<FolderAudience | null>(null)
  const [self, setSelf] = useState<AdminSelf | null>(null)
  /** the asks that are done (answered or failed): the chip waits for them, so it never shows a number it must take back */
  const [done, setDone] = useState({ audience: false, self: false })
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => accessChanged.on(() => setTick((n) => n + 1)), [])
  const askAudience = place === 'ask'
  // never inside a team project's folder: its people follow the project's members, and no admin endpoint is asked there
  const askSelf = admin && place !== null && place !== 'own' && path !== null && !inProjects(path)
  useEffect(() => {
    setAudience(null)
    setSelf(null)
    setError(null)
    setDone({ audience: !askAudience, self: !askSelf })
    if (path === null) return
    let live = true
    if (askAudience)
      api.call(API.folderAudience, { query: { path } }).then(
        (r) => live && (setAudience(r), setDone((d) => ({ ...d, audience: true }))),
        (e) => live && (setError(errorText(e, locale, t('error.network'))), setDone((d) => ({ ...d, audience: true }))),
      )
    if (askSelf)
      api.call(API.explainAccessTree, { query: { path, limit: 1 } }).then(
        (r) => live && (setSelf({ self: r.self, members: r.members }), setDone((d) => ({ ...d, self: true }))),
        () => live && setDone((d) => ({ ...d, self: true })),
      )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, askAudience, askSelf, tick])
  const ready = done.audience && done.self
  return { audience, self, error, ready, adminsOnly: !!self && adminsOnly(self.self, self.members) }
}

/** The chip for the folder on screen; nothing where a member learns nothing new, while loading, or after a failure. */
export function FolderAccessChip({ path, access, project, onOpen }: { path: string; access: Access; project: Project | null; onOpen: () => void }) {
  const t = useT()
  const me = useMeStrict()
  const place = chipPlace(path, { me: me.user.id, access, project })
  const a = useFolderAccess(path, place, isAdmin(me))
  const chip = a.ready ? chipOf(place, { audience: a.audience, project, adminsOnly: a.adminsOnly, apart: true }) : null
  if (!chip) return null
  const Icon = chip.kind === 'onlyYou' ? UserRound : Users
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={chipLabel(t, chip)}
      className="relative ml-2 inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-micro font-medium whitespace-nowrap text-muted hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-md:after:absolute max-md:after:-inset-x-1 max-md:after:-inset-y-2.5 max-md:after:content-['']"
      data-testid="folder-access-chip"
      data-kind={chip.kind}
    >
      <Icon size={11} aria-hidden /> {chipText(t, chip)}
    </button>
  )
}

/** An admin changes who can open it in the panel: any team folder with a panel, but not a team project's folder in
 * projects/ or anything inside it (by its path, so a project list that failed to load does not offer it), and not a
 * personal folder. A project made before outside projects/ keeps it (its page sends admins to Admin too). */
export const editableHere = (path: string, place: ChipPlace | null) => place !== null && place !== 'own' && hasPanel(path) && !inProjects(path)

/** Whether a folder row's ⋯ menu offers "Who can open it" (where the chip would show for that folder). */
export function offersFolderAccess(path: string, access: Access, me: string, project: Project | null): boolean {
  return chipPlace(path, { me, access, project }) !== null
}

/**
 * The panel: who can open the folder, as far as the caller may know. Asked again each time it opens. Members: the count
 * and who changes it; their own folder: only them; a team project's folder: its count and that its members decide.
 * Admins: FolderSharing (the people and groups, general access, changed in place), or on a team project's folder and
 * inside it the count apart and the way to its members. "Change there" on a row from a folder above shows that folder
 * here, with the way back; leaving with changes asks first (`guard`).
 */
export function FolderAccessPanel({ target, project, projectOf, onClose }: {
  target: { path: string; access: Access } | null
  project: Project | null
  /** a team project by its folder (the folders shown after "Change there") */
  projectOf?: (path: string) => Project | null
  onClose: () => void
}) {
  const t = useT()
  const me = useMeStrict()
  const admin = isAdmin(me)
  const nameOf = useFolderName()
  const navigate = useNavigate()
  /** the folders shown after "Change there", the last on screen (admins only; they write everywhere outside users/) */
  const [trail, setTrail] = useState<string[]>([])
  useEffect(() => setTrail([]), [target?.path])
  const path = target ? (trail[trail.length - 1] ?? target.path) : null
  const access: Access = !target ? 'none' : trail.length ? 'write' : target.access
  const proj = !target ? null : trail.length ? (projectOf?.(path!) ?? null) : project
  const place = path !== null ? chipPlace(path, { me: me.user.id, access, project: proj }) : null
  const sharing = admin && path !== null && editableHere(path, place)
  // the count (members, one's own folder, a team project's folder and inside it): never an admin endpoint
  const a = useFolderAccess(!sharing && place ? path : null, place, false)
  const chip = a.ready ? chipOf(place, { audience: a.audience, project: proj, apart: admin }) : null
  /** set by FolderSharing: true when the panel may go (nothing changed, or the admin dropped it) */
  const guard = useRef<() => Promise<boolean>>(async () => true)
  /** the add field's list: Esc closes it before the panel */
  const list = useRef({ open: false, close: () => {} })
  const close = async () => {
    if (list.current.open) {
      list.current.close()
      return
    }
    if (await guard.current()) onClose()
  }
  /** leave for another page ('' = just close), the leave question already asked */
  const leave = (to: string) => {
    onClose()
    if (to) navigate(to)
  }
  const go = async (to: string) => {
    if (await guard.current()) leave(to)
  }
  const back = async () => {
    if (await guard.current()) setTrail((tr) => tr.slice(0, -1))
  }
  const previous = trail.length > 1 ? trail[trail.length - 2]! : target?.path ?? ''
  const projectFolder = place === 'project' && proj
  return (
    <Modal open={!!target && !!place} onClose={() => void close()} title={t('folderAccess.menu')} width={520}>
      {target && place && path !== null && (
        <div className="space-y-3" data-testid="folder-access-panel" data-path={path}>
          {trail.length > 0 && (
            <button type="button" onClick={() => void back()} className="-mt-1 -ml-1 inline-flex min-h-11 items-center gap-1 rounded-md px-1 text-sm font-medium text-muted hover:text-ink sm:min-h-0" data-testid="folder-access-back">
              <ChevronLeft size={16} aria-hidden /> {t('folderAccess.backTo', { folder: nameOf(previous) })}
            </button>
          )}
          <p className="-mt-2 text-xs [overflow-wrap:anywhere] text-muted" data-testid="folder-access-name">{nameOf(path)}</p>
          {sharing ? (
            <>
              {projectFolder && <ProjectLines project={proj} admin go={go} />}
              <Suspense fallback={<Skeleton lines={4} />}>
                <FolderSharing key={path} path={path} project={proj} projectOf={projectOf ?? (() => null)} onSwap={(to) => setTrail((tr) => [...tr, to])} onLeave={leave} guard={guard} list={list} />
              </Suspense>
            </>
          ) : (
            <>
              {/* no headline once the answers are in without a count (a plugin's managed folder: no write passes there) */}
              {a.error && !chip ? (
                <ErrorNote>{a.error}</ErrorNote>
              ) : !chip ? (
                !a.ready && <Skeleton lines={2} />
              ) : (
                <div>
                  <p className="text-base font-semibold text-ink" data-testid="folder-access-headline">
                    {panelHeadline(t, chip, me.team.name)}
                  </p>
                  {admin && panelByRole(t, chip) && <p className="mt-0.5 text-sm text-muted" data-testid="folder-access-by-role">{panelByRole(t, chip)}</p>}
                </div>
              )}
              {place === 'own' && <p className="text-sm text-muted">{t('folderAccess.ownFolder')}</p>}
              {projectFolder && <ProjectLines project={proj} admin={admin} go={go} />}
              {place === 'ask' && !admin && <p className="text-sm text-muted">{t('folderAccess.adminsChange')}</p>}
              {admin && inProjects(path) && (
                <div className="space-y-1 border-t border-line pt-3 text-xs text-muted">
                  <p data-testid="folder-access-footer">{t('folderAccess.adminsAlways')}</p>
                  {!projectFolder && (
                    <p>
                      <Link to={`/admin/folders?folder=${encodeURIComponent(path)}`} onClick={onClose} className="text-accent-text underline-offset-2 hover:underline" data-testid="folder-access-open-admin">
                        {t('folderAccess.openInAdmin')}
                      </Link>
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  )
}

/** A team project's folder: whose members decide, #298's own pieces ([Members] for whoever may change them, else who
 * does), and the way to the project. */
function ProjectLines({ project, admin, go }: { project: Project; admin: boolean; go: (to: string) => Promise<void> }) {
  const t = useT()
  const words = useFolderWords()
  return (
    <div className="space-y-1.5 text-sm" data-testid="folder-access-project">
      <p className="text-muted break-keep">{t('folderAccess.project', { name: project.name })}</p>
      {/* #298's own pieces: whoever may change the members gets its dialog (?members=1 opens it only for them); anyone
          else reads who does, as on the project page (the creator by name only while they can) */}
      {!project.membersEditable && (
        <p className="text-muted break-keep" data-testid="folder-access-members-hint">
          {admin
            ? /^projects\/[^/]+$/.test(project.folderPath)
              ? t('projects.membersFolderMissing')
              : t('projects.legacyNote', { folder: words.path(project.folderPath) || t('files.root') })
            : project.creatorChangesMembers && project.createdBy
              ? t('projects.membersByCreator', { name: project.createdBy.name })
              : t('projects.membersByAdmins')}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-0.5">
        {project.membersEditable && (
          <Button size="sm" onClick={() => void go(`/projects/${project.id}?members=1`)} data-testid="folder-access-members">
            <Users size={14} aria-hidden /> {t('projects.participants')}
          </Button>
        )}
        <Link
          to={`/projects/${project.id}`}
          onClick={(e) => {
            e.preventDefault()
            void go(`/projects/${project.id}`)
          }}
          className="text-accent-text underline-offset-2 hover:underline"
          data-testid="folder-access-open-project"
        >
          {t('files.openProject')}
        </Link>
      </div>
    </div>
  )
}
