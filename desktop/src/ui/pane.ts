// Browser pane toolbar: tabs, address bar, the AI-control row while the AI uses the browser (a pulsing dot, "Trina is
// using the browser", the AI's latest action and a Stop button, with a thin accent line over the page; docs/DECISIONS.md
// "AI가 브라우저를 쓰는 동안"), the person's permission question (once / always / deny; one at a time), the activity log
// (everything the AI did or the browser refused, opened from the toolbar), at most one line over the page for what needs
// the person now (common/pane-activity.ts), and the settings panel (site access: ask / allow all websites, and the
// sites allowed always; the same value as the team page's Settings > Browser, and "allow all" is off when the team
// turned that choice off). The page itself is a separate view placed under this toolbar by the main process; until its
// first page is drawn this view shows the theme's own surface there (a loading line while a page loads). The edge
// handle on the left (the strip this view reaches over the team page's edge) resizes the browser like the web app's
// PanelDivider: drag, arrow keys when focused, double-click resets (docs/DECISIONS.md "브라우저 너비는 끌어서").
import type { DesktopPaneState } from '@mycel/shared'
import { browserAction } from '../common/browser-action'
import { addActivity, dismissNotice, drivingLine, emptyActivity, markSeen, type ActivityView } from '../common/pane-activity'
import { isBlankPage } from '../common/net-policy'
import { h, locale, onLocaleChange, tr, ui, type PaneActivity, type PanePrompt, type PaneWidth, type SiteSettings } from './dom'

/** the line over the page goes away by itself after this long */
const NOTICE_MS = 20_000

/** a press on the edge is a click until the pointer has gone this far */
const DRAG_SLOP = 3
const EDGE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End'])

