// A free-roam demo on screen (docs/decisions/20261119-demo-free-roam-web.md): one visitor's own server behind demo-gate,
// signed in as the demo's person, with the real AI until the demo limit (store/demo.ts reads it, lib/freeRoam.ts has the
// rules). Lean on purpose: one thin bar, the suggestions under Home's box, one dialog at the limit, one line under the
// AI's message boxes.
//
// - FreeRoamBar: in place of the demo bar at the top (in the page's flow, so it never covers a message box): "You're
//   Mina at Steepling, a made-up company." with "About 8 questions left" (lib/freeRoam.ts demoQuestionsLeft, in
//   questions right to the end: "Almost out of questions" at 0), a small "Gmail, Drive, Higgsfield: practice only" button
//   whose tap or click opens the whole sentence (a tooltip never shows on a touch screen: QA 2026-11-22 F3), and one
//   quiet "Start free" link at the end. One line on a computer; on a 390 px phone three short rows, 56 px at most (QA
//   2026-11-22 F9: it was 120 to 145 px tall with the chips).
// - FreeRoamChips: Home's 2-4 suggestions under the message box (pages/Home.tsx, free roam, not in a project); a tap
//   SENDS one as a new chat, as the scripted demo's questions do (DemoQuestions). Nowhere else (owner, 2026-11-22).
// - DemoLimitDialog: "You've used all your questions", the app's own Modal (a bottom sheet on phones), Start free / Look
//   around.
// - DemoLimitNotice: under an AI message box once the limit is used up (the box does not send): one line and Start free.
// - FreeRoamStart: the sign-in page's one action, "Continue as Mina": demo-gate signs the visitor back in
//   (POST /__demo/resume; its start page when that fails).
// - FreeRoamUnavailable: a page a visitor cannot use here (the admin pages, the dev environment): one line and Back to
//   Home.
import clsx from 'clsx'
import { CirclePause, ExternalLink, Loader2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { DemoInfo } from '@mycel/shared/api'
import { useT, type MessageKey } from '../../i18n'
import { demoQuestionsLeft, freeRoamSuggestions, isFreeRoam, resumeFreeRoam } from '../../lib/freeRoam'
import { useChats } from '../../store/chats'
import { useDemo } from '../../store/demo'
import { useMe } from '../../store/session'
import { CalmNotice } from '../LoadError'
import { Button, LinkButton, Modal } from '../ui'

/** the demo's one person (the gate signs the visitor in as them) */
const personOf = (info: DemoInfo) => (info.current ? info.personas.find((p) => p.key === info.current) : undefined) ?? info.personas[0]

export function FreeRoamBar({ info }: { info: DemoInfo }) {
  const t = useT()
  const out = useDemo((s) => s.out)
  const left = out ? null : demoQuestionsLeft(info.used, info.cap)
  const person = personOf(info)
  return (
    // `relative`: the practice sentence opens under the bar on a phone, across its width. A computer: one line (who you
    // are · the count · practice ……… Start free). A 390 px phone: three short rows, 56 px at most (who you are; the count
    // ……… Start free; practice), measured in all six languages (test/e2e/demo-free-roam.spec.ts): two rows cannot hold
    // the four in es and id, and ", a made-up company" is never cut
    <div role="note" className="relative flex flex-wrap items-center gap-x-3 bg-accent-soft px-3 py-1 text-xs leading-4 text-accent-text" data-testid="free-roam-bar">
      {/* never cut: ", a made-up company" is what keeps the demo from misleading anyone */}
      <span className="min-w-0 font-medium max-md:basis-full" data-testid="free-roam-who">
        {t('demo.free.bar', { name: person?.name ?? '', company: info.company })}
      </span>
      {left !== null && (
        // how much they can still ask, in questions (never tokens), right to the end: for visitors who skipped the gate's
        // landing too
        <span role="status" className="whitespace-nowrap text-muted" data-testid="free-roam-left">
          {left > 0 ? t('demo.free.left', { n: left }) : t('demo.free.almostOut')}
        </span>
      )}
      <PracticeLabel />
      {/* one quiet text link at the end (owner, QA 2026-11-22 F8): the end of the line on a computer, of the count's row
          on a phone; a new tab, so the visitor's copy stays open. Out: the limit dialog and the line under the box have
          their own */}
      {info.signupUrl && !out && (
        <a
          href={info.signupUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded font-medium whitespace-nowrap underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
          data-testid="free-roam-bar-start-free"
        >
          {t('demo.free.limit.start')}
          <ExternalLink size={12} aria-hidden />
        </a>
      )}
    </div>
  )
}

/** "Gmail, Drive, Higgsfield: practice only": a small text button; a tap or click opens the whole sentence under it
 * (demo.free.practiceTip), Esc or a tap outside closes it. Not the shared Tooltip, which never opens on a touch screen
 * (components/Tooltip.tsx), so a phone never read it (QA 2026-11-22 F3). */
function PracticeLabel() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
      button.current?.focus()
    }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', esc, true)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', esc, true)
    }
  }, [open])
  return (
    // a computer: the sentence opens under the label (this span is its anchor); a phone: under the bar, its full width
    <span ref={wrap} className="max-md:order-last max-md:basis-full md:relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="rounded text-left text-muted underline decoration-dotted underline-offset-2 outline-none hover:text-accent-text focus-visible:ring-2 focus-visible:ring-accent"
        data-testid="free-roam-practice"
      >
        {t('demo.free.practice')}
      </button>
      {open && (
        <span
          id={id}
          role="note"
          className="absolute top-full z-50 mt-1 block rounded-lg border border-line bg-surface p-3 text-xs leading-relaxed text-ink shadow-lg max-md:inset-x-3 md:left-0 md:w-80"
          data-testid="free-roam-practice-tip"
        >
          {t('demo.free.practiceTip')}
        </span>
      )}
    </span>
  )
}

