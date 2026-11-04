// Demo mode on screen (`bun run demo:trina`; docs/DECISIONS.md "Demo company: a new hire at 트리나"). Nothing here renders
// unless the server answers GET /api/demo, which only a development server started for the demo does.
//
// - DemoBar: one strip at the top, in place of the development-mode banner (its words move into the sheet): "데모 ·
//   가상 회사 트리나 · 신입 한지우" and ONE button, 사람 바꾸기, which opens a sheet with the three people and the same
//   question to ask each of them.
// - DemoIntro / DemoQuestions: Home for a demo person: their one line ("오늘 트리나 마케팅팀에 입사한 한지우예요") above
//   the message box and their suggested questions under it; a tap sends one. Nothing else (no cards).
// - DemoStart: the sign-in page's one action, "한지우 님으로 시작하기"; the usual form is one quiet link away.
import clsx from 'clsx'
import { Check } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { DemoInfo, DemoPersona } from '@mycel/shared/api'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { errorText } from '../../lib/api'
import { useChats } from '../../store/chats'
import { hasSwitched, switchPersona, useDemo } from '../../store/demo'
import { useMe, useMeStrict } from '../../store/session'
import { Button, Modal } from '../ui'

const ROLE: Record<DemoPersona['key'], MessageKey> = { newHire: 'demo.persona.newHire', lead: 'demo.persona.lead', ceo: 'demo.persona.ceo' }

/**
 * The demo info once it is loaded. Signed in, only a development server is asked (`me.server.dev`): a normal install
 * never gets the request. `ready`: it is known whether this is a demo (always, off a development server).
 */
export function useDemoInfo(): { ready: boolean; info: DemoInfo | null } {
  const me = useMe()
  // signed out (the sign-in page) every server is asked once; signed in only a development server
  const ask = !me || me.server.dev
  const info = useDemo((s) => s.info)
  const loaded = useDemo((s) => s.loaded)
  useEffect(() => {
    if (ask) void useDemo.getState().load()
  }, [ask])
  return { ready: !ask || loaded, info: ask ? info : null }
}

/** the demo person the viewer is signed in as, if any */
export function useDemoPersona(): { ready: boolean; demo: { info: DemoInfo; persona: DemoPersona } | null } {
  const { ready, info } = useDemoInfo()
  const persona = info?.current ? info.personas.find((p) => p.key === info.current) : undefined
  return { ready, demo: info && persona ? { info, persona } : null }
}

export function DemoBar() {
  const t = useT()
  const { info } = useDemoInfo()
  const [open, setOpen] = useState(false)
  if (!info) return null
  const me = info.current ? info.personas.find((p) => p.key === info.current) : undefined
  return (
    <>
      <div role="note" className="flex items-center justify-between gap-2 bg-accent-soft px-3 py-1 text-xs font-medium text-accent-text" data-testid="demo-bar">
        <span className="min-w-0 truncate">
          {t('demo.bar', { company: info.company })}
          {me?.name && <> · {t(ROLE[me.key])} {me.name}</>}
        </span>
        <button type="button" onClick={() => setOpen(true)} className="shrink-0 rounded-md px-2 py-1 underline underline-offset-2 hover:bg-hover max-sm:min-h-8" data-testid="demo-switch">
          {t('demo.switch')}
        </button>
      </div>
      {open && <PersonaSheet info={info} onClose={() => setOpen(false)} />}
    </>
  )
}

