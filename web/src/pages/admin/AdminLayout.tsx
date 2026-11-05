// Admin screens (admin and owner). Admins never see other people's chats or memories (tab 1); the system screen
// (diagnostics, update, backup / restore, export, connection) is the owner's; admins see the storage use there, and in
// office mode the automatic update card (docs/OFFICE.md "자동 업데이트").
//
// The menu stays where it is while a page scrolls: its own column on wide screens, a strip under the title on narrow
// ones. It is grouped so what the whole team shares (AI engines, AI connections, external services, plugins) sits
// apart from people, activity and the server (App connectors: what this server offers members, AppConnectors.tsx). Home (/admin) comes first: what needs attention, then one line per area
// (Home.tsx).
import clsx from 'clsx'
import { Activity, Bot, Cable, Cpu, FolderLock, Gauge, House, KeyRound, Plug, Puzzle, ScrollText, Settings2, Users, UsersRound } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef } from 'react'
import { Navigate, NavLink, useParams } from 'react-router-dom'
import { useT, type MessageKey } from '../../i18n'
import { isAdmin, isOwner, useMeStrict } from '../../store/session'
import { Spinner, useEdgeFade } from '../../components/ui'

const Home = lazy(() => import('./Home'))
const Members = lazy(() => import('./Members'))
const Groups = lazy(() => import('./Groups'))
const Folders = lazy(() => import('./Folders'))
const Engines = lazy(() => import('./Engines'))
const Credentials = lazy(() => import('./Credentials'))
const Integrations = lazy(() => import('./Integrations'))
const AppConnectors = lazy(() => import('./AppConnectors'))
const AiApps = lazy(() => import('./AiApps'))
const Plugins = lazy(() => import('./Plugins'))
const TeamSettingsPage = lazy(() => import('./TeamSettings'))
const Usage = lazy(() => import('./Usage'))
const Audit = lazy(() => import('./Audit'))
const System = lazy(() => import('./System'))

type Section = { id: string; label: MessageKey; icon: typeof Users; ownerOnly?: boolean }

/** The menu, in groups; Home's id is '' (/admin). */
const MENU: { label: MessageKey | null; items: Section[] }[] = [
  { label: null, items: [{ id: '', label: 'admin.home', icon: House }] },
  {
    label: 'admin.group.people',
    items: [
      { id: 'members', label: 'admin.members', icon: Users },
      { id: 'groups', label: 'admin.groups', icon: UsersRound },
      { id: 'folders', label: 'admin.folders', icon: FolderLock },
    ],
  },
  {
    label: 'admin.group.shared',
    items: [
      { id: 'engines', label: 'admin.engines', icon: Cpu },
      { id: 'credentials', label: 'admin.credentials', icon: KeyRound },
      { id: 'integrations', label: 'admin.integrations', icon: Cable },
      { id: 'app-connectors', label: 'connectors.title', icon: Plug },
      { id: 'ai-apps', label: 'aiApps.title', icon: Bot },
      { id: 'plugins', label: 'admin.plugins', icon: Puzzle },
    ],
  },
  {
    label: 'admin.group.activity',
    items: [
      { id: 'usage', label: 'admin.usage', icon: Gauge },
      { id: 'audit', label: 'admin.audit', icon: ScrollText },
    ],
  },
  {
    label: 'admin.group.settings',
    items: [
      { id: 'settings', label: 'admin.settings', icon: Settings2 },
      // owner: everything; admins: the storage use (and, in office mode, the automatic update card)
      { id: 'system', label: 'admin.system', icon: Activity },
    ],
  },
]

export default function AdminLayout() {
  const t = useT()
  const me = useMeStrict()
  const { section = '' } = useParams()
  const nav = useRef<HTMLElement>(null)
  useEdgeFade(nav)
  // the strip of a narrow screen scrolls sideways: bring the open page's link into it
  useEffect(() => {
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [section])
  if (!isAdmin(me)) return <Navigate to="/" replace />
  const menu = MENU.map((g) => ({ ...g, items: g.items.filter((s) => !s.ownerOnly || isOwner(me)) })).filter((g) => g.items.length)
  if (!menu.some((g) => g.items.some((s) => s.id === section))) return <Navigate to="/admin" replace />
  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <div className="shrink-0 border-b border-line lg:flex lg:w-60 lg:flex-col lg:border-r lg:border-b-0">
        <h1 className="px-4 pt-4 pb-2 text-lg font-semibold tracking-tight sm:px-6 lg:px-5 lg:pt-6 lg:pb-4 lg:text-xl">{t('admin.title')}</h1>
        {/* narrow screens: the strip runs to the screen edges, so a link cut off at the right reads as "scroll for more";
            relative: the group names hidden there (sr-only) stay inside the strip instead of widening the page */}
        <nav ref={nav} aria-label={t('admin.title')} className="scroll-thin edge-fade relative flex items-center gap-1 overflow-x-auto px-4 pb-3 sm:px-6 lg:min-h-0 lg:flex-1 lg:flex-col lg:items-stretch lg:gap-5 lg:overflow-x-hidden lg:overflow-y-auto lg:px-3 lg:pb-6" data-testid="admin-menu">
          {menu.map((g) => {
            const links = g.items.map((s) => (
              <NavLink
                key={s.id}
                to={s.id ? `/admin/${s.id}` : '/admin'}
                end
                className={({ isActive }) =>
                  clsx('flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm whitespace-nowrap hover:bg-hover lg:whitespace-normal hover:text-ink focus-visible:-outline-offset-2 max-lg:py-2', isActive ? 'bg-hover font-medium text-ink' : 'text-muted')
                }
              >
                <s.icon size={15} className="shrink-0" aria-hidden /> {t(s.label)}
              </NavLink>
            ))
            if (!g.label) return <div key="home" className="flex shrink-0 lg:flex-col">{links}</div>
            return (
              <div key={g.label} role="group" aria-labelledby={`admin-menu-${g.label}`} className="flex shrink-0 items-center gap-1 max-lg:border-l max-lg:border-line max-lg:pl-1 lg:flex-col lg:items-stretch lg:gap-0.5">
                <p id={`admin-menu-${g.label}`} className="sr-only lg:not-sr-only lg:px-3 lg:pb-1 lg:text-xs lg:text-faint">
                  {t(g.label)}
                </p>
                {links}
              </div>
            )
          })}
        </nav>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="admin-content">
        <div className="mx-auto w-full max-w-6xl p-4 sm:p-6 lg:px-8 lg:py-7">
          <Suspense fallback={<Spinner />}>
            {section === '' && <Home />}
            {section === 'members' && <Members />}
            {section === 'groups' && <Groups />}
            {section === 'folders' && <Folders />}
            {section === 'engines' && <Engines />}
            {section === 'credentials' && <Credentials />}
            {section === 'integrations' && <Integrations />}
            {section === 'app-connectors' && <AppConnectors />}
            {section === 'ai-apps' && <AiApps />}
            {section === 'plugins' && <Plugins />}
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
