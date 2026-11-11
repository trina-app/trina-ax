// The attach sheet of a phone's message box (below 768px): the AI chat's box (Composer.tsx), a room's and a thread's
// (rooms/RoomComposer.tsx) and the room side chat's (rooms/SideChatPanel.tsx). One sheet in all of them, on MenuButton's
// phone sheet (rooms/MenuButton.tsx: 48px rows over a scrim; a tap outside or Escape closes it): 사진 보관함, 사진 찍기,
// 파일 and 팀 파일. Each row opens one picker of the phone, never a second menu where the phone lets a page choose:
// - 사진 보관함: pictures and videos (`image/*,video/*`, several). Android opens its photo picker. iOS (WebKit's
//   WKFileUploadPanel) shows its own short menu for any input that takes pictures, the photo library first; only the
//   app could skip it.
// - 사진 찍기: the camera (`capture`), on iOS and Android alike.
// - 파일: any file. On iOS it asks for any data file (`application/octet-stream`, WebKit's public.data, which every file
//   is but a folder): an input that takes no picture or video type opens the Files browser at once, without iOS's menu.
//   Elsewhere no type is named (Android's own chooser, as before).
// - 팀 파일: the box's team-file picker (components/chat/TeamFilePicker.tsx), through `onTeam`; absent: no such row.
// `computer` false: only 팀 파일 (a shared chat whose project folder the person may not write). Computers keep their own
// menus; this sheet is not drawn there.
import { Camera, FileText, FolderOpen, Images } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { MenuButton, type MenuItem } from '../rooms/MenuButton'

/** WebKit on an iPhone or iPad (an iPad's Safari says it is a Mac, with touch) */
export const iosWebKit = () =>
  typeof navigator !== 'undefined' && (/iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1))

/** What the 파일 row's input takes: on iOS any data file, so the Files browser opens without iOS's menu; elsewhere any. */
export const filesAccept = () => (iosWebKit() ? 'application/octet-stream' : undefined)

export function AttachSheet({ onFiles, onTeam, computer = true, icon, testId, buttonClassName }: {
  /** files picked from the phone (pictures, a photo just taken, files) */
  onFiles: (files: File[]) => void
  /** opens the box's team-file picker; absent: no 팀 파일 row */
  onTeam?: () => void
  /** false: files from the phone are not taken here (only 팀 파일) */
  computer?: boolean
  /** the button's icon (the AI chat's +, a room's 📎) */
  icon: ReactNode
  testId: string
  buttonClassName?: string
}) {
  const t = useT()
  const photos = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  const files = useRef<HTMLInputElement>(null)
  const take = (input: HTMLInputElement) => {
    const picked = Array.from(input.files ?? [])
    // the same file picked again later is a change again
    input.value = ''
    if (picked.length) onFiles(picked)
  }
  const items: MenuItem[] = [
    ...(computer
      ? [
          { label: t('composer.photos'), icon: <Images size={18} className="text-muted" aria-hidden />, onSelect: () => photos.current?.click(), testId: 'attach-photos' },
          { label: t('composer.camera'), icon: <Camera size={18} className="text-muted" aria-hidden />, onSelect: () => camera.current?.click(), testId: 'attach-camera' },
          { label: t('composer.files'), icon: <FileText size={18} className="text-muted" aria-hidden />, onSelect: () => files.current?.click(), testId: 'attach-files' },
        ]
      : []),
    ...(onTeam ? [{ label: t('composer.teamFiles'), icon: <FolderOpen size={18} className="text-accent-text" aria-hidden />, onSelect: onTeam, testId: 'attach-team' }] : []),
  ]
  return (
    <>
      <MenuButton label={t('composer.attach')} heading={t('composer.attach')} items={items} icon={icon} muted buttonClassName={buttonClassName ?? 'touch-hit'} testId={testId} />
      {computer && (
        <>
          <input ref={photos} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => take(e.target)} data-testid="attach-photos-input" />
          <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => take(e.target)} data-testid="attach-camera-input" />
          <input ref={files} type="file" accept={filesAccept()} multiple hidden onChange={(e) => take(e.target)} data-testid="attach-files-input" />
        </>
      )}
    </>
  )
}
