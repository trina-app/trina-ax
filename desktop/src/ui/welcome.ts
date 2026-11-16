// The first-run screen (①: one box for an invite link, a team link or a team address, with the remembered teams),
// its two help views (②: no address, ③: no team yet), the one-time question for an address the hosted service does
// not run, screen ④ for a link from outside, and the "cannot reach the team server" screen. docs/DECISIONS.md
// "First run: one box" and "First run, phase 2".
import { UI_LOCALES } from '../common/locales'
import { h, locale, onLocaleChange, tr, ui, type WelcomeState } from './dom'

const root = document.getElementById('root')!
let state: WelcomeState = { mode: 'welcome', teams: [], canGoBack: false, offline: null }
let busy = false
let error = ''
let confirming: string | null = null
/** a question before an address is remembered: the hosted service does not run it (asked once), or the team was
 * renamed at its relay (the new address, `address`, is the one connected to) */
let outside: { kind: 'outside' | 'renamed'; host: string; address: string } | null = null
let draft = ''
/** ① the box, ② no address, ③ no team yet */
let view: 'main' | 'unknown' | 'none' = 'main'
/** a kit build's address is filled in once; after that the field is the person's */
let suggestedUsed = false
function takeState(s: WelcomeState) {
  // ④ appears: an error from before (a refused link, an address that failed) is not about this link
  if (s.link && s.link.id !== state.link?.id) error = ''
  const newLinkError = s.linkError && s.linkError !== state.linkError && !s.link
  // the line was taken back (the team it named left the list): it leaves the screen too, unless something else replaced it
  if (state.linkError && !s.linkError && error === state.linkError) error = ''
  state = s
  // a link from outside that cannot open a team: said on ① (never over ④)
  if (newLinkError) {
    error = s.linkError!
    view = 'main'
  }
  if (s.suggested && !suggestedUsed && !draft) {
    draft = s.suggested
    suggestedUsed = true
  }
}

function render() {
  const focused = document.activeElement?.id
  root.replaceChildren(state.link ? linkAsk(state.link) : state.mode === 'offline' && state.offline ? offline() : view === 'unknown' ? noAddress() : view === 'none' ? noTeam() : welcome())
  if (focused) document.getElementById(focused)?.focus()
}

function show(next: typeof view) {
  view = next
  render()
  // the new view's own first control, so a keyboard user lands on it (Esc goes back)
  document.querySelector<HTMLElement>(next === 'main' ? '#address' : '[data-autofocus]')?.focus()
}

addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key !== 'Escape') return
  if (state.link) {
    void ui.welcome.answerLink(false, state.link.host)
  } else if (outside) {
    outside = null
    render()
    document.getElementById('address')?.focus()
  } else if (view !== 'main') show('main')
  else if (menuFor) closeMenu(true)
  else if (confirming) closeConfirm()
})

/** the remove question closes without removing: the keyboard goes back to that row's "···" */
function closeConfirm() {
  const id = confirming
  confirming = null
  render()
  if (id) document.getElementById(`team-more-${id}`)?.focus()
}

function offline() {
  return h(
    'section',
    { class: 'card', 'data-testid': 'offline', 'aria-labelledby': 'offline-title' },
    h('div', { class: 'brand' }, tr('app.name')),
    h('h1', { id: 'offline-title' }, tr('offline.title')),
    h('p', { class: 'sub' }, tr('offline.body', { address: state.offline!.address })),
    // the app looks again by itself (main/app-window.ts watchOffline) and opens the team when it answers (QA TC-3453)
    state.offline!.auto ? h('p', { class: 'sub', role: 'status', 'data-testid': 'offline-auto' }, tr('offline.auto')) : null,
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'primary', type: 'button', onclick: () => ui.welcome.retry() }, tr('offline.retry')),
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            // the card is left: the app stops looking again by itself (it would open the team under the list)
            ui.welcome.leftOffline()
            state = { ...state, mode: 'welcome' }
            render()
          },
        },
        tr('offline.teams'),
      ),
    ),
  )
}

