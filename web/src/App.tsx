// Routes and the sign-in gate: first-run setup → /setup, signed out → /login (invite links still open),
// must change password → /password, otherwise the app with its WebSocket running.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate, useNavigationType, type Location } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import { ApiError, errorText } from './lib/api'
import { useLocale, useT } from './i18n'
import { useChats } from './store/chats'
import { useDeckBuilds } from './store/deckBuilds'
import { useSendQueue } from './store/sendQueue'
import { useProjects } from './store/projects'
import { useAiAccess } from './store/aiAccess'
import { useWelcome } from './store/welcome'
import { useHandover } from './store/handover'
import { useRooms } from './store/rooms'
import { usePeople } from './store/people'
import { startLive, stopLive } from './store/live'
import { useEngines } from './store/engines'
import { resetInbox } from './store/inbox'
import { useJobs } from './store/jobs'
import { useSessionMarkers } from './store/sessionMarkers'
import { setBeforePersonSwitch, useSession } from './store/session'
import { clearLocalData } from './lib/localData'
import { forgetStepsSeen } from './lib/welcome'
import Layout from './components/Layout'
import { ChunkErrorBoundary } from './components/ChunkErrorBoundary'
import { AnnounceProvider, Button, DialogHost, Spinner, Toaster } from './components/ui'
import { StatusDialogHost } from './components/StatusMessage'
import { AcceptInvite, ForcedPassword, InviteWhileSignedIn, Login, ResetPassword, Setup, signedInHome, TeamJoin } from './pages/Auth'
import Home from './pages/Home'
import SettingsDialog from './components/settings/SettingsDialog'
import { ImageViewerHost } from './components/ImageViewer'
import { RealPath } from './lib/realPath'
import { noteLocation } from './lib/backStack'
import { safeNext } from './lib/nav'
import { afterJoinTarget, clearAfterJoin, readJoinToken } from './lib/team-link'
import { afterSetupTarget, clearAfterSetup, LANDING_STATE } from './lib/welcome'

const ChatPage = lazy(() => import('./pages/Chat'))
const Files = lazy(() => import('./pages/Files'))
const FileView = lazy(() => import('./pages/FileView'))
const ProjectList = lazy(() => import('./pages/Projects').then((m) => ({ default: m.ProjectList })))
const ProjectHome = lazy(() => import('./pages/Projects').then((m) => ({ default: m.ProjectHome })))
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'))
const Trash = lazy(() => import('./pages/Trash'))
const Skills = lazy(() => import('./pages/Skills'))
const SkillSharePage = lazy(() => import('./pages/SkillSharePage'))
const ScheduledList = lazy(() => import('./pages/Scheduled').then((m) => ({ default: m.ScheduledList })))
const ScheduledTask = lazy(() => import('./pages/Scheduled').then((m) => ({ default: m.ScheduledTask })))
const ConnectorConsent = lazy(() => import('./pages/ConnectorConsent'))
const ConnectorsLayout = lazy(() => import('./pages/Connectors').then((m) => ({ default: m.ConnectorsLayout })))
const ConnectorsHome = lazy(() => import('./pages/Connectors').then((m) => ({ default: m.ConnectorsHome })))
const ConnectorPage = lazy(() => import('./pages/Connectors').then((m) => ({ default: m.ConnectorPage })))
const CustomConnectorPage = lazy(() => import('./pages/Connectors').then((m) => ({ default: m.CustomConnectorPage })))
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

const isSettings = (path: string) => path === '/settings' || path.startsWith('/settings/')

/** Settings is a dialog over a page (components/settings/SettingsDialog.tsx): the page it was opened from, or Home when
 * its address was opened directly. `close` goes back to that page: back through the history entries Settings added on
 * top of it, or straight to it when there are none. */
