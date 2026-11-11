// ask_user: the AI asks back mid-answer (options and/or free text), browser_site: the in-app browser wants an
// office-network address, and dev_env_site: a dev-environment command needs a site that is not allowed. Answered with POST /api/turns/:id/answer; closed by turn.request.closed (answered in
// another window, timed out, turn ended). Ordinary form controls (radios / checkboxes / buttons) for keyboards
// and screen readers. The AI's own questions can also be answered from the message box (lib/askAnswer.ts): what is
// ticked here goes along with that answer when the question takes several. The same card outside a turn (a scheduled
// task's card shown again in Settings, "다시 확인") passes its own `onAnswer`. The server's yes/no cards are two buttons
// ([허용 안 함] [이번만 허용]) with what they let happen as plain lines; a server card that says its three choices are
// buttons (`buttons`: a room's change card) shows them in one row in the same order, the main one last
// ([허용 안 함] [이 방에서는 항상 허용] [이번만 허용]; stacked on a phone, the main one on top and first in the page: ChoiceRow,
// as the address and dev-environment cards) with its one line under them (`note`); radios and [답하기] are for real
// choices.
import clsx from 'clsx'
import { Globe, MessageCircleQuestion, ShieldAlert } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { errorText } from '../../lib/api'
import { forgetPicks, rememberPicks } from '../../lib/askAnswer'
import { issueText } from '../../lib/skillIssues'
import { useLocale, useT } from '../../i18n'
import { useChats, type OpenRequest } from '../../store/chats'
import type { ConfirmDetail, SkillWritePreview } from '@mycel/shared/api'
import { ALL_SITES_ANSWER } from '@mycel/shared'
import { navigateTo } from '../../lib/nav'
import { toast } from '../../store/ui'
import { Button, inputCls } from '../ui'
import { SecretWarning, useSecretHold } from './SecretWarning'

