// Admin screens (admin and owner). Admins never see other people's chats or memories (tab 1); the system screen
// (diagnostics, update, backup / restore, export, connection) is the owner's; admins see the storage use there, and in
// office mode the automatic update card (docs/OFFICE.md "자동 업데이트").
//
// From 768 px (tablets and computers): the menu in its own column beside the page, staying where it is while the page
// scrolls. From 1024 px it has the names beside the icons; between 768 and 1023 px (a tablet, beside the app's own
// sidebar) it is a narrow rail with each name small under its icon (no tips: a finger has no hover), so the page keeps
// room (a column of the full width there left it 280 to 330 px). Groups: People · Connections (Providers: the AI engines and the accounts they use, Engines.tsx; MCP, App
// connectors, AI apps, plugins) · Activity · Team (team settings, with the team's AI settings, and the server). Home
// (/admin) comes first: what needs attention, then one line per area (Home.tsx). Every page here is for the whole team:
// the menu's title is the team's ("<team> admin", with its logo) and one line above every page says so ("Applies to
// everyone in <team>", common.tsx AdminScope), so page titles keep the same nouns as Settings'. Old addresses: /admin/engines and /admin/credentials (AI engines, AI connections) open
// Providers; their "Team provider settings" tab (?tab=team, focus=limits) opens Team settings at #ai or #ai-limits.
//
// Below 768 px (phones): /admin is a list (PhoneRoot.tsx) and each page opens over it with a push, under its own bar
// (‹ and the page's name; the phone top bar steps aside for /admin). The list is always under a page, also one opened
// from a link, and Back returns to it at the same place (lib/backStack.ts; docs/DECISIONS.md "Admin and Settings on
// phones: a list you tap into"). Team settings is one more list there: its groups, each a page at
// /admin/settings/<group> under "‹ Team settings" (teamSettingsGroups.ts); computers keep it one page.
import { Activity, Bot, Cable, Cpu, FolderLock, Gauge, House, MessagesSquare, Puzzle, ScrollText, Settings2, Users, UsersRound } from 'lucide-react'
import { lazy, Suspense, useRef, useState } from 'react'
import { Navigate, NavLink, useLocation, useParams } from 'react-router-dom'
import clsx from 'clsx'
import { teamIconUrl } from '@mycel/shared'
import { useT, type MessageKey } from '../../i18n'
import { useGoBack } from '../../lib/back'
import { BELOW, entryBelow, useBackLabel, useKeptScroll, useListUnderPage } from '../../lib/backStack'
import { isAdmin, isOwner, useMeStrict } from '../../store/session'
import { Spinner, useMediaQuery } from '../../components/ui'
import { PhonePageBar } from '../../components/phone/PhonePageBar'
import { settingsPageName } from '../settingsTabs'
import { AdminScope } from './common'
import { teamSettingsGroup, teamSettingsRedirect } from './teamSettingsGroups'
import { ADMIN_DETAILS, adminChain, adminDesktopOf, adminParent, isAdminDetail } from './adminScreens'
import { AdminBarProvider, type AdminBar } from './phoneBar'

const Home = lazy(() => import('./Home'))
const PhoneRoot = lazy(() => import('./PhoneRoot'))
const Members = lazy(() => import('./Members'))
const Groups = lazy(() => import('./Groups'))
const Folders = lazy(() => import('./Folders'))
const Engines = lazy(() => import('./Engines'))
const Integrations = lazy(() => import('./Integrations'))
const AiApps = lazy(() => import('./AiApps'))
const Plugins = lazy(() => import('./Plugins'))
const Slack = lazy(() => import('./Slack'))
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
    label: 'admin.group.connections',
    items: [
      { id: 'providers', label: 'admin.providers', icon: Cpu },
      { id: 'connectors', label: 'admin.integrations', icon: Cable },
      { id: 'ai-apps', label: 'aiApps.title', icon: Bot },
      { id: 'plugins', label: 'admin.plugins', icon: Puzzle },
      // the owner's: the Slack connector acts as each linked person (docs/SLACK.md)
      { id: 'slack', label: 'slack.admin.title', icon: MessagesSquare, ownerOnly: true },
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
    label: 'admin.group.team',
    items: [
      { id: 'settings', label: 'admin.settings', icon: Settings2 },
      // owner: everything; admins: the storage use (and, in office mode, the automatic update card)
      { id: 'system', label: 'admin.system', icon: Activity },
    ],
  },
]

/** The name of an address for the phone's ‹ label: Admin's list and pages (a group of Team settings by its own name),
 * and Settings' (lib/backStack.ts). */
