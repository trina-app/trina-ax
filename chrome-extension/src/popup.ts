// The popup: connect (when not linked), the pairing wait, and when linked who it works for, online or not, Stop
// while the AI works, Disconnect. All words come from _locales (messages.ts) through chrome.i18n.
import type { PopupStatus } from './worker'

const t = (key: string, subs?: string[]) => chrome.i18n.getMessage(key, subs) || key
const app = document.getElementById('app')!
let activeOrigin: string | null = null
let note = ''
let otherOpen = false
/** the name the person types for this browser profile at Connect (kept across re-renders) */
let label: string | null = null
/** renaming a linked profile: the name being typed, or null */
let renaming: string | null = null

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  const { cls, ...rest } = props
  Object.assign(e, rest)
  if (cls) e.className = cls
  e.append(...kids)
  return e
}

/** http(s) origin a team could live at, or null (the popup only offers https and a developer's localhost). */
function origin(raw: string): string | null {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`)
    if (u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) return u.origin
  } catch {
    // not an address
  }
  return null
}

async function ask(msg: Record<string, unknown>): Promise<PopupStatus> {
  return chrome.runtime.sendMessage<PopupStatus>(msg)
}

/** Ask Chrome for access to this one team address, inside the click (a user gesture), then start pairing. */
function connectTo(o: string) {
  const name = label ?? ''
  const u = new URL(o)
  const pattern = `${u.protocol}//${u.hostname}/*`
  // the worker starts pairing when Chrome grants access, also if this popup closes while Chrome asks
  void chrome.runtime.sendMessage({ type: 'want', origin: o, label: name }).catch(() => {})
  chrome.permissions.request({ origins: [pattern] }).then(
    async (granted) => {
      if (!granted) {
        note = t('permissionDenied')
        return render(await ask({ type: 'status' }))
      }
      note = ''
      render(await ask({ type: 'pair', origin: o, label: name }))
    },
    () => {
      note = t('permissionDenied')
      void refresh()
    },
  )
}

function render(s: PopupStatus) {
  app.replaceChildren()
  if (!s.linked && s.pair.state === 'waiting') {
    app.append(
      el('h1', { textContent: t('pairingTitle') }),
      el('p', { textContent: t('pairingBody') }),
      el('button', { textContent: t('cancel'), onclick: async () => render(await ask({ type: 'cancelPair' })) }),
    )
    return
  }
  if (!s.linked) {
    app.append(el('h1', { textContent: t('notLinkedTitle') }), el('p', { textContent: t('notLinkedBody') }))
    if (s.pair.state === 'failed') app.append(el('p', { cls: 'error', textContent: s.pair.full ? t('linksFull') : t('pairFailed') }))
    if (note) app.append(el('p', { cls: 'error', textContent: note }))
    // each browser profile is its own link: the person names it ("Work mail"), shown in the team's list
    if (label === null) label = s.suggestedLabel
    const name = el('input', { type: 'text', value: label, maxLength: 60, spellcheck: false, oninput: () => (label = name.value) })
    name.id = 'name'
    app.append(el('label', { cls: 'field', htmlFor: 'name' }, el('span', { textContent: t('nameLabel') }), name))
    if (activeOrigin) {
      app.append(el('button', { cls: 'primary', textContent: t('connectTo', [new URL(activeOrigin).host]), onclick: () => connectTo(activeOrigin!) }))
    } else app.append(el('p', { cls: 'note', textContent: t('openTeamFirst') }))
    if (otherOpen || !activeOrigin) {
      const input = el('input', { type: 'url', placeholder: t('addressPlaceholder'), spellcheck: false })
      input.setAttribute('aria-label', t('otherAddress'))
      const form = el('form', {
        onsubmit: (e: Event) => {
          e.preventDefault()
          const o = origin(input.value)
          if (!o) {
            note = t('badAddress')
            return void refresh()
          }
          connectTo(o)
        },
      }, input, el('button', { type: 'submit', textContent: t('connect') }))
      app.append(form)
      if (otherOpen) input.focus()
    } else app.append(el('button', { cls: 'link', textContent: t('otherAddress'), onclick: () => ((otherOpen = true), void refresh()) }))
    return
  }
  app.append(
    el('div', { cls: 'who', textContent: t('connectedTo', [s.team ?? '', s.user ?? '']) }),
    ...nameRow(s),
    el('div', { cls: 'status' }, el('span', { cls: `dot${s.online ? ' on' : ''}` }), el('span', { textContent: s.online ? t('online') : t('offline') })),
  )
  if (s.runs.length) {
    // each task the AI works on now, with its own Stop
    app.append(el('p', { textContent: t('workingTitle') }))
    for (const r of s.runs) {
      app.append(el('div', { cls: 'run' },
        el('div', { cls: 'run-text' }, el('div', { cls: 'run-title', textContent: r.title || '…' }), el('div', { cls: 'note', textContent: r.tabs <= 1 ? t('runTabsOne') : t('runTabsMany', [String(r.tabs)]) })),
        el('button', { cls: 'stop', textContent: t('stop'), onclick: async () => render(await ask({ type: 'stop', runId: r.id })) }),
      ))
    }
    app.append(el('p', { cls: 'note', textContent: t('stopHint') }))
  } else if (s.stopped) app.append(el('p', { textContent: t('stopped') }))
  app.append(
    el('p', { cls: 'note', textContent: t('groupHint') }),
    el('hr'),
    el('button', { cls: 'link', textContent: t('disconnect'), onclick: async () => render(await ask({ type: 'disconnect' })) }),
  )
}

/** "This browser: Work" with Rename (only while online: the team keeps the name), or the field being typed. */
function nameRow(s: PopupStatus): Node[] {
  if (renaming !== null) {
    const input = el('input', {
      type: 'text', value: renaming, maxLength: 60, spellcheck: false, oninput: () => (renaming = input.value),
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); renaming = null; void refresh() } },
    })
    input.setAttribute('aria-label', t('nameLabel'))
    const form = el('form', {
      cls: 'rename',
      onsubmit: async (e: Event) => {
        e.preventDefault()
        const v = input.value
        renaming = null
        render(await ask({ type: 'rename', label: v }))
      },
    }, input, el('button', { type: 'submit', textContent: t('save') }))
    queueMicrotask(() => input.focus())
    return [form]
  }
  const out: Node[] = []
  if (s.label) {
    const row = el('p', { cls: 'note' }, t('thisBrowser', [s.label]) + ' ')
    if (s.online) row.append(el('button', { cls: 'link', textContent: t('rename'), onclick: () => ((renaming = s.label ?? ''), render(s)) }))
    out.push(row)
  }
  if (s.renameFailed) out.push(el('p', { cls: 'error', textContent: t('renameOffline') }))
  return out
}

async function refresh() {
  render(await ask({ type: 'status' }))
}

async function start() {
  document.documentElement.lang = chrome.i18n.getUILanguage()
  // activeTab: the address of the page in front, given for this click only
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [])
  activeOrigin = tab?.url ? origin(tab.url) : null
  if (activeOrigin && !/^https?:\/\//.test(tab!.url!)) activeOrigin = null
  await refresh()
  // the state changes while the popup is open (online, working, pairing finished)
  setInterval(() => {
    if (!document.activeElement || document.activeElement.tagName !== 'INPUT') void refresh()
  }, 1000)
}

void start()
