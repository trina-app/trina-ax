// Signing out of this window: the session, this browser's own data, then the sign-in page. Used by the account menu
// (components/nav/AccountMenu.tsx) and, on a phone, the 나 tab's list (components/settings/SettingsDialog.tsx).
import { useNavigate } from 'react-router-dom'
import { api, API } from './api'
import { clearLocalData } from './localData'
import { forgetStepsSeen } from './welcome'
import { useSession } from '../store/session'
import { dropRoomUploads } from '../store/roomUploads'

/** Signs out, then opens `to`: the sign-in page by default, or (a team link, when someone signs out to join with it) the
 * page at that address, loaded afresh so nothing of the person who left stays in memory on a shared computer. */
export function useLogoutTo() {
  const signedOut = useSession((s) => s.signedOut)
  const navigate = useNavigate()
  return async (to?: string) => {
    // uploads still on their way in rooms stop here, while the session can still drop what the server holds of them
    await dropRoomUploads().catch(() => {})
    await api.call(API.logout).catch(() => {})
    clearLocalData()
    forgetStepsSeen()
    if (to) { window.location.assign(to); return }
    signedOut()
    navigate('/login')
  }
}

export function useLogout() {
  const out = useLogoutTo()
  return () => out()
}
