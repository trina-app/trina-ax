// The first-run screen: S0 (the remembered teams, then "Create a team for free" and "Join with an invite link", and
// "Just look around first"), S1 = ① (one box for an invite link, a team link or a team address) with its help view
// (②: no address), the create screens (S2 sign in, S3 name your team, S4 starting, and the state lines: ./create.ts),
// the one-time question for an address the hosted service does not run, screen ④ for a link from outside, and the
// "cannot reach the team server" screen. docs/DECISIONS.md "First run: one box" and "First run, phase 2";
// docs/decisions/20261126-desktop-create-team.md. A console without the create flow (an older hosting service), and
// the Mac App Store build, keep ① as the first screen.
import { UI_LOCALES } from '../common/locales'
import { h, locale, onLocaleChange, tr, ui, type WelcomeState } from './dom'
import { createScreen, focusCreate } from './create'

const root = document.getElementById('root')!
let state: WelcomeState = { mode: 'welcome', teams: [], canGoBack: false, offline: null, offer: 'checking' }
let busy = false
let error = ''
let confirming: string | null = null
/** a question before an address is remembered: the hosted service does not run it (asked once), or the team was
 * renamed at its relay (the new address, `address`, is the one connected to) */
let outside: { kind: 'outside' | 'renamed'; host: string; address: string } | null = null
let draft = ''
/** S0 the first screen, S1 = ① the box, ② no address */
let view: 'start' | 'join' | 'unknown' = 'start'
/** S0 has the two rows: the console offers the create flow, and this is not the Mac App Store build */
const rows = () => state.offer === 'yes' && !state.store
const creating = () => !!state.create && state.create.screen !== 'off'
/** a create screen and its step: the keyboard moves when it changes */
const createKey = (c: WelcomeState['create']) => (c ? `${c.screen}:${c.screen === 'signin' ? c.step : ''}` : '')
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
    view = 'join'
  }
  // a kit build for one team: its box, with the address filled in
  if (s.suggested && !suggestedUsed && !draft) {
    draft = s.suggested
    suggestedUsed = true
    view = 'join'
  }
}

function render() {
  const focused = document.activeElement?.id
  root.replaceChildren(
    state.link ? linkAsk(state.link)
    : state.mode === 'offline' && state.offline ? offline()
    : creating() ? createScreen(state.create!, { store: state.store === true, teams: state.teams.length > 0, rerender: render })
    : view === 'unknown' ? noAddress()
    : view === 'join' || !rows() ? (state.offer === 'checking' && view !== 'join' ? checking() : welcome())
    : start(),
  )
  if (focused) document.getElementById(focused)?.focus()
}

function show(next: typeof view) {
  view = next
  render()
  // the new view's own first control, so a keyboard user lands on it (Esc goes back)
  document.querySelector<HTMLElement>(next === 'unknown' ? '[data-autofocus]' : next === 'start' && rows() ? '#create-team' : '#address')?.focus()
}

addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key !== 'Escape') return
  if (state.link) {
    void ui.welcome.answerLink(false, state.link.host)
  } else if (creating()) {
    ui.create.cancel()
  } else if (outside) {
    outside = null
    render()
    document.getElementById('address')?.focus()
  } else if (view === 'unknown') show('join')
  else if (view === 'join' && rows()) show('start')
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
  // the help view: a quiet text button (muted, no underline, a hover fill like the team rows), never an orange link;
  // its text lines up with the box above (the button's own inset reaches out past the card's text column). Next to it,
  // on S1, Back to S0; where ① is the first screen, the demo link (and in the Mac App Store build, its sign-in)
  const helpLinks = h(
    'div',
    { class: 'help-links' },
    h('button', { type: 'button', class: 'ghost', 'data-testid': 'no-address', onclick: () => show('unknown') }, tr('welcome.noAddress')),
    rows() ? h('button', { type: 'button', class: 'ghost', 'data-testid': 'join-back', onclick: () => show('start') }, tr('nav.back')) : demoLink(),
    // a hosting console without the create flow (GET /me 404): still a way to make a team, on its website (never in the
    // Mac App Store build: no sign-up or plans there)
    state.offer === 'no' && !state.store
      ? h('button', { type: 'button', class: 'ghost', 'data-testid': 'signup-web', onclick: () => ui.welcome.openLink('console') }, tr('start.signupWeb'), h('span', { class: 'out', 'aria-hidden': 'true' }, ' ↗'))
      : null,
  )
  const storeSignIn = state.store && state.offer === 'yes'
    ? h('p', { class: 'store-signin', 'data-testid': 'store-signin' }, tr('start.storeAsk'), ' ', h('button', { type: 'button', class: 'inline', 'data-testid': 'store-signin-button', onclick: () => ui.create.signIn() }, tr('start.signIn')))
    : null
  const foot = footLine()
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
      storeSignIn,
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
    storeSignIn,
    helpLinks,
    foot,
  )
}

