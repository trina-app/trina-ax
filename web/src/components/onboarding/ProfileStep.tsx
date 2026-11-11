// The company profile step (docs/DECISIONS.md "D — Company profile from the company website"). Standalone: the
// wave-2 welcome wizard and Admin > Team settings (CompanyProfileCard.tsx) both use it.
//   website → "읽는 중" (the AI reads it in a chat of this person: server/src/onboarding/draft.ts; each page the server
//   opens or skips shows as a line as it happens, DraftActivity, and so do the images it kept for the brand folder) →
//   "이렇게 이해했어요": every field editable, its source page and excerpt under it, a wrong one removed with one click,
//   the brand colours the server found as swatches (remove only; docs/DECISIONS.md "N") → Save
//   (PUT /api/onboarding/profile). The AI never saves anything itself: the person saves, or, in the welcome steps
//   (`autoSave`), the page saves a website reading as it came on the person's behalf, unchecked (chat/prompt.ts says
//   so to the AI).
// When the site can't be read (or there is none): paste a text (the same draft, from the text; the one primary) or
// answer three questions (무엇을 파나요 / 누구에게 / 어떤 말투로), which go straight to the same review. While it reads,
// the step offers nothing but "later" (docs/DECISIONS.md "W2"): a reading that fails opens that fallback by itself,
// naming what could not be read (the website or the pasted text) with "다시 시도", which reads the same input again.
// `autoSave` (the welcome steps): a website reading whose draft has a one-line intro is saved as it came, with the
// same body as the review's save, and the step is done; the welcome page then shows one line of it with "고치기", which
// opens this review. Only while the team has no saved profile (asked again right before saving): a re-read of a saved
// profile (다시 읽기 from its review) never overwrites it unseen, it shows the review. Pasted text, a draft without a
// one-line intro and a save that fails keep the review too. There the review's one button is "저장하고 계속"
// (`continueWith`): it saves and goes on (the brand materials, docs/DECISIONS.md "W6"), with the line under it that says
// what goes where; Admin › Team settings keeps 저장.
// A draft is an AI answer: with no AI the person can use (GET /api/me/ai-access, stream A), the step says so with A's
// connect button instead of starting one, and the three questions (no AI needed) stay open.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, ExternalLink, Globe, Loader2, Minus, X } from 'lucide-react'
import { normalizeWebsite, PROFILE_DRAFT_PAGES_MAX, PROFILE_FIELDS, PROFILE_LIMITS, PROFILE_TEXT_MAX, profileName, type CompanyProfile, type CompanyProfileInput, type ProfileDraftPage, type ProfileDraftState, type ProfileField, type ProfileSource } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { setupSite } from '../../lib/setupLink'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { useAiAccess } from '../../store/aiAccess'
import { chatActivity } from '../../store/live'
import { useMe } from '../../store/session'
import { toast } from '../../store/ui'
import AiAccessBanner from '../chat/AiAccessBanner'
import { Button, ErrorNote, Field, IconButton, inputCls } from '../ui'

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
  /** save a website draft that has a one-line intro without the review (the welcome steps) */
  autoSave?: boolean
  /** the address typed, as its reading starts (the welcome steps keep it on the server, so it is there when the owner
   * leaves mid-reading and comes back) */
  onRead?: (website: string) => void
  /** The welcome steps: the review's save goes on too (one button, "저장하고 계속": docs/DECISIONS.md "W5", "W6"), with
   * `extra` above the buttons (the intro files link) and `note` right under the button (what the press puts into the
   * brand folder, given the website the review holds now). `onSaved` (the brand materials, then the next step) runs after the save while the button is busy;
   * what fails stays on the review with its reason, and the same button saves again and goes on. No toast: the next
   * step says it. Without it (Admin › Team settings, 고치기): the plain 저장. */
  continueWith?: { label: string; note?: (website: string) => ReactNode; extra?: ReactNode; disabled?: boolean; onSaved: (profile: CompanyProfile) => Promise<void> }
}

/** what a draft is read from: the website, or the text the person pasted */
type DraftInput = { website: string } | { text: string }

