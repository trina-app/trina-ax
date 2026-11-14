// Routes and the sign-in gate: first-run setup → /setup, signed out → /login (invite links still open),
// must change password → /password, otherwise the app with its WebSocket running.
import { GuestLanding, NotForGuests, NotForRoomGuests, useGuestPlacePath } from './components/GuestView'
import { ShareChatHost } from './components/chat/ShareChat'
import { ChatShareHost } from './components/chat/ChatShareDialog'
import { WideningDraftHost } from './components/WideningDraftHost'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, Route, Routes, unstable_HistoryRouter as HistoryRouter, useLocation, useNavigate, useNavigationType, type Location } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import { Loader2 } from 'lucide-react'
import { ApiError, errorText, isTeamWaking, setMediaKey } from './lib/api'
import { useLocale, useT } from './i18n'
import { useChats } from './store/chats'
import { useDeckBuilds } from './store/deckBuilds'
import { useSendQueue } from './store/sendQueue'
import { useProjects } from './store/projects'
import { useFileLists } from './store/fileLists'
import { useListCache } from './store/listCache'
import { useProjectPage } from './store/projectPage'
import { useTeamFiles } from './store/teamFiles'
import { useChatGroups } from './store/chatGroups'
import { useNavFolders } from './store/navFolders'
import { useAiAccess } from './store/aiAccess'
import { useWelcome } from './store/welcome'
import { useMemberWelcome } from './store/memberWelcome'
import { useHandover } from './store/handover'
import { useRooms } from './store/rooms'
import { usePeople } from './store/people'
import { startLive, stopLive } from './store/live'
import { useEngines } from './store/engines'
import { resetInbox } from './store/inbox'
import { useJobs } from './store/jobs'
import { useSessionMarkers } from './store/sessionMarkers'
import { resetAdminReads } from './store/adminPeople'
import { useRailMemory } from './lib/rail'
import { setBeforePersonSwitch, useMe, useSession } from './store/session'
import { isGuestMe } from './lib/guests'
import { clearLocalData } from './lib/localData'
import { forgetStepsSeen } from './lib/welcome'
import Layout from './components/Layout'
import { screenHistory } from './lib/screenHistory'
import { ChunkErrorBoundary } from './components/ChunkErrorBoundary'
import { AnnounceProvider, Button, DialogHost, Spinner, Toaster } from './components/ui'
import { StatusDialogHost } from './components/StatusMessage'
import { AcceptInvite, ForcedPassword, InviteWhileSignedIn, Login, ResetPassword, Setup, signedInHome, TeamJoin } from './pages/Auth'
import Home from './pages/Home'
import SettingsDialog from './components/settings/SettingsDialog'
import { ImageViewerHost } from './components/ImageViewer'
import { RealPath } from './lib/realPath'
import { noteLocation } from './lib/backStack'
import { useAppNav } from './lib/appNav'
import { safeNext } from './lib/nav'
import { isOldConnectorsPath, oldConnectorsTarget } from './lib/connectors'
import { useLogoutTo } from './lib/logout'
import { afterJoinSet, afterJoinTarget, clearAfterJoin, readJoinToken } from './lib/team-link'
import { resetOptimistic } from './lib/optimistic'
import { toast } from './store/ui'
import { afterSetupTarget, clearAfterSetup, LANDING_STATE } from './lib/welcome'
import { RoomAppsHost } from './components/rooms/apps/AppsHost'

const ChatPage = lazy(() => import('./pages/Chat'))
const Files = lazy(() => import('./pages/Files'))
const FileView = lazy(() => import('./pages/FileView'))
const ProjectList = lazy(() => import('./pages/Projects').then((m) => ({ default: m.ProjectList })))
const ProjectHome = lazy(() => import('./pages/Projects').then((m) => ({ default: m.ProjectHome })))
const ProjectFiles = lazy(() => import('./pages/Projects').then((m) => ({ default: m.ProjectFiles })))
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'))
const Trash = lazy(() => import('./pages/Trash'))
const Skills = lazy(() => import('./pages/Skills'))
const SkillSharePage = lazy(() => import('./pages/SkillSharePage'))
const ScheduledList = lazy(() => import('./pages/Scheduled').then((m) => ({ default: m.ScheduledList })))
const ScheduledTask = lazy(() => import('./pages/Scheduled').then((m) => ({ default: m.ScheduledTask })))
const ConnectorConsent = lazy(() => import('./pages/ConnectorConsent'))
const SlackLink = lazy(() => import('./pages/SlackLink'))
const SlackSignInReturn = lazy(() => import('./pages/SlackSignIn').then((m) => ({ default: m.SlackSignInReturn })))
const SlackDone = lazy(() => import('./pages/SlackSignIn').then((m) => ({ default: m.SlackDone })))
const Welcome = lazy(() => import('./pages/Welcome'))
const Rooms = lazy(() => import('./pages/Rooms'))
const RoomPage = lazy(() => import('./pages/Room'))
const Activity = lazy(() => import('./pages/Activity'))

