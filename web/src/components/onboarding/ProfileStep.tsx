// The company profile step (docs/DECISIONS.md "D — Company profile from the company website"). Standalone: the
// wave-2 welcome wizard and Admin > Team settings (CompanyProfileCard.tsx) both use it.
//   website → "읽는 중" (the AI reads it in a chat of this person: server/src/onboarding/draft.ts) → "이렇게 이해했어요":
//   every field editable, its source page and excerpt under it, a wrong one removed with one click → Save
//   (PUT /api/onboarding/profile). The AI never saves anything: the person does.
// When the site can't be read (or there is none): paste a text (the same draft, from the text) or answer three
// questions (무엇을 파나요 / 누구에게 / 어떤 말투로), which go straight to the same review.
// A draft is an AI answer: with no AI the person can use (GET /api/me/ai-access, stream A), the step says so with A's
// connect button instead of starting one, and the three questions (no AI needed) stay open.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, X } from 'lucide-react'
import { normalizeWebsite, PROFILE_FIELDS, PROFILE_LIMITS, PROFILE_TEXT_MAX, profileName, type CompanyProfile, type CompanyProfileInput, type ProfileField, type ProfileSource } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { setupSite } from '../../lib/setupLink'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { useAiAccess } from '../../store/aiAccess'
import { useMe } from '../../store/session'
import { toast } from '../../store/ui'
import AiAccessBanner from '../chat/AiAccessBanner'
import { Button, ErrorNote, Field, IconButton, inputCls, Spinner } from '../ui'

export interface ProfileStepProps {
  /** saved: the profile as the server keeps it */
  onDone: (profile: CompanyProfile) => void
  /** "later" (the wizard) or "cancel" (an edit dialog); no button without it */
  onSkip?: () => void
  skipLabel?: string
  /** a saved profile to start from: the review opens with it */
  initial?: CompanyProfile | null
  /** the website to start with; default: the one the setup link carried in this tab */
  initialWebsite?: string | null
}

type Phase =
  | { kind: 'site' }
  | { kind: 'reading'; chatId: string; source: 'website' | 'text' }
  | { kind: 'fallback'; unreadable: boolean; error: string | null }
  | { kind: 'paste' }
  | { kind: 'questions' }
  | { kind: 'review' }

const POLL_MS = 2500
const blank = (website = ''): CompanyProfileInput => ({ website, name: '', oneLine: '', products: '', audience: '', tone: [], avoid: '', sources: [] })
const FIELD_LABEL: Record<ProfileField | 'website', MessageKey> = {
  website: 'onboarding.profile.f.website', name: 'onboarding.profile.f.name', oneLine: 'onboarding.profile.f.oneLine', products: 'onboarding.profile.f.products',
  audience: 'onboarding.profile.f.audience', tone: 'onboarding.profile.f.tone', avoid: 'onboarding.profile.f.avoid',
}
const filled = (p: CompanyProfileInput, f: ProfileField) => (f === 'tone' ? p.tone.length > 0 : (p[f] ?? '').trim().length > 0)
/** chips from "friendly, expert" (commas, line breaks), at most PROFILE_LIMITS.toneCount, no repeats */
export function toneChips(text: string, have: string[] = []): string[] {
  const out = [...have]
  for (const raw of text.split(/[,，、\n]/)) {
    const s = raw.trim().slice(0, PROFILE_LIMITS.toneItem)
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase()) && out.length < PROFILE_LIMITS.toneCount) out.push(s)
  }
  return out
}
/** What is saved: trimmed text, and a source only for a field that still has a value. */
export function tidyProfile(p: CompanyProfileInput): CompanyProfileInput {
  const out: CompanyProfileInput = {
    website: p.website.trim() ? normalizeWebsite(p.website) ?? p.website.trim() : '',
    name: (p.name ?? '').trim(),
    oneLine: p.oneLine.trim(), products: p.products.trim(), audience: p.audience.trim(), tone: p.tone.map((t) => t.trim()).filter(Boolean),
    avoid: p.avoid.trim(), sources: [],
  }
  out.sources = p.sources.filter((s) => filled(out, s.field))
  return out
}

