// Shared building blocks. Every icon-only button takes an aria-label (translated); modals trap focus and give it
// back to where it was (tab 5 "접근성").
import clsx from 'clsx'
import { Check, ChevronDown, CircleAlert, Copy, Loader2, X } from 'lucide-react'
import { cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { useT } from '../i18n'
import { useUi } from '../store/ui'
import { writeRich } from '../lib/clipboard'
import { edgeFade } from '../lib/edgeFade'
import { Tooltip } from './Tooltip'
import { MenuButton } from './rooms/MenuButton'

/** A dialog goes into <body> through a portal; rendered to a string (no document, as in a unit test), it stays in place. */
const inBody = (node: ReactNode, body: Element | null) => (body ? createPortal(node, body) : node)

/** Inside it, below 768 px, every Button and IconButton is at least 44 px (Apple's minimum touch target) and a Switch
 * takes taps from a 44 px box around it: the form pages on a phone (Admin › Team settings and System, Settings' own
 * sections; docs/DECISIONS.md "Admin and Settings on phones"). Elsewhere buttons keep their sizes. */
export const PhoneTargets = createContext(false)

/** primary: the one main action; secondary (default): a bordered button; ghost: no border (also a plain "no": Deny on a
 * permission card, Skip, Reject of a suggestion, like Claude Code's "No"); danger: a destructive action with a border;
 * ghost-danger: a quiet destructive action beside others that removes or discards something (Delete a project, turn off
 * a grant), never a plain "no". Don't recolour a variant with className: the classes are not merged, and the variant's
 * own colour can win. */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ghost-danger'
export function Button({ variant = 'secondary', size = 'md', busy, className, children, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; busy?: boolean }) {
  const big = useContext(PhoneTargets)
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || busy}
      // busy disables; a caller that must keep the focus (an action that asks the server first) says busy itself
      aria-busy={busy || props['aria-busy'] || undefined}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-label' : 'h-9 px-3.5 text-sm',
        big ? 'max-md:min-h-11' : size === 'sm' ? 'max-sm:min-h-9' : 'max-sm:min-h-10',
        variant === 'primary' && 'bg-accent text-accent-ink hover:bg-accent-hover',
        // dark mode: the half-transparent accent turned a muddy brown with dim text; a disabled main button is neutral
        // (a busy one, with its spinner, keeps the accent: it is working, not off)
        variant === 'primary' && !busy && 'dark:disabled:bg-hover dark:disabled:text-faint dark:disabled:opacity-100 dark:disabled:hover:bg-hover',
        // the edge of a bordered button is what marks it as one on a card: --c-field-border (>= 3:1), not the hairline
        variant === 'secondary' && 'border border-field-border bg-surface text-ink hover:bg-hover',
        variant === 'ghost' && 'text-muted hover:bg-hover hover:text-ink',
        variant === 'danger' && 'border border-danger/70 bg-surface text-danger hover:bg-danger-soft',
        variant === 'ghost-danger' && 'text-danger hover:bg-danger-soft',
        className,
      )}
    >
      {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
      {children}
    </button>
  )
}

/** onKeyDown of a button that acts at once (a delete with no confirm dialog): a held Enter repeats keydown, and each
 * repeat would press the button again, or the next one the focus lands on. */
export const noKeyRepeat = (e: React.KeyboardEvent) => {
  if (e.repeat) e.preventDefault()
}

/** An icon-only button: `label` is its name (aria-label) and its tooltip (components/Tooltip.tsx), shown on hover and
 * keyboard focus. `tip`: other words for the tooltip, when the icon needs more than its name (they describe the button);
 * `tip={false}` only inside a <Tooltip> of its own. `danger`: a destructive icon action (Delete) that turns red on hover. */
export function IconButton({ label, danger, className, children, tip = true, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; danger?: boolean; tip?: boolean | string }) {
  const big = useContext(PhoneTargets)
  const button = (
    <button type="button" aria-label={label} {...props} className={clsx('inline-flex items-center justify-center rounded-md p-1.5 text-muted transition disabled:opacity-40 max-sm:p-2', big && 'max-md:min-h-11 max-md:min-w-11', danger ? 'hover:bg-danger-soft hover:text-danger' : 'hover:bg-hover hover:text-ink', className)}>
      {children}
    </button>
  )
  if (tip === false) return button
  return typeof tip === 'string' ? <Tooltip label={tip} description>{button}</Tooltip> : <Tooltip label={label}>{button}</Tooltip>
}

