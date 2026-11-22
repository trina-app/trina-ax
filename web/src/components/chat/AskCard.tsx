// ask_user: the AI asks back mid-answer (options and/or free text), browser_site: the in-app browser wants an
// office-network address, and dev_env_site: a dev-environment command needs a site that is not allowed. Answered with POST /api/turns/:id/answer; closed by turn.request.closed (answered in
// another window, timed out, turn ended). Ordinary form controls (buttons / checkboxes) for keyboards
// and screen readers. The AI's own questions can also be answered from the message box (lib/askAnswer.ts): what is
// ticked here goes along with that answer when the question takes several. The same card outside a turn (a scheduled
// task's card shown again in Settings, "다시 확인") passes its own `onAnswer`. The server's yes/no cards are two buttons
// ([허용 안 함] [이번만 허용]) with what they let happen as plain lines; a server card that says its three choices are
// buttons (`buttons`: a room's change card) shows them in one row in the same order, the main one last
// ([허용 안 함] [이 방에서는 항상 허용] [이번만 허용]; stacked on a phone, the main one on top and first in the page: ChoiceRow,
// as the address and dev-environment cards) with its one line under them (`note`). The AI's own question that takes
// one choice: a press on an option answers it (one click per decision, QA TC-ask1-15), the options being buttons; while
// the card's own box holds typed text they are off (nothing typed is lost) and [답하기] sends the text. A server card
// with more choices keeps its radios and [답하기]; a question that takes several keeps its checkboxes and [답하기].
import clsx from 'clsx'
import { Globe, MessageCircleQuestion, ShieldAlert } from 'lucide-react'
import { type ReactNode, useContext, useEffect, useId, useRef, useState } from 'react'
import { api, API, errorText } from '../../lib/api'
import { BoxAnswers, forgetPicks, rememberPicks } from '../../lib/askAnswer'
import { useFolderWords } from '../../lib/folderLabels'
import { issueText } from '../../lib/skillIssues'
import { useLocale, useT } from '../../i18n'
import { useChats, type OpenRequest } from '../../store/chats'
import { PRODUCT_NAMED_AFTER_AI, type ConfirmDetail, type SkillWritePreview } from '@mycel/shared/api'
import { ALL_SITES_ANSWER } from '@mycel/shared'
import { navigateTo } from '../../lib/nav'
import { isPhone } from '../../lib/screenHistory'
import { toast } from '../../store/ui'
import { useSession } from '../../store/session'
import { Button, inputCls } from '../ui'
import { SecretWarning, useSecretHold } from './SecretWarning'
import { ShareAskRows } from './ShareCard'
import { Markdown } from '../LazyMarkdown'

/** a card's turn and id: where a folded detail's whole text is read (GET /api/turns/:id/requests/:requestId/details/:index) */
type FullAt = { turnId: string; requestId: string }

type AnswerBody = Parameters<ReturnType<typeof useChats.getState>['answer']>[1]

