// ⌘/Ctrl+K: search own chats by title and content (GET /api/chats?q=). Arrow keys move, Enter opens.
import clsx from 'clsx'
import { MessageSquare, Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Chat } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { formatRelative } from '../lib/format'
import { useLocale, useT } from '../i18n'
import { useUi } from '../store/ui'
import { useFocusTrap } from './ui'

export default function SearchDialog() {
  const open = useUi((s) => s.searchOpen)
  const setOpen = useUi((s) => s.setSearchOpen)
  if (!open) return null
  return <SearchBox onClose={() => setOpen(false)} />
}

function SearchBox({ onClose }: { onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  const ref = useRef<HTMLDivElement>(null)
  const [q, setQ] = useState('')
  const [items, setItems] = useState<Chat[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState(0)
  useFocusTrap(ref, true, onClose)

  useEffect(() => {
    let live = true
    const ctrl = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const page = await api.call(API.listChats, { query: { q: q.trim() || undefined, limit: 30 }, signal: ctrl.signal })
        if (live) {
          setItems(page.items)
          setError(null)
          setSel(0)
        }
      } catch (e) {
        if (live && !ctrl.signal.aborted) setError(errorText(e, locale, t('error.network')))
      }
    }, q ? 200 : 0)
    return () => {
      live = false
      ctrl.abort()
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  const go = (c: Chat) => {
    onClose()
    navigate(`/c/${c.id}`)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onMouseDown={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={t('search.title')} className="w-full max-w-xl overflow-hidden rounded-2xl bg-surface shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search size={18} className="text-faint" aria-hidden />
          <input
            data-autofocus
            role="combobox"
            aria-expanded
            aria-controls="search-results"
            aria-activedescendant={items?.[sel] ? `sr-${items[sel]!.id}` : undefined}
            className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
            placeholder={t('search.placeholder')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (!items?.length) return
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((s) => Math.min(items.length - 1, s + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((s) => Math.max(0, s - 1))
              } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                go(items[sel]!)
              }
            }}
          />
        </div>
        <ul id="search-results" role="listbox" className="scroll-thin max-h-[50vh] overflow-y-auto p-2">
          {error && <li className="px-3 py-2 text-sm text-danger">{error}</li>}
          {items && !items.length && <li className="px-3 py-6 text-center text-sm text-faint">{t('search.none')}</li>}
          {items?.map((c, i) => (
            <li key={c.id} id={`sr-${c.id}`} role="option" aria-selected={i === sel}>
              <button type="button" onMouseEnter={() => setSel(i)} onClick={() => go(c)} className={clsx('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm', i === sel && 'bg-hover')}>
                <MessageSquare size={15} className="shrink-0 text-faint" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{c.title || t('chat.untitled')}</span>
                <span className="shrink-0 text-xs text-faint">{formatRelative(c.updatedAt, locale)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
