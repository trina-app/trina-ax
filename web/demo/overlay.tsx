// The demo's own screen parts, over the real app (docs/AGENTS/plan/20261114-0507-mina-demo.md): one guide line in a
// corner ("다음: 팀장님 메시지 열기 →") that highlights the next control and takes the visitor back there, the suggested
// questions as buttons when the step has them, "처음부터", and the end card. No tooltip tour (DECISIONS rejected
// those). Styles are in demo.css (not Tailwind: the product's CSS must not change for the demo).
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { useT } from '../src/i18n'
import type { DemoAnswer, DemoGuideStep } from './script'
import type { DemoServer } from './server'
import './demo.css'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** a route change react-router hears (BrowserRouter follows popstate) */
export function navigate(to: string) {
  if (location.pathname + location.search === to) return
  history.pushState(null, '', to)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

async function waitFor<T extends Element>(selector: string, ms = 4000): Promise<T | null> {
  for (let left = ms; left > 0; left -= 100) {
    const el = [...document.querySelectorAll<T>(selector)].find((x) => (x as unknown as HTMLElement).offsetParent !== null)
    if (el) return el
    await sleep(100)
  }
  return null
}

export function mountOverlay(server: DemoServer, signupUrl: string) {
  const host = document.createElement('div')
  host.id = 'demo-overlay'
  document.body.append(host)
  createRoot(host).render(<Overlay server={server} signupUrl={signupUrl} />)
  watchOpened(server)
}

/** "opened" happenings: the visitor is on a room's page or in a project (its page or one of its chats) */
function watchOpened(server: DemoServer) {
  let last = ''
  setInterval(() => {
    const path = location.pathname
    if (path === last) return
    last = path
    const room = /^\/rooms\/([^/]+)/.exec(path)?.[1]
    const proj = /^\/projects\/([^/]+)/.exec(path)?.[1] ?? server.chats.find((c) => c.id === /^\/c\/([^/]+)/.exec(path)?.[1])?.projectId ?? undefined
    const r = room && server.storyId('room', room)
    const p = proj && server.storyId('project', proj)
    if (r) server.engine.fire({ opened: { room: r } })
    if (p) server.engine.fire({ opened: { project: p } })
  }, 300)
}

/** where a guide step's place is in the app */
function targetOf(server: DemoServer, go: DemoGuideStep['go']): string {
  if (go === 'home') return '/'
  if ('room' in go) return `/rooms/${server.idOf('room', go.room)}`
  if ('side' in go) return `/rooms/${server.idOf('room', go.side)}`
  // a project: its first earlier chat (e.g. Leo's banner), else its page
  const chat = server.script.projects.find((p) => p.id === go.project)?.chats?.[0]
  return chat ? `/c/${server.idOf('chat', chat.id)}` : `/projects/${server.idOf('project', go.project)}`
}

async function goTo(server: DemoServer, go: DemoGuideStep['go']) {
  navigate(targetOf(server, go))
  if (go !== 'home' && 'side' in go) {
    const button = await waitFor<HTMLButtonElement>('[data-testid="room-side-chat-button"]')
    if (button && button.getAttribute('aria-pressed') !== 'true') button.click()
  }
}

/** a suggested question, sent with the app's own box as if typed */
async function sendPrompt(server: DemoServer, step: DemoGuideStep, a: DemoAnswer) {
  await goTo(server, step.go)
  const side = step.go !== 'home' && 'side' in step.go
  const box = await waitFor<HTMLTextAreaElement>(side ? '[data-testid="side-chat-input"]' : '[data-testid="composer-input"]')
  if (!box) return
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, a.prompt)
  box.dispatchEvent(new Event('input', { bubbles: true }))
  const send = await waitFor<HTMLButtonElement>(side ? '[data-testid="side-chat-send"]:not([disabled])' : '[data-testid="send"]:not([disabled])', 2000)
  send?.click()
}

function useEngine(server: DemoServer) {
  const e = server.engine
  return useSyncExternalStore((fn) => e.subscribe(fn), () => `${e.guide()?.id ?? ''}|${e.endShown}|${e.endClosed}`)
}

function Overlay({ server, signupUrl }: { server: DemoServer; signupUrl: string }) {
  const t = useT()
  useEngine(server)
  const e = server.engine
  const step = e.guide()
  const end = e.endShown && !e.endClosed
  const suggest = (step?.suggest ?? []).flatMap((id) => server.script.answers.filter((a) => a.id === id))
  const [sending, setSending] = useState(false)

  // the control the line points to, outlined while it is on screen
  useEffect(() => {
    if (!step?.highlight || end) return
    let marked: Element | null = null
    const tick = () => {
      const el = document.querySelector(step.highlight!)
      if (el === marked) return
      marked?.classList.remove('demo-highlight')
      el?.classList.add('demo-highlight')
      marked = el
    }
    tick()
    const id = setInterval(tick, 400)
    return () => { clearInterval(id); marked?.classList.remove('demo-highlight') }
  }, [step?.highlight, end])

  const pick = async (a: DemoAnswer) => {
    if (!step || sending) return
    setSending(true)
    try { await sendPrompt(server, step, a) } finally { setSending(false) }
  }

  return (
    <>
      <div className="demo-guide" role="region" aria-label={t('demo.guideLabel')} data-testid="demo-guide">
        {step && !end && suggest.length > 0 && (
          <div className="demo-suggest" data-testid="demo-suggest">
            {suggest.map((a) => (
              <button key={a.id} type="button" className="demo-chip" disabled={sending} onClick={() => void pick(a)} data-testid={`demo-suggest-${a.id}`}>{a.label ?? a.prompt}</button>
            ))}
          </div>
        )}
        <div className="demo-bar">
          <span className="demo-badge">{t('demo.bar', { company: server.script.company.name })}</span>
          {step && !end && (
            <button type="button" className="demo-next" onClick={() => void goTo(server, step.go)} data-testid="demo-next">{step.text}</button>
          )}
          <button type="button" className="demo-restart" onClick={() => location.assign('/')} data-testid="demo-restart">{t('demo.restart')}</button>
        </div>
      </div>
      {end && (
        <div className="demo-end-backdrop" data-testid="demo-end">
          <section className="demo-end" role="dialog" aria-modal="true" aria-labelledby="demo-end-title">
            <h2 id="demo-end-title">{server.script.end.title}</h2>
            {server.script.end.body?.split('\n\n').map((p) => <p key={p}>{p}</p>)}
            <div className="demo-end-actions">
              <a className="demo-primary" href={signupUrl} data-testid="demo-signup">{server.script.end.signup.label}</a>
              <button type="button" className="demo-secondary" onClick={() => e.closeEnd()} data-testid="demo-explore">{server.script.end.explore.label}</button>
            </div>
          </section>
        </div>
      )}
    </>
  )
}
