// Adding a file from the phone: the rows every add on a phone (below 768px) starts from, in the app's own sheet
// (rooms/MenuButton.tsx), never iOS's raw "Photo Library / Take Photo or Video / Choose Files" menu (English, which
// WebKit shows for a file input that names no type or takes pictures; docs/decisions/20261118-our-file-picker-everywhere.md).
// The message boxes' attach sheet (chat/AttachSheet.tsx), Files ⊕ and an empty folder's 올리기, the profile photo, the
// member welcome's photo, the team logo, a room app's icon and the welcome's file buttons all take their rows here.
// Each row opens one picker of the phone:
// - 사진 보관함: pictures and videos (`image/*,video/*`, several; a picture place: its picture types, one). Android opens
//   its photo picker. iOS (WebKit's WKFileUploadPanel) shows its own short menu for any input that takes pictures, the
//   photo library first. The phone app from 1.0.5 skips it (photo-pick-v1, lib/mobile.ts pickPhotosFromApp): it opens
//   the system photo picker itself (PHPicker, Android's photo picker) for as many as the place still takes, and hands the
//   files over; they go to `onFiles` like the input's. A file over the bridge's 50 MB where bigger ones are taken (the
//   AI chat, the side chat, Files): the message offers the input (WebKit's picker reaches the library and takes big
//   videos; the 파일 row's Files browser does not reach the library). An older app or a browser: the input, as before.
// - 사진 찍기: the camera (`capture`), on iOS and Android alike.
// - 파일: any file (a picture place: its picture types, except on iOS). On iOS it asks for any data file
//   (`application/octet-stream`, WebKit's public.data, which every file is but a folder): an input that takes no
//   picture or video type opens the Files browser at once, without iOS's menu. The place checks what came (a picture
//   place: squarePhoto says when it is no picture). Elsewhere: no type (any), or the picture types.
// Computers keep their buttons and menus: a computer's file window is what a labelled button opens there.
import { Camera, FileText, Images } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocale, useT, type MessageKey } from '../i18n'
import { holdHistory } from '../lib/backCloses'
import { markBusy } from '../lib/busy'
import { formatSize } from '../lib/format'
import { mediaKindOf } from '../lib/preview'
import { appPicksPhotos, PHOTO_PICK_LIMITS, pickPhotosFromApp } from '../lib/mobile'
import { toast } from '../store/ui'
import { MenuButton, type MenuItem } from './rooms/MenuButton'

/** WebKit on an iPhone or iPad (an iPad's Safari says it is a Mac, with touch) */
export const iosWebKit = () =>
  typeof navigator !== 'undefined' && (/iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1))

/** What the 파일 row's input takes: on iOS any data file, so the Files browser opens without iOS's menu; elsewhere
 * `other` (absent: any). */
export const filesAccept = (other?: string) => (iosWebKit() ? 'application/octet-stream' : other)

/** How long the history stays held for a pick's bytes once the picker answered: 15 s, and 1 s more per MiB (a full
 * 200 MiB pick: the 120 s cap). */
export const bytesHoldMs = (bytes: number) => Math.min(120_000, 15_000 + Math.ceil(bytes / (1024 * 1024)) * 1000)

/** The line for what the app's photo picker left out as too big, by what it is (lib/preview.ts mediaKindOf): `limit`
 * where the place takes no bigger file, `other` where its input can (it offers that). */
export const TOO_BIG_WORDS = {
  photo: { limit: 'composer.photosTooBig', other: 'composer.photosTooBigOther' },
  video: { limit: 'composer.videosTooBig', other: 'composer.videosTooBigOther' },
  file: { limit: 'composer.filesTooBig', other: 'composer.filesTooBigOther' },
} as const satisfies Record<ReturnType<typeof mediaKindOf>, { limit: MessageKey; other: MessageKey }>

export type DeviceRow = 'photos' | 'camera' | 'files'
/** The rows of a place, in this order: 사진 보관함, 사진 찍기, 파일 (pure, for the tests). `picture`: a place that takes
 * one picture (a face, a logo, an icon); `camera` false: no 사진 찍기 (a logo or an app's icon is not photographed). */
export const deviceRows = (picture: boolean, camera = true): { id: DeviceRow; multiple: boolean }[] =>
  (['photos', 'camera', 'files'] as const).filter((id) => camera || id !== 'camera').map((id) => ({ id, multiple: !picture && id !== 'camera' }))