function Splash() {
  const t = useT()
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner label={t('common.loading')} />
    </div>
  )
}

/** Settings' addresses, and Connectors' old ones (Settings › Connectors now: they open the dialog over the page they
 * came from too; lib/connectors.ts) */
const isSettings = (path: string) => path === '/settings' || path.startsWith('/settings/') || isOldConnectorsPath(path)

/** Settings is a dialog over a page (components/settings/SettingsDialog.tsx): the page it was opened from, or Home when
 * its address was opened directly (a guest: their one place, components/GuestView.tsx useGuestPlacePath). `close` goes
 * back to that page: back through the history entries Settings added on top of it, or straight to it when there are
 * none. */
function useSettingsOverlay() {
  const location = useLocation()
  const navType = useNavigationType()
  const navigate = useNavigate()
  const page = useRef<Location | null>(null)
  const depth = useRef(0)
  const open = isSettings(location.pathname)
  const guestHome = useGuestPlacePath()
  // the phone's back stack notes what is under each entry the first time it shows, before any page renders and reads
  // it (lib/backStack.ts: the list under a page opened from a link, and the ‹ button's label)
  noteLocation(location, navType)
  useEffect(() => {
    if (!open) {
      page.current = location
      depth.current = 0
    } else if (navType === 'PUSH') depth.current += 1
    else if (navType === 'POP') depth.current = Math.max(0, depth.current - 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key])
  const home = guestHome ?? '/'
  const under: Location = open ? (page.current ?? { pathname: home, search: '', hash: '', state: null, key: 'settings-home' }) : location
  const close = useCallback(() => {
    const back = page.current
    if (depth.current > 0 && back) navigate(-depth.current)
    else navigate(back ? `${back.pathname}${back.search}${back.hash}` : home, { replace: true })
  }, [navigate, home])
  const real = useMemo(() => ({ pathname: location.pathname, navigationType: navType }), [location.pathname, navType])
  return { open, under, close, real }
}

/** Everything one person's window keeps in memory of their own: chats, the messages waiting to be sent, the projects
 * seen, rooms (and their side chats), people, the AI engine picker's list, the unread Inbox count, job cards, the
 * chat counted as on screen, the lists kept by key (store/listCache.ts: skills, Search, Settings, tasks, 활동) and the
 * admin screens' kept reads. */
function dropPersonStores() {
  // the changes still on their way to the server (lib/optimistic.ts) write nothing into the next person's stores
  resetOptimistic()
  useChats.getState().reset()
  useDeckBuilds.getState().reset()
  useSendQueue.getState().reset()
  useProjects.getState().reset()
  useFileLists.getState().reset()
  useListCache.getState().reset()
  useTeamFiles.getState().reset()
  useProjectPage.getState().reset()
  useChatGroups.getState().reset()
  useNavFolders.getState().reset()
  useAiAccess.getState().reset()
  useWelcome.getState().reset()
  useMemberWelcome.getState().reset()
  useHandover.getState().reset()
  useRooms.getState().reset()
  usePeople.getState().reset()
  useEngines.getState().reset()
  resetInbox()
  useJobs.getState().reset()
  useSessionMarkers.getState().reset()
  useRailMemory.getState().reset()
  resetAdminReads()
}

// Another person signing in over a signed-in one in this window (a password reset link on a shared computer,
// docs/DECISIONS.md "Another person signs in over a session") is a sign-out first, before the new person's screens
// mount: the live connection closes, the stores are emptied and this browser's drafts, queue and uploads go, as at the
// account menu's sign-out (lib/logout.ts). useSessionLifecycle then opens the new person's connection and reloads.
setBeforePersonSwitch(() => {
  stopLive()
  dropPersonStores()
  clearLocalData()
  forgetStepsSeen()
})

// the addresses of room pictures carry this sign-in's media key (lib/api.ts roomFileUrl): set before any screen of the
// session draws (a store subscription runs as the status changes, before React renders), none while signed out
const mediaKeyOf = (s: ReturnType<typeof useSession.getState>) => (s.status.kind === 'signed-in' ? s.status.me.session?.mediaKey ?? null : null)
setMediaKey(mediaKeyOf(useSession.getState()))
useSession.subscribe((s) => setMediaKey(mediaKeyOf(s)))

/** The page load after another person signed in over the signed-in one (tests replace it). */
export const personSwitch = { reload: () => location.reload() }

/** The session's side effects (Gate): live updates while signed in; when signed out, nothing one person's window kept
 * stays for the next. After another person signed in over a signed-in one (emptied by the sign-out above, at that
 * moment) the new person's connection opens and the page loads again, so that no module's own copy of the last
 * person's data stays either. Returns whether signed in. */
export function useSessionLifecycle(): boolean {
  const status = useSession((s) => s.status)
  const signedIn = status.kind === 'signed-in' && !status.me.user.mustChangePassword
  const userId = status.kind === 'signed-in' ? status.me.user.id : null
  /** the person this window last had signed in (also while changing a forced password) */
  const lastUser = useRef<string | null>(null)
  useEffect(() => {
    const before = lastUser.current
    if (status.kind === 'signed-in' || status.kind === 'signed-out') lastUser.current = userId
    if (signedIn) startLive()
    else {
      stopLive()
      if (status.kind !== 'loading') dropPersonStores()
    }
    if (before && userId && before !== userId) personSwitch.reload()
  }, [signedIn, status.kind, userId])
  return signedIn
}

/** How often the page asks the server again on its own while "Can't reach" shows. */
const RETRY_MS = 5000

/** The offline page: it asks again by itself (every few seconds, when the network comes back, when the tab is looked at
 * again) and the screen the person was on returns when the server answers; the button asks at once. */
function CantReach({ hint, detail, waking }: { hint: string; detail: string; waking?: boolean }) {
  const t = useT()
  const load = useSession((s) => s.load)
  useEffect(() => {
    let asking = false
    const ask = () => {
      if (asking || document.visibilityState === 'hidden') return
      asking = true
      void load().finally(() => { asking = false })
    }
    const timer = setInterval(ask, RETRY_MS)
    window.addEventListener('online', ask)
    document.addEventListener('visibilitychange', ask)
    return () => { clearInterval(timer); window.removeEventListener('online', ask); document.removeEventListener('visibilitychange', ask) }
  }, [load])
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-canvas p-6 text-center" data-testid="cant-reach">
      <p className="mb-3 flex items-center justify-center gap-2 text-xl font-semibold tracking-tight">
        <img src="/favicon.svg" alt="" aria-hidden className="size-7 rounded-lg" />
        {PRODUCT.displayName}
      </p>
      {waking ? (
        // the team's server was turned off for no use and is starting (about a minute): a calm wait, not an error
        <>
          <p className="flex items-center gap-2 font-medium" role="status" data-testid="team-waking"><Loader2 size={16} className="animate-spin text-muted" aria-hidden />{t('conn.waking')}</p>
          <p className="max-w-md text-sm text-balance text-muted">{t('conn.wakingDetail')}</p>
        </>
      ) : (
        <>
          <p className="font-medium">{t('conn.cantReach')}</p>
          <p className="max-w-md text-sm text-balance text-muted">{hint}</p>
          {detail && <p className="max-w-md text-xs text-faint">{detail}</p>}
          <Button onClick={() => void load()}>{t('common.retry')}</Button>
        </>
      )}
    </div>
  )
}

