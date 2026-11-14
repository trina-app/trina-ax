// The parts the apps dialog's guides share (AppsDialog, PresetSteps): a service's screen label quoted, Copy in the
// click itself, the one copy button, numbered steps, a fold, the event chips and a body to paste with its Copy.
import clsx from 'clsx'
import { Check, ChevronRight } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { Locale } from '@mycel/shared/api'
import { errorText } from '../../../lib/api'
import { useLocale, useT } from '../../../i18n'
import { toast } from '../../../store/ui'
import { Button } from '../../ui'

/** A service's own screen label, quoted the way the language quotes ("Webhook URL", 「Webhook URL」). */
function quote(locale: Locale, s: string): string {
  return locale === 'ja' || locale === 'zh' ? `「${s}」` : `“${s}”`
}
export function useVendor() {
  const t = useT()
  const locale = useLocale()
  return (k: string) => quote(locale, t(`roomApps.vendorLabel.${k}` as never))
}

/** Copy what `make` gives, in the same click: the text may come from the server (the first Copy adds the app), and
 * Safari only lets a page write the clipboard in the click itself (a ClipboardItem with a promise). Throws with the
 * text when no copy was possible, so the screen can show it to copy by hand. */
export async function copyFrom(make: Promise<string>): Promise<string> {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': make.then((s) => new Blob([s], { type: 'text/plain' })) })])
      return await make
    }
  } catch {
    // fall through: the text is written the plain way once it is here
  }
  const s = await make
  await navigator.clipboard.writeText(s)
  return s
}

/** The one copy button of these screens (the address, Forms' code, a secret, an example, a body): one size; "✓ Copied"
 * once copied. `primary` while copying is the screen's next step; after that it is an outline button and the next step
 * (Done) is the primary one. */
export function CopyButton({ label, copied, primary = false, busy, disabled, onClick, className, testId }: { label: string; copied: boolean; primary?: boolean; busy?: boolean; disabled?: boolean; onClick: () => void; className?: string; testId: string }) {
  const t = useT()
  return (
    <Button variant={primary && !copied ? 'primary' : 'secondary'} onClick={onClick} busy={busy} disabled={disabled} className={clsx('shrink-0', className)} data-testid={testId}>
      {copied ? <><Check size={14} aria-hidden />{t('roomApps.copied')}</> : label}
    </Button>
  )
}

/** a copy button's "Copied" for a moment */
export function useFlash(): [string | null, (what: string) => void] {
  const [copied, setCopied] = useState<string | null>(null)
  return [copied, (w) => { setCopied(w); setTimeout(() => setCopied((c) => (c === w ? null : c)), 1500) }]
}

/** A numbered step; `optional` ones say so above their words (and are where "Not set up in …" leads). */
export function Step({ n, optional = false, children }: { n: number; optional?: boolean; children: ReactNode }) {
  const t = useT()
  return (
    <li className="flex gap-3 text-sm text-ink" data-testid={optional ? 'apps-step-optional' : 'apps-step'}>
      <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-hover text-xs font-semibold text-muted">{n}</span>
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        {optional && <p className="text-xs font-medium text-muted">{t('roomApps.optionalStep')}</p>}
        {children}
      </div>
    </li>
  )
}

export function Fold({ summary, children, testId, className }: { summary: string; children: ReactNode; testId: string; className?: string }) {
  return (
    <details className={clsx('group rounded-lg border border-line', className)} data-testid={testId}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium text-ink md:min-h-9 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={14} aria-hidden className="shrink-0 text-faint transition group-open:rotate-90" />
        {summary}
      </summary>
      <div className="space-y-2 px-3 pb-3 text-sm text-ink">{children}</div>
    </details>
  )
}

/** What to tick in the service, as it names it (Stripe's events): code chips in the step where they are ticked. */
export function Chips({ items, testId }: { items: readonly string[]; testId: string }) {
  return (
    <ul className="flex flex-wrap gap-1.5" data-testid={testId}>
      {items.map((x) => <li key={x} className="rounded-md border border-line bg-hover/50 px-1.5 py-0.5 font-mono text-code-sm break-all text-ink">{x}</li>)}
    </ul>
  )
}

/** A body to paste in the service (Zendesk's trigger, Make's request): shown, with its Copy right under it. */
export function CopyBody({ body, testId }: { body: string; testId: string }) {
  const t = useT()
  const locale = useLocale()
  const [copied, flash] = useFlash()
  const copy = async () => {
    try { await copyFrom(Promise.resolve(body)); flash('body') } catch (e) { toast({ level: 'error', text: errorText(e, locale, t('error.network')) }) }
  }
  return (
    <div className="space-y-2">
      <pre className="max-h-32 overflow-auto rounded-lg border border-line bg-hover/50 px-3 py-2 font-mono text-code-sm break-all whitespace-pre-wrap text-ink" data-testid={`${testId}-text`}>{body}</pre>
      <CopyButton label={t('roomApps.copyBody')} copied={copied === 'body'} onClick={() => void copy()} testId={testId} />
    </div>
  )
}
