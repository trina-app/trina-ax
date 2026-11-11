// Settings as a dialog over the page it was opened from, like Claude's: the sections on the left (a search filters them
// by name and by a few words of what is inside, hairlines separate the groups of pages/settingsTabs.ts) and the open
// section on the right. /settings and
// /settings/<section> still work: App.tsx keeps the page behind it (Home when the address was opened directly) and
// `onClose` goes back to that page. On a computer /settings opens on the profile, with the list beside it. On a phone it
// is the 나 tab (BottomTabs.tsx opens /settings): it fills the screen above the tab bar (the bar is the way out, no ✕)
// and opens on its list (no search box): the person's photo, name and title on top, which open the profile (the list's
// own "프로필" row is left out there), then what needs me: 알림함 with its unread count (the 알림 section, whose own row
// is left out there) and, for admins, 관리자; then the sections in their groups and 로그아웃, in the phone list every
// settings list uses (phone/PhoneList.tsx: chevrons, the count as the row's value). A row pushes its section, so the
// phone's own Back returns to the list (it replaced the list before, and Back left Settings); a section opened from a
// link gets the list put under it (lib/backStack.ts). A section on a phone has the phone bar: ‹ (named after where it
// goes, "‹ Settings") and its own name (its page keeps that heading for screen readers only, so the name is not said
// twice on screen; "설정" stays the dialog's name). Computers keep replacing: closing the dialog steps back once.
// docs/DECISIONS.md "Admin and Settings on phones: a list you tap into". A page under a section (`page`:
// /settings/account/delete, the account deletion request under the profile) keeps its section marked in the list, and
// its way back goes to that section. Admin stays its own page.
import clsx from 'clsx'
import { Bell, ChevronRight, LogOut, Search, Shield, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react'
import { Link, Navigate, NavLink, useLocation, useParams } from 'react-router-dom'
import { api, API } from '../../lib/api'
import { useGoBack } from '../../lib/back'
import { useBackLabel, useKeptScroll, useListUnderPage } from '../../lib/backStack'
import { browserSettingsBridge } from '../../lib/desktop'
import { useT } from '../../i18n'
import { SETTINGS_GROUPS, sectionMatches, settingsPageName, settingsTabs, type SettingsTab } from '../../pages/settingsTabs'
import { useInboxUnread } from '../../store/inbox'
import { isAdmin, useMeStrict } from '../../store/session'
import { IconButton, Spinner, inputCls, menuOpener, useFocusTrap, useMediaQuery } from '../ui'
import { Avatar } from '../Avatar'
import { BottomTabs } from '../BottomTabs'
import { useLogout } from '../../lib/logout'
import { PhonePushLine } from './PushNotifications'
import { PhoneListGroup, PhoneListRow } from '../phone/PhoneList'
import { PhonePageBar } from '../phone/PhonePageBar'

const SettingsPane = lazy(() => import('../../pages/Settings'))
/** sections a phone's list shows on top instead of in their group: the profile (the photo row) */
const PHONE_TOP = new Set(['profile'])

let openedFrom: HTMLElement | null = null
/** What gets the keyboard back when the dialog closes, said by whatever opens it when that is not what has focus by
 * then (the account menu's Settings item is gone once the menu closes): the menu's button. */
export function settingsOpenedFrom(el: HTMLElement | null) {
  openedFrom = el
}

/** pages under a section, by their address (App.tsx routes them here) */
export type SettingsPage = 'account-delete'
const PAGE_SECTION: Record<SettingsPage, string> = { 'account-delete': 'profile' }
export default function SettingsDialog({ onClose, page }: { onClose: () => void; page?: SettingsPage }) {
  const t = useT()
  const me = useMeStrict()
  // phones (below 768 px, the width of the phone top bar and tabs): the list first, its photo row, no search box
  const phone = useMediaQuery('(max-width: 767.98px)')
  const params = useParams()
  const tab = page ? PAGE_SECTION[page] : params.tab
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
  const searchRef = useRef<HTMLInputElement>(null)
  const q = query.trim().toLowerCase()
  const shown = tabs.filter((x) => sectionMatches(x, q, t))
  const groups = SETTINGS_GROUPS.map((g) => shown.filter((x) => x.group === g)).filter((g) => g.length)
  const waiting = (tab === 'providers' && own === null) || (tab === 'dev-env-sites' && sites === null)
  // phones: a section opened from a link gets the list under it, once it is the section that stays; the list and the
  // open section each keep their place for Back (lib/backStack.ts)
  const redirecting = tab === 'drive' || tab === 'integrations' || tab === 'credentials'
  const valid = !!tab && !waiting && !redirecting && tabs.some((x) => x.id === tab)
  useListUnderPage('/settings', phone, valid && !page)
  const listRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  useKeptScroll(listRef, 'settings-list', phone && !tab)
  useKeptScroll(contentRef, 'settings-section', phone && !!tab && !waiting)
  const back = useGoBack(page ? `/settings/${tab}` : '/settings')
  const backLabel = useBackLabel(page ? `/settings/${tab}` : '/settings', (p) => settingsPageName(p, t))
  // Google Drive and MCP were sections of their own: both are Connectors now (Drive's page open for a Drive link)
  if (tab === 'drive') return <Navigate to="/settings/connectors?drive=1" replace />
  if (tab === 'integrations') return <Navigate to={`/settings/connectors${location.search}`} replace />
  // AI connections are now AI providers (the same accounts, by provider)
  if (tab === 'credentials') return <Navigate to="/settings/providers" replace />
  // an old or mistyped address (/settings/devices), or /settings/browser outside the desktop app: /settings instead (the
  // list, and on a computer the profile beside it)
  if (tab && !waiting && !tabs.some((x) => x.id === tab)) return <Navigate to="/settings" replace />
  const current = tab ?? 'profile'
  // phones: the open section's name in the bar (not for a page under a section: that page has its own title)
  const section = tab && !page ? tabs.find((x) => x.id === tab) : undefined
  const sectionName = section ? t(section.label) : ''

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
        {phone && tab ? (
          // a phone's section: the phone bar (‹ and where it goes, the section's name); a computer's header below
          <div className="relative">
            {/* a phone starts on the title, not on its ‹ (focus put there showed a ring nobody asked for) */}
            <h2 id={titleId} tabIndex={-1} data-autofocus="" className="sr-only">{t('settings.title')}</h2>
            <PhonePageBar onBack={back} backLabel={backLabel} title={section ? sectionName : ''} titleHidden={!!section} backTestId="settings-back" titleTestId="settings-section-title" className="h-14" />
          </div>
        ) : (
          <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line pr-2.5 pl-3 md:pl-5">
            {/* a phone starts on the title, not on a hidden ✕; a computer still starts on its first button */}
            <h2 id={titleId} tabIndex={-1} data-autofocus={phone ? '' : undefined} className="min-w-0 flex-1 truncate px-1 font-semibold outline-none">
              {t('settings.title')}
            </h2>
            <IconButton label={t('common.close')} className="max-md:hidden" onClick={onClose} data-testid="settings-close">
              <X size={18} />
            </IconButton>
          </div>
        )}
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
            {phone ? (
              <PhoneSettingsList tabs={tabs} navRef={listRef} />
            ) : (
              <nav aria-label={t('settings.title')} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 pb-3" data-testid="settings-menu">
                {groups.map((g, i) => (
                  <div key={g[0]!.group} role="group" aria-labelledby={`settings-group-${g[0]!.group}`} className={clsx('space-y-0.5', i > 0 && 'mt-3')} data-testid={`settings-group-${g[0]!.group}`}>
                    <p id={`settings-group-${g[0]!.group}`} className="px-3 pb-1 text-xs text-faint">{t(`settings.group.${g[0]!.group}`)}</p>
                    {g.map((x) => (
                      <NavLink
                        key={x.id}
                        to={`/settings/${x.id}`}
                        replace
                        className={({ isActive }) =>
                          clsx('flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm hover:bg-hover focus-visible:-outline-offset-2', (isActive || (x.id === 'profile' && !tab) || x.id === tab) && 'bg-hover font-medium')
                        }
                      >
                        <x.icon size={16} className="shrink-0 text-muted" aria-hidden /> {t(x.label)}
                      </NavLink>
                    ))}
                  </div>
                ))}
                {!shown.length && (
                  <p className="px-3 py-2 text-sm text-muted" data-testid="settings-no-match">
                    {t('settings.noMatch', { q: query.trim() })}
                  </p>
                )}
              </nav>
            )}
          </div>
          <div ref={contentRef} className={clsx('min-h-0 min-w-0 flex-1 overflow-y-auto', !tab && 'max-md:hidden')} data-testid="settings-content">
            <div className="mx-auto max-w-3xl p-4 sm:p-6">
              {waiting ? (
                <Spinner />
              ) : (
                <Suspense fallback={<Spinner />}>
                  {/* every section here is just for you (Admin says "Applies to everyone in <team>" the same way, admin/common.tsx) */}
                  {/* mb-3: a section's title row starts 12px higher (-mt-3) and would cover the line's descenders */}
                  <p className="mb-3 text-xs text-faint" data-testid="page-scope">{t('scope.you')}</p>
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

/** The 나 list on a phone: who is signed in (it opens the profile), what needs me (the Activity page with its count, the
 * phone app's notifications when they are off, 관리자 for owners and admins), the sections in their groups (알림, the
 * notification settings, in its own), and 로그아웃. Every row pushes its page, so Back comes back here. */
function PhoneSettingsList({ tabs, navRef }: { tabs: SettingsTab[]; navRef: React.Ref<HTMLElement> }) {
  const t = useT()
  const me = useMeStrict()
  const logout = useLogout()
  const inbox = useInboxUnread()
  const groups = SETTINGS_GROUPS.map((g) => tabs.filter((x) => x.group === g && !PHONE_TOP.has(x.id))).filter((g) => g.length)
  return (
    <nav ref={navRef} aria-label={t('settings.title')} className="min-h-0 flex-1 overflow-y-auto pb-6" data-testid="settings-menu">
      <PhoneListGroup testId="settings-me-group">
        <li className="group/row">
          <Link to="/settings/profile" className="flex items-center gap-3 px-4 py-3 hover:bg-hover focus-visible:-outline-offset-2" data-testid="settings-me">
            <Avatar user={me.user} size={48} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{me.user.name}</span>
              <span className="block truncate text-sm text-muted">{me.user.title || t(`role.${me.user.role}`)}</span>
            </span>
            <span className="sr-only">{t('settings.profile')}</span>
            <ChevronRight size={16} className="shrink-0 text-faint" aria-hidden />
          </Link>
        </li>
      </PhoneListGroup>
      {/* what needs me, first: the Inbox with its count (the same count as on the 나 tab) and Admin */}
      <PhoneListGroup testId="settings-phone-top">
        <PhoneListRow
          icon={<Bell size={16} />}
          title={t('inbox.title')}
          to="/activity"
          badge={inbox > 0 ? (
            <span className="shrink-0 rounded-full bg-accent px-1.5 text-micro font-medium text-accent-ink" data-testid="settings-inbox-unread">
              <span aria-hidden>{inbox > 99 ? '99+' : inbox}</span>
              <span className="sr-only">{t('notifications.unread', { count: inbox })}</span>
            </span>
          ) : undefined}
          testId="settings-inbox"
        />
        {isAdmin(me) && <PhoneListRow icon={<Shield size={16} />} title={t('sidebar.admin')} to="/admin" testId="settings-admin" />}
      </PhoneListGroup>
      {/* the phone app with its notifications off in the phone's Settings: says so, with the way there */}
      <PhonePushLine />
      {groups.map((g) => (
        <PhoneListGroup key={g[0]!.group} title={t(`settings.group.${g[0]!.group}`)} labelId={`settings-group-${g[0]!.group}`} testId={`settings-group-${g[0]!.group}`}>
          {g.map((x) => <PhoneListRow key={x.id} icon={<x.icon size={16} />} title={t(x.label)} to={`/settings/${x.id}`} testId={`settings-row-${x.id}`} />)}
        </PhoneListGroup>
      ))}
      {/* signing out lives here (the phone has no account menu) */}
      <PhoneListGroup>
        <PhoneListRow icon={<LogOut size={16} />} title={t('auth.logout')} onClick={() => void logout()} testId="settings-logout" />
      </PhoneListGroup>
    </nav>
  )
}
