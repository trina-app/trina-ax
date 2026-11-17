// A new skill's save card in plain words (QA MAN-052, docs/decisions/20261117-new-skill-one-card.md): what the skill
// does and the titles of its parts first, the raw file ("---", "name:", "## Steps") one click away under "Show the
// file". A change to an existing skill, a rule and a file that is not a skill keep the diff as before.
import { expect, test } from 'bun:test'
import type { SkillWritePreview, TurnRequest } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import AskCard, { newSkillSummary } from '../../src/components/chat/AskCard'
import { installDom, mount, removeDom } from './dom-host'

const SKILL = ['---', 'name: leave-request', 'description: Fills in the team\'s leave request form.', '---', '', '# Leave request', '', '## Steps', '1. Ask for the dates.', '## Form', '- Name:']
const preview = (o: Partial<SkillWritePreview> = {}): SkillWritePreview => ({
  kind: 'skill_write', path: 'skills/leave-request/SKILL.md', isNew: true, skillName: 'leave-request',
  diff: `@@ -0,0 +1,${SKILL.length} @@\n` + SKILL.map((l) => '+' + l).join('\n'), added: SKILL.length, removed: 0, truncated: false, ...o,
})
const card = (p: SkillWritePreview): Extract<TurnRequest, { kind: 'ask_user' }> => ({
  kind: 'ask_user', origin: 'server', requestId: 'r1', question: 'Save this as a team skill?', multiple: false, allowText: false,
  options: [{ label: 'Save', value: 'save' }, { label: "Don't save", value: 'skip' }], preview: p,
})

test('newSkillSummary: the description and the part titles of a new SKILL.md; null for a change or a rule', () => {
  expect(newSkillSummary(preview())).toEqual({ description: "Fills in the team's leave request form.", parts: ['Steps', 'Form'] })
  expect(newSkillSummary(preview({ isNew: false }))).toBeNull()
  expect(newSkillSummary(preview({ skillName: null }))).toBeNull()
  expect(newSkillSummary(preview({ diff: 'A file the AI makes (DOCX)' }))).toBeNull()
})

test('the card: plain words first, the file folded under "Show the file"', async () => {
  installDom()
  const m = await mount(<AskCard req={{ request: card(preview()) }} onAnswer={async () => {}} />)
  try {
    expect(m.get('skill-preview-does').textContent).toBe(`${translate('en', 'ask.skillDoes')} Fills in the team's leave request form.`)
    expect(m.get('skill-preview-parts').textContent).toBe(`${translate('en', 'ask.skillParts')} Steps · Form`)
    const file = m.get('skill-preview-file')
    expect(file.localName).toBe('details')
    expect(file.hasAttribute('open')).toBe(false)
    expect(file.textContent).toContain(translate('en', 'ask.skillShowFile'))
    expect(m.get('skill-preview-diff').textContent).toContain('+name: leave-request')
  } finally {
    await m.unmount()
    removeDom()
  }
})

test('a change to an existing skill keeps the open diff, no summary', async () => {
  installDom()
  const m = await mount(<AskCard req={{ request: card(preview({ isNew: false, diff: '@@ -1,1 +1,1 @@\n-old\n+new', added: 1, removed: 1 })) }} onAnswer={async () => {}} />)
  try {
    expect(m.html()).not.toContain('skill-preview-summary')
    expect(m.html()).not.toContain('skill-preview-file')
    expect(m.get('skill-preview-diff').textContent).toContain('+new')
  } finally {
    await m.unmount()
    removeDom()
  }
})
