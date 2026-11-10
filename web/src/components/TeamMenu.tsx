// The team menu on top of the computer's sidebar (docs/DECISIONS.md "The team menu"; the owner: "top of the sidebar =
// the team, bottom = me"). The team's logo (28 px, Admin › Team settings, or the product's mark) and its name (16 px,
// semibold: above the 14 px rows, below the 18–20 px page titles), then a ▾. For owners and admins it is a button that
// opens a menu under it: the team again with its address (GET /api/me team.address, when the server knows one), then
// "Invite people" (the invite endpoints are admins' only) and "Admin". Nothing personal: Settings and Sign out are the
// profile menu's at the bottom. A member has neither item, so for them the header is the team's name and logo, not a
// button (a menu with no items would be a dead end). Home is the "Ask Trina" row right under it, as ⇧⌘O is; the header
// is not a second way there. Keyboard as in the profile menu: the first item takes focus, arrows, Home and End move,
// Esc closes it and gives the keyboard back, Tab and a click outside close it. Phones (below 768 px) keep the AI's
// drawer and have Admin on the 나 tab (Sidebar.tsx).
// "Invite people" (here and in ⌘K) opens the invite dialog Home's goal card opens (onboarding/InviteStep.tsx: the team
// invite link's message and its copy button), one for the whole window (Layout.tsx mounts it); while the owner's
// welcome steps are unfinished it opens their own invite step instead, never a second invite dialog (GoalCard.tsx).
import clsx from 'clsx'
import { ChevronDown, Shield, UserPlus } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate, type NavigateFunction } from 'react-router-dom'
import { create } from 'zustand'
import { teamIconUrl } from '@mycel/shared'
import { useT } from '../i18n'
import { teamAddressHost } from '../lib/team-address'
import { showResume } from '../lib/welcome'
import { isAdmin, useMeStrict } from '../store/session'
import { useWelcome } from '../store/welcome'
import { INVITE_STEP_STATE } from './onboarding/GoalCard'
import { InviteStep } from './onboarding/InviteStep'
import { Modal } from './ui'

/** The team's logo, cropped square as the settings previews do; the product's mark while there is none. */
function TeamLogo({ className, testId }: { className: string; testId?: string }) {
  const me = useMeStrict()
  const src = me.team.iconVersion ? teamIconUrl(me.team.iconVersion) : '/favicon.svg'
  return <img src={src} alt="" aria-hidden className={clsx('shrink-0 object-cover', className)} data-testid={testId} />
}

export function TeamMenu() {
  const t = useT()
  const me = useMeStrict()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const admin = isAdmin(me)
  const host = teamAddressHost(me.team.address)
  const hide = (focusBack: boolean) => {
    setOpen(false)
    if (focusBack) button.current?.focus()
  }
  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && hide(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const onKey = (e: KeyboardEvent) => {
    if (!open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      hide(true)
      return
    }
    if (e.key === 'Tab') return hide(false)
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    const go = (n: number) => {
      e.preventDefault()
      items[(n + items.length) % items.length]?.focus()
    }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i < 0 ? -1 : i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(-1)
  }
  const name = <span className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight" data-testid="sidebar-team">{me.team.name}</span>
  // the logo's middle is in line with the rows' icons below (8 + 6 + 14 = 8 + 12 + 8 px from the edge)
  const head = 'flex h-11 w-full items-center gap-2.5 rounded-lg pr-2 pl-1.5 text-left text-ink'
  if (!admin)
    return (
      <div className="px-2 pt-2 pb-1">
        <div className={head} data-testid="team-header">
          <TeamLogo className="size-7 rounded-lg" testId="sidebar-logo" />
          {name}
        </div>
      </div>
    )
  const item = 'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-ink hover:bg-hover focus-visible:-outline-offset-2'
  return (
    <div ref={ref} className="relative px-2 pt-2 pb-1" onKeyDown={onKey}>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => (open ? hide(false) : setOpen(true))}
        className={clsx(head, 'hover:bg-hover active:bg-hover aria-expanded:bg-hover focus-visible:-outline-offset-2')}
        data-testid="team-menu"
      >
        <TeamLogo className="size-7 rounded-lg" testId="sidebar-logo" />
        {name}
        <ChevronDown size={14} className={clsx('shrink-0 text-faint transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div ref={menu} role="menu" aria-label={me.team.name} className="absolute top-full right-2 left-2 z-30 mt-1 rounded-xl border border-line bg-surface p-1.5 shadow-lg" data-testid="team-dropdown">
          {/* the team, as a new device would look for it: its logo, its whole name (the button above may cut it) and its
              address (Settings › 앱 has the copy button) */}
          <div className="flex items-center gap-2.5 px-2.5 pt-1 pb-2" data-testid="team-menu-head">
            <TeamLogo className="size-8 rounded-lg" />
            <span className="min-w-0">
              <span className="line-clamp-3 text-sm font-semibold break-words text-ink" data-testid="team-menu-name">{me.team.name}</span>
              {host && <span className="block truncate text-xs text-muted" data-testid="team-menu-address">{host}</span>}
            </span>
          </div>
          <div role="separator" className="mx-1 mb-1.5 border-t border-line" />
          <button
            role="menuitem"
            type="button"
            className={item}
            onClick={() => {
              hide(true)
              openTeamInvite(navigate, button.current)
            }}
            data-testid="team-menu-invite"
          >
            <UserPlus size={16} className="text-muted" aria-hidden /> {t('teamMenu.invite')}
          </button>
          <button
            role="menuitem"
            type="button"
            className={item}
            onClick={() => {
              hide(false)
              navigate('/admin')
            }}
            data-testid="team-menu-admin"
          >
            <Shield size={16} className="text-muted" aria-hidden /> {t('sidebar.admin')}
          </button>
        </div>
      )}
    </div>
  )
}

/** The invite dialog, one for the window: open while `open`, the keyboard back on `returnTo` when it closes. */
const useTeamInvite = create<{ open: boolean; returnTo: HTMLElement | null }>(() => ({ open: false, returnTo: null }))

/** "Invite people" (the team menu, ⌘K): the owner's own invite step while the welcome steps are unfinished, else the
 * invite dialog. `returnTo`: where the keyboard goes when the dialog closes (null: where it was when it opened). */
export function openTeamInvite(navigate: NavigateFunction, returnTo: HTMLElement | null) {
  const computer = typeof matchMedia === 'function' && matchMedia('(min-width: 768px)').matches
  if (showResume(useWelcome.getState().progress, computer)) return void navigate('/welcome', { state: INVITE_STEP_STATE })
  useTeamInvite.setState({ open: true, returnTo })
}

export function TeamInviteDialog() {
  const t = useT()
  const { open, returnTo } = useTeamInvite()
  if (!open) return null
  const close = () => useTeamInvite.setState({ open: false, returnTo: null })
  return (
    <Modal open onClose={close} title={t('teamMenu.invite')} width={560} returnTo={returnTo}>
      <InviteStep title={null} onDone={close} />
    </Modal>
  )
}
