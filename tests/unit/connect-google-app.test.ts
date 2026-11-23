// connect_service for the built-in Google apps (server/src/chat/connect-google-app.ts): which calls are one, and what
// the AI is told for each state of the app (AI scenario CON-01.calendar, 2026-11-17).
import { describe, expect, test } from 'bun:test'
import { googleAppAsked, googleAppOwnCard, googleAppTeamCard, googleAppWay } from '../../server/src/chat/connect-google-app'

describe('which call is a built-in Google app', () => {
  test('by name, in any case or spacing, English or Korean', () => {
    expect(googleAppAsked('Google Calendar', undefined)).toBe('calendar')
    expect(googleAppAsked('google-calendar', undefined)).toBe('calendar')
    expect(googleAppAsked('구글 캘린더', undefined)).toBe('calendar')
    expect(googleAppAsked('Gmail', undefined)).toBe('gmail')
    expect(googleAppAsked('지메일', undefined)).toBe('gmail')
    expect(googleAppAsked('Google Docs', undefined)).toBe('docs')
    expect(googleAppAsked('Google Sheets', undefined)).toBe('sheets')
  })
  test('by a Google API address that names it', () => {
    expect(googleAppAsked('Calendar', 'https://calendarmcp.googleapis.com/mcp/v1')).toBe('calendar')
    expect(googleAppAsked('Mail', 'https://gmailmcp.googleapis.com/mcp/v1')).toBe('gmail')
    expect(googleAppAsked('Sheets', 'https://sheets.googleapis.com/v4')).toBe('sheets')
  })
  test('not other services, other calendars or other Google products', () => {
    expect(googleAppAsked('Calendar', undefined)).toBeNull()
    expect(googleAppAsked('Outlook Calendar', 'https://graph.microsoft.com/v1.0')).toBeNull()
    expect(googleAppAsked('Notion', 'https://mcp.notion.com/mcp')).toBeNull()
    expect(googleAppAsked('Google Chat', 'https://chatmcp.googleapis.com/mcp/v1')).toBeNull()
    expect(googleAppAsked('Calendar', 'https://calendar.evil.example/googleapis.com')).toBeNull()
    expect(googleAppAsked('Calendar', 'not a url')).toBeNull()
  })
})

describe('what the AI is told', () => {
  const app = (status: 'connected' | 'disconnected' | 'needs_reconnect', reason: 'not_set_up' | 'unsupported' | 'service_limited' | null = null) => ({ name: 'Google Calendar', status, reason } as const)
  test('available: its own page, Connect and Google sign-in; nothing asked first; no technical words', () => {
    const w = googleAppWay(app('disconnected'), false, 'en')
    expect(w.connected).toBe(false)
    expect(w.text).toContain('Settings › Connectors › Google Calendar')
    expect(w.text).toContain('press Connect and sign in with their Google account')
    expect(w.text).toContain('Ask nothing about the task until it is connected')
    expect(w.text).toContain('do not look one up')
    expect(w.text).not.toMatch(/MCP|server|endpoint/i)
  })
  test('connected: its tools are there', () => {
    const w = googleAppWay(app('connected'), false, 'en')
    expect(w).toEqual({ connected: true, text: expect.stringContaining('already connected') })
  })
  test('not set up: an admin sets it up in Admin; a member asks from its page', () => {
    expect(googleAppWay(app('disconnected', 'not_set_up'), true, 'en').text).toContain('Admin › Connected apps')
    const member = googleAppWay(app('disconnected', 'not_set_up'), false, 'en').text
    expect(member).toContain('the owner or an admin has to set it up first')
    expect(member).toContain('has a button to ask them')
  })
  test('not on this kind of install, or not open yet: nobody can connect it now', () => {
    expect(googleAppWay(app('disconnected', 'unsupported'), true, 'en').text).toContain("not available on this team's app yet, so nobody can connect it now")
    expect(googleAppWay(app('disconnected', 'service_limited'), false, 'en').text).toContain('once Google has approved it')
  })
  test('the team\'s shared account: connected through it; one that needs a sign-in is an admin\'s to fix', () => {
    expect(googleAppWay({ ...app('disconnected', 'not_set_up'), shared: { status: 'connected' } }, false, 'en')).toEqual({ connected: true, text: expect.stringContaining("through the team's shared account") })
    const stale = googleAppWay({ ...app('disconnected'), shared: { status: 'needs_reconnect' } }, false, 'en').text
    expect(stale).toContain('the owner or an admin does it')
    expect(googleAppWay({ ...app('disconnected'), shared: { status: 'needs_reconnect' } }, true, 'en').text).toMatch(/they do it in Admin › Connected apps .* › Google Calendar/)
  })
  test('connected but not answering now: says so, not "its tools are yours"', () => {
    const w = googleAppWay({ ...app('connected'), serviceDown: true }, false, 'en')
    expect(w.connected).toBe(false)
    expect(w.text).toContain('not answering right now')
  })
  test('needs a new sign-in: Reconnect on its page', () => {
    expect(googleAppWay(app('needs_reconnect'), false, 'ko').text).toContain('presses Reconnect in Settings › Connectors › Google Calendar')
  })
})

