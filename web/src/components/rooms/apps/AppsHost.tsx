// The apps dialog's place in the app (App.tsx, beside the other dialogs): its code loads the first time it opens
// (components/rooms/apps/AppsDialog.tsx), so the first visit does not download it.
import { lazy, Suspense } from 'react'
import { useRoomApps } from '../../../store/roomApps'

const AppsDialog = lazy(() => import('./AppsDialog').then((m) => ({ default: m.AppsDialog })))

export function RoomAppsHost() {
  const dialog = useRoomApps((s) => s.dialog)
  if (!dialog) return null
  return (
    <Suspense fallback={null}>
      <AppsDialog key={dialog.key} roomId={dialog.roomId} start={dialog.start} />
    </Suspense>
  )
}
