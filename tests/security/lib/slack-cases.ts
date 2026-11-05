import type { Spec } from './cases'

// The Slack connector (docs/SLACK.md). Admin › Slack is the owner's alone (admins too are refused); each person's own
// link is theirs (self); a one-time link token nobody was given is refused for everyone after the auth level. Who a
// link binds (the Slack account of the event, used once, 10 minutes, both names shown) is tested against a fake Slack
// in tests/unit/c-slack.test.ts.
/** a sealed value of the right shape that opens with no key (refused after the permission check) */
const FAKE_SEALED = { kid: '0123456789abcdef', epk: 'A'.repeat(87), iv: 'B'.repeat(16), ct: 'C'.repeat(40) }
const NO_TOKEN = { token: 'n'.repeat(43) }
export const SLACK_SPECS: Record<string, Spec> = {
  slackAdmin: { build: c => c.get('/api/admin/slack'), scope: 'byLevel' },
  saveSlackTokens: { build: c => c.put('/api/admin/slack/tokens', { botToken: FAKE_SEALED, appToken: FAKE_SEALED }), scope: 'byLevel' },
  setSlackEnabled: { build: c => c.post('/api/admin/slack/enabled', { enabled: false }), scope: 'byLevel' },
  removeSlack: { build: c => c.del('/api/admin/slack'), scope: 'byLevel' },
  mySlack: { build: c => c.get('/api/slack/me'), scope: 'self' },
  unlinkSlack: { build: c => c.del('/api/slack/me'), scope: 'self' },
  previewSlackLink: { build: c => c.post('/api/slack/link/preview', NO_TOKEN), scope: 'nobody' },
  confirmSlackLink: { build: c => c.post('/api/slack/link/confirm', NO_TOKEN), scope: 'nobody' },
  cancelSlackLink: { build: c => c.post('/api/slack/link/cancel', NO_TOKEN), scope: 'nobody' },
}
