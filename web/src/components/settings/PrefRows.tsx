// The look of Settings › Notifications (docs/DECISIONS.md "대화방 알림 설정"): plain sections under a heading with a
// hairline between them, and one row per setting with its name, a short line under it and the control on the right
// (like Admin › Team settings, but a switch stays on the right on a phone too). No frames.
import clsx from 'clsx'
import type { ReactNode } from 'react'

/** A group of settings: a plain heading (h3: the page's own title is the h2), a hairline above it. */
export function PrefSection({ title, desc, children, testId, className }: { title: ReactNode; desc?: ReactNode; children: ReactNode; testId?: string; className?: string }) {
  return (
    <section className={clsx('border-t border-line pt-5', className)} data-testid={testId}>
      <h3 className="text-base font-semibold">{title}</h3>
      {desc && <p className="mt-1 text-sm text-muted">{desc}</p>}
      <div className="mt-1">{children}</div>
    </section>
  )
}

/** One setting. `id` is the control's: the name labels it and the short line describes it (`${id}-desc`). `below`: more
 * of the same setting under the line (the hours of quiet hours, a short list). */
export function PrefRow({ id, title, desc, control, below, testId, attrs }: { id: string; title: ReactNode; desc?: ReactNode; control?: ReactNode; below?: ReactNode; testId?: string; attrs?: Record<string, string> }) {
  return (
    <div className="py-3.5" data-testid={testId} {...attrs}>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <label htmlFor={id} className="text-sm font-medium text-ink">{title}</label>
          {desc && <p id={`${id}-desc`} className="mt-0.5 text-sm text-muted">{desc}</p>}
        </div>
        {control && <div className="flex shrink-0 items-center gap-2 pt-0.5">{control}</div>}
      </div>
      {below}
    </div>
  )
}