const root = document.getElementById('root')!
/** the edge handle and the pane's own box stay in the page across renders (a re-render must not end a drag) */
const edge = h('div', { id: 'pane-edge', class: 'edge', role: 'separator', 'aria-orientation': 'vertical', tabindex: '0', 'data-testid': 'pane-divider' })
const main = h('div', { id: 'main' })
root.replaceChildren(edge, main)
let width: PaneWidth = { now: 0, min: 0, max: 0, grab: 6 }
let state: DesktopPaneState = { open: false, tabs: [], driving: false }
let prompts: PanePrompt[] = []
let activity: ActivityView = emptyActivity()
let showLog = false
let showSites = false
let sites: SiteSettings = { always: [], privateAlways: [], siteAccess: 'ask', teamAllowsAll: true }
/** when the current AI call started (the bar shows only what the AI did since) */
let drivingSince = 0
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
  const lastAction = state.driving ? drivingLine(activity, drivingSince) : null
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
          h('button', { class: 'title', type: 'button', role: 'tab', 'aria-selected': t.active ? 'true' : 'false', title: t.url, onclick: () => ui.pane.select(t.tabId) }, t.popup ? `${tr('pane.popup')}: ${t.title || t.url}` : tabLabel(t)),
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
      h('span', { class: 'label' }, tr('pane.driving')),
      // the AI's own latest action in this call, in place of a banner per action (never a refusal or an old entry)
      lastAction ? h('span', { class: 'last', 'data-testid': 'driving-last', title: activityText(lastAction) }, activityText(lastAction)) : null,
      h('button', { type: 'button', class: 'stop', 'data-testid': 'stop', onclick: () => ui.pane.stop() }, h('span', { class: 'stop-mark', 'aria-hidden': 'true' }), tr('pane.stop')),
    ),
    prompts[0] ? promptCard(prompts[0], prompts.length - 1) : null,
    activity.notice ? noticeLine(activity.notice) : null,
    showLog ? logBox() : null,
    showSites ? sitesBox() : null,
  )
  // under the toolbar, where the page goes: seen until the tab's first page is drawn (the main process shows the tab
  // only then). A page on its way: a quiet loading line; no tab and the AI not at work: what the pane is for.
  const loading = Boolean(tab?.loading)
  const stage = h(
    'div',
    { class: 'stage', 'data-testid': 'pane-stage' },
    loading
      ? h('p', { class: 'loading', role: 'status', 'data-testid': 'pane-loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), tr('pane.loading'))
      : !state.tabs.length && !state.driving
        ? h('p', { class: 'empty' }, tr('pane.empty'))
        : null,
  )
  edge.setAttribute('aria-label', tr('pane.resize'))
  main.replaceChildren(toolbar, stage)
  if (hadFocus && hadFocus !== edge.id) document.getElementById(hadFocus)?.focus()
  observer.disconnect()
  observer.observe(toolbar)
  ui.pane.toolbarHeight(toolbar.getBoundingClientRect().height)
}

/** a tab's name: its page's title, else its address; an empty tab (about:blank, also its title) is "New tab" */
function tabLabel(t: DesktopPaneState['tabs'][number]): string {
  if (isBlankPage(t.url) && (!t.title || isBlankPage(t.title))) return tr('pane.newTab')
  return t.title || t.url
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
  const time = (at: number) => new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return h(
    'section',
    { class: 'log', 'data-testid': 'activity', 'aria-label': tr('pane.activity') },
    h('strong', {}, tr('pane.activity')),
    activity.log.length
      ? h(
          'ol',
          {},
          ...activity.log.map((a) =>
            h('li', { 'data-kind': a.kind }, h('time', {}, time(a.at)), h('span', {}, activityText(a)), a.count && a.count > 1 ? h('span', { class: 'count', 'data-testid': 'activity-repeat' }, `×${a.count}`) : null),
          ),
        )
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
    // what the AI does there in plain words (the step's words), not the tool's name such as preview_start
    h('p', { class: 'url', 'data-testid': 'prompt-action' }, `${browserAction(p.tool, locale)} · ${p.url}`),
    // the third site question in a row (common/site-permissions.ts RepeatPromptHint): where the setting is
    p.hint && !isPrivate
      ? h(
          'p',
          { class: 'hint', 'data-testid': 'prompt-hint' },
          h('span', {}, tr(sites.teamAllowsAll ? 'perm.hint.all' : 'perm.hint.always')),
          sites.teamAllowsAll ? h('button', { type: 'button', class: 'link', 'data-testid': 'prompt-hint-settings', onclick: () => void toggleSites(true) }, tr('perm.hint.open')) : null,
        )
      : null,
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
  if (a.kind === 'payment') return tr('activity.payment')
  return tr('activity.password')
}

function sitesBox() {
  const rows = [...sites.always.map((s) => ({ host: s, priv: sites.privateAlways.includes(s) })), ...sites.privateAlways.filter((s) => !sites.always.includes(s)).map((s) => ({ host: s, priv: true }))]
  const accessChoice = (value: 'ask' | 'all', label: string, hint: string, disabled = false) =>
    h(
      'label',
      { class: `choice${disabled ? ' disabled' : ''}` },
      h('input', {
        type: 'radio',
        name: 'site-access',
        value,
        'data-testid': `site-access-${value}`,
        checked: sites.siteAccess === value,
        disabled,
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
      accessChoice('all', tr('pane.accessAll'), tr('pane.accessAllHint'), !sites.teamAllowsAll),
      sites.teamAllowsAll ? null : h('p', { class: 'policy', 'data-testid': 'site-access-policy' }, tr('pane.accessAllOff')),
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

// ---------------------------------------------------------------- the edge handle

function applyWidth(w: PaneWidth) {
  width = w
  document.documentElement.style.setProperty('--grab', `${w.grab}px`)
  edge.hidden = w.grab <= 0
  edge.setAttribute('aria-valuenow', String(w.now))
  edge.setAttribute('aria-valuemin', String(w.min))
  edge.setAttribute('aria-valuemax', String(w.max))
}

/** a drag of the edge: where it started (screen x), how far the pointer is from the edge, whether it has moved */
let drag: { x: number; offset: number; moved: boolean } | null = null
let frame = 0
let pendingEdge: number | null = null

edge.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  // the toolbar's own focused element (the address bar) keeps the focus: a press here only resizes
  e.preventDefault()
  edge.setPointerCapture(e.pointerId)
  // the edge is where the toolbar's box begins (x = grab in this view): keep the pointer's distance to it
  drag = { x: e.screenX, offset: width.grab - e.clientX, moved: false }
  edge.dataset.dragging = ''
  ui.pane.drag('start')
})
edge.addEventListener('pointermove', (e) => {
  const d = drag
  if (!d) return
  if (!d.moved && Math.abs(e.screenX - d.x) < DRAG_SLOP) return
  d.moved = true
  // screen coordinates: this view moves under the pointer while the main process lays the views out again
  pendingEdge = e.screenX + d.offset
  if (!frame) {
    frame = requestAnimationFrame(() => {
      frame = 0
      if (pendingEdge !== null) ui.pane.drag('move', pendingEdge)
      pendingEdge = null
    })
  }
})
/** pointerup: the edge goes where the pointer is; a cancel or a lost capture keeps the last width shown. Either way the
 * main process remembers it and gives the keyboard back where it was before the press. */
function endDrag(up: PointerEvent | null) {
  const d = drag
  if (!d) return
  drag = null
  cancelAnimationFrame(frame)
  frame = 0
  const last = up && d.moved ? up.screenX + d.offset : d.moved ? pendingEdge : null
  pendingEdge = null
  if (last !== null) ui.pane.drag('move', last)
  delete edge.dataset.dragging
  ui.pane.drag('end')
}
edge.addEventListener('pointerup', (e) => {
  endDrag(e)
  if (edge.hasPointerCapture(e.pointerId)) edge.releasePointerCapture(e.pointerId)
})
edge.addEventListener('pointercancel', () => endDrag(null))
edge.addEventListener('lostpointercapture', () => endDrag(null))
edge.addEventListener('dblclick', () => ui.pane.drag('reset'))
edge.addEventListener('keydown', (e) => {
  if (!EDGE_KEYS.has(e.key)) return
  e.preventDefault()
  ui.pane.resizeKey(e.key, e.shiftKey)
})
ui.pane.onWidth(applyWidth)
void ui.pane.width().then((w) => {
  if (w) applyWidth(w)
})

const observer = new ResizeObserver((entries) => {
  for (const e of entries) ui.pane.toolbarHeight((e.target as HTMLElement).getBoundingClientRect().height)
})

ui.pane.onState((s) => {
  if (s.driving && !state.driving) drivingSince = Date.now()
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
