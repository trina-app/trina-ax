// Browser pane toolbar: tabs, address bar, "AI is using the browser" bar with a stop button and the AI's latest
// action, the person's permission question (once / always / deny; one at a time), the activity log (everything the
// AI did or the browser refused, opened from the toolbar), at most one line over the page for what needs the person
// now (common/pane-activity.ts), and the settings panel (site access: ask / allow all websites, and the sites
// allowed always). The page itself is a separate view placed under this toolbar by the main process.
import type { DesktopPaneState } from '@mycel/shared'
import { addActivity, dismissNotice, emptyActivity, markSeen, type ActivityView } from '../common/pane-activity'
import { h, onLocaleChange, tr, ui, type PaneActivity, type PanePrompt, type SiteSettings } from './dom'

/** the line over the page goes away by itself after this long */
const NOTICE_MS = 20_000

const root = document.getElementById('root')!
let state: DesktopPaneState = { open: false, tabs: [], driving: false }
let prompts: PanePrompt[] = []
let activity: ActivityView = emptyActivity()
let showLog = false
let showSites = false
let sites: SiteSettings = { always: [], privateAlways: [], siteAccess: 'ask' }
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
      // the setting is on: visible all the time, one click from the panel that turns it off
      sites.siteAccess === 'all'
        ? h('button', { class: 'pill', type: 'button', 'data-testid': 'access-all-on', onclick: () => toggleSites(true) }, tr('pane.accessAllOn'))
        : null,
      h(
        'button',
        {
          class: 'icon log-button',
          type: 'button',
          'aria-expanded': showLog ? 'true' : 'false',
          'aria-label': tr('pane.activity'),
          title: tr('pane.activity'),
          'data-testid': 'activity-button',
          onclick: () => {
            showLog = !showLog
            if (showLog) {
              showSites = false
              activity = markSeen(activity)
            }
            render()
          },
        },
        '☰',
        activity.unseen ? h('span', { class: 'badge', 'data-testid': 'activity-count' }, String(activity.unseen)) : null,
      ),
      h(
        'button',
        {
          class: 'icon',
          type: 'button',
          'aria-expanded': showSites ? 'true' : 'false',
          'aria-label': tr('pane.settings'),
          title: tr('pane.settings'),
          'data-testid': 'sites-button',
          onclick: () => toggleSites(),
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
      // the AI's latest action, in place of a banner per action
      activity.log[0] ? h('span', { class: 'last', 'data-testid': 'driving-last', title: activityText(activity.log[0]) }, activityText(activity.log[0])) : null,
      h('button', { type: 'button', 'data-testid': 'stop', onclick: () => ui.pane.stop() }, tr('pane.stop')),
    ),
    prompts[0] ? promptCard(prompts[0], prompts.length - 1) : null,
    activity.notice ? noticeLine(activity.notice) : null,
    showLog ? logBox() : null,
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

async function toggleSites(open = !showSites) {
  showSites = open
  if (showSites) {
    showLog = false
    sites = (await ui.pane.sites()) ?? sites
  }
  render()
}

/** The one line over the page (common/pane-activity.ts): a newer one replaces it. */
function noticeLine(a: PaneActivity) {
  return h(
    'div',
    { class: 'notice', role: 'status', 'aria-live': 'polite', 'data-testid': 'notice', 'data-kind': a.kind },
    h('span', {}, activityText(a)),
    h(
      'button',
      {
        class: 'x',
        type: 'button',
        'aria-label': tr('pane.dismiss'),
        title: tr('pane.dismiss'),
        onclick: () => {
          activity = dismissNotice(activity, a.id)
          render()
        },
      },
      '×',
    ),
  )
}

function logBox() {
  const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return h(
    'section',
    { class: 'log', 'data-testid': 'activity', 'aria-label': tr('pane.activity') },
    h('strong', {}, tr('pane.activity')),
    activity.log.length
      ? h('ol', {}, ...activity.log.map((a) => h('li', { 'data-kind': a.kind }, h('time', {}, time(a.at)), h('span', {}, activityText(a)))))
      : h('p', {}, tr('pane.activityNone')),
  )
}

function promptCard(p: PanePrompt, more: number) {
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
    more > 0 ? h('p', { class: 'more', 'data-testid': 'prompts-more' }, tr('pane.promptsMore', { n: String(more) })) : null,
  )
}

function activityText(a: PaneActivity) {
  if (a.kind === 'script') return tr('activity.script', { host: a.host || '—' })
  if (a.kind === 'network') return tr('activity.network', { host: a.host || '—' })
  if (a.kind === 'blocked') return tr('activity.blocked', { host: a.host })
  if (a.kind === 'offsite') return tr('activity.offsite', { host: a.host })
  if (a.kind === 'denied') return tr('activity.denied', { host: a.host })
  if (a.kind === 'forbidden') return tr('activity.forbidden', { host: a.host })
  return tr('activity.password')
}

function sitesBox() {
  const rows = [...sites.always.map((s) => ({ host: s, priv: sites.privateAlways.includes(s) })), ...sites.privateAlways.filter((s) => !sites.always.includes(s)).map((s) => ({ host: s, priv: true }))]
  const accessChoice = (value: 'ask' | 'all', label: string, hint: string) =>
    h(
      'label',
      { class: 'choice' },
      h('input', {
        type: 'radio',
        name: 'site-access',
        value,
        'data-testid': `site-access-${value}`,
        checked: sites.siteAccess === value,
        onchange: () => {
          sites = { ...sites, siteAccess: value }
          ui.pane.setSiteAccess(value)
          render()
        },
      }),
      h('span', {}, h('b', {}, label), h('small', {}, hint)),
    )
  return h(
    'section',
    { class: 'sites', 'data-testid': 'sites', 'aria-label': tr('pane.settings') },
    h(
      'fieldset',
      { 'data-testid': 'site-access' },
      h('legend', {}, tr('pane.access')),
      accessChoice('ask', tr('pane.accessAsk'), tr('pane.accessAskHint')),
      accessChoice('all', tr('pane.accessAll'), tr('pane.accessAllHint')),
    ),
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
  activity = addActivity(activity, a, showLog)
  render()
  if (a.notice) {
    setTimeout(() => {
      activity = dismissNotice(activity, a.id)
      render()
    }, NOTICE_MS)
  }
})
ui.pane.onActivityReset(() => {
  activity = emptyActivity()
  render()
})
ui.pane.onSites((s) => {
  sites = s
  render()
})
void ui.pane.state().then((s) => {
  if (s) state = s
  render()
})
void ui.pane.sites().then((s) => {
  if (s) sites = s
  render()
})
onLocaleChange(render)
render()