async function submit(confirmed = false) {
  if (busy) return
  busy = true
  error = ''
  outside = null
  render()
  try {
    const r = await ui.welcome.add(draft, confirmed)
    if (r && !r.ok && r.error === 'confirmOutside') outside = { kind: 'outside', host: r.host ?? '', address: draft }
    else if (r && !r.ok && r.error === 'renamed' && r.next) outside = { kind: 'renamed', host: r.host ?? '', address: r.next }
    else if (r && !r.ok && r.error === 'cancelled') error = ''
    else if (r && !r.ok) error = r.message
    else if (r?.ok) draft = ''
  } catch {
    error = tr('err.unreachable')
  } finally {
    busy = false
    render()
    if (outside) document.getElementById('outside-cancel')?.focus()
  }
}

/** A sleeping free trial team that is starting (QA wake gap 1): a calm wait with a spinner, not an error. The add
 * goes on by itself when the team answers (main/app-window.ts addTeam). */
function waking() {
  return busy && state.waking
    ? h(
        'div',
        { class: 'waking', role: 'status', 'data-testid': 'team-waking' },
        h('p', { class: 'waking-title' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), tr('welcome.waking')),
        h('p', { class: 'waking-detail' }, tr('welcome.wakingDetail')),
        // the wait lasts up to 3 minutes: it can be stopped (on ④ its own Cancel does it)
        state.link ? null : h('button', { type: 'button', class: 'waking-cancel', 'data-testid': 'team-waking-cancel', onclick: () => ui.welcome.cancelWake() }, tr('welcome.cancel')),
      )
    : null
}

function welcome() {
  const input = h('input', {
    id: 'address',
    name: 'address',
    type: 'text',
    inputmode: 'url',
    autocomplete: 'url',
    spellcheck: 'false',
    placeholder: tr('welcome.placeholder'),
    'aria-describedby': state.teams.length ? 'address-error' : 'welcome-sub address-error',
    'aria-invalid': error ? 'true' : undefined,
    value: draft,
    oninput: (e: Event) => {
      draft = (e.target as HTMLInputElement).value
      // a changed address is a new question
      if (outside) {
        outside = null
        render()
      }
    },
  })
  const form = h(
    'form',
    {
      'data-testid': 'add-team',
      onsubmit: (e: Event) => {
        e.preventDefault()
        void submit()
      },
    },
    h('label', { for: 'address', class: 'sr-only' }, tr('welcome.label')),
    h('div', { class: 'field' }, input, h('button', { class: 'primary', type: 'submit', disabled: busy }, busy ? tr('welcome.checking') : tr('welcome.connect'))),
    waking(),
    h('p', { id: 'address-error', class: 'error', role: 'alert', 'data-testid': 'address-error' }, error),
  )
  const helpLinks = h(
    'p',
    { class: 'help-links' },
    h('button', { type: 'button', class: 'link', 'data-testid': 'no-address', onclick: () => show('unknown') }, tr('welcome.noAddress')),
    h('span', { 'aria-hidden': 'true' }, ' · '),
    h('button', { type: 'button', class: 'link', 'data-testid': 'no-team', onclick: () => show('none') }, tr('welcome.noTeam')),
  )
  // the bottom line: [돌아가기] (a quiet link, when a team is open behind this screen) and the language, both small
  const foot = h(
    'div',
    { class: 'foot' },
    state.canGoBack ? h('button', { type: 'button', class: 'link quiet', 'data-testid': 'welcome-back', onclick: () => ui.welcome.back() }, tr('welcome.back')) : h('span'),
    languagePicker(),
  )
  // remembered teams: they come first (the usual thing here is opening one), the box for another address under them
  if (state.teams.length) {
    return h(
      'section',
      { class: 'card', 'aria-label': tr('app.name') },
      h('div', { class: 'brand' }, tr('app.name')),
      teamList(),
      h('h2', { class: 'another', id: 'another-title' }, tr('welcome.another')),
      form,
      outside ? outsideBox(outside) : null,
      helpLinks,
      foot,
    )
  }
  return h(
    'section',
    { class: 'card', 'aria-labelledby': 'welcome-title' },
    h('div', { class: 'brand' }, tr('app.name')),
    h('h1', { id: 'welcome-title' }, tr('welcome.title')),
    h('p', { class: 'sub', id: 'welcome-sub' }, tr('welcome.subtitle')),
    form,
    outside ? outsideBox(outside) : null,
    helpLinks,
    foot,
  )
}

