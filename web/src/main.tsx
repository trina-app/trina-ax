import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initPwa } from './lib/pwa'
import { followVisualViewport } from './lib/viewport'
import { applyTheme, storedTheme, watchSystemTheme } from './lib/theme'
import { useLocaleStore, t } from './i18n'
import { initMobile, MobileFileTooLarge, setMobileSession } from './lib/mobile'
import { useSession } from './store/session'
import { toast } from './store/ui'
import { setPushSession } from './lib/push'
import './index.css'
import './theme.edition.css'

applyTheme(storedTheme())
watchSystemTheme()
document.documentElement.lang = useLocaleStore.getState().locale
initMobile(error => toast({ level: 'error', text: t(error instanceof MobileFileTooLarge ? 'mobile.fileTooLarge' : 'mobile.saveFailed') }))
useSession.subscribe(state => {
  const status = state.status
  setMobileSession(status.kind === 'signed-in' ? `${status.me.user.id}:${status.me.session.id}` : null)
  setPushSession(status.kind === 'signed-in' ? `${status.me.user.id}:${status.me.session.id}` : null)
})
initPwa()
followVisualViewport()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
