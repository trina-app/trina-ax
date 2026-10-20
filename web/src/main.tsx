import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initPwa } from './lib/pwa'
import { followVisualViewport } from './lib/viewport'
import { applyTheme, storedTheme, watchSystemTheme } from './lib/theme'
import { useLocaleStore } from './i18n'
import './index.css'

applyTheme(storedTheme())
watchSystemTheme()
document.documentElement.lang = useLocaleStore.getState().locale
initPwa()
followVisualViewport()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
