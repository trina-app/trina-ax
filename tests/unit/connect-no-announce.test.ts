// The AI wrote "연결 카드를 띄울게요" (I'll show a connect card) before connect_service, which then showed none (AI scenario
// CON-02, 2026-11-16; docs/AGENTS/plan/*-ai-no-card-announce.md). The rule and the tool's description say to call it
// first and never announce a card: it shows itself when there is one, and only the result says what happened.
import { describe, expect, test } from 'bun:test'
import { CONNECT_RULE } from '../../server/src/chat/prompt'
import { B_TOOL_DESCRIPTIONS } from '../../server/src/chat/tools'

describe('no card announced before connect_service', () => {
  test('the rule: call it before writing about connecting; never announce a card; nothing that invites one', () => {
    expect(CONNECT_RULE).toContain('call it before you write anything about connecting. Never announce a card: it shows itself when there is one, and only its result says what happened.')
    expect(CONNECT_RULE).toContain('and call connect_service again.')
    expect(CONNECT_RULE).not.toMatch(/offer the card|finish on the card/)
  })
  test('the description starts with it, short', () => {
    const first = B_TOOL_DESCRIPTIONS.connect_service.split('. ')[0]!
    expect(first).toBe('Call it before writing about connecting; never say a card will show (it shows itself, if any)')
    expect(first.length).toBeLessThanOrEqual(100)
  })
})
