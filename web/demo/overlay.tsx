// The demo's only layer over the real app (docs/AGENTS/plan/20261114-0507-mina-demo.md): the guide line in a corner
// (on phones a bar of its own) with "Start over", and a ring over the one real control to use next. Everything else
// on screen is the app's own UI: answers, file chips, the share dialog, the AI's cards, rooms, typing, reactions.
// The guide line names the moment and does its step; it holds the step's prompts as buttons, and at the end it becomes
// the end line with the sign-up link. No tooltip tour (DECISIONS rejected those), no cards or toasts of our own.
// Styles are in demo.css (not Tailwind: the product's stylesheet must not change for the demo).
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { useLocale, useT } from '../src/i18n'
import type { DemoAnswer, DemoGo } from './script'
import type { DemoServer } from './server'
import { demoWord } from './words'
import './demo.css'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** a route change react-router hears (BrowserRouter follows popstate) */
export function navigate(to: string) {
  if (location.pathname + location.search === to) return
  history.pushState(null, '', to)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

const visible = (el: Element) => (el as HTMLElement).offsetParent !== null || getComputedStyle(el).position === 'fixed'
async function waitFor<T extends Element>(selector: string, ms = 4000): Promise<T | null> {
  for (let left = ms; left > 0; left -= 100) {
    const el = [...document.querySelectorAll<T>(selector)].find(visible)
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

/** where a place is in the app; a project: the visitor's latest chat there (their result), else its first earlier
 * chat (e.g. Leo's banner), else its page */
function targetOf(server: DemoServer, go: DemoGo): string {
  if (go === 'home') return '/'
  if ('room' in go) return `/rooms/${server.idOf('room', go.room)}`
  if ('side' in go) return `/rooms/${server.idOf('room', go.side)}`
  const pid = server.idOf('project', go.project)
  const mine = server.chats
    .filter((c) => c.projectId === pid && !c.deletedAt && server.messages.some((m) => m.chatId === c.id && m.role === 'user' && m.author?.id === server.script.visitor))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  if (mine) return `/c/${mine.id}`
  const chat = server.script.projects.find((p) => p.id === go.project)?.chats?.[0]
  return chat ? `/c/${server.idOf('chat', chat.id)}` : `/projects/${pid}`
}

/** is the visitor at that place now (a project: its page or any of its chats; a side chat: the room with it open) */
function atPlace(server: DemoServer, go: DemoGo, path: string): boolean {
  const chatId = /^\/c\/([^/]+)/.exec(path)?.[1]
  const chat = chatId ? server.chats.find((c) => c.id === chatId) : undefined
  if (go === 'home') return path === '/' || path === '/new' || (!!chat && !chat.projectId && !chat.sideRoomId)
  if ('room' in go) return path.startsWith(`/rooms/${server.idOf('room', go.room)}`)
  if ('side' in go) return path.startsWith(`/rooms/${server.idOf('room', go.side)}`) && !!document.querySelector('[data-testid="side-chat-panel"]')
  const pid = server.idOf('project', go.project)
  return path.startsWith(`/projects/${pid}`) || chat?.projectId === pid
}

async function goTo(server: DemoServer, go: DemoGo) {
  navigate(targetOf(server, go))
  if (go !== 'home' && 'side' in go) {
    const button = await waitFor<HTMLButtonElement>('[data-testid="room-side-chat-button"]')
    if (button && button.getAttribute('aria-pressed') !== 'true') button.click()
  }
}

/** the message box of a place: the side chat's in a room, else the chat's */
const boxOf = (go: DemoGo) => (go !== 'home' && 'side' in go ? '[data-testid="side-chat-input"]' : '[data-testid="composer-input"]')
const sendOf = (go: DemoGo) => (go !== 'home' && 'side' in go ? '[data-testid="side-chat-send"]:not([disabled])' : '[data-testid="send"]:not([disabled])')

/** a suggested prompt, sent with the app's own box as if typed */
async function sendPrompt(server: DemoServer, go: DemoGo, a: DemoAnswer) {
  if (!atPlace(server, go, location.pathname)) await goTo(server, go)
  const box = await waitFor<HTMLTextAreaElement>(boxOf(go))
  if (!box) return
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, a.prompt)
  box.dispatchEvent(new Event('input', { bubbles: true }))
  const send = await waitFor<HTMLButtonElement>(sendOf(go), 2000)
  send?.click()
}

function useEngine(server: DemoServer) {
  const e = server.engine
  return useSyncExternalStore((fn) => e.subscribe(fn), () => `${e.guide()?.id ?? ''}|${e.endShown}|${e.endClosed}`)
}

/** the path, kept fresh (react-router changes it without telling this root) */
function usePath() {
  const [path, setPath] = useState(location.pathname)
  useEffect(() => {
    const id = setInterval(() => setPath(location.pathname), 250)
    return () => clearInterval(id)
  }, [])
  return path
}

/** re-render every `ms` while on (things in the app's DOM come and go) */
function useTick(ms: number) {
  const [, set] = useState(0)
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms)
    return () => clearInterval(id)
  }, [ms])
}


