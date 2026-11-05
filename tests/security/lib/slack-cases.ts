import type { Spec } from './cases'

// The Slack connector (docs/SLACK.md). Admin › Slack is the owner's alone (admins too are refused); each person's own
// link is theirs (self); a one-time link token nobody was given is refused for everyone after the auth level. Who a
// link binds (the Slack account of the event, used once, 10 minutes, both names shown) is tested against a fake Slack
// in tests/unit/c-slack.test.ts.
/** a sealed value of the right shape that opens with no key (refused after the permission check) */
const FAKE_SEALED = { kid: '0123456789abcdef', epk: 'A'.repeat(87), iv: 'B'.repeat(16), ct: 'C'.repeat(40) }
const NO_TOKEN = { token: 'n'.repeat(43) }
const NONE = '00000000-0000-7000-8000-000000000000'
export const SLACK_SPECS: Record<string, Spec> = {
  slackAdmin: { build: c => c.get('/api/admin/slack'), scope: 'byLevel' },
  saveSlackTokens: { build: c => c.put('/api/admin/slack/tokens', { botToken: FAKE_SEALED, appToken: FAKE_SEALED }), scope: 'byLevel' },
  setSlackEnabled: { build: c => c.post('/api/admin/slack/enabled', { enabled: false }), scope: 'byLevel' },
  removeSlack: { build: c => c.del('/api/admin/slack'), scope: 'byLevel' },
  // the owner linking a Slack person (here: Slack not set up, so the owner passes the permission check and gets 409)
  slackMembers: { build: c => c.get('/api/admin/slack/members'), scope: 'byLevel' },
  proposeSlackLink: { build: c => c.post('/api/admin/slack/proposals', { slackUserId: 'U0NOBODY', userId: 'nobody' }), scope: 'byLevel' },
  // an unknown proposal: the owner passes the permission check and gets 404
  cancelSlackProposal: { build: c => c.del(`/api/admin/slack/proposals/${NONE}`), scope: 'byLevel' },
  // a proposal is answered only by the member it is for (tests/unit/c-slack.test.ts: not the owner, not someone else)
  acceptSlackProposal: { build: c => c.post(`/api/slack/proposals/${NONE}/accept`, {}), scope: 'nobody' },
  declineSlackProposal: { build: c => c.post(`/api/slack/proposals/${NONE}/decline`, {}), scope: 'nobody' },
  mySlack: { build: c => c.get('/api/slack/me'), scope: 'self' },
  unlinkSlack: { build: c => c.del('/api/slack/me'), scope: 'self' },
  previewSlackLink: { build: c => c.post('/api/slack/link/preview', NO_TOKEN), scope: 'nobody' },
  confirmSlackLink: { build: c => c.post('/api/slack/link/confirm', NO_TOKEN), scope: 'nobody' },
  cancelSlackLink: { build: c => c.post('/api/slack/link/cancel', NO_TOKEN), scope: 'nobody' },
}
