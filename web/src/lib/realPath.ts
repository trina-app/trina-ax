// The address in the browser bar and how it was reached. Under the Settings dialog the app renders the page it was
// opened from (App.tsx useSettingsOverlay) through <Routes location>, so useLocation() there is that page and
// useNavigationType() is always POP; what must know the real ones reads them here.
import { createContext, useContext } from 'react'
import { useLocation, useNavigationType, type NavigationType } from 'react-router-dom'

export const RealPath = createContext<{ pathname: string; navigationType: NavigationType } | null>(null)

export function useRealPath() {
  const fallback = useLocation().pathname
  return useContext(RealPath)?.pathname ?? fallback
}

export function useRealNavigationType() {
  const fallback = useNavigationType()
  return useContext(RealPath)?.navigationType ?? fallback
}
