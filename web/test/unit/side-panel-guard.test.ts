// A panel with work in it (a file edited, not saved) asks before anything takes its place (lib/sidePanel.ts setPanelGuard,
// components/FilePanel.tsx): ✕, Back, another file, a page that does not keep it. No is staying in the editor.
import { afterEach, describe, expect, test } from 'bun:test'
import { closeSidePanel, getPanelRefusals, getSidePanel, openTeamFile, panelGuarded, setPanelGuard } from '../../src/lib/sidePanel'

afterEach(() => {
  setPanelGuard(null)
  closeSidePanel()
})
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('the panel guard', () => {
  test('without a guard everything is immediate', () => {
    openTeamFile('docs/a.md')
    openTeamFile('docs/b.md')
    expect(getSidePanel()).toMatchObject({ kind: 'file', file: { path: 'docs/b.md' } })
    closeSidePanel()
    expect(getSidePanel()).toBeNull()
  })

  test('closing or another file asks first; no keeps the panel and its file', async () => {
    openTeamFile('docs/a.md')
    let asked = 0
    setPanelGuard(async () => (asked++, false))
    closeSidePanel()
    await tick()
    expect(asked).toBe(1)
    expect(getSidePanel()).toMatchObject({ file: { path: 'docs/a.md' } })
    openTeamFile('docs/b.md')
    await tick()
    expect(asked).toBe(2)
    expect(getSidePanel()).toMatchObject({ file: { path: 'docs/a.md' } })
  })

  test('yes goes on, and the guard is spent', async () => {
    openTeamFile('docs/a.md')
    setPanelGuard(async () => true)
    openTeamFile('docs/b.md')
    await tick()
    expect(getSidePanel()).toMatchObject({ file: { path: 'docs/b.md' } })
    closeSidePanel()
    await tick()
    expect(getSidePanel()).toBeNull()
  })

  test('a second click while the question is open waits for it instead of asking again', async () => {
    openTeamFile('docs/a.md')
    let asked = 0
    let answer!: (v: boolean) => void
    setPanelGuard(() => new Promise<boolean>((r) => { asked++; answer = r }))
    closeSidePanel()
    closeSidePanel()
    openTeamFile('docs/b.md')
    expect(asked).toBe(1)
    answer(true)
    await tick()
    expect(getSidePanel()).toBeNull()
  })

  test('nothing open: nothing to ask', () => {
    setPanelGuard(async () => false)
    openTeamFile('docs/a.md')
    expect(getSidePanel()).toMatchObject({ file: { path: 'docs/a.md' } })
  })

  test('no counts as a refusal (a phone holds a new Back entry), yes does not; a guard that throws asks again next time', async () => {
    openTeamFile('docs/a.md')
    const before = getPanelRefusals()
    setPanelGuard(async () => false)
    closeSidePanel()
    await tick()
    expect(getPanelRefusals()).toBe(before + 1)
    setPanelGuard(async () => true)
    closeSidePanel()
    await tick()
    expect(getPanelRefusals()).toBe(before + 1)
    expect(getSidePanel()).toBeNull()
    openTeamFile('docs/a.md')
    let calls = 0
    setPanelGuard(async () => { calls++; if (calls === 1) throw new Error('boom'); return true })
    closeSidePanel()
    await tick()
    expect(getSidePanel()).not.toBeNull()
    closeSidePanel()
    await tick()
    expect(calls).toBe(2)
    expect(getSidePanel()).toBeNull()
  })

  test('panelGuarded says whether a guard is set', () => {
    expect(panelGuarded()).toBe(false)
    setPanelGuard(async () => true)
    expect(panelGuarded()).toBe(true)
  })
})
