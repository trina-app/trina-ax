// The team menu on top of the rail (components/rail/Rail.tsx; docs/DECISIONS.md "The team menu", "Computers: an icon
// rail with labels"; docs/decisions/20261118-team-menu-for-members.md): the team's logo (Admin › Team settings, or the
// product's mark) with its name small under it, a button for every role that opens a menu to its right: the team again
// with its address (GET /api/me team.address, when the server knows one), then for owners and admins only "Invite
// people" (the invite endpoints are admins' only) and "Admin", then "Switch team" for everyone (lib/teamSwitch.ts: the
// desktop app's team screen, the phone app's, or in a plain browser a dialog that opens another team's address or an
// invite link). Nothing personal: Settings and Sign out are the photo's menu at the rail's bottom. Only a phone app
// without its team screen, at a computer's width, gives a member no item: there it is the team's logo and name, not a
// button (a menu with no items would be a dead end). Keyboard as in the profile menu: the first item takes focus,
// arrows, Home and End move, Esc closes it and gives the keyboard back, Tab and a click outside close it. Phones (below
// 768 px) have the team's row with Invite, Admin and Switch team on the 나 tab.
import clsx from 'clsx'
import { ArrowLeftRight, Shield, UserPlus } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { useLocation, useNavigate, type NavigateFunction } from 'react-router-dom'
import { create } from 'zustand'
import { teamIconUrl } from '@mycel/shared'
import { useT } from '../i18n'
import { teamAddressShown } from '../lib/team-address'
import { switchTeam, useTeamSwitchWay } from '../lib/teamSwitch'
import { showResume } from '../lib/welcome'
import { isAdmin, isOwner, useMeStrict, useSession } from '../store/session'
import { useWelcome } from '../store/welcome'
import { INVITE_STEP_STATE } from './onboarding/GoalCard'
import { InviteStep } from './onboarding/InviteStep'
import { GuestChoiceButtons, GuestChoiceForm, GuestChoicePanel, InviteKindTabs, useGuestChoice, type InviteKind } from './GuestInviteChoice'
import { Modal, TabPanel } from './ui'