// #253: an owner or admin gets a card with Connect for the team (the team's shared Google account) where the app can be
// connected and is not connected for them; a member keeps the words above
describe('who gets the card with Connect for the team', () => {
  const app = (status: 'connected' | 'disconnected' | 'needs_reconnect', reason: 'not_set_up' | 'unsupported' | 'service_limited' | null = null, shared: 'connected' | 'needs_reconnect' | null = null) => ({ status, reason, shared: shared ? { status: shared } : null })
  test('an owner or admin, the app set up and not connected for them: the card; a member never', () => {
    expect(googleAppTeamCard(app('disconnected'), true)).toBe(true)
    expect(googleAppTeamCard(app('disconnected'), false)).toBe(false)
  })
  test('a team account that needs a new sign-in: the card (its dialog signs it in again)', () => {
    expect(googleAppTeamCard(app('disconnected', null, 'needs_reconnect'), true)).toBe(true)
  })
  test('already connected (their own or the team\'s they may use), their own needing a new sign-in, or not available: the words', () => {
    expect(googleAppTeamCard(app('connected'), true)).toBe(false)
    expect(googleAppTeamCard(app('disconnected', null, 'connected'), true)).toBe(false)
    expect(googleAppTeamCard(app('needs_reconnect'), true)).toBe(false)
    for (const r of ['not_set_up', 'unsupported', 'service_limited'] as const) expect(googleAppTeamCard(app('disconnected', r), true)).toBe(false)
  })
})

// QA TC-8034: a member who can connect it themselves gets a card with their own Connect, never the team's way
describe('who gets the card with only their own Connect', () => {
  const app = (status: 'connected' | 'disconnected' | 'needs_reconnect', reason: 'not_set_up' | 'unsupported' | 'service_limited' | null = null, shared: 'connected' | 'needs_reconnect' | null = null) => ({ status, reason, shared: shared ? { status: shared } : null })
  test('a member, the app set up and not connected: the card', () => {
    expect(googleAppOwnCard(app('disconnected'), 'member')).toBe(true)
  })
  test('owners and admins have the team card; a guest uses no connections', () => {
    for (const r of ['owner', 'admin', 'guest'] as const) expect(googleAppOwnCard(app('disconnected'), r)).toBe(false)
  })
  test('connected, needing their own sign-in, not available, or covered by a team account: the words', () => {
    expect(googleAppOwnCard(app('connected'), 'member')).toBe(false)
    expect(googleAppOwnCard(app('needs_reconnect'), 'member')).toBe(false)
    for (const r of ['not_set_up', 'unsupported', 'service_limited'] as const) expect(googleAppOwnCard(app('disconnected', r), 'member')).toBe(false)
    expect(googleAppOwnCard(app('disconnected', null, 'connected'), 'member')).toBe(false)
    expect(googleAppOwnCard(app('disconnected', null, 'needs_reconnect'), 'member')).toBe(false)
  })
})
