// The attach sheet of a phone's message box (below 768px): the AI chat's box (Composer.tsx), a room's and a thread's
// (rooms/RoomComposer.tsx) and the room side chat's (rooms/SideChatPanel.tsx). One sheet in all of them, on MenuButton's
// phone sheet (rooms/MenuButton.tsx: 48px rows over a scrim; a tap outside or Escape closes it): 사진 보관함, 사진 찍기,
// 파일 (the device rows every add on a phone starts from, components/DevicePick.tsx, which says what each opens) and
// 팀 파일. Each row opens one picker of the phone, never a second menu where the phone lets a page choose.
// - 팀 파일: the box's team-file picker (components/chat/TeamFilePicker.tsx), through `onTeam`; absent: no such row.
// `computer` false: only 팀 파일 (a shared chat whose project folder the person may not write). Computers keep their own
// menus; this sheet is not drawn there.
import { FolderOpen, Loader2 } from 'lucide-react'
import { type ReactNode } from 'react'
import { useT } from '../../i18n'
import { useMe } from '../../store/session'
import { isGuestMe } from '../../lib/guests'
import { MenuButton, type MenuItem } from '../rooms/MenuButton'
import { useDevicePick } from '../DevicePick'

// (first defined here: the tests and the other boxes still take them from here)
export { iosWebKit, filesAccept, bytesHoldMs, TOO_BIG_WORDS } from '../DevicePick'

export function AttachSheet({ onFiles, room, fileMax, onTeam, computer = true, icon, testId, filesTestId = 'attach-files-input', buttonClassName }: {
  /** files picked from the phone (pictures, a photo just taken, files) */
  onFiles: (files: File[]) => void
  /** how many more files the box takes: the phone app's photo picker stops there (the box still checks) */
  room?: number
  /** the largest file the box takes (a room's 50 MB); absent: no limit of its own (the AI chat's uploads) */
  fileMax?: number
  /** opens the box's team-file picker; absent: no 팀 파일 row */
  onTeam?: () => void
  /** false: files from the phone are not taken here (only 팀 파일) */
  computer?: boolean
  /** the button's icon (the AI chat's +, a room's 📎) */
  icon: ReactNode
  testId: string
  /** the 파일 row's input, by the name the box's own file input has on a computer */
  filesTestId?: string
  buttonClassName?: string
}) {
  const t = useT()
  // a guest has no team folder: the row names what they can reach (components/chat/TeamFilePicker.tsx)
  const guest = isGuestMe(useMe())
  const device = useDevicePick({ onFiles, room, fileMax, filesTestId })
  const items: MenuItem[] = [
    ...(computer ? device.items : []),
    ...(onTeam ? [{ label: t(guest ? 'picker.guestRoot' : 'composer.teamFiles'), icon: <FolderOpen size={18} className="text-accent-text" aria-hidden />, onSelect: onTeam, testId: 'attach-team' }] : []),
  ]
  return (
    <>
      {/* flex: no line box around the button, so it sits on its slot's centre whatever the system font's line metrics */}
      <MenuButton label={device.fetching ? t('composer.photosFetching') : t('composer.attach')} heading={t('composer.attach')} items={items} icon={device.fetching ? <Loader2 size={18} className="animate-spin" aria-hidden /> : icon} muted compact className="flex" buttonClassName={buttonClassName} testId={testId} />
      {computer && device.inputs}
    </>
  )
}
