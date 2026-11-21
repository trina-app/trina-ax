// TC-4550: a team skill that shows its numbering as a fixed example ("Q-YYYYMMDD-01") made three quotes on one day,
// all -01, in the same folder (qa.trina.app 2026-11-17). The skill block tells the AI that such a number is only a
// format: look in the folder it saves to and take the next free number.
import { expect, test } from 'bun:test'
import { parseSkill } from '../../server/src/chat/skills'
import { skillBlock } from '../../server/src/chat/prompt'
import type { Skill } from '../../server/src/chat/skills'

const quote = { ...parseSkill('---\nname: quote\ndescription: Makes a customer quote as a PDF.\n---\n3. Date and quote number (Q-YYYYMMDD-01).\n', 'skills/quote/SKILL.md')!, path: 'skills/quote/SKILL.md' } as unknown as Skill

test('a running skill is told to take the next free number from the folder it saves to', () => {
  for (const block of [skillBlock(quote, ''), skillBlock(quote, '', 'loaded')]) {
    expect(block).toMatch(/next free number/)
    expect(block).toMatch(/list the folder/i)
    expect(block).toMatch(/never reuse a number/i)
    // the rule sits before the skill's own text, inside the block
    expect(block.indexOf('next free number')).toBeLessThan(block.lastIndexOf('Q-YYYYMMDD-01'))
  }
})
