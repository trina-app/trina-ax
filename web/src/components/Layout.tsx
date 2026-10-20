// App frame: sidebar (drawer on phones), the page, and the right-hand panel (artifact / file preview / browser),
// which is a full-screen sheet below 768 px. Also: connection banner, keyboard shortcuts, the new-version reload.
import clsx from 'clsx'
import { Menu, MessageSquarePlus, WifiOff, RefreshCw } from 'lucide-react'
import { lazy, Suspense, useEffect } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import { isBusy } from '../lib/busy'
import { closeSidePanel, openArtifact, setSidePanel, useSidePanel } from '../lib/sidePanel'
import { useT } from '../i18n'
import { useChats } from '../store/chats'
import { useUi } from '../store/ui'
import SearchDialog from './SearchDialog'
import Sidebar from './Sidebar'
import { IconButton, Spinner } from './ui'

const ArtifactPanel = lazy(() => import('./ArtifactPanel'))
const FilePanel = lazy(() => import('./FilePanel'))
const BrowserPanel = lazy(() => import('./BrowserPanel'))

export default function Layout() {
  const t = useT()
  const drawer = useUi((s) => s.drawerOpen)
  const setDrawer = useUi((s) => s.setDrawer)
  const setSearchOpen = useUi((s) => s.setSearchOpen)
  const panel = useSidePanel()
  const navigate = useNavigate()
  const location = useLocation()
  const autoOpen = useChats((s) => s.autoOpen)

  // keyboard: ⌘/Ctrl+K search, ⌘/Ctrl+Shift+O new chat, Esc closes the side panel
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        navigate('/')
      } else if (e.key === 'Escape' && !document.querySelector('[role="dialog"]:not([data-drawer])')) {
        if (useUi.getState().drawerOpen) setDrawer(false)
        else closeSidePanel()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [navigate, setSearchOpen, setDrawer])

  // the AI started writing an artifact in the chat on screen: open it (Claude parity)
  useEffect(() => {
    if (!autoOpen) return
    if (location.pathname === `/c/${autoOpen.chatId}`) openArtifact(autoOpen.chatId, autoOpen.key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen])

  // a chat's artifact panel doesn't belong to another chat
  useEffect(() => {
    if (panel?.kind === 'artifact' && location.pathname !== `/c/${panel.chatId}`) setSidePanel(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  useEffect(() => setDrawer(false), [location.pathname, setDrawer])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <a href="#main" className="sr-only-focusable absolute top-2 left-2 z-[70] rounded bg-surface px-3 py-2 text-sm shadow">
        {t('a11y.skip')}
      </a>
      <ConnectionBanner />
      <div className="flex min-h-0 flex-1">
        {/* sidebar: fixed column on wide screens, drawer below md */}
        <div className="hidden w-64 shrink-0 border-r border-line md:block">
          <Sidebar />
        </div>
        {drawer && (
          <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label={t('sidebar.label')} data-drawer>
            <div className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
            <div className="absolute inset-y-0 left-0 w-[84vw] max-w-xs shadow-xl">
              <Sidebar />
            </div>
          </div>
        )}
        <main id="main" className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2 md:hidden">
            <IconButton label={t('sidebar.open')} onClick={() => setDrawer(true)}>
              <Menu size={20} />
            </IconButton>
            <span className="flex-1 truncate text-center text-sm font-semibold">{PRODUCT.displayName}</span>
            <IconButton label={t('sidebar.newChat')} onClick={() => navigate('/')}>
              <MessageSquarePlus size={20} />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1">
            <Outlet />
          </div>
        </main>
        {panel && (
          <div
            className={clsx(
              'min-w-0 border-l border-line bg-surface',
              // phones: a full-screen sheet over everything
              'max-md:fixed max-md:inset-0 max-md:z-40',
              'md:w-[46%] md:max-w-[880px] md:min-w-[360px]',
            )}
          >
            <Suspense fallback={<Spinner className="p-6" />}>
              {panel.kind === 'artifact' && <ArtifactPanel chatId={panel.chatId} artifactKey={panel.artifactKey} versionId={panel.versionId} onClose={closeSidePanel} />}
              {panel.kind === 'file' && <FilePanel key={panel.key} file={panel.file} onClose={closeSidePanel} />}
              {panel.kind === 'browser' && <BrowserPanel onClose={closeSidePanel} />}
            </Suspense>
          </div>
        )}
      </div>
      <SearchDialog />
      <UpdateWatcher />
    </div>
  )
}

/** "다시 연결 중" while the socket is down; after 30 s "팀 서버에 연결할 수 없음" (answers on screen stay). */
function ConnectionBanner() {
  const t = useT()
  const conn = useUi((s) => s.conn)
  if (conn !== 'reconnecting' && conn !== 'offline') return null
  const offline = conn === 'offline'
  return (
    <div role="status" className={clsx('flex items-center justify-center gap-2 px-3 py-1.5 text-center text-xs font-medium', offline ? 'bg-danger-soft text-danger' : 'bg-warn-soft text-warn')} data-testid="conn-banner">
      {offline ? <WifiOff size={14} aria-hidden /> : <RefreshCw size={14} className="animate-spin" aria-hidden />}
      {offline ? t('conn.offline') : t('conn.reconnecting')}
    </div>
  )
}

/** After the server reports a new version: reload by itself once nothing would be lost (checked every 60 s). */
function UpdateWatcher() {
  const ready = useUi((s) => s.updateReady)
  useEffect(() => {
    if (!ready) return
    const timer = setInterval(() => {
      const streaming = Object.values(useChats.getState().threads).some((th) => th.messages.some((m) => m.status === 'streaming' || m.local))
      if (!streaming && !isBusy()) location.reload()
    }, 60_000)
    return () => clearInterval(timer)
  }, [ready])
  return null
}