type AnswerBody = Parameters<ReturnType<typeof useChats.getState>['answer']>[1]

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
  /** the own answer looks like a key: it waits for "Send anyway" (SecretWarning) */
  const secret = useSecretHold(text)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const r = req.request
  useEffect(() => rememberPicks(r.requestId, picked), [r.requestId, picked])
  useEffect(() => () => forgetPicks(r.requestId), [r.requestId])

  const run = async (body: AnswerBody) => {
    setBusy(true)
    setError(null)
    try {
      await answer(r.requestId, body)
      // the address card's "Allow all websites (turn off in Settings)" (server/src/tools/url-gate.ts): say it is on, and
      // where it goes off
      if (body.kind === 'ask_user' && r.kind === 'ask_user' && r.origin === 'server' && body.answer === ALL_SITES_ANSWER)
        toast({ level: 'success', text: t('settings.browser.allOnFromCard'), action: { label: t('settings.browser.open'), run: () => navigateTo('/settings/browser') } })
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
      setBusy(false)
    }
  }

  if (r.kind === 'browser_site')
    return (
      <div className="my-3 rounded-2xl border border-warn/40 px-4 py-3" role="group" aria-label={t('ask.siteTitle')} data-testid="site-card">
        <p className="flex items-center gap-1.5 text-xs font-medium text-warn">
          <Globe size={14} aria-hidden /> {t('ask.siteTitle')}
        </p>
        <div className="mt-1 space-y-2 text-sm">
          <p>{t('ask.siteBody', { host: r.host })}</p>
          <p className="truncate text-xs text-faint" title={r.url}>
            {r.url}
          </p>
          {r.reason && <p className="text-xs text-muted">{r.reason}</p>}
          <ChoiceRow
            className="pt-1"
            busy={busy}
            error={error}
            choices={[
              { label: t('browser.allowOnce'), onClick: () => void run({ kind: 'browser_site', decision: 'once' }) },
              { label: t('browser.allowAlways'), onClick: () => void run({ kind: 'browser_site', decision: 'always' }) },
              { label: t('browser.deny'), onClick: () => void run({ kind: 'browser_site', decision: 'deny' }) },
            ]}
          />
        </div>
      </div>
    )

  // a dev-environment command needs a site that is not allowed: only the person who owns the turn gets this card
  if (r.kind === 'dev_env_site')
    return (
      <div className="my-3 overflow-hidden rounded-2xl border border-warn/40" role="group" aria-label={t('devEnvSite.title', { host: r.host })} data-testid="dev-env-site-card">
        <div className="flex items-center gap-2 bg-warn-soft px-4 py-2.5 text-sm font-semibold text-warn">
          <Globe size={16} aria-hidden /> <span className="min-w-0 break-all">{t('devEnvSite.title', { host: r.host })}</span>
        </div>
        <div className="space-y-2 px-4 py-3 text-sm">
          {r.command && <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-subtle px-2 py-1 font-mono text-xs text-muted" data-testid="dev-env-site-command">{r.command}</pre>}
          <p className="text-xs text-muted">{t('devEnvSite.body')}</p>
          <ChoiceRow
            className="pt-1"
            busy={busy}
            error={error}
            choices={[
              { label: t('devEnvSite.allowOnce'), onClick: () => void run({ kind: 'dev_env_site', decision: 'once' }), testId: 'dev-env-site-once' },
              { label: t('devEnvSite.allowAlways'), onClick: () => void run({ kind: 'dev_env_site', decision: 'always' }), testId: 'dev-env-site-always' },
              { label: t('devEnvSite.deny'), onClick: () => void run({ kind: 'dev_env_site', decision: 'deny' }), testId: 'dev-env-site-deny' },
            ]}
          />
        </div>
      </div>
    )

  // a connect_service card is ConnectCard (Messages.tsx): its key never goes through /answer
  if (r.kind === 'connect_service') return null

  const options = r.options ?? []
  const allowText = r.allowText ?? options.length === 0
  const value: string | string[] | null = r.multiple ? [...picked, ...(text.trim() ? [text.trim()] : [])] : (picked[0] ?? (text.trim() || null))
  const ready = Array.isArray(value) ? value.length > 0 : !!value
  const toggle = (v: string) => setPicked((p) => (r.multiple ? (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]) : [v]))

  const fromServer = r.origin === 'server'
  // the server's yes/no (a change in a room, saving where more people see it, a team skill, an address, a send): two
  // buttons, "no" neutral and "yes" primary, like Claude Code's permission prompt. The first option is the yes. A
  // question with more choices keeps its radios and [답하기].
  if (fromServer && !allowText && !r.multiple && options.length === 2) {
    const [yes, no] = options as [(typeof options)[number], (typeof options)[number]]
    const pick = (v: string) => {
      setPicked([v])
      void run({ kind: 'ask_user', answer: v })
    }
    return (
      <div className="my-3 rounded-2xl border border-warn/40 px-4 py-3" role="group" aria-labelledby={`${name}-q`} data-testid="ask-card" data-origin="server" data-kind="confirm">
        <p className="flex items-center gap-1.5 text-xs font-medium text-warn">
          <ShieldAlert size={14} aria-hidden /> {t('ask.serverTitle')}
        </p>
        <p id={`${name}-q`} className="mt-1 whitespace-pre-wrap text-sm font-medium [overflow-wrap:anywhere]">
          {r.question}
        </p>
        {r.preview && <div className="mt-2.5"><SkillPreview p={r.preview} /></div>}
        {r.details?.length ? <Details items={r.details} plain /> : null}
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {error && <span role="alert" className="mr-auto text-xs text-danger">{error}</span>}
          <Button size="sm" variant="ghost" disabled={busy} busy={busy && picked[0] === no.value} onClick={() => pick(no.value)} data-testid="ask-no">
            {no.label}
          </Button>
          <Button size="sm" variant="primary" disabled={busy} busy={busy && picked[0] === yes.value} onClick={() => pick(yes.value)} data-testid="ask-yes">
            {yes.label}
          </Button>
        </div>
        {r.note && <p className="mt-2 text-right text-xs text-muted" data-testid="ask-note">{r.note}</p>}
      </div>
    )
  }
  // a server card whose three choices are buttons (a room's change card): once, always here, no (the server's order:
  // the first the main one, the last the quiet "no"). The same compact card, the buttons shown in the yes/no card's
  // order (ChoiceRow: on a computer the "no" first, the main one last); the line under them says what "always" covers
  if (fromServer && !allowText && !r.multiple && r.buttons && options.length === 3) {
    const pick = (v: string) => {
      setPicked([v])
      void run({ kind: 'ask_user', answer: v })
    }
    return (
      <div className="my-3 rounded-2xl border border-warn/40 px-4 py-3" role="group" aria-labelledby={`${name}-q`} data-testid="ask-card" data-origin="server" data-kind="buttons">
        <p className="flex items-center gap-1.5 text-xs font-medium text-warn">
          <ShieldAlert size={14} aria-hidden /> {t('ask.serverTitle')}
        </p>
        <p id={`${name}-q`} className="mt-1 whitespace-pre-wrap text-sm font-medium [overflow-wrap:anywhere]">
          {r.question}
        </p>
        {/* a project skill whose name is taken elsewhere: another name, or the one that runs (docs/DECISIONS.md "Project skills") */}
        {r.preview && <div className="mt-2.5"><SkillPreview p={r.preview} /></div>}
        {r.details?.length ? <Details items={r.details} plain /> : null}
        <ChoiceRow
          className="mt-3"
          busy={busy}
          error={error}
          choices={options.map((o): Choice => ({ label: o.label, onClick: () => pick(o.value), busy: busy && picked[0] === o.value, testId: 'ask-choice', value: o.value })) as [Choice, Choice, Choice]}
        />
        {r.note && <p className="mt-2 text-xs text-muted sm:text-right" data-testid="ask-note">{r.note}</p>}
      </div>
    )
  }
  return (
    <form
      className={clsx('my-3 overflow-hidden rounded-2xl border', fromServer ? 'border-warn/40' : 'border-line')}
      data-testid="ask-card"
      data-origin={fromServer ? 'server' : 'ai'}
      onSubmit={(e) => {
        e.preventDefault()
        if (ready && secret.pass()) void run({ kind: 'ask_user', answer: value })
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
              ref={textRef}
              aria-label={t('ask.ownAnswer')}
              aria-describedby={`${name}-secrets`}
              className={clsx(inputCls, 'h-auto min-h-16 resize-y py-2')}
              placeholder={options.length ? t('ask.orType') : t('ask.typeAnswer')}
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                if (!r.multiple && e.target.value) setPicked([])
              }}
              data-testid="ask-text"
            />
          )}
          {/* tab 5 "확인 카드": the free-text answer goes to the AI; this line is always there under it */}
          {allowText && (
            <p id={`${name}-secrets`} className="text-xs text-faint" data-testid="ask-no-secrets">
              {t('ask.noSecrets')}
            </p>
          )}
          {secret.held && (
            <div className="pt-1">
              <SecretWarning
                onSendAnyway={() => {
                  secret.release()
                  void run({ kind: 'ask_user', answer: value })
                }}
                onEdit={() => {
                  secret.release()
                  textRef.current?.focus()
                }}
              />
            </div>
          )}
        </fieldset>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2.5">
        {error && <span role="alert" className="mr-auto text-xs text-danger">{error}</span>}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => run({ kind: 'ask_user', answer: null })}>
          {t('ask.skip')}
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={!ready} busy={busy} data-testid="ask-send">
          {t('ask.send')}
        </Button>
      </div>
    </form>
  )
}