/** The way to a place when the visitor is elsewhere: its link on screen (a room or project link, the ✦ of a side chat),
 * else the rail's tab for it */
function wayTo(server: DemoServer, go: DemoGo, path: string): Element | null {
  const first = (sel: string) => [...document.querySelectorAll(sel)].find(visible) ?? null
  if (go === 'home') return first('a[href="/"]')
  if ('project' in go) return first(`a[href^="/projects/${server.idOf('project', go.project)}"]`) ?? first('a[href="/projects"]')
  const room = server.idOf('room', 'room' in go ? go.room : go.side)
  if ('side' in go && path.startsWith(`/rooms/${room}`)) return first('[data-testid="room-side-chat-button"]')
  return first(`a[href^="/rooms/${room}"]`) ?? first('a[href^="/rooms"]')
}

/** The share dialog (the app's own "Send to room"): the story's room row until it is picked, then Send, then the
 * confirm's Send */
function shareTarget(server: DemoServer): Element | null {
  const confirm = [...document.querySelectorAll('[data-testid="share-room-confirm-send"]')].find(visible)
  if (confirm) return confirm
  const options = [...document.querySelectorAll<HTMLElement>('[data-testid="share-room-option"]')].filter(visible)
  if (!options.length) return null
  const step = server.engine.guide()
  const roomId = step && step.until && 'shared' in step.until ? step.until.shared : null
  const r = roomId ? server.script.rooms.find((x) => x.id === roomId) : undefined
  const name = r?.group ? server.script.groups.find((g) => g.id === r.group)?.name : r?.name
  const row = options.find((o) => !!name && o.textContent?.includes(name))
  if (row && row.getAttribute('aria-selected') !== 'true') return row
  return [...document.querySelectorAll('[data-testid="share-room-send"]')].find(visible) ?? row ?? null
}

