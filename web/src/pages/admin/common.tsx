// Small helpers shared by the admin screens.
import clsx from 'clsx'
import { Building2, Search } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { useMeStrict } from '../../store/session'
import { toast } from '../../store/ui'
import { Button, Field, Modal, Skeleton, StickyHeader, inputCls, useMediaQuery } from '../../components/ui'
import { LoadError } from '../../components/LoadError'

/** Team settings, scrolled to Usage limits (TeamAiSettings.tsx reads #ai-limits). */
export const USAGE_LIMITS_LINK = '/admin/settings#ai-limits'

/** `error`: the failure in words (kept until a read works); `cause`: what was thrown, for Loadable's notice. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const t = useT()
  const locale = useLocale()
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cause, setCause] = useState<unknown>(null)
  const reload = useCallback(async () => {
    try {
      setData(await fn())
      setError(null)
      setCause(null)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
      setCause(e)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => {
    void reload()
  }, [reload])
  return { data, error, cause, reload, setData }
}

/** A read that failed: the connection gets the calm notice that reads again by itself, anything else the red note with
 * the server's words (components/LoadError.tsx). */
export function Loadable<T>({ state, children, lines = 4 }: { state: { data: T | null; error: string | null; cause?: unknown; reload: () => Promise<void> }; children: (d: T) => ReactNode; lines?: number }) {
  if (state.error) return <LoadError error={state.cause} text={state.error} onRetry={state.reload} />
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

/**
 * The one page header of every admin page: the page title, then (optional) tabs or filters next to it, the page's own
 * buttons on the right, and one line on what the page is for. It stays at the top while the page scrolls. The cards
 * go under it. Engines, Usage and Activity log started this pattern; the other pages use it too now, so all admin
 * pages look the same.
 */
/** "Applies to everyone in <team>": above every Admin page (AdminLayout.tsx), the pair of Settings' "Just for you"
 * (SettingsDialog.tsx), in the same size and colour. The shell says whose a page is, so the titles keep the same nouns
 * as Settings' (Connectors, Providers, AI apps). */
export function AdminScope() {
  const t = useT()
  const me = useMeStrict()
  return (
    // mb-3: the title rows under it start 12px higher (-mt-3) to stay put when stuck, and would cover its descenders
    <p className="mb-3 flex items-center gap-1.5 text-xs text-faint" data-testid="page-scope">
      <Building2 size={13} className="shrink-0" aria-hidden /> {t('scope.teamName', { team: me.team.name })}
    </p>
  )
}

export function AdminPageHeader({ title, desc, actions, children, controls, testId, className, still }: { title: ReactNode; desc?: ReactNode; actions?: ReactNode; children?: ReactNode; controls?: ReactNode; testId?: string; className?: string; still?: boolean }) {
  const phone = useMediaQuery('(max-width: 767.98px)')
  if (phone) {
    // A phone (docs/DECISIONS.md "Admin and Settings on phones"): the bar above says the page's name (AdminLayout's
    // PhonePageBar), so the title is for screen readers only; the line keeps one line (More) with the page's buttons at
    // its end (PageActions: one, the rest under its ⌄); only the search and filters row stays at the top while the page
    // scrolls (the whole header stuck took a third of the screen)
    return (
      <>
        <div className={clsx('mb-3', className)} data-testid={testId}>
          <h2 className="sr-only">{title}</h2>
          {children && <div className="mb-2 flex flex-wrap items-center gap-2">{children}</div>}
          {(desc || actions) && (
            <div className="flex items-center gap-3">
              {desc ? <OneLine className="min-w-0 flex-1 text-xs text-muted">{desc}</OneLine> : <span className="flex-1" />}
              {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
            </div>
          )}
        </div>
        {controls && (
          <StickyHeader className="mb-3 flex flex-wrap items-center gap-2 py-2" testId={testId ? `${testId}-controls` : undefined}>
            {controls}
          </StickyHeader>
        )}
      </>
    )
  }
  const body = (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <h2 className="flex items-center text-lg font-semibold tracking-tight">{title}</h2>
        {children}
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {desc && <OneLine className="mt-1 text-xs text-muted" twoOnPhone>{desc}</OneLine>}
      {/* the People pages' search and filters, under the line (like the Claude Console's Members) */}
      {controls && <div className="mt-3 flex flex-wrap items-center gap-2">{controls}</div>}
    </>
  )
  // still: the header scrolls away with the page, for a page with a sticky part of its own (Folder permissions' detail)
  if (still) return <div className={clsx('mb-3 pb-3', className)} data-testid={testId}>{body}</div>
  return <StickyHeader className={clsx('-mt-3 mb-3 py-3', className)} testId={testId}>{body}</StickyHeader>
}

/** How many there are, as a small round badge after a page title ("Members 4"). Nothing until the list has loaded. */
export function CountBadge({ n, testId }: { n: number | null | undefined; testId?: string }) {
  if (n == null) return null
  return (
    <span className="ml-2 inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-subtle px-2 text-xs font-medium text-muted tabular-nums" data-testid={testId}>
      {n}
    </span>
  )
}

/** A search box for a list on the page (it filters what is already loaded), in the height of the filter pills. */
export function SearchBox({ value, onChange, label, testId, className }: { value: string; onChange: (v: string) => void; label: string; testId?: string; className?: string }) {
  return (
    <label className={clsx('flex h-9 min-w-0 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-sm focus-within:border-accent focus-within:ring-1 focus-within:ring-accent max-md:min-h-11 max-md:flex-1', className)}>
      <Search size={15} className="shrink-0 text-faint" aria-hidden />
      <input
        type="search"
        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint"
        placeholder={label}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Escape empties the box first (and does not close anything around it while there is text)
          if (e.key === 'Escape' && value) {
            e.stopPropagation()
            onChange('')
          }
        }}
        data-testid={testId}
      />
    </label>
  )
}

