// The demo's only layer over the real app (docs/AGENTS/plan/20261114-0507-mina-demo.md): the guide line in a corner
// (on phones a bar of its own) with "Start over", and a ring over the one real control to use next. Everything else
// on screen is the app's own UI: answers, file chips, the share dialog, the AI's cards, rooms, typing, reactions.
// The guide line names the moment and does its step; it holds the step's prompts as buttons, and at the end it becomes
// the end line with the sign-up link. No tooltip tour (DECISIONS rejected those), no cards or toasts of our own.
// Styles are in demo.css (not Tailwind: the product's stylesheet must not change for the demo).
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, Modal } from '../src/components/ui'
import { useLocale, useT } from '../src/i18n'
import type { DemoAnswer, DemoGo } from './script'
import type { DemoServer } from './server'
import { appPath, appPathNow, BASE } from './base'
import { demoWord } from './words'
import './demo.css'

/** the demos of every language on the site (web/demo/vite.ts demoLangs), named in their own language */
const LANGS = __DEMO_LANGS__
const LANG_NAMES: Record<string, string> = { en: 'English', ko: '한국어', ja: '日本語', es: 'Español', id: 'Bahasa Indonesia' }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** a route change react-router hears (BrowserRouter follows popstate) */
export function navigate(to: string) {
  if (appPathNow() + location.search === to) return
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
  // a link to a chat, room or project that the browser would follow loads the page again, and a new page starts the
  // story over: such a link moves inside the app instead (the app's own handler may run too; the same address twice
  // is one move). Other links (a file's preview, downloads) are left to the app.
  window.addEventListener('click', (ev) => {
    if (apiLink(ev)) return
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return
    const href = inAppLink(ev.target)
    if (!href) return
    ev.preventDefault()
    navigate(href)
  }, true)
  watchOpened(server)
}

const endTitle = (title: string, time: string) => (title.includes('{time}') ? title.replace('{time}', time) : `${title} · ${time}`)

/** A link to the page's own server (/api/…: a download, an image's "open original") that the browser would follow:
 * no team server is behind the site, and under a base path the worker cannot answer a page it does not hold. The file
 * is fetched from the page's server and saved, or opened in a new tab, as a blob. */
function apiLink(ev: MouseEvent): boolean {
  const a = (ev.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!a || ev.defaultPrevented) return false
  const url = new URL(a.href, location.href)
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return false
  ev.preventDefault()
  const name = a.getAttribute('download')
  // a new tab now, while the click still counts as the visitor's (filled once the file is here)
  const tab = name === null ? window.open('', '_blank') : null
  void (async () => {
    const res = await fetch(url.href)
    if (!res.ok) { tab?.close(); return }
    const blob = await res.blob()
    const href = URL.createObjectURL(blob)
    if (tab) tab.location.href = href
    else {
      const save = document.createElement('a')
      save.href = href
      save.download = name || decodeURIComponent(url.pathname.split('/').pop() ?? 'file')
      document.body.append(save)
      save.click()
      save.remove()
    }
    setTimeout(() => URL.revokeObjectURL(href), 60_000)
  })()
  return true
}

/** the in-app address of a link to a chat, room or project under `target`, or null */
function inAppLink(target: EventTarget | null): string | null {
  const a = (target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!a || a.target === '_blank' || a.hasAttribute('download')) return null
  const url = new URL(a.href, location.href)
  if (url.origin !== location.origin || !/^\/(c|rooms|projects)(\/|$)/.test(appPath(url.pathname))) return null
  return appPath(url.pathname) + url.search + url.hash
}

