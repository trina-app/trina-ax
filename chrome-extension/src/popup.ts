// The popup: connect (when not linked), the pairing wait, and when linked who it works for, online or not, Stop
// while the AI works, Disconnect. All words come from messages.ts: in the person's language once the team told it
// (i18n.ts), else the browser's (chrome.i18n).
import type { PopupStatus } from './worker'
import { t, uiLanguage, useLocale } from './i18n'
const app = document.getElementById('app')!
let activeOrigin: string | null = null
let note = ''
let otherOpen = false
/** the name the person types for this browser profile at Connect (kept across re-renders); empty: the profile's Google
 * account, else "Chrome on Mac" */
let label: string | null = null
/** Connect also asks Chrome (once, in the same prompt) to let the extension read the profile's Google account */
let askEmail = false
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

/** Ask Chrome for access to this one team address, inside the click (a user gesture), then start pairing. An empty name
 * also asks, in the same prompt and only once, to read the profile's Google account: the profile is named after it. */
function connectTo(o: string) {
  const name = label ?? ''
  const u = new URL(o)
  const pattern = `${u.protocol}//${u.hostname}/*`
  const withEmail = askEmail && !name.trim()
  // the worker starts pairing when Chrome grants access, also if this popup closes while Chrome asks
  void chrome.runtime.sendMessage({ type: 'want', origin: o, label: name, askEmail: withEmail }).catch(() => {})
  chrome.permissions.request({ origins: [pattern], ...(withEmail ? { permissions: ['identity.email'] } : {}) }).then(
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
  useLocale(s.locale)
  document.documentElement.lang = uiLanguage()
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
    // each browser profile is its own link, shown in the team's list: named after its Google account when the extension
    // may read it (else left empty: Connect asks once), else "Chrome on Mac"; the person can type any name ("Work mail")
    askEmail = s.askEmail
    if (label === null) label = s.email ?? ''
    const name = el('input', { type: 'text', value: label, maxLength: 60, spellcheck: false, placeholder: s.askEmail ? t('nameAuto') : s.suggestedLabel, oninput: () => (label = name.value) })
    name.id = 'name'
    app.append(el('label', { cls: 'field', htmlFor: 'name' }, el('span', { textContent: t('nameLabel') }), name))
    if (s.askEmail) app.append(el('p', { cls: 'note', textContent: t('nameAutoHint') }))
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
  document.documentElement.lang = uiLanguage()
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
