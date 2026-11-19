// A free-roam demo on screen (docs/decisions/20261119-demo-free-roam-web.md): one visitor's own server behind demo-gate,
// signed in as the demo's person, with the real AI until the demo limit (store/demo.ts reads it, lib/freeRoam.ts has the
// rules). Lean on purpose: one thin bar, one dialog at the limit, one line under the AI's message boxes.
//
// - FreeRoamBar: in place of the demo bar at the top (in the page's flow, so it never covers a message box): "You're
//   Mina at Steepling, a made-up company. Try anything." and 2-3 suggestions; a tap SENDS one as a new chat, as the
//   scripted demo's questions on Home do (DemoQuestions), since the bar is on every screen and a box to fill may not be.
//   From 80 % of the limit one quiet line "About 20% of your demo AI left"; at the limit the suggestions go.
// - DemoLimitDialog: "You've used this demo's AI", the app's own Modal (a bottom sheet on phones), Start free / Look around.
// - DemoLimitNotice: under an AI message box once the limit is used up (the box does not send): one line and Start free.
// - FreeRoamStart: the sign-in page's one action, "Continue as Mina": demo-gate signs the visitor back in
//   (POST /__demo/resume; its start page when that fails).
// - FreeRoamUnavailable: a page a visitor cannot use here (the admin pages, the dev environment): one line.
import clsx from 'clsx'
import { CirclePause } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { DemoInfo } from '@mycel/shared/api'
import { useT, type MessageKey } from '../../i18n'
import { demoMeter, freeRoamSuggestions, isFreeRoam, resumeFreeRoam } from '../../lib/freeRoam'
import { useChats } from '../../store/chats'
import { useDemo } from '../../store/demo'
import { useMe } from '../../store/session'
import { CalmNotice } from '../LoadError'
import { Button, LinkButton, Modal } from '../ui'

/** the demo's one person (the gate signs the visitor in as them) */
const personOf = (info: DemoInfo) => (info.current ? info.personas.find((p) => p.key === info.current) : undefined) ?? info.personas[0]

export function FreeRoamBar({ info }: { info: DemoInfo }) {
  const t = useT()
  const me = useMe()
  const navigate = useNavigate()
  const send = useChats((s) => s.send)
  const out = useDemo((s) => s.out)
  const [sending, setSending] = useState<string | null>(null)
  const meter = demoMeter(info.used, info.cap)
  const person = personOf(info)
  const chips = out || meter.out ? [] : freeRoamSuggestions(info, t)
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
  return (
    <div role="note" className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-accent-soft px-3 py-1 text-xs text-accent-text" data-testid="free-roam-bar">
      <span className="min-w-0 font-medium max-md:basis-full" data-testid="free-roam-who">
        {t('demo.free.bar', { name: person?.name ?? '', company: info.company })}
      </span>
      {chips.length > 0 && (
        // phones: one row that scrolls sideways (never a second and third row of chips); hidden while the keyboard is up,
        // so the message box keeps the room
        <ul aria-label={t('demo.free.tryLabel')} className="scroll-thin -mx-1 flex min-w-0 flex-1 gap-1.5 overflow-x-auto px-1 py-0.5 in-[.keyboard-open]:hidden max-md:order-2 md:flex-wrap md:overflow-visible" data-testid="free-roam-chips">
          {chips.map((c) => (
            <li key={c.label} className="shrink-0">
              <button
                type="button"
                disabled={!!sending}
                onClick={() => void ask(c.prompt)}
                className={clsx('rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-ink transition hover:bg-hover max-md:min-h-8', sending && sending !== c.prompt && 'opacity-50')}
                data-testid="free-roam-chip"
              >
                {c.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {meter.low && !meter.out && !out && (
        // phones: its own short line under who you are (beside the suggestions it squeezed them), before the suggestions
        <span role="status" className="shrink-0 text-muted max-md:order-1 max-md:basis-full md:ml-auto" data-testid="free-roam-meter">
          {t('demo.free.meter', { pct: meter.leftPct })}
        </span>
      )}
    </div>
  )
}

/** "Start free" (the demo file's sign-up address, a new tab); none when the demo names none */
function StartFree({ info, size }: { info: DemoInfo; size?: 'sm' | 'md' }) {
  const t = useT()
  if (!info.signupUrl) return null
  return (
    <LinkButton variant="primary" size={size} href={info.signupUrl} data-testid="free-roam-start-free">
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
          <Button onClick={close} data-testid="free-roam-look-around">{t('demo.free.limit.look')}</Button>
          <StartFree info={info} />
        </>
      )}
    >
      <p className="text-sm text-ink" data-testid="free-roam-limit">{t('demo.free.limit.body')}</p>
    </Modal>
  )
}

/** Under an AI message box (the chat's, Home's, a room's ✦ side chat) once the demo's AI is used up: the box does not
 * send; one calm line and Start free. People-to-people messages in rooms go on as before. */
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

/** A page a free-roam visitor cannot use (the admin pages; the dev environment says so in its own words). */
export function FreeRoamUnavailable({ what = 'demo.free.fenced' }: { what?: Extract<MessageKey, 'demo.free.fenced' | 'demo.free.devEnv'> }) {
  const t = useT()
  return (
    <div className="flex h-full items-center justify-center p-6">
      <p className="text-center text-sm text-muted" data-testid="free-roam-unavailable">{t(what)}</p>
    </div>
  )
}
