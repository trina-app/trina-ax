// The demo's own screen parts, over the real app (docs/AGENTS/plan/20261114-0507-mina-demo.md), all in the demo bundle:
// - the guide line in a corner ("Next: … →", or "Sara is waiting in your DMs →" while the visitor is elsewhere); it
//   takes the visitor there. Exactly one control glows at a time: the step's control (or its suggested prompts) when the
//   visitor is in the right place, else the guide line itself. No tooltip tour (DECISIONS rejected those);
// - the step's suggested prompts as big buttons right above the message box;
// - message toasts at the top right;
// - what an answer brings under it (sources, people, a before/after slider, deliverables, ONE send-to-room button);
// - small touches to real screens (Home's card: the inviter's photo, one big button; a project link as a card);
// - the end card with the day's numbers.
// Styles are in demo.css (not Tailwind: the product's stylesheet must not change for the demo).
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { useLocale, useT } from '../src/i18n'
import type { DemoAnswer, DemoGo, DemoGuideStep } from './script'
import type { DemoServer, Extras, Toast } from './server'
import { demoWord } from './words'
import './demo.css'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const fileUrl = (path: string) => `/api/files/download?path=${encodeURIComponent(path)}&disposition=inline`
const viewUrl = (path: string) => `/files/view?path=${encodeURIComponent(path)}`
const isPicture = (path: string) => /\.(png|jpe?g|webp|gif)$/i.test(path)
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)

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

function Face({ server, id, size = 28 }: { server: DemoServer; id: string; size?: number }) {
  const p = server.script.people.find((x) => x.id === id)
  const [broken, setBroken] = useState(false)
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) }
  if (p?.avatar && server.avatars.has(id) && !broken) return <img className="demo-face" style={style} src={`/api/people/${id}/avatar?v=1`} alt="" onError={() => setBroken(true)} />
  return <span className="demo-face demo-face-letter" style={style} aria-hidden>{(p?.name ?? '?').trim().charAt(0).toUpperCase()}</span>
}