/** Does `text` contain the search `q` (already trimmed and lower-cased)? Case-insensitive in the person's language. */
export const matches = (q: string, locale: string, ...texts: (string | null | undefined)[]) =>
  !q || texts.some((s) => !!s && s.toLocaleLowerCase(locale).includes(q))

/** Cards inside this show as plain page sections (a heading, its line, the content; no box), for a settings page laid
 * out like a document (Team settings). */
const FlatCards = createContext(false)
export const FlatCardsProvider = FlatCards.Provider

/** The name the phone's bar shows for this page (a group of Team settings on a phone): a section or card with the same
 * title keeps it for screen readers only, so the name is not said twice on screen. */
const BarTitle = createContext<string | null>(null)
export const BarTitleProvider = BarTitle.Provider
const useInBar = (title: ReactNode) => {
  const bar = useContext(BarTitle)
  return bar !== null && title === bar
}

/** headingRef: the title takes the focus (tabIndex -1) when a list has no row left to focus, see useFocusAfterRemove.
 * No title, no line and no buttons: the card has no header row (the page header above names it).
 * flat: below the md width no frame, a section that ends with a hairline (none after the page's last), for a page whose
 * cards would stack frame on frame on a phone (Slack, Settings › Providers). Its content must not reach into
 * the card's padding. */