export interface DevicePick {
  /** the sheet's rows (사진 보관함, 사진 찍기, 파일), for a MenuButton with the place's own rows around them */
  items: MenuItem[]
  /** the hidden inputs the rows open: put them anywhere in the place */
  inputs: ReactNode
  /** the phone app's photo picker is handing files over */
  fetching: boolean
}

export function useDevicePick({ onFiles, room, fileMax, accept, camera: withCamera = true, testIds = 'attach', filesTestId, off = false }: {
  /** false: no 사진 찍기 row */
  camera?: boolean
  /** what was picked (pictures, a photo just taken, files) */
  onFiles: (files: File[]) => void
  /** how many more files the place takes: the phone app's photo picker stops there (the place still checks) */
  room?: number
  /** the largest file the place takes (a room's 50 MB); absent: no limit of its own */
  fileMax?: number
  /** a place for one picture (a face, a logo): the picture types it takes, e.g. image/png,image/jpeg,image/webp */
  accept?: string
  /** the rows' test ids: `<testIds>-photos`, `-camera`, `-files`, their inputs `…-input` */
  testIds?: string
  /** the 파일 row's input, by the name the place's own file input has on a computer */
  filesTestId?: string
  /** the rows are shown but off (an upload on its way) */
  off?: boolean
}): DevicePick {
  const t = useT()
  const locale = useLocale()
  const picture = accept !== undefined
  const photos = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  const files = useRef<HTMLInputElement>(null)
  const take = (input: HTMLInputElement) => {
    const picked = Array.from(input.files ?? [])
    // the same file picked again later is a change again
    input.value = ''
    if (picked.length) onFiles(picture ? picked.slice(0, 1) : picked)
  }
  // the phone app's photo picker: the bytes come over the bridge (a few seconds for a video), the button turns into a
  // spinner meanwhile; they go to the place as it is then, and are dropped when it went away (each box keys its sheet
  // by what it writes to, so another room's or chat's box is another sheet)
  const [fetching, setFetching] = useState(false)
  const alive = useRef(true)
  const latest = useRef(onFiles)
  latest.current = onFiles
  // the history stays where it is while the pick is on (lib/backCloses.ts holdHistory): the sheet's own back-off waits
  const letGo = useRef<(() => void) | null>(null)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      letGo.current?.()
    }
  }, [])
  // bytes on their way: an update waits before it reloads the page, as for an upload
  useEffect(() => (fetching ? markBusy('upload') : undefined), [fetching])
  const pickPhotos = () => {
    if (!appPicksPhotos()) return photos.current?.click()
    if (fetching) return
    setFetching(true)
    // the sheet closes as the picker opens: its back-off (a step of the history within this page) waits until the bytes
    // are in, so nothing the phone app could take for a new page happens meanwhile (QA TC-251: on Android it dropped
    // the pick)
    // Held while the picker is up (the page is under it), then for the bytes at most bytesHoldMs, so a stuck transfer
    // never keeps Back's history waiting for minutes
    letGo.current?.()
    const hold = holdHistory()
    let cap: ReturnType<typeof setTimeout> | null = null
    const release = () => { if (cap) clearTimeout(cap); cap = null; hold() }
    letGo.current = release
    const limit = picture ? 1 : Math.min(Math.max(1, room ?? PHOTO_PICK_LIMITS.files), PHOTO_PICK_LIMITS.files)
    pickPhotosFromApp(limit, (bytes) => { cap = setTimeout(release, bytesHoldMs(bytes)) })
      .then(({ files: picked, tooBig }) => {
        if (!alive.current) return
        // one line for all left out: a file over 50 MB, or past 200 MB in one pick. A place that takes bigger files
        // offers the input, which has no such limit (a long video from the library)
        const names = tooBig.join(', ')
        // the line names what they are where the language says it (ko "이 동영상은"): never a video called a photo
        const words = TOO_BIG_WORDS[mediaKindOf(tooBig)]
        if (tooBig.length && (fileMax === undefined || fileMax > PHOTO_PICK_LIMITS.file)) toast({ level: 'warn', ms: 12_000, text: t(words.other, { names }), action: { label: t('composer.photosPickOther'), run: () => photos.current?.click(), primary: true } })
        else if (tooBig.length) toast({ level: 'warn', text: t(words.limit, { names, max: formatSize(PHOTO_PICK_LIMITS.file, locale), total: formatSize(PHOTO_PICK_LIMITS.pick, locale) }) })
        if (picked.length) latest.current(picture ? picked.slice(0, 1) : picked)
      }, (e: unknown) => {
        // a place that went away (another page, another room) says nothing. Cancelled in the picker is no error either:
        // that is an empty pick, not a failure. A pick the page gave up on while the place is still here (the app put
        // its bridge in again, a session reset) did fail: the person picked and nothing came, so it says so
        if (!alive.current) return
        toast({ level: 'warn', text: t(e instanceof Error && e.message === 'photo_denied' ? 'composer.photosDenied' : 'composer.photosFailed') })
      })
      .finally(() => {
        release()
        if (letGo.current === release) letGo.current = null
        if (alive.current) setFetching(false)
      })
  }
  const rows = deviceRows(picture, withCamera)
  const many = (id: DeviceRow) => !!rows.find((r) => r.id === id)?.multiple
  const row: Record<DeviceRow, MenuItem> = {
    photos: { label: t('composer.photos'), icon: <Images size={18} className="text-muted" aria-hidden />, onSelect: pickPhotos, testId: `${testIds}-photos` },
    camera: { label: t('composer.camera'), icon: <Camera size={18} className="text-muted" aria-hidden />, onSelect: () => camera.current?.click(), testId: `${testIds}-camera` },
    files: { label: t('composer.files'), icon: <FileText size={18} className="text-muted" aria-hidden />, onSelect: () => files.current?.click(), testId: `${testIds}-files` },
  }
  const items: MenuItem[] = rows.map((r) => ({ ...row[r.id], disabled: off || undefined }))
  const inputs = (
    <>
      <input ref={photos} type="file" accept={accept ?? 'image/*,video/*'} multiple={many('photos')} hidden onChange={(e) => take(e.target)} data-testid={`${testIds}-photos-input`} />
      {withCamera && <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => take(e.target)} data-testid={`${testIds}-camera-input`} />}
      <input ref={files} type="file" accept={filesAccept(accept)} multiple={many('files')} hidden onChange={(e) => take(e.target)} data-testid={filesTestId ?? `${testIds}-files-input`} />
    </>
  )
  return { items, inputs, fetching }
}

