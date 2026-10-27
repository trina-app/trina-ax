import { expect, test } from 'bun:test'
import { validOrigin, redirectAllowed, redirectMatches, resourceMatches, scopes } from '../../server/src/connectors/remote-mcp/policy'
test('issuer is an explicit HTTPS origin, never credentials, path, opaque URL or forwarded host', () => {
  expect(validOrigin('https://TEAM.example:443')).toBe('https://team.example')
  for (const value of ['http://team.example', 'https://u@team.example', 'https://team.example/path', 'https://team.example?x=1', 'https://team.example#x', null]) expect(validOrigin(value)).toBeNull()
})
test('Claude hosted redirect is exact; native loopback varies only in its port', () => {
  expect(redirectAllowed('https://claude.ai/api/mcp/auth_callback')).toBe(true)
  expect(redirectMatches(['http://localhost/callback'], 'http://localhost:51732/callback')).toBe(true)
  expect(redirectMatches(['http://127.0.0.1/callback'], 'http://127.0.0.1:51732/callback')).toBe(true)
  for (const uri of ['https://claude.ai.evil.test/api/mcp/auth_callback', 'https://u@claude.ai/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback?extra=1', 'javascript:x', 'http://127.0.0.2/callback', 'http://localhost/callback?x=1']) expect(redirectAllowed(uri)).toBe(false)
  expect(redirectMatches(['http://localhost/callback'], 'http://127.0.0.1/callback')).toBe(false)
})
test('resource binding is exact including path; query and credential aliases never weaken the audience', () => {
  expect(resourceMatches('https://team.example','HTTPS://TEAM.EXAMPLE/mcp')).toBe(true)
  for (const r of [undefined,'https://team.example','https://team.example/mcp/','https://team.example/mcp?x=1','https://u@team.example/mcp','https://evil.example/mcp']) expect(resourceMatches('https://team.example',r)).toBe(false)
})
test('unknown scopes are refused, read is the default and write never implies extra tool families', () => {
  expect(scopes(undefined)).toEqual(['mcp:read'])
  expect(scopes('offline_access mcp:read mcp:write mcp:read')).toEqual(['mcp:read','mcp:write','offline_access'])
  for (const s of ['admin', 'mcp:read admin', 'offline_access', 'mcp:write']) expect(() => scopes(s)).toThrow()
})