export const inputCls =
  'h-9 w-full rounded-lg border border-field-border bg-surface px-3 text-sm text-ink outline-none transition placeholder:text-faint focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-60 max-sm:min-h-10'

/** The title of a sidebar section (대화, 트리나 기록), which folds its list. A step under the rows (12px, 13px on phones;
 * rows are 14 / 15px) but heavier than them and than "더 보기" under a list, and in the main text colour (the owner,
 * 2026-11-07: the quiet grey titles ran the two lists together; type and space only, no fill); a date heading inside a
 * list stays lower (text-micro, 500, faint: smaller on computers, the same 13px on phones, where weight and colour set
 * it apart). The chevron stays quiet; hover shifts the colour one step, as before. It never shrinks or wraps: a long
 * filter label beside it is cut instead. */
export function SidebarSectionTitle({ open, onToggle, controls, children, testId }: { open: boolean; onToggle: () => void; controls: string; children: ReactNode; testId: string }) {
  return (
    <h2 className="shrink-0 text-xs font-semibold whitespace-nowrap text-ink">
      <button type="button" aria-expanded={open} aria-controls={controls} onClick={onToggle} className="flex items-center gap-1 rounded py-1 hover:text-muted" data-testid={testId}>
        {children}
        <ChevronDown size={12} className={clsx('text-faint transition-transform', !open && '-rotate-90')} aria-hidden />
      </button>
    </h2>
  )
}

/** A labelled field. The hint / error sit outside the <label> (so they are not part of the field's name) and are
 * tied to the control with aria-describedby. `aside` (a password field's eye button) sits over the control's right edge, outside the label, so
 * the control's name stays the label's words; the control then keeps room for it (pr-11). */
export function Field({ label, children, hint, error, aside }: { label: string; children: ReactNode; hint?: string; error?: ReactNode; aside?: ReactNode }) {
  const id = useId()
  const note = error || hint
  const control = note && isValidElement(children) ? cloneElement(children as React.ReactElement<{ 'aria-describedby'?: string; 'aria-invalid'?: boolean }>, { 'aria-describedby': id, 'aria-invalid': error ? true : undefined }) : children
  const labelled = (
    <label className="block">
      <span className="mb-1.5 block text-label font-medium text-ink">{label}</span>
      {control}
    </label>
  )
  return (
    <div className="block">
      {aside ? <div className="relative">{labelled}<div className="absolute right-0 bottom-0 flex h-9 items-center max-sm:h-10">{aside}</div></div> : labelled}
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

/** An error with an icon, the message in the body colour and an optional small detail (such as "HTTP 503") under it. */
export function ErrorNote({ children, onRetry, detail }: { children: ReactNode; onRetry?: () => void; detail?: ReactNode }) {
  const t = useT()
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-ink">
      {/* at least ~12rem for the text: on a phone the button wraps below instead of squeezing it to a column */}
      <span className="flex min-w-0 flex-[1_1_12rem] items-start gap-2">
        <CircleAlert size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden />
        <span className="min-w-0">
          {children}
          {detail && <span className="mt-0.5 block text-xs text-muted">{detail}</span>}
        </span>
      </span>
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
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro font-medium whitespace-nowrap',
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

/** Keep Tab inside `ref` while open; Esc calls onClose; focus returns to `returnTo` (when still in the page) or else
 *  to the opener on close. */
/** Open dialogs, innermost last: only the top one handles Esc / Tab / focus (a prompt over a picker, …). */
const trapStack: HTMLElement[] = []

export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, open: boolean, onClose: () => void, returnTo?: HTMLElement | null) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const returnRef = useRef(returnTo)
  returnRef.current = returnTo
  useLayoutEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const el = ref.current
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE)
    // the dialog below (Settings under a confirm) is out of reach while this one is open: inert, and hidden from
    // assistive technology, like the page behind a modal
    const below = trapStack[trapStack.length - 1]
    below?.setAttribute('inert', '')
    below?.setAttribute('aria-hidden', 'true')
    if (el) trapStack.push(el) // before focusing, so the dialog below doesn't pull focus back
    ;(first ?? el)?.focus()
    const onTop = () => !!el && trapStack[trapStack.length - 1] === el
    // Esc after the dialog's own controls had their say: one that closes or cancels something of its own (an edit
    // field, a menu) stops it, and the dialog stays open
    const onEscape = (e: KeyboardEvent) => {
      if (!onTop() || e.key !== 'Escape' || e.defaultPrevented) return
      e.stopPropagation()
      closeRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (!onTop()) return
      if (e.key !== 'Tab' || !el) return
      // not a part the dialog made inert meanwhile (the image viewer's file under a phone's sheet): focus cannot go there
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => (x.offsetParent !== null || x === document.activeElement) && !x.closest('[inert]'))
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
    // something behind the dialog grabbing focus (an autofocus effect) gets it sent back (to its first control still in
    // reach when the first one went inert)
    const onFocusIn = (e: FocusEvent) => {
      if (!onTop() || !el || !(e.target instanceof Node) || el.contains(e.target)) return
      const to = first && !first.closest('[inert]') ? first : [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].find((x) => x.offsetParent !== null && !x.closest('[inert]'))
      ;(to ?? el).focus()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('keydown', onEscape)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('keydown', onEscape)
      document.removeEventListener('focusin', onFocusIn)
      const i = el ? trapStack.lastIndexOf(el) : -1
      if (i >= 0) trapStack.splice(i, 1)
      if (below && !trapStack.slice(trapStack.indexOf(below) + 1).length) {
        below.removeAttribute('inert')
        below.removeAttribute('aria-hidden')
      }
      const back = returnRef.current
      ;(back?.isConnected ? back : prev)?.focus?.()
    }
  }, [open, ref])
}

