import crypto from 'node:crypto'
export const MCP_PATH = '/mcp'
export const SCOPES = ['mcp:read', 'mcp:write', 'offline_access'] as const
export const ACCESS_MS = 60 * 60_000, GRANT_MS = 30 * 86400_000, REQUEST_MS = 10 * 60_000, CODE_MS = 5 * 60_000
export const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex')
export const secret = (prefix = '') => prefix + crypto.randomBytes(32).toString('base64url')
export const challenge = (value: string) => crypto.createHash('sha256').update(value).digest('base64url')
export class OAuthError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code) }
}
export function validOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 1024) return null
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash ? u.origin : null } catch { return null }
}
const HOSTED = 'https://claude.ai/api/mcp/auth_callback'
function loopback(value: string): URL | null {
  try { const u = new URL(value); return u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname) && u.pathname === '/callback' && !u.username && !u.password && !u.search && !u.hash ? u : null } catch { return null }
}
export function redirectAllowed(value: string): boolean { return value === HOSTED || !!loopback(value) }
export function redirectMatches(registered: string[], value: string): boolean {
  if (!redirectAllowed(value)) return false
  if (registered.includes(value)) return true
  const given = loopback(value)
  return !!given && registered.some(r => loopback(r)?.hostname === given.hostname)
}
export function resourceMatches(origin: string, value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 2048) return false
  try { const u = new URL(value); return !u.username && !u.password && !u.search && !u.hash && u.href === origin + MCP_PATH } catch { return false }
}
export function scopes(value: unknown): string[] {
  if (value === undefined || value === '') return ['mcp:read']
  if (typeof value !== 'string' || value.length > 200) throw new OAuthError('invalid_scope')
  const asked = value.split(/\s+/).filter(Boolean)
  if (!asked.includes('mcp:read') || asked.some(s => !SCOPES.includes(s as typeof SCOPES[number]))) throw new OAuthError('invalid_scope')
  return SCOPES.filter(s => asked.includes(s))
}