type Phase =
  | { kind: 'site' }
  | { kind: 'reading'; chatId: string; source: 'website' | 'text'; site: string | null; website: string; input: DraftInput }
  /** `failed`: a reading that did not give a draft (what it read, the answer's error); null: chosen ("홈페이지가 없어요",
   * 뒤로) or no AI */
  | { kind: 'fallback'; failed: { input: DraftInput; error: string | null } | null }
  | { kind: 'paste' }
  | { kind: 'questions' }
  /** `from`: 'answers' after the three typed answers (nothing was read: its title says to check what was typed) */
  | { kind: 'review'; from?: 'answers' }

const POLL_MS = 2500
/** after a step event of the draft chat (realtime): ask again this soon (the tool call reaches the server a moment after
 * the engine reports its step) */
const NUDGE_MS = 250
const blank = (website = ''): CompanyProfileInput => ({ website, name: '', oneLine: '', products: '', audience: '', tone: [], avoid: '', sources: [] })
const FIELD_LABEL: Record<ProfileField | 'website', MessageKey> = {
  website: 'onboarding.profile.f.website', name: 'onboarding.profile.f.name', oneLine: 'onboarding.profile.f.oneLine', products: 'onboarding.profile.f.products',
  audience: 'onboarding.profile.f.audience', tone: 'onboarding.profile.f.tone', avoid: 'onboarding.profile.f.avoid',
}
const filled = (p: CompanyProfileInput, f: ProfileField) => (f === 'tone' ? p.tone.length > 0 : (p[f] ?? '').trim().length > 0)
/** What the server collected while reading the website (images for the brand folder, brand colours). */
export type DraftAssets = NonNullable<ProfileDraftState['assets']>
/** Brand colours as the profile keeps them: "#rrggbb" in lower case, each once, at most PROFILE_LIMITS.colors; anything
 * else is left out (a colour is shown as a fill, so only this exact form gets there). */
export function brandColors(list: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const raw of list ?? []) {
    const c = raw.trim().toLowerCase()
    if (/^#[0-9a-f]{6}$/.test(c) && !out.includes(c) && out.length < PROFILE_LIMITS.colors) out.push(c)
  }
  return out
}
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
  // the brand colours only when some are left (profiles without them stay as they were)
  const colors = brandColors(p.colors)
  if (colors.length) out.colors = colors
  return out
}

