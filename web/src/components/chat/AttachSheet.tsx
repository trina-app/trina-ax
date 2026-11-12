// The attach sheet of a phone's message box (below 768px): the AI chat's box (Composer.tsx), a room's and a thread's
// (rooms/RoomComposer.tsx) and the room side chat's (rooms/SideChatPanel.tsx). One sheet in all of them, on MenuButton's
// phone sheet (rooms/MenuButton.tsx: 48px rows over a scrim; a tap outside or Escape closes it): 사진 보관함, 사진 찍기,
// 파일 and 팀 파일. Each row opens one picker of the phone, never a second menu where the phone lets a page choose:
// - 사진 보관함: pictures and videos (`image/*,video/*`, several). Android opens its photo picker. iOS (WebKit's
//   WKFileUploadPanel) shows its own short menu for any input that takes pictures, the photo library first. The phone
//   app from 1.0.5 skips it (photo-pick-v1, lib/mobile.ts pickPhotosFromApp): it opens the system photo picker itself
//   (PHPicker, Android's photo picker) for as many as the box still takes, and hands the files over; they go to
//   `onFiles` like the input's. An older app or a browser: the input, as before.
// - 사진 찍기: the camera (`capture`), on iOS and Android alike.
// - 파일: any file. On iOS it asks for any data file (`application/octet-stream`, WebKit's public.data, which every file
//   is but a folder): an input that takes no picture or video type opens the Files browser at once, without iOS's menu.
//   Elsewhere no type is named (Android's own chooser, as before).
// - 팀 파일: the box's team-file picker (components/chat/TeamFilePicker.tsx), through `onTeam`; absent: no such row.
// `computer` false: only 팀 파일 (a shared chat whose project folder the person may not write). Computers keep their own
// menus; this sheet is not drawn there.
import { Camera, FileText, FolderOpen, Images, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocale, useT } from '../../i18n'
import { formatSize } from '../../lib/format'
import { appPicksPhotos, PHOTO_PICK_LIMITS, pickPhotosFromApp } from '../../lib/mobile'
import { toast } from '../../store/ui'
import { MenuButton, type MenuItem } from '../rooms/MenuButton'

/** WebKit on an iPhone or iPad (an iPad's Safari says it is a Mac, with touch) */
export const iosWebKit = () =>
  typeof navigator !== 'undefined' && (/iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1))

/** What the 파일 row's input takes: on iOS any data file, so the Files browser opens without iOS's menu; elsewhere any. */
export const filesAccept = () => (iosWebKit() ? 'application/octet-stream' : undefined)

export function AttachSheet({ onFiles, room, onTeam, computer = true, icon, testId, filesTestId = 'attach-files-input', buttonClassName }: {
  /** files picked from the phone (pictures, a photo just taken, files) */
  onFiles: (files: File[]) => void
  /** how many more files the box takes: the phone app's photo picker stops there (the box still checks) */
  room?: number
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
  const locale = useLocale()
  const photos = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  const files = useRef<HTMLInputElement>(null)
  const take = (input: HTMLInputElement) => {
    const picked = Array.from(input.files ?? [])
    // the same file picked again later is a change again
    input.value = ''
    if (picked.length) onFiles(picked)
  }
  // the phone app's photo picker: the bytes come over the bridge (a few seconds for a video), the button turns into a
  // spinner meanwhile; they go to the box as it is then, and are dropped when the box went away
  const [fetching, setFetching] = useState(false)
  const alive = useRef(true)
  const latest = useRef(onFiles)
  latest.current = onFiles
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const pickPhotos = () => {
    if (!appPicksPhotos()) return photos.current?.click()
    if (fetching) return
    setFetching(true)
    pickPhotosFromApp(Math.min(Math.max(1, room ?? PHOTO_PICK_LIMITS.files), PHOTO_PICK_LIMITS.files))
      .then(({ files: picked, tooBig }) => {
        if (!alive.current) return
        // one line for all left out: a file over 50 MB, or past 200 MB in one pick
        if (tooBig.length) toast({ level: 'warn', text: t('composer.photosTooBig', { names: tooBig.join(', '), max: formatSize(PHOTO_PICK_LIMITS.file, locale), total: formatSize(PHOTO_PICK_LIMITS.pick, locale) }) })
        if (picked.length) latest.current(picked)
      }, (e: unknown) => {
        // cancelled is no error; a page that moved on says nothing either
        if (!alive.current || (e instanceof DOMException && e.name === 'AbortError')) return
        toast({ level: 'warn', text: t(e instanceof Error && e.message === 'photo_denied' ? 'composer.photosDenied' : 'composer.photosFailed') })
      })
      .finally(() => { if (alive.current) setFetching(false) })
  }
  const items: MenuItem[] = [
    ...(computer
      ? [
          { label: t('composer.photos'), icon: <Images size={18} className="text-muted" aria-hidden />, onSelect: pickPhotos, testId: 'attach-photos' },
          { label: t('composer.camera'), icon: <Camera size={18} className="text-muted" aria-hidden />, onSelect: () => camera.current?.click(), testId: 'attach-camera' },
          { label: t('composer.files'), icon: <FileText size={18} className="text-muted" aria-hidden />, onSelect: () => files.current?.click(), testId: 'attach-files' },
        ]
      : []),
    ...(onTeam ? [{ label: t('composer.teamFiles'), icon: <FolderOpen size={18} className="text-accent-text" aria-hidden />, onSelect: onTeam, testId: 'attach-team' }] : []),
  ]
  return (
    <>
      <MenuButton label={fetching ? t('composer.photosFetching') : t('composer.attach')} heading={t('composer.attach')} items={items} icon={fetching ? <Loader2 size={18} className="animate-spin" aria-hidden /> : icon} muted compact buttonClassName={buttonClassName} testId={testId} />
      {computer && (
        <>
          <input ref={photos} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => take(e.target)} data-testid="attach-photos-input" />
          <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => take(e.target)} data-testid="attach-camera-input" />
          <input ref={files} type="file" accept={filesAccept()} multiple hidden onChange={(e) => take(e.target)} data-testid={filesTestId} />
        </>
      )}
    </>
  )
}