export function Modal({ open, onClose, title, children, width = 480, footer, returnTo }: { open: boolean; onClose: () => void; title: string; children: ReactNode; width?: number; footer?: ReactNode; returnTo?: HTMLElement | null }) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useFocusTrap(ref, open, onClose, returnTo)
  if (!open) return null
  return (
    // in <body>, so a dialog opened from inside another dialog (Settings) is not inside it: the one below goes inert
    inBody(
    // phones: a bottom sheet; tall content scrolls inside so the header and close button stay reachable. With the
    // keyboard up it ends on the keyboard and is at most as high as what is left (lib/viewport.ts --kb-inset, --app-h:
    // iOS Safari keeps the fixed layer's bottom under the keyboard), its footer's buttons in sight. The image
    // viewer's level (ImageViewer.tsx): of the two, the one opened last is on top (each goes to the end of <body>), so a
    // confirm or Share to room from the viewer's column is over the viewer, and a picture opened from a dialog over it
    <div className="fixed inset-0 z-[55] flex items-end justify-center bg-black/40 max-sm:bottom-[var(--kb-inset,0px)] sm:items-center sm:p-4" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        // phones: below the status bar; without a footer the body keeps clear of the home indicator itself
        className={clsx('flex max-h-[min(calc(var(--app-h,100dvh)*0.92),calc(var(--app-h,100dvh)-var(--safe-top)-0.5rem))] w-full flex-col rounded-t-2xl bg-surface text-ink shadow-xl outline-none [--sticky-bg:var(--c-surface)] sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl', !footer && 'max-sm:pb-[var(--safe-bottom)]')}
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line py-2.5 pr-2.5 pl-5 max-sm:pr-3 max-sm:pl-4 sm:py-3">
          <h2 id={titleId} className="min-w-0 font-semibold">
            {title}
          </h2>
          <IconButton label={t('common.close')} onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="scroll-thin min-h-0 overflow-y-auto overscroll-contain p-5 max-sm:px-4">{children}</div>
        {footer && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3 pb-[max(0.75rem,var(--safe-bottom))] max-sm:px-4">{footer}</div>}
      </div>
    </div>,
    typeof document === 'undefined' ? null : document.body,
    )
  )
}

// ---------------- confirm / prompt dialogs (promise based) ----------------
type DialogReq = { returnTo: HTMLElement | null } & (
  | { kind: 'confirm'; title: string; body?: ReactNode; confirm: string; danger?: boolean; resolve: (ok: boolean) => void }
  | { kind: 'prompt'; title: string; body?: ReactNode; label: string; initial: string; select?: number; confirm: string; validate?: (v: string) => string | null; placeholder?: string; allowEmpty?: boolean; maxLength?: number; resolve: (v: string | null) => void }
)

const useDialogs = create<{ req: DialogReq | null; set: (r: DialogReq | null) => void }>((set) => ({ req: null, set: (req) => set({ req }) }))

/** A dialog opened from a menu item: the item unmounts when its menu closes, so focus would end on BODY (B-W41-2).
 *  Find the menu's trigger now, while the menu is still in the page: the expanded control beside the menu. */
