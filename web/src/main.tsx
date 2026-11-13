import { StrictMode } from 'react'
import { setOwnFolderWord } from '@mycel/shared'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initPwa } from './lib/pwa'
import { followVisualViewport } from './lib/viewport'
import { holdPageZoom } from './lib/pageZoom'
import { applyTheme, storedTheme, watchSystemTheme } from './lib/theme'
import { applyTextSize, storedTextSize } from './lib/textSize'
import { loadLocale, localeChosen, localeLoaded, recentLocale, storedLocale, useLocaleStore, t } from './i18n'
import { initMobile, MobileFileTooLarge, setMobileSession } from './lib/mobile'
import { useSession } from './store/session'
import { useAiAccess } from './store/aiAccess'
import { loadChatList } from './lib/chatListLoad'
import { toast } from './store/ui'
import { setPushSession } from './lib/push'
import { setMobilePushSession } from './lib/mobile-push'
import { guardFileDrops } from './lib/fileDrop'
import './index.css'
import './theme.edition.css'

// the person's own folder is "내 파일" (파일's name for it; shared/src/folder-labels.ts), as the server's AI says too
setOwnFolderWord('files')
applyTheme(storedTheme())
applyTextSize(storedTextSize())
watchSystemTheme()
document.documentElement.lang = useLocaleStore.getState().locale
initMobile(error => toast({ level: 'error', text: t(error instanceof MobileFileTooLarge ? 'mobile.fileTooLarge' : 'mobile.saveFailed') }))
useSession.subscribe(state => {
  const status = state.status
  setMobileSession(status.kind === 'signed-in' ? `${status.me.user.id}:${status.me.session.id}` : null, status.kind === 'signed-out')
  setPushSession(status.kind === 'signed-in' ? `${status.me.user.id}:${status.me.session.id}` : null)
  setMobilePushSession(status.kind === 'signed-in' && !status.me.user.mustChangePassword ? `${status.me.user.id}:${status.me.session.id}` : null)
})
// the signed-in screen's first reads start the moment the session is known, not after its first render: the chat list
// (the rail's marks and the history) and AI access (the box's banner); the screens share these reads (lib/chatListLoad.ts,
// store/aiAccess.ts). Not while the password must be changed first: that screen shows nothing else.
let readsFor = ''
useSession.subscribe(({ status }) => {
  if (status.kind !== 'signed-in' || status.me.user.mustChangePassword) return
  const who = `${status.me.user.id}:${status.me.session.id}`
  if (who === readsFor) return
  readsFor = who
  void loadChatList().catch(() => {})
  void useAiAccess.getState().load()
})
initPwa()
followVisualViewport()
// the phone app and the installed app: no zoom of the whole page (a picture viewer zooms on its own)
holdPageZoom()
// a file dropped where nothing takes it is not opened in place of the app
guardFileDrops(window)
// what the old navigation remembered (its lists open or showing all): nothing reads it now
try { for (const k of ['mycel.sidebar.recents', 'mycel.sidebar.recentsAll', 'mycel.sidebar.rooms', 'mycel.sidebar.roomsAll']) localStorage.removeItem(k) } catch { /* storage blocked */ }

// First load (docs/DECISIONS.md "First load: compressed files, one language, formatting on demand"): who is signed in
// (GET /api/me) is asked at once, while the screen's language loads; the page draws once its words are here. With no
// language picked on this browser, the loading screen is in the one the last person here used (the recovery rule of
// i18n/recovery-locale.ts: shown only until the server says which language this screen has), so a returning person
// downloads one dictionary, not English and theirs. A language that cannot load (offline, a tab of an older build) does
// not stop the page: it draws in English, unless the session has picked another language meanwhile.
void useSession.getState().load()
const startLocale = storedLocale() ?? recentLocale() ?? useLocaleStore.getState().locale
void loadLocale(startLocale)
  .catch(() => {})
  .then(() => {
    // nothing chose the screen's language meanwhile (the session does once the server answers): this one
    if (!localeChosen() && localeLoaded(startLocale)) useLocaleStore.getState().setLocale(startLocale)
    // the language on screen, whatever set it, has its words before the first draw
    return loadLocale(useLocaleStore.getState().locale)
  })
  .catch(() => {
    useLocaleStore.getState().setLocale('en')
    return loadLocale('en')
  })
  .catch(() => {})
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })
