// App frame: sidebar (drawer on phones), the page, and the right-hand panel (artifact / file preview / browser),
// which is a full-screen sheet below 768 px. Also: connection banner, keyboard shortcuts, the new-version reload.
import clsx from 'clsx'
import { ShieldAlert, WifiOff, RefreshCw } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import { mayReloadNow } from '../lib/reload-guard'
import { setNavigator } from '../lib/nav'
import { closeSidePanel, keepsFilePanel, openArtifact, setSidePanel, typingOnPhone, useSidePanel } from '../lib/sidePanel'
import { useT } from '../i18n'
import { useChats } from '../store/chats'
import { useMe } from '../store/session'
import { useAttention } from '../store/sessionMarkers'
import { useUi } from '../store/ui'
import OfficeUpdateBanner from './OfficeUpdateBanner'
import ManagedNoticesBanner from './ManagedNoticesBanner'
import ScheduleReviewBanner from './ScheduleReviewBanner'
import SearchDialog from './SearchDialog'
import Sidebar from './Sidebar'
import { BottomTabs } from './BottomTabs'
import { PhoneTopBar } from './PhoneTopBar'
import { PhonePushAsk } from './settings/PushNotifications'
import { WebPushAsk } from './WebPushAsk'
import { useRoomsSync } from './rooms/useRoomsSync'
import { ChunkErrorBoundary } from './ChunkErrorBoundary'
import { DemoBar, useDemoInfo } from './demo/Demo'
import { Spinner } from './ui'

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
  // the team chat rooms: the list (sidebar group, the phone tab's count) stays loaded while the app is open
  useRoomsSync()

  // banners raised by the server (e.g. a changed team skill) open app addresses through the router
  useEffect(() => {
    setNavigator((to) => navigate(to))
    return () => setNavigator(null)
  }, [navigate])

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

  // the AI started writing an artifact in the chat on screen, or saved an intro deck, a promo video or a card news: open
  // it (Claude parity). A new chat's first answer (the welcome steps' intro deck) can start before its page is on
  // screen (the chat page loads lazily and the route changes in a transition), so the request waits for the chat to
  // show and is used once; moving to another chat drops it. Checking only when the event arrived lost it on slower
  // machines (e2e on a 2-vCPU Linux server). On a phone the panel is a full-screen sheet (closed by its ✕ or Esc): it
  // never covers a draft being written; the card under the answer opens it.
  useEffect(() => {
    if (!autoOpen) return
    if (location.pathname === `/c/${autoOpen.chatId}`) {
      if (!typingOnPhone()) openArtifact(autoOpen.chatId, autoOpen.key)
      useChats.setState({ autoOpen: null })
    } else if (location.pathname.startsWith('/c/')) useChats.setState({ autoOpen: null })
  }, [autoOpen, location.pathname])

  // a file panel belongs to the page it was opened on (fileFrom: that page's address)
  const fileFrom = useRef<{ key: number; path: string } | null>(null)
  useEffect(() => {
    if (panel?.kind !== 'file') fileFrom.current = null
    else if (fileFrom.current?.key !== panel.key) fileFrom.current = { key: panel.key, path: location.pathname }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel])

  // a chat's artifact panel doesn't belong to another chat; a file panel stays only on its own page, on the Files page
  // (open in folder, a file link) and in the chat a new-chat page's first message opens: not in another or a new chat
  useEffect(() => {
    if (panel?.kind === 'artifact' && location.pathname !== `/c/${panel.chatId}`) setSidePanel(null)
    const from = fileFrom.current
    if (panel?.kind === 'file' && from && from.path !== location.pathname) {
      if (keepsFilePanel(from.path, location.pathname)) from.path = location.pathname
      else setSidePanel(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  useEffect(() => setDrawer(false), [location.pathname, setDrawer])

  // the app is exactly the window: only the areas inside it scroll (index.css html.app-shell)
  useEffect(() => {
    document.documentElement.classList.add('app-shell')
    return () => document.documentElement.classList.remove('app-shell')
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <a href="#main" className="sr-only-focusable absolute top-2 left-2 z-[70] rounded bg-surface px-3 py-2 text-sm shadow">
        {t('a11y.skip')}
      </a>
      <DemoOrDevBanner />
      <ConnectionBanner />
      <OfficeUpdateBanner />
      <ManagedNoticesBanner />
      <ScheduleReviewBanner />
      <div className="flex min-h-0 flex-1">
        {/* sidebar: fixed column on wide screens, drawer below md. 280px at the default text size; it grows with a larger
            one (Settings > Profile > 글자 크기) so its rows keep their words, up to 40% of a narrow window */}
        <div className="hidden w-[min(17.5rem,40vw)] shrink-0 border-r border-line md:block">
          <Sidebar />
        </div>
        {drawer && (
          <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label={t('sidebar.label')} data-drawer>
            <div className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
            <div className="absolute inset-y-0 left-0 w-[84vw] max-w-xs bg-subtle pt-[var(--safe-top)] pb-[var(--safe-bottom)] shadow-xl">
              <Sidebar />
            </div>
          </div>
        )}
        <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col">
          {/* a web browser not asked about notifications yet: one line, here on a computer (components/WebPushAsk.tsx) */}
          <WebPushAsk at="top" />
          {/* phones: where you are and one action at most (components/PhoneTopBar.tsx); not in a room or an AI chat */}
          <PhoneTopBar />
          <div className="min-h-0 flex-1">
            {/* a page that cannot be loaded after a server update: here, with the sidebar still there (another page resets it) */}
            <ChunkErrorBoundary resetKey={location.pathname}>
              <Outlet />
            </ChunkErrorBoundary>
          </div>
          {/* the phone app's own question before the OS prompt (only while the OS has not been asked); a phone browser's
              line, above the tab bar */}
          <PhonePushAsk />
          <WebPushAsk at="bottom" />
          {/* phones: 트리나 · 대화 · 파일 · 나 (gone inside a room or an AI chat, whose message box needs the bottom) */}
          <BottomTabs />
        </main>
        {panel && (
          <div
            className={clsx(
              'min-w-0 border-line bg-surface md:border-l',
              // phones: a full-screen sheet over everything (no edge of its own)
              'max-md:fixed max-md:inset-0 max-md:z-40 max-md:pt-[var(--safe-top)] max-md:pb-[var(--safe-bottom)]',
              'md:w-[46%] md:max-w-[880px] md:min-w-[360px]',
            )}
          >
            <ChunkErrorBoundary resetKey={panel.kind === 'file' ? `file:${panel.key}` : panel.kind === 'artifact' ? `artifact:${panel.chatId}:${panel.artifactKey}:${panel.versionId ?? ''}` : panel.kind}>
              <Suspense fallback={<Spinner className="p-6" />}>
                {panel.kind === 'artifact' && <ArtifactPanel chatId={panel.chatId} artifactKey={panel.artifactKey} versionId={panel.versionId} onClose={closeSidePanel} />}
                {panel.kind === 'file' && <FilePanel key={panel.key} file={panel.file} onClose={closeSidePanel} />}
                {panel.kind === 'browser' && <BrowserPanel onClose={closeSidePanel} />}
              </Suspense>
            </ChunkErrorBoundary>
          </div>
        )}
      </div>
      <SearchDialog />
      <UpdateWatcher />
      <AttentionTitle />
    </div>
  )
}

/** A demo server (`bun run demo:company`) shows the demo bar instead of the development-mode banner: one strip, and the
 * banner's words are in the bar's sheet (components/demo/Demo.tsx). */
function DemoOrDevBanner() {
  const { info } = useDemoInfo()
  return info ? <DemoBar /> : <DevModeBanner />
}

/**
 * Tab 5 "개발 모드 배너": a server in DEV mode runs the engines as the signed-in Mac user, without the engine account,
 * firewall or sandbox. Everyone sees it on every screen and it cannot be closed.
 */
function DevModeBanner() {
  const t = useT()
  const dev = useMe()?.server.dev
  if (!dev) return null
  return (
    <div role="note" className="flex items-center justify-center gap-2 bg-warn-soft px-3 py-1 text-center text-xs font-medium text-warn" data-testid="dev-banner">
      <ShieldAlert size={14} className="shrink-0" aria-hidden />
      {t('dev.banner')}
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

/**
 * Session markers (docs/DECISIONS.md "Session markers"): while the tab is hidden its title starts with "(n) ", n = the
 * AI chats showing "?" or a new answer and the rooms that want me, each once (store/sessionMarkers.ts): the same number
 * as the dock badge. It counts chats and rooms, not events.
 */
export function AttentionTitle() {
  const { n: count } = useAttention()
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden)
  useEffect(() => {
    const h = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', h)
    return () => document.removeEventListener('visibilitychange', h)
  }, [])
  const n = hidden ? count : 0
  useEffect(() => {
    document.title = n > 0 ? `(${n}) ${PRODUCT.displayName}` : PRODUCT.displayName
  }, [n])
  return null
}

/** After the server reports a new version: reload by itself once nothing would be lost and the server can be reached
 * (lib/reload-guard.ts; checked every 60 s). */
function UpdateWatcher() {
  const ready = useUi((s) => s.updateReady)
  useEffect(() => {
    if (!ready) return
    const timer = setInterval(() => {
      if (mayReloadNow()) location.reload()
    }, 60_000)
    return () => clearInterval(timer)
  }, [ready])
  return null
}
