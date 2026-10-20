// ask_user: the AI asks back mid-answer (options and/or free text), and browser_site: the in-app browser wants an
// office-network address. Answered with POST /api/turns/:id/answer; closed by turn.request.closed (answered in
// another window, timed out, turn ended). Ordinary form controls (radios / checkboxes / buttons) for keyboards
// and screen readers.
import clsx from 'clsx'
import { Globe, MessageCircleQuestion, ShieldAlert } from 'lucide-react'
import { useId, useState } from 'react'
import { errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { useChats, type OpenRequest } from '../../store/chats'
import { Button, inputCls } from '../ui'

export default function AskCard({ req }: { req: OpenRequest }) {
  const t = useT()
  const locale = useLocale()
  const answer = useChats((s) => s.answer)
  const [picked, setPicked] = useState<string[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = useId()
  const r = req.request

  const run = async (body: Parameters<typeof answer>[1]) => {
    setBusy(true)
    setError(null)
    try {
      await answer(r.requestId, body)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
      setBusy(false)
    }
  }

  if (r.kind === 'browser_site')
    return (
      <div className="my-3 overflow-hidden rounded-2xl border border-warn/40" role="group" aria-label={t('ask.siteTitle')} data-testid="site-card">
        <div className="flex items-center gap-2 bg-warn-soft px-4 py-2.5 text-sm font-semibold text-warn">
          <Globe size={16} aria-hidden /> {t('ask.siteTitle')}
        </div>
        <div className="space-y-2 px-4 py-3 text-sm">
          <p>{t('ask.siteBody', { host: r.host })}</p>
          <p className="truncate text-xs text-faint" title={r.url}>
            {r.url}
          </p>
          {r.reason && <p className="text-xs text-muted">{r.reason}</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => run({ kind: 'browser_site', decision: 'once' })}>
              {t('browser.allowOnce')}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => run({ kind: 'browser_site', decision: 'always' })}>
              {t('browser.allowAlways')}
            </Button>
            <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => run({ kind: 'browser_site', decision: 'deny' })}>
              {t('browser.deny')}
            </Button>
          </div>
          {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        </div>
      </div>
    )

  const options = r.options ?? []
  const allowText = r.allowText ?? options.length === 0
  const value: string | string[] | null = r.multiple ? [...picked, ...(text.trim() ? [text.trim()] : [])] : (picked[0] ?? (text.trim() || null))
  const ready = Array.isArray(value) ? value.length > 0 : !!value
  const toggle = (v: string) => setPicked((p) => (r.multiple ? (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]) : [v]))

  const fromServer = r.origin === 'server'
  return (
    <form
      className={clsx('my-3 overflow-hidden rounded-2xl border', fromServer ? 'border-warn/40' : 'border-line')}
      data-testid="ask-card"
      data-origin={fromServer ? 'server' : 'ai'}
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) void run({ kind: 'ask_user', answer: value })
      }}
    >
      {fromServer ? (
        <div className="flex items-center gap-2 bg-warn-soft px-4 py-2.5 text-sm font-semibold text-warn">
          <ShieldAlert size={16} aria-hidden /> {t('ask.serverTitle')}
        </div>
      ) : (
        <div className="flex items-center gap-2 bg-subtle px-4 py-2.5 text-sm font-semibold">
          <MessageCircleQuestion size={16} className="text-accent-text" aria-hidden /> {t('ask.title')}
        </div>
      )}
      <fieldset className="space-y-2 px-4 py-3">
        <legend className="mb-2 whitespace-pre-wrap text-sm font-medium [overflow-wrap:anywhere]">{r.question}</legend>
        {options.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {options.map((o) => (
              <label key={o.value} className={clsx('flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm', picked.includes(o.value) ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover')}>
                <input type={r.multiple ? 'checkbox' : 'radio'} name={name} value={o.value} checked={picked.includes(o.value)} onChange={() => toggle(o.value)} className="accent-[var(--c-accent)]" />
                {o.label}
              </label>
            ))}
          </div>
        )}
        {allowText && (
          <textarea
            aria-label={t('ask.ownAnswer')}
            className={clsx(inputCls, 'h-auto min-h-16 resize-y py-2')}
            placeholder={options.length ? t('ask.orType') : t('ask.typeAnswer')}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              if (!r.multiple && e.target.value) setPicked([])
            }}
          />
        )}
      </fieldset>
      <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2.5">
        {error && <span role="alert" className="mr-auto text-xs text-danger">{error}</span>}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => run({ kind: 'ask_user', answer: null })}>
          {t('ask.skip')}
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={!ready} busy={busy}>
          {t('ask.send')}
        </Button>
      </div>
    </form>
  )
}
