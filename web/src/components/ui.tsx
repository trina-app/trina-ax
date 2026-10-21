// Shared building blocks. Every icon-only button takes an aria-label (translated); modals trap focus and give it
// back to where it was (tab 5 "접근성").
import clsx from 'clsx'
import { Check, Copy, Loader2, X } from 'lucide-react'
import { cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { create } from 'zustand'
import { useT } from '../i18n'
import { useUi } from '../store/ui'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
export function Button({ variant = 'secondary', size = 'md', busy, className, children, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-[13px] max-sm:min-h-9' : 'h-9 px-3.5 text-sm max-sm:min-h-10',
        variant === 'primary' && 'bg-accent text-accent-ink hover:bg-accent-hover',
        variant === 'secondary' && 'border border-line bg-surface text-ink hover:bg-hover',
        variant === 'ghost' && 'text-muted hover:bg-hover hover:text-ink',
        variant === 'danger' && 'border border-danger/40 bg-surface text-danger hover:bg-danger-soft',
        className,
      )}
    >
      {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
      {children}
    </button>
  )
}

export function IconButton({ label, className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label} {...props} className={clsx('inline-flex items-center justify-center rounded-md p-1.5 text-muted transition hover:bg-hover hover:text-ink disabled:opacity-40 max-sm:p-2', className)}>
      {children}
    </button>
  )
}

export const inputCls =
  'h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink outline-none transition placeholder:text-faint focus:border-line-strong focus:ring-2 focus:ring-accent/25 disabled:opacity-60 max-sm:min-h-10'

/** A labelled field. The hint / error sit outside the <label> (so they are not part of the field's name) and are
 * tied to the control with aria-describedby. */
export function Field({ label, children, hint, error }: { label: string; children: ReactNode; hint?: string; error?: string | null }) {
  const id = useId()
  const note = error || hint
  const control = note && isValidElement(children) ? cloneElement(children as React.ReactElement<{ 'aria-describedby'?: string; 'aria-invalid'?: boolean }>, { 'aria-describedby': id, 'aria-invalid': error ? true : undefined }) : children
  return (
    <div className="block">
      <label className="block">
        <span className="mb-1.5 block text-[13px] font-medium text-ink">{label}</span>
        {control}
      </label>
      {hint && !error && (
        <span id={id} className="mt-1 block text-xs text-faint">
          {hint}
        </span>
      )}
      {error && (
        <span id={id} role="alert" className="mt-1 block text-xs text-danger">
          {error}
        </span>
      )}
    </div>
  )
}

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span role="status" className={clsx('inline-flex items-center gap-2 text-sm text-faint', className)}>
      <Loader2 size={16} className="animate-spin" aria-hidden />
      {label && <span>{label}</span>}
    </span>
  )
}

export function Skeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={clsx('space-y-2', className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-subtle" style={{ width: `${90 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  )
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="text-faint">{icon}</div>}
      <p className="max-w-md font-medium text-balance text-ink">{title}</p>
      {children && <div className="max-w-md text-sm text-balance text-muted">{children}</div>}
    </div>
  )
}

export function ErrorNote({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  const t = useT()
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
      {/* at least ~12rem for the text: on a phone the button wraps below instead of squeezing it to a column */}
      <span className="min-w-0 flex-[1_1_12rem]">{children}</span>
      {onRetry && (
        <Button size="sm" variant="secondary" className="ml-auto" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  )
}

export function Badge({ tone = 'neutral', children, className }: { tone?: 'neutral' | 'accent' | 'warn' | 'danger' | 'ok'; children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap',
        tone === 'neutral' && 'bg-subtle text-muted',
        tone === 'accent' && 'bg-accent-soft text-accent-text',
        tone === 'warn' && 'bg-warn-soft text-warn',
        tone === 'danger' && 'bg-danger-soft text-danger',
        tone === 'ok' && 'bg-ok-soft text-ok',
        className,
      )}
    >
      {children}
    </span>
  )
}

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])'

/** Keep Tab inside `ref` while open; Esc calls onClose; focus returns to the opener on close. */
/** Open dialogs, innermost last: only the top one handles Esc / Tab / focus (a prompt over a picker, …). */
const trapStack: HTMLElement[] = []