export default function ProfileStep({ onDone, onSkip, skipLabel, initial, initialWebsite, autoSave, onRead, continueWith }: ProfileStepProps) {
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
  // the latest props for the reading loop (it starts once per reading)
  const latest = useRef({ onDone, autoSave, hadProfile: !!initial })
  latest.current = { onDone, autoSave, hadProfile: !!initial }
  // while reading: the pages the server opened or skipped so far, and whether the AI is writing the profile
  const [activity, setActivity] = useState<{ steps: ProfileDraftPage[]; writing: boolean; assets: DraftAssets | null }>({ steps: [], writing: false, assets: null })
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

  const start = async (body: DraftInput) => {
    setBusy(true)
    setError(null)
    try {
      // asked again right before: a draft without AI would only fail after a while
      await useAiAccess.getState().load(true)
      if (!useAiAccess.getState().usable) { setPhase({ kind: 'fallback', failed: null }); return }
      const r = await api.call(API.startProfileDraft, { body })
      if (r.website) setDraft((d) => ({ ...d, website: r.website }))
      setActivity({ steps: [], writing: false, assets: null })
      setPhase({ kind: 'reading', chatId: r.chatId, source: 'website' in body ? 'website' : 'text', site: r.site, website: r.website, input: body })
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(false)
    }
  }

  // while reading: ask the server how the draft chat is doing, right after each of its realtime step events and every
  // few seconds besides (a missed event, a reconnecting socket)
  useEffect(() => {
    if (phase.kind !== 'reading') return
    let stopped = false
    let inFlight = false
    let again = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => void tick(), ms) }
    const tick = async () => {
      if (inFlight) { again = true; return }
      inFlight = true
      try {
        const s = await api.call(API.getProfileDraft, { params: { chatId: phase.chatId } })
        if (stopped) return
        if (s.status === 'running') {
          setActivity({ steps: s.steps ?? [], writing: !!s.writing, assets: s.assets ?? null })
          schedule(again ? NUDGE_MS : POLL_MS)
          return
        }
        if (s.status === 'done' && s.draft) {
          const d = s.draft
          // the brand colours the server found on the pages it opened (a pasted text has none: the draft's own, if any)
          const colors = brandColors(s.assets?.colors.length ? s.assets.colors : d.colors)
          const read: CompanyProfileInput = { ...d, website: d.website || phase.website, colors }
          if (latest.current.autoSave && phase.source === 'website' && d.oneLine.trim()) {
            // no more reads of this draft (a late step event must not save it twice)
            stopped = true
            clearTimeout(timer)
            // only the team's first profile: one saved before (this step's own, another tab, an admin) is never
            // overwritten unseen; a read that fails counts as "there may be one"
            const first = !latest.current.hadProfile && (await api.call(API.getCompanyProfile).then((r) => !r.profile, () => false))
            if (first) { await saveAsRead(read); return }
          }
          setDraft((prev) => named({ ...read, website: read.website || prev.website }))
          setPhase({ kind: 'review' })
          return
        }
        setPhase({ kind: 'fallback', failed: { input: phase.input, error: s.status === 'failed' ? s.error : null } })
        // the answer may have failed for want of AI (the trial credit ran out): the fallback then offers the button
        if (s.status === 'failed') void useAiAccess.getState().load(true)
      } catch {
        if (!stopped) schedule(POLL_MS * 2)
      } finally {
        inFlight = false
        again = false
      }
    }
    const off = chatActivity.on((id) => { if (id !== phase.chatId || stopped) return; if (inFlight) again = true; else schedule(NUDGE_MS) })
    schedule(POLL_MS)
    return () => { stopped = true; clearTimeout(timer); off() }
  }, [phase])

  const readSite = () => {
    const w = normalizeWebsite(site)
    if (!w) return setSiteError(t('onboarding.profile.siteInvalid'))
    setSiteError(null)
    // kept by the caller as the reading starts: leaving mid-reading and coming back finds the address again
    onRead?.(w)
    void start({ website: w })
  }

  /** The welcome steps: the website draft saved as it came (only what the pages said: no name is filled in, an empty one
   * reads as the team's name everywhere), with the save's own body and checks; the step is then done. A save that fails
   * opens the review with the draft and the reason. */
  const saveAsRead = async (read: CompanyProfileInput) => {
    const body = tidyProfile(read)
    setBusy(true)
    try {
      if (body.website && !normalizeWebsite(body.website)) throw new Error(t('onboarding.profile.siteInvalid'))
      const saved = await api.call(API.saveCompanyProfile, { body })
      latest.current.onDone(saved)
    } catch (e) {
      setDraft(named(read))
      setError(errorText(e, locale, t('error.network')))
      setPhase({ kind: 'review' })
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    const body = tidyProfile(draft)
    if (body.website && !normalizeWebsite(body.website)) return setError(t('onboarding.profile.siteInvalid'))
    setBusy(true)
    setError(null)
    try {
      const saved = await api.call(API.saveCompanyProfile, { body })
      // the welcome steps: saved and on in one press (the brand materials); the next step says it, no toast
      if (continueWith) await continueWith.onSaved(saved)
      else {
        toast({ level: 'success', text: t('onboarding.profile.saved') })
        onDone(saved)
      }
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
          <input className={inputCls} value={site} onChange={(e) => setSite(e.target.value)} placeholder={t('onboarding.profile.sitePlaceholder')} inputMode="url" autoComplete="url" autoCapitalize="none" spellCheck={false} maxLength={PROFILE_LIMITS.website} />
        </Field>
        {note}
        {noAiNote}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" busy={busy} disabled={!site.trim() || noAi}>
            {t('onboarding.profile.read')}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setPhase({ kind: 'fallback', failed: null })} disabled={busy}>
            {t('onboarding.profile.noSite')}
          </Button>
          <span className="ml-auto">{skip}</span>
        </div>
      </form>
    )

  if (phase.kind === 'reading')
    return (
      <div className="space-y-4" data-testid="profile-step-reading">
        <div className="flex items-baseline justify-between gap-3">
          {head(t('onboarding.profile.title'))}
          {phase.source === 'website' && (
            <span className="shrink-0 text-xs text-faint tabular-nums" data-testid="profile-activity-count">
              {t('onboarding.profile.activity.count', { n: pagesUsed(activity.steps), max: PROFILE_DRAFT_PAGES_MAX })}
            </span>
          )}
        </div>
        <div>
          <DraftActivity source={phase.source} site={phase.site} steps={activity.steps} writing={activity.writing} assets={activity.assets} />
          <p className="mt-3 text-xs text-faint">{t('onboarding.profile.readingHint')}</p>
        </div>
        {/* only "나중에 하기" while it reads (docs/DECISIONS.md "W2"): the chat and the written path are not offered here;
            a reading that fails opens the fallback (paste a text, three questions) by itself */}
        {skip && <div className="flex justify-end">{skip}</div>}
      </div>
    )

  if (phase.kind === 'fallback') {
    const failed = phase.failed
    return (
      <div className="space-y-4" data-testid="profile-step-fallback">
        {head(t('onboarding.profile.fallbackTitle'), t(noAi ? 'onboarding.profile.noAi' : 'onboarding.profile.fallbackDesc'))}
        {/* what could not be read, in its own words (the website or the pasted text), and "다시 시도" with the same
            input (a draft needs AI: without one, the connect banner instead) */}
        {failed && (
          <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="profile-step-unreadable">
            <span className="min-w-0 flex-[1_1_12rem]">
              {t('text' in failed.input ? 'onboarding.profile.unreadableText' : 'onboarding.profile.unreadable')}
              {failed.error ? ` ${failed.error}` : ''}
            </span>
            {!noAi && (
              <Button size="sm" variant="secondary" className="ml-auto" busy={busy} onClick={() => void start(failed.input)} data-testid="profile-step-retry">
                {t('common.retry')}
              </Button>
            )}
          </div>
        )}
        {note}
        {noAi && <div data-testid="profile-step-no-ai"><AiAccessBanner /></div>}
        {/* one primary: pasting what the company does (pasted text is read by the AI too: without one, the questions) */}
        <div className="flex flex-wrap items-center gap-2">
          {!noAi && (
            <Button variant="primary" className="max-sm:w-full" disabled={busy} onClick={() => setPhase({ kind: 'paste' })} data-testid="profile-step-to-paste">
              {t('onboarding.profile.paste')}
            </Button>
          )}
          <Button variant={noAi ? 'primary' : 'ghost'} className="max-sm:w-full" disabled={busy} onClick={toQuestions} data-testid="profile-step-to-questions">
            {t('onboarding.profile.answer')}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* "주소 다시 넣기" only after a website could not be read; else (no homepage, a pasted text) the address is new */}
          <Button variant="ghost" onClick={() => setPhase({ kind: 'site' })} disabled={busy} data-testid="profile-step-to-site">
            {t(failed && 'website' in failed.input ? 'onboarding.profile.tryAgain' : 'onboarding.profile.enterSite')}
          </Button>
          <span className="ml-auto">{skip}</span>
        </div>
      </div>
    )
  }

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
          <Button type="button" variant="ghost" onClick={() => setPhase({ kind: 'fallback', failed: null })} disabled={busy}>
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
      setPhase({ kind: 'review', from: 'answers' })
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
          <Button type="button" variant="ghost" onClick={() => setPhase({ kind: 'fallback', failed: null })}>
            {t('onboarding.profile.back')}
          </Button>
          <span className="ml-auto">{skip}</span>
        </div>
      </form>
    )
  }

  // review: "이렇게 이해했어요" (what was read, or a saved profile); after typed answers "입력한 내용을 확인해 주세요" (QA TC-206)
  const sourceOf = (f: ProfileField) => draft.sources.find((s) => s.field === f) ?? null
  const set = (f: Exclude<ProfileField, 'tone'>, v: string) => setDraft((d) => ({ ...d, [f]: v }))
  const clear = (f: ProfileField) => setDraft((d) => ({ ...d, [f]: f === 'tone' ? [] : '', sources: d.sources.filter((s) => s.field !== f) }))
  const nothing = PROFILE_FIELDS.every((f) => !filled(draft, f))
  const fromDraft = draft.sources.length > 0
  return (
    <div className="space-y-4" data-testid="profile-step-review">
      {head(t(phase.from === 'answers' ? 'onboarding.profile.reviewTitleTyped' : 'onboarding.profile.reviewTitle'), t('onboarding.profile.reviewDesc'))}
      <ReviewField field="name" value={draft.name ?? ''} source={sourceOf('name')} onClear={() => clear('name')}>
        {(id) => <input id={id} className={inputCls} value={draft.name ?? ''} onChange={(e) => set('name', e.target.value)} maxLength={PROFILE_LIMITS.name} data-testid="profile-name" />}
      </ReviewField>
      <Field label={t('onboarding.profile.f.website')}>
        <input className={inputCls} value={draft.website} onChange={(e) => setDraft({ ...draft, website: e.target.value })} placeholder={t('onboarding.profile.sitePlaceholder')} inputMode="url" autoCapitalize="none" spellCheck={false} maxLength={PROFILE_LIMITS.website} />
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
      <ColorsField colors={brandColors(draft.colors)} onChange={(colors) => setDraft((d) => ({ ...d, colors }))} />
      <ReviewField field="avoid" value={draft.avoid} source={sourceOf('avoid')} hint={t('onboarding.profile.avoidHint')} onClear={() => clear('avoid')}>
        {(id) => <textarea id={id} className={`${inputCls} h-auto min-h-16 resize-y py-2`} value={draft.avoid} onChange={(e) => set('avoid', e.target.value)} maxLength={PROFILE_LIMITS.avoid} />}
      </ReviewField>
      {note}
      {continueWith?.extra}
      {/* the welcome steps: the note sits right under the one button (on a phone: the button, the note, then the rest) */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" className={continueWith ? 'max-sm:w-full' : undefined} busy={busy} disabled={nothing || !!continueWith?.disabled} onClick={() => void save()} data-testid="profile-step-save">
          {continueWith?.label ?? t('onboarding.profile.save')}
        </Button>
        {/* only with a homepage to read again: not after "홈페이지가 없어요" and a pasted text (the recheck of v5) */}
        {!!draft.website.trim() && (
          <Button variant="ghost" className="max-sm:order-2" onClick={() => { setSite(draft.website); setPhase({ kind: 'site' }) }} disabled={busy} data-testid="profile-step-read-again">
            {t('onboarding.profile.readAgain')}
          </Button>
        )}
        <span className="ml-auto max-sm:order-2">{skip}</span>
        {continueWith?.note && <div className="w-full max-sm:order-1">{continueWith.note(draft.website)}</div>}
      </div>
    </div>
  )
}

