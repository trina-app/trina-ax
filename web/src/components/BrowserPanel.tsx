// Desktop app only: the frame of the in-app Browser pane (tabs, address bar, site permission prompts). The page
// itself is a native view the shell draws over the empty slot, so the person can use it directly too.
// Ported from Saram / chat-proto BrowserPanel.
import clsx from 'clsx'
import { ArrowLeft, ArrowRight, Globe, Loader2, Lock, Plus, RotateCw, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { desktop, type PaneState, type PanePermissionRequest, type PermissionDecision } from '../lib/desktop'
import { useT, type MessageKey } from '../i18n'
import { IconButton } from './ui'

const ACTION: Record<string, MessageKey> = {
  read_page: 'browser.action.read',
  get_page_text: 'browser.action.read',
  find: 'browser.action.find',
  computer: 'browser.action.computer',
  form_input: 'browser.action.form',
  javascript_tool: 'browser.action.script',
  read_console_messages: 'browser.action.console',
  read_network_requests: 'browser.action.network',
}

export default function BrowserPanel({ onClose }: { onClose: () => void }) {
  const t = useT()
  const app = desktop()
  if (!app)
    return (
      <aside className="flex h-full flex-col bg-surface">
        <header className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="text-sm font-semibold">{t('browser.title')}</span>
          <IconButton label={t('common.close')} onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>
        <p className="p-6 text-sm text-muted">{t('browser.desktopOnly')}</p>
      </aside>
    )
  return <Pane onClose={onClose} />
}

function Pane({ onClose }: { onClose: () => void }) {
  const t = useT()
  const app = desktop()!
  const [state, setState] = useState<PaneState>({ open: true, tabs: [], driving: false })
  const [url, setUrl] = useState<string | null>(null)
  const [asks, setAsks] = useState<PanePermissionRequest[]>([])
  const slot = useRef<HTMLDivElement>(null)

  useEffect(() => {
    app.pane.setVisible(true)
    void app.pane.getState().then((s) => s && setState(s))
    const offs = [
      app.pane.onState(setState),
      app.pane.onPermission((req) => setAsks((a) => [...a, req])),
      app.pane.onPermissionResolved(({ id }) => setAsks((a) => a.filter((r) => r.id !== id))),
    ]
    return () => {
      for (const off of offs) off()
      app.pane.setBounds(null)
      app.pane.setVisible(false)
    }
  }, [app])

  const ask = asks[0]
  // keep the native page exactly over the slot
  useLayoutEffect(() => {
    const el = slot.current
    if (!el) return
    const report = () => {
      const r = el.getBoundingClientRect()
      app.pane.setBounds({ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [app, ask])

  const active = state.tabs.find((x) => x.tabId === state.activeTabId)
  const answer = (decision: PermissionDecision) => {
    if (!ask) return
    app.pane.answerPermission(ask.id, decision)
    setAsks((a) => a.slice(1))
  }
  const opening = ask && (ask.tool === 'navigate' || ask.tool === 'preview_start')

  return (
    <aside aria-label={t('browser.title')} className="flex h-full min-w-0 flex-col bg-surface">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Globe size={16} className="text-muted" aria-hidden />
        <span className="text-sm font-semibold">{t('browser.title')}</span>
        {state.driving && (
          <span className="flex items-center gap-1.5 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent-text" role="status">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
            {t('browser.driving')}
          </span>
        )}
        <IconButton className="ml-auto" label={t('common.close')} onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>

      <div className="flex items-end gap-1 overflow-x-auto border-b border-line bg-subtle px-2 pt-1.5" role="tablist">
        {state.tabs.map((x) => (
          <div key={x.tabId} role="tab" aria-selected={x.tabId === state.activeTabId} className={clsx('group flex max-w-52 items-center gap-1 rounded-t-md border border-b-0 border-line px-2 py-1 text-xs', x.tabId === state.activeTabId ? 'bg-surface font-medium' : 'bg-hover text-muted')}>
            <button type="button" className="flex min-w-0 items-center gap-1 truncate" onClick={() => app.pane.selectTab(x.tabId)} title={x.url}>
              {x.popup && <Lock size={11} className="shrink-0" aria-hidden />}
              {x.loading && <Loader2 size={11} className="shrink-0 animate-spin" aria-hidden />}
              <span className="truncate">{x.title || x.url || t('browser.newTab')}</span>
            </button>
            <button type="button" className="text-faint hover:text-ink" onClick={() => app.pane.closeTab(x.tabId)} aria-label={t('browser.closeTab')}>
              <X size={12} />
            </button>
          </div>
        ))}
        <button type="button" className="mb-1 rounded p-1 text-muted hover:bg-hover" onClick={() => app.pane.newTab()} aria-label={t('browser.newTab')}>
          <Plus size={14} />
        </button>
      </div>

      <form
        className="flex items-center gap-0.5 border-b border-line px-2 py-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          if (url?.trim()) app.pane.navigate(url.trim())
          setUrl(null)
        }}
      >
        <IconButton label={t('browser.back')} onClick={() => app.pane.history('back')}>
          <ArrowLeft size={15} />
        </IconButton>
        <IconButton label={t('browser.forward')} onClick={() => app.pane.history('forward')}>
          <ArrowRight size={15} />
        </IconButton>
        <IconButton label={t('browser.reload')} onClick={() => app.pane.history('reload')}>
          <RotateCw size={14} />
        </IconButton>
        <input
          aria-label={t('browser.address')}
          className="ml-1 min-w-0 flex-1 rounded-full border border-line bg-subtle px-3 py-1 text-xs outline-none focus:border-line-strong"
          value={url ?? active?.url ?? ''}
          placeholder={t('browser.addressPlaceholder')}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => setUrl(null)}
        />
      </form>

      {ask && (
        <div className="border-b border-warn/30 bg-warn-soft p-3 text-sm" role="alertdialog" aria-label={t('browser.permission')}>
          <div className="font-medium text-ink">{opening ? t('browser.wantsOpen', { host: ask.host }) : t('browser.wantsDo', { action: t(ACTION[ask.tool] ?? 'browser.action.other'), host: ask.host })}</div>
          <div className="mt-0.5 truncate text-xs text-muted" title={ask.url}>
            {ask.url}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button type="button" className="rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-canvas" onClick={() => answer('once')}>
              {t('browser.allowOnce')}
            </button>
            <button type="button" className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium" onClick={() => answer('always')}>
              {t('browser.allowAlways')}
            </button>
            <button type="button" className="rounded-lg px-3 py-1.5 text-xs font-medium text-danger" onClick={() => answer('deny')}>
              {t('browser.deny')}
            </button>
          </div>
        </div>
      )}

      <div className={clsx('relative min-h-0 flex-1', state.driving && 'ring-4 ring-accent/50 ring-inset')}>
        <div ref={slot} className="absolute inset-1" />
        {!state.tabs.length && <p className="p-6 text-center text-sm text-faint">{t('browser.empty')}</p>}
      </div>
    </aside>
  )
}