interface Choice { label: string; onClick: () => void; busy?: boolean; testId?: string; value?: string }

/** Three choices as buttons (a room's change card, an address, a dev-environment site), given in the server's order:
 * the main one, "always", the quiet "no", and kept in that order in the page, so the keyboard and a screen reader meet
 * them as a phone shows them: stacked full width, the main one on top (as the skill share card's stacked buttons). On a
 * computer one row in the order of the yes/no card and of every dialog (docs/DESIGN-SYSTEM.md), the row reversed: the
 * "no" first and the main one last, on the right. A failed answer's reason comes after the buttons, under them. */
const CHOICE_LOOKS = ['primary', 'secondary', 'ghost'] as const
function ChoiceRow({ choices, busy, error, className }: { choices: [Choice, Choice, Choice]; busy: boolean; error: string | null; className?: string }) {
  return (
    <div className={className}>
      <div className="flex flex-col gap-2 sm:flex-row-reverse sm:flex-wrap sm:items-center" data-testid="ask-choices">
        {choices.map((c, i) => (
          <Button key={i} size="sm" variant={CHOICE_LOOKS[i]} className="max-sm:w-full" disabled={busy} busy={c.busy} onClick={c.onClick} data-testid={c.testId} data-value={c.value}>
            {c.label}
          </Button>
        ))}
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-danger sm:text-right">{error}</p>}
    </div>
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
        <pre className="scroll-thin max-h-64 overflow-auto px-0 py-1 font-mono text-code-sm leading-5" data-testid="skill-preview-diff">
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
      {p.truncated && <p className="border-t border-line px-3 py-1 text-micro text-faint">{t('ask.skillTruncated')}</p>}
      {p.problem && <p className="border-t border-line bg-warn-soft px-3 py-1.5 text-xs text-warn" data-testid="skill-preview-problem">{issueText(t, { path: p.path, problem: p.problem })}</p>}
      {/* a skill of the same name at another level the person sees: which one runs (the server's words) */}
      {p.sameName && <p className="border-t border-line bg-warn-soft px-3 py-1.5 text-xs text-warn" data-testid="skill-preview-same-name" data-hidden={p.sameName.hidden || undefined}>{p.sameName.text}</p>}
    </div>
  )
}

