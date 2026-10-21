// Browser pane toolbar: tabs, address bar, "AI is using the browser" bar with a stop button, the person's
// permission prompts (once / always / deny), what the AI did that is always shown (scripts, network bodies,
// blocked office requests, refused password fields), and the allowed-sites list. The page itself is a separate
// view placed under this toolbar by the main process.
import type { DesktopPaneState } from '@mycel/shared'
import { h, onLocaleChange, tr, ui, type PaneActivity, type PanePrompt } from './dom'

const root = document.getElementById('root')!
let state: DesktopPaneState = { open: false, tabs: [], driving: false }
let prompts: PanePrompt[] = []
const activity: PaneActivity[] = []
let showSites = false
let sites: { always: string[]; privateAlways: string[] } = { always: [], privateAlways: [] }
let editingAddress = false
let addressDraft = ''

function activeTab() {
  return state.tabs.find((t) => t.tabId === state.activeTabId)
}

function render() {
  document.body.classList.toggle('driving', state.driving)
  const hadFocus = document.activeElement?.id
  const tab = activeTab()
  if (!editingAddress) addressDraft = tab?.url && tab.url !== 'about:blank' ? tab.url : ''
  const toolbar = h(
    'div',
    { id: 'toolbar' },
    h(
      'div',
      { class: 'tabs', role: 'tablist', 'aria-label': tr('pane.title') },
      ...state.tabs.map((t) =>
        h(
          'div',
          { class: `tab${t.active ? ' active' : ''}`, 'data-testid': 'pane-tab', 'data-tab-id': t.tabId },
          h('button', { class: 'title', type: 'button', role: 'tab', 'aria-selected': t.active ? 'true' : 'false', title: t.url, onclick: () => ui.pane.select(t.tabId) }, t.popup ? `${tr('pane.popup')}: ${t.title || t.url}` : t.title || t.url || tr('pane.newTab')),
          h('button', { class: 'x', type: 'button', 'aria-label': tr('pane.closeTab'), onclick: () => ui.pane.closeTab(t.tabId) }, '×'),
        ),
      ),
      h('button', { class: 'icon', type: 'button', 'aria-label': tr('pane.newTab'), title: tr('pane.newTab'), onclick: () => ui.pane.newTab() }, '+'),
      h('div', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'icon',
          type: 'button',
          'aria-expanded': showSites ? 'true' : 'false',
          'aria-label': tr('pane.sites'),
          title: tr('pane.sites'),
          'data-testid': 'sites-button',
          onclick: async () => {
            showSites = !showSites
            if (showSites) sites = (await ui.pane.sites()) ?? sites
            render()
          },
        },
        '⚙',
      ),
      h('button', { class: 'icon', type: 'button', 'aria-label': tr('pane.close'), title: tr('pane.close'), onclick: () => ui.pane.close() }, '✕'),
    ),
    h(
      'div',
      { class: 'nav' },
      h('button', { class: 'icon', type: 'button', 'aria-label': tr('pane.back'), title: tr('pane.back'), onclick: () => ui.pane.history('back') }, '←'),
      h('button', { class: 'icon', type: 'button', 'aria-label': tr('pane.forward'), title: tr('pane.forward'), onclick: () => ui.pane.history('forward') }, '→'),
      h('button', { class: 'icon', type: 'button', 'aria-label': tr('pane.reload'), title: tr('pane.reload'), onclick: () => ui.pane.history('reload') }, '↻'),
      h(
        'form',
        {
          onsubmit: (e: Event) => {
            e.preventDefault()
            editingAddress = false
            if (addressDraft.trim()) ui.pane.navigate(addressDraft.trim())
            ;(document.activeElement as HTMLElement | null)?.blur()
          },
        },
        h('label', { for: 'pane-address', class: 'sr-only' }, tr('pane.address')),
        h('input', {
          id: 'pane-address',
          'data-testid': 'pane-address',
          type: 'text',
          spellcheck: 'false',
          value: addressDraft,
          onfocus: () => {
            editingAddress = true
          },
          onblur: () => {
            editingAddress = false
          },
          oninput: (e: Event) => {
            addressDraft = (e.target as HTMLInputElement).value
          },
        }),
      ),
    ),
    h(
      'div',
      { class: 'driving-bar', role: 'status', 'data-testid': 'driving' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('span', {}, tr('pane.driving')),
      h('button', { type: 'button', 'data-testid': 'stop', onclick: () => ui.pane.stop() }, tr('pane.stop')),
    ),
    ...prompts.map(promptCard),
    activity.length ? h('div', { class: 'activity', 'aria-live': 'polite', 'data-testid': 'activity' }, ...activity.map((a) => h('div', { 'data-kind': a.kind }, activityText(a)))) : null,
    showSites ? sitesBox() : null,
  )
  const body = state.tabs.length ? null : h('p', { class: 'empty' }, tr('pane.empty'))
  const splitter = h('button', { class: 'splitter', type: 'button', 'aria-label': tr('pane.resize'), tabindex: '-1' })
  splitter.addEventListener('pointerdown', (e: PointerEvent) => {
    splitter.setPointerCapture(e.pointerId)
    const move = (m: PointerEvent) => ui.pane.resize(m.screenX)
    const up = () => {
      splitter.removeEventListener('pointermove', move)
      splitter.removeEventListener('pointerup', up)
    }
    splitter.addEventListener('pointermove', move)
    splitter.addEventListener('pointerup', up)
  })
  root.replaceChildren(splitter, toolbar, ...(body ? [body] : []))
  if (hadFocus) document.getElementById(hadFocus)?.focus()
  observer.disconnect()
  observer.observe(toolbar)
  ui.pane.toolbarHeight(toolbar.getBoundingClientRect().height)
}

