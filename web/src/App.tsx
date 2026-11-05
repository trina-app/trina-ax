// Routes and the sign-in gate: first-run setup → /setup, signed out → /login (invite links still open),
// must change password → /password, otherwise the app with its WebSocket running.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef } from 'react'
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate, useNavigationType, type Location } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import { ApiError, errorText } from './lib/api'
import { useLocale, useT } from './i18n'
import { useChats } from './store/chats'
import { useSendQueue } from './store/sendQueue'
import { useProjects } from './store/projects'
import { useAiAccess } from './store/aiAccess'
import { useWelcome } from './store/welcome'
import { startLive, stopLive } from './store/live'
import { useSession } from './store/session'
import Layout from './components/Layout'
import { ChunkErrorBoundary } from './components/ChunkErrorBoundary'
import { AnnounceProvider, Button, DialogHost, Spinner, Toaster } from './components/ui'
import { AcceptInvite, ForcedPassword, Login, ResetPassword, Setup, TeamJoin } from './pages/Auth'
import Home from './pages/Home'
import SettingsDialog from './components/settings/SettingsDialog'
import { RealPath } from './lib/realPath'
import { afterJoinTarget, clearAfterJoin } from './lib/team-link'
import { afterSetupTarget, clearAfterSetup } from './lib/welcome'

const ChatPage = lazy(() => import('./pages/Chat'))
const Files = lazy(() => import('./pages/Files'))
const FileView = lazy(() => import('./pages/FileView'))
const ProjectList = lazy(() => import('./pages/Projects').then((m) => ({ default: m.ProjectList })))
const ProjectHome = lazy(() => import('./pages/Projects').then((m) => ({ default: m.ProjectHome })))
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'))
const Trash = lazy(() => import('./pages/Trash'))
const Skills = lazy(() => import('./pages/Skills'))
const ScheduledList = lazy(() => import('./pages/Scheduled').then((m) => ({ default: m.ScheduledList })))
const ScheduledTask = lazy(() => import('./pages/Scheduled').then((m) => ({ default: m.ScheduledTask })))
const ConnectorConsent = lazy(() => import('./pages/ConnectorConsent'))
const Welcome = lazy(() => import('./pages/Welcome'))

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

/** The session's side effects (Gate): live updates while signed in; when signed out, nothing one person's window kept
 * stays for the next (chats, the messages waiting to be sent, the projects seen). Returns whether signed in. */
export function useSessionLifecycle(): boolean {
  const status = useSession((s) => s.status)
  const signedIn = status.kind === 'signed-in' && !status.me.user.mustChangePassword
  useEffect(() => {
    if (signedIn) startLive()
    else {
      stopLive()
      if (status.kind !== 'loading') {
        useChats.getState().reset()
        useSendQueue.getState().reset()
        useProjects.getState().reset()
        useAiAccess.getState().reset()
        useWelcome.getState().reset()
      }
    }
  }, [signedIn, status.kind])
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
        <Route path="*" element={<Navigate to={`/login${next}`} replace />} />
      </Routes>
    )
  }
  if (status.me.user.mustChangePassword)
    return (
      <Routes>
        <Route path="/password" element={<ForcedPassword />} />
        <Route path="*" element={<Navigate to="/password" replace />} />
      </Routes>
    )
  return (
    // a lazy route that is gone after a server update: reload once instead of a blank page (lib/chunk-reload.ts)
    <ChunkErrorBoundary>
    <Suspense fallback={<Splash />}>
      {/* under Settings: the page it was opened from (Settings itself is the dialog below), out of reach while it is open */}
      <RealPath.Provider value={settings.real}>
      <div className="h-full" inert={settings.open} aria-hidden={settings.open || undefined}>
      <Routes location={settings.under}>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="c/:chatId" element={<ChatPage />} />
          <Route path="files" element={<Files />} />
          <Route path="files/view" element={<FileView />} />
          <Route path="projects" element={<ProjectList />} />
          <Route path="projects/:projectId" element={<ProjectHome />} />
          <Route path="admin" element={<AdminLayout />} />
          <Route path="admin/:section" element={<AdminLayout />} />
          <Route path="trash" element={<Trash />} />
          <Route path="skills" element={<Skills />} />
          <Route path="scheduled" element={<ScheduledList />} />
          <Route path="scheduled/:id" element={<ScheduledTask />} />
          {/* the welcome steps after /setup (owner only; pages/Welcome.tsx) */}
          <Route path="welcome" element={<Welcome />} />
          <Route path="connectors/authorize" element={<ConnectorConsent key={`${status.me.user.id}:${status.me.session.id}`} />} />
          {/* an unknown address: say so (with a way home) instead of opening Home without a word */}
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route path="/login" element={<AfterSignIn />} />
        {/* right after making the team: the welcome steps (lib/welcome.ts), else Home */}
        <Route path="/setup" element={<AfterSetup />} />
        <Route path="/password" element={<Navigate to="/" replace />} />
        <Route path="/invite/:token" element={<Navigate to="/" replace />} />
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
        <Toaster />
      </AnnounceProvider>
    </BrowserRouter>
  )
}

/** Signed in while on /join: the page the team link sent the new member to (lib/team-link.ts), else Home. */
function AfterJoin() {
  useEffect(() => () => clearAfterJoin(), [])
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

/** Signed in while on /login: go where the person was heading (?next=, same-site paths only). */
function AfterSignIn() {
  const location = useLocation()
  const next = new URLSearchParams(location.search).get('next')
  return <Navigate to={next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/'} replace />
}