/** Pages that took one of the draft's places: everything but what the server refused before opening it. */
export const pagesUsed = (steps: readonly ProfileDraftPage[]) => Math.min(PROFILE_DRAFT_PAGES_MAX, steps.filter((s) => s.status !== 'refused').length)

/** "acme.co.kr/about": an address without its scheme, www. and trailing slash, readable (decoded), cut to `max`. */
export function shortUrl(raw: string, max = 48): string {
  let s = raw
  try {
    const u = new URL(raw)
    let path = u.pathname
    try { path = decodeURI(path) } catch { /* as written */ }
    s = (u.host.replace(/^www\./, '') + path + u.search).replace(/\/$/, '')
  } catch { /* as written */ }
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}
const clipTitle = (s: string, max = 40) => (s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s)

/**
 * What the AI is doing while it drafts the profile: plain lines, newest last, each with a small mark. First what will
 * happen ("공개된 페이지만, acme.co.kr 안에서 최대 4개 읽어요"), then one line per page as the server opened or skipped it
 * (the real addresses, from GET /api/onboarding/profile/draft/:chatId), then the images the server kept from those
 * pages for the brand folder ("로고와 이미지 3개 가져옴"), then "회사 소개 정리 중" while it writes. Pasted text has one
 * line.
 */
export function DraftActivity({ source, site, steps, writing, assets }: { source: 'website' | 'text'; site: string | null; steps: readonly ProfileDraftPage[]; writing: boolean; assets?: Pick<DraftAssets, 'images' | 'logo'> | null }) {
  const t = useT()
  const max = PROFILE_DRAFT_PAGES_MAX
  const spin = <Loader2 size={14} className="animate-spin text-faint" aria-hidden />
  const line = (key: string, mark: ReactNode, text: string, tone = 'text-muted', testId?: string) => (
    <li key={key} className={`flex items-start gap-2 ${tone}`} data-testid={testId}>
      <span className="mt-[3px] shrink-0">{mark}</span>
      <span className="min-w-0 break-words">{text}</span>
    </li>
  )
  const page = (s: ProfileDraftPage, i: number) => {
    if (s.status === 'running') return line(`p${i}`, spin, t('onboarding.profile.activity.reading', { page: shortUrl(s.url) }), 'text-ink', 'profile-activity-running')
    if (s.status === 'ok') {
      const where = shortUrl(s.finalUrl ?? s.url)
      return line(`p${i}`, <Check size={14} className="text-ok" aria-hidden />, s.title
        ? t('onboarding.profile.activity.readTitled', { title: clipTitle(s.title), page: where })
        : t('onboarding.profile.activity.read', { page: where }), 'text-muted', 'profile-activity-ok')
    }
    // a refused redirect shows both addresses: the page asked for and where it tried to go
    const where = s.reason === 'off_site' && s.finalUrl ? `${shortUrl(s.url, 36)} → ${shortUrl(s.finalUrl, 36)}` : shortUrl(s.url)
    const why = t(`onboarding.profile.activity.why.${s.reason ?? 'unreachable'}` as MessageKey, { max })
    return line(`p${i}`, <Minus size={14} className="text-faint" aria-hidden />, t('onboarding.profile.activity.skipped', { page: where, why }), 'text-faint', 'profile-activity-skipped')
  }
  const idle = steps.length === 0 && !writing
  return (
    <ul className="space-y-1.5 text-label" aria-label={t('onboarding.profile.activity.label')} aria-live="polite" data-testid="profile-activity">
      {source === 'website'
        ? line('intro', idle ? spin : <Globe size={14} className="text-faint" aria-hidden />, t('onboarding.profile.activity.intro', { site: site ?? '', max }), 'text-muted', 'profile-activity-intro')
        : line('text', spin, t('onboarding.profile.activity.text'), 'text-ink')}
      {source === 'website' && steps.map(page)}
      {source === 'website' && assets && assets.images > 0 && line('images', <Check size={14} className="text-ok" aria-hidden />, imagesLine(t, assets), 'text-muted', 'profile-activity-images')}
      {source === 'website' && writing && line('writing', spin, t('onboarding.profile.activity.writing'), 'text-ink', 'profile-activity-writing')}
    </ul>
  )
}