export function menuOpener(): HTMLElement | null {
  const menu = document.activeElement?.closest<HTMLElement>('[role="menu"]')
  const btns = menu?.parentElement?.querySelectorAll<HTMLElement>('[aria-expanded="true"]') ?? []
  return [...btns].find((b) => !menu!.contains(b)) ?? null
}

export function confirmDialog(o: { title: string; body?: ReactNode; confirm: string; danger?: boolean }): Promise<boolean> {
  const returnTo = menuOpener()
  return new Promise((resolve) => useDialogs.getState().set({ kind: 'confirm', ...o, returnTo, resolve }))
}
/** `select`: the first characters of `initial` that start selected (a file name without its extension). `allowEmpty`:
 * an empty field may be saved too ('' comes back: a room's name, whose empty value is its own default, shown as the
 * `placeholder`). */
export function promptDialog(o: { title: string; body?: ReactNode; label: string; initial?: string; select?: number; confirm: string; validate?: (v: string) => string | null; placeholder?: string; allowEmpty?: boolean; maxLength?: number }): Promise<string | null> {
  const returnTo = menuOpener()
  return new Promise((resolve) => useDialogs.getState().set({ kind: 'prompt', initial: '', ...o, returnTo, resolve }))
}

export function DialogHost() {
  const t = useT()
  const req = useDialogs((s) => s.req)
  const setReq = useDialogs((s) => s.set)
  const [value, setValue] = useState(() => (req?.kind === 'prompt' ? req.initial : ''))
  const [touched, setTouched] = useState(false)
  // a new dialog starts from its own text in the first frame, so the field is focused (Modal) with it in place
  const [shownReq, setShownReq] = useState(req)
  if (shownReq !== req) {
    setShownReq(req)
    if (req?.kind === 'prompt') setValue(req.initial)
    setTouched(false)
  }
  const input = useRef<HTMLInputElement>(null)
  // after Modal focused the field (a child's layout effect runs first)
  useLayoutEffect(() => {
    if (req?.kind === 'prompt' && req.select !== undefined) input.current?.setSelectionRange(0, req.select)
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
      returnTo={req.returnTo}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant={req.kind === 'confirm' && req.danger ? 'danger' : 'primary'} disabled={req.kind === 'prompt' && ((!req.allowEmpty && !value.trim()) || !!problem)} onClick={() => close(true)} data-testid="dialog-confirm">
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
            setTouched(true)
            if ((req.allowEmpty || value.trim()) && !problem) close(true)
          }}
        >
          <Field label={req.label} error={value || touched ? problem : null}>
            <input ref={input} data-autofocus className={inputCls} value={value} placeholder={req.placeholder} maxLength={req.maxLength} onBlur={() => setTouched(true)} onChange={(e) => { setValue(e.target.value); setTouched(true) }} data-testid="dialog-input" />
          </Field>
        </form>
      )}
    </Modal>
  )
}

// ---------------- toasts ----------------
/** Phones: how far above the window's bottom edge the highest bottom bar starts (the tab bar, a message box: marked
 * data-bottom-bar), so toasts sit above it instead of over it. null on wider screens or with no bar on screen. While a
 * toast shows it is measured again, one frame after anything that can move the bars has settled: a resize of the
 * window or the visual viewport (the phone keyboard), a bar resizing, and the page changing under it (another route
 * mounts another bar). */
function useBottomBarLift(toasts: unknown[]) {
  const [lift, setLift] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!toasts.length) return
    let frame = 0
    let watched: HTMLElement[] = []
    let last: number | null | undefined
    const bars = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => later())
    const measure = () => {
      frame = 0
      const phone = typeof window.matchMedia === 'function' && !window.matchMedia('(min-width: 768px)').matches
      const els = phone ? [...document.querySelectorAll<HTMLElement>('[data-bottom-bar]')] : []
      // watch the bars only when they are other elements than before: observing again makes the observer report again,
      // which would measure again every frame
      if (els.length !== watched.length || els.some((el, i) => el !== watched[i])) {
        bars?.disconnect()
        for (const el of els) bars?.observe(el)
        watched = els
      }
      const tops = els.map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => r.top)
      const next = tops.length ? Math.max(0, window.innerHeight - Math.min(...tops)) : null
      if (next !== last) setLift((last = next))
    }
    // after layout has settled: a resize or a route change is measured on the next frame, not in the middle of it
    const later = () => { if (!frame) frame = requestAnimationFrame(measure) }
    measure()
    const page = typeof MutationObserver === 'undefined' ? null : new MutationObserver(later)
    page?.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', later)
    window.visualViewport?.addEventListener('resize', later)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      bars?.disconnect()
      page?.disconnect()
      window.removeEventListener('resize', later)
      window.visualViewport?.removeEventListener('resize', later)
    }
  }, [toasts])
  return lift
}

