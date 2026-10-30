// ask_user: the AI asks back mid-answer (options and/or free text), and browser_site: the in-app browser wants an
// office-network address. Answered with POST /api/turns/:id/answer; closed by turn.request.closed (answered in
// another window, timed out, turn ended). Ordinary form controls (radios / checkboxes / buttons) for keyboards
// and screen readers. The AI's own questions can also be answered from the message box (lib/askAnswer.ts): what is
// ticked here goes along with that answer when the question takes several. The same card outside a turn (a scheduled
// task's card shown again in Settings, "다시 확인") passes its own `onAnswer`.
import clsx from 'clsx'
import { Globe, MessageCircleQuestion, ShieldAlert } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { errorText } from '../../lib/api'
import { forgetPicks, rememberPicks } from '../../lib/askAnswer'
import { useLocale, useT } from '../../i18n'
import { useChats, type OpenRequest } from '../../store/chats'

type AnswerBody = Parameters<ReturnType<typeof useChats.getState>['answer']>[1]
import type { ConfirmDetail, SkillWritePreview } from '@mycel/shared/api'
import { Button, inputCls } from '../ui'

export default function AskCard({ req, onAnswer }: { req: Pick<OpenRequest, 'request'>; onAnswer?: (requestId: string, body: AnswerBody) => Promise<void> }) {
  const t = useT()
  const locale = useLocale()
  const storeAnswer = useChats((s) => s.answer)
  const answer = onAnswer ?? storeAnswer
  const [picked, setPicked] = useState<string[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = useId()
  const r = req.request
  useEffect(() => rememberPicks(r.requestId, picked), [r.requestId, picked])
  useEffect(() => () => forgetPicks(r.requestId), [r.requestId])

  const run = async (body: AnswerBody) => {
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
      {/* the padding sits on a wrapper: a <legend> ignores its fieldset's top padding and would touch the header */}
      <div className="px-4 pt-3.5 pb-3">
        <fieldset className="space-y-2">
          <legend className="mb-2.5 whitespace-pre-wrap text-sm font-medium [overflow-wrap:anywhere]">{r.question}</legend>
          {fromServer && r.preview && <SkillPreview p={r.preview} />}
          {fromServer && r.details?.length ? <Details items={r.details} /> : null}
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
              aria-describedby={`${name}-secrets`}
              className={clsx(inputCls, 'h-auto min-h-16 resize-y py-2')}
              placeholder={options.length ? t('ask.orType') : t('ask.typeAnswer')}
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                if (!r.multiple && e.target.value) setPicked([])
              }}
            />
          )}
          {/* tab 5 "확인 카드": the free-text answer goes to the AI; this line is always there under it */}
          {allowText && (
            <p id={`${name}-secrets`} className="text-xs text-faint" data-testid="ask-no-secrets">
              {t('ask.noSecrets')}
            </p>
          )}
        </fieldset>
      </div>
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

/** What the AI is about to save under skills/ (team skills and rules every teammate's AI follows): the diff. */
function SkillPreview({ p }: { p: SkillWritePreview }) {
  const t = useT()
  const lines = p.diff.split('\n')
  const isDiff = lines[0]?.startsWith('@@')
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-line" data-testid="skill-preview">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-subtle px-3 py-1.5 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono" title={p.path}>
          {p.path}
        </span>
        <span className="text-faint">{p.isNew ? t('ask.skillNew') : t('ask.skillChange')}</span>
        {isDiff && (
          <span className="font-mono text-faint" data-testid="skill-preview-count">
            {t('ask.skillLines', { added: p.added, removed: p.removed })}
          </span>
        )}
      </div>
      {isDiff ? (
        <pre className="scroll-thin max-h-64 overflow-auto px-0 py-1 font-mono text-[12px] leading-5" data-testid="skill-preview-diff">
          {lines.map((l, i) => (
            <div
              key={i}
              className={clsx('px-3 whitespace-pre-wrap [overflow-wrap:anywhere]', l.startsWith('+') ? 'bg-ok-soft text-ok' : l.startsWith('-') ? 'bg-danger-soft text-danger' : l.startsWith('@@') ? 'text-faint' : '')}
            >
              {l || ' '}
            </div>
          ))}
        </pre>
      ) : (
        <p className="px-3 py-2 text-xs text-muted">{p.diff}</p>
      )}
      {p.truncated && <p className="border-t border-line px-3 py-1 text-[11px] text-faint">{t('ask.skillTruncated')}</p>}
    </div>
  )
}

/** What a server check is about to let out, every character of it (a connected service's write with where it goes, a
 * scheduled task's instruction and its addresses): scrollable, with its size; long random-looking parts highlighted. */
function Details({ items }: { items: ConfirmDetail[] }) {
  const t = useT()
  return (
    <div className="mb-2 space-y-2" data-testid="ask-details">
      {items.map((d, i) => (
        <div key={i} className="overflow-hidden rounded-lg border border-line" data-testid="ask-detail">
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-subtle px-3 py-1.5 text-xs">
            <span className="min-w-0 flex-1 font-medium">{d.label}</span>
            <span className="text-faint" data-testid="ask-detail-size">
              {t('ask.detailSize', { n: d.text.length })}
            </span>
          </div>
          {d.fields?.length ? (
            <div
              className="scroll-thin max-h-40 space-y-0.5 overflow-auto border-b border-line px-3 py-1.5 font-mono text-xs"
              role="group"
              aria-label={d.label}
              tabIndex={0}
              data-testid="ask-detail-fields"
            >
              {d.fields.map((f, j) => (
                <div key={j} className="flex gap-3">
                  <span className="shrink-0 text-faint">{f.name}</span>
                  <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{f.value}</span>
                </div>
              ))}
            </div>
          ) : null}
          <pre
            className="scroll-thin max-h-64 overflow-auto px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]"
            tabIndex={0}
            aria-label={d.label}
            data-testid="ask-detail-text"
          >
            <Marked text={d.text} marks={d.marks} />
          </pre>
        </div>
      ))}
    </div>
  )
}

/** The text with the server's marks (long random-looking parts) highlighted. */
function Marked({ text, marks }: { text: string; marks?: string[] }) {
  const list = [...new Set((marks ?? []).filter((m) => m.length >= 8))].slice(0, 50)
  if (!list.length) return <>{text}</>
  const re = new RegExp(list.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  const parts: { s: string; mark: boolean }[] = []
  let at = 0
  for (const m of text.matchAll(re)) {
    if (m.index > at) parts.push({ s: text.slice(at, m.index), mark: false })
    parts.push({ s: m[0], mark: true })
    at = m.index + m[0].length
  }
  if (at < text.length) parts.push({ s: text.slice(at), mark: false })
  return (
    <>
      {parts.map((p, i) =>
        p.mark ? (
          <mark key={i} className="rounded-sm bg-warn-soft text-warn" data-testid="ask-detail-mark">
            {p.s}
          </mark>
        ) : (
          p.s
        ),
      )}
    </>
  )
}
