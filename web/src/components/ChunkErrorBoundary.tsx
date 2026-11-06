// Where a lazy part of the page failed to load (lib/chunk-reload.ts): a spinner while the page reloads for the current
// build, or a short line with a Reload button where it does not reload by itself (a reload a moment ago, something
// busy, the server out of reach). When a reload would lose something the person can finish (a message not sent yet, an
// upload, a recording), the line says so; the button keeps unsent messages' text as drafts first. Any other error goes
// on to the boundary above, as before.
import { Component, type ReactNode } from 'react'
import { useT } from '../i18n'
import { chunkReloading, isChunkLoadError, reloadForChunkError } from '../lib/chunk-reload'
import { keepUnsentAsDrafts, unfinishedWork } from '../lib/reload-guard'
import { Button, Spinner } from './ui'

/** decided: componentDidCatch has decided whether the page reloads (until then a spinner, so no button flashes up);
 * unsent: it did not, and something the person can finish is under way (reload-guard.ts unfinishedWork) */
interface State { error: unknown; decided: boolean; reloading: boolean; unsent?: boolean }

/** `resetKey`: when it changes (another page), the next render tries the children again; nothing is remounted otherwise */
export class ChunkErrorBoundary extends Component<{ children?: ReactNode; resetKey?: string }, State> {
  state: State = { error: null, decided: false, reloading: false }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    const reloading = chunkReloading()
    return { error, decided: reloading, reloading }
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error !== null && !this.state.reloading && prev.resetKey !== this.props.resetKey) this.setState({ error: null, decided: false })
  }

  componentDidCatch(error: unknown) {
    if (!isChunkLoadError(error)) return
    const reloading = reloadForChunkError(error)
    this.setState({ decided: true, reloading, unsent: !reloading && unfinishedWork() })
  }

  render() {
    const { error, decided, reloading, unsent } = this.state
    if (error === null) return this.props.children
    if (!isChunkLoadError(error)) throw error
    return <ChunkFallback reloading={reloading || !decided} unsent={!!unsent} />
  }
}

export function ChunkFallback({ reloading, unsent = false }: { reloading: boolean; unsent?: boolean }) {
  const t = useT()
  if (reloading) return <div className="flex h-full items-center justify-center p-6"><Spinner label={t('common.loading')} /></div>
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
      <p className="max-w-md text-sm text-muted">{t(unsent ? 'update.chunkUnsent' : 'update.chunkFailed')}</p>
      <Button onClick={() => { keepUnsentAsDrafts(); location.reload() }}>{t('update.reload')}</Button>
    </div>
  )
}