/** The question before an address is remembered: the hosted service does not run it (once), or the team moved to a
 * new address at its relay (that address is shown and connected to). [취소] has the focus. */
function outsideBox(o: { kind: 'outside' | 'renamed'; host: string; address: string }) {
  return h(
    'div',
    { class: 'confirm', role: 'alertdialog', 'aria-labelledby': 'outside-host', 'aria-describedby': 'outside-body', 'data-testid': 'outside-confirm' },
    h('p', { id: 'outside-host', class: 'host' }, o.host),
    h('p', { id: 'outside-body' }, o.kind === 'renamed' ? tr('err.renamed', { host: o.host }) : tr('outside.body')),
    h(
      'div',
      { class: 'row' },
      h('button', { type: 'button', id: 'outside-cancel', onclick: () => { outside = null; render(); document.getElementById('address')?.focus() } }, tr('welcome.cancel')),
      h('button', { type: 'button', class: 'primary', 'data-testid': 'outside-connect', onclick: () => { draft = o.address; void submit(true) } }, tr('outside.connect')),
    ),
  )
}

/**
 * ④ A link from outside (`trina-ax://open?url=…`): "{host}에 연결할까요? 직접 받은 링크가 맞을 때만 연결하세요.", the
 * outside note when the hosted service does not run it, [취소] (focus) [연결]. Nothing was fetched yet; [연결] runs the
 * address check, then opens the link's page (the main process holds the link: this screen only names the host).
 */
/** ④'s [연결] is on only after this long on screen (the main process's LinkGate counts 600 ms from linkShown) */
const LINK_READY_MS = 650
let linkSeen = 0
let linkReady = false
function linkAsk(link: { id: number; host: string; hosted: boolean }) {
  // the yes counts only some time after ④ is on screen (the main process's LinkGate); until then [연결] is off
  if (link.id !== linkSeen) {
    linkSeen = link.id
    linkReady = false
    queueMicrotask(() => ui.welcome.linkShown(link.id))
    setTimeout(() => {
      if (linkSeen !== link.id) return
      linkReady = true
      render()
    }, LINK_READY_MS)
  }
  return h(
    'section',
    { class: 'card', role: 'alertdialog', 'aria-labelledby': 'link-title', 'aria-describedby': 'link-body', 'data-testid': 'link-ask' },
    h('div', { class: 'brand' }, tr('app.name')),
    h('h1', { id: 'link-title', class: 'host-title' }, tr('link.title', { host: link.host })),
    h('p', { class: 'sub', id: 'link-body' }, tr('link.body')),
    link.hosted ? null : h('div', { class: 'confirm', 'data-testid': 'link-outside' }, h('p', {}, tr('outside.body'))),
    waking(),
    h('p', { id: 'address-error', class: 'error', role: 'alert', 'data-testid': 'address-error' }, error),
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'button', id: 'link-cancel', 'data-testid': 'link-cancel', onclick: () => void ui.welcome.answerLink(false, link.host) }, tr('welcome.cancel')),
      h(
        'button',
        {
          type: 'button',
          class: 'primary',
          'data-testid': 'link-connect',
          disabled: busy || !linkReady,
          onclick: async () => {
            if (busy) return
            busy = true
            error = ''
            render()
            try {
              const r = await ui.welcome.answerLink(true, link.host)
              // the team moved at its relay: its new address is asked on ① before anything is remembered
              // Cancel on ④ while the team started: ④'s own no already took the screen back
              if (r && !r.ok && r.error === 'cancelled') return
              if (r && !r.ok && r.error === 'renamed' && r.next) {
                outside = { kind: 'renamed', host: r.host ?? '', address: r.next }
                draft = r.next
                view = 'main'
              } else if (r && !r.ok) {
                error = r.message
                view = 'main'
              }
            } catch {
              error = tr('err.unreachable')
            } finally {
              busy = false
              render()
            }
          },
        },
        busy ? tr('welcome.checking') : tr('outside.connect'),
      ),
    ),
  )
}

