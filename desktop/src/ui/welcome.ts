// First-run "team address" screen, the remembered team list, and the "cannot reach the team server" screen.
import { UI_LOCALES } from '../common/locales'
import { h, locale, onLocaleChange, tr, ui, type WelcomeState } from './dom'

const root = document.getElementById('root')!
let state: WelcomeState = { mode: 'welcome', teams: [], canGoBack: false, offline: null }
let busy = false
let error = ''
let confirming: string | null = null
let draft = ''
/** a kit build's address is filled in once; after that the field is the person's */
let suggestedUsed = false
function takeState(s: WelcomeState) {
  state = s
  if (s.suggested && !suggestedUsed && !draft) {
    draft = s.suggested
    suggestedUsed = true
  }
}

function render() {
  const focusAddress = document.activeElement?.id === 'address'
  root.replaceChildren(state.mode === 'offline' && state.offline ? offline() : welcome())
  if (focusAddress) document.getElementById('address')?.focus()
}

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

function welcome() {
  const input = h('input', {
    id: 'address',
    name: 'address',
    type: 'text',
    inputmode: 'url',
    autocomplete: 'url',
    spellcheck: 'false',
    placeholder: tr('welcome.placeholder'),
    'aria-describedby': 'address-error',
    'aria-invalid': error ? 'true' : undefined,
    value: draft,
    oninput: (e: Event) => {
      draft = (e.target as HTMLInputElement).value
    },
  })
  const form = h(
    'form',
    {
      'data-testid': 'add-team',
      onsubmit: async (e: Event) => {
        e.preventDefault()
        if (busy) return
        busy = true
        error = ''
        render()
        try {
          const r = await ui.welcome.add(draft)
          if (r && !r.ok) error = r.message
          else if (r?.ok) draft = ''
        } catch {
          error = tr('err.unreachable')
        } finally {
          busy = false
          render()
        }
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
    h('p', { class: 'sub' }, tr('welcome.subtitle')),
    form,
    state.teams.length ? teamList() : null,
    state.canGoBack ? h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => ui.welcome.back() }, tr('welcome.back'))) : null,
    languagePicker(),
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
  takeState(s)
  render()
})
void ui.welcome.state().then((s) => {
  if (s) takeState(s)
  render()
  document.getElementById('address')?.focus()
})
render()
