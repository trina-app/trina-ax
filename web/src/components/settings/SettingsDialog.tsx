// Settings as a dialog over the page it was opened from, like Claude's: the sections on the left (a search filters them
// by name and by a few words of what is inside, hairlines separate the groups of pages/settingsTabs.ts) and the open
// section on the right. /settings and
// /settings/<section> still work: App.tsx keeps the page behind it (Home when the address was opened directly) and
// `onClose` goes back to that page. On a computer /settings opens on the profile, with the list beside it. On a phone it
// is the 나 tab (BottomTabs.tsx opens /settings): it fills the screen above the tab bar (the bar is the way out, no ✕)
// and opens on its list (no search box): the person's photo, name and title on top, which open the profile (the list's
// own "프로필" row is left out there), then what needs me: 알림함 with its unread count (the 알림 section, whose own row
// is left out there) and, for admins, 관리자; then the sections, with MCP, app connectors and AI connections behind one
// "더 보기" row at the end of their group (they open in place). A section on a phone has a ← back to the list and its
// own name in the bar (its page keeps that heading for screen readers only, so the name is not said twice on screen;
// "설정" stays the dialog's name). A page under a section (`page`:
// /settings/account/delete, the account deletion request under the profile) keeps its section marked in the list, and
// its way back goes to that section. Admin stays its own page.
import clsx from 'clsx'
import { ArrowLeft, Bell, ChevronDown, LogOut, Search, Shield, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react'
import { Link, Navigate, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom'
import { api, API } from '../../lib/api'
import { browserSettingsBridge } from '../../lib/desktop'
import { useT } from '../../i18n'
import { SETTINGS_GROUPS, sectionMatches, settingsTabs } from '../../pages/settingsTabs'
import { useInboxUnread } from '../../store/inbox'
import { isAdmin, useMeStrict } from '../../store/session'
import { IconButton, Spinner, inputCls, menuOpener, useFocusTrap, useMediaQuery } from '../ui'
import { Avatar } from '../Avatar'
import { BottomTabs } from '../BottomTabs'
import { useLogout } from '../../lib/logout'
import { PhonePushLine } from './PushNotifications'

const SettingsPane = lazy(() => import('../../pages/Settings'))
/** sections few people need on a phone: behind "더 보기" in the phone's list */
const ADVANCED = new Set(['integrations', 'connectors', 'ai-apps', 'providers'])
/** sections whose page starts with its own title row that stays (MCP's title beside its tabs, AI providers' card):
 * the phone's bar keeps "설정" there instead of saying the name twice */
const OWN_TITLE = new Set(['integrations', 'providers'])
/** sections a phone's list shows on top instead of in their group: the profile (the photo row) and 알림 (알림함) */
const PHONE_TOP = new Set(['profile', 'notifications'])
/** a row of the phone's list */
const phoneRow = 'flex h-11 items-center gap-2.5 rounded-lg px-3 text-sm hover:bg-hover focus-visible:-outline-offset-2'

let openedFrom: HTMLElement | null = null
/** What gets the keyboard back when the dialog closes, said by whatever opens it when that is not what has focus by
 * then (the account menu's Settings item is gone once the menu closes): the menu's button. */
export function settingsOpenedFrom(el: HTMLElement | null) {
  openedFrom = el
}

/** pages under a section, by their address (App.tsx routes them here) */
export type SettingsPage = 'account-delete'
const PAGE_SECTION: Record<SettingsPage, string> = { 'account-delete': 'profile' }
/** The hairline between groups of the list: on a phone it starts where the rows' icons do, 16px in from each edge (the
 * list keeps 4px around the rows' own tap area). */
const Rule = ({ className }: { className?: string }) => <hr className={clsx('my-2 border-line max-md:mx-3', className)} />

export default function SettingsDialog({ onClose, page }: { onClose: () => void; page?: SettingsPage }) {
  const t = useT()
  const me = useMeStrict()
  const logout = useLogout()
  const inbox = useInboxUnread()
  // phones (below 768 px, the width of the phone top bar and tabs): the list first, its photo row, no search box
  const phone = useMediaQuery('(max-width: 767.98px)')
  const params = useParams()
  const tab = page ? PAGE_SECTION[page] : params.tab
  const navigate = useNavigate()
  const location = useLocation()
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  // focus goes back to what opened the dialog; a menu's item is gone by then, so the menu's button
  const [returnTo] = useState(() => {
    const el = openedFrom ?? menuOpener()
    openedFrom = null
    return el
  })
  useFocusTrap(ref, true, onClose, returnTo)
  // the page under the dialog is inert until it has closed, so the keyboard goes back once it is reachable again
  useEffect(() => () => void requestAnimationFrame(() => returnTo?.isConnected && returnTo.focus()), [returnTo])
  const [own, setOwn] = useState<boolean | null>(null)
  useEffect(() => {
    api.call(API.myCredentials).then((r) => setOwn(r.allowed || r.items.length > 0), () => setOwn(false))
  }, [])
  // the dev environment's sites: only while the dev environment on srt is on for this person (a 404: not on this server)
  const devEnv = me.server.devEnv
  const [sites, setSites] = useState<boolean | null>(devEnv ? null : false)
  useEffect(() => {
    if (!devEnv) return
    api.call(API.myDevEnvSites).then((r) => setSites(r.state !== 'off'), () => setSites(false))
  }, [devEnv])
  // the desktop app's site setting: only inside a desktop app that offers it (the value lives there)
  const tabs = settingsTabs(Boolean(browserSettingsBridge()), Boolean(own), Boolean(sites))
  const [query, setQuery] = useState('')
  const [more, setMore] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const q = query.trim().toLowerCase()
  const shown = tabs.filter((x) => sectionMatches(x, q, t))
  const groups = SETTINGS_GROUPS.map((g) => shown.filter((x) => x.group === g)).filter((g) => g.length)
  const waiting = (tab === 'providers' && own === null) || (tab === 'dev-env-sites' && sites === null)
  // Google Drive and MCP were sections of their own: both are Connectors now (Drive's page open for a Drive link)
  if (tab === 'drive') return <Navigate to="/settings/connectors?drive=1" replace />
  if (tab === 'integrations') return <Navigate to={`/settings/connectors${location.search}`} replace />
  // AI connections are now AI providers (the same accounts, by provider)
  if (tab === 'credentials') return <Navigate to="/settings/providers" replace />
  // an old or mistyped address (/settings/devices), or /settings/browser outside the desktop app: /settings instead (the
  // list, and on a computer the profile beside it)
  if (tab && !waiting && !tabs.some((x) => x.id === tab)) return <Navigate to="/settings" replace />
  const current = tab ?? 'profile'
  // phones: the open section's name in the bar (not for a page under a section: that page has its own title); 알림 is
  // reached from the 알림함 row there, so it keeps that name
  const section = tab && !page && !OWN_TITLE.has(tab) ? tabs.find((x) => x.id === tab) : undefined
  const sectionName = section ? t(section.id === 'notifications' ? 'inbox.title' : section.label) : ''

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 md:p-6 dark:bg-black/60" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex h-full w-full flex-col bg-surface text-ink shadow-xl outline-none [--sticky-bg:var(--c-surface)] max-md:bg-canvas max-md:[--sticky-bg:var(--c-canvas)] max-md:pt-[var(--safe-top)] md:h-[min(760px,100%)] md:max-w-[1040px] md:rounded-2xl md:dark:ring-1 md:dark:ring-line"
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="settings-dialog"
      >
        <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line pr-2.5 pl-3 md:pl-5">
          {tab && (
            <IconButton label={t('settings.allSections')} className="md:hidden" onClick={() => navigate(page ? `/settings/${tab}` : '/settings', { replace: true })} data-testid="settings-back">
              <ArrowLeft size={18} />
            </IconButton>
          )}
          {/* a phone starts on the title, not on its ← (focus put there showed a ring nobody asked for) or on a hidden
              ✕; a computer still starts on its first button */}
          <h2 id={titleId} tabIndex={-1} data-autofocus={phone ? '' : undefined} className={clsx('min-w-0 flex-1 truncate px-1 font-semibold outline-none', section && 'max-md:sr-only')}>
            {t('settings.title')}
          </h2>
          {section && (
            <p aria-hidden className="min-w-0 flex-1 truncate px-1 font-semibold md:hidden" data-testid="settings-section-title">
              {sectionName}
            </p>
          )}
          <IconButton label={t('common.close')} className="max-md:hidden" onClick={onClose} data-testid="settings-close">
            <X size={18} />
          </IconButton>
        </div>
        <div className="flex min-h-0 flex-1">
          {/* phones: the list on its own until a section is open */}
          <div className={clsx('flex w-full shrink-0 flex-col md:w-64 md:border-r md:border-line', tab && 'max-md:hidden')}>
            <div className="px-3 pt-3 pb-2 max-md:hidden">
              <div className="relative">
                <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
                <input ref={searchRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('settings.search')} aria-label={t('settings.search')} className={`${inputCls} pl-9 ${query ? 'pr-9' : ''}`} data-testid="settings-search" data-own-clear />
                {/* the app's own clear button (the browser's one is hidden in index.css: data-own-clear); the focus goes back to the field */}
                {query && (
                  <IconButton label={t('picker.clearSearch')} className="absolute top-1/2 right-1 -translate-y-1/2" onClick={() => { setQuery(''); searchRef.current?.focus() }} data-testid="settings-search-clear">
                    <X size={14} aria-hidden />
                  </IconButton>
                )}
              </div>
            </div>
            <nav aria-label={t('settings.title')} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 pb-3 max-md:px-1" data-testid="settings-menu">
              {/* phones: who is signed in, on top; it opens the profile (in place of the list's "프로필" row) */}
              <Link to="/settings/profile" replace className="mt-2 mb-2 flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-hover focus-visible:-outline-offset-2 md:hidden" data-testid="settings-me">
                <Avatar user={me.user} size={48} />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{me.user.name}</span>
                  <span className="block truncate text-sm text-muted">{me.user.title || t(`role.${me.user.role}`)}</span>
                </span>
                <span className="sr-only">{t('settings.profile')}</span>
              </Link>
              {/* phones: what needs me, first: the Inbox with its count (the same count as on the 나 tab) and Admin */}
              <div className="mb-3 space-y-0.5 md:hidden" data-testid="settings-phone-top">
                <NavLink to="/settings/notifications" replace className={({ isActive }) => clsx(phoneRow, isActive && 'bg-hover font-medium')} data-testid="settings-inbox">
                  <Bell size={16} className="shrink-0 text-muted" aria-hidden /> {t('inbox.title')}
                  {inbox > 0 && (
                    <span className="ml-auto rounded-full bg-accent px-1.5 text-micro font-medium text-accent-ink" data-testid="settings-inbox-unread">
                      <span aria-hidden>{inbox > 99 ? '99+' : inbox}</span>
                      <span className="sr-only">{t('notifications.unread', { count: inbox })}</span>
                    </span>
                  )}
                </NavLink>
                {/* the phone app with its notifications off in the phone's Settings: says so, with the way there */}
                <PhonePushLine />
                {isAdmin(me) && (
                  <Link to="/admin" className={phoneRow} data-testid="settings-admin">
                    <Shield size={16} className="shrink-0 text-muted" aria-hidden /> {t('sidebar.admin')}
                  </Link>
                )}
              </div>
              {groups.map((g, i) => (
                <div key={g[0]!.group} role="group" aria-labelledby={`settings-group-${g[0]!.group}`} className={clsx('space-y-0.5', i > 0 && 'mt-3')} data-testid={`settings-group-${g[0]!.group}`}>
                  <p id={`settings-group-${g[0]!.group}`} className="px-3 pb-1 text-xs text-faint">{t(`settings.group.${g[0]!.group}`)}</p>
                  {g.map((x) => (
                    <NavLink
                      key={x.id}
                      to={`/settings/${x.id}`}
                      replace
                      className={({ isActive }) =>
                        clsx('flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm hover:bg-hover focus-visible:-outline-offset-2 max-md:h-11', (isActive || (x.id === 'profile' && !tab) || x.id === tab) && 'md:bg-hover md:font-medium', isActive && 'bg-hover font-medium', ((ADVANCED.has(x.id) && !more) || PHONE_TOP.has(x.id)) && 'max-md:hidden')
                      }
                    >
                      <x.icon size={16} className="shrink-0 text-muted" aria-hidden /> {t(x.label)}
                    </NavLink>
                  ))}
                  {/* phones: the rarer sections of this group open here, in place */}
                  {!more && g.some((x) => ADVANCED.has(x.id)) && (
                    <button type="button" onClick={() => setMore(true)} className="flex h-11 w-full items-center gap-2.5 rounded-lg px-3 text-sm text-muted hover:bg-hover md:hidden" data-testid="settings-more">
                      <ChevronDown size={16} className="shrink-0" aria-hidden /> {t('common.more')}
                    </button>
                  )}
                </div>
              ))}
              {/* phones: signing out lives here (the drawer has no account menu there) */}
              <div className="md:hidden">
                <Rule />
                <button type="button" onClick={() => void logout()} className="flex h-11 w-full items-center gap-2.5 rounded-lg px-3 text-sm hover:bg-hover" data-testid="settings-logout">
                  <LogOut size={16} className="shrink-0 text-muted" aria-hidden /> {t('auth.logout')}
                </button>
              </div>
              {!shown.length && (
                <p className="px-3 py-2 text-sm text-muted" data-testid="settings-no-match">
                  {t('settings.noMatch', { q: query.trim() })}
                </p>
              )}
            </nav>
          </div>
          <div className={clsx('min-h-0 min-w-0 flex-1 overflow-y-auto', !tab && 'max-md:hidden')} data-testid="settings-content">
            <div className="mx-auto max-w-3xl p-4 sm:p-6">
              {waiting ? (
                <Spinner />
              ) : (
                <Suspense fallback={<Spinner />}>
                  {/* every section here is just for you (Admin pages say "For the whole team", admin/common.tsx) */}
                  <p className="mb-2 text-xs text-faint" data-testid="page-scope">{t('scope.you')}</p>
                  <SettingsPane tab={page ?? current} />
                </Suspense>
              )}
            </div>
          </div>
        </div>
        {/* phones: the tab bar stays (대화 · 파일 · 나): it is the way out of here */}
        <BottomTabs />
      </div>
    </div>
  )
}