function Gate() {
  const t = useT()
  const locale = useLocale()
  const status = useSession((s) => s.status)
  const load = useSession((s) => s.load)
  const location = useLocation()
  const settings = useSettingsOverlay()

  useEffect(() => {
    // main.tsx asked already (before the first render); this one counts only when nothing did (tests mount Gate alone)
    if (useSession.getState().status.kind === 'loading') void load()
  }, [load])

  useSessionLifecycle()
  // the phone app's swipe and Back follow the screens (nav-v1, lib/appNav.ts)
  useAppNav(status.kind === 'signed-in' ? status.me.user.id : '')

  useEffect(() => {
    document.title = PRODUCT.displayName
  }, [])

  if (status.kind === 'loading') return <Splash />
  if (status.kind === 'error') {
    // The plain hint always shows; the server's own words and the HTTP status are a small detail under it
    const hint = t('conn.cantReachHint')
    const text = errorText(status.error, locale, hint)
    const detail = [text !== hint ? text : null, status.error instanceof ApiError ? `HTTP ${status.error.status}` : null].filter(Boolean).join(' · ')
    return <CantReach hint={hint} detail={detail} waking={isTeamWaking(status.error)} />
  }
  if (status.kind === 'setup')
    return (
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route path="*" element={<Navigate to={`/setup${location.search}`} replace />} />
      </Routes>
    )
  if (status.kind === 'signed-out') {
    const next = location.pathname !== '/' && location.pathname !== '/login' ? `?next=${encodeURIComponent(location.pathname + location.search)}` : ''
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/invite/:token" element={<AcceptInvite />} />
        {/* the team invite link: the token is after # (never in a path or a log) */}
        <Route path="/join" element={<TeamJoin />} />
        <Route path="/reset-password/:token" element={<ResetPassword />} />
        <Route path="/slack/done" element={<Suspense fallback={<Splash />}><SlackDone signedIn={false} /></Suspense>} />
        <Route path="*" element={<Navigate to={`/login${next}`} replace />} />
      </Routes>
    )
  }
  if (status.me.user.mustChangePassword) {
    // where the person was heading goes along (?next=), so the new password leads there instead of Home
    // (never an address that holds a token: an invite or reset link would only move it into the query)
    const tokenPage = /^\/(invite|reset-password|join)(\/|$)/.test(location.pathname)
    const heading = location.pathname === '/login' ? safeNext(location.search) : location.pathname !== '/' && !tokenPage ? location.pathname + location.search : null
    return (
      <Routes>
        <Route path="/password" element={<ForcedPassword />} />
        <Route path="*" element={<Navigate to={`/password${heading ? `?next=${encodeURIComponent(heading)}` : ''}`} replace />} />
      </Routes>
    )
  }
  return (
    // a lazy route that is gone after a server update: reload once instead of a blank page (lib/chunk-reload.ts)
    <ChunkErrorBoundary>
    <Suspense fallback={<Splash />}>
      {/* under Settings: the page it was opened from (Settings itself is the dialog below), out of reach while it is open */}
      <RealPath.Provider value={settings.real}>
      {/* keyed by the person: another person signed in over this one starts every screen afresh (useSessionLifecycle) */}
      <div key={status.me.user.id} className="h-full" inert={settings.open} aria-hidden={settings.open || undefined}>
      {/* a guest (lib/guests.ts): the pages that are not theirs go to Home (components/GuestView.tsx NotForGuests) */}
      <Routes location={settings.under}>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          {/* the new chat on its own page: a phone, where / is 트리나's list (lib/newChat.ts); a
              computer's goes to / (pages/Home.tsx) */}
          <Route path="new" element={<Home />} />
          <Route path="c/:chatId" element={<ChatPage />} />
          {/* the team chat rooms: the list (the 대화 tab on phones) and one room (the mobile app links here) */}
          <Route path="rooms" element={<Rooms />} />
          <Route path="rooms/:roomId" element={<RoomPage />} />
          {/* a thread of a room (beside it on computers, over it on phones; a room notice of a reply links here) */}
          <Route path="rooms/:roomId/t/:messageId" element={<RoomPage />} />
          <Route path="activity" element={<Activity key={`${status.me.user.id}:${status.me.session.id}`} />} />
          <Route path="files" element={<NotForGuests><Files /></NotForGuests>} />
          <Route path="files/view" element={<NotForGuests><FileView /></NotForGuests>} />
          {/* a guest in a room has no projects: their room instead of an empty list (components/GuestView.tsx) */}
          <Route path="projects" element={<NotForRoomGuests><ProjectList /></NotForRoomGuests>} />
          <Route path="projects/:projectId" element={<ProjectHome />} />
          <Route path="projects/:projectId/files" element={<ProjectFiles />} />
          <Route path="admin" element={<NotForGuests><AdminLayout /></NotForGuests>} />
          <Route path="admin/:section" element={<NotForGuests><AdminLayout /></NotForGuests>} />
          {/* a group of Team settings, its own page on a phone (pages/admin/teamSettingsGroups.ts) */}
          <Route path="admin/:section/:sub" element={<NotForGuests><AdminLayout /></NotForGuests>} />
          {/* a team connection's page in Admin › Connectors (/admin/connectors/mcp/<id>) */}
          <Route path="admin/:section/:sub/:item" element={<NotForGuests><AdminLayout /></NotForGuests>} />
          <Route path="trash" element={<Trash />} />
          <Route path="skills" element={<NotForGuests><Skills /></NotForGuests>} />
          {/* a share proposal of the owner's or admin's own (내 스킬 가져오기): the Claude Code notice leads here */}
          <Route path="skills/share/:id" element={<NotForGuests><SkillSharePage /></NotForGuests>} />
          <Route path="scheduled" element={<NotForGuests><ScheduledList /></NotForGuests>} />
          <Route path="scheduled/:id" element={<NotForGuests><ScheduledTask /></NotForGuests>} />
          {/* the welcome steps after /setup (owner only; pages/Welcome.tsx) */}
          <Route path="welcome" element={<NotForGuests><Welcome /></NotForGuests>} />
          {/* an outside AI app asks to use this server as the person (Connectors itself is in Settings, below) */}
          <Route path="connectors/authorize" element={<ConnectorConsent key={`${status.me.user.id}:${status.me.session.id}`} />} />
          {/* the one-time link from Slack (docs/SLACK.md): signed out, the sign-in comes back here with it */}
          <Route path="slack/link" element={<NotForGuests><SlackLink key={`${status.me.user.id}:${status.me.session.id}`} /></NotForGuests>} />
          {/* "Sign in with Slack" back in a browser that had to sign in first, and its end page outside the app */}
          <Route path="slack/signin-return" element={<SlackSignInReturn />} />
          <Route path="slack/done" element={<SlackDone signedIn />} />
          {/* an unknown address: say so (with a way home) instead of opening Home without a word */}
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route path="/login" element={<AfterSignIn />} />
        {/* right after making the team: the welcome steps (lib/welcome.ts), else Home */}
        <Route path="/setup" element={<AfterSetup />} />
        {/* right after the forced password change: where a sign-in lands (a phone: the 대화 list) */}
        <Route path="/password" element={<AfterSignIn />} />
        {/* an invite opened while someone is signed in: say who, offer to sign out and accept it (QA TC-134, TC-174) */}
        <Route path="/invite/:token" element={<InviteWhileSignedIn />} />
        {/* right after joining with the team link: the skill it names, else Home */}
        <Route path="/join" element={<AfterJoin />} />
        {/* a reset link opened while someone is signed in (a shared computer): using it signs that person in instead */}
        <Route path="/reset-password/:token" element={<ResetPassword />} />
      </Routes>
      </div>
      </RealPath.Provider>
      {settings.open && (
        <Routes>
          {/* scheduled tasks have their own page (/scheduled): old links (banners, notifications, bookmarks) go there */}
          <Route path="/settings/schedules" element={<Navigate to="/scheduled" replace />} />
          {/* the account deletion request, a page under the profile (components/settings/AccountDeletion.tsx) */}
          <Route path="/settings/account/delete" element={<SettingsDialog onClose={settings.close} page="account-delete" />} />
          {/* a phone's 보안·기기 opens the password form and every signed-in device as pages under it */}
          <Route path="/settings/security/password" element={<SettingsDialog onClose={settings.close} page="security-password" />} />
          <Route path="/settings/security/devices" element={<SettingsDialog onClose={settings.close} page="security-devices" />} />
          {/* Connectors (pages/Connectors.tsx) is a section: a connector's page and one of the person's connections are
              pages under it */}
          <Route path="/settings/connectors/mcp/:integrationId" element={<SettingsDialog onClose={settings.close} page="connector" />} />
          <Route path="/settings/connectors/:id" element={<SettingsDialog onClose={settings.close} page="connector" />} />
          {/* Connectors was a page of its own until 2026-11-12: its addresses (notices, Slack, mails, bookmarks) lead
              to the same place in Settings, with their query */}
          <Route path="/connectors/*" element={<OldConnectors />} />
          {/* an address under Settings that is none of these (/settings/a/b): the list, never an empty dialog-less page */}
          <Route path="*" element={<Navigate to="/settings" replace />} />
          <Route path="/settings/:tab?" element={<SettingsDialog onClose={settings.close} />} />
        </Routes>
      )}
    </Suspense>
    </ChunkErrorBoundary>
  )
}