/** Send a suggestion as a new chat, then open it; `sending`: the one on its way (the others dim, it spins). */
function useAskAsNewChat() {
  const me = useMe()
  const navigate = useNavigate()
  const send = useChats((s) => s.send)
  const [sending, setSending] = useState<string | null>(null)
  const ask = async (text: string) => {
    if (sending || !me) return
    setSending(text)
    try {
      const r = await send({ chatId: null, content: text, attachments: [], author: { id: me.user.id, name: me.user.name }, projectId: null })
      navigate(`/c/${r.chatId}`)
    } catch {
      // the chat's own error line says why (a refusal at the limit opens the limit dialog: store/demo.ts)
    } finally {
      setSending(null)
    }
  }
  return { sending, ask }
}

/** Home's suggestions for a free-roam visitor, by the message box (pages/Home.tsx): round buttons that wrap (at most
 * four, lib/freeRoam.ts SUGGESTIONS_MAX); none once the questions are used up. */
export function FreeRoamChips({ info }: { info: DemoInfo }) {
  const t = useT()
  const out = useDemo((s) => s.out)
  const { sending, ask } = useAskAsNewChat()
  const chips = out ? [] : freeRoamSuggestions(info, t)
  if (!chips.length) return null
  return (
    <ul aria-label={t('demo.free.tryLabel')} className="mt-4 flex flex-wrap justify-center gap-2 max-md:mt-0 max-md:mb-3 max-md:justify-start in-[.keyboard-open]:hidden" data-testid="free-roam-chips">
      {chips.map((c) => {
        const busy = sending === c.prompt
        return (
          <li key={c.label} className="min-w-0">
            <button
              type="button"
              disabled={!!sending}
              aria-busy={busy || undefined}
              onClick={() => void ask(c.prompt)}
              className={clsx('inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-left text-sm text-ink transition hover:bg-hover disabled:cursor-default max-md:min-h-9', sending && !busy && 'opacity-50')}
              data-testid="free-roam-chip"
            >
              {busy && <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden data-testid="free-roam-chip-busy" />}
              {c.label}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** "Start free" (the demo file's sign-up address, a new tab); none when the demo names none. `first`: the dialog starts
 * on it (the Modal's [data-autofocus]), so the sheet opens on its one action, not on ✕ with its tooltip */
function StartFree({ info, size, first }: { info: DemoInfo; size?: 'sm' | 'md'; first?: boolean }) {
  const t = useT()
  if (!info.signupUrl) return null
  return (
    <LinkButton variant="primary" size={size} href={info.signupUrl} data-autofocus={first || undefined} data-testid="free-roam-start-free">
      {t('demo.free.limit.start')}
    </LinkButton>
  )
}

/** At the demo limit, once per tab: what happened, that what they made stays, and the way on. */
export function DemoLimitDialog() {
  const t = useT()
  const info = useDemo((s) => s.info)
  const open = useDemo((s) => s.limitOpen)
  const close = useDemo((s) => s.closeLimit)
  if (!isFreeRoam(info)) return null
  return (
    <Modal
      open={open}
      onClose={close}
      title={t('demo.free.limit.title')}
      width={440}
      footer={(
        <>
          {/* no sign-up address: Look around is the one action, and the dialog starts on it */}
          <Button onClick={close} data-autofocus={info.signupUrl ? undefined : true} data-testid="free-roam-look-around">{t('demo.free.limit.look')}</Button>
          <StartFree info={info} first />
        </>
      )}
    >
      <p className="text-sm text-ink" data-testid="free-roam-limit">{t('demo.free.limit.body')}</p>
    </Modal>
  )
}

/** Under an AI message box (the chat's, Home's, a room's ✦ side chat) once the questions are used up: the box does not
 * send; one calm line ("You can still look around everything here": the teammates are made up and never answer, so no
 * promise about messages with people) and Start free. */
export function DemoLimitNotice({ className, testId = 'free-roam-out' }: { className?: string; testId?: string }) {
  const t = useT()
  const info = useDemo((s) => s.info)
  if (!isFreeRoam(info)) return null
  return (
    <CalmNotice className={className} testId={testId} icon={<CirclePause size={16} />} title={t('demo.free.out')} action={<StartFree info={info} size="sm" />} />
  )
}

/** The sign-in page of a free-roam demo: one action. demo-gate signs the visitor back in as the demo's person
 * (lib/freeRoam.ts resumeFreeRoam; no password, no other account: the sign-in form is refused on such a server). */
export function FreeRoamStart({ info, go }: { info: DemoInfo; go?: (to: string) => void }) {
  const t = useT()
  const person = personOf(info)
  const [busy, setBusy] = useState(false)
  const resume = () => {
    if (busy) return
    setBusy(true)
    void resumeFreeRoam({ go })
  }
  return (
    <div className="space-y-3" data-testid="free-roam-start">
      {person?.intro && <p className="text-sm text-muted">{person.intro}</p>}
      <Button variant="primary" className="w-full" busy={busy} onClick={resume} data-testid="free-roam-continue">
        {t('demo.free.continue', { name: person?.name ?? '' })}
      </Button>
    </div>
  )
}

/** A page a free-roam visitor cannot use (the admin pages; the dev environment says so in its own words): one line and
 * the way back to Home (QA 2026-11-22 F20: /admin was a dead end). */
export function FreeRoamUnavailable({ what = 'demo.free.fenced' }: { what?: Extract<MessageKey, 'demo.free.fenced' | 'demo.free.devEnv'> }) {
  const t = useT()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
      <p className="text-center text-sm text-muted" data-testid="free-roam-unavailable">{t(what)}</p>
      <Link to="/" className="inline-flex min-h-6 items-center rounded-md text-sm font-medium text-accent-text hover:underline max-md:min-h-11" data-testid="free-roam-back-home">
        {t('demo.free.backHome')}
      </Link>
    </div>
  )
}