export default function ProfileStep({ onDone, onSkip, skipLabel, initial, initialWebsite }: ProfileStepProps) {
  const t = useT()
  const locale = useLocale()
  const [phase, setPhase] = useState<Phase>(initial ? { kind: 'review' } : { kind: 'site' })
  const [site, setSite] = useState(() => initial?.website || initialWebsite || setupSite() || '')
  const [siteError, setSiteError] = useState<string | null>(null)
  // the company name starts as the team's name (Admin › Team settings) when the profile has none: one less thing to type
  const teamName = useMe()?.team.name ?? ''
  const named = (d: CompanyProfileInput): CompanyProfileInput => ({ ...d, name: profileName(d, teamName) })
  const [draft, setDraft] = useState<CompanyProfileInput>(() => named(initial ? { ...initial } : blank()))
  const [text, setText] = useState('')
  const [answers, setAnswers] = useState({ what: '', who: '', tone: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  // no usable AI: no draft can be made (the questions need none)
  const ai = useAiAccess()
  const noAi = ai.loaded && !ai.usable
  useEffect(() => { void ai.load() }, [ai.load])
  // a new phase (not the first one): its heading takes the focus, so keyboard and screen-reader users hear where they are
  const firstPhase = useRef(true)
  useEffect(() => {
    if (firstPhase.current) { firstPhase.current = false; return }
    heading.current?.focus()
  }, [phase.kind])

  const start = async (body: { website: string } | { text: string }) => {
    setBusy(true)
    setError(null)
    try {
      // asked again right before: a draft without AI would only fail after a while
      await useAiAccess.getState().load(true)
      if (!useAiAccess.getState().usable) { setPhase({ kind: 'fallback', unreadable: false, error: null }); return }
      const r = await api.call(API.startProfileDraft, { body })
      if (r.website) setDraft((d) => ({ ...d, website: r.website }))
      setPhase({ kind: 'reading', chatId: r.chatId, source: 'website' in body ? 'website' : 'text' })
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(false)
    }
  }

  // while reading: ask the server every few seconds how the draft chat is doing
  useEffect(() => {
    if (phase.kind !== 'reading') return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const s = await api.call(API.getProfileDraft, { params: { chatId: phase.chatId } })
        if (stopped) return
        if (s.status === 'running') { timer = setTimeout(tick, POLL_MS); return }
        if (s.status === 'done' && s.draft) {
          const d = s.draft
          setDraft((prev) => named({ ...d, website: d.website || prev.website }))
          setPhase({ kind: 'review' })
          return
        }
        setPhase({ kind: 'fallback', unreadable: true, error: s.status === 'failed' ? s.error : null })
        // the answer may have failed for want of AI (the trial credit ran out): the fallback then offers the button
        if (s.status === 'failed') void useAiAccess.getState().load(true)
      } catch {
        if (!stopped) timer = setTimeout(tick, POLL_MS * 2)
      }
    }
    timer = setTimeout(tick, POLL_MS)
    return () => { stopped = true; clearTimeout(timer) }
  }, [phase])

  const readSite = () => {
    const w = normalizeWebsite(site)
    if (!w) return setSiteError(t('onboarding.profile.siteInvalid'))
    setSiteError(null)
    void start({ website: w })
  }

  const save = async () => {
    const body = tidyProfile(draft)
    if (body.website && !normalizeWebsite(body.website)) return setError(t('onboarding.profile.siteInvalid'))
    setBusy(true)
    setError(null)
    try {
      const saved = await api.call(API.saveCompanyProfile, { body })
      toast({ level: 'success', text: t('onboarding.profile.saved') })
      onDone(saved)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(false)
    }
  }

  const skip = onSkip && (
    <Button variant="ghost" onClick={onSkip} disabled={busy}>
      {skipLabel ?? t('onboarding.profile.later')}
    </Button>
  )
  const head = (title: string, desc?: ReactNode) => (
    <div className="space-y-1">
      <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold text-ink outline-none">
        {title}
      </h2>
      {desc && <p className="text-sm text-muted">{desc}</p>}
    </div>
  )
  const note = error && <ErrorNote>{error}</ErrorNote>
  const toQuestions = () => setPhase({ kind: 'questions' })
  const noAiNote = noAi && (
    <div data-testid="profile-step-no-ai">
      <AiAccessBanner />
      <p className="text-sm text-muted">
        {t('onboarding.profile.noAi')}{' '}
        <button type="button" className="font-medium text-accent-text hover:underline" onClick={toQuestions} data-testid="profile-step-no-ai-questions">
          {t('onboarding.profile.answer')}
        </button>
      </p>
    </div>
  )

  if (phase.kind === 'site')
    return (
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); readSite() }} data-testid="profile-step-site">
        {head(t('onboarding.profile.siteTitle'), t('onboarding.profile.siteDesc'))}
        <Field label={t('onboarding.profile.siteLabel')} error={siteError}>
          <input className={inputCls} value={site} onChange={(e) => setSite(e.target.value)} placeholder="acme.co.kr" inputMode="url" autoComplete="url" autoCapitalize="none" spellCheck={false} maxLength={PROFILE_LIMITS.website} />
        </Field>
        {note}
        {noAiNote}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" busy={busy} disabled={!site.trim() || noAi}>
            {t('onboarding.profile.read')}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setPhase({ kind: 'fallback', unreadable: false, error: null })} disabled={busy}>
            {t('onboarding.profile.noSite')}
          </Button>
          <span className="ml-auto">{skip}</span>
        </div>
      </form>
    )

  if (phase.kind === 'reading')
    return (
      <div className="space-y-4" data-testid="profile-step-reading">
        {head(t('onboarding.profile.title'))}
        <div className="rounded-xl border border-line bg-subtle px-4 py-5">
          <Spinner label={t(phase.source === 'website' ? 'onboarding.profile.reading' : 'onboarding.profile.readingText')} />
          <p className="mt-2 text-xs text-faint">{t('onboarding.profile.readingHint')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/c/${phase.chatId}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-sm font-medium text-accent-text hover:bg-hover max-sm:min-h-10">
            {t('onboarding.profile.openChat')}
          </Link>
          <Button variant="ghost" onClick={() => setPhase({ kind: 'fallback', unreadable: false, error: null })}>
            {t('onboarding.profile.stopWaiting')}
          </Button>
          <span className="ml-auto">{skip}</span>
        </div>
      </div>
    )

  if (phase.kind === 'fallback')
    return (
      <div className="space-y-4" data-testid="profile-step-fallback">
        {head(t('onboarding.profile.fallbackTitle'), t(noAi ? 'onboarding.profile.noAi' : 'onboarding.profile.fallbackDesc'))}
        {phase.unreadable && (
          <p role="status" className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
            {t('onboarding.profile.unreadable')}
            {phase.error ? ` ${phase.error}` : ''}
          </p>
        )}
        {noAi && <div data-testid="profile-step-no-ai"><AiAccessBanner /></div>}
        <div className={noAi ? 'grid gap-2' : 'grid gap-2 sm:grid-cols-2'}>
          {/* pasted text is read by the AI too: without one only the questions are left */}
          {!noAi && <Button onClick={() => setPhase({ kind: 'paste' })}>{t('onboarding.profile.paste')}</Button>}
          <Button variant={noAi ? 'primary' : 'secondary'} onClick={toQuestions}>{t('onboarding.profile.answer')}</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={() => setPhase({ kind: 'site' })}>
            {t('onboarding.profile.tryAgain')}
          </Button>
          <span className="ml-auto">{skip}</span>
        </div>
      </div>
    )

  if (phase.kind === 'paste')
    return (
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void start({ text: text.trim() }) }} data-testid="profile-step-paste">
        {head(t('onboarding.profile.paste'))}
        <Field label={t('onboarding.profile.pasteLabel')} hint={t('onboarding.profile.pasteHint')}>
          <textarea className={`${inputCls} h-auto min-h-40 resize-y py-2`} value={text} onChange={(e) => setText(e.target.value)} maxLength={PROFILE_TEXT_MAX} />
        </Field>
        {note}
        {noAiNote}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" busy={busy} disabled={!text.trim() || noAi}>
            {t('onboarding.profile.makeDraft')}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setPhase({ kind: 'fallback', unreadable: false, error: null })} disabled={busy}>
            {t('onboarding.profile.back')}
          </Button>
          <span className="ml-auto">{skip}</span>
        </div>
      </form>
    )

  if (phase.kind === 'questions') {
    const any = !!(answers.what.trim() || answers.who.trim() || answers.tone.trim())
    const next = () => {
      setDraft((d) => ({ ...d, website: d.website || normalizeWebsite(site) || '', products: answers.what.trim().slice(0, PROFILE_LIMITS.products), audience: answers.who.trim().slice(0, PROFILE_LIMITS.audience), tone: toneChips(answers.tone), sources: [] }))
      setPhase({ kind: 'review' })
    }
    return (
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (any) next() }} data-testid="profile-step-questions">
        {head(t('onboarding.profile.answer'))}
        <Field label={t('onboarding.profile.qWhat')}>
          <textarea className={`${inputCls} h-auto min-h-16 resize-y py-2`} value={answers.what} onChange={(e) => setAnswers({ ...answers, what: e.target.value })} maxLength={PROFILE_LIMITS.products} />
        </Field>
        <Field label={t('onboarding.profile.qWho')}>
          <textarea className={`${inputCls} h-auto min-h-16 resize-y py-2`} value={answers.who} onChange={(e) => setAnswers({ ...answers, who: e.target.value })} maxLength={PROFILE_LIMITS.audience} />
        </Field>
        <Field label={t('onboarding.profile.qTone')} hint={t('onboarding.profile.qToneHint')}>
          <input className={inputCls} value={answers.tone} onChange={(e) => setAnswers({ ...answers, tone: e.target.value })} maxLength={120} />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={!any}>
            {t('onboarding.profile.next')}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setPhase({ kind: 'fallback', unreadable: false, error: null })}>
            {t('onboarding.profile.back')}
          </Button>
          <span className="ml-auto">{skip}</span>
        </div>
      </form>
    )
  }

  // review: "이렇게 이해했어요"
  const sourceOf = (f: ProfileField) => draft.sources.find((s) => s.field === f) ?? null
  const set = (f: Exclude<ProfileField, 'tone'>, v: string) => setDraft((d) => ({ ...d, [f]: v }))
  const clear = (f: ProfileField) => setDraft((d) => ({ ...d, [f]: f === 'tone' ? [] : '', sources: d.sources.filter((s) => s.field !== f) }))
  const nothing = PROFILE_FIELDS.every((f) => !filled(draft, f))
  const fromDraft = draft.sources.length > 0
  return (
    <div className="space-y-4" data-testid="profile-step-review">
      {head(t('onboarding.profile.reviewTitle'), t('onboarding.profile.reviewDesc'))}
      <ReviewField field="name" value={draft.name ?? ''} source={sourceOf('name')} onClear={() => clear('name')}>
        {(id) => <input id={id} className={inputCls} value={draft.name ?? ''} onChange={(e) => set('name', e.target.value)} maxLength={PROFILE_LIMITS.name} data-testid="profile-name" />}
      </ReviewField>
      <Field label={t('onboarding.profile.f.website')}>
        <input className={inputCls} value={draft.website} onChange={(e) => setDraft({ ...draft, website: e.target.value })} placeholder="acme.co.kr" inputMode="url" autoCapitalize="none" spellCheck={false} maxLength={PROFILE_LIMITS.website} />
      </Field>
      <ReviewField field="oneLine" value={draft.oneLine} source={sourceOf('oneLine')} hint={fromDraft && !draft.oneLine ? t('onboarding.profile.notFound') : undefined} onClear={() => clear('oneLine')}>
        {(id) => <input id={id} className={inputCls} value={draft.oneLine} onChange={(e) => set('oneLine', e.target.value)} maxLength={PROFILE_LIMITS.oneLine} />}
      </ReviewField>
      <ReviewField field="products" value={draft.products} source={sourceOf('products')} hint={fromDraft && !draft.products ? t('onboarding.profile.notFound') : undefined} onClear={() => clear('products')}>
        {(id) => <textarea id={id} className={`${inputCls} h-auto min-h-16 resize-y py-2`} value={draft.products} onChange={(e) => set('products', e.target.value)} maxLength={PROFILE_LIMITS.products} />}
      </ReviewField>
      <ReviewField field="audience" value={draft.audience} source={sourceOf('audience')} hint={fromDraft && !draft.audience ? t('onboarding.profile.notFound') : undefined} onClear={() => clear('audience')}>
        {(id) => <textarea id={id} className={`${inputCls} h-auto min-h-16 resize-y py-2`} value={draft.audience} onChange={(e) => set('audience', e.target.value)} maxLength={PROFILE_LIMITS.audience} />}
      </ReviewField>
      <ToneField tone={draft.tone} source={sourceOf('tone')} onChange={(tone) => setDraft((d) => ({ ...d, tone, sources: tone.length ? d.sources : d.sources.filter((s) => s.field !== 'tone') }))} />
      <ReviewField field="avoid" value={draft.avoid} source={sourceOf('avoid')} hint={t('onboarding.profile.avoidHint')} onClear={() => clear('avoid')}>
        {(id) => <textarea id={id} className={`${inputCls} h-auto min-h-16 resize-y py-2`} value={draft.avoid} onChange={(e) => set('avoid', e.target.value)} maxLength={PROFILE_LIMITS.avoid} />}
      </ReviewField>
      {note}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" busy={busy} disabled={nothing} onClick={() => void save()}>
          {t('onboarding.profile.save')}
        </Button>
        <Button variant="ghost" onClick={() => { setSite(draft.website || site); setPhase({ kind: 'site' }) }} disabled={busy}>
          {t('onboarding.profile.readAgain')}
        </Button>
        <span className="ml-auto">{skip}</span>
      </div>
    </div>
  )
}

