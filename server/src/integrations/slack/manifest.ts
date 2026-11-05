// The Slack app the owner makes in their own workspace (https://docs.slack.dev/reference/app-manifest): an internal app
// in Socket Mode, so the server needs no public address. Only what the connector uses:
//   app_mentions:read  @app in a channel                 im:history        messages in the app's DM
//   chat:write         answers, ephemeral ones included   users:read        the asker's name (the link page, "asked by")
//   users:read.email   the zero-click link: the Slack      im:write          the one DM telling a Slack account
//                      account's e-mail is the person's                       which account it was linked to
//   channels:read, groups:read   whether a channel is shared with another organization, checked again before
//                                "Post to channel" (conversations.info)
// The redirect URL: "Sign in with Slack" (docs.slack.dev "Sign in with Slack"), with which a person proves the Slack
// account they link; it asks for openid and profile in its own flow, so no user scopes here. Its user token is never
// kept. No channel history, no files, no slash command.
import { PRODUCT } from '@mycel/shared'

export const BOT_SCOPES = ['app_mentions:read', 'channels:read', 'chat:write', 'groups:read', 'im:history', 'im:write', 'users:read', 'users:read.email'] as const
export const BOT_EVENTS = ['app_mention', 'message.im'] as const

/** a bot user name Slack takes: a-z, 0-9, -, _ and . (at most 80) */
const botName = (s: string) => (s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'assistant').slice(0, 80)

/** `redirectUrl`: the team's https address for "Sign in with Slack" (none without one: Slack takes https only) */
export function slackManifest(name = PRODUCT.displayName, redirectUrl: string | null = null) {
  const app = name.slice(0, 35)
  return {
    _metadata: { major_version: 2, minor_version: 1 },
    display_information: { name: app, description: `Ask ${app} from Slack. Answers come from your team's ${app} with your own permissions.`.slice(0, 140), background_color: '#111111' },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: botName(app), always_online: true },
    },
    // no user scopes: "Sign in with Slack" asks for openid and profile in its own flow (they may not be combined with
    // others in one OAuth flow, and the manifest's user scopes are asked for when the app is installed)
    oauth_config: { ...(redirectUrl ? { redirect_urls: [redirectUrl] } : {}), scopes: { bot: [...BOT_SCOPES] } },
    settings: {
      event_subscriptions: { bot_events: [...BOT_EVENTS] },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  }
}

/** Slack's "create an app" with this manifest filled in (docs.slack.dev "Configuring apps with app manifests") */
export function createAppUrl(manifest: object): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`
}
