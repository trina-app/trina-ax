// Routes and the sign-in gate: first-run setup → /setup, signed out → /login (invite links still open),
// must change password → /password, otherwise the app with its WebSocket running.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useNavigationType, type Location } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import { errorText } from './lib/api'
import { useLocale, useT } from './i18n'
import { useChats } from './store/chats'
import { useSendQueue } from './store/sendQueue'
import { useProjects } from './store/projects'
import { startLive, stopLive } from './store/live'
import { useSession } from './store/session'
import Layout from './components/Layout'
import { ChunkErrorBoundary } from './components/ChunkErrorBoundary'
import { AnnounceProvider, Button, DialogHost, Spinner, Toaster } from './components/ui'
import { AcceptInvite, ForcedPassword, Login, ResetPassword, Setup } from './pages/Auth'
import Home from './pages/Home'
import SettingsDialog from './components/settings/SettingsDialog'
import { RealPath } from './lib/realPath'

const ChatPage = lazy(() => import('./pages/Chat'))
const Files = lazy(() => import('./pages/Files'))
const FileView = lazy(() => import('./pages/FileView'))
const ProjectList = lazy(() => import('./pages/Projects').then((m) => ({ default: m.ProjectList })))
const ProjectHome = lazy(() => import('./pages/Projects').then((m) => ({ default: m.ProjectHome })))
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'))
const Trash = lazy(() => import('./pages/Trash'))
const Skills = lazy(() => import('./pages/Skills'))
const ConnectorConsent = lazy(() => import('./pages/ConnectorConsent'))

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
  if (status.kind === 'error')
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="font-medium">{t('conn.cantReach')}</p>
        <p className="max-w-md text-sm text-muted">{errorText(status.error, locale, t('conn.cantReachHint'))}</p>
        <Button onClick={() => void load()}>{t('common.retry')}</Button>
      </div>
    )
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
          <Route path="connectors/authorize" element={<ConnectorConsent key={`${status.me.user.id}:${status.me.session.id}`} />} />
        </Route>
        <Route path="/login" element={<AfterSignIn />} />
        <Route path="/setup" element={<Navigate to="/" replace />} />
        <Route path="/password" element={<Navigate to="/" replace />} />
        <Route path="/invite/:token" element={<Navigate to="/" replace />} />
        {/* a reset link opened while someone is signed in (a shared computer): using it signs that person in instead */}
        <Route path="/reset-password/:token" element={<ResetPassword />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </div>
      </RealPath.Provider>
      {settings.open && (
        <Routes>
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

/** Signed in while on /login: go where the person was heading (?next=, same-site paths only). */
function AfterSignIn() {
  const location = useLocation()
  const next = new URLSearchParams(location.search).get('next')
  return <Navigate to={next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/'} replace />
}
