// "Who can see it" on the Files page (docs/DECISIONS.md "Who can see a folder, in place"): a chip at the end of the
// breadcrumbs for the folder on screen, and a panel (the chip, or a folder row's ⋯ menu). What a member learns is the
// server's answer (GET /api/files/audience: a count only where they can write) or a team project's own count
// (Project.audience); their own folder says "only you" by its path. An admin's panel adds the people by name and where
// their access comes from, from the admin endpoints (FolderAccessAdmin.tsx, loaded only for admins). Nothing here
// decides access.
import { UserRound, Users } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Access, AccessTreeNode, FolderAudience, Project } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { adminsOnly, chipOf, chipPlace, chipText, headlineText, type ChipPlace } from '../lib/folder-access'
import { useFolderWords } from '../lib/folderLabels'
import { useLocale, useT } from '../i18n'
import { accessChanged } from '../store/live'
import { isAdmin, useMeStrict } from '../store/session'
import { ErrorNote, Modal, Skeleton } from './ui'

const FolderAccessAdmin = lazy(() => import('../pages/admin/FolderAccessAdmin'))

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
  const askSelf = admin && place !== null && place !== 'own'
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
  const chip = a.ready ? chipOf(place, { audience: a.audience, project, adminsOnly: a.adminsOnly }) : null
  if (!chip) return null
  const Icon = chip.kind === 'onlyYou' ? UserRound : Users
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={headlineText(t, chip)}
      className="relative ml-2 inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-micro font-medium whitespace-nowrap text-muted hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-md:after:absolute max-md:after:-inset-x-1 max-md:after:-inset-y-2.5 max-md:after:content-['']"
      data-testid="folder-access-chip"
      data-kind={chip.kind}
    >
      <Icon size={11} aria-hidden /> {chipText(t, chip)}
    </button>
  )
}

/** An admin changes the rules here from the panel, in Admin's edit panel: not on a team project's own folder in
 * projects/ (its members are changed on its page, #298) and not on a personal folder (rules never apply there). A
 * project made before outside projects/ keeps it (its page sends admins to Admin too). */
export const changeHere = (path: string, place: ChipPlace | null) => place !== null && place !== 'own' && !(place === 'project' && /^projects\/[^/]+$/.test(path))

/** Whether a folder row's ⋯ menu offers "Who can see it" (where the chip would show for that folder). */
export function offersFolderAccess(path: string, access: Access, me: string, project: Project | null): boolean {
  return chipPlace(path, { me, access, project }) !== null
}

/**
 * The panel: who can see the folder, as far as the caller may know. Asked again each time it opens. Members: the
 * count and who changes it; their own folder: only them; a team project's folder: its count and that its members
 * decide. Admins also get the people by name (FolderAccessAdmin), asked when the panel opens.
 */
export function FolderAccessPanel({ target, project, onClose }: { target: { path: string; access: Access } | null; project: Project | null; onClose: () => void }) {
  const t = useT()
  const me = useMeStrict()
  const admin = isAdmin(me)
  const words = useFolderWords()
  // closed, the path is null: each opening asks again
  const path = target?.path ?? null
  const place = target ? chipPlace(target.path, { me: me.user.id, access: target.access, project }) : null
  const a = useFolderAccess(place ? path : null, place, admin)
  const chip = a.ready ? chipOf(place, { audience: a.audience, project, adminsOnly: a.adminsOnly }) : null
  return (
    <Modal open={!!target && !!place} onClose={onClose} title={t('folderAccess.menu')} width={520}>
      {target && place && (
        <div className="space-y-3" data-testid="folder-access-panel" data-path={target.path}>
          <p className="-mt-2 text-xs [overflow-wrap:anywhere] text-muted">{words.path(target.path) || t('files.root')}</p>
          {/* no headline once the answers are in without a count (a plugin's managed folder: no write passes there) */}
          {a.error && !chip ? (
            <ErrorNote>{a.error}</ErrorNote>
          ) : !chip ? (
            !a.ready && <Skeleton lines={2} />
          ) : (
            <p className="text-base font-semibold text-ink" data-testid="folder-access-headline">
              {headlineText(t, chip)}
            </p>
          )}
          {place === 'own' && <p className="text-sm text-muted">{t('folderAccess.ownFolder')}</p>}
          {place === 'project' && project && (
            <div className="space-y-1.5 text-sm" data-testid="folder-access-project">
              <p className="text-muted break-keep">{t('folderAccess.project', { name: project.name })}</p>
              <Link to={`/projects/${project.id}`} onClick={onClose} className="inline-block text-accent-text underline-offset-2 hover:underline" data-testid="folder-access-open-project">
                {t('files.openProject')}
              </Link>
            </div>
          )}
          {place === 'ask' && !admin && <p className="text-sm text-muted">{t('folderAccess.adminsChange')}</p>}
          {admin && place !== 'own' && (
            <Suspense fallback={<Skeleton lines={4} />}>
              <FolderAccessAdmin path={target.path} self={a.self} ready={a.ready} change={changeHere(target.path, place)} onLeave={onClose} />
            </Suspense>
          )}
        </div>
      )}
    </Modal>
  )
}
