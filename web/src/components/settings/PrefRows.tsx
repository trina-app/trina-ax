// The look of Settings › Notifications (docs/DECISIONS.md "대화방 알림 설정"): plain sections under a heading with a
// hairline between them, and one row per setting with its name, a short line under it and the control on the right
// (like Admin › Team settings, but a switch stays on the right on a phone too). No frames.
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { SettingRow } from './SettingRow'

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

/** One setting: the shared settings row (SettingRow.tsx) with its control on the right on a phone too. */
export function PrefRow(props: { id: string; title: ReactNode; desc?: ReactNode; control?: ReactNode; below?: ReactNode; testId?: string; attrs?: Record<string, string> }) {
  return <SettingRow inline {...props} />
}
