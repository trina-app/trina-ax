// The account menu: my photo at the bottom of the rail (components/rail/Rail.tsx; docs/DECISIONS.md "The team menu":
// the team on top, me at the bottom).
import clsx from 'clsx'
import { LogOut, Settings, Smile } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { errorText } from '../../lib/api'
import { useLogout } from '../../lib/logout'
import { useLocale, useT } from '../../i18n'
import { useMeStrict, useSession } from '../../store/session'
import { toast } from '../../store/ui'
import { PresenceDot, PresenceFace, PresenceText } from '../Presence'
import { openStatusDialog, StatusEmoji, useMyStatusWords } from '../StatusMessage'
import { settingsOpenedFrom } from '../settings/SettingsDialog'

/** My photo and its menu to its right, like Claude's: my name, email and role, then "자리 비움으로 표시" ("접속 중으로
 * 표시" while set: Slack's "Set yourself as away", docs/DECISIONS.md "접속 상태"; its mark is the dot it leads to), my
 * status, Settings (a dialog over the page, components/settings/SettingsDialog.tsx) and Sign out. Usage is in Settings
 * and Deleted history at the end of the 트리나 list, so neither is repeated here (docs/AGENTS/plan/
 * 20261112-1839-nav-rail.md §2.1). The theme is not here, it is chosen in Settings. My picture carries my own online
 * dot, as the team sees it. Arrow keys, Home and End move in the menu; Esc closes it and gives the keyboard back. */
export function AccountMenu() {
  const t = useT()
  const me = useMeStrict()
  const [open, setOpen] = useState(false)
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
    <div ref={ref} className="relative flex justify-center px-1.5 py-2" onKeyDown={onKey}>
      {open && (
        <div ref={menu} role="menu" aria-label={me.user.name} className="absolute bottom-2 left-full z-30 ml-2 w-64 rounded-xl border border-line bg-surface p-1.5 shadow-lg" data-testid="account-dropdown">
          <div className="px-2.5 pt-1 pb-1.5" data-testid="account-who">
            <p className="truncate text-sm font-medium text-ink">{me.user.name}</p>
            <p className="truncate text-xs text-faint">{me.user.email || me.user.username}</p>
            <p className="truncate text-xs text-faint" data-testid="account-role">{t(`role.${me.user.role}` as 'role.member')}</p>
          </div>
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
              navigate('/settings')
            }}
            data-testid="account-settings"
          >
            <Settings size={16} className="text-muted" aria-hidden /> {t('sidebar.settings')}
          </button>
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
        onClick={() => (open ? hide(false) : setOpen(true))}
        className="relative flex size-11 items-center justify-center rounded-full [--presence-bg:var(--c-subtle)] hover:bg-hover hover:[--presence-bg:var(--c-hover)] aria-expanded:bg-hover"
        data-testid="account-menu"
        data-rail-stop=""
      >
        <PresenceFace user={me.user} size={32} />
        <span className="sr-only">{me.user.name}</span>
        <StatusEmoji userId={me.user.id} className="absolute -top-0.5 -right-0.5 text-xs leading-none" />
        <PresenceText userId={me.user.id} />
      </button>
    </div>
  )
}