/** What a server check is about to let out, every character of it (a connected service's write with where it goes, a
 * scheduled task's instruction and its addresses): scrollable, with its size; long random-looking parts highlighted.
 * `plain` (a yes/no card): no boxes, the fields as name–value lines and the text under its label with a rule beside it. */
function Details({ items, plain }: { items: ConfirmDetail[]; plain?: boolean }) {
  const t = useT()
  if (plain)
    return (
      <div className="mt-2.5 space-y-2.5" data-testid="ask-details">
        {items.map((d, i) => (
          <div key={i} className="space-y-1.5 text-sm" data-testid="ask-detail">
            {d.fields?.length ? (
              <div role="group" aria-label={d.label} data-testid="ask-detail-fields">
                {/* the names' column as wide as the longest one ("파일", "고칠 수 있게 돼요"), at least 3.5rem */}
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                  {d.fields.map((f, j) => (
                    <div key={j} className="contents">
                      <dt className="min-w-14 text-faint">{f.name}</dt>
                      <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{f.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}
            {d.text && (
              <div>
                <p className="flex items-baseline gap-2 text-xs text-faint">
                  <span className="min-w-0 flex-1">{d.label}</span>
                  {!d.noSize && <span data-testid="ask-detail-size">{t('ask.detailSize', { n: d.text.length })}</span>}
                </p>
                <div className="mt-1 border-l-2 border-line">
                  <DetailText d={d} plain />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    )
  return (
    <div className="mb-2 space-y-2" data-testid="ask-details">
      {items.map((d, i) => (
        <div key={i} className="overflow-hidden rounded-lg border border-line" data-testid="ask-detail">
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-subtle px-3 py-1.5 text-xs">
            <span className="min-w-0 flex-1 font-medium">{d.label}</span>
            {d.text && !d.noSize && (
              <span className="text-faint" data-testid="ask-detail-size">
                {t('ask.detailSize', { n: d.text.length })}
              </span>
            )}
          </div>
          {d.fields?.length ? (
            <div
              className={clsx('scroll-thin max-h-40 space-y-0.5 overflow-auto px-3 py-1.5 font-mono text-xs', d.text && 'border-b border-line')}
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
          {/* a detail of named fields only (a room change card's rename: the file and its new name) has no text */}
          {d.text && <DetailText d={d} />}
        </div>
      ))}
    </div>
  )
}

/** A detail's text: all of it, or with `collapsedAt` its start and the rest one click away (a room change card's
 * preview of what a call writes; the size above always counts all of it). */
function DetailText({ d, plain }: { d: ConfirmDetail; plain?: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const long = d.collapsedAt !== undefined && d.text.length > d.collapsedAt
  const text = long && !open ? `${d.text.slice(0, d.collapsedAt).trimEnd()}…` : d.text
  return (
    <>
      <pre
        className={clsx('scroll-thin max-h-64 overflow-auto font-mono text-code-sm leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]', plain ? 'py-0.5 pl-3' : 'px-3 py-2')}
        tabIndex={0}
        aria-label={d.label}
        data-testid="ask-detail-text"
      >
        <Marked text={text} marks={d.marks} alerts={d.alerts} />
      </pre>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={clsx('block text-left text-xs font-medium text-muted hover:text-ink', plain ? 'mt-1 ml-3 rounded px-0 py-1 underline-offset-2 hover:underline' : 'w-full border-t border-line px-3 py-1.5 hover:bg-hover')}
          data-testid="ask-detail-more"
        >
          {open ? t('ask.detailLess') : t('ask.detailAll')}
        </button>
      )}
    </>
  )
}

/** The text with the server's marks (long random-looking parts) highlighted, and its alert lines in red with their
 * note (a name not in the person's own messages, on the AI's members card). */
function Marked({ text, marks, alerts }: { text: string; marks?: string[]; alerts?: ConfirmDetail['alerts'] }) {
  if (alerts?.length) {
    const note = new Map(alerts.map((a) => [a.text, a.note]))
    const lines = text.split('\n')
    return (
      <>
        {lines.map((l, i) => {
          const n = note.get(l)
          return (
            <span key={i}>
              {n === undefined ? <Marked text={l} marks={marks} /> : (
                <>
                  <span className="font-medium text-danger" data-testid="ask-detail-alert">{l}</span>
                  {/* the note in the card's own type, one step smaller (the line around it is monospace) */}
                  <span className="ml-2 inline-block rounded bg-danger-soft px-1.5 font-sans text-xs font-medium text-danger" data-testid="ask-detail-alert-note">{n}</span>
                </>
              )}
              {i < lines.length - 1 ? '\n' : ''}
            </span>
          )
        })}
      </>
    )
  }
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
