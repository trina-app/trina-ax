// Signing out of this window: the session, this browser's own data, then the sign-in page. Used by the account menu
// (Sidebar.tsx) and, on a phone, the 나 tab's list (components/settings/SettingsDialog.tsx).
import { useNavigate } from 'react-router-dom'
import { api, API } from './api'
import { clearLocalData } from './localData'
import { forgetStepsSeen } from './welcome'
import { useSession } from '../store/session'

export function useLogout() {
  const signedOut = useSession((s) => s.signedOut)
  const navigate = useNavigate()
  return async () => {
    await api.call(API.logout).catch(() => {})
    clearLocalData()
    forgetStepsSeen()
    signedOut()
    navigate('/login')
  }
}
