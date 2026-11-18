// What a failed check printed, for support: closed by default under a plain line that says what happened, opened with
// "Show details", with a copy button. Only on admin screens (the text comes cleaned and cut short from the server).
import { useId, useState } from 'react'
import { useT } from '../i18n'
import { CopyButton } from './ui'

export function SupportDetails({ text, testId = 'support-details' }: { text: string; testId?: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div data-testid={testId}>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}
        className="text-xs font-medium text-muted underline-offset-2 hover:text-ink hover:underline max-md:min-h-11" data-testid={`${testId}-toggle`}>
        {t(open ? 'system.hideDetails' : 'system.showDetails')}
      </button>
      <div id={id} hidden={!open} className="mt-1 flex items-start gap-1">
        <pre className="max-h-40 min-w-0 flex-1 overflow-auto rounded-lg border border-line bg-subtle px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap text-muted" data-testid={`${testId}-text`}>{text}</pre>
        <CopyButton text={text} />
      </div>
    </div>
  )
}