export default function AskCard({ req, onAnswer }: { req: Pick<OpenRequest, 'request'> & { turnId?: string }; onAnswer?: (requestId: string, body: AnswerBody) => Promise<void> }) {
  const t = useT()
  const locale = useLocale()
  const storeAnswer = useChats((s) => s.answer)
  const answer = onAnswer ?? storeAnswer
  const [picked, setPicked] = useState<string[]>([])
  const [text, setText] = useState('')
  /** typed in the card's own box once: it keeps that box (see inBox) */
  const [typedHere, setTypedHere] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = useId()
  /** the own answer looks like a key: it waits for "Send anyway" (SecretWarning) */
  const secret = useSecretHold(text)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const r = req.request
  /** where a long detail's whole text is read (ConfirmDetail.fullChars): the card's own turn */
  const full = req.turnId ? { turnId: req.turnId, requestId: r.requestId } : null
  const boxAnswers = useContext(BoxAnswers)
  useEffect(() => rememberPicks(r.requestId, picked), [r.requestId, picked])
  useEffect(() => () => forgetPicks(r.requestId), [r.requestId])

  const run = async (body: AnswerBody) => {
    setBusy(true)
    setError(null)
    try {
      await answer(r.requestId, body)
      // the address card's "Allow all websites (turn off in Settings)" (server/src/tools/url-gate.ts): say it is on, and
      // where it goes off, only once Me says so (an admin may have turned the team's switch off while the card was open:
      // then the address opened and the switch stayed off)
      if (body.kind === 'ask_user' && r.kind === 'ask_user' && r.origin === 'server' && body.answer === ALL_SITES_ANSWER) void toastWhenOn(t)
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
  const fromServer = r.origin === 'server'
  // the message box under the chat answers this question (lib/askAnswer.ts, docs/DECISIONS.md "The message box answers
  // the AI's open question"): typing goes there only, so the card has no second text box and no second secrets line,
  // just a line saying where to type (TRINA-24). Text already typed here (the card became the box's question later,
  // when an older one closed) keeps its box.
  const inBox = !fromServer && !onAnswer && boxAnswers === r.requestId && !typedHere
  const allowText = (r.allowText ?? options.length === 0) && !inBox
  const value: string | string[] | null = r.multiple ? [...picked, ...(text.trim() ? [text.trim()] : [])] : (picked[0] ?? (text.trim() || null))
  const ready = Array.isArray(value) ? value.length > 0 : !!value
  // one press answers only the AI's own single-choice question; a server card's choices (more than its two-button and
  // three-button forms above) keep radios and [답하기]: the press there is a decision the card weighs
  const onePress = !fromServer && !r.multiple
  const toggle = (v: string) => setPicked((p) => (r.multiple ? (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]) : [v]))

  // the server's yes/no (a change in a room, saving where more people see it, a team skill, an address, a send): two
  // buttons, "no" neutral and "yes" primary, like Claude Code's permission prompt. The first option is the yes. A
  // question with more choices is the form below (one press answers it).
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
        {/* a share or a stop (AskUserRequest.share): the files and people as rows, the card its result card becomes */}
        {r.share ? <ShareAskRows ask={r.share} titleId={`${name}-q`} /> : (
          <p id={`${name}-q`} className="mt-1 whitespace-pre-wrap text-sm font-medium [overflow-wrap:anywhere]">
            <QuestionText r={r} />
          </p>
        )}
        {r.preview && <div className="mt-2.5"><SkillPreview p={r.preview} /></div>}
        {!r.share && r.details?.length ? <Details items={r.details} plain full={full} /> : null}
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
        {r.share ? <ShareAskRows ask={r.share} titleId={`${name}-q`} /> : (
          <p id={`${name}-q`} className="mt-1 whitespace-pre-wrap text-sm font-medium [overflow-wrap:anywhere]">
            <QuestionText r={r} />
          </p>
        )}
        {/* a project skill whose name is taken elsewhere: another name, or the one that runs (docs/DECISIONS.md "Project skills") */}
        {r.preview && <div className="mt-2.5"><SkillPreview p={r.preview} /></div>}
        {!r.share && r.details?.length ? <Details items={r.details} plain full={full} /> : null}
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
          <legend className="mb-2.5 whitespace-pre-wrap text-sm font-medium [overflow-wrap:anywhere]">{fromServer ? <QuestionText r={r} /> : r.question}</legend>
          {fromServer && r.preview && <SkillPreview p={r.preview} />}
          {fromServer && r.details?.length ? <Details items={r.details} full={full} /> : null}
          {/* the AI's own question with one choice: each option is a button that answers at once; off while the card's
              own box holds typed text. A server card's choices (a decision with a card's weight) are picked, then sent */}
          {options.length > 0 && onePress && (
            <div className="flex flex-col gap-1.5">
              {options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  disabled={busy || !!text.trim()}
                  aria-busy={busy && picked[0] === o.value ? true : undefined}
                  onClick={() => {
                    setPicked([o.value])
                    void run({ kind: 'ask_user', answer: o.value })
                  }}
                  className={clsx('flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm [overflow-wrap:anywhere] disabled:cursor-not-allowed disabled:opacity-50', busy && picked[0] === o.value ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover')}
                  data-testid="ask-option"
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
          {options.length > 0 && !onePress && (
            <div className="flex flex-col gap-1.5">
              {options.map((o) => (
                <label key={o.value} className={clsx('flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm', picked.includes(o.value) ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover')}>
                  <input type={r.multiple ? 'checkbox' : 'radio'} name={name} value={o.value} checked={picked.includes(o.value)} onChange={() => toggle(o.value)} className="accent-[var(--c-accent)]" />
                  {o.label}
                </label>
              ))}
            </div>
          )}
          {/* a server card with four choices (the team folder card that also asks about file shares, with "Always allow"):
              its line about the file shares and what "Always allow" covers, as on the button cards */}
          {fromServer && r.note && <p className="whitespace-pre-wrap text-xs text-muted" data-testid="ask-note">{r.note}</p>}
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
                setTypedHere(true)
                if (!r.multiple && e.target.value) setPicked([])
              }}
              data-testid="ask-text"
            />
          )}
          {inBox && (
            <p className="text-xs text-muted" data-testid="ask-in-box">
              {t(options.length ? 'ask.inBoxOr' : 'ask.inBox')}
            </p>
          )}
          {/* tab 5 "확인 카드": the free-text answer goes to the AI; this line is always under the box it is typed in (here, or
              the message box's own when that answers: inBox) */}
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
        {/* ticks to send, or text typed here; one choice is sent by its own button, and typing in the message box by
            that box's button */}
        {((!onePress && options.length > 0) || allowText) && (
          <Button size="sm" variant="primary" type="submit" disabled={!ready} busy={busy} data-testid="ask-send">
            {t('ask.send')}
          </Button>
        )}
      </div>
    </form>
  )
}

interface Choice { label: string; onClick: () => void; busy?: boolean; testId?: string; value?: string }

/** A server card's question, with the part the server marks (AskUserRequest.placeTip: the wider-audience card's file
 * name) showing the whole place on hover (docs/decisions/20261122-widening-card-wording.md). */
function QuestionText({ r }: { r: { question: string; placeTip?: { text: string; title: string } } }) {
  const tip = r.placeTip
  const at = tip ? r.question.indexOf(tip.text) : -1
  if (!tip || at < 0) return <>{r.question}</>
  return (
    <>
      {r.question.slice(0, at)}
      <span title={tip.title} className="underline decoration-dotted decoration-1 underline-offset-2" data-testid="ask-place">{tip.text}</span>
      {r.question.slice(at + tip.text.length)}
    </>
  )
}

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

/** A new skill's SKILL.md in plain words (QA MAN-052: the card showed only the raw file, "---", "name:", "## Steps"):
 * its description and the titles of its parts, read from the diff (a new file: every line added). null for a change,
 * a rule or a file that is not a skill. */
export function newSkillSummary(p: Pick<SkillWritePreview, 'isNew' | 'skillName' | 'diff'>): { description: string | null; parts: string[] } | null {
  if (!p.isNew || !p.skillName) return null
  const lines = p.diff.split('\n')
  if (!lines[0]?.startsWith('@@')) return null
  const text = lines.slice(1).filter((l) => l.startsWith('+')).map((l) => l.slice(1))
  let i = 0
  let description: string | null = null
  if (text[0]?.trim() === '---') {
    for (i = 1; i < text.length && text[i]!.trim() !== '---'; i++) {
      const m = /^description:\s*(.+)$/.exec(text[i]!.trim())
      if (m) description = m[1]!.replace(/^["']|["']$/g, '').trim() || null
    }
    i++
  }
  const parts = text.slice(i).map((l) => /^#{2,3}\s+(.+)$/.exec(l.trim())?.[1]?.trim()).filter((x): x is string => !!x).slice(0, 8)
  return { description, parts }
}

/** What the AI is about to save under skills/ (team skills and rules every teammate's AI follows): the diff. A new
 * skill first in plain words (what it does, its parts), the file itself one click away. */
function SkillPreview({ p }: { p: SkillWritePreview }) {
  const t = useT()
  const words = useFolderWords()
  const lines = p.diff.split('\n')
  const isDiff = lines[0]?.startsWith('@@')
  const sum = newSkillSummary(p)
  const plain = sum && (sum.description || sum.parts.length) ? sum : null
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-line" data-testid="skill-preview">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-subtle px-3 py-1.5 text-xs">
        {/* the file in words (팀 스킬 › 회의록 › SKILL.md), its path on hover */}
        <span className="min-w-0 flex-1 truncate" title={p.path} data-testid="skill-preview-path">
          {words.path(p.path, ' › ')}
        </span>
        <span className="text-faint">{p.isNew ? t('ask.skillNew') : t('ask.skillChange')}</span>
        {isDiff && (
          <span className="font-mono text-faint" data-testid="skill-preview-count">
            {t('ask.skillLines', { added: p.added, removed: p.removed })}
          </span>
        )}
      </div>
      {plain && (
        <div className="space-y-1 px-3 py-2 text-sm" data-testid="skill-preview-summary">
          {plain.description && <p data-testid="skill-preview-does"><span className="text-muted">{t('ask.skillDoes')}</span> {plain.description}</p>}
          {plain.parts.length > 0 && <p data-testid="skill-preview-parts"><span className="text-muted">{t('ask.skillParts')}</span> {plain.parts.join(' · ')}</p>}
        </div>
      )}
      {isDiff && plain ? (
        <details className="border-t border-line" data-testid="skill-preview-file">
          <summary className="cursor-pointer px-3 py-1.5 text-xs text-muted hover:text-ink">{t('ask.skillShowFile')}</summary>
          <SkillDiff lines={lines} />
        </details>
      ) : isDiff ? (
        <SkillDiff lines={lines} />
      ) : (
        <p className="px-3 py-2 text-xs text-muted">{p.diff}</p>
      )}
      {p.truncated && <p className="border-t border-line px-3 py-1 text-micro text-faint">{t('ask.skillTruncated')}</p>}
      {p.files?.length ? <HeldFiles files={p.files} /> : null}
      {p.problem && <p className="border-t border-line bg-warn-soft px-3 py-1.5 text-xs text-warn" data-testid="skill-preview-problem">{issueText(t, { path: p.path, problem: p.problem })}</p>}
      {/* a skill of the same name at another level the person sees: which one runs (the server's words) */}
      {p.sameName && <p className="border-t border-line bg-warn-soft px-3 py-1.5 text-xs text-warn" data-testid="skill-preview-same-name" data-hidden={p.sameName.hidden || undefined}>{p.sameName.text}</p>}
    </div>
  )
}

/** A new skill's other files that the same card saves (a form, a template; docs/decisions/
 * 20261117-new-skill-files-on-card.md): each by name, size and first lines, its whole text one click away. */
function HeldFiles({ files }: { files: NonNullable<SkillWritePreview['files']> }) {
  const t = useT()
  return (
    <div className="border-t border-line px-3 py-2 text-sm" data-testid="skill-preview-files">
      <p className="text-muted">{t('ask.skillFiles', { count: files.length })}</p>
      <ul className="mt-1 space-y-1">
        {files.map((f) => (
          <li key={f.path} data-testid="skill-preview-held">
            <details>
              <summary className="cursor-pointer">
                <span className="font-medium" title={f.path}>{f.path.split('/').at(-1)}</span>{' '}
                <span className="font-mono text-xs text-faint">{f.size} B</span>
                {f.lines && <span className="block whitespace-pre-wrap pl-4 text-xs text-muted [overflow-wrap:anywhere]">{f.lines}</span>}
              </summary>
              <pre className="scroll-thin mt-1 max-h-64 overflow-auto rounded bg-subtle px-3 py-1 font-mono text-code-sm leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="skill-preview-held-text">{f.text}</pre>
            </details>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The skill card's diff: added lines green, removed red. */
function SkillDiff({ lines }: { lines: string[] }) {
  return (
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
  )
}

/** What a server check is about to let out, every character of it (a connected service's write with where it goes, a
 * scheduled task's instruction and its addresses): scrollable, with its size; long random-looking parts highlighted, in
 * the fields too. `plain` (a yes/no card): no boxes, the fields as name–value lines and the text under its label with a
 * rule beside it. `exact` (a connected service's call, docs/DECISIONS.md "Plain words in errors, cards and steps"): the
 * fields already show every value, so the text (its exact JSON) is one click away, "보내는 내용 그대로 보기". */
function Details({ items, plain, full }: { items: ConfirmDetail[]; plain?: boolean; full?: FullAt | null }) {
  const t = useT()
  if (plain)
    return (
      <div className="mt-2.5 space-y-2.5" data-testid="ask-details">
        {items.map((d, i) => (
          <div key={i} className="space-y-1.5 text-sm" data-testid="ask-detail">
            {d.fields?.length ? (
              <div role="group" aria-label={d.label} data-testid="ask-detail-fields">
                {/* the names' column as wide as the longest one ("파일", "고칠 수 있게 돼요"), at least 3.5rem and at most
                    40%: a long name wraps and never squeezes the values off the card; marks show in names too */}
                <dl className="grid grid-cols-[fit-content(40%)_minmax(0,1fr)] gap-x-3 gap-y-1">
                  {d.fields.map((f, j) => (
                    <div key={j} className="contents">
                      <dt className="min-w-14 text-faint [overflow-wrap:anywhere]"><Marked text={f.name} marks={d.marks} /></dt>
                      {/* a long value scrolls in place, so the next name stays near; the marks are highlighted here too */}
                      {f.code ? (
                        <dd className="min-w-0" data-testid="ask-detail-value"><CodeValue text={f.value} label={f.name} marks={d.marks} /></dd>
                      ) : (
                        <dd className={clsx('min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]', f.value.length > 600 && 'scroll-thin max-h-48 overflow-auto')} tabIndex={f.value.length > 600 ? 0 : undefined} data-testid="ask-detail-value">
                          <Marked text={f.value} marks={d.marks} />
                        </dd>
                      )}
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}
            {d.text && (
              <Folded d={d} plain>
              <Exact d={d} plain>
                <div>
                  <p className="flex items-baseline gap-2 text-xs text-faint">
                    <span className="min-w-0 flex-1">{d.label}</span>
                    {!d.noSize && !d.markdown && <span data-testid="ask-detail-size">{t('ask.detailSize', { n: d.fullChars ?? d.text.length })}</span>}
                  </p>
                  <div className="mt-1 border-l-2 border-line">
                    <DetailText d={d} plain full={full && { ...full, index: i }} />
                  </div>
                </div>
              </Exact>
              </Folded>
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
            {d.text && !d.noSize && !d.markdown && (
              <span className="text-faint" data-testid="ask-detail-size">
                {t('ask.detailSize', { n: d.fullChars ?? d.text.length })}
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
                  <span className="max-w-[40%] shrink-0 text-faint [overflow-wrap:anywhere]"><Marked text={f.name} marks={d.marks} /></span>
                  {f.code ? (
                    <span className="min-w-0 flex-1" data-testid="ask-detail-value"><CodeValue text={f.value} label={f.name} marks={d.marks} /></span>
                  ) : (
                    <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="ask-detail-value"><Marked text={f.value} marks={d.marks} /></span>
                  )}
                </div>
              ))}
            </div>
          ) : null}
          {/* a detail of named fields only (a room change card's rename: the file and its new name) has no text */}
          {d.text && <Folded d={d}><Exact d={d}><DetailText d={d} full={full && { ...full, index: i }} /></Exact></Folded>}
        </div>
      ))}
    </div>
  )
}

/** A script as it runs (a field with `code`: a declared CLI's stdin), in a code block: every space, tab and line as sent,
 * never wrapped or trimmed (a long line scrolls sideways); the marks highlighted as in any value. */
function CodeValue({ text, label, marks }: { text: string; label: string; marks?: string[] }) {
  return (
    <pre className="scroll-thin max-h-64 overflow-auto rounded bg-subtle px-2 py-1 font-mono text-code-sm leading-5 whitespace-pre [tab-size:4]" tabIndex={0} aria-label={label} data-testid="ask-detail-code">
      <Marked text={text} marks={marks} />
    </pre>
  )
}

/** A detail's text that is code or a file's content (`folded`: a dev-environment command, what a file will hold) behind
 * "자세히", with its size on the button while closed; the label, the fields and the question above say what happens in
 * words. A text with highlighted parts (marks, alerts) or one formatted for reading (markdown) stays open. */
function Folded({ d, plain, children }: { d: ConfirmDetail; plain?: boolean; children: ReactNode }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  if (!d.folded || d.markdown || d.marks?.length || d.alerts?.length) return <>{children}</>
  return (
    <div className={plain ? undefined : 'border-t border-line'}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={clsx('flex items-baseline gap-2 text-left text-xs font-medium text-muted hover:text-ink', plain ? 'touch-hit rounded py-1 underline-offset-2 hover:underline' : 'w-full px-3 py-1.5 hover:bg-hover')}
        data-testid="ask-detail-folded"
      >
        <span>{open ? t('ask.foldedHide') : t('ask.foldedShow')}</span>
        {!open && !d.noSize && <span className="font-normal text-faint">{t('ask.detailSize', { n: d.fullChars ?? d.text.length })}</span>}
      </button>
      {open && <div className={plain ? 'mt-1' : 'border-t border-line'}>{children}</div>}
    </div>
  )
}

/** A detail's text as it is, behind "보내는 내용 그대로 보기" when the fields above show every value of it (`exact`), with
 * its size on the button while closed; else as it is. Open, it shows what it shows today (its label, size and marks). */
function Exact({ d, plain, children }: { d: ConfirmDetail; plain?: boolean; children: ReactNode }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  if (!d.exact) return <>{children}</>
  return (
    <div className={plain ? undefined : 'border-t border-line'}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={clsx('flex items-baseline gap-2 text-left text-xs font-medium text-muted hover:text-ink', plain ? 'rounded py-1 underline-offset-2 hover:underline' : 'w-full px-3 py-1.5 hover:bg-hover')}
        data-testid="ask-detail-exact"
      >
        <span>{open ? t('ask.exactHide') : t('ask.exactShow')}</span>
        {/* open, the size shows beside the text's label (once) */}
        {!open && !d.noSize && <span className="font-normal text-faint">{t('ask.detailSize', { n: d.fullChars ?? d.text.length })}</span>}
      </button>
      {open && <div className={plain ? 'mt-1' : 'border-t border-line'}>{children}</div>}
    </div>
  )
}

/** A detail's text: all of it, or with `collapsedAt` its start and the rest one click away (a room change card's
 * preview of what a call writes; the size above always counts all of it). `markdown` (a message as the room will show
 * it: post_to_room's card) is formatted with the chat's renderer, in the same scrolling box. */
function DetailText({ d, plain, full }: { d: ConfirmDetail; plain?: boolean; full?: (FullAt & { index: number }) | null }) {
  const t = useT()
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  /** the whole text of a detail the card carries only the start of (fullChars), read when "Show all" is pressed */
  const [whole, setWhole] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const more = !!d.fullChars && d.fullChars > d.text.length
  const long = (d.collapsedAt !== undefined && d.text.length > d.collapsedAt) || more
  const all = whole ?? d.text
  const text = long && !open ? `${d.text.slice(0, d.collapsedAt ?? d.text.length).trimEnd()}…` : more && !whole ? `${all}…` : all
  const toggle = async () => {
    if (open || !more || whole !== null || !full) { setOpen((v) => !v); return }
    setLoading(true)
    try {
      const r = await api.call(API.turnRequestDetail, { params: { id: full.turnId, requestId: full.requestId, index: String(full.index) } })
      setWhole(r.text)
      setOpen(true)
    } catch (e) { toast({ level: 'error', text: errorText(e, locale, t('error.network')) }) } finally { setLoading(false) }
  }
  return (
    <>
      {d.markdown ? (
        <div className={clsx('scroll-thin max-h-64 overflow-auto', plain ? 'py-0.5 pl-3' : 'px-3 py-2')} tabIndex={0} aria-label={d.label} data-testid="ask-detail-text" data-format="markdown">
          <Markdown text={text} size="small" />
        </div>
      ) : (
        <pre
          className={clsx('scroll-thin max-h-64 overflow-auto font-mono text-code-sm leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]', plain ? 'py-0.5 pl-3' : 'px-3 py-2')}
          tabIndex={0}
          aria-label={d.label}
          data-testid="ask-detail-text"
        >
          <Marked text={text} marks={d.marks} alerts={d.alerts} />
        </pre>
      )}
      {/* the card carries only the start: it says so, with the whole size, before anyone opens it */}
      {more && !whole && <p className={clsx('text-xs text-muted', plain ? 'mt-1 ml-3' : 'border-t border-line px-3 py-1.5')} data-testid="ask-detail-partial">{t('ask.detailPartial', { shown: (open ? d.text.length : Math.min(d.collapsedAt ?? d.text.length, d.text.length)).toLocaleString(locale), n: d.fullChars!.toLocaleString(locale) })}</p>}
      {long && (
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={loading}
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

/** After the card's "Allow all websites": read Me again (the server sets the switch as the card closes) and say it is on
 * only when it is, with where to turn it off on this screen: a phone has no Browser row, the switch is a part of
 * 트리나에게 허용한 것 there (SettingsDialog.tsx PHONE_FOLDED), and Open lands on it either way. */
async function toastWhenOn(t: ReturnType<typeof useT>) {
  for (const wait of [300, 1000, 3000]) {
    await new Promise((r) => setTimeout(r, wait))
    await useSession.getState().refreshMe().catch(() => {})
    const st = useSession.getState().status
    if (st.kind === 'signed-in' && st.me.user.webAllowAll === true) {
      const place = t(isPhone() ? (PRODUCT_NAMED_AFTER_AI ? 'settings.allowances' : 'settings.allowancesAi') : 'settings.browser')
      toast({ level: 'success', text: t('settings.browser.allOnFromCard', { place }), action: { label: t('settings.browser.open'), run: () => navigateTo('/settings/browser') } })
      return
    }
  }
}
