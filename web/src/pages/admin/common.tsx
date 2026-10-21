// Small helpers shared by the admin screens.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { toast } from '../../store/ui'
import { ErrorNote, Skeleton } from '../../components/ui'

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const t = useT()
  const locale = useLocale()
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    try {
      setData(await fn())
      setError(null)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => {
    void reload()
  }, [reload])
  return { data, error, reload, setData }
}

export function Loadable<T>({ state, children, lines = 4 }: { state: { data: T | null; error: string | null; reload: () => Promise<void> }; children: (d: T) => ReactNode; lines?: number }) {
  if (state.error) return <ErrorNote onRetry={() => void state.reload()}>{state.error}</ErrorNote>
  if (state.data === null) return <Skeleton lines={lines} />
  return <>{children(state.data)}</>
}

/** Run an admin action and toast its error. */
export function useAction() {
  const t = useT()
  const locale = useLocale()
  return async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    try {
      const r = await fn()
      if (ok) toast({ level: 'success', text: ok })
      return r
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      return undefined
    }
  }
}

export function Card({ title, actions, children, desc }: { title: ReactNode; actions?: ReactNode; children: ReactNode; desc?: ReactNode }) {
  return (
    <section className="mb-6 rounded-2xl border border-line bg-surface">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{title}</h2>
          {desc && <p className="mt-0.5 text-xs text-muted">{desc}</p>}
        </div>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

/** Shown once (temporary passwords, invite links): copy it now, it is not shown again. */
export function SecretBox({ label, value, note, testId = 'secret-value', large }: { label: string; value: string; note?: string; testId?: string; large?: boolean }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted">{label}</p>
      <div className="flex items-center gap-2 rounded-lg border border-line bg-subtle px-3 py-2">
        {/* white-space kept, so what is shown is exactly what is copied */}
        <code className={`min-w-0 flex-1 font-mono break-all whitespace-pre-wrap select-all ${large ? 'text-xl font-semibold tracking-wide' : 'text-sm'}`} data-testid={testId}>
          {value}
        </code>
      </div>
      {note && <p className="text-xs text-warn">{note}</p>}
    </div>
  )
}