function Overlay({ server, signupUrl }: { server: DemoServer; signupUrl: string }) {
  const t = useT()
  const locale = useLocale()
  useEngine(server)
  useTick(400)
  const path = usePath()
  const e = server.engine
  const step = e.guide()
  const end = e.endShown && !e.endClosed
  const here = !!step && atPlace(server, step.go, path)
  const [sending, setSending] = useState(false)
  // a step's prompts go once one was sent (they come back with the next step), and while the AI's card waits
  const [usedFor, setUsedFor] = useState<string | null>(null)
  const cardOpen = [...document.querySelectorAll('[data-testid="ask-card"]')].some(visible)
  // the AI is still answering on screen (its card not out yet): the guide waits with it
  const working = !cardOpen && [...document.querySelectorAll('[data-testid="assistant-message"][data-status="streaming"]')].some(visible)
  const suggest = here && usedFor !== step?.id && !cardOpen ? (step?.suggest ?? []).flatMap((id) => server.script.answers.filter((a) => a.id === id)) : []
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    server.onToast = (t) => {
      setToasts((list) => [...list.filter((x) => x.id !== t.id), t])
      // shorter on phones, where a toast sits over the header
      setTimeout(() => setToasts((list) => list.filter((x) => x.id !== t.id)), window.matchMedia('(max-width: 767px)').matches ? 7000 : 9000)
    }
    return () => { server.onToast = null }
  }, [server])

  // the one control that glows: the step's suggested prompts when they are up; else its control, there or anywhere it
  // is on screen (a toast that takes the visitor there); in the room of a side-chat step, the ✦ button; else the guide
  const inSideRoom = !!step && step.go !== 'home' && 'side' in step.go && path.startsWith(`/rooms/${server.idOf('room', step.go.side)}`)
  const control = !step || end || suggest.length || working ? null
    // the AI's card waits: the card is the thing to answer
    : here && cardOpen ? '[data-testid="ask-card"]'
    : here ? step.highlight ?? null
    : inSideRoom ? '[data-testid="room-side-chat-button"]'
    : step.highlight && [...document.querySelectorAll(step.highlight)].some(visible) ? step.highlight : null
  const glowSelector = control
  useEffect(() => {
    let marked: Element | null = null
    const tick = () => {
      const el = glowSelector ? [...document.querySelectorAll(glowSelector)].reverse().find(visible) ?? null : null
      // (the app may set the element's class again when it re-renders: the glow is put back)
      if (el === marked) { el?.classList.add('demo-glow'); return }
      marked?.classList.remove('demo-glow')
      el?.classList.add('demo-glow')
      marked = el
    }
    tick()
    const id = setInterval(tick, 300)
    return () => { clearInterval(id); marked?.classList.remove('demo-glow') }
  }, [glowSelector])

  useDecorations(server)
  // a ring drawn over the glowing control too: it stays whatever the app does to the element's own classes
  const ringEl = glowSelector ? [...document.querySelectorAll(glowSelector)].reverse().find(visible) : undefined
  const ring = ringEl?.getBoundingClientRect()

  const pick = async (a: DemoAnswer) => {
    if (!step || sending) return
    setSending(true)
    setUsedFor(step.id)
    try { await sendPrompt(server, step.go, a) } finally { setSending(false) }
  }

  /** the guide line does its step: there, it presses the glowing control (or sends the one prompt); else it goes there */
  const act = async () => {
    if (!step) return
    if (!here) {
      await goTo(server, step.go)
      return
    }
    const el = control ? [...document.querySelectorAll<HTMLElement>(control)].reverse().find(visible) : undefined
    if (el && control === '[data-testid="ask-card"]') {
      // the card: its first choice (the suggested one, or Send), as the visitor would pick it
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      const send = el.querySelector<HTMLButtonElement>('[data-testid="ask-send"]')
      if (send) {
        el.querySelector<HTMLElement>('label, [role="radio"], input[type="radio"]')?.click()
        await sleep(150)
        send.click()
      } else [...el.querySelectorAll<HTMLButtonElement>('button')].filter(visible).pop()?.click()
      return
    }
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      // a row that holds the control (Home's card row): its button
      const target = el.matches('button, a, [role="button"]') ? el : el.querySelector<HTMLElement>('button, a, [role="button"]') ?? el
      target.click()
      return
    }
    // the step's prompts: the line sends the first (the buttons stay for the other choice)
    if (suggest.length) { void pick(suggest[0]!); return }
  }

  return (
    <>
      <div className="demo-guide" role="region" aria-label={demoWord('guideLabel', locale)} data-testid="demo-guide">
        <div className="demo-bar">
          <span className="demo-badge">{t('demo.bar', { company: server.script.company.name })}</span>
          {step && !end && !working && (
            <button type="button" className={here || control || suggest.length ? 'demo-next' : 'demo-next demo-glow'} onClick={() => void act()} data-testid="demo-next" data-away={here || inSideRoom ? undefined : ''}>
              {here && cardOpen ? demoWord('card', locale) : here || inSideRoom ? step.text : step.away ?? step.text}
            </button>
          )}
          {(!step || working) && !end && <span className="demo-next demo-wait" data-testid="demo-wait" role="status">{demoWord(working ? 'working' : 'waiting', locale)}</span>}
          <button type="button" className="demo-restart" onClick={() => location.assign('/')} data-testid="demo-restart">{demoWord('restart', locale)}</button>
        </div>
      </div>
      {suggest.length > 0 && step && !end && <Suggestions go={step.go} answers={suggest} sending={sending} onPick={pick} />}
      <div className="demo-toasts" aria-live="polite">
        {toasts.filter((x) => !x.open || !atPlace(server, x.open, path)).map((x) => {
          const who = server.script.people.find((p) => p.id === x.from)
          return (
            <button key={x.id} type="button" className="demo-toast" data-testid="demo-toast"
              onClick={() => { setToasts((list) => list.filter((y) => y.id !== x.id)); if (x.open) void goTo(server, x.open) }}>
              <Face server={server} id={x.from} size={36} />
              <span className="demo-toast-words">
                <strong>{who?.name ?? x.from}{who?.org ? ` (${who.org})` : ''}</strong>
                <span>{x.text}</span>
              </span>
            </button>
          )
        })}
      </div>
      {ring && ring.width > 0 && (
        <span className="demo-ring" data-testid="demo-ring" aria-hidden
          style={{ left: ring.left - 5, top: ring.top - 5, width: ring.width + 10, height: ring.height + 10 }} />
      )}
      <AnswerExtras server={server} />
      {end && <EndCard server={server} signupUrl={signupUrl} />}
    </>
  )
}

