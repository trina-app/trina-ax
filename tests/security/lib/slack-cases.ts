import type { Spec } from './cases'

// The Slack connector (docs/SLACK.md). Slack's admin page is the owner's and admins' (auth 'admin': its state, "Add to
// Slack", on/off, Remove); saving the team's own app's tokens is the owner's alone (auth 'owner'), and an admin's Remove
// of the own app is refused in the service (tests/unit/c-slack.test.ts); members get none of them. Each person's
// own link is theirs (self); a one-time link token nobody was given is refused for everyone after the auth level. Who a
// link binds (the Slack account of the event, used once, 10 minutes, both names shown) is tested against a fake Slack
// in tests/unit/c-slack.test.ts.
/** a sealed value of the right shape that opens with no key (refused after the permission check) */
const FAKE_SEALED = { kid: '0123456789abcdef', epk: 'A'.repeat(87), iv: 'B'.repeat(16), ct: 'C'.repeat(40) }
const NO_TOKEN = { token: 'n'.repeat(43) }
export const SLACK_SPECS: Record<string, Spec> = {
  slackAdmin: { build: c => c.get('/api/admin/slack'), scope: 'byLevel' },
  saveSlackTokens: { build: c => c.put('/api/admin/slack/tokens', { botToken: FAKE_SEALED, appToken: FAKE_SEALED, clientId: '1111111111.2222222222', clientSecret: FAKE_SEALED }), scope: 'byLevel',
    // the body has every field: the owner reaches the handler, which refuses the seal (not the request's shape)
    check: (r, _w, who) => { if (who === 'owner' && !r.text.includes('body.sealed')) throw new Error(`the owner case stopped before the handler: ${r.status} ${r.text.slice(0, 160)}`) } },
  setSlackEnabled: { build: c => c.post('/api/admin/slack/enabled', { enabled: false }), scope: 'byLevel' },
  removeSlack: { build: c => c.del('/api/admin/slack'), scope: 'byLevel' },
  mySlack: { build: c => c.get('/api/slack/me'), scope: 'self' },
  unlinkSlack: { build: c => c.del('/api/slack/me'), scope: 'self' },
  previewSlackLink: { build: c => c.post('/api/slack/link/preview', NO_TOKEN), scope: 'nobody' },
  confirmSlackLink: { build: c => c.post('/api/slack/link/confirm', NO_TOKEN), scope: 'nobody' },
  cancelSlackLink: { build: c => c.post('/api/slack/link/cancel', NO_TOKEN), scope: 'nobody' },
  // "Sign in with Slack" for the caller's own account (Slack not set up here: 409 after the permission check)
  startSlackSignIn: { build: c => c.post('/api/slack/signin', {}), scope: 'self' },
  // "Add to Slack" (the hosting service's official app): the owner's and admins' (no hosting service here: 409 after the
  // permission check)
  startSlackInstall: { build: c => c.post('/api/admin/slack/official/install', {}), scope: 'byLevel' },
}
// GET /api/integrations/slack/oauth/callback: the state's person and session binding is tested in tests/unit/c-slack.test.ts
// (the official app's handoff: tests/unit/c-slack-official.test.ts); GET /api/integrations/slack/official/callback, the
// binding of "Add to Slack" to the owner or admin who pressed it: tests/unit/c-slack-official.test.ts
export const SLACK_RAW_COVERED = ['RAW GET SLACK_CALLBACK_PATH', 'RAW GET SLACK_BROKER_TEAM_INSTALL_RETURN_PATH']