export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useLayoutEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const el = ref.current
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE)
    if (el) trapStack.push(el) // before focusing, so the dialog below doesn't pull focus back
    ;(first ?? el)?.focus()
    const onTop = () => !!el && trapStack[trapStack.length - 1] === el
    const onKey = (e: KeyboardEvent) => {
      if (!onTop()) return
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
        return
      }
      if (e.key !== 'Tab' || !el) return
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement)
      if (!items.length) return
      const a = items[0]!
      const z = items[items.length - 1]!
      if (e.shiftKey && document.activeElement === a) {
        e.preventDefault()
        z.focus()
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault()
        a.focus()
      }
    }
    // something behind the dialog grabbing focus (an autofocus effect) gets it sent back
    const onFocusIn = (e: FocusEvent) => {
      if (onTop() && el && e.target instanceof Node && !el.contains(e.target)) (first ?? el).focus()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', onFocusIn)
      const i = el ? trapStack.lastIndexOf(el) : -1
      if (i >= 0) trapStack.splice(i, 1)
      prev?.focus?.()
    }
  }, [open, ref])
}

export function Modal({ open, onClose, title, children, width = 480, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; width?: number; footer?: ReactNode }) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useFocusTrap(ref, open, onClose)
  if (!open) return null
  return (
    // phones: a bottom sheet; tall content scrolls inside so the header and close button stay reachable
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex max-h-[92dvh] w-full flex-col rounded-t-2xl bg-surface text-ink shadow-xl outline-none sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line py-2.5 pr-2.5 pl-5 sm:py-3">
          <h2 id={titleId} className="min-w-0 font-semibold">
            {title}
          </h2>
          <IconButton label={t('common.close')} onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="scroll-thin min-h-0 overflow-y-auto overscroll-contain p-5">{children}</div>
        {footer && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>
  )
}

// ---------------- confirm / prompt dialogs (promise based) ----------------
type DialogReq =
  | { kind: 'confirm'; title: string; body?: ReactNode; confirm: string; danger?: boolean; resolve: (ok: boolean) => void }
  | { kind: 'prompt'; title: string; body?: ReactNode; label: string; initial: string; confirm: string; validate?: (v: string) => string | null; resolve: (v: string | null) => void }

const useDialogs = create<{ req: DialogReq | null; set: (r: DialogReq | null) => void }>((set) => ({ req: null, set: (req) => set({ req }) }))

export function confirmDialog(o: { title: string; body?: ReactNode; confirm: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => useDialogs.getState().set({ kind: 'confirm', ...o, resolve }))
}
export function promptDialog(o: { title: string; body?: ReactNode; label: string; initial?: string; confirm: string; validate?: (v: string) => string | null }): Promise<string | null> {
  return new Promise((resolve) => useDialogs.getState().set({ kind: 'prompt', initial: '', ...o, resolve }))
}

export function DialogHost() {
  const t = useT()
  const req = useDialogs((s) => s.req)
  const setReq = useDialogs((s) => s.set)
  const [value, setValue] = useState('')
  useEffect(() => {
    if (req?.kind === 'prompt') setValue(req.initial)
  }, [req])
  if (!req) return null
  const close = (ok: boolean) => {
    setReq(null)
    if (req.kind === 'confirm') req.resolve(ok)
    else req.resolve(ok ? value.trim() : null)
  }
  const problem = req.kind === 'prompt' ? req.validate?.(value) ?? null : null
  return (
    <Modal
      open
      onClose={() => close(false)}
      title={req.title}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant={req.kind === 'confirm' && req.danger ? 'danger' : 'primary'} disabled={req.kind === 'prompt' && (!value.trim() || !!problem)} onClick={() => close(true)} data-testid="dialog-confirm">
            {req.confirm}
          </Button>
        </>
      }
    >
      {req.body && <div className="mb-3 text-sm text-muted">{req.body}</div>}
      {req.kind === 'prompt' && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (value.trim() && !problem) close(true)
          }}
        >
          <Field label={req.label} error={value && problem ? problem : null}>
            <input data-autofocus className={inputCls} value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
        </form>
      )}
    </Modal>
  )
}