/** the step's prompts as big buttons right above the message box of that place */
function Suggestions({ go, answers, sending, onPick }: { go: DemoGo; answers: DemoAnswer[]; sending: boolean; onPick: (a: DemoAnswer) => void }) {
  useTick(250)
  const box = [...document.querySelectorAll(boxOf(go))].find(visible)
  const frame = box?.closest('form') ?? box?.parentElement?.parentElement ?? null
  const r = frame?.getBoundingClientRect()
  const style = r ? { left: r.left + 6, width: r.width - 12, bottom: window.innerHeight - r.top + 10 } : undefined
  return (
    <div className={r ? 'demo-suggest' : 'demo-suggest demo-suggest-loose'} style={style} data-testid="demo-suggest">
      {answers.map((a) => (
        <button key={a.id} type="button" className="demo-chip demo-glow" disabled={sending} onClick={() => onPick(a)} data-testid={`demo-suggest-${a.id}`}>{a.label ?? a.prompt}</button>
      ))}
    </div>
  )
}

/** what an answer brings, under it: one host element appended inside each finished answer that has extras */
function AnswerExtras({ server }: { server: DemoServer }) {
  useTick(400)
  const hosts: { id: string; el: HTMLElement; x: Extras }[] = []
  for (const el of document.querySelectorAll<HTMLElement>('[data-testid="assistant-message"]')) {
    const id = el.dataset.messageId
    const found = id ? server.extras.get(id) : undefined
    if (!id || !found) continue
    // while the answer runs only its attachments show (a mail draft's, above its card); the rest once it is done
    const x: Extras = el.dataset.status === 'done' ? found : { chatId: found.chatId, answerId: found.answerId, attachments: found.attachments }
    if (el.dataset.status !== 'done' && !x.attachments?.length) continue
    let host = el.querySelector<HTMLElement>(':scope > .demo-extras')
    if (!host) {
      host = document.createElement('div')
      host.className = 'demo-extras'
      el.append(host)
    }
    hosts.push({ id, el: host, x })
  }
  return <>{hosts.map((h) => createPortal(<Extra server={server} messageId={h.id} x={h.x} />, h.el, h.id))}</>
}

function Extra({ server, messageId, x }: { server: DemoServer; messageId: string; x: Extras }) {
  const [sent, setSent] = useState<'no' | 'busy' | 'yes'>('no')
  const send = async () => {
    if (sent !== 'no') return
    setSent('busy')
    const room = await server.sendToRoom(messageId)
    setSent(room ? 'yes' : 'no')
    if (room) navigate(`/rooms/${room}`)
  }
  return (
    <div className="demo-extra" data-testid="demo-extras">
      {x.attachments && x.attachments.length > 0 && (
        <div className="demo-row">
          {x.attachments.map((p) => <FileChip key={p} path={p} />)}
        </div>
      )}
      {x.sources && x.sources.length > 0 && (
        <div className="demo-row" data-testid="demo-sources">
          {x.sources.map((p) => (
            <button key={p} type="button" className="demo-source" onClick={() => navigate(viewUrl(p))}>📄 {baseName(p)}</button>
          ))}
        </div>
      )}
      {x.people && x.people.length > 0 && (
        <div className="demo-people" data-testid="demo-people">
          {x.people.map((p) => {
            const who = server.script.people.find((y) => y.id === p.id)
            return (
              <div key={p.id} className="demo-person">
                <Face server={server} id={p.id} size={40} />
                <span><strong>{who?.name ?? p.id}</strong>{who?.title && <em>{who.title}</em>}<span>{p.why}</span></span>
              </div>
            )
          })}
        </div>
      )}
      {x.compare && <Compare {...x.compare} />}
      {x.deliverables && x.deliverables.length > 0 && (
        <div className="demo-tiles" data-testid="demo-deliverables">
          {x.deliverables.map((d) => (
            <button key={d.path} type="button" className="demo-tile" onClick={() => navigate(viewUrl(d.path))}>
              {isPicture(d.path) ? <img src={fileUrl(d.path)} alt="" /> : <span className="demo-tile-doc" aria-hidden>📝</span>}
              <span>{d.label}</span>
            </button>
          ))}
        </div>
      )}
      {x.sendTo && (
        <button type="button" className="demo-send" disabled={sent !== 'no'} onClick={() => void send()} data-testid="demo-send-to">
          {sent === 'yes' ? `✓ ${x.sendTo.label}` : x.sendTo.label}
        </button>
      )}
    </div>
  )
}

function FileChip({ path }: { path: string }) {
  return (
    <button type="button" className="demo-file" onClick={() => navigate(viewUrl(path))}>
      {isPicture(path) ? <img src={fileUrl(path)} alt="" /> : <span aria-hidden>📎</span>}
      <span>{baseName(path)}</span>
    </button>
  )
}

