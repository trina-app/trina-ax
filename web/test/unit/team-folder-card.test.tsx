// The AI's team folder access card (components/chat/TeamFolderCard.tsx; docs/decisions/20261116-team-folder-ai-and-ask.md):
// drawn from the server's record (`Step.shared.teamFolder`) alone: the headline names the person or group and the
// folder, the folder row shows its place in words (never a path), the lines say how many people could open it before and
// after and who gained or lost access, and what happened to files inside shared one by one. No button. Every language.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { StepShared } from '@mycel/shared/api'
import TeamFolderCard from '../../src/components/chat/TeamFolderCard'
import { useLocaleStore } from '../../src/i18n'
import { installDom, mount, removeDom } from './dom-host'

const sales = { subjectType: 'group' as const, subjectId: 'g-sales', name: 'Sales', members: 2 }
const added: StepShared = {
  op: 'share', outcome: 'done', files: [], who: [sales], level: 'view',
  teamFolder: { name: 'Reports', place: 'Team files › Reports', action: 'add', access: 'view', before: 4, after: 6, gained: ['Jun', 'Mina'], gainedCount: 2, lost: [], lostCount: 0 },
}
const removed: StepShared = {
  op: 'stop', outcome: 'done', files: [], who: [sales], level: 'view',
  teamFolder: { name: 'Reports', place: 'Team files › Reports', action: 'remove', before: 9, after: 5, gained: [], gainedCount: 0, lost: ['Ana', 'Bo', 'Chen', 'Dee', 'Eve'], lostCount: 6, fileShares: 'kept' },
}
const changedMeanwhile: StepShared = { ...added, outcome: 'refused', refusal: { reason: 'changed' } }

beforeAll(() => { installDom() })
afterAll(() => { removeDom() })

test('an add: the headline, the folder in words, the group with its level, the counts and who got access; no button, no path', async () => {
  useLocaleStore.setState({ locale: 'en' })
  const m = await mount(<TeamFolderCard shared={added} folder={added.teamFolder!} />)
  try {
    expect(m.get('action-card-title').textContent).toBe('The Sales group (2 people) can now view Reports')
    expect(m.get('team-folder-card-folder').textContent).toContain('Team files › Reports')
    expect(m.get('team-folder-card-who').textContent).toContain('Can view')
    const notes = [...m.container.querySelectorAll('[data-testid="team-folder-card-note"]')].map((n) => n.textContent)
    expect(notes).toEqual(['4 people could open it before, 6 now.', 'Got access: Jun and Mina', 'New members of the group get it too.'])
    expect(m.find('action-card-footer')).toBeNull()
    expect(m.container.textContent).not.toContain('Reports/')
  } finally { await m.unmount() }
})

test('a removal: who lost access (the first five and how many more) and the person\'s pick for the file shares', async () => {
  useLocaleStore.setState({ locale: 'en' })
  const m = await mount(<TeamFolderCard shared={removed} folder={removed.teamFolder!} />)
  try {
    expect(m.get('action-card-title').textContent).toBe('Took the Sales group (2 people) off Reports')
    const notes = [...m.container.querySelectorAll('[data-testid="team-folder-card-note"]')].map((n) => n.textContent)
    expect(notes).toEqual(['9 people could open it before, 5 now.', 'Lost access: Ana, Bo, Chen, Dee, Eve and 1 more', 'Files inside that were shared one by one stay shared.'])
  } finally { await m.unmount() }
})

test('changed while the card waited: says so, nothing about counts', async () => {
  useLocaleStore.setState({ locale: 'en' })
  const m = await mount(<TeamFolderCard shared={changedMeanwhile} folder={changedMeanwhile.teamFolder!} />)
  try {
    expect(m.get('action-card-title').textContent).toBe("Couldn't change who can open Reports")
    const notes = [...m.container.querySelectorAll('[data-testid="team-folder-card-note"]')].map((n) => n.textContent)
    expect(notes).toEqual(['Something changed while the card was open. Ask again.'])
  } finally { await m.unmount() }
})

test('every language has the words (no key falls back to its name)', async () => {
  for (const l of ['ko', 'ja', 'zh', 'es', 'id'] as const) {
    useLocaleStore.setState({ locale: l })
    for (const s of [added, removed, changedMeanwhile]) {
      const m = await mount(<TeamFolderCard shared={s} folder={s.teamFolder!} />)
      try {
        expect(m.container.textContent).toContain('Reports')
        expect(m.container.textContent).not.toContain('teamFolderCard.')
      } finally { await m.unmount() }
    }
  }
  useLocaleStore.setState({ locale: 'en' })
})