/** One field of the review: its label with a "remove" button, the control, and where the AI found it. */
function ReviewField({ field, value, source, hint, onClear, children }: { field: Exclude<ProfileField, 'tone'>; value: string; source: ProfileSource | null; hint?: string; onClear: () => void; children: (id: string) => ReactNode }) {
  const t = useT()
  const id = useId()
  const name = t(FIELD_LABEL[field])
  return (
    <div>
      <div className="mb-1.5 flex min-h-8 items-center justify-between gap-2">
        <label htmlFor={id} className="text-[13px] font-medium text-ink">
          {name}
        </label>
        {value.trim() && (
          <Button size="sm" variant="ghost" onClick={onClear} aria-label={t('onboarding.profile.remove', { name })}>
            <X size={14} aria-hidden /> {t('onboarding.profile.clear')}
          </Button>
        )}
      </div>
      {children(id)}
      {hint && <p className="mt-1 text-xs text-faint">{hint}</p>}
      <SourceLine source={source} />
    </div>
  )
}

/** Tone: up to four chips, each removed with its own button; a new one added from the field below. */
function ToneField({ tone, source, onChange }: { tone: string[]; source: ProfileSource | null; onChange: (tone: string[]) => void }) {
  const t = useT()
  const id = useId()
  const [next, setNext] = useState('')
  const full = tone.length >= PROFILE_LIMITS.toneCount
  const add = () => { if (next.trim()) { onChange(toneChips(next, tone)); setNext('') } }
  return (
    <div role="group" aria-labelledby={`${id}-label`}>
      <p id={`${id}-label`} className="mb-1.5 text-[13px] font-medium text-ink">
        {t('onboarding.profile.f.tone')}
      </p>
      {tone.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {tone.map((x) => (
            <li key={x} className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-subtle py-0.5 pr-0.5 pl-2.5 text-[13px] text-ink">
              {x}
              <IconButton label={t('onboarding.profile.remove', { name: x })} onClick={() => onChange(tone.filter((y) => y !== x))}>
                <X size={13} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      {!full && (
        <div className="flex gap-2">
          <input
            className={inputCls}
            value={next}
            aria-label={t('onboarding.profile.toneNew')}
            placeholder={t('onboarding.profile.toneNew')}
            maxLength={PROFILE_LIMITS.toneItem}
            onChange={(e) => setNext(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); add() } }}
          />
          <Button onClick={add} disabled={!next.trim()}>
            {t('onboarding.profile.toneAdd')}
          </Button>
        </div>
      )}
      <p className="mt-1 text-xs text-faint">{t('onboarding.profile.toneHint')}</p>
      <SourceLine source={source} />
    </div>
  )
}

/** "출처: acme.co.kr/about · “…”" (a link to the page), or the pasted text. Only http(s) addresses become links. */
function SourceLine({ source }: { source: ProfileSource | null }) {
  const t = useT()
  if (!source) return null
  const web = /^https?:\/\//i.test(source.url)
  let shown = source.url
  if (web) { try { const u = new URL(source.url); shown = (u.host + u.pathname).replace(/\/$/, '') } catch { /* as written */ } }
  return (
    <p className="mt-1 text-xs break-words text-faint">
      {t('onboarding.profile.source')}:{' '}
      {web ? (
        <a href={source.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-accent-text hover:underline">
          {shown}
          <ExternalLink size={11} aria-hidden />
        </a>
      ) : (
        t('onboarding.profile.sourcePasted')
      )}
      {source.excerpt && <> · “{source.excerpt}”</>}
    </p>
  )
}
