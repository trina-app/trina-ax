// The account menu at the bottom of the computer's sidebar (docs/DECISIONS.md "The team menu": the team on top, me at
// the bottom). Moved out of Sidebar.tsx unchanged so the navigation redesign's rail (docs/AGENTS/plan/
// 20261112-1839-nav-rail.md, phase P0b) can use the same menu; Sidebar.tsx imports it.
import clsx from 'clsx'
import { ChevronDown, Gauge, LogOut, Settings, Smile, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { errorText } from '../../lib/api'
import { useLogout } from '../../lib/logout'
import { useLocale, useT } from '../../i18n'
import { useMeStrict, useSession } from '../../store/session'
import { toast, useUi } from '../../store/ui'
import { PresenceDot, PresenceFace, PresenceText } from '../Presence'
import { openStatusDialog, StatusEmoji, useMyStatusWords } from '../StatusMessage'
import { settingsOpenedFrom } from '../settings/SettingsDialog'

/** The profile line at the bottom and its menu above it, like Claude's: who is signed in, then "자리 비움으로 표시" ("접속
 * 중으로 표시" while set: Slack's "Set yourself as away", docs/DECISIONS.md "접속 상태"; its mark is the dot it leads to),
 * Settings (a dialog over the page, components/settings/SettingsDialog.tsx), Usage (their own usage in Settings; the
 * team's is Admin > Usage), Deleted chats and Sign out. The theme is not here, it is chosen in Settings. My picture carries my
 * own online dot, as the team sees it. Arrow keys, Home and End move in the menu; Esc closes it and gives the keyboard
 * back. */
export function AccountMenu() {
  const t = useT()
  const me = useMeStrict()
  const [open, setOpen] = useState(false)
  const setDrawer = useUi((s) => s.setDrawer)
  const navigate = useNavigate()
  const ref = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const hide = (focusBack: boolean) => {
    setOpen(false)
    if (focusBack) button.current?.focus()
  }
  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
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
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
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
  const logout = useLogout()
  const locale = useLocale()
  const away = !!me.user.prefs.away
  const status = useMyStatusWords()
  const toggleAway = () => {
    hide(true)
    void useSession.getState().setAway(!away).catch((e) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) }))
  }
  const item = 'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-ink hover:bg-hover focus-visible:-outline-offset-2'
  return (
    <div ref={ref} className="relative border-t border-line p-2" onKeyDown={onKey}>
      {open && (
        <div ref={menu} role="menu" aria-label={me.user.name} className="absolute right-2 bottom-full left-2 z-30 mb-1 rounded-xl border border-line bg-surface p-1.5 shadow-lg" data-testid="account-dropdown">
          <p className="truncate px-2.5 pt-1 pb-1.5 text-xs text-faint" data-testid="account-who">
            {me.user.email || me.user.username}
          </p>
          <button role="menuitem" type="button" className={clsx(item, '[--presence-bg:var(--c-surface)] hover:[--presence-bg:var(--c-hover)]')} onClick={toggleAway} data-testid="account-away">
            <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
              <PresenceDot state={away ? 'online' : 'away'} size={10} />
            </span>
            {away ? t('presence.setActive') : t('presence.setAway')}
          </button>
          {/* my status message (docs/DECISIONS.md "상태 메시지"): what it says now, or "Set your status" */}
          <button
            role="menuitem"
            type="button"
            className={item}
            onClick={() => {
              const from = button.current
              hide(false)
              openStatusDialog(from)
            }}
            data-testid="account-status"
          >
            <span className="flex size-4 shrink-0 items-center justify-center leading-none" aria-hidden>
              {status ? status.emoji : <Smile size={16} className="text-muted" />}
            </span>
            <span className="truncate">{status ? status.words : t('status.set')}</span>
          </button>
          <button
            role="menuitem"
            type="button"
            className={item}
            onClick={() => {
              settingsOpenedFrom(button.current)
              hide(false)
              setDrawer(false)
              navigate('/settings')
            }}
            data-testid="account-settings"
          >
            <Settings size={16} className="text-muted" aria-hidden /> {t('sidebar.settings')}
          </button>
          <button
            role="menuitem"
            type="button"
            className={item}
            onClick={() => {
              settingsOpenedFrom(button.current)
              hide(false)
              setDrawer(false)
              navigate('/settings/usage')
            }}
            data-testid="account-usage"
          >
            <Gauge size={16} className="text-muted" aria-hidden /> {t('sidebar.usage')}
          </button>
          <Link
            role="menuitem"
            to="/trash"
            onClick={() => {
              hide(false)
              setDrawer(false)
            }}
            className={item}
            data-testid="account-trash"
          >
            <Trash2 size={16} className="text-muted" aria-hidden /> {t('sidebar.trash')}
          </Link>
          <div role="separator" className="mx-1 my-1.5 border-t border-line" />
          <button role="menuitem" type="button" onClick={logout} className={item} data-testid="logout">
            <LogOut size={16} className="text-muted" aria-hidden /> {t('auth.logout')}
          </button>
        </div>
      )}
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={(e) => {
          // a click on my status emoji opens the status dialog (the menu has the same as its item, for the keyboard)
          if ((e.target as HTMLElement).closest?.('[data-testid="status-emoji"]')) return openStatusDialog(button.current)
          if (open) hide(false)
          else setOpen(true)
        }}
        className="flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left [--presence-bg:var(--c-subtle)] hover:bg-hover hover:[--presence-bg:var(--c-hover)]"
        data-testid="account-menu"
      >
        <PresenceFace user={me.user} size={24} />
        {/* the team's name is on top of the sidebar (a computer), not said twice here */}
        <span className="flex min-w-0 flex-1 items-baseline gap-1">
          <span className="truncate text-sm font-medium">{me.user.name}</span>
          <StatusEmoji userId={me.user.id} className="ml-0.5 self-center text-sm" />
          <PresenceText userId={me.user.id} />
        </span>
        <ChevronDown size={14} className={clsx('shrink-0 text-faint transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
    </div>
  )
}
