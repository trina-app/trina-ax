import { StrictMode } from 'react'
import { setOwnFolderWord } from '@mycel/shared'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initPwa } from './lib/pwa'
import { followVisualViewport } from './lib/viewport'
import { holdPageZoom } from './lib/pageZoom'
import { applyTheme, storedTheme, watchSystemTheme } from './lib/theme'
import { applyTextSize, storedTextSize } from './lib/textSize'
import { useLocaleStore, t } from './i18n'
import { initMobile, MobileFileTooLarge, setMobileSession } from './lib/mobile'
import { useSession } from './store/session'
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
initPwa()
followVisualViewport()
// the phone app and the installed app: no zoom of the whole page (a picture viewer zooms on its own)
holdPageZoom()
// a file dropped where nothing takes it is not opened in place of the app
guardFileDrops(window)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