/** ② "주소를 모르겠어요": where the address is. */
function noAddress() {
  return h(
    'section',
    { class: 'card', 'aria-labelledby': 'unknown-title', 'data-testid': 'no-address-view' },
    h('div', { class: 'brand' }, tr('app.name')),
    h('h1', { id: 'unknown-title' }, tr('welcome.noAddress')),
    h('ol', { class: 'steps' }, h('li', {}, tr('noAddress.paste')), h('li', {}, tr('noAddress.device')), h('li', {}, tr('noAddress.ask'))),
    h('div', { class: 'actions' }, h('button', { type: 'button', 'data-autofocus': true, 'data-testid': 'view-back', onclick: () => show('main') }, tr('nav.back'))),
  )
}

/** ③ "아직 팀이 없어요": a leader makes the team; members come in with a link. */
function noTeam() {
  return h(
    'section',
    { class: 'card', 'aria-labelledby': 'none-title', 'data-testid': 'no-team-view' },
    h('div', { class: 'brand' }, tr('app.name')),
    h('h1', { id: 'none-title' }, tr('welcome.noTeam')),
    h('p', { class: 'sub' }, tr('noTeam.body')),
    h(
      'div',
      { class: 'actions' },
      state.signup ? h('button', { type: 'button', 'data-autofocus': true, 'data-testid': 'signup', onclick: () => ui.welcome.openLink('signup') }, tr('noTeam.create'), h('span', { class: 'out', 'aria-hidden': 'true' }, ' ↗')) : null,
      h('button', { type: 'button', 'data-autofocus': state.signup ? undefined : true, 'data-testid': 'install-docs', onclick: () => ui.welcome.openLink('docs') }, tr('noTeam.docs'), h('span', { class: 'out', 'aria-hidden': 'true' }, ' ↗')),
    ),
    state.signup ? h('p', { class: 'note' }, tr('noTeam.after')) : null,
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', 'data-testid': 'view-back', onclick: () => show('main') }, tr('noTeam.enter'))),
  )
}

/** The app's own language (before a team page reports its person's language, or to change it here). */
function languagePicker() {
  const select = h(
    'select',
    { id: 'ui-locale', 'data-testid': 'ui-locale', onchange: (e: Event) => ui.setLocale((e.target as HTMLSelectElement).value as typeof locale) },
    ...UI_LOCALES.map((l) => h('option', { value: l.id, lang: l.id, selected: l.id === locale }, l.label)),
  )
  return h('label', { class: 'language', for: 'ui-locale' }, tr('welcome.language'), select)
}

/** a team's address as people read it: without "https://" */
const shortOrigin = (origin: string) => origin.replace(/^https?:\/\//, '')

const SVG = 'http://www.w3.org/2000/svg'
/** a small line icon (lucide's check, ellipsis), drawn in the text colour */
function glyph(kind: 'check' | 'more') {
  const svg = document.createElementNS(SVG, 'svg')
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v)
  const parts = kind === 'check' ? [['path', { d: 'M20 6 9 17l-5-5' }]] : [['circle', { cx: '5', cy: '12', r: '1' }], ['circle', { cx: '12', cy: '12', r: '1' }], ['circle', { cx: '19', cy: '12', r: '1' }]]
  for (const [tag, attrs] of parts as [string, Record<string, string>][]) {
    const el = document.createElementNS(SVG, tag)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    svg.append(el)
  }
  return svg
}

/** the team whose "···" menu is open */
let menuFor: string | null = null
function closeMenu(focusButton: boolean) {
  const id = menuFor
  menuFor = null
  render()
  if (focusButton && id) document.getElementById(`team-more-${id}`)?.focus()
}
addEventListener('mousedown', (e) => {
  if (menuFor && !(e.target as Element).closest?.('.row-menu, .more')) closeMenu(false)
})

/**
 * The remembered teams, as a workspace switcher: one row per team (its initial, its name, its address small under it),
 * the whole row opens the team; the open one has a quiet check and "지금 사용 중" (a click on it goes back to it);
 * "목록에서 지우기" is in the row's "···" menu. The rows take the web app's list row (web/src/components/list/List.tsx
 * ListRow: 15px name, 13px faint meta, 8px rounded hover fill).
 */