function useSettingsOverlay() {
  const location = useLocation()
  const navType = useNavigationType()
  const navigate = useNavigate()
  const page = useRef<Location | null>(null)
  const depth = useRef(0)
  const open = isSettings(location.pathname)
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
  const under: Location = open ? (page.current ?? { pathname: '/', search: '', hash: '', state: null, key: 'settings-home' }) : location
  const close = useCallback(() => {
    const back = page.current
    if (depth.current > 0 && back) navigate(-depth.current)
    else navigate(back ? `${back.pathname}${back.search}${back.hash}` : '/', { replace: true })
  }, [navigate])
  const real = useMemo(() => ({ pathname: location.pathname, navigationType: navType }), [location.pathname, navType])
  return { open, under, close, real }
}

/** Everything one person's window keeps in memory of their own: chats, the messages waiting to be sent, the projects
 * seen, rooms (and their side chats), people, the AI engine picker's list, the unread Inbox count, job cards and the
 * chat counted as on screen. */
function dropPersonStores() {
  useChats.getState().reset()
  useDeckBuilds.getState().reset()
  useSendQueue.getState().reset()
  useProjects.getState().reset()
  useAiAccess.getState().reset()
  useWelcome.getState().reset()
  useHandover.getState().reset()
  useRooms.getState().reset()
  usePeople.getState().reset()
  useEngines.getState().reset()
  resetInbox()
  useJobs.getState().reset()
  useSessionMarkers.getState().reset()
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

function Gate() {
  const t = useT()
  const locale = useLocale()
  const status = useSession((s) => s.status)
  const load = useSession((s) => s.load)
  const location = useLocation()
  const settings = useSettingsOverlay()

  useEffect(() => {
    void load()
  }, [load])

  useSessionLifecycle()

  useEffect(() => {
    document.title = PRODUCT.displayName
  }, [])

  if (status.kind === 'loading') return <Splash />
  if (status.kind === 'error') {
    // The plain hint always shows; the server's own words and the HTTP status are a small detail under it
    const hint = t('conn.cantReachHint')
    const text = errorText(status.error, locale, hint)
    const detail = [text !== hint ? text : null, status.error instanceof ApiError ? `HTTP ${status.error.status}` : null].filter(Boolean).join(' · ')
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-canvas p-6 text-center" data-testid="cant-reach">
        <p className="mb-3 flex items-center justify-center gap-2 text-xl font-semibold tracking-tight">
          <img src="/favicon.svg" alt="" aria-hidden className="size-7 rounded-lg" />
          {PRODUCT.displayName}
        </p>
        <p className="font-medium">{t('conn.cantReach')}</p>
        <p className="max-w-md text-sm text-balance text-muted">{hint}</p>
        {detail && <p className="max-w-md text-xs text-faint">{detail}</p>}
        <Button onClick={() => void load()}>{t('common.retry')}</Button>
      </div>
    )
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
      <Routes location={settings.under}>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="c/:chatId" element={<ChatPage />} />
          {/* the team chat rooms: the list (the 대화 tab on phones) and one room (the mobile app links here) */}
          <Route path="rooms" element={<Rooms />} />
          <Route path="rooms/:roomId" element={<RoomPage />} />
          {/* a thread of a room (beside it on computers, over it on phones; a room notice of a reply links here) */}
          <Route path="rooms/:roomId/t/:messageId" element={<RoomPage />} />
          <Route path="activity" element={<Activity key={`${status.me.user.id}:${status.me.session.id}`} />} />
          <Route path="files" element={<Files />} />
          <Route path="files/view" element={<FileView />} />
          <Route path="projects" element={<ProjectList />} />
          <Route path="projects/:projectId" element={<ProjectHome />} />
          <Route path="admin" element={<AdminLayout />} />
          <Route path="admin/:section" element={<AdminLayout />} />
          {/* a group of Team settings, its own page on a phone (pages/admin/teamSettingsGroups.ts) */}
          <Route path="admin/:section/:sub" element={<AdminLayout />} />
          <Route path="trash" element={<Trash />} />
          <Route path="skills" element={<Skills />} />
          {/* a share proposal of the owner's or admin's own (내 스킬 가져오기): the Claude Code notice leads here */}
          <Route path="skills/share/:id" element={<SkillSharePage />} />
          <Route path="scheduled" element={<ScheduledList />} />
          <Route path="scheduled/:id" element={<ScheduledTask />} />
          {/* the welcome steps after /setup (owner only; pages/Welcome.tsx) */}
          <Route path="welcome" element={<Welcome />} />
          <Route path="connectors/authorize" element={<ConnectorConsent key={`${status.me.user.id}:${status.me.session.id}`} />} />
          {/* Connectors, from the sidebar (pages/Connectors.tsx): the list, a built-in or listed service's page, one of
              the person's own connections; Settings › Connectors leads here */}
          <Route path="connectors" element={<ConnectorsLayout key={`${status.me.user.id}:${status.me.session.id}`} />}>
            <Route index element={<ConnectorsHome />} />
            <Route path="mcp/:integrationId" element={<CustomConnectorPage />} />
            <Route path=":id" element={<ConnectorPage />} />
          </Route>
          {/* the one-time link from Slack (docs/SLACK.md): signed out, the sign-in comes back here with it */}
          <Route path="slack/link" element={<SlackLink key={`${status.me.user.id}:${status.me.session.id}`} />} />
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
          {/* scheduled tasks moved to the sidebar: old links (banners, notifications, bookmarks) go there */}
          <Route path="/settings/schedules" element={<Navigate to="/scheduled" replace />} />
          {/* the account deletion request, a page under the profile (components/settings/AccountDeletion.tsx) */}
          <Route path="/settings/account/delete" element={<SettingsDialog onClose={settings.close} page="account-delete" />} />
          <Route path="/settings/:tab?" element={<SettingsDialog onClose={settings.close} />} />
        </Routes>
      )}
    </Suspense>
    </ChunkErrorBoundary>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AnnounceProvider>
        <Gate />
        <DialogHost />
        <StatusDialogHost />
        <ImageViewerHost />
        <Toaster />
      </AnnounceProvider>
    </BrowserRouter>
  )
}