function PersonaSheet({ info, onClose }: { info: DemoInfo; onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pick = async (p: DemoPersona) => {
    if (busy || p.key === info.current) return
    setBusy(p.key)
    setError(null)
    try {
      await switchPersona(p.key)
    } catch (e) {
      setBusy(null)
      setError(errorText(e, locale, t('error.network')))
    }
  }
  return (
    <Modal open onClose={onClose} title={t('demo.sheet.title')}>
      {info.sameQuestion && <p className="mb-3 text-sm text-muted">{t('demo.sheet.same', { question: info.sameQuestion })}</p>}
      <ul className="space-y-2" data-testid="demo-personas">
        {info.personas.filter((p) => p.name).map((p) => {
          const current = p.key === info.current
          return (
            <li key={p.key}>
              <button
                type="button"
                disabled={!!busy}
                aria-current={current || undefined}
                onClick={() => void pick(p)}
                className={clsx('flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 text-left text-sm', current ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover', busy && busy !== p.key && 'opacity-50')}
                data-testid={`demo-persona-${p.key}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{t(ROLE[p.key])} · {p.name}</span>
                  {p.team && <span className="text-muted"> · {p.team}</span>}
                </span>
                {current && <Check size={14} className="shrink-0 text-accent-text" aria-label={t('demo.sheet.now')} />}
                {busy === p.key && <span className="shrink-0 text-xs text-faint">{t('demo.sheet.switching')}</span>}
              </button>
            </li>
          )
        })}
      </ul>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      <p className="mt-4 text-xs text-faint">{t('demo.sheet.note')} {t('dev.banner')}</p>
    </Modal>
  )
}

/** Home's heading for a demo person: who you are here, in one line. */
export function DemoIntro({ persona }: { persona: DemoPersona }) {
  return (
    <h1 className="mb-6 text-center text-[22px] font-semibold tracking-tight sm:text-[26px]" data-testid="demo-intro">
      {persona.intro}
    </h1>
  )
}

/** Under Home's message box for a demo person: their questions; a tap sends one. The team lead and the CEO also get
 * one line on the same question. */
export function DemoQuestions({ info, persona }: { info: DemoInfo; persona: DemoPersona }) {
  const t = useT()
  const me = useMeStrict()
  const navigate = useNavigate()
  const send = useChats((s) => s.send)
  const [sending, setSending] = useState<string | null>(null)
  // after a switch, the new hire's screen also offers the question the others were asked
  const same = info.sameQuestion && persona.key === 'newHire' && hasSwitched() && !persona.questions.includes(info.sameQuestion) ? [info.sameQuestion] : []
  const questions = [...persona.questions, ...same]
  const ask = async (text: string) => {
    if (sending) return
    setSending(text)
    try {
      const r = await send({ chatId: null, content: text, attachments: [], author: { id: me.user.id, name: me.user.name }, projectId: null })
      navigate(`/c/${r.chatId}`)
    } catch {
      setSending(null)
    }
  }
  return (
    <div className="mt-5 space-y-2" data-testid="demo-questions">
      {persona.key !== 'newHire' && info.sameQuestion && <p className="text-center text-sm text-muted">{t('demo.home.same')}</p>}
      {questions.map((q) => (
        <button
          key={q}
          type="button"
          disabled={!!sending}
          onClick={() => void ask(q)}
          className={clsx('block w-full rounded-xl border border-line px-3.5 py-3 text-left text-sm text-ink transition hover:bg-hover', sending && sending !== q && 'opacity-50')}
          data-testid="demo-question"
        >
          {q}
        </button>
      ))}
    </div>
  )
}

/** The sign-in page's one action on a demo server: start as the new hire. */
export function DemoStart({ info, onOtherAccount }: { info: DemoInfo; onOtherAccount: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const first = info.personas.find((p) => p.key === 'newHire' && p.name) ?? info.personas.find((p) => p.name)
  const start = async () => {
    if (!first) return
    setBusy(true)
    setError(null)
    try {
      await switchPersona(first.key, { first: true })
    } catch (e) {
      setBusy(false)
      setError(errorText(e, locale, t('error.network')))
    }
  }
  return (
    <div className="space-y-3" data-testid="demo-start">
      {first && (
        <>
          <p className="text-sm text-muted">{first.intro}</p>
          <Button variant="primary" className="w-full" busy={busy} onClick={() => void start()} data-testid="demo-start-button">
            {t('demo.start', { name: first.name ?? '' })}
          </Button>
        </>
      )}
      {!first && <p className="text-sm text-muted">{t('demo.notSeeded')}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <button type="button" onClick={onOtherAccount} className="block w-full text-center text-xs text-faint hover:text-muted">
        {t('demo.otherAccount')}
      </button>
    </div>
  )
}