function teamList() {
  return h(
    'section',
    { class: 'teams', 'aria-labelledby': 'teams-title' },
    h('h1', { id: 'teams-title' }, tr('welcome.saved')),
    h(
      'ul',
      { 'data-testid': 'team-list' },
      ...state.teams.map((t) =>
        h(
          'li',
          { 'data-testid': 'team', 'data-team-id': t.id, class: menuFor === t.id ? 'menu-open' : undefined },
          h(
            'button',
            {
              class: 'team-row',
              type: 'button',
              id: `team-row-${t.id}`,
              'data-testid': 'team-open',
              'aria-current': t.current ? 'true' : undefined,
              title: t.origin,
              onclick: () => ui.welcome.open(t.id),
            },
            h('span', { class: 'initial', 'aria-hidden': 'true' }, (Array.from(t.label.trim())[0] ?? '?').toLocaleUpperCase()),
            h('span', { class: 'words' }, h('span', { class: 'name' }, t.label), h('span', { class: 'origin' }, shortOrigin(t.origin))),
            t.current ? h('span', { class: 'current', 'data-testid': 'team-current' }, glyph('check'), tr('welcome.current')) : null,
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'more',
              id: `team-more-${t.id}`,
              'aria-label': tr('welcome.more', { team: t.label }),
              title: tr('welcome.more', { team: t.label }),
              'aria-haspopup': 'menu',
              'aria-expanded': menuFor === t.id ? 'true' : 'false',
              onclick: () => {
                if (menuFor === t.id) return closeMenu(true)
                menuFor = t.id
                render()
                document.querySelector<HTMLElement>('.row-menu [role="menuitem"]')?.focus()
              },
            },
            glyph('more'),
          ),
          menuFor === t.id
            ? h(
                'div',
                {
                  class: 'row-menu',
                  role: 'menu',
                  'aria-label': tr('welcome.more', { team: t.label }),
                  onkeydown: (e: Event) => {
                    const k = (e as KeyboardEvent).key
                    if (k === 'Escape') {
                      e.preventDefault()
                      e.stopPropagation()
                      closeMenu(true)
                    } else if (k === 'Tab') {
                      // focus moves on as usual; the menu closes after it
                      menuFor = null
                      setTimeout(() => {
                        const at = document.activeElement?.id
                        render()
                        if (at) document.getElementById(at)?.focus()
                      })
                    }
                  },
                },
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'menuitem',
                    'aria-label': `${tr('welcome.remove')}: ${t.label}`,
                    onclick: () => {
                      menuFor = null
                      confirming = t.id
                      render()
                      document.getElementById('remove-cancel')?.focus()
                    },
                  },
                  tr('welcome.remove'),
                ),
              )
            : null,
        ),
      ),
    ),
    confirming ? confirmBox(confirming) : null,
  )
}

function confirmBox(id: string) {
  const team = state.teams.find((t) => t.id === id)
  if (!team) return null
  return h(
    'div',
    { class: 'confirm', role: 'alertdialog', 'aria-label': tr('welcome.remove'), 'aria-describedby': 'remove-body', 'data-testid': 'remove-confirm' },
    h('p', { id: 'remove-body' }, tr('welcome.removeConfirm', { team: team.label })),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          type: 'button',
          id: 'remove-cancel',
          onclick: closeConfirm,
        },
        tr('welcome.cancel'),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'danger',
          onclick: async () => {
            confirming = null
            await ui.welcome.remove(id)
            // the list comes back without it: the keyboard goes to the first team left, or the box
            ;(document.querySelector<HTMLElement>('.team-row') ?? document.getElementById('address'))?.focus()
          },
        },
        tr('welcome.removeYes'),
      ),
    ),
  )
}

onLocaleChange(render)
ui.welcome.onState((s) => {
  // the screen shown again from the 팀 menu or the host strip: start at the box
  if (s.mode === 'welcome' && state.mode !== 'welcome') view = 'main'
  const asked = !state.link && s.link
  takeState(s)
  render()
  // ④ appeared: the safe answer has the focus
  if (asked) document.getElementById('link-cancel')?.focus()
})
void ui.welcome.state().then((s) => {
  if (s) takeState(s)
  render()
  // no saved team: the box, ready to type in. Saved teams: nothing is focused (no ring on a row the person did not
  // pick); Tab reaches the first row
  if (!state.teams.length) document.getElementById('address')?.focus()
})
render()