/** "이미지 4개 가져옴"; with the logo among them "로고와 이미지 3개 가져옴", or "로고 가져옴" when it is the only one. */
function imagesLine(t: ReturnType<typeof useT>, a: Pick<DraftAssets, 'images' | 'logo'>): string {
  if (!a.logo) return t('onboarding.profile.activity.images', { n: a.images })
  return a.images > 1 ? t('onboarding.profile.activity.logoImages', { n: a.images - 1 }) : t('onboarding.profile.activity.logo')
}

/** One field of the review: its label with a "remove" button, the control, and where the AI found it. */
function ReviewField({ field, value, source, hint, onClear, children }: { field: Exclude<ProfileField, 'tone'>; value: string; source: ProfileSource | null; hint?: string; onClear: () => void; children: (id: string) => ReactNode }) {
  const t = useT()
  const id = useId()
  const name = t(FIELD_LABEL[field])
  return (
    <div>
      <div className="mb-1.5 flex min-h-8 items-center justify-between gap-2">
        <label htmlFor={id} className="text-label font-medium text-ink">
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
      <p id={`${id}-label`} className="mb-1.5 text-label font-medium text-ink">
        {t('onboarding.profile.f.tone')}
      </p>
      {tone.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {tone.map((x) => (
            <li key={x} className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-subtle py-0.5 pr-0.5 pl-2.5 text-label text-ink">
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

/** A brand colour as a small round swatch (24px), its hex as its name. Only "#rrggbb" (brandColors) gets here. */
export function ColorSwatch({ color }: { color: string }) {
  return <span role="img" aria-label={color} title={color} className="inline-block size-6 shrink-0 rounded-full border border-line" style={{ backgroundColor: color }} data-testid="profile-color-swatch" />
}

/** The brand colours the server found ("브랜드 색"): swatches, each removed with its own X like a tone chip; no picker and
 * no way to add one. Hidden when there are none. */
function ColorsField({ colors, onChange }: { colors: string[]; onChange: (colors: string[]) => void }) {
  const t = useT()
  const id = useId()
  if (!colors.length) return null
  return (
    <div role="group" aria-labelledby={`${id}-label`} data-testid="profile-colors">
      <p id={`${id}-label`} className="mb-1.5 text-label font-medium text-ink">
        {t('onboarding.profile.f.colors')}
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {colors.map((c) => (
          <li key={c} className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-subtle py-0.5 pr-0.5 pl-1" data-testid="profile-color" data-color={c}>
            <ColorSwatch color={c} />
            <IconButton label={t('onboarding.profile.remove', { name: c })} onClick={() => onChange(colors.filter((x) => x !== c))} data-testid="profile-color-remove">
              <X size={13} />
            </IconButton>
          </li>
        ))}
      </ul>
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
