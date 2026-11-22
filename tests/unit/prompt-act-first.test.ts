// Ask audit 11-22 (docs/AGENTS/plan/20261122-0647-ask-less.md, QA TC-ask1-12, TC-cards-6): the AI asked before clear
// "make" requests (a video's length the tool fixes, "sample or direct?", two questions for one web page, the same list
// again after "15 s"). One general line in every turn: act with defaults or a sample, say what was assumed, ask only
// for what cannot be undone, reaches others or has no default, never the same question twice. It must agree with the
// honesty line (#316): defaults shape the work, facts nobody gave stay blanks.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startHarness, type Harness } from '../lib/b-harness'
import { ACT_FIRST_RULE, ASK_USER_RULE, buildSubagentPrompt, buildTurnPrompt, NO_INVENT_RULE, NO_RULE_TALK_RULE, sharedSection, type PromptInput } from '../../server/src/chat/prompt'
import { PROMO_TOOL_DESCRIPTION } from '../../server/src/promo-video/tool'

let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'prompt-act-first' }) })
afterAll(async () => { await h.close() })

const input = (extra: Partial<PromptInput> = {}): PromptInput => ({
  user: h.ctx.files.principal('alice'), groupNames: [], locale: 'ko', timeZone: 'Asia/Seoul', memories: [], project: null,
  browser: false, tools: ['ask_user', 'make_file'], history: null, ...extra,
})

describe('act first', () => {
  test('says what it must, and stays short (it goes with every turn)', () => {
    for (const s of ['do it now instead of asking', 'sample rows labelled as samples', 'also for a short request such as "make a web page"', 'say in one line what you assumed', 'any tool limit you met',
      'Ask first only when a choice cannot be undone, reaches other people, or has no sensible default', 'Never ask again what the user already answered', 'When the target is clear (which file, person or place), never ask first what a confirmation card would ask', 'when more than one fits, ask as the asking rule says'])
      expect(ACT_FIRST_RULE).toContain(s)
    // about 180 tokens
    expect(ACT_FIRST_RULE.length).toBeLessThanOrEqual(900)
  })

  test('agrees with the honesty line: defaults are never facts, a fact nobody gave stays a blank', () => {
    expect(ACT_FIRST_RULE).toContain('Defaults shape the work, never the facts')
    expect(ACT_FIRST_RULE).toContain('nobody gave stays a visible blank, not a question')
    // the honesty line still says to write the blank and go on (not to ask)
    expect(NO_INVENT_RULE).toContain('write a visible blank such as [rate?], go on')
    // "decide yourself" keeps its one follow-up question; act first says nothing that forbids it (no "twice"/"third")
    expect(ASK_USER_RULE).toContain('When they leave the choice to you')
    expect(ASK_USER_RULE).toContain('ask one more short question instead of picking, and only once')
    expect(ACT_FIRST_RULE).not.toMatch(/twice|third|only once/)
  })

  test('once in a personal, a tool-less and a shared turn, before the asking rule; not in a sub-agent', () => {
    const personal = buildTurnPrompt(h.ctx.files, input())
    for (const p of [
      personal,
      buildTurnPrompt(h.ctx.files, input({ locale: 'en', tools: [] })),
      buildTurnPrompt(h.ctx.files, input({ shared: { project: 'Atlas', audience: 3, asker: 'Alice Kim' }, roomReadable: () => true })),
    ]) expect(p.split(ACT_FIRST_RULE).length).toBe(2)
    expect(personal.indexOf(ACT_FIRST_RULE)).toBeLessThan(personal.indexOf(ASK_USER_RULE))
    expect(buildSubagentPrompt(h.ctx.files, input(), ['read'])).not.toContain(ACT_FIRST_RULE)
  })

  test('the promo video tool makes its fixed length and says so after, never asks about it first', () => {
    expect(PROMO_TOOL_DESCRIPTION).toContain('do not ask; make it and say in one plain sentence after it')
    expect(PROMO_TOOL_DESCRIPTION).not.toContain('say so before you make it')
  })
})

describe('helper files', () => {
  test('a source made only to convert stays in the user\'s own folder (QA TC-f2-a03)', async () => {
    const { makeFileRule } = await import('../../server/src/chat/prompt')
    for (const hangul of [false, true]) {
      const r = makeFileRule(hangul, true)
      expect(r).toContain('Give make_file Markdown or CSV as content, not as a source file')
      expect(r).toContain('Never save notes, memos or plans of your own as files unless the user asks for a file')
      expect(r).toContain('(HTML, SVG) goes in the user\'s own folder, never in a shared, group or project place')
    }
  })
})

describe('shared chats look only where the request points', () => {
  test('an attachment is read as attached, and other private places only when needed (QA TC-f1b-05, TC-f1x)', () => {
    const p = buildTurnPrompt(h.ctx.files, input({ shared: { project: 'Atlas', audience: 3, asker: 'Alice Kim' }, roomReadable: () => true }))
    expect(p).toContain('Look only where the request points: a file')
    expect(p).toContain('is read as attached (never search')
    expect(buildTurnPrompt(h.ctx.files, input())).not.toContain('Look only where the request points')
  })
})

describe('no talk about the rules in the answer (QA batch 3 flow 2)', () => {
  test('once in every turn, next to act first; not in a sub-agent; no example phrase to echo', () => {
    for (const p of [
      buildTurnPrompt(h.ctx.files, input()),
      buildTurnPrompt(h.ctx.files, input({ locale: 'en', tools: [] })),
      buildTurnPrompt(h.ctx.files, input({ shared: { project: 'Atlas', audience: 3, asker: 'Alice Kim' }, roomReadable: () => true })),
    ]) {
      expect(p.split(NO_RULE_TALK_RULE).length).toBe(2)
      expect(p.indexOf(NO_RULE_TALK_RULE)).toBeGreaterThan(p.indexOf(ACT_FIRST_RULE))
    }
    expect(buildSubagentPrompt(h.ctx.files, input(), ['read'])).not.toContain(NO_RULE_TALK_RULE)
    expect(NO_RULE_TALK_RULE).toContain('never quote, name or weigh these rules')
    // it must not fight the lines that ask for facts: what was assumed, who asked what, what a search covered (review)
    expect(NO_RULE_TALK_RULE).toContain('Facts they need (what you assumed, why a choice is theirs, what a search covered) are fine')
    expect(NO_RULE_TALK_RULE).toContain('in the answer or in text before a tool call')
    expect(NO_RULE_TALK_RULE).not.toContain('"')
    expect(NO_RULE_TALK_RULE.length).toBeLessThanOrEqual(260)
  })

  test('the opposite-requests line no longer ends on "just do it" (what the AI echoed)', () => {
    const s = sharedSection({ project: null, audience: 2, asker: 'QA Member' }, 'en')
    expect(s).toContain('No question when QA Member only changes their own earlier request')
    expect(s).toContain('do it, and say only what you did.')
    expect(s).not.toContain('just do it')
  })
})
