// The web app's i18n keys the AI's map of the app names (chat/app-map.ts). Its own module so that the generator
// (scripts/app-map-labels.ts) reads the list without importing the file it writes (app-map-labels.ts).
/** The web app's i18n keys this map names (web/src/i18n/en.ts). The generator writes their words to app-map-labels.ts. */
export const APP_MAP_KEYS = [
  'settings.title', 'admin.title', 'sidebar.files', 'sidebar.skills', 'rooms.aiName', 'inbox.title', 'projects.title', 'projects.new',
  // chats
  'chat.rename', 'chat.pin', 'navFolders.new', 'navFolders.moveTo', 'chat.regenerate', 'chat.edit',
  // account: Settings › Profile and Security & devices, the status from the account menu
  'profile.photo', 'settings.security', 'auth.changePassword', 'settings.devices', 'status.set', 'presence.setAway',
  // cards and allowances (the card's own "Always allow" is the server's: chat/i18n.ts cardAlways)
  'settings.allowances', 'settings.allowancesAi',
  // rooms
  'roomApps.menuAdd', 'roomApps.menuList', 'roomApps.address', 'rooms.menu.notify', 'rooms.notify.mentions', 'rooms.notify.off',
  'rooms.info.rename', 'rooms.info.invite', 'rooms.menu.copyLink', 'rooms.react',
  // Settings
  'notifications.title', 'notifications.quiet', 'settings.apps', 'settings.about', 'aiApps.title', 'settings.profile', 'integrations.title',
  // skills, files
  'skills.catalog.more', 'skills.catalog.bring', 'files.findWork.entryButton',
  // Admin
  'admin.members', 'members.inviteToTeam', 'members.inviteMore', 'teamLink.title', 'members.resetLinkButton', 'members.reset', 'admin.groups',
  'admin.integrations', 'integrations.requests.add', 'handover.menu', 'guest.admin.title', 'guest.invite.ai', 'guest.ai.none', 'guest.ai.own', 'guest.ai.team',
  'admin.usage', 'budgets.title', 'admin.audit', 'admin.settings', 'teamSettings.section.general', 'teamSettings.timeZone',
  'speech.title', 'teamSettings.group.engine', 'devEnv.title', 'admin.plugins', 'admin.providers', 'admin.system',
  'storage.title', 'system.updates', 'system.backups', 'system.export', 'system.connection', 'system.address',
] as const
export type AppMapKey = (typeof APP_MAP_KEYS)[number]

