// Figures and links from the web (QA A-11-M; plan docs/AGENTS/plan/20261125-0851-research-figure-fidelity.md): a cited
// brief turned "71% of staff reported less burnout" into "71% less burnout" after writing from search summaries. One
// general line for every turn and sub-agent that can read web pages; not keyed to the QA case's words.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startHarness, type Harness } from '../lib/b-harness'
import { buildSubagentPrompt, buildTurnPrompt, WEB_FIGURES_RULE, type PromptInput } from '../../server/src/chat/prompt'

let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'prompt-web-figures' }) })
afterAll(async () => { await h.close() })

const input = (extra: Partial<PromptInput> = {}): PromptInput => ({
  user: h.ctx.files.principal('alice'), groupNames: [], locale: 'en', timeZone: 'Asia/Seoul', memories: [], project: null,
  browser: false, tools: ['web_fetch', 'make_file'], history: null, ...extra,
})

describe('the web figures line', () => {
  test('says what a figure keeps, where it may come from, which links, and the check; stays short', () => {
    for (const s of ['unit, base and population', 'percent or percentage points', 'currency, year and period', 'in any language',
      'only from a page whose own text you read', 'a summary written by the search tool, not the source', 'another page that states the figure',
      'marked as from a search summary', 'Link only addresses a tool gave you in this chat', 'never one you built or remember',
      'check each figure against the text you read'])
      expect(WEB_FIGURES_RULE).toContain(s)
    // general: not the QA case's figures or topic
    expect(WEB_FIGURES_RULE).not.toMatch(/71%|39%|burnout|four-day|4-day/i)
    expect(WEB_FIGURES_RULE.length).toBeLessThanOrEqual(1150)
  })

  test('in a turn and a sub-agent that can read web pages, and only there', () => {
    expect(buildTurnPrompt(h.ctx.files, input())).toContain(WEB_FIGURES_RULE)
    expect(buildTurnPrompt(h.ctx.files, input({ locale: 'ko' }))).toContain(WEB_FIGURES_RULE)
    expect(buildSubagentPrompt(h.ctx.files, input(), ['web_fetch', 'read'])).toContain(WEB_FIGURES_RULE)
    expect(buildTurnPrompt(h.ctx.files, input({ tools: ['make_file'] }))).not.toContain(WEB_FIGURES_RULE)
    expect(buildSubagentPrompt(h.ctx.files, input(), ['read'])).not.toContain(WEB_FIGURES_RULE)
  })
})