/** Signed in while on /join: the page the team link sent the new member to (lib/team-link.ts), else Home. The join page
 * takes the link's token out of the address as soon as it opens, so a token still there (read once: the page below takes
 * it out too) is a team link opened while someone was signed in already: say who, and offer to sign out and join, as an
 * invite does (QA TC-200). */
export function AfterJoin() {
  const [opened] = useState(() => readJoinToken(window.location).cleanUrl !== null)
  useEffect(() => () => clearAfterJoin(), [])
  if (opened) return <InviteWhileSignedIn />
  return <Navigate to={afterJoinTarget()} replace />
}

/** Signed in while on /setup: the welcome steps right after the team was made (lib/welcome.ts), else Home. */
export function AfterSetup() {
  useEffect(() => () => clearAfterSetup(), [])
  return <Navigate to={afterSetupTarget()} replace />
}

/** An address the app does not know (a wrong or old link): a clear message and a link to Home, inside the normal layout. */
function NotFound() {
  const t = useT()
  return (
    // the layout already has the <main> landmark; the page heading is an h1 like on other pages
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center" data-testid="not-found">
      <h1 className="text-lg font-semibold text-balance text-ink">{t('notFound.title')}</h1>
      <p className="max-w-md text-sm text-balance text-muted">{t('notFound.hint')}</p>
      <Link to="/" className="mt-3 text-sm font-medium text-accent-text underline">
        {t('notFound.home')}
      </Link>
    </div>
  )
}

/** Signed in while on /login (or /password): go where the person was heading (?next=, same-site paths only); otherwise
 * Home, or on a phone the 대화 list (signedInHome). */
function AfterSignIn() {
  const next = safeNext(useLocation().search)
  // no ?next: a landing (lib/welcome.ts LANDING_STATE), where an owner with unfinished welcome steps goes to them
  if (next) return <Navigate to={next} replace />
  return <Navigate to={signedInHome()} state={LANDING_STATE} replace />
}