function promptCard(p: PanePrompt) {
  const isPrivate = p.scope === 'private'
  return h(
    'section',
    { class: `prompt${isPrivate ? ' private' : ''}`, role: 'alertdialog', 'aria-labelledby': `p-${p.id}`, 'data-testid': 'permission-prompt', 'data-scope': p.scope },
    h('h2', { id: `p-${p.id}` }, tr(isPrivate ? 'perm.private.title' : 'perm.site.title', { host: p.host })),
    h('p', {}, tr(isPrivate ? 'perm.private.body' : 'perm.site.body')),
    h('p', { class: 'url' }, `${p.tool} · ${p.url}`),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'primary', type: 'button', onclick: () => ui.pane.answer(p.id, 'once') }, tr('perm.once')),
      h('button', { type: 'button', onclick: () => ui.pane.answer(p.id, 'always') }, tr('perm.always')),
      h('button', { type: 'button', class: 'danger', onclick: () => ui.pane.answer(p.id, 'deny') }, tr('perm.deny')),
    ),
  )
}

function activityText(a: PaneActivity) {
  if (a.kind === 'script') return tr('activity.script', { host: a.host || '—' })
  if (a.kind === 'network') return tr('activity.network', { host: a.host || '—' })
  if (a.kind === 'blocked') return tr('activity.blocked', { host: a.host })
  if (a.kind === 'forbidden') return tr('activity.forbidden', { host: a.host })
  return tr('activity.password')
}

function sitesBox() {
  const rows = [...sites.always.map((s) => ({ host: s, priv: sites.privateAlways.includes(s) })), ...sites.privateAlways.filter((s) => !sites.always.includes(s)).map((s) => ({ host: s, priv: true }))]
  return h(
    'section',
    { class: 'sites', 'data-testid': 'sites', 'aria-label': tr('pane.sites') },
    h('strong', {}, tr('pane.sites')),
    rows.length
      ? h(
          'ul',
          {},
          ...rows.map((r) =>
            h(
              'li',
              {},
              h('span', {}, r.host),
              r.priv ? h('span', { class: 'tag' }, tr('pane.privateTag')) : null,
              h(
                'button',
                {
                  type: 'button',
                  class: 'danger',
                  onclick: async () => {
                    ui.pane.removeSite(r.host)
                    sites = (await ui.pane.sites()) ?? sites
                    render()
                  },
                },
                tr('pane.sitesRemove'),
              ),
            ),
          ),
        )
      : h('p', {}, tr('pane.sitesNone')),
    rows.length > 1
      ? h(
          'button',
          {
            type: 'button',
            class: 'danger',
            'data-testid': 'sites-clear',
            onclick: async () => {
              ui.pane.clearSites()
              sites = (await ui.pane.sites()) ?? sites
              render()
            },
          },
          tr('pane.sitesClear'),
        )
      : null,
  )
}

const observer = new ResizeObserver((entries) => {
  for (const e of entries) ui.pane.toolbarHeight((e.target as HTMLElement).getBoundingClientRect().height)
})

ui.pane.onState((s) => {
  state = s
  render()
})
ui.pane.onPrompts((p) => {
  prompts = p
  render()
})
ui.pane.onActivity((a) => {
  activity.push(a)
  if (activity.length > 4) activity.shift()
  render()
  // activity notes fade after a while; the newest stay
  setTimeout(() => {
    const i = activity.indexOf(a)
    if (i >= 0) {
      activity.splice(i, 1)
      render()
    }
  }, 15_000)
})
void ui.pane.state().then((s) => {
  if (s) state = s
  render()
})
onLocaleChange(render)
render()
