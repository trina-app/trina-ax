// The strip above the team's sign-in pages: the team address the app connected to (punycode, with its port), drawn by
// the app because a page can draw anything, and [다른 팀] back to the first-run screen. While Find work files reads the
// files the person added, the same strip says "Trina is reading N files from this computer" (no click, it goes by itself). Shown by AppWindow.layout()
// on the sign-in pages (/login, /invite/…, /join, /setup, /reset-password/…) and on every page until the team answered
// GET /api/me for a signed-in person (shared/src/team-link.ts hostLineNow); off the sign-in pages it waits up to 300 ms
// for that answer, so a signed-in open never shows it.
import { h, onLocaleChange, tr, ui } from './dom'

const root = document.getElementById('root')!
let host = ''
/** Find work files: files the person added, being read now (AppWindow.reading); the strip says so instead */
let reading = 0

function render() {
  if (reading > 0) {
    root.replaceChildren(
      h('div', { class: 'hostbar-row reading', role: 'status', 'data-testid': 'work-files-reading' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'label' }, tr('workFiles.reading', { n: String(reading) }))),
    )
    return
  }
  root.replaceChildren(
    h(
      'div',
      { class: 'hostbar-row', 'data-testid': 'hostbar' },
      h('span', { class: 'label' }, tr('hostbar.label')),
      h('span', { class: 'host', 'data-testid': 'hostbar-host', translate: 'no' }, host),
      h('button', { type: 'button', class: 'link', 'data-testid': 'hostbar-teams', onclick: () => ui.hostbar.teams() }, tr('hostbar.other')),
    ),
  )
}

onLocaleChange(render)
ui.hostbar.onState((s) => {
  host = s?.host ?? ''
  reading = s?.reading ?? 0
  render()
})
void ui.hostbar.state().then((s) => {
  host = s?.host ?? ''
  reading = s?.reading ?? 0
  render()
})
render()