function Overlay({ server, signupUrl }: { server: DemoServer; signupUrl: string }) {
  const t = useT()
  const locale = useLocale()
  useEngine(server)
  useTick(250)
  const path = usePath()
  const e = server.engine
  const step = e.guide()
  const end = e.endShown
  const here = !!step && atPlace(server, step.go, path)
  // in the room of a side-chat step with the side chat closed: the line already says the step (✦ is ringed)
  const inSideRoom = !!step && step.go !== 'home' && 'side' in step.go && path.startsWith(`/rooms/${server.idOf('room', step.go.side)}`)
  const [sending, setSending] = useState(false)
  // a step's prompts go once one was sent (they come back with the next step), and while the AI's card waits
  const [usedFor, setUsedFor] = useState<string | null>(null)
  const cardOpen = [...document.querySelectorAll('[data-testid="ask-card"]')].some(visible)
  // the AI is still answering on screen (its card not out yet): the guide waits with it
  const working = !cardOpen && [...document.querySelectorAll('[data-testid="assistant-message"][data-status="streaming"]')].some(visible)
  const suggest = here && usedFor !== step?.id && !cardOpen && !working ? (step?.suggest ?? []).flatMap((id) => server.script.answers.filter((a) => a.id === id)) : []

  // the one thing ringed: the AI's card when it waits, the share dialog's next control, the step's control, or the way
  // there; nothing while Trina works or while the step's prompts are in the guide line
  const target: Element | null = !step || end || working || suggest.length ? null
    : cardOpen && here ? [...document.querySelectorAll('[data-testid="ask-card"]')].reverse().find(visible) ?? null
    : shareTarget(server)
      ?? (here && step.highlight ? [...document.querySelectorAll(step.highlight)].reverse().find(visible) ?? null : null)
      ?? (!here ? (step.highlight ? [...document.querySelectorAll(step.highlight)].find(visible) ?? null : null) ?? wayTo(server, step.go, path) : null)
  const ring = target?.getBoundingClientRect()
  // a ringed control under the message box or above the top bar is brought into view, once
  const [shown, setShown] = useState<Element | null>(null)
  useEffect(() => {
    if (!target || target === shown) return
    setShown(target)
    const r = target.getBoundingClientRect()
    if (r.bottom > window.innerHeight - 160 || r.top < 64) target.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [target, shown])

  const pick = async (a: DemoAnswer) => {
    if (!step || sending) return
    setSending(true)
    setUsedFor(step.id)
    try { await sendPrompt(server, step.go, a) } finally { setSending(false) }
  }

  /** the guide line does its step: it presses the ringed control (the card: its first choice; a row: its button), sends
   * the step's first prompt, or goes there */
  const act = async () => {
    if (!step) return
    if (suggest.length) { void pick(suggest[0]!); return }
    // elsewhere: straight there (the ring shows the way for a visitor who clicks by hand), unless the step's own
    // control is on screen (a link in a message)
    if (!here && !(step.highlight && target?.matches(step.highlight))) { await goTo(server, step.go); return }
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' })
      if (target.matches('[data-testid="ask-card"]')) {
        const send = target.querySelector<HTMLButtonElement>('[data-testid="ask-send"]')
        if (send) {
          target.querySelector<HTMLElement>('label, [role="radio"], input[type="radio"]')?.click()
          await sleep(150)
          send.click()
        } else [...target.querySelectorAll<HTMLButtonElement>('button')].filter(visible).pop()?.click()
        return
      }
      const el = target as HTMLElement
      const button = el.matches('button, a, [role="button"], [role="option"]') ? el : el.querySelector<HTMLElement>('button, a, [role="button"]') ?? el
      button.click()
      return
    }
    await goTo(server, step.go)
  }

  const secs = Math.max(0, Math.round(((e.endedAt ?? Date.now()) - e.startedAt) / 1000))
  const elapsed = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
  return (
    <>
      <div className="demo-guide" role="region" aria-label={demoWord('guideLabel', locale)} data-testid="demo-guide">
        {suggest.length > 0 && (
          <div className="demo-choices" data-testid="demo-suggest">
            {suggest.map((a) => (
              <button key={a.id} type="button" className="demo-choice" disabled={sending} onClick={() => void pick(a)} data-testid={`demo-suggest-${a.id}`}>{a.label ?? a.prompt}</button>
            ))}
          </div>
        )}
        <div className="demo-bar">
          <span className="demo-badge">{t('demo.bar', { company: server.script.company.name })}</span>
          {end ? (
            <span className="demo-end-line" data-testid="demo-end">
              <span><strong>{server.script.end.title}</strong> · {elapsed}{server.script.end.contrast ? ` · ${server.script.end.contrast}` : ''}</span>
              <a className="demo-next" href={signupUrl} target="_blank" rel="noopener" data-testid="demo-signup">{server.script.end.signup.label} →</a>
            </span>
          ) : step && !working ? (
            <button type="button" className={target || suggest.length ? 'demo-next' : 'demo-next demo-glow'} onClick={() => void act()} data-testid="demo-next" data-away={here ? undefined : ''}>
              {here && cardOpen ? demoWord('card', locale) : here || inSideRoom ? step.text : step.away ?? step.text}
            </button>
          ) : (
            <span className="demo-next demo-wait" data-testid="demo-wait" role="status">{demoWord(working ? 'working' : 'waiting', locale)}</span>
          )}
          <button type="button" className="demo-restart" onClick={() => location.assign('/')} data-testid="demo-restart">{demoWord('restart', locale)}</button>
        </div>
      </div>
      {ring && ring.width > 0 && (
        <span className="demo-ring" data-testid="demo-ring" aria-hidden style={{ left: ring.left - 5, top: ring.top - 5, width: ring.width + 10, height: ring.height + 10 }} />
      )}
    </>
  )
}
