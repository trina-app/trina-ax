// The Slack app the owner makes in their own workspace (https://docs.slack.dev/reference/app-manifest): an internal app
// in Socket Mode, so the server needs no public address. Only what the connector uses:
//   app_mentions:read  @app in a channel                 im:history  messages in the app's DM
//   chat:write         answers, ephemeral ones included   users:read  the asker's name (the link page, "asked by")
// No channel history, no files, no slash command, no user token.
import { PRODUCT } from '@mycel/shared'

export const BOT_SCOPES = ['app_mentions:read', 'chat:write', 'im:history', 'users:read'] as const
export const BOT_EVENTS = ['app_mention', 'message.im'] as const

/** a bot user name Slack takes: a-z, 0-9, -, _ and . (at most 80) */
const botName = (s: string) => (s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'assistant').slice(0, 80)

export function slackManifest(name = PRODUCT.displayName) {
  const app = name.slice(0, 35)
  return {
    _metadata: { major_version: 2, minor_version: 1 },
    display_information: { name: app, description: `Ask ${app} from Slack. Answers come from your team's ${app} with your own permissions.`.slice(0, 140), background_color: '#111111' },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: botName(app), always_online: true },
    },
    oauth_config: { scopes: { bot: [...BOT_SCOPES] } },
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
