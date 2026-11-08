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
/** the address answered but the hosted service does not run it: ask once before it is remembered */
let outside: { host: string; address: string } | null = null
let draft = ''
/** ① the box, ② no address, ③ no team yet */
let view: 'main' | 'unknown' | 'none' = 'main'
/** a kit build's address is filled in once; after that the field is the person's */
let suggestedUsed = false
function takeState(s: WelcomeState) {
  state = s
  // a link from outside that cannot open a team: said once, on ①
  if (s.linkError) {
    error = s.linkError
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
})

function offline() {
  return h(
    'section',
    { class: 'card', 'data-testid': 'offline', 'aria-labelledby': 'offline-title' },
    h('div', { class: 'brand' }, tr('app.name')),
    h('h1', { id: 'offline-title' }, tr('offline.title')),
    h('p', { class: 'sub' }, tr('offline.body', { address: state.offline!.address })),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'primary', type: 'button', onclick: () => ui.welcome.retry() }, tr('offline.retry')),
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
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
    if (r && !r.ok && r.error === 'confirmOutside') outside = { host: r.host ?? '', address: draft }
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

function welcome() {
  const input = h('input', {
    id: 'address',
    name: 'address',
    type: 'text',
    inputmode: 'url',
    autocomplete: 'url',
    spellcheck: 'false',
    placeholder: tr('welcome.placeholder'),
    'aria-describedby': 'welcome-sub address-error',
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
    h('p', { id: 'address-error', class: 'error', role: 'alert', 'data-testid': 'address-error' }, error),
  )
  return h(
    'section',
    { class: 'card', 'aria-labelledby': 'welcome-title' },
    h('div', { class: 'brand' }, tr('app.name')),
    h('h1', { id: 'welcome-title' }, tr('welcome.title')),
    h('p', { class: 'sub', id: 'welcome-sub' }, tr('welcome.subtitle')),
    form,
    outside ? outsideBox(outside) : null,
    h(
      'p',
      { class: 'help-links' },
      h('button', { type: 'button', class: 'link', 'data-testid': 'no-address', onclick: () => show('unknown') }, tr('welcome.noAddress')),
      h('span', { 'aria-hidden': 'true' }, ' · '),
      h('button', { type: 'button', class: 'link', 'data-testid': 'no-team', onclick: () => show('none') }, tr('welcome.noTeam')),
    ),
    state.teams.length ? teamList() : null,
    state.canGoBack ? h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => ui.welcome.back() }, tr('welcome.back'))) : null,
    languagePicker(),
  )
}

/** The one-time question before an address the hosted service does not run is remembered. [취소] has the focus. */
function outsideBox(o: { host: string; address: string }) {
  return h(
    'div',
    { class: 'confirm', role: 'alertdialog', 'aria-labelledby': 'outside-host', 'aria-describedby': 'outside-body', 'data-testid': 'outside-confirm' },
    h('p', { id: 'outside-host', class: 'host' }, o.host),
    h('p', { id: 'outside-body' }, tr('outside.body')),
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
function linkAsk(link: { host: string; hosted: boolean }) {
  return h(
    'section',
    { class: 'card', role: 'alertdialog', 'aria-labelledby': 'link-title', 'aria-describedby': 'link-body', 'data-testid': 'link-ask' },
    h('div', { class: 'brand' }, tr('app.name')),
    h('h1', { id: 'link-title', class: 'host-title' }, tr('link.title', { host: link.host })),
    h('p', { class: 'sub', id: 'link-body' }, tr('link.body')),
    link.hosted ? null : h('div', { class: 'confirm', 'data-testid': 'link-outside' }, h('p', {}, tr('outside.body'))),
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
          disabled: busy,
          onclick: async () => {
            if (busy) return
            busy = true
            error = ''
            render()
            try {
              const r = await ui.welcome.answerLink(true, link.host)
              if (r && !r.ok) {
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

function teamList() {
  return h(
    'section',
    { class: 'teams', 'aria-labelledby': 'teams-title' },
    h('h2', { id: 'teams-title' }, tr('welcome.saved')),
    h(
      'ul',
      { 'data-testid': 'team-list' },
      ...state.teams.map((t) =>
        h(
          'li',
          { 'data-testid': 'team', 'data-team-id': t.id },
          h(
            'button',
            { class: 'open', type: 'button', 'aria-label': `${tr('welcome.open')}: ${t.label}`, onclick: () => ui.welcome.open(t.id) },
            t.label,
            h('span', { class: 'origin' }, t.origin),
          ),
          t.current ? h('span', { class: 'tag' }, tr('welcome.current')) : null,
          h(
            'button',
            {
              type: 'button',
              class: 'danger',
              'aria-label': `${tr('welcome.remove')}: ${t.label}`,
              onclick: () => {
                confirming = t.id
                render()
              },
            },
            tr('welcome.remove'),
          ),
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
    { class: 'confirm', role: 'alertdialog', 'aria-label': tr('welcome.remove'), 'data-testid': 'remove-confirm' },
    h('p', {}, tr('welcome.removeConfirm', { team: team.label })),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          type: 'button',
          class: 'danger',
          onclick: async () => {
            confirming = null
            await ui.welcome.remove(id)
          },
        },
        tr('welcome.removeYes'),
      ),
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            confirming = null
            render()
          },
        },
        tr('welcome.cancel'),
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
  document.getElementById('address')?.focus()
})
render()