/** the bottom line: [돌아가기] (the same quiet button, when a team is open behind this screen) and the language */
function footLine() {
  return h(
    'div',
    { class: 'foot' },
    state.canGoBack ? h('button', { type: 'button', class: 'ghost', 'data-testid': 'welcome-back', onclick: () => ui.welcome.back() }, tr('welcome.back')) : h('span'),
    languagePicker(),
  )
}

/** "Just look around first": the demo team in the browser (the address is the app's own) */
const demoLink = () => h('button', { type: 'button', class: 'ghost', 'data-testid': 'demo', onclick: () => ui.welcome.openLink('demo') }, tr('start.demo'), h('span', { class: 'out', 'aria-hidden': 'true' }, ' ↗'))

/** before the console answered whether it offers the create flow (a moment): the card, nothing to press yet */
function checking() {
  return h('section', { class: 'card', 'aria-busy': 'true', 'data-testid': 'welcome-checking' }, h('div', { class: 'brand' }, tr('app.name')))
}

/**
 * one of S0's actions: a list row with its own voice, so it never reads as one more team: a bare line icon (Create's
 * "+" keeps the accent tile, the screen's one accent), a 14px title, a faint chevron at the right (the demo opens
 * outside: an arrow). `lead`: the first run's Create, outlined (nothing above it to open). `quiet`: the demo, muted.
 */
function actionRow(o: { id: string; icon: 'plus' | 'link' | 'compass'; title: string; sub?: string; lead?: boolean; quiet?: boolean; out?: boolean; onclick: () => void }) {
  return h(
    'button',
    { type: 'button', class: `action-row icon-${o.icon}${o.lead ? ' lead' : ''}${o.quiet ? ' quiet' : ''}`, id: o.id, 'data-testid': o.id, onclick: o.onclick },
    h('span', { class: 'tile', 'aria-hidden': 'true' }, glyph(o.icon)),
    h('span', { class: 'words' }, h('span', { class: 'name' }, o.title), o.sub ? h('span', { class: 'sub-line' }, o.sub) : null),
    h('span', { class: 'go', 'aria-hidden': 'true' }, glyph(o.out ? 'external' : 'chevron')),
  )
}

/**
 * S0: the remembered teams first (opening one is the usual thing here), then, under a hairline, the actions as one
 * short list: "Create a team for free" (its "+" tile is the screen's one accent), "Join with an invite link" (S1, the
 * box) and "Just look around first" (the demo, muted), then the foot line (Back, the language). On the first run Create
 * leads (outlined, with its short line); with teams listed the short line is left out
 * (docs/AGENTS/plan/20261127-1053-team-picker-polish-2.md, after docs/AGENTS/plan/20261127-1028-team-picker-actions-redesign.md).
 */
function start() {
  const first = !state.teams.length
  return h(
    'section',
    { class: 'card', 'aria-labelledby': first ? 'start-title' : 'teams-title', 'data-testid': 'start' },
    h('div', { class: 'brand' }, tr('app.name')),
    first ? h('h1', { id: 'start-title' }, tr('start.title')) : teamList(),
    h(
      'div',
      { class: first ? 'action-rows' : 'action-rows after-teams' },
      actionRow({ id: 'create-team', icon: 'plus', title: tr('start.create'), sub: first ? tr('start.createSub') : undefined, lead: first, onclick: () => ui.create.start() }),
      actionRow({ id: 'join-team', icon: 'link', title: tr('start.join'), onclick: () => show('join') }),
      actionRow({ id: 'demo', icon: 'compass', title: tr('start.demo'), quiet: true, out: true, onclick: () => ui.welcome.openLink('demo') }),
    ),
    footLine(),
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
                view = 'join'
              } else if (r && !r.ok) {
                error = r.message
                view = 'join'
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
    h('div', { class: 'actions' }, h('button', { type: 'button', 'data-autofocus': true, 'data-testid': 'view-back', onclick: () => show('join') }, tr('nav.back'))),
  )
}