function pageName(to: string, t: (key: MessageKey) => string, devEnv: boolean | undefined): string | null {
  const path = to.split(/[?#]/)[0]!
  if (path === '/admin') return t('admin.title')
  if (path.startsWith('/admin/')) {
    const [id, sub] = path.slice('/admin/'.length).split('/')
    const group = id === 'settings' ? teamSettingsGroup(sub, devEnv) : undefined
    if (group) return t(group.label)
    const s = MENU.flatMap((g) => g.items).find((x) => x.id === id)
    return s ? t(s.label) : null
  }
  return settingsPageName(path, t)
}

/** The old addresses that open another page (see the top of this file), else null. An item's page that is a phone's
 * only (adminScreens.ts ADMIN_DETAILS) is the item in its page on a computer, and the other way round. */
function redirectOf(section: string, sub: string | undefined, search: string, phone: boolean): string | null {
  const q = new URLSearchParams(search)
  if (sub && !phone) {
    const desktop = adminDesktopOf(section, sub)
    if (desktop) return desktop
  }
  // a connector's and a plugin's page have their own address (/admin/connectors/<id>, /admin/plugins/<id>); the
  // queries that opened them in place lead there (a notice's ?drive=1, ?app=gmail; a link's ?focus=<plugin>)
  if (section === 'connectors' && !sub) {
    const app = q.get('app')
    if (app && /^[a-z0-9-]+$/.test(app)) return `/admin/connectors/${app}`
    if (q.get('drive') === '1') return '/admin/connectors/google-drive'
  }
  if (section === 'plugins' && !sub && q.get('focus')) return `/admin/plugins/${encodeURIComponent(q.get('focus')!)}`
  // a phone: an engine is a page of its own (?engine= opened its row in place)
  if (phone && section === 'providers' && !sub && q.get('engine') && q.get('tab') !== 'team') return `/admin/providers/${encodeURIComponent(q.get('engine')!)}`
  // the team's AI settings moved from the Providers page's second tab into Team settings: its old address opens them
  if ((section === 'engines' || section === 'providers') && q.get('tab') === 'team') return q.get('focus') === 'limits' ? '/admin/settings#ai-limits' : '/admin/settings#ai'
  // AI engines and AI connections are one page now: their old addresses open it (AI connections: at Claude Code's accounts)
  if (section === 'engines') return `/admin/providers${search}`
  if (section === 'credentials') return '/admin/providers?engine=claude-code'
  // MCP and App connectors are one page now, Connectors (App connectors' old address opens it at Google Drive)
  if (section === 'integrations') return `/admin/connectors${search}`
  if (section === 'app-connectors') return '/admin/connectors?drive=1'
  return null
}

export default function AdminLayout() {
  const t = useT()
  const me = useMeStrict()
  const { section = '', sub } = useParams()
  const location = useLocation()
  const { search, hash } = location
  // phones: the list and its pages (below 768 px, the width of the phone top bar and tabs)
  const phone = useMediaQuery('(max-width: 767.98px)')
  // tablets: the menu as a rail of icons (names in tips); computers: with the names
  const wide = useMediaQuery('(min-width: 1024px)')
  const content = useRef<HTMLDivElement>(null)
  // the width this entry first showed at: a redirect after a resize (Team settings' one page ↔ its groups) says what is
  // under it, so the new entry gets no list put under it (a resize never builds a back stack, lib/backStack.ts)
  const firstWidth = useRef<{ key: string; phone: boolean } | null>(null)
  if (firstWidth.current?.key !== location.key) firstWidth.current = { key: location.key, phone }
  const resized = firstWidth.current.phone !== phone
  const admin = isAdmin(me)
  const devEnv = me.server.devEnv
  // Team settings: a group's page on a phone, the one page on a computer (teamSettingsGroups.ts); no other page has
  // pages under it
  const redirect = !admin ? null
    : redirectOf(section, sub, search, phone) ?? (section === 'settings' ? teamSettingsRedirect({ sub, hash, phone, devEnv }) : sub && !ADMIN_DETAILS[section] ? `/admin/${section}${search}${hash}` : null)
  const group = section === 'settings' ? teamSettingsGroup(sub, devEnv) : undefined
  const menu = MENU.map((g) => ({ ...g, items: g.items.filter((s) => !s.ownerOnly || isOwner(me)) })).filter((g) => g.items.length)
  const known = menu.some((g) => g.items.some((s) => s.id === section))
  // the page that stays (no redirect, allowed): only then may the list be put under it
  const final = admin && !redirect && known && section !== ''
  // the lists under a page (adminScreens.ts): Back goes group → Team settings → Admin, a connector → Connectors → Admin,
  // the rule editor → the folder → the tree → Admin
  const here = `${location.pathname}${search}`
  useListUnderPage(adminChain(here), phone, final)
  useKeptScroll(content, 'admin', phone && admin && !redirect && known)
  const up = adminParent(here) ?? '/admin'
  const name = (p: string) => pageName(p, t, devEnv)
  // a folder, a person in By person, the rule editor: the same address with another query is still the page above it
  const label = useBackLabel(up, name) ?? (isAdminDetail(here) && entryBelow(location.key) === location.pathname ? name(up) : null)
  const goBack = useGoBack(up)
  // what the page on show tells the bar: an item's name as the title, a check before ‹ leaves (phoneBar.ts)
  const [bar, setBar] = useState<AdminBar | null>(null)
  const back = () => {
    if (!bar?.beforeBack) return goBack()
    void bar.beforeBack().then((ok) => ok && goBack())
  }
  if (!admin) return <Navigate to="/" replace />
  if (redirect) return <Navigate to={redirect} replace state={resized ? { [BELOW]: entryBelow(location.key) ?? null } : undefined} />
  if (!known) return <Navigate to="/admin" replace />
  const current = menu.flatMap((g) => g.items).find((s) => s.id === section)!

  const page = (
    <AdminBarProvider value={setBar}>
    <Suspense fallback={<Spinner />}>
      {section === '' && <Home />}
      {section === 'members' && <Members />}
      {section === 'groups' && <Groups />}
      {section === 'folders' && <Folders />}
      {section === 'providers' && <Engines />}
      {section === 'connectors' && <Integrations />}
      {section === 'ai-apps' && <AiApps />}
      {section === 'plugins' && <Plugins />}
      {section === 'slack' && <Slack />}
      {section === 'usage' && <Usage />}
      {section === 'audit' && <Audit />}
      {section === 'settings' && <TeamSettingsPage />}
      {section === 'system' && <System />}
    </Suspense>
    </AdminBarProvider>
  )

  if (phone)
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="admin-phone">
        {/* the list's bar: ‹ back to where it came from (the 나 list: "‹ Settings"); its big title is in the list */}
        <PhonePageBar onBack={back} backLabel={label} title={bar?.title ?? (group ? t(group.label) : isAdminDetail(here) && section !== 'folders' ? '' : section ? t(current.label) : '')} titleHidden={!!section} backTestId="admin-back" titleTestId="admin-bar-title" />
        <div ref={content} className="min-h-0 flex-1 overflow-y-auto" data-testid="admin-content">
          {section === '' ? (
            <Suspense fallback={<Spinner />}>
              <PhoneRoot groups={menu.filter((g): g is typeof g & { label: MessageKey } => g.label !== null)} />
            </Suspense>
          ) : (
            <div className="mx-auto w-full max-w-6xl p-4">
              {/* every page here applies to the whole team (Settings says "Just for you" the same way) */}
              <AdminScope />
              {page}
            </div>
          )}
        </div>
      </div>
    )

  return (
    <div className="flex h-full min-h-0 flex-row">
      <div className={clsx('flex shrink-0 flex-col border-r border-line', wide ? 'w-60' : 'w-[5.5rem]')} data-testid="admin-sidebar" data-rail={wide ? undefined : ''}>
        {/* whose admin this is: the team's logo and "<team> admin", as the main sidebar shows the team (its logo, else the
            product's mark); the rail shows the logo and keeps the words for screen readers */}
        <h1 className={clsx('flex items-center gap-2 pt-6 pb-4 text-lg font-semibold tracking-tight', wide ? 'px-5' : 'justify-center px-2')} data-testid="admin-title">
          <img src={me.team.iconVersion ? teamIconUrl(me.team.iconVersion) : '/favicon.svg'} alt="" aria-hidden className="size-6 shrink-0 rounded-md object-cover" data-testid="admin-team-logo" />
          <span className={wide ? 'min-w-0 truncate' : 'sr-only'}>{t('admin.teamTitle', { team: me.team.name })}</span>
        </h1>
        <nav aria-label={t('admin.title')} className={clsx('scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto pb-6', wide ? 'gap-5 px-3' : 'items-center gap-3 px-2')} data-testid="admin-menu">
          {menu.map((g) => {
            const links = g.items.map((s) => (
              <NavLink
                key={s.id}
                to={s.id ? `/admin/${s.id}` : '/admin'}
                end
                className={({ isActive }) =>
                  clsx('flex rounded-lg hover:bg-hover hover:text-ink focus-visible:-outline-offset-2', wide ? 'items-center gap-2.5 px-3 py-1.5 text-sm' : 'w-full flex-col items-center gap-1 px-1 py-2 text-center text-micro leading-tight', isActive ? 'bg-hover font-medium text-ink' : 'text-muted')
                }
              >
                <s.icon size={wide ? 15 : 18} className="shrink-0" aria-hidden /> <span className={wide ? undefined : 'line-clamp-2 break-words'}>{t(s.label)}</span>
              </NavLink>
            ))
            if (!g.label) return <div key="home" className="flex flex-col">{links}</div>
            return (
              <div key={g.label} role="group" aria-labelledby={`admin-menu-${g.label}`} className={clsx('flex flex-col gap-0.5', !wide && 'items-center border-t border-line pt-3')}>
                <p id={`admin-menu-${g.label}`} className={wide ? 'px-3 pb-1 text-xs text-faint' : 'sr-only'}>
                  {t(g.label)}
                </p>
                {links}
              </div>
            )
          })}
        </nav>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-testid="admin-content">
        <div className="mx-auto w-full max-w-6xl p-4 sm:p-6 lg:px-8 lg:py-7">
          {/* every page here applies to the whole team (Settings says "Just for you" the same way) */}
          <AdminScope />
          {page}
        </div>
      </div>
    </div>
  )
}
