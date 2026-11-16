// The AI wrote "연결 카드를 띄울게요" (I'll show a connect card) before connect_service, which then showed none (AI scenario
// CON-02, 2026-11-16; docs/AGENTS/plan/*-ai-no-card-announce.md). The rule says to call it first and never announce a
// connect card (other cards are still named): it shows itself when there is one, and only the result says what happened.
import { describe, expect, test } from 'bun:test'
import { CONNECT_RULE } from '../../server/src/chat/prompt'
import { B_TOOL_DESCRIPTIONS } from '../../server/src/chat/tools'

describe('no card announced before connect_service', () => {
  test('the rule: call it before writing about connecting; never announce a card; nothing that invites one', () => {
    expect(CONNECT_RULE).toContain('call it before you write anything about connecting. Never announce a connect card: it shows itself when there is one, and only the result says what happened.')
    expect(CONNECT_RULE).toContain('and call connect_service (without the key) so they enter a new one on the card.')
    expect(CONNECT_RULE).not.toContain('connect_service again')
    expect(CONNECT_RULE).not.toMatch(/offer the card|finish on the card/)
  })
  test('said in one place: the rule (and the refusal text), not again in the tool description', () => {
    expect(B_TOOL_DESCRIPTIONS.connect_service.startsWith('Connect a service for the user')).toBe(true)
    expect(B_TOOL_DESCRIPTIONS.connect_service).not.toMatch(/announce|card will show|before writing/i)
  })
})
