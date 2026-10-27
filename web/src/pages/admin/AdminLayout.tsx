// Admin screens (admin and owner). Admins never see other people's chats or memories (tab 1); the system screen
// (diagnostics, update, backup / restore, export, connection) is the owner's; admins see the storage use there, and in
// office mode the automatic update card (docs/OFFICE.md "자동 업데이트").
import clsx from 'clsx'
import { Activity, Cpu, FolderLock, Gauge, KeyRound, ScrollText, Settings2, Users, UsersRound } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { Navigate, NavLink, useParams } from 'react-router-dom'
import { useT, type MessageKey } from '../../i18n'
import { isAdmin, isOwner, useMeStrict } from '../../store/session'
import { PageHeader, Spinner } from '../../components/ui'

const Members = lazy(() => import('./Members'))
const Groups = lazy(() => import('./Groups'))
const Folders = lazy(() => import('./Folders'))
const Engines = lazy(() => import('./Engines'))
const Credentials = lazy(() => import('./Credentials'))
const TeamSettingsPage = lazy(() => import('./TeamSettings'))
const Usage = lazy(() => import('./Usage'))
const Audit = lazy(() => import('./Audit'))
const System = lazy(() => import('./System'))

const SECTIONS: { id: string; label: MessageKey; icon: typeof Users; ownerOnly?: boolean }[] = [
  { id: 'members', label: 'admin.members', icon: Users },
  { id: 'groups', label: 'admin.groups', icon: UsersRound },
  { id: 'folders', label: 'admin.folders', icon: FolderLock },
  { id: 'engines', label: 'admin.engines', icon: Cpu },
  { id: 'credentials', label: 'admin.credentials', icon: KeyRound },
  { id: 'usage', label: 'admin.usage', icon: Gauge },
  { id: 'audit', label: 'admin.audit', icon: ScrollText },
  { id: 'settings', label: 'admin.settings', icon: Settings2 },
  // owner: everything; admins: the storage use (and, in office mode, the automatic update card)
  { id: 'system', label: 'admin.system', icon: Activity },
]

export default function AdminLayout() {
  const t = useT()
  const me = useMeStrict()
  const { section } = useParams()
  if (!isAdmin(me)) return <Navigate to="/" replace />
  if (!section) return <Navigate to="/admin/members" replace />
  const visible = SECTIONS.filter((s) => !s.ownerOnly || isOwner(me))
  if (!visible.some((s) => s.id === section)) return <Navigate to="/admin/members" replace />
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader title={t('admin.title')} desc={t('admin.desc')} />
      <div className="flex flex-col gap-4 p-4 sm:p-6 lg:flex-row">
        {/* narrow screens: the tab strip runs to the screen edges, so a tab cut off at the right reads as "scroll for more" */}
        <nav aria-label={t('admin.title')} className="scroll-thin -mx-4 flex shrink-0 gap-1 overflow-x-auto px-4 sm:-mx-6 sm:px-6 lg:mx-0 lg:w-48 lg:flex-col lg:px-0">
          {visible.map((s) => (
            <NavLink key={s.id} to={`/admin/${s.id}`} className={({ isActive }) => clsx('flex items-center gap-2 rounded-lg px-3 py-2 text-sm whitespace-nowrap hover:bg-hover', isActive && 'bg-hover font-medium')}>
              <s.icon size={15} aria-hidden /> {t(s.label)}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          <Suspense fallback={<Spinner />}>
            {section === 'members' && <Members />}
            {section === 'groups' && <Groups />}
            {section === 'folders' && <Folders />}
            {section === 'engines' && <Engines />}
            {section === 'credentials' && <Credentials />}
            {section === 'usage' && <Usage />}
            {section === 'audit' && <Audit />}
            {section === 'settings' && <TeamSettingsPage />}
            {section === 'system' && <System />}
          </Suspense>
        </div>
      </div>
    </div>
  )
}
