// Settings as a dialog over the page it was opened from, like Claude's: the sections on the left (a search filters them
// by name, hairlines separate the groups of pages/settingsTabs.ts) and the open section on the right. /settings and
// /settings/<section> still work: App.tsx keeps the page behind it (Home when the address was opened directly) and
// `onClose` goes back to that page. On a phone it fills the screen: the list first, then a section with a way back.
// Admin stays its own page.
import clsx from 'clsx'
import { ArrowLeft, Search, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react'
import { Navigate, NavLink, useNavigate, useParams } from 'react-router-dom'
import { api, API } from '../../lib/api'
import { browserSettingsBridge } from '../../lib/desktop'
import { useT } from '../../i18n'
import { settingsTabs } from '../../pages/settingsTabs'
import { IconButton, Spinner, inputCls, menuOpener, useFocusTrap } from '../ui'

const SettingsPane = lazy(() => import('../../pages/Settings'))

let openedFrom: HTMLElement | null = null
/** What gets the keyboard back when the dialog closes, said by whatever opens it when that is not what has focus by
 * then (the account menu's Settings item is gone once the menu closes): the menu's button. */
export function settingsOpenedFrom(el: HTMLElement | null) {
  openedFrom = el
}

export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const { tab } = useParams()
  const navigate = useNavigate()
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  // focus goes back to what opened the dialog; a menu's item is gone by then, so the menu's button
  const [returnTo] = useState(() => {
    const el = openedFrom ?? menuOpener()
    openedFrom = null
    return el
  })
  useFocusTrap(ref, true, onClose, returnTo)
  // the page under the dialog is inert until it has closed, so the keyboard goes back once it is reachable again
  useEffect(() => () => void requestAnimationFrame(() => returnTo?.isConnected && returnTo.focus()), [returnTo])
  const [own, setOwn] = useState<boolean | null>(null)
  useEffect(() => {
    api.call(API.myCredentials).then((r) => setOwn(r.allowed || r.items.length > 0), () => setOwn(false))
  }, [])
  // the desktop app's site setting: only inside a desktop app that offers it (the value lives there)
  const tabs = settingsTabs(Boolean(browserSettingsBridge()), Boolean(own))
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const q = query.trim().toLowerCase()
  const shown = tabs.filter((x) => !q || t(x.label).toLowerCase().includes(q))
  const groups = [1, 2, 3].map((g) => shown.filter((x) => x.group === g)).filter((g) => g.length)
  const waiting = tab === 'credentials' && own === null
  // an old or mistyped address (/settings/devices), or /settings/browser outside the desktop app: the profile instead
  if (tab && !waiting && !tabs.some((x) => x.id === tab)) return <Navigate to="/settings" replace />
  const current = tab ?? 'profile'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 md:p-6" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex h-full w-full flex-col bg-surface text-ink shadow-xl outline-none [--sticky-bg:var(--c-surface)] md:h-[min(760px,100%)] md:max-w-[1040px] md:rounded-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="settings-dialog"
      >
        <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line pr-2.5 pl-3 md:pl-5">
          {tab && (
            <IconButton label={t('settings.allSections')} className="md:hidden" onClick={() => navigate('/settings', { replace: true })} data-testid="settings-back">
              <ArrowLeft size={18} />
            </IconButton>
          )}
          <h2 id={titleId} className="min-w-0 flex-1 truncate px-1 font-semibold">
            {t('settings.title')}
          </h2>
          <IconButton label={t('common.close')} onClick={onClose} data-testid="settings-close">
            <X size={18} />
          </IconButton>
        </div>
        <div className="flex min-h-0 flex-1">
          {/* phones: the list on its own until a section is open */}
          <div className={clsx('flex w-full shrink-0 flex-col md:w-64 md:border-r md:border-line', tab && 'max-md:hidden')}>
            <div className="px-3 pt-3 pb-2">
              <div className="relative">
                <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
                <input ref={searchRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('settings.search')} aria-label={t('settings.search')} className={`${inputCls} pl-9 ${query ? 'pr-9' : ''}`} data-testid="settings-search" data-own-clear />
                {/* the app's own clear button (the browser's one is hidden in index.css: data-own-clear); the focus goes back to the field */}
                {query && (
                  <IconButton label={t('picker.clearSearch')} className="absolute top-1/2 right-1 -translate-y-1/2" onClick={() => { setQuery(''); searchRef.current?.focus() }} data-testid="settings-search-clear">
                    <X size={14} aria-hidden />
                  </IconButton>
                )}
              </div>
            </div>
            <nav aria-label={t('settings.title')} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 pb-3" data-testid="settings-menu">
              {groups.map((g, i) => (
                <div key={g[0]!.group} className={clsx('space-y-0.5', i > 0 && 'mt-2 border-t border-line pt-2')}>
                  {g.map((x) => (
                    <NavLink
                      key={x.id}
                      to={`/settings/${x.id}`}
                      replace
                      className={({ isActive }) =>
                        clsx('flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm hover:bg-hover focus-visible:-outline-offset-2 max-md:h-11', (isActive || (x.id === 'profile' && !tab)) && 'md:bg-hover md:font-medium', isActive && 'bg-hover font-medium')
                      }
                    >
                      <x.icon size={16} className="shrink-0 text-muted" aria-hidden /> {t(x.label)}
                    </NavLink>
                  ))}
                </div>
              ))}
              {!shown.length && (
                <p className="px-3 py-2 text-sm text-muted" data-testid="settings-no-match">
                  {t('settings.noMatch', { q: query.trim() })}
                </p>
              )}
            </nav>
          </div>
          <div className={clsx('min-h-0 min-w-0 flex-1 overflow-y-auto', !tab && 'max-md:hidden')} data-testid="settings-content">
            <div className="mx-auto max-w-3xl p-4 sm:p-6">
              {waiting ? (
                <Spinner />
              ) : (
                <Suspense fallback={<Spinner />}>
                  <SettingsPane tab={current} />
                </Suspense>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
