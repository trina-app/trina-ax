// The one attach button of every message box that takes files (components/composer/ComposerShell.tsx): a + in the
// box's row. On a computer a small menu: from this computer (the camera too on a small touch screen) and team files;
// on a phone the attach sheet every message box has there (chat/AttachSheet.tsx: 사진 보관함, 사진 찍기, 파일, 팀 파일). It
// holds the file inputs and the team-file picker (chat/TeamFilePicker.tsx), so a box only says what it takes:
// - `onFiles`: files from this computer or phone; `computer` false: none (a shared chat whose project folder the
//   person may not write), team files only;
// - `onTeamFiles`: team files picked (absent: no team row); the box attaches them its own way (the AI chat by
//   reference, a room as a copy);
// - `off`: why the box takes no files here (a project room the person may only read): the button says it and a press
//   says it again, nothing opens.
import clsx from 'clsx'
import { Camera, FolderOpen, Monitor, Plus, Smartphone } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { FileEntry } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { isGuestMe } from '../../lib/guests'
import { useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { IconButton, useMediaQuery } from '../ui'
import { AttachSheet } from '../chat/AttachSheet'
import TeamFilePicker from '../chat/TeamFilePicker'

export interface AttachProps {
  onFiles: (files: File[]) => void
  /** false: no files from this computer or phone, team files only */
  computer?: boolean
  /** team files picked in the picker; absent: no team row */
  onTeamFiles?: (picked: FileEntry[]) => void
  /** the team files on the box already (the picker shows them as added) */
  teamAttached?: Set<string>
  /** how many more files the box takes, and its most */
  room: number
  max: number
  /** the largest file the box takes (a room's); absent: no limit of its own */
  fileMax?: number
  /** the box takes no files here, and why */
  off?: string | null
  /** test ids: the button, and the computer's file input (a phone's 파일 row's input takes the same) */
  testId: string
  filesTestId: string
  /** a phone's stacked box: a quiet round button as tall as what is beside it */
  round?: boolean
  /** after the picker hands team files to the box: back to the text */
  onPicked?: () => void
}

export function AttachMenu({ onFiles, computer = true, onTeamFiles, teamAttached, room, max, fileMax, off, testId, filesTestId, round = false, onPicked }: AttachProps) {
  const t = useT()
  const me = useMe()
  const phone = useMediaQuery('(max-width: 767.98px)')
  const [open, setOpen] = useState(false)
  const [picker, setPicker] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const camRef = useRef<HTMLInputElement>(null)
  // phones and tablets: "from this device", else "from this computer"
  const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    // Escape anywhere closes the menu (focus back on the button)
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setOpen(false)
      button()?.focus()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  const button = () => wrap.current?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? null
  const items = () => [...(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].filter((x) => x.offsetParent !== null)
  const openMenu = (focusFirst: boolean) => {
    setOpen(true)
    if (focusFirst) requestAnimationFrame(() => items()[0]?.focus())
  }
  const picked = (e: React.ChangeEvent<HTMLInputElement>) => {
    onFiles(Array.from(e.target.files ?? []))
    e.target.value = ''
  }

  const teamPicker = onTeamFiles && (
    <TeamFilePicker
      open={picker}
      onClose={() => setPicker(false)}
      room={Math.max(0, room)}
      max={max}
      attached={teamAttached ?? new Set()}
      onPick={(files: FileEntry[]) => {
        setPicker(false)
        onTeamFiles(files)
        // after the dialog has handed focus back (to the attach button): on to the message
        if (onPicked) setTimeout(onPicked, 0)
      }}
    />
  )

  if (off) {
    // off, with why: a tap says it too (a disabled button would give a finger no tooltip)
    return (
      <IconButton tip={off} compact label={off} aria-disabled onClick={() => toast({ level: 'info', text: off })} className="opacity-40" data-testid={`${testId}-off`}>
        <Plus size={19} aria-hidden />
      </IconButton>
    )
  }

  if (phone) {
    return (
      <>
        <AttachSheet onFiles={onFiles} room={room} fileMax={fileMax} onTeam={onTeamFiles ? () => setPicker(true) : undefined} computer={computer} icon={<Plus size={round ? 20 : 19} aria-hidden />} testId={testId} filesTestId={filesTestId} buttonClassName={round ? 'size-9 rounded-full! border border-line p-0! text-ink!' : undefined} />
        {teamPicker}
      </>
    )
  }

  const row = 'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left text-sm hover:bg-hover focus-visible:bg-hover sm:py-2 max-md:min-h-11'
  return (
    <>
      <div
        // flex: the button itself is what the row's slot centres (not a line box around it)
        className="relative flex"
        ref={wrap}
        onBlur={(e) => {
          // focus moving out of the button and its menu (Tab, Shift+Tab) closes the menu; no new target (Safari does not
          // focus a clicked button) is left to the click-outside handler
          if (open && e.relatedTarget && !wrap.current?.contains(e.relatedTarget as Node)) setOpen(false)
        }}
      >
        <IconButton
          label={t('composer.attach')}
          aria-haspopup="menu"
          aria-expanded={open}
          // a click opens the menu; Enter / Space (detail 0) and the arrow keys also put focus on its first item
          onClick={(e) => (open ? setOpen(false) : openMenu(e.detail === 0))}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              openMenu(true)
            }
          }}
          compact
          data-testid={testId}
        >
          <Plus size={19} aria-hidden />
        </IconButton>
        {open && (
          <div className="absolute bottom-full left-0 z-30 mb-1 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-1 shadow-lg" data-testid="attach-menu">
            <div
              role="menu"
              aria-label={t('composer.attach')}
              onKeyDown={(e) => {
                const all = items()
                const i = all.indexOf(document.activeElement as HTMLElement)
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus()
                } else if (e.key === 'Home' || e.key === 'End') {
                  e.preventDefault()
                  all[e.key === 'Home' ? 0 : all.length - 1]?.focus()
                } else if (e.key === 'Tab') setOpen(false)
              }}
            >
              {computer && (
                <>
                  <button type="button" role="menuitem" tabIndex={-1} className={row} onClick={() => { setOpen(false); fileRef.current?.click() }} data-testid="attach-computer">
                    {coarse ? <Smartphone size={16} className="text-muted" aria-hidden /> : <Monitor size={16} className="text-muted" aria-hidden />} {t(coarse ? 'composer.fromDevice' : 'composer.fromComputer')}
                  </button>
                  <button type="button" role="menuitem" tabIndex={-1} className={clsx(row, 'sm:hidden')} onClick={() => { setOpen(false); camRef.current?.click() }} data-testid="attach-camera">
                    <Camera size={16} className="text-muted" aria-hidden /> {t('composer.camera')}
                  </button>
                </>
              )}
              {onTeamFiles && (
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={row}
                  onClick={() => {
                    // focus on the attach button first: closing the picker without picking brings it back there
                    button()?.focus()
                    setOpen(false)
                    setPicker(true)
                  }}
                  data-testid="attach-team"
                >
                  <FolderOpen size={16} className="text-accent-text" aria-hidden /> {t(isGuestMe(me) ? 'picker.guestTitle' : 'composer.fromTeam')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      {computer && (
        <>
          <input ref={fileRef} type="file" multiple hidden data-testid={filesTestId} onChange={picked} />
          <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={picked} />
        </>
      )}
      {teamPicker}
    </>
  )
}
