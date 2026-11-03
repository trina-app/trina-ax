// Small helpers shared by the admin screens.
import clsx from 'clsx'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { toast } from '../../store/ui'
import { Button, ErrorNote, Field, Modal, Skeleton, inputCls } from '../../components/ui'

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
          {desc && <OneLine className="mt-0.5 text-xs text-muted">{desc}</OneLine>}
        </div>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

/** An explanation kept to one line; "More" opens the rest when it does not fit (and "Less" closes it again). The whole
 * text stays in the page, so a screen reader reads all of it either way. */
export function OneLine({ children, className, testId }: { children: ReactNode; className?: string; testId?: string }) {
  const t = useT()
  const ref = useRef<HTMLParagraphElement>(null)
  const [open, setOpen] = useState(false)
  const [cut, setCut] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || open) return
    const measure = () => setCut(el.scrollWidth > el.clientWidth + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [children, open])
  return (
    <div className={clsx('flex items-baseline gap-1.5', className)} data-testid={testId}>
      {/* inline-size containment: a line that does not wrap must not widen what holds it (a grid cell, a fieldset) */}
      <p ref={ref} className={clsx('min-w-0 flex-1 [contain:inline-size]', !open && 'truncate')}>
        {children}
      </p>
      {(cut || open) && (
        <button type="button" aria-expanded={open} className="shrink-0 font-medium text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => setOpen(!open)}>
          {t(open ? 'common.less' : 'common.more')}
        </button>
      )}
    </div>
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

/** Ask for the owner's password again (update / restore / connection / owner transfer). */
export function ReauthDialog({ title, body, confirm, danger, onClose, onConfirm }: { title: string; body: React.ReactNode; confirm: string; danger?: boolean; onClose: () => void; onConfirm: (password: string) => Promise<void> }) {
  const t = useT()
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            busy={busy}
            disabled={!pw}
            onClick={async () => {
              setBusy(true)
              await onConfirm(pw)
              setBusy(false)
            }}
          >
            {confirm}
          </Button>
        </>
      }
    >
      <div className="mb-3 text-sm text-muted">{body}</div>
      <Field label={t('system.passwordAgain')}>
        <input data-autofocus className={inputCls} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </Field>
    </Modal>
  )
}
