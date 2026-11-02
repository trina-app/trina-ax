// The PC runner's bar under the team page: the question the person answers (one at a time), the "AI is using this PC" line
// with a stop button, the dev servers running, and the run log. A view of its own, not part of the team page: the page
// can send a call but cannot answer here (docs/DECISIONS.md "PC runner"). A button takes a moment to work after a question
// appears, so a click meant for the chat does not land on it.
import { h, locale, onLocaleChange, tr, ui, type PcPrompt, type PcState } from './dom'

const ARM_MS = 600

const root = document.getElementById('root')!
let state: PcState = { prompts: [], running: [], background: [], allowedChats: 0, log: [], logOpen: false }
let armedFor = ''
let armTimer: ReturnType<typeof setTimeout> | undefined

function promptCard(p: PcPrompt, armed: boolean) {
  const button = (label: string, value: string, cls: string, testId: string) => h('button', { type: 'button', class: cls, 'data-testid': testId, disabled: !armed, onclick: () => ui.pc.answer(p.id, value) }, label)
  if (p.kind === 'folder') {
    return h(
      'section',
      { class: 'prompt', role: 'alertdialog', 'aria-labelledby': `p-${p.id}`, 'data-testid': 'pc-prompt', 'data-kind': 'folder' },
      h('h2', { id: `p-${p.id}` }, tr('pc.folder.title')),
      h('p', {}, tr('pc.folder.body', { project: p.project })),
      p.problem ? h('p', { class: 'warn', 'data-testid': 'pc-folder-problem' }, tr(p.problem === 'system' ? 'pc.folder.system' : 'pc.folder.wide')) : null,
      h('div', { class: 'actions' }, button(tr('pc.folder.pick'), 'once', 'primary', 'pc-folder-pick'), button(tr('pc.deny'), 'deny', 'danger', 'pc-deny')),
    )
  }
  return h(
    'section',
    { class: `prompt${p.grants.login || p.grants.secretFiles ? ' private' : ''}`, role: 'alertdialog', 'aria-labelledby': `p-${p.id}`, 'data-testid': 'pc-prompt', 'data-kind': 'call', 'data-tool': p.tool },
    h('h2', { id: `p-${p.id}` }, tr(`pc.tool.${p.tool}`)),
    h('p', { class: 'where' }, `${p.project} · ${p.folder}${p.cwd ? `/${p.cwd}` : ''}`),
    p.grants.login ? h('p', { class: 'warn', 'data-testid': 'pc-warn-login' }, tr('pc.warn.login')) : null,
    p.grants.secretFiles ? h('p', { class: 'warn', 'data-testid': 'pc-warn-secret' }, tr('pc.warn.secret')) : null,
    h('pre', { class: 'command', 'data-testid': 'pc-text' }, p.text),
    p.detail ? h('pre', { class: 'command detail', 'data-testid': 'pc-detail' }, p.detail) : null,
    h(
      'div',
      { class: 'actions' },
      button(tr('pc.once'), 'once', 'primary', 'pc-once'),
      p.always ? null : button(tr('pc.chat'), 'chat', '', 'pc-chat'),
      button(tr('pc.deny'), 'deny', 'danger', 'pc-deny'),
    ),
  )
}

function logBox() {
  const time = (at: number) => new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return h(
    'section',
    { class: 'log', 'data-testid': 'pc-log', 'aria-label': tr('pc.log') },
    h('strong', {}, tr('pc.log')),
    state.log.length
      ? h('ol', {}, ...state.log.map((e) => h('li', { 'data-outcome': e.outcome }, h('time', {}, time(e.at)), h('span', { class: 'what' }, `${tr(`pc.tool.${e.tool}`)} · ${e.text}`), h('span', { class: 'outcome' }, tr(`pc.outcome.${e.outcome}`)))))
      : h('p', {}, tr('pc.logNone')),
  )
}

function render() {
  const p = state.prompts[0]
  if (p && armedFor !== p.id) {
    armedFor = p.id
    clearTimeout(armTimer)
    armTimer = setTimeout(() => {
      armTimer = undefined
      render()
    }, ARM_MS)
  }
  const armed = !!p && armedFor === p.id && armTimer === undefined
  const using = state.running[0]
  const bar = h(
    'div',
    { class: 'bar', role: 'status', 'data-testid': 'pc-bar' },
    using ? h('span', { class: 'dot', 'aria-hidden': 'true' }) : null,
    h('span', { class: 'line', 'data-testid': 'pc-line' }, using ? tr('pc.using') : state.allowedChats ? tr('pc.allowed') : tr('pc.idle')),
    using ? h('span', { class: 'last', title: using.text }, using.text) : null,
    h('span', { class: 'spacer' }),
    state.allowedChats ? h('button', { type: 'button', 'data-testid': 'pc-revoke', onclick: () => ui.pc.revokeChats() }, tr('pc.revoke')) : null,
    h('button', { type: 'button', 'data-testid': 'pc-log-button', 'aria-expanded': state.logOpen ? 'true' : 'false', onclick: () => ui.pc.toggleLog() }, tr('pc.log')),
    using || state.background.length || p ? h('button', { type: 'button', class: 'danger', 'data-testid': 'pc-stop', onclick: () => ui.pc.stop() }, tr('pc.stop')) : null,
  )
  const background = state.background.map((b) =>
    h(
      'div',
      { class: 'bg', 'data-testid': 'pc-background' },
      h('span', { class: 'line' }, `${tr('pc.background')} · ${b.text}`),
      b.port ? h('button', { type: 'button', 'data-testid': 'pc-preview', onclick: () => ui.pc.openPreview(b.id) }, tr('pc.preview', { port: String(b.port) })) : null,
    ),
  )
  root.replaceChildren(...[p ? promptCard(p, armed) : null, bar, ...background, state.logOpen ? logBox() : null].filter((x): x is HTMLElement => !!x))
  ui.pc.height(root.getBoundingClientRect().height)
}

new ResizeObserver(() => ui.pc.height(root.getBoundingClientRect().height)).observe(root)
ui.pc.onState((s) => {
  state = s
  render()
})
onLocaleChange(render)
void ui.pc.state().then((s) => {
  if (s) state = s
  render()
})