export function Toaster() {
  const t = useT()
  const toasts = useUi((s) => s.toasts)
  const dismiss = useUi((s) => s.dismiss)
  const lift = useBottomBarLift(toasts)
  return (
    <div
      className="pointer-events-none fixed right-3 bottom-[calc(0.75rem+var(--safe-bottom))] left-3 z-[60] flex flex-col items-end gap-2 sm:left-auto sm:w-96"
      style={lift === null ? undefined : { bottom: `calc(${lift}px + 0.5rem)` }}
      aria-live="polite"
    >
      {toasts.map((x) => (
        <div
          key={x.id}
          role={x.level === 'error' ? 'alert' : 'status'}
          className={clsx(
            'pointer-events-auto flex w-full gap-2 rounded-xl border px-3 py-2.5 text-sm shadow-lg',
            x.image || x.action?.primary ? 'items-center' : 'items-start',
            x.level === 'error' ? 'border-danger/30 bg-danger-soft text-danger' : x.level === 'warn' ? 'border-warn/30 bg-warn-soft text-warn' : x.level === 'success' ? 'border-ok/30 bg-ok-soft text-ok' : 'border-line bg-surface text-ink',
          )}
          data-testid="toast"
        >
          {x.image && <img src={x.image} alt="" className="mr-1 aspect-video w-[72px] shrink-0 rounded border border-line object-cover" data-testid="toast-image" />}
          <span className="min-w-0 flex-1 break-words">
            {x.text}
            {x.detail && <span className="block text-xs text-faint">{x.detail}</span>}
          </span>
          {x.action?.primary ? (
            <Button
              size="sm"
              variant="primary"
              className="shrink-0"
              onClick={() => {
                x.action!.run()
                dismiss(x.id)
              }}
              data-testid="toast-action"
            >
              {x.action.label}
            </Button>
          ) : x.action && (
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
          <Tooltip label={t('common.close')}>
            <button type="button" aria-label={t('common.close')} className="shrink-0 opacity-70 hover:opacity-100" onClick={() => dismiss(x.id)}>
              <X size={15} />
            </button>
          </Tooltip>
        </div>
      ))}
    </div>
  )
}

// ---------------- copy ----------------
export function useCopy(timeout = 1500) {
  const [copied, setCopied] = useState(false)
  // the mark's timer goes with the component (a copy that ends after it is gone sets nothing), and a new copy starts
  // it again
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    }
  }, [])
  const mark = useCallback(() => {
    if (!live.current) return
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      setCopied(false)
    }, timeout)
  }, [timeout])
  const copy = useCallback(
    /** `html`: formatted text as well (text/html beside the plain text, lib/clipboard.ts) */
    async (text: string, html?: string) => {
      if (html !== undefined) {
        await writeRich({ html, plain: text })
        mark()
        return
      }
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
      mark()
    },
    [mark],
  )
  return { copied, copy }
}

/** `html`: also put formatted text on the clipboard (an answer: lib/richCopy.tsx), made at the click */
export function CopyButton({ text, html, label, className, showLabel }: { text: string | (() => string); html?: () => string; label?: string; className?: string; showLabel?: boolean }) {
  const t = useT()
  const { copied, copy } = useCopy()
  const l = copied ? t('common.copied') : label ?? t('common.copy')
  const click = () => {
    const plain = typeof text === 'function' ? text() : text
    let rich: string | undefined
    // a failure to format still copies the text
    try { rich = html?.() } catch { rich = undefined }
    void copy(plain, rich)
  }
  const button = (
    <button type="button" aria-label={l} onClick={click} className={clsx('inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-faint transition hover:bg-hover hover:text-ink', className)}>
      {copied ? <Check size={13} className="text-ok" aria-hidden /> : <Copy size={13} aria-hidden />}
      {showLabel && <span>{l}</span>}
    </button>
  )
  // with its words shown it needs no tip
  return showLabel ? button : <Tooltip label={l}>{button}</Tooltip>
}