/** "opened" happenings: the visitor is on a room's page or in a project (its page or one of its chats) */
function watchOpened(server: DemoServer) {
  // every tick, not only on a move: a message that waits on a visit (DemoEvent.requires) may come while the visitor is there
  setInterval(() => {
    const path = appPathNow()
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

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
/** the box's text, through its own input event, so the app's state follows (never focused: no phone keyboard) */
function setBox(box: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, value)
  box.dispatchEvent(new Event('input', { bubbles: true }))
}
/** the visible message box of a place, now */
const boxNow = (go: DemoGo) => [...document.querySelectorAll<HTMLTextAreaElement>(boxOf(go))].reverse().find(visible) ?? null

/** A suggested prompt typed into the place's real message box, as a person types (25–40 ms a letter, a short pause at
 * some spaces; at once with reduced motion or `instant`), and left there: the visitor presses send. Never over the
 * visitor's own text, and it stops when they type in between (what they typed stays). */
/** what one try of typing came to: the prompt is in the box, the box holds the visitor's own words, or the box was not
 * ready or went away under it (the app still mounting or putting its chat back: try again) */
type Typed = 'done' | 'theirs' | 'gone'
async function typePromptOnce(server: DemoServer, go: DemoGo, a: DemoAnswer, instant: boolean): Promise<Typed> {
  if (!atPlace(server, go, appPathNow())) await goTo(server, go)
  const box = await waitFor<HTMLTextAreaElement>(boxOf(go))
  if (!box || box.disabled || box.readOnly) return 'gone'
  const text = a.prompt
  const mine = (v: string) => text.startsWith(v)
  if (box.value === text) return 'done'
  // the visitor's own words stay; a part of the prompt from an earlier try is carried on
  if (box.value.trim() && !mine(box.value)) return 'theirs'
  if (instant || reducedMotion()) { setBox(box, text); return box.value === text ? 'done' : 'gone' }
  const per = Math.min(40, Math.max(25, 1700 / text.length))
  let setBack = 0
  for (let i = box.value.length + 1; i <= text.length; i++) {
    if (!box.isConnected) return 'gone'
    if (box.value !== text.slice(0, i - 1)) {
      if (box.value && !mine(box.value)) return 'theirs'
      // the app set the box back (its own render under load): go on from what is there, a few times
      if (++setBack > 5) return 'gone'
      i = box.value.length + 1
    }
    setBox(box, text.slice(0, i))
    await sleep(per + Math.random() * 10 - 5 + (text[i - 1] === ' ' && Math.random() < 0.2 ? 60 + Math.random() * 70 : 0))
  }
  // (the app's render after the last letter)
  await sleep(60)
  if (!box.isConnected) return 'gone'
  return box.value === text ? 'done' : box.value && !mine(box.value) ? 'theirs' : 'gone'
}

/** A suggested prompt typed into the place's real message box (typePromptOnce), tried again until the box is there and
 * keeps the text (a slow phone mounts the chat late, or renders it again while the letters go in), while `still` holds */
async function typePrompt(server: DemoServer, go: DemoGo, a: DemoAnswer, instant: boolean, still: () => boolean): Promise<Typed> {
  const until = Date.now() + 30_000
  for (let n = 0; ; n++) {
    const r = await typePromptOnce(server, go, a, instant || n > 0)
    if (r !== 'gone' || !still() || Date.now() > until) return r
    await sleep(300)
  }
}

function useEngine(server: DemoServer) {
  const e = server.engine
  return useSyncExternalStore((fn) => e.subscribe(fn), () => `${e.guide()?.id ?? ''}|${e.endShown}|${e.endClosed}`)
}

/** the path, kept fresh (react-router changes it without telling this root) */
function usePath() {
  const [path, setPath] = useState(appPathNow())
  useEffect(() => {
    const id = setInterval(() => setPath(appPathNow()), 250)
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
  // the app's navigation (the rail, the phone's tabs) first, then the phone's back arrow of a chat (where the tabs hide)
  const tab = (href: string) => first(`nav a[href${href}]`) ?? first(`a[href${href}]`)
  const back = () => first('[data-testid="chat-back"]')
  if (go === 'home') return tab('="/"') ?? back()
  if ('project' in go) return first(`a[href^="/projects/${server.idOf('project', go.project)}"]`) ?? tab('="/projects"') ?? back()
  const room = server.idOf('room', 'room' in go ? go.room : go.side)
  if ('side' in go && path.startsWith(`/rooms/${room}`)) return first('[data-testid="room-side-chat-button"]')
  return first(`a[href^="/rooms/${room}"]`) ?? tab('^="/rooms"') ?? back()
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
  // the step whose prompt was typed (once a step: a later press fills it at once), and a typing under way
  const [typedFor, setTypedFor] = useState<string | null>(null)
  const [typing, setTyping] = useState(false)
  const cardOpen = [...document.querySelectorAll('[data-testid="ask-card"]')].some(visible)
  // the AI is still answering on screen (its card not out yet): the guide waits with it
  const working = !cardOpen && [...document.querySelectorAll('[data-testid="assistant-message"][data-status="streaming"]')].some(visible)
  // on a project's own page with an earlier chat (Leo's banner): that chat first, so the banner is seen before the choice
  const goProject = step && step.go !== 'home' && 'project' in step.go ? step.go.project : null
  const projectChat = goProject && /^\/projects\/[^/]+$/.test(path) ? server.script.projects.find((p) => p.id === goProject)?.chats?.[0] : undefined
  const chatRow = projectChat ? [...document.querySelectorAll(`a[href^="/c/${server.idOf('chat', projectChat.id)}"]`)].find(visible) ?? null : null
  // the place's message box holds text (typed by the demo or by the visitor): the guide line says to press send, and the
  // real send button is ringed
  const box = here && step && !chatRow ? boxNow(step.go) : null
  const sendReady = !!box?.value.trim() && !typing && !working && !cardOpen
  const sendButton = sendReady && step ? [...document.querySelectorAll(sendOf(step.go))].reverse().find(visible) ?? null : null
  const suggest = here && !chatRow && !typing && !sendReady && !cardOpen && !working ? (step?.suggest ?? []).flatMap((id) => server.script.answers.filter((a) => a.id === id)) : []
  // one prompt only: no choice buttons, the guide line itself sends it (and glows)
  const choices = suggest.length > 1 ? suggest : []
  // a dialog of the app is open (Send to room): the guide steps back so it never covers the dialog's buttons
  const dialogOpen = [...document.querySelectorAll('[role="dialog"]')].some(visible)

  // the one thing ringed: the AI's card when it waits, the share dialog's next control, the step's control, or the way
  // there; nothing while Trina works or while the step's prompts are in the guide line
  const target: Element | null = !step || end || working || typing || suggest.length ? null
    : sendButton ? sendButton
    : cardOpen && here ? [...document.querySelectorAll('[data-testid="ask-card"]')].reverse().find(visible) ?? null
    : chatRow ?? shareTarget(server)
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

  /** a prompt into the real box: typed the first time at a step, at once after that (a prompt stopped, or cleared) */
  const pick = async (a: DemoAnswer) => {
    if (!step || typing) return
    const instant = typedFor === step.id
    setTyping(true)
    setTypedFor(step.id)
    const id = step.id
    try { await typePrompt(server, step.go, a, instant, () => server.engine.guide()?.id === id && atPlace(server, step.go, appPathNow())) } finally { setTyping(false) }
  }
  // arriving at a step with one prompt (Leo's chat, the side chat opened by hand or by the guide line): it types itself
  const single = here && !chatRow && !cardOpen && !working && !typing && step?.suggest?.length === 1 && typedFor !== step.id && !box?.value.trim()
  const singleAnswer = single ? server.script.answers.find((a) => a.id === step!.suggest![0]) : undefined
  useEffect(() => {
    if (!singleAnswer || !step) return
    // (a moment for the place to settle: the page's own focus and scroll first)
    const id = setTimeout(() => void pick(singleAnswer), 500)
    return () => clearTimeout(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singleAnswer?.id, step?.id])

  /** the guide line does its step: it presses the ringed control (the card: its first choice; a row: its button), sends
   * the step's first prompt, or goes there */
  const act = async () => {
    if (!step) return
    const ringed = target
    // (read again now: the page may have changed since the last render)
    const row = projectChat ? [...document.querySelectorAll(`a[href^="/c/${server.idOf('chat', projectChat.id)}"]`)].find(visible) : undefined
    if (row) { navigate(inAppLink(row) ?? `/c/${server.idOf('chat', projectChat!.id)}`); return }
    // (here, read again: the last render may be a quarter of a second old)
    const hereNow = atPlace(server, step.go, appPathNow())
    const noCard = ![...document.querySelectorAll('[data-testid="ask-card"]')].some(visible)
    // the box holds the prompt (or the visitor's words): the guide line is the visitor pressing send
    const full = hereNow && noCard ? boxNow(step.go) : null
    if (full?.value.trim()) {
      ;[...document.querySelectorAll<HTMLButtonElement>(sendOf(step.go))].reverse().find(visible)?.click()
      return
    }
    const firstPrompt = hereNow && noCard ? server.script.answers.find((a) => a.id === step.suggest?.[0]) : undefined
    if (firstPrompt) { void pick(firstPrompt); return }
    // the ringed control as the page is now (the last render may have had none yet: a message still coming in)
    const now: Element | null = ringed ?? (step.highlight ? [...document.querySelectorAll(step.highlight)].reverse().find(visible) ?? null : null)
    // elsewhere: straight there (the ring shows the way for a visitor who clicks by hand), unless the step's own
    // control is on screen (a link in a message)
    if (!hereNow && !(step.highlight && now?.matches(step.highlight))) { await goTo(server, step.go); return }
    if (now) {
      now.scrollIntoView({ block: 'center', behavior: 'smooth' })
      if (now.matches('[data-testid="ask-card"]')) {
        const send = now.querySelector<HTMLButtonElement>('[data-testid="ask-send"]')
        if (send) {
          now.querySelector<HTMLElement>('label, [role="radio"], input[type="radio"]')?.click()
          await sleep(150)
          send.click()
        } else [...now.querySelectorAll<HTMLButtonElement>('button')].filter(visible).pop()?.click()
        return
      }
      const el = now as HTMLElement
      const href = inAppLink(el)
      if (href) { navigate(href); return }
      const button = el.matches('button, a, [role="button"], [role="option"]') ? el : el.querySelector<HTMLElement>('button, a, [role="button"]') ?? el
      button.click()
      return
    }
    await goTo(server, step.go)
  }

  const guideRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = guideRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const o = new ResizeObserver(() => document.documentElement.style.setProperty('--demo-guide-h', `${el.offsetHeight}px`))
    o.observe(el)
    return () => o.disconnect()
  }, [])

  const popup = server.script.end.popup
  const secs = Math.max(0, Math.round(((e.endedAt ?? Date.now()) - e.startedAt) / 1000))
  const elapsed = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
  return (
    <>
      <div ref={guideRef} className={dialogOpen ? 'demo-guide demo-guide-back' : 'demo-guide'} role="region" aria-label={demoWord('guideLabel', locale)} data-testid="demo-guide">
        {choices.length > 0 && (
          <div className="demo-choices" data-testid="demo-suggest">
            {choices.map((a) => (
              <button key={a.id} type="button" className="demo-choice" disabled={typing} onClick={() => void pick(a)} data-testid={`demo-suggest-${a.id}`}>{a.label ?? a.prompt}</button>
            ))}
          </div>
        )}
        <div className="demo-bar">
          <span className="demo-badge">{t('demo.bar', { company: server.script.company.name })}</span>
          {end ? (
            <span className="demo-end-line" data-testid="demo-end">
              <span><strong>{endTitle(server.script.end.title, elapsed)}</strong>{server.script.end.contrast ? ` (${server.script.end.contrast})` : ''}</span>
              <a className="demo-next" href={signupUrl} target="_blank" rel="noopener" data-testid="demo-signup">{server.script.end.signup.label} →</a>
            </span>
          ) : step && !working ? (
            <button type="button" className={target || choices.length ? 'demo-next' : 'demo-next demo-glow'} disabled={typing} onClick={() => void act()} data-testid="demo-next" data-away={here ? undefined : ''}>
              {sendReady ? demoWord('pressSend', locale) : here && cardOpen ? demoWord('card', locale) : chatRow && projectChat ? demoWord('openChat', locale).replace('{title}', projectChat.title) : here || inSideRoom ? step.text : step.away ?? step.text}
            </button>
          ) : (
            <span className="demo-next demo-wait" data-testid="demo-wait" role="status">{demoWord(working ? 'working' : 'waiting', locale)}</span>
          )}
          <button type="button" className="demo-restart" onClick={() => location.assign(BASE)} data-testid="demo-restart">{demoWord('restart', locale)}</button>
          {LANGS.length > 1 && (
            // the other languages' demos (each its own build on the site): a plain link, a new story
            <span className="demo-langs" data-testid="demo-langs">
              {LANGS.map((l, i) => (
                <span key={l.locale}>
                  {i > 0 && <span aria-hidden> / </span>}
                  {l.locale === server.script.locale
                    ? <span aria-current="true">{LANG_NAMES[l.locale] ?? l.locale}</span>
                    : <a href={l.base} hrefLang={l.locale} lang={l.locale} data-testid={`demo-lang-${l.locale}`}>{LANG_NAMES[l.locale] ?? l.locale}</a>}
                </span>
              ))}
            </span>
          )}
        </div>
      </div>
      {end && popup && (
        // the end popup: the app's own Modal (a bottom sheet on phones), no motion of its own
        <Modal
          open={!e.endClosed}
          onClose={() => e.closeEnd()}
          title={popup.title}
          width={460}
          footer={(
            <>
              <Button onClick={() => location.assign(BASE)} data-testid="demo-popup-restart">{demoWord('restart', locale)}</Button>
              <Button onClick={() => e.closeEnd()} data-testid="demo-popup-close">{popup.close}</Button>
              <Button variant="primary" onClick={() => window.open(signupUrl, '_blank', 'noopener')} data-testid="demo-popup-signup">{server.script.end.signup.label}</Button>
            </>
          )}
        >
          <div data-testid="demo-popup">
            <p className="text-sm text-ink">{popup.line.replace('{time}', elapsed)}</p>
            {popup.recap?.length ? <p className="mt-2 text-sm text-muted">{popup.recap.join(' · ')}</p> : null}
          </div>
        </Modal>
      )}
      {ring && ring.width > 0 && (
        <span className="demo-ring" data-testid="demo-ring" aria-hidden style={{ left: ring.left - 5, top: ring.top - 5, width: ring.width + 10, height: ring.height + 10 }} />
      )}
    </>
  )
}
