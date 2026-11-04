// Small helpers shared by the admin screens.
import clsx from 'clsx'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
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

/**
 * Run an admin action and toast its error. The answer, or undefined when it failed. Only for actions that answer with
 * something: an empty answer (a 204, such as a delete) is undefined too, so it cannot be told from a failure. Those
 * use useActionOk; the type refuses them here.
 */
export function useAction() {
  const t = useT()
  const locale = useLocale()
  return async <T extends {} | null>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
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

/** Run an admin action and toast its error: true when it worked, false when it failed. For any answer, empty or not. */
export function useActionOk() {
  const t = useT()
  const locale = useLocale()
  return async (fn: () => Promise<unknown>, ok?: string): Promise<boolean> => {
    try {
      await fn()
      if (ok) toast({ level: 'success', text: ok })
      return true
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      return false
    }
  }
}

/**
 * Keyboard focus after a row was deleted: the row's own button is gone, so focus would fall back to the page. Call
 * `removed(index)` once the delete worked, before the list loads again. When the list shows its new data, focus moves to
 * the row now at that place (the next one, or the last), else to `fallback`. A row marks the control that takes focus
 * with `data-row-focus`; `box` holds the list. Focus that is still on the page (someone moved on) stays where it is.
 * A delete without a confirm dialog never marks the next row's delete: a held Enter would go on deleting row after row.
 */
export function useFocusAfterRemove(data: unknown, fallback: () => HTMLElement | null) {
  const box = useRef<HTMLDivElement>(null)
  const pending = useRef<number | null>(null)
  const fallbackRef = useRef(fallback)
  fallbackRef.current = fallback
  useLayoutEffect(() => {
    const i = pending.current
    if (i === null) return
    pending.current = null
    const a = document.activeElement
    if (a && a !== document.body && a.isConnected) return
    const rows = [...(box.current?.querySelectorAll<HTMLElement>('[data-row-focus]') ?? [])]
    ;(rows[Math.min(i, rows.length - 1)] ?? fallbackRef.current())?.focus()
  }, [data])
  return { box, removed: (index: number) => { pending.current = index } }
}

/**
 * A row action that runs at once, with no confirm dialog (delete a usage limit, revoke an invite): one at a time on the
 * screen. `busy` is the key of the one running, for aria-disabled on its button. Not `disabled`: a disabled button loses
 * the keyboard focus to the page, and it would stay there when the action fails.
 */
export function useOneAtATime<K>() {
  const running = useRef<K | null>(null)
  const [busy, setBusy] = useState<K | null>(null)
  const run = async (key: K, fn: () => Promise<void>) => {
    if (running.current !== null) return
    running.current = key
    setBusy(key)
    try {
      await fn()
    } finally {
      running.current = null
      setBusy(null)
    }
  }
  return { busy, run }
}

/** headingRef: the title takes the focus (tabIndex -1) when a list has no row left to focus, see useFocusAfterRemove */
export function Card({ title, actions, children, desc, headingRef }: { title: ReactNode; actions?: ReactNode; children: ReactNode; desc?: ReactNode; headingRef?: Ref<HTMLHeadingElement> }) {
  return (
    <section className="mb-6 rounded-2xl border border-line bg-surface">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        {/* a phone: the title and its line take the whole row and the buttons go under them, so the line is not cut
            to a few words */}
        <div className="min-w-0 flex-1 max-sm:basis-full">
          <h2 ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="text-sm font-semibold">{title}</h2>
          {desc && <OneLine className="mt-0.5 text-xs text-muted" twoOnPhone>{desc}</OneLine>}
        </div>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

/** An explanation kept to one line; "More" opens the rest when it does not fit (and "Less" closes it again). The whole
 * text stays in the page, so a screen reader reads all of it either way. twoOnPhone: 2 lines below 640 px (a card
 * header, where one line holds only a few words). */
export function OneLine({ children, className, testId, twoOnPhone }: { children: ReactNode; className?: string; testId?: string; twoOnPhone?: boolean }) {
  const t = useT()
  const ref = useRef<HTMLParagraphElement>(null)
  const [open, setOpen] = useState(false)
  const [cut, setCut] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || open) return
    // cut sideways (one line) or below (the 2-line clamp)
    const measure = () => setCut(el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [children, open])
  return (
    <div className={clsx('flex items-baseline gap-1.5', className)} data-testid={testId}>
      {/* inline-size containment: a line that does not wrap must not widen what holds it (a grid cell, a fieldset) */}
      <p ref={ref} className={clsx('min-w-0 flex-1 [contain:inline-size]', !open && (twoOnPhone ? 'max-sm:line-clamp-2 sm:truncate' : 'truncate'))}>
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