// ---------------- layout helpers ----------------
/** Whether a media query matches now, and again when it changes (a phone turned, a window resized). */
export function useMediaQuery(query: string) {
  const get = () => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches
  const [matches, setMatches] = useState(get)
  useEffect(() => {
    const mq = window.matchMedia?.(query)
    if (!mq) return
    const on = () => setMatches(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return matches
}

/** A row that scrolls sideways (class `edge-fade`): marks the edges that have more behind them (data-fade-start,
 * data-fade-end), and index.css fades those edges. Its scroll-padding keeps a margin when a tab scrolls into view. */
export function useEdgeFade<T extends HTMLElement>(ref: React.RefObject<T | null>) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const f = edgeFade(el.scrollLeft, el.scrollWidth, el.clientWidth)
      for (const [name, on] of [['data-fade-start', f.start], ['data-fade-end', f.end]] as const) {
        if (on) el.setAttribute(name, '')
        else el.removeAttribute(name)
      }
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro?.disconnect()
    }
  }, [ref])
}

// ---------------- simple tabs ----------------
/** The ids that tie a tab to its panel: `base` is the Tabs' `panels` (one useId per Tabs), `id` the tab's. */
export const tabIds = (base: string, id: string) => ({ tab: `${base}-tab-${id}`, panel: `${base}-panel-${id}` })

/** What the chosen tab shows: role=tabpanel, named by its tab, the one each tab's aria-controls points at. `base`: the
 * same as the Tabs' `panels`; null when no tabs are shown (a plain box then). */
export function TabPanel({ base, value, className, children, ...rest }: { base: string | null; value: string; className?: string; children?: ReactNode } & Omit<React.HTMLAttributes<HTMLDivElement>, 'id' | 'role'>) {
  if (base === null) return <div className={className} {...rest}>{children}</div>
  const ids = tabIds(base, value)
  return (
    <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} className={className} {...rest}>
      {children}
    </div>
  )
}

/** `segmented`: the tabs sit in one quiet pill group, for a page's main switch next to its title. The keyboard follows
 * the WAI-ARIA tabs pattern: Tab reaches the chosen tab only; the arrow keys, Home and End choose another. `panels`:
 * the ids of the panels (`useId()`), shared with the TabPanel that shows the chosen tab's content.
 * A phone (below 768px), segmented: the row takes the width it is given (the page's, or what a button beside it
 * leaves: Folder permissions' Filters), its choices of equal width and 44px tall, never scrolling sideways; an item's `short` is its word there ("Mine" for "My suggestions"). When a choice's word does not
 * fit its share (a long language, five choices), the row is one picker row instead, "Available skills ⌄", whose
 * sheet lists them all (rooms/MenuButton.tsx), so nothing is cut or hidden off the side. Computers keep the row. */
