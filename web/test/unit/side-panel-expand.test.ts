// "크게 보기" on the side panel (lib/sidePanel.ts, components/Layout.tsx): not remembered, it lasts while the panel is
// open (another file or an artifact opened in it keeps it), closing the panel or the Browser pane ends it, and Esc
// undoes it before it closes the panel. How it looks, the divider, a page change and the phone width are checked in the
// browser (test/e2e/side-panel-expand.spec.ts).
import { afterEach, describe, expect, test } from 'bun:test'
import { closeSidePanel, escapeAction, getPanelExpanded, getSidePanel, openArtifact, openTeamFile, panelExpandedNow, setPanelExpanded, setSidePanel } from '../../src/lib/sidePanel'

afterEach(() => closeSidePanel())

describe('big or side by side', () => {
  test('nothing open: nothing to make big', () => {
    setPanelExpanded(true)
    expect(getPanelExpanded()).toBe(false)
  })

  test('a file opens side by side; big until the panel closes; reopened side by side', () => {
    openTeamFile('docs/handbook.pdf')
    expect(getPanelExpanded()).toBe(false)
    setPanelExpanded(true)
    expect(getPanelExpanded()).toBe(true)
    // another file in the same panel (a link inside it, a source of the answer): still big
    openTeamFile('docs/plan.md')
    expect(getPanelExpanded()).toBe(true)
    // an artifact taking the panel: still big
    openArtifact('chat-1', 'report')
    expect(getPanelExpanded()).toBe(true)
    // the toggle
    setPanelExpanded(false)
    expect(getPanelExpanded()).toBe(false)
    setPanelExpanded(true)
    // closed (✕, Esc, a page that does not keep it): over, and the next panel opens side by side
    closeSidePanel()
    expect(getPanelExpanded()).toBe(false)
    openTeamFile('docs/handbook.pdf')
    expect(getPanelExpanded()).toBe(false)
  })

  test('the Browser pane is never big, and taking the panel ends it', () => {
    openTeamFile('docs/handbook.pdf')
    setPanelExpanded(true)
    setSidePanel({ kind: 'browser' })
    expect(getPanelExpanded()).toBe(false)
    setPanelExpanded(true)
    expect(getPanelExpanded()).toBe(false)
    expect(getSidePanel()?.kind).toBe('browser')
  })

  test('not big on screen without a computer-width window (a phone has the full-screen sheet)', () => {
    openTeamFile('docs/handbook.pdf')
    setPanelExpanded(true)
    // no window here, as narrow as a phone for this purpose: Esc closes the panel
    expect(panelExpandedNow()).toBe(false)
  })
})

describe('Esc in the app frame', () => {
  test('a dialog keeps it; then the drawer; then side by side; then the panel closes', () => {
    expect(escapeAction({ dialog: true, drawer: true, expanded: true })).toBe('none')
    expect(escapeAction({ dialog: false, drawer: true, expanded: true })).toBe('drawer')
    expect(escapeAction({ dialog: false, drawer: false, expanded: true })).toBe('side-by-side')
    expect(escapeAction({ dialog: false, drawer: false, expanded: false })).toBe('close')
  })
})
