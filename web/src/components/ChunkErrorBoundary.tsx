// Where a lazy part of the page failed to load (lib/chunk-reload.ts): a spinner while the page reloads for the current
// build, or a short line with a Reload button where it does not reload by itself (a reload a moment ago, something
// busy, the server out of reach). When a reload would lose something the person can finish (a message not sent yet, an
// upload, a recording), the line says so; the button keeps unsent messages' text as drafts first. Any other error goes
// on to the boundary above, as before.
// Out of reach (the live connection down, the browser offline: a page opened then cannot load its part): the line says
// it loads by itself once the connection is back, and when the live connection is open again it asks the same reload
// again (QA TC-231: it waited for a click). Nothing is lost for it: while a reload would lose something (a draft, an
// upload, a message not sent, an answer that was streaming when the connection dropped and ends a moment after it is
// back) it asks again every few seconds, as the update watcher does; when one was made a moment ago (the guard) the
// button stays.
import { Component, type ReactNode } from 'react'
import { useT } from '../i18n'
import { chunkReloadAllowed, chunkReloading, isChunkLoadError, reloadForChunkError } from '../lib/chunk-reload'
import { keepUnsentAsDrafts, mayReloadNow, serverUnreachable, unfinishedWork } from '../lib/reload-guard'
import { useUi } from '../store/ui'
import { Button, Spinner } from './ui'

/** decided: componentDidCatch has decided whether the page reloads (until then a spinner, so no button flashes up);
 * unsent: it did not, and something the person can finish is under way (reload-guard.ts unfinishedWork); offline: it did
 * not because the server was out of reach, and it reloads by itself once the connection is back (nothing to finish
 * first, the guard allows it) */
interface State { error: unknown; decided: boolean; reloading: boolean; unsent?: boolean; offline?: boolean }

/** `resetKey`: when it changes (another page), the next render tries the children again; nothing is remounted otherwise */
export class ChunkErrorBoundary extends Component<{ children?: ReactNode; resetKey?: string }, State> {
  state: State = { error: null, decided: false, reloading: false }
  /** after the connection is back, how long it waits before asking again while something would be lost */
  static retryMs = 3_000
  /** stops waiting for the live connection or for the next ask (set while it waits) */
  private unwatch: (() => void) | null = null

  static getDerivedStateFromError(error: unknown): Partial<State> {
    const reloading = chunkReloading()
    return { error, decided: reloading, reloading }
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error !== null && !this.state.reloading && prev.resetKey !== this.props.resetKey) {
      this.stopWaiting()
      this.setState({ error: null, decided: false, offline: false })
    }
  }

  componentDidCatch(error: unknown) {
    if (!isChunkLoadError(error)) return
    const reloading = reloadForChunkError(error)
    const away = !reloading && serverUnreachable()
    const unsent = !reloading && unfinishedWork()
    // "loads by itself once the connection is back": only when it will (nothing to finish first, the guard allows one)
    this.setState({ decided: true, reloading, unsent, offline: away && !unsent && chunkReloadAllowed() })
    if (away) this.waitForConnection()
  }

  componentWillUnmount() {
    this.stopWaiting()
  }

  /** the live connection open again (and the browser online): the same reload is asked again (the guard decides, as on
   * the first try) */
  private waitForConnection() {
    this.stopWaiting()
    const check = () => { if (useUi.getState().conn === 'open' && !serverUnreachable()) this.reconnected() }
    const off = useUi.subscribe(check)
    const win = typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null
    win?.addEventListener('online', check)
    this.unwatch = () => { off(); win?.removeEventListener('online', check) }
  }

  private stopWaiting() {
    this.unwatch?.()
    this.unwatch = null
  }

  private reconnected() {
    this.stopWaiting()
    const { error, reloading } = this.state
    if (error === null || reloading) return
    const now = reloadForChunkError(error)
    this.setState({ reloading: now, unsent: !now && unfinishedWork(), offline: false })
    if (now || mayReloadNow()) return
    // held back: out of reach again, or something would be lost; asked again once that changes
    if (serverUnreachable()) return this.waitForConnection()
    const timer = setTimeout(() => this.reconnected(), ChunkErrorBoundary.retryMs)
    this.unwatch = () => clearTimeout(timer)
  }

  render() {
    const { error, decided, reloading, unsent, offline } = this.state
    if (error === null) return this.props.children
    if (!isChunkLoadError(error)) throw error
    return <ChunkFallback reloading={reloading || !decided} unsent={!!unsent} offline={!!offline} />
  }
}

export function ChunkFallback({ reloading, unsent = false, offline = false }: { reloading: boolean; unsent?: boolean; offline?: boolean }) {
  const t = useT()
  if (reloading) return <div className="flex h-full items-center justify-center p-6"><Spinner label={t('common.loading')} /></div>
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
      <p className="max-w-md text-sm text-muted">{t(unsent ? 'update.chunkUnsent' : offline ? 'update.chunkOffline' : 'update.chunkFailed')}</p>
      <Button onClick={() => { keepUnsentAsDrafts(); location.reload() }}>{t('update.reload')}</Button>
    </div>
  )
}
