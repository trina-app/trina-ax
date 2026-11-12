// The chat's connect card finds what a person already has for a service (server/src/chat/connect-service.ts
// sameAddress): the same address (a trailing slash aside), or another official address of the same listed service
// (shared/src/service-catalog.ts otherUrls, 2026-11-12): a connection saved at Atlassian's v1 is Atlassian when the
// card asks for v2, never a second connection.
import { expect, test } from 'bun:test'
import { sameAddress } from '../../server/src/chat/connect-service'

test('the same address, or two official addresses of one listed service', () => {
  expect(sameAddress('https://mcp.notion.com/mcp/', 'https://mcp.notion.com/mcp')).toBe(true)
  expect(sameAddress('https://mcp.atlassian.com/v1/mcp', 'https://mcp.atlassian.com/v2/mcp')).toBe(true)
  expect(sameAddress('https://api.canva.com/connect/v1/mcp', 'https://mcp.canva.com/mcp')).toBe(true)
  expect(sameAddress('https://mcp.atlassian.com/v1/mcp', 'https://mcp.notion.com/mcp')).toBe(false)
  expect(sameAddress('https://atlassian-mcp.example.com/v1/mcp', 'https://mcp.atlassian.com/v2/mcp')).toBe(false)
  expect(sameAddress('https://board.example.com/mcp', 'https://board.example.com/mcp?x=1')).toBe(false)
})