/** A phone's add button whose sheet is the device rows (and the place's own rows around them): a button with words
 * (an empty folder's 올리기, the welcome's file link), its look the caller's (components/ui.tsx buttonClass). */
export function PhonePickButton({ pick, label, heading, before = [], after = [], className, wrapClassName, children, testId, describedBy, inputs = true }: {
  /** the box around the button (w-full for a full-width button) */
  wrapClassName?: string
  pick: DevicePick
  /** false: the place draws `pick.inputs` itself (one set for two buttons, Files' ⊕ and its empty folder's 올리기) */
  inputs?: boolean
  label: string
  /** the sheet's name (default: `label`) */
  heading?: string
  /** the place's own rows above and below the device rows (새 폴더; a photo's 삭제) */
  before?: MenuItem[]
  after?: MenuItem[]
  className?: string
  children: ReactNode
  testId?: string
  describedBy?: string
}) {
  return (
    <>
      <MenuButton bare label={label} heading={heading ?? label} items={[...before, ...pick.items, ...after]} icon={children} className={wrapClassName} buttonClassName={className} testId={testId} describedBy={describedBy} startAligned />
      {inputs && pick.inputs}
    </>
  )
}

/** The same sheet opened from the place's own control (a phone's list row, the team logo's): no button of its own;
 * `request` counts up to open it (MenuButton's openRequest), the keyboard goes back to `focusBack`. */
export function PhonePickSheet({ pick, heading, request, focusBack, before = [], after = [], testId }: {
  pick: DevicePick
  heading: string
  request: number
  focusBack?: () => void
  before?: MenuItem[]
  after?: MenuItem[]
  testId?: string
}) {
  return (
    <>
      <MenuButton label={heading} heading={heading} items={[...before, ...pick.items, ...after]} className="absolute" buttonClassName="hidden!" openRequest={request} focusBack={focusBack} testId={testId} />
      {pick.inputs}
    </>
  )
}