/** The team's logo, cropped square as the settings previews do; the product's mark while there is none. */
export function TeamLogo({ className, testId }: { className: string; testId?: string }) {
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
  // "다른 팀으로 전환" for everyone: the desktop app's or phone app's team screen, a plain browser's dialog
  const canSwitch = useTeamSwitchWay() !== null
  const host = teamAddressShown(me.team.address)
  const addressId = useId()
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
  const railHead = 'flex w-full flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-ink'
  if (!admin && !canSwitch)
    return (
      <div className="px-1.5 pt-2 pb-1" title={me.team.name}>
        <div className={railHead} data-testid="team-header">
          <TeamLogo className="size-9 rounded-xl" testId="sidebar-logo" />
          <span className="block w-full truncate px-0.5 text-center text-micro leading-tight text-muted" data-testid="sidebar-team">{me.team.name}</span>
        </div>
      </div>
    )
  const item = 'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-ink hover:bg-hover focus-visible:-outline-offset-2'
  return (
    <div ref={ref} className="relative px-1.5 pt-2 pb-1" onKeyDown={onKey}>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={me.team.name}
        onClick={() => (open ? hide(false) : setOpen(true))}
        className={clsx(railHead, 'hover:bg-hover active:bg-hover aria-expanded:bg-hover focus-visible:-outline-offset-2')}
        data-testid="team-menu"
        data-rail-stop=""
      >
        <TeamLogo className="size-9 rounded-xl" testId="sidebar-logo" />
        <span className="block w-full truncate px-0.5 text-center text-micro leading-tight text-muted" aria-hidden data-testid="sidebar-team">{me.team.name}</span>
      </button>
      {open && (
        <div ref={menu} role="menu" aria-label={me.team.name} aria-describedby={host ? addressId : undefined} className="absolute top-2 left-full z-30 ml-2 w-64 rounded-xl border border-line bg-surface p-1.5 shadow-lg" data-testid="team-dropdown">
          {/* the team, as a new device would look for it: its logo, its whole name (the button above may cut it) and its
              address (Settings › 앱 has the copy button) */}
          <div className="flex items-center gap-2.5 px-2.5 pt-1 pb-2" data-testid="team-menu-head">
            <TeamLogo className="size-8 rounded-lg" />
            <span className="min-w-0">
              <span className="line-clamp-3 text-sm font-semibold break-words text-ink" data-testid="team-menu-name">{me.team.name}</span>
              {host && <span id={addressId} className="block truncate text-xs text-muted" data-testid="team-menu-address">{host}</span>}
            </span>
          </div>
          <div role="separator" className="mx-1 mb-1.5 border-t border-line" />
          {admin && (
            <>
              <button
                role="menuitem"
                type="button"
                className={item}
                onClick={() => {
                  hide(true)
                  void openTeamInvite(navigate, button.current)
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
            </>
          )}
          {canSwitch && (
            <>
              {admin && <div role="separator" className="mx-1 my-1.5 border-t border-line" />}
              <button
                role="menuitem"
                type="button"
                className={item}
                onClick={() => {
                  hide(true)
                  switchTeam()
                }}
                data-testid="team-menu-switch"
              >
                <ArrowLeftRight size={16} className="text-muted" aria-hidden /> {t('teamMenu.switch')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** The invite dialog, one for the window: open while `open`, the keyboard back on `returnTo` when it closes. */
const useTeamInvite = create<{ open: boolean; returnTo: HTMLElement | null }>(() => ({ open: false, returnTo: null }))

/** "Invite people" (the team menu, ⌘K): the owner's own invite step while the welcome steps are unfinished, else the
 * invite dialog. `returnTo`: where the keyboard goes when the dialog closes (null: where it was when it opened). */
export async function openTeamInvite(navigate: NavigateFunction, returnTo: HTMLElement | null) {
  const session = useSession.getState().status
  const owner = session.kind === 'signed-in' && isOwner(session.me)
  const computer = typeof matchMedia === 'function' && matchMedia('(min-width: 768px)').matches
  // the owner's progress not read yet (a click right after the page loaded, before the setup row read it): read it first;
  // a failed read opens the dialog
  if (owner && !useWelcome.getState().loaded) await useWelcome.getState().load().catch(() => {})
  // a new history entry each time, so the steps already on screen open their invite step too (pages/Welcome.tsx)
  if (owner && showResume(useWelcome.getState().progress, computer)) return void navigate('/welcome', { state: INVITE_STEP_STATE })
  useTeamInvite.setState({ open: true, returnTo })
}

const closeInvite = () => useTeamInvite.setState({ open: false, returnTo: null })

export function TeamInviteDialog() {
  const { open, returnTo } = useTeamInvite()
  const { pathname } = useLocation()
  // another page (a link in the dialog: 스킬 넣기, 팀 파일 넣기; ⇧⌘O) closes it, and so does a new mount (signed out and
  // in again): it never stays over a page it was not opened on
  useEffect(closeInvite, [pathname])
  if (!open) return null
  return <InvitePeople returnTo={returnTo} onClose={closeInvite} />
}

/** "Invite people" (docs/DECISIONS.md "Guests from Invite people"): Team member (picked first: the team link's message,
 * InviteStep, as before) or Guest, the same Guest half as Admin › Invite to team (components/GuestInviteChoice.tsx): one
 * line, the one place they join, then the rooms' and projects' guest invite form, whose Cancel comes back here. Opened
 * fresh each time, so it always starts on Team member. */
function InvitePeople({ returnTo, onClose }: { returnTo: HTMLElement | null; onClose: () => void }) {
  const t = useT()
  const admin = isAdmin(useMeStrict())
  const [kind, setKind] = useState<InviteKind>('member')
  const kinds = useId()
  const guest = kind === 'guest'
  const choice = useGuestChoice(guest)
  if (choice.place) return <GuestChoiceForm choice={choice} onDone={onClose} />
  return (
    <Modal open onClose={onClose} title={t('teamMenu.invite')} width={560} returnTo={returnTo}>
      <InviteKindTabs value={kind} onChange={setKind} panels={kinds} />
      {guest ? (
        <div className="space-y-4">
          <GuestChoicePanel choice={choice} panels={kinds} admin={admin} />
          {/* where the Team member half has Done: the same row under the content */}
          <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
            <GuestChoiceButtons choice={choice} admin={admin} onClose={onClose} />
          </div>
        </div>
      ) : (
        <TabPanel base={kinds} value="member">
          <InviteStep title={null} onDone={onClose} guestLine={false} />
        </TabPanel>
      )}
    </Modal>
  )
}
