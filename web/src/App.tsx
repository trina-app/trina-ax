// Routes and the sign-in gate: first-run setup → /setup, signed out → /login (invite links still open),
// must change password → /password, otherwise the app with its WebSocket running.
import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import { errorText } from './lib/api'
import { useLocale, useT } from './i18n'
import { useChats } from './store/chats'
import { startLive, stopLive } from './store/live'
import { useSession } from './store/session'
import Layout from './components/Layout'
import { AnnounceProvider, Button, DialogHost, Spinner, Toaster } from './components/ui'
import { AcceptInvite, ForcedPassword, Login, Setup } from './pages/Auth'
import Home from './pages/Home'

const ChatPage = lazy(() => import('./pages/Chat'))
const Files = lazy(() => import('./pages/Files'))
const ProjectList = lazy(() => import('./pages/Projects').then((m) => ({ default: m.ProjectList })))
const ProjectHome = lazy(() => import('./pages/Projects').then((m) => ({ default: m.ProjectHome })))
const Settings = lazy(() => import('./pages/Settings'))
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'))
const Trash = lazy(() => import('./pages/Trash'))

function Splash() {
  const t = useT()
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner label={t('common.loading')} />
    </div>
  )
}

function Gate() {
  const t = useT()
  const locale = useLocale()
  const status = useSession((s) => s.status)
  const load = useSession((s) => s.load)
  const location = useLocation()

  useEffect(() => {
    void load()
  }, [load])

  const signedIn = status.kind === 'signed-in' && !status.me.user.mustChangePassword
  useEffect(() => {
    if (signedIn) startLive()
    else {
      stopLive()
      if (status.kind !== 'loading') useChats.getState().reset()
    }
  }, [signedIn, status.kind])

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
    <Suspense fallback={<Splash />}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="c/:chatId" element={<ChatPage />} />
          <Route path="files" element={<Files />} />
          <Route path="projects" element={<ProjectList />} />
          <Route path="projects/:projectId" element={<ProjectHome />} />
          <Route path="settings" element={<Settings />} />
          <Route path="settings/:tab" element={<Settings />} />
          <Route path="admin" element={<AdminLayout />} />
          <Route path="admin/:section" element={<AdminLayout />} />
          <Route path="trash" element={<Trash />} />
        </Route>
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/setup" element={<Navigate to="/" replace />} />
        <Route path="/password" element={<Navigate to="/" replace />} />
        <Route path="/invite/:token" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
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