export default function App() {
  return (
    // the browser's history as React Router keeps it; on a phone, each tab's stack of screens (lib/screenHistory.ts)
    <HistoryRouter history={screenHistory()}>
      <AnnounceProvider>
        <Gate />
        <DialogHost />
        <RoomAppsHost />
        <ShareChatHost />
        <ChatShareHost />
        <WideningDraftHost />
        <StatusDialogHost />
        <ImageViewerHost />
        <Toaster />
      </AnnounceProvider>
    </HistoryRouter>
  )
}

/** Signed in while on /join: the page the team link sent the new member to (lib/team-link.ts), else Home. A team link
 * opened while already signed in (nothing was joined here): Home, saying "You're already in {team}" (docs/DECISIONS.md
 * "A welcome for invited people"; single-use invites have their own page, InviteWhileSignedIn). */
export function AfterJoin() {
  const t = useT()
  const team = useSession((s) => (s.status.kind === 'signed-in' ? s.status.me.team.name : ''))
  const [target] = useState(() => ({ to: afterJoinTarget(), joined: afterJoinSet(), token: readJoinToken(window.location).token }))
  const signOutToJoin = useLogoutTo()
  const told = useRef(false)
  useEffect(() => {
    if (!target.joined && team && !told.current) {
      told.current = true
      // a shared computer: the next person can sign this one out and come back to the same link (the link is in the address only here)
      const token = target.token
      toast({
        level: 'info', text: t('teamLink.alreadyIn', { team }), ms: 15000,
        action: token ? { label: t('teamLink.signOutToJoin'), run: () => void signOutToJoin(`/join#t=${token}`) } : undefined,
      })
    }
    return () => clearAfterJoin()
    // once, on arriving
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <Navigate to={target.to} replace />
}

/** Signed in while on /setup: the welcome steps right after the team was made (lib/welcome.ts), else Home. */
export function AfterSetup() {
  useEffect(() => () => clearAfterSetup(), [])
  return <Navigate to={afterSetupTarget()} replace />
}

/** /connectors, /connectors/<id>, /connectors/mcp/<id>: the same place in Settings, its query and hash kept. */
function OldConnectors() {
  const { pathname, search, hash } = useLocation()
  return <Navigate to={oldConnectorsTarget(pathname, search, hash)} replace />
}

/** An address the app does not know (a wrong or old link): a clear message and a link to Home, inside the normal layout. */
function NotFound() {
  const t = useT()
  return (
    // the layout already has the <main> landmark; the page heading is an h1 like on other pages
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center" data-testid="not-found">
      <h1 className="text-display font-semibold text-balance text-ink">{t('notFound.title')}</h1>
      <p className="max-w-md text-sm text-balance text-muted">{t('notFound.hint')}</p>
      <Link to="/" className="mt-3 text-sm font-medium text-accent-text underline max-md:inline-flex max-md:min-h-11 max-md:items-center max-md:px-3">
        {t('notFound.home')}
      </Link>
    </div>
  )
}

/** Signed in while on /login (or /password): go where the person was heading (?next=, same-site paths only); otherwise
 * Home, or on a phone the 대화 list (signedInHome); a guest, their one place (components/GuestView.tsx GuestLanding). */
function AfterSignIn() {
  const next = safeNext(useLocation().search)
  const guest = isGuestMe(useMe())
  // no ?next: a landing (lib/welcome.ts LANDING_STATE), where an owner with unfinished welcome steps goes to them
  if (next) return <Navigate to={next} replace />
  if (guest) return <GuestLanding />
  return <Navigate to={signedInHome()} state={LANDING_STATE} replace />
}
