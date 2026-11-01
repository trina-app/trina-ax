// Where a lazy part of the page failed to load (lib/chunk-reload.ts): a spinner while the page reloads for the current
// build, or a short line with a Reload button where it does not reload by itself (a reload a moment ago, something
// busy). Any other error goes on to the boundary above, as before.
import { Component, type ReactNode } from 'react'
import { useT } from '../i18n'
import { chunkReloading, isChunkLoadError, reloadForChunkError } from '../lib/chunk-reload'
import { Button, Spinner } from './ui'

/** decided: componentDidCatch has decided whether the page reloads (until then a spinner, so no button flashes up) */
interface State { error: unknown; decided: boolean; reloading: boolean }

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
    this.setState({ decided: true, reloading: reloadForChunkError(error) })
  }

  render() {
    const { error, decided, reloading } = this.state
    if (error === null) return this.props.children
    if (!isChunkLoadError(error)) throw error
    return <ChunkFallback reloading={reloading || !decided} />
  }
}

export function ChunkFallback({ reloading }: { reloading: boolean }) {
  const t = useT()
  if (reloading) return <div className="flex h-full items-center justify-center p-6"><Spinner label={t('common.loading')} /></div>
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
      <p className="max-w-md text-sm text-muted">{t('update.chunkFailed')}</p>
      <Button onClick={() => location.reload()}>{t('update.reload')}</Button>
    </div>
  )
}