export function Tabs<T extends string>({ value, onChange, items, label, segmented, panels }: { value: T; onChange: (v: T) => void; items: { id: T; label: string; short?: string }[]; label: string; segmented?: boolean; panels: string }) {
  const list = useRef<HTMLDivElement>(null)
  useEdgeFade(list)
  const phone = useMediaQuery('(max-width: 767.98px)')
  const fitted = !!segmented && phone
  // on a phone the tabs may not all fit: the chosen one scrolls into the row (a link can choose the last one). Only
  // then, so a row that fits never moves the page.
  useEffect(() => {
    const row = list.current
    const tab = row?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    if (!row || !tab || row.scrollWidth <= row.clientWidth) return
    const r = row.getBoundingClientRect()
    const b = tab.getBoundingClientRect()
    if (b.left < r.left || b.right > r.right) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [value, items.length])
  // a phone's segmented row: whether every word fits its equal share, measured on a hidden copy of the row (so the
  // picker can turn back into the row when the screen turns wider)
  const probe = useRef<HTMLDivElement>(null)
  const [fits, setFits] = useState(true)
  const words = items.map((it) => it.short ?? it.label).join('\n')
  useLayoutEffect(() => {
    const row = probe.current
    if (!fitted || !row) return
    const measure = () => setFits(items.length <= 5 && [...row.querySelectorAll<HTMLElement>('[data-word]')].every((w) => w.scrollWidth <= w.clientWidth + 0.5))
    measure()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(row)
    return () => ro?.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitted, words])
  // the tabs pattern: one Tab stop (the chosen tab); Left / Right (round), Home and End move to a tab and choose it
  const current = items.some((it) => it.id === value) ? value : items[0]?.id
  // the tab chosen last, also before the page shows it (a choice can render later: keys pressed quickly go on from it)
  const chosen = useRef(current)
  chosen.current = current
  const picker = useRef<HTMLButtonElement>(null)
  const [pick, setPick] = useState(0)
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = items.findIndex((it) => it.id === chosen.current)
    const n = items.length
    const to = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
    if (to < 0 || !n) return
    e.preventDefault()
    chosen.current = items[to]!.id
    onChange(items[to]!.id)
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus()
  }
  const segment = 'flex min-h-11 min-w-0 items-center justify-center rounded-md px-2 text-label font-medium'
  if (fitted) {
    const now = items.find((it) => it.id === current)
    return (
      <div className="relative min-w-0 flex-1" data-testid="tabs-phone" data-fits={fits ? 'row' : 'picker'}>
        {/* the row as it would be drawn, out of sight: each word against its share */}
        <div ref={probe} aria-hidden className="pointer-events-none invisible absolute inset-x-0 top-0 grid h-0 auto-cols-[minmax(0,1fr)] grid-flow-col gap-0.5 overflow-hidden p-0.5">
          {items.map((it) => (
            <span key={it.id} className={segment}>
              <span data-word className="block min-w-0 overflow-hidden whitespace-nowrap">{it.short ?? it.label}</span>
            </span>
          ))}
        </div>
        {fits ? (
          <div ref={list} role="tablist" aria-label={label} onKeyDown={onKeyDown} className="grid w-full auto-cols-[minmax(0,1fr)] grid-flow-col gap-0.5 rounded-lg bg-subtle p-0.5">
            {items.map((it) => (
              <button
                key={it.id}
                role="tab"
                type="button"
                id={tabIds(panels, it.id).tab}
                aria-controls={tabIds(panels, it.id).panel}
                aria-selected={value === it.id}
                tabIndex={it.id === current ? 0 : -1}
                onClick={() => onChange(it.id)}
                className={clsx(segment, 'focus-visible:-outline-offset-2', value === it.id ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted')}
              >
                <span className="truncate">{it.short ?? it.label}</span>
              </button>
            ))}
          </div>
        ) : (
          <>
            {/* the chosen tab's place: it names the panel below (TabPanel's aria-labelledby) */}
            <button
              ref={picker}
              type="button"
              id={current ? tabIds(panels, current).tab : undefined}
              aria-haspopup="menu"
              aria-label={`${label}: ${now?.label ?? ''}`}
              onClick={() => setPick((n) => n + 1)}
              className="flex min-h-11 w-full items-center gap-2 rounded-lg bg-subtle px-3 text-left text-sm font-medium text-ink"
              data-testid="tabs-picker"
            >
              <span className="min-w-0 flex-1 truncate">{now?.label}</span>
              <ChevronDown size={16} className="shrink-0 text-faint" aria-hidden />
            </button>
            <MenuButton
              label={label}
              heading={label}
              className="contents"
              buttonClassName="hidden!"
              openRequest={pick}
              focusBack={() => picker.current?.focus()}
              items={items.map((it) => ({ label: it.label, checked: it.id === current, onSelect: () => onChange(it.id), testId: `tabs-pick-${it.id}` }))}
            />
          </>
        )}
      </div>
    )
  }
  return (
    <div ref={list} role="tablist" aria-label={label} onKeyDown={onKeyDown} className={clsx('edge-fade flex overflow-x-auto', segmented ? 'max-w-full gap-0.5 rounded-lg bg-subtle p-0.5' : 'gap-1')}>
      {items.map((it) => (
        <button
          key={it.id}
          role="tab"
          type="button"
          id={tabIds(panels, it.id).tab}
          aria-controls={tabIds(panels, it.id).panel}
          aria-selected={value === it.id}
          tabIndex={it.id === current ? 0 : -1}
          onClick={() => onChange(it.id)}
          className={clsx(
            'rounded-md font-medium whitespace-nowrap focus-visible:-outline-offset-2',
            segmented ? 'px-3 py-1 text-label' : 'px-2.5 py-1 text-xs',
            segmented ? (value === it.id ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink') : value === it.id ? 'bg-ink text-canvas' : 'text-muted hover:bg-hover',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

/** Toggle switch with a real checkbox underneath (keyboard + screen readers). Off: a --c-field-border track (>= 3:1 on
 * canvas, surface and subtle) with a white knob; on: a --c-accent track with a white knob in light (>= 3:1, as in Claude's
 * apps) and a --c-accent-ink knob in dark (a white one would be 2.85:1 on the dark accent). The focus ring sits 2px
 * outside the track, so it shows on the accent. */
/** `hideLabel`: the label is for screen readers only (a row whose name is already beside the switch). */
/** `id` with `external`: the switch has no text of its own; a `<label htmlFor={id}>` elsewhere on its row names it (a
 * settings row with the words on the left and the switch on the right). */
export function Switch({ checked, onChange, label, disabled, hideLabel, testId, id, external, describedBy }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; hideLabel?: boolean; testId?: string; id?: string; external?: boolean; describedBy?: string }) {
  const big = useContext(PhoneTargets)
  return (
    <label className={clsx('relative inline-flex cursor-pointer items-center gap-2 text-sm', big && 'touch-hit', disabled && 'cursor-not-allowed opacity-60')}>
      <input id={id} type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} data-testid={testId} aria-describedby={describedBy} />
      <span className="relative h-5 w-9 shrink-0 rounded-full bg-field-border transition peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-4 dark:peer-checked:after:bg-accent-ink" aria-hidden />
      {!(external && id) && <span className={hideLabel ? 'sr-only' : undefined}>{label}</span>}
    </label>
  )
}

// ---------------- page header ----------------
/** The box that scrolls `el` (the page's own scrolling area), or null when the page itself does not scroll there. */
function scrollBox(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if (o === 'auto' || o === 'scroll') return p
  }
  return null
}

/** A page's title row that stays at the top while the page scrolls (put `stickyCls` on it). `scrolled`: the page has
 * scrolled, so the row shows its hairline. The scrolling area keeps the row's height free at its top for the keyboard
 * (scroll-padding), so a control that gets focus never hides under the row. */
export function useStickyHeader<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const el = ref.current
    const box = scrollBox(el)
    if (!el || !box) return
    const onScroll = () => setScrolled(box.scrollTop > 0)
    const pad = () => {
      box.style.scrollPaddingTop = `${el.offsetHeight + 8}px`
    }
    onScroll()
    pad()
    box.addEventListener('scroll', onScroll, { passive: true })
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(pad)
    resize?.observe(el)
    return () => {
      box.removeEventListener('scroll', onScroll)
      resize?.disconnect()
      box.style.scrollPaddingTop = ''
    }
  }, [])
  return { ref, scrolled }
}
/** Filled with the surface it sits on (--sticky-bg: the page, or a dialog's panel), so it looks transparent and nothing
 * shows through while it scrolls under the row. */
export const stickyCls = 'sticky top-0 z-20 bg-[var(--sticky-bg)]'

/** A title row (title, tabs, search, the main button) that stays at the top while the page scrolls, with a hairline under
 * it once the page has scrolled (like Claude's Customize page). `bar`: a full-width bar that has its own line already
 * (the project page's top line), so no second one. */
export function StickyHeader({ className, children, testId, bar }: { className?: string; children: ReactNode; testId?: string; bar?: boolean }) {
  const { ref, scrolled } = useStickyHeader<HTMLDivElement>()
  return (
    <div ref={ref} data-sticky-header data-scrolled={scrolled || undefined} data-testid={testId} className={clsx(stickyCls, !bar && 'transition-shadow', !bar && scrolled && 'shadow-[0_1px_0_var(--color-line)]', className)}>
      {children}
    </div>
  )
}

/** A page's content column: centred in the space beside the sidebar, like Claude's Customize page (phones: full width). */
export const pageColumn = 'mx-auto w-full max-w-5xl'

/** A page's full-width title bar: it keeps its line and stays at the top while the page scrolls; its contents line up
 * with the page's column (pageColumn). */
export function PageHeader({ title, desc, actions, testId }: { title: ReactNode; desc?: ReactNode; actions?: ReactNode; testId?: string }) {
  const { ref } = useStickyHeader<HTMLDivElement>()
  return (
    <div ref={ref} data-sticky-header data-testid={testId} className={clsx(stickyCls, 'shrink-0 border-b border-line')}>
      <div className={clsx(pageColumn, 'flex flex-wrap items-end justify-between gap-3 px-4 py-4 sm:px-6 sm:py-5')}>
      <div className="min-w-0">
        {/* phones: the top bar says the page's name (components/PhoneTopBar.tsx); here for screen readers only */}
        <h1 className="text-xl font-semibold tracking-tight max-md:sr-only">{title}</h1>
        {desc && <p className="mt-1 text-sm text-muted max-md:mt-0">{desc}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
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