/** The app's own language (before a team page reports its person's language, or to change it here). */
function languagePicker() {
  const select = h(
    'select',
    { id: 'ui-locale', 'data-testid': 'ui-locale', onchange: (e: Event) => ui.setLocale((e.target as HTMLSelectElement).value as typeof locale) },
    ...UI_LOCALES.map((l) => h('option', { value: l.id, lang: l.id, selected: l.id === locale }, l.label)),
  )
  // compact: a globe (read in any language) and the select; the word "Language" is its name for screen readers
  return h('label', { class: 'language', for: 'ui-locale', title: tr('welcome.language') }, glyph('globe', 14), h('span', { class: 'sr-only' }, tr('welcome.language')), select)
}

/** a team's address as people read it: without "https://" */
const shortOrigin = (origin: string) => origin.replace(/^https?:\/\//, '')

const SVG = 'http://www.w3.org/2000/svg'
/** small line icons (lucide's check, ellipsis, plus, link, globe, compass, chevron-right, arrow-up-right), drawn in the text colour */
const GLYPHS: Record<'check' | 'more' | 'plus' | 'link' | 'globe' | 'compass' | 'chevron' | 'external', [string, Record<string, string>][]> = {
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  more: [['circle', { cx: '5', cy: '12', r: '1' }], ['circle', { cx: '12', cy: '12', r: '1' }], ['circle', { cx: '19', cy: '12', r: '1' }]],
  plus: [['path', { d: 'M5 12h14' }], ['path', { d: 'M12 5v14' }]],
  link: [['path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }], ['path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }]],
  globe: [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' }], ['path', { d: 'M2 12h20' }]],
  compass: [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'm16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36z' }]],
  chevron: [['path', { d: 'm9 18 6-6-6-6' }]],
  external: [['path', { d: 'M7 7h10v10' }], ['path', { d: 'M7 17 17 7' }]],
}
function glyph(kind: keyof typeof GLYPHS, size = 16) {
  const svg = document.createElementNS(SVG, 'svg')
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v)
  for (const [tag, attrs] of GLYPHS[kind]) {
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
 * the whole row opens the team and every other team shows an outlined "열기" on hover or keyboard focus (always on a
 * touch screen); the open one has a quiet check and
 * "지금 사용 중" (a click on it goes back to it);
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
              // another team: "Open {team}", its address read after it; the open team: its name, address and "Current"
              'aria-label': t.current ? undefined : tr('welcome.openTeam', { team: t.label }),
              'aria-describedby': t.current ? undefined : `team-origin-${t.id}`,
              title: t.origin,
              onclick: () => ui.welcome.open(t.id),
            },
            h('span', { class: 'initial', 'aria-hidden': 'true' }, (Array.from(t.label.trim())[0] ?? '?').toLocaleUpperCase()),
            h('span', { class: 'words' }, h('span', { class: 'name' }, t.label), h('span', { class: 'origin', id: `team-origin-${t.id}` }, shortOrigin(t.origin))),
            // the open team: a quiet check; every other team: a visible "Open" (user feedback: a row did not say a
            // click opens it), drawn as the plain outlined button, never the orange one Continue uses. It is part of
            // the row's one button, so the whole row still opens the team with one tab stop.
            t.current
              ? h('span', { class: 'current', 'data-testid': 'team-current' }, glyph('check'), tr('welcome.current'))
              : h('span', { class: 'open-pill', 'data-testid': 'team-open-pill', 'aria-hidden': 'true' }, tr('welcome.open')),
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
  // the screen shown again from the 팀 menu or the host strip: start at the first screen
  if (s.mode === 'welcome' && state.mode !== 'welcome') view = 'start'
  const asked = !state.link && s.link
  const screen = createKey(state.create)
  const offerBefore = state.offer
  takeState(s)
  render()
  // a create screen came or changed: the keyboard goes to its first control
  if (s.create && createKey(s.create) !== screen) focusCreate(s.create)
  // S0's rows appeared after the console answered: the keyboard to "Create a team for free" when nothing has it
  else if (offerBefore === 'checking' && rows() && !creating() && view === 'start' && !state.teams.length && document.activeElement === document.body) document.getElementById('create-team')?.focus()
  else if (offerBefore === 'checking' && !rows() && !creating() && !state.teams.length && document.activeElement === document.body) document.getElementById('address')?.focus()
  // ④ appeared: the safe answer has the focus
  if (asked) document.getElementById('link-cancel')?.focus()
})
void ui.welcome.state().then((s) => {
  if (s) takeState(s)
  render()
  // no saved team: the box (or S0's create row), ready to use. Saved teams: nothing is focused (no ring on a row the
  // person did not pick); Tab reaches the first row
  if (creating()) focusCreate(state.create!)
  else if (!state.teams.length) document.getElementById(rows() && view === 'start' ? 'create-team' : 'address')?.focus()
})
render()
