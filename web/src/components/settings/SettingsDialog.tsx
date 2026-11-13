// Settings as a dialog over the page it was opened from, like Claude's: the sections on the left (a search filters them
// by name and by a few words of what is inside, hairlines separate the groups of pages/settingsTabs.ts) and the open
// section on the right. /settings and
// /settings/<section> still work: App.tsx keeps the page behind it (Home when the address was opened directly) and
// `onClose` goes back to that page. On a computer /settings opens on the profile, with the list beside it. On a phone it
// is the 나 tab (BottomTabs.tsx opens /settings): it fills the screen above the tab bar (the bar is the way out, no ✕)
// and opens on its list (no search box): the person's photo, name and title on top, which open the profile (the list's
// own "프로필" row is left out there), then what needs me: 활동 (the Activity page, /activity) with its unread count and,
// for admins, 관리자; then the sections in their groups (알림 in its own) and 로그아웃, in the phone list every
// settings list uses (phone/PhoneList.tsx: chevrons, the count as the row's value). A row pushes its section, so the
// phone's own Back returns to the list (it replaced the list before, and Back left Settings); a section opened from a
// link gets the list put under it (lib/backStack.ts). A section on a phone has the phone bar: ‹ (named after where it
// goes, "‹ Settings") and its own name (its page keeps that heading for screen readers only, so the name is not said
// twice on screen; "설정" stays the dialog's name). Computers keep replacing: closing the dialog steps back once.
// docs/DECISIONS.md "Admin and Settings on phones: a list you tap into". A page under a section (`page`:
// /settings/account/delete, the account deletion request under the profile; a connector's page under Connectors,
// /settings/connectors/<id> and /settings/connectors/mcp/<id>) keeps its section marked in the list, and its way back
// goes to that section. Admin stays its own page. On a phone the sections about what the AI may open
// (트리나에게 허용한 것, 브라우저, 개발 환경 사이트) are one page, 트리나에게 허용한 것, with a part for each that is shown
// (PHONE_FOLDED; their old addresses open it), every section has no "나에게만 적용" line (all of 나 is just for you),
// its bar has a place for the section's one action (SettingsBar.tsx: Memory's "+"), and 로그아웃 asks first.
// On a phone (docs/DECISIONS.md "Phone tabs: 트리나 · 대화 · 파일 · 나") the list is headed "나" (not "설정": the tab says 나) and starts with the team: its logo and name, and for
// owners and admins 팀원 초대 and 관리자 (the computer's team menu; 관리자 moves here from the rows under the photo);
// after the photo, 활동 with its count, the status ("상태 설정") and "자리 비움으로 표시" (the computer's account menu).
import clsx from 'clsx'
import { ArrowLeftRight, Bell, ChevronRight, LogOut, Search, Shield, Smile, UserPlus, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react'
import { Link, Navigate, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom'
import { api, API, errorText } from '../../lib/api'
import { useGoBack } from '../../lib/back'
import { useBackLabel, useKeptScroll, useListUnderPage } from '../../lib/backStack'
import { browserSettingsBridge } from '../../lib/desktop'
import { switchTeam, useTeamSwitchWay } from '../../lib/teamSwitch'
import { connectorHref, CONNECTORS_HOME } from '../../lib/connectors'
import { useLocale, useT } from '../../i18n'
import { SETTINGS_GROUPS, browserTabShown, sectionMatches, settingsPageName, settingsTabs, type SettingsTab } from '../../pages/settingsTabs'
import { useNoticeUnread } from '../../store/inbox'
import { isAdmin, useMeStrict, useSession } from '../../store/session'
import { toast } from '../../store/ui'
import { IconButton, Spinner, confirmDialog, inputCls, menuOpener, useFocusTrap, useMediaQuery } from '../ui'
import { Avatar } from '../Avatar'
import { PresenceDot } from '../Presence'
import { openStatusDialog, useMyStatusWords } from '../StatusMessage'
import { openTeamInvite, TeamLogo } from '../TeamMenu'
import { BottomTabs } from '../BottomTabs'
import { useLogout } from '../../lib/logout'
import { PhonePushLine } from './PushNotifications'
import { PhoneListGroup, PhoneListRow } from '../phone/PhoneList'
import { PhonePageBar } from '../phone/PhonePageBar'
import { SettingsBarSlot, SettingsHold } from './SettingsBar'
import type { MessageKey } from '../../i18n'

const SettingsPane = lazy(() => import('../../pages/Settings'))
/** sections a phone's list shows on top instead of in their group: the profile (the photo row) */
const PHONE_TOP = new Set(['profile'])
/** sections a phone shows as parts of 트리나에게 허용한 것 (the AI's sites), not as rows of their own */
const PHONE_FOLDED = new Set(['browser', 'dev-env-sites'])

let openedFrom: HTMLElement | null = null
/** What gets the keyboard back when the dialog closes, said by whatever opens it when that is not what has focus by
 * then (the account menu's Settings item is gone once the menu closes): the menu's button. */
export function settingsOpenedFrom(el: HTMLElement | null) {
  openedFrom = el
}

/** pages under a section, by their address (App.tsx routes them here): the account deletion request under the
 * profile, on a phone the password form and every signed-in device under 보안·기기, and a connector's page under
 * Connectors */
export type SettingsPage = 'account-delete' | 'security-password' | 'security-devices' | 'connector'
const PAGE_SECTION: Record<SettingsPage, string> = { 'account-delete': 'profile', 'security-password': 'security', 'security-devices': 'security', connector: 'connectors' }
/** a page's name in a phone's bar (the account deletion page and a connector's page say their own) */
const PAGE_TITLE: Partial<Record<SettingsPage, MessageKey>> = { 'security-password': 'auth.changePassword', 'security-devices': 'settings.devices' }
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
  // a Google sign-in under way in Connectors: a stray click beside the dialog or Esc does not close it (its ✕ does)
  const [held, setHeld] = useState(false)
  const softClose = () => { if (!held) onClose() }
  useFocusTrap(ref, true, softClose, returnTo)
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
  // Browser: inside a desktop app that offers its site setting (that value lives there); elsewhere only while the
  // person's "Allow all websites" for the AI's web reads is on (that value lives on the server), and still after they
  // turn it off here, until the dialog closes (the section does not vanish under their hand)
  const [webOn, setWebOn] = useState(me.user.webAllowAll === true)
  useEffect(() => { if (me.user.webAllowAll) setWebOn(true) }, [me.user.webAllowAll])
  const tabs = settingsTabs(browserTabShown(Boolean(browserSettingsBridge()), me.team.webAllowAll, webOn), Boolean(own), Boolean(sites))
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const q = query.trim().toLowerCase()
  const shown = tabs.filter((x) => sectionMatches(x, q, t))
  const groups = SETTINGS_GROUPS.map((g) => shown.filter((x) => x.group === g)).filter((g) => g.length)
  const waiting = (tab === 'providers' && own === null) || (tab === 'dev-env-sites' && sites === null)
  // phones: a section opened from a link gets the list under it, once it is the section that stays; the list and the
  // open section each keep their place for Back (lib/backStack.ts)
  const redirecting = tab === 'drive' || tab === 'integrations' || tab === 'credentials' || (phone && !page && !!tab && PHONE_FOLDED.has(tab))
  const valid = !!tab && !waiting && !redirecting && tabs.some((x) => x.id === tab)
  // the Activity page (#364) is the 나 tab's too: 알림 opened from its gear goes back to it, with no list put between
  useListUnderPage('/settings', phone, valid && !page, ['/activity'])
  const listRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  useKeptScroll(listRef, 'settings-list', phone && !tab)
  // Connectors' pages are pushed on a computer too (a connector's page from the list): each starts at the top and Back
  // puts the list's place back
  useKeptScroll(contentRef, 'settings-section', (phone || tab === 'connectors') && !!tab && !waiting)
  // the section's one action in a phone's bar (SettingsBar.tsx)
  const [barSlot, setBarSlot] = useState<HTMLElement | null>(null)
  const back = useGoBack(page ? `/settings/${tab}` : '/settings')
  const backLabel = useBackLabel(page ? `/settings/${tab}` : '/settings', (p) => settingsPageName(p, t))
  // Connectors' older addresses here (MCP and Google Drive were sections of their own): its section, with what the
  // address asked for (?add=1, ?template=, ?request=), and Google Drive's page under it
  if (tab === 'integrations') return <Navigate to={`${CONNECTORS_HOME}${location.search}`} replace />
  if (tab === 'drive') return <Navigate to={connectorHref('google-drive')} replace />
  // AI connections are now AI providers (the same accounts, by provider)
  if (tab === 'credentials') return <Navigate to="/settings/providers" replace />
  // an old or mistyped address (/settings/devices), or /settings/browser outside the desktop app while the team does not
  // let members allow all websites for web reads: /settings instead (the list, and on a computer the profile beside it)
  if (tab && !waiting && !tabs.some((x) => x.id === tab)) return <Navigate to="/settings" replace />
  // a phone: Browser and Dev environment sites are parts of 트리나에게 허용한 것
  if (phone && tab && !page && !waiting && PHONE_FOLDED.has(tab)) return <Navigate to="/settings/allowances" replace />
  const current = tab ?? 'profile'
  // phones: the open section's name in the bar (not for a page under a section: that page has its own title)
  const section = tab && !page ? tabs.find((x) => x.id === tab) : undefined
  const pageTitle = page && PAGE_TITLE[page] ? t(PAGE_TITLE[page]!) : ''
  const sectionName = section ? t(section.label) : pageTitle
  // a phone's 트리나에게 허용한 것: which of the folded sections are there (each keeps its own condition)
  const fold = phone && current === 'allowances' && !page ? { browser: tabs.some((x) => x.id === 'browser'), devEnvSites: tabs.some((x) => x.id === 'dev-env-sites') } : undefined

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 md:p-6 dark:bg-black/60" onMouseDown={softClose}>
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
            <PhonePageBar onBack={back} backLabel={backLabel} title={sectionName} titleHidden={!!section} backTestId="settings-back" titleTestId="settings-section-title" className="h-14"
              action={<span ref={setBarSlot} className="flex items-center" data-testid="settings-bar-action" />} />
          </div>
        ) : (
          <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line pr-2.5 pl-3 md:pl-5">
            {/* a phone starts on the title, not on a hidden ✕; a computer still starts on its first button */}
            <h2 id={titleId} tabIndex={-1} data-autofocus={phone ? '' : undefined} className="min-w-0 flex-1 truncate px-1 text-title-sm font-semibold outline-none" data-testid="settings-title">
              {phone ? t('tabs.me') : t('settings.title')}
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
                  {/* a phone: everything under 나 is just for you, so the line is not on every section */}
                  <p className="mb-3 text-xs text-faint max-md:hidden" data-testid="page-scope">{t('scope.you')}</p>
                  <SettingsBarSlot.Provider value={phone && tab ? barSlot : null}>
                    <SettingsHold.Provider value={setHeld}>
                      <SettingsPane tab={page ?? current} fold={fold} />
                    </SettingsHold.Provider>
                  </SettingsBarSlot.Provider>
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

/** The 나 list on a phone: the team (PhoneTeamGroup: 팀원 초대 and 관리자 for owners and admins), who is signed in (it
 * opens the profile), what needs me (the Activity page with its count, my status and away, the phone app's notifications
 * when they are off), the sections in their groups (알림, the
 * notification settings, in its own), and 로그아웃. Every row pushes its page, so Back comes back here. */
function PhoneSettingsList({ tabs, navRef }: { tabs: SettingsTab[]; navRef: React.Ref<HTMLElement> }) {
  const t = useT()
  const me = useMeStrict()
  const logout = useLogout()
  // the 나 tab's count (the app's own notices: mentions and thread replies are counted on 대화)
  const inbox = useNoticeUnread()
  const groups = SETTINGS_GROUPS.map((g) => tabs.filter((x) => x.group === g && !PHONE_TOP.has(x.id) && !PHONE_FOLDED.has(x.id))).filter((g) => g.length)
  // signing out asks first (a tap at the end of a long list is easily made by mistake)
  const signOut = async () => {
    if (await confirmDialog({ title: t('settings.logoutConfirm'), confirm: t('auth.logout'), danger: true })) void logout()
  }
  return (
    <nav ref={navRef} aria-label={t('tabs.me')} className="min-h-0 flex-1 overflow-y-auto pb-6" data-testid="settings-menu">
      <PhoneTeamGroup />
      <PhoneListGroup testId="settings-me-group">
        <li className="group/row">
          <Link to="/settings/profile" className="flex items-center gap-3 px-4 py-3 hover:bg-hover focus-visible:-outline-offset-2" data-testid="settings-me">
            <Avatar user={me.user} size={48} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-row font-medium">{me.user.name}</span>
              <span className="block truncate text-meta text-muted">{me.user.title || t(`role.${me.user.role}`)}</span>
            </span>
            <span className="sr-only">{t('settings.profile')}</span>
            <ChevronRight size={16} className="shrink-0 text-faint" aria-hidden />
          </Link>
        </li>
      </PhoneListGroup>
      {/* what needs me, first: the Inbox with its count (the same count as on the 나 tab), my status and away */}
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
        <PhoneStatusRows />
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
        <PhoneListRow icon={<LogOut size={16} />} title={t('auth.logout')} onClick={() => void signOut()} testId="settings-logout" />
      </PhoneListGroup>
    </nav>
  )
}

/** The 나 tab's team: the team's logo and name; for owners and admins 팀원 초대 (the invite dialog, or
 * the owner's own invite step while the welcome steps are unfinished: TeamMenu.tsx openTeamInvite) and 관리자; in the
 * phone app (or the desktop app at a phone's width) "다른 팀으로 전환…" for everyone (lib/teamSwitch.ts: the app's own
 * screen; a plain browser has none). */
function PhoneTeamGroup() {
  const t = useT()
  const me = useMeStrict()
  const navigate = useNavigate()
  const admin = isAdmin(me)
  const canSwitch = useTeamSwitchWay() !== null
  return (
    <PhoneListGroup testId="settings-team-group">
      <li className="flex items-center gap-3 px-4 py-3" data-testid="settings-team">
        <TeamLogo className="size-8 rounded-lg" />
        <span className="min-w-0 flex-1 truncate text-row font-medium">{me.team.name}</span>
      </li>
      {admin && <PhoneListRow icon={<UserPlus size={16} />} title={t('teamMenu.invite')} onClick={() => void openTeamInvite(navigate, null)} chevron testId="settings-invite" />}
      {admin && <PhoneListRow icon={<Shield size={16} />} title={t('sidebar.admin')} to="/admin" testId="settings-admin" />}
      {canSwitch && <PhoneListRow icon={<ArrowLeftRight size={16} />} title={t('teamMenu.switch')} onClick={switchTeam} chevron testId="settings-switch-team" />}
    </PhoneListGroup>
  )
}

/** The 나 tab's status rows (the computer's account menu has the same): my status message ("상태 설정",
 * or what it says now) and "자리 비움으로 표시" / "접속 중으로 표시". */
function PhoneStatusRows() {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const status = useMyStatusWords()
  const away = !!me.user.prefs.away
  const toggleAway = () => void useSession.getState().setAway(!away).catch((e) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) }))
  return (
    <>
      <PhoneListRow
        icon={status ? <span className="text-base leading-none">{status.emoji}</span> : <Smile size={16} />}
        title={status ? status.words : t('status.set')}
        onClick={() => openStatusDialog(null)}
        chevron
        testId="settings-status"
      />
      <PhoneListRow
        icon={<span className="[--presence-bg:var(--c-canvas)]"><PresenceDot state={away ? 'online' : 'away'} size={10} /></span>}
        title={away ? t('presence.setActive') : t('presence.setAway')}
        onClick={toggleAway}
        chevron={false}
        testId="settings-away"
      />
    </>
  )
}