// ---------------- toasts ----------------
export function Toaster() {
  const t = useT()
  const toasts = useUi((s) => s.toasts)
  const dismiss = useUi((s) => s.dismiss)
  return (
    <div className="pointer-events-none fixed right-3 bottom-3 left-3 z-[60] flex flex-col items-end gap-2 sm:left-auto sm:w-96" aria-live="polite">
      {toasts.map((x) => (
        <div
          key={x.id}
          role={x.level === 'error' ? 'alert' : 'status'}
          className={clsx(
            'pointer-events-auto flex w-full items-start gap-2 rounded-xl border px-3 py-2.5 text-sm shadow-lg',
            x.level === 'error' ? 'border-danger/30 bg-danger-soft text-danger' : x.level === 'warn' ? 'border-warn/30 bg-warn-soft text-warn' : x.level === 'success' ? 'border-ok/30 bg-ok-soft text-ok' : 'border-line bg-surface text-ink',
          )}
        >
          <span className="min-w-0 flex-1 break-words">{x.text}</span>
          {x.action && (
            <button
              type="button"
              className="shrink-0 rounded-md px-2 py-0.5 font-medium underline underline-offset-2"
              onClick={() => {
                x.action!.run()
                dismiss(x.id)
              }}
            >
              {x.action.label}
            </button>
          )}
          <button type="button" aria-label={t('common.close')} className="shrink-0 opacity-70 hover:opacity-100" onClick={() => dismiss(x.id)}>
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  )
}

// ---------------- copy ----------------
export function useCopy(timeout = 1500) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        // older browsers / insecure contexts: a hidden textarea
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
      }
      setCopied(true)
      setTimeout(() => setCopied(false), timeout)
    },
    [timeout],
  )
  return { copied, copy }
}

export function CopyButton({ text, label, className, showLabel }: { text: string | (() => string); label?: string; className?: string; showLabel?: boolean }) {
  const t = useT()
  const { copied, copy } = useCopy()
  const l = copied ? t('common.copied') : label ?? t('common.copy')
  return (
    <button type="button" aria-label={l} title={l} onClick={() => void copy(typeof text === 'function' ? text() : text)} className={clsx('inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-faint transition hover:bg-hover hover:text-ink', className)}>
      {copied ? <Check size={13} className="text-ok" aria-hidden /> : <Copy size={13} aria-hidden />}
      {showLabel && <span>{l}</span>}
    </button>
  )
}

// ---------------- simple tabs ----------------
export function Tabs<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: { id: T; label: string }[]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto">
      {items.map((it) => (
        <button
          key={it.id}
          role="tab"
          type="button"
          aria-selected={value === it.id}
          onClick={() => onChange(it.id)}
          className={clsx('rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap', value === it.id ? 'bg-ink text-canvas' : 'text-muted hover:bg-hover')}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

/** Toggle switch with a real checkbox underneath (keyboard + screen readers). */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className={clsx('inline-flex cursor-pointer items-center gap-2 text-sm', disabled && 'cursor-not-allowed opacity-60')}>
      <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="relative h-5 w-9 shrink-0 rounded-full bg-line-strong/60 transition peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-accent after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-4" aria-hidden />
      <span>{label}</span>
    </label>
  )
}

// ---------------- page header ----------------
export function PageHeader({ title, desc, actions }: { title: ReactNode; desc?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line px-4 py-4 sm:px-6 sm:py-5">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {desc && <p className="mt-1 text-sm text-muted">{desc}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** Live region for short screen-reader status lines ("답변 생성 중" / "답변 완료"). */
const AnnounceCtx = createContext<(text: string) => void>(() => {})
export function AnnounceProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState('')
  return (
    <AnnounceCtx.Provider value={setText}>
      {children}
      <div role="status" aria-live="polite" className="sr-only">
        {text}
      </div>
    </AnnounceCtx.Provider>
  )
}
export const useAnnounce = () => useContext(AnnounceCtx)