/** before/after: the after picture over the before one, cut where the handle is */
function Compare({ before, after, beforeLabel, afterLabel }: { before: string; after: string; beforeLabel?: string; afterLabel?: string }) {
  const [at, setAt] = useState(50)
  return (
    <div className="demo-compare" data-testid="demo-compare">
      <img src={fileUrl(before)} alt={beforeLabel ?? ''} />
      <img src={fileUrl(after)} alt={afterLabel ?? ''} style={{ clipPath: `inset(0 0 0 ${at}%)` }} />
      <span className="demo-compare-line" style={{ left: `${at}%` }} aria-hidden />
      {beforeLabel && <span className="demo-compare-label demo-left">{beforeLabel}</span>}
      {afterLabel && <span className="demo-compare-label demo-right">{afterLabel}</span>}
      <input type="range" min={0} max={100} value={at} onChange={(e) => setAt(Number(e.target.value))} aria-label={`${beforeLabel ?? 'Before'} / ${afterLabel ?? 'After'}`} />
    </div>
  )
}

/** small touches on the real screens, kept while they re-render */
function useDecorations(server: DemoServer) {
  useEffect(() => {
    const inviter = server.memberWelcome?.inviter?.id
    const tick = () => {
      // Home's card: the inviter's photo before the title
      const title = document.querySelector('[data-testid="member-welcome-title"]')
      if (title && inviter && !title.parentElement?.querySelector('.demo-inviter')) {
        const img = document.createElement('img')
        img.className = 'demo-inviter'
        img.src = `/api/people/${inviter}/avatar?v=1`
        img.alt = ''
        img.onerror = () => img.remove()
        title.before(img)
      }
      // a project link in a message: a card with its picture
      for (const a of document.querySelectorAll<HTMLAnchorElement>('[data-testid="room-message"] a[href^="/projects/"]:not([data-demo-card])')) {
        a.dataset.demoCard = ''
        const pid = /^\/projects\/([^/?#]+)/.exec(a.getAttribute('href') ?? '')?.[1]
        const story = pid ? server.storyId('project', pid) : null
        const pr = server.script.projects.find((p) => p.id === story)
        if (!pr) continue
        const picture = pr.chats?.flatMap((c) => c.turns.flatMap((t) => t.files ?? [])).find(isPicture)
        const card = document.createElement('a')
        // to the project's chat with Leo's banner big, not its page: the next step happens there
        card.href = targetOf(server, { project: pr.id })
        card.className = 'demo-project-card'
        card.dataset.testid = 'demo-project-card'
        card.addEventListener('click', (ev) => { ev.preventDefault(); navigate(card.getAttribute('href')!) })
        if (picture) {
          const img = document.createElement('img')
          img.src = fileUrl(picture)
          img.alt = ''
          card.append(img)
        }
        const words = document.createElement('span')
        const name = document.createElement('strong')
        name.textContent = pr.name
        words.append(name)
        if (pr.description) {
          const d = document.createElement('span')
          d.textContent = pr.description
          words.append(d)
        }
        card.append(words)
        a.classList.add('demo-project-link')
        a.after(card)
      }
    }
    tick()
    const id = setInterval(tick, 300)
    return () => clearInterval(id)
  }, [server])
}

function EndCard({ server, signupUrl }: { server: DemoServer; signupUrl: string }) {
  const e = server.engine
  const end = server.script.end
  const secs = Math.max(0, Math.round(((e.endedAt ?? Date.now()) - e.startedAt) / 1000))
  const elapsed = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
  return (
    <div className="demo-end-backdrop" data-testid="demo-end">
      <section className="demo-end" role="dialog" aria-modal="true" aria-labelledby="demo-end-title">
        <h2 id="demo-end-title">{end.title}</h2>
        {end.body?.split('\n\n').map((p) => <p key={p}>{p}</p>)}
        {end.stats && end.stats.length > 0 && (
          <dl className="demo-stats" data-testid="demo-stats">
            {end.stats.map((s) => (
              <div key={s.label}><dt>{s.label}</dt><dd>{s.value === 'elapsed' ? elapsed : s.value}</dd></div>
            ))}
          </dl>
        )}
        <div className="demo-end-actions">
          <a className="demo-primary" href={signupUrl} target="_blank" rel="noopener" data-testid="demo-signup">{end.signup.label}</a>
          <button type="button" className="demo-secondary" onClick={() => e.closeEnd()} data-testid="demo-explore">{end.explore.label}</button>
        </div>
      </section>
    </div>
  )
}

export type { DemoGuideStep }