export function Card({ title, actions, children, desc, headingRef, testId, flat, id }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; desc?: ReactNode; headingRef?: Ref<HTMLHeadingElement>; testId?: string; flat?: boolean; id?: string }) {
  const head = title || desc || actions
  const inBar = useInBar(title)
  if (useContext(FlatCards)) {
    return (
      <section id={id} className="scroll-mt-24 border-t border-line py-6 first:border-t-0 first:pt-2" data-testid={testId}>
        {head && (
          <header className="mb-3 flex flex-wrap items-start gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1 max-sm:basis-full">
              {title && <h2 ref={headingRef} tabIndex={headingRef ? -1 : undefined} className={clsx('text-base font-medium', inBar && 'sr-only')}>{title}</h2>}
              {desc && <p className="mt-1 text-sm text-muted">{desc}</p>}
            </div>
            {actions}
          </header>
        )}
        {children}
      </section>
    )
  }
  return (
    <section id={id} className={clsx('mb-6 rounded-2xl border border-line bg-surface', flat && 'max-md:rounded-none max-md:border-x-0 max-md:border-t-0 max-md:bg-transparent max-md:pb-6 max-md:last:border-b-0')} data-testid={testId}>
      {head && (
        <header className={clsx('flex flex-wrap items-center gap-2 border-b border-line px-4 py-3', flat && 'max-md:border-b-0 max-md:px-0 max-md:pt-0')}>
          {/* a phone: the title and its line take the whole row and the buttons go under them, so the line is not cut
              to a few words */}
          <div className="min-w-0 flex-1 max-sm:basis-full">
            {title && <h2 ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="text-sm font-semibold">{title}</h2>}
            {desc && <OneLine className="mt-0.5 text-xs text-muted" twoOnPhone>{desc}</OneLine>}
          </div>
          {actions}
        </header>
      )}
      <div className={clsx('p-4', flat && 'max-md:p-0')}>{children}</div>
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
    // phones with 2 lines: More sits on the last line, right after the cut ("…"), not beside the first
    <div className={clsx('flex items-baseline gap-1.5', twoOnPhone && 'max-sm:items-end', className)} data-testid={testId}>
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

/** A group of settings under a plain heading (Team settings): no box, a hairline above every group but the first.
 * `actions`: a button beside the heading (Add limit). `headingRef`: the heading takes the focus when a link opens the
 * page at this group (#ai-limits). */
export function SettingsSection({ title, desc, actions, children, testId, id, headingRef }: { title: ReactNode; desc?: ReactNode; actions?: ReactNode; children: ReactNode; testId?: string; id?: string; headingRef?: Ref<HTMLHeadingElement> }) {
  const inBar = useInBar(title)
  return (
    <section id={id} className="scroll-mt-24 border-t border-line py-6 first:border-t-0 first:pt-2" data-testid={testId} aria-labelledby={id ? `${id}-title` : undefined}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id={id ? `${id}-title` : undefined} ref={headingRef} tabIndex={headingRef ? -1 : undefined} className={clsx('text-base font-medium focus:outline-none', inBar && 'sr-only')}>{title}</h2>
          {desc && <div className="mt-1 text-sm text-muted">{desc}</div>}
        </div>
        {actions}
      </div>
      <div className="mt-1">{children}</div>
    </section>
  )
}

/**
 * One setting as one row: its name, a short line on what it does under it, and the control on the right. Below 768 px
 * a wide control (a select, a text field, the logo's buttons) goes under the line; an `inline` one (a switch, a short
 * number) stays on the right of the name, as on a phone's Settings, with the line under the name. `id` is the control's
 * id: the name labels it and the line describes it. `more`: the longer details, behind "Learn more" (kept in the page,
 * hidden, so the row reads short). `heading`: the name is a heading, for a row whose control is not one field (the team
 * logo). `below`: under the line, always shown (an error, a state).
 */
export function SettingRow({ id, title, desc, more, control, below, heading, inline, testId, attrs }: {
  id?: string; title: ReactNode; desc?: ReactNode; more?: ReactNode; control?: ReactNode; below?: ReactNode; heading?: boolean; inline?: boolean; testId?: string; attrs?: Record<string, string>
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const descId = id ? `${id}-desc` : undefined
  return (
    <div className={clsx('flex py-4 md:flex-row md:items-start md:gap-8', inline ? 'items-start gap-4' : 'flex-col gap-3')} data-testid={testId} {...attrs}>
      <div className="min-w-0 flex-1">
        {heading ? <h3 className="text-sm font-medium text-ink">{title}</h3> : <label htmlFor={id} className="text-sm font-medium text-ink">{title}</label>}
        {(desc || more) && (
          <div className="mt-1 text-sm text-muted">
            {desc && <span id={descId}>{desc}</span>}
            {desc && more && ' '}
            {more && (
              <button type="button" aria-expanded={open} className="font-medium whitespace-nowrap text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => setOpen(!open)} data-testid={testId ? `${testId}-more` : undefined}>
                {t(open ? 'common.less' : 'teamSettings.learnMore')}
              </button>
            )}
          </div>
        )}
        {more && <div hidden={!open} className="mt-2 max-w-prose text-xs leading-relaxed text-faint">{more}</div>}
        {below}
      </div>
      {control && <div className={clsx('flex shrink-0 md:justify-end md:pt-0.5', inline ? 'pt-0.5 max-md:items-center max-md:gap-2' : 'justify-start')}>{control}</div>}
    </div>
  )
}
