// The feature map (docs/FEATURES.md): the product's features, each claiming the API endpoints (shared/src/api) and web
// screens (web/src/App.tsx routes, Settings sections, Admin pages) that make it. The units are read from the code; only
// this grouping is kept by hand. `bun run features:check` fails when an endpoint or a screen belongs to no feature, or a
// pattern here claims nothing.
//
// IDs are stable: QA rows in the QA sheet name them (its "Feature ID" column). Never rename or reuse an ID; add a new one.
// Patterns: an exact endpoint name / screen path, or `*` for any run of characters ("*Room*", "/admin/system/*").
// An endpoint may belong to more than one feature. `manual: true`: a feature with no endpoint or screen of its own (the
// desktop and phone apps, installs, releases), judged by QA rows only.

export type FeatureArea =
  | 'Sign-in & account'
  | 'AI chat'
  | 'Projects'
  | 'Files'
  | 'Rooms'
  | 'Skills'
  | 'Scheduled tasks'
  | 'Connections'
  | 'Onboarding'
  | 'Home'
  | 'Settings'
  | 'Admin'
  | 'System'
  | 'Apps & hosting'

export interface Feature {
  id: string
  name: string
  area: FeatureArea
  endpoints?: string[]
  screens?: string[]
  manual?: true
}

export const FEATURES: Feature[] = [
  // ---------------- Sign-in & account ----------------
  { id: 'auth.setup', name: 'First-run setup: make the team and its owner', area: 'Sign-in & account', endpoints: ['setupStatus', 'setup'], screens: ['/setup'] },
  { id: 'auth.signin', name: 'Sign in and sign out', area: 'Sign-in & account', endpoints: ['login', 'logout', 'me', 'health'], screens: ['/login'] },
  { id: 'auth.password', name: 'Change password (also a forced temporary one)', area: 'Sign-in & account', endpoints: ['changePassword'], screens: ['/password', '/settings/security/password'] },
  { id: 'auth.reset', name: 'Password reset link', area: 'Sign-in & account', endpoints: ['passwordResetInfo', 'completePasswordReset'], screens: ['/reset-password/:token'] },
  { id: 'auth.invite', name: 'Accept an invite', area: 'Sign-in & account', endpoints: ['inviteInfo', 'acceptInvite'], screens: ['/invite/:token'] },
  { id: 'auth.team-link', name: 'Join with the team link', area: 'Sign-in & account', endpoints: ['teamLinkInfo', 'joinTeamLink', '*TeamLink'], screens: ['/join'] },
  { id: 'auth.devices', name: 'Signed-in devices', area: 'Sign-in & account', endpoints: ['mySessions', 'revokeMySession'], screens: ['/settings/security', '/settings/security/devices'] },
  { id: 'account.profile', name: 'Profile, photo and language', area: 'Sign-in & account', endpoints: ['updateMe', 'updateMyProfile', 'putMyAvatar', 'deleteMyAvatar', 'personAvatar'], screens: ['/settings/profile'] },
  { id: 'account.status', name: 'Status message and away', area: 'Sign-in & account', endpoints: ['setMyStatus', 'clearMyStatus', 'setMyAway'] },
  { id: 'account.deletion', name: 'Account deletion request', area: 'Sign-in & account', endpoints: ['myDeletionRequest', 'requestAccountDeletion', 'cancelAccountDeletion'], screens: ['/settings/account/delete'] },
  { id: 'account.usage', name: 'My own AI usage', area: 'Sign-in & account', endpoints: ['myUsage'], screens: ['/settings/usage'] },
  { id: 'people.directory', name: 'People of the team', area: 'Sign-in & account', endpoints: ['listPeople'] },

  // ---------------- AI chat ----------------
  { id: 'chat.conversation', name: 'Chat with the AI: send, stream, stop', area: 'AI chat', endpoints: ['createChat', 'getChat', 'listMessages', 'sendMessage', 'stop', 'getChatQueue', 'markChatSeen'], screens: ['/c/:chatId'] },
  { id: 'chat.list', name: 'Chat history: rename, pin, delete, restore', area: 'AI chat', endpoints: ['listChats', 'listChatGroups', 'updateChat', 'deleteChat', 'restoreChat', 'pinChat', 'unpinChat'], screens: ['/trash'] },
  { id: 'chat.list-folders', name: 'List folders: my own folders for AI chats and conversations', area: 'AI chat', endpoints: ['*NavFolder*', 'setChatFolder', 'setRoomFolder'] },
  { id: 'chat.edit-regenerate', name: 'Edit a question, regenerate, answer branches', area: 'AI chat', endpoints: ['editMessage', 'regenerate', 'selectBranch'] },
  { id: 'chat.cards', name: 'AI questions, confirmations and connect cards in a turn', area: 'AI chat', endpoints: ['listTurnRequests', 'answerTurn', 'connectTurn'] },
  { id: 'chat.sources', name: 'Answer sources', area: 'AI chat', endpoints: ['messageSources'] },
  { id: 'chat.share', name: 'Share a chat or an answer to a room', area: 'AI chat', endpoints: ['shareChat', 'shareAnswerToRoom'] },
  { id: 'chat.engine', name: 'Pick the AI engine and model', area: 'AI chat', endpoints: ['chatEngines'] },
  { id: 'chat.artifacts', name: 'Artifacts made in a chat (pages, documents)', area: 'AI chat', endpoints: ['listChatArtifacts', 'getArtifact'] },
  { id: 'chat.decks', name: 'Intro decks (slides, PPTX, PDF)', area: 'AI chat', endpoints: ['*IntroDeck*', 'listDeckBuilds', 'deckBuildSlide'] },
  { id: 'chat.promo-video', name: 'Promo videos (MP4)', area: 'AI chat', endpoints: ['*PromoVideo'] },
  { id: 'chat.voice', name: 'Voice input and recordings to text', area: 'AI chat', endpoints: ['transcribe', 'getJob', 'cancelJob'] },
  { id: 'chat.browser', name: 'The AI uses the browser (desktop app)', area: 'AI chat', endpoints: ['pollCalls', 'postResult'], screens: ['/settings/browser'] },
  { id: 'chat.web-access', name: 'Allow all websites for the AI', area: 'AI chat', endpoints: ['setMyWebAccess'] },
  { id: 'chat.memory', name: 'What the AI remembers about me', area: 'AI chat', endpoints: ['*Memor*'], screens: ['/settings/memory'] },
  { id: 'chat.allowances', name: 'What I allowed the AI in advance', area: 'AI chat', endpoints: ['*AiAllowance*'], screens: ['/settings/allowances'] },
  { id: 'chat.ai-access', name: 'Can I use AI now: ask the owner, AI not ready', area: 'AI chat', endpoints: ['getAiAccess', 'requestAiAccess', 'tellAiNotReady', 'trialCredit'] },

  // ---------------- Projects ----------------
  { id: 'projects.list', name: 'Projects list and new project', area: 'Projects', endpoints: ['listProjects', 'createProject', 'previewProjectAccess'], screens: ['/projects'] },
  { id: 'projects.home', name: 'A project: its chats, files, rename, delete, restore', area: 'Projects', endpoints: ['getProject', 'updateProject', 'deleteProject', 'restoreProject'], screens: ['/projects/:projectId', '/projects/:projectId/files'] },
  { id: 'projects.members', name: 'Who is in a project', area: 'Projects', endpoints: ['getProjectAccess', 'getProjectPeople', 'putProjectParticipants', 'shareProject'] },
  { id: 'projects.update-notice', name: 'Projects become members-only (0.5 update notice)', area: 'Projects', endpoints: ['*ProjectsUpdateNotice'] },
  { id: 'projects.dev-env', name: 'Dev environment of a project', area: 'Projects', endpoints: ['devEnv', 'devEnvStop', 'devEnvRunStop', 'devEnvActivity', 'myDevEnvRuns', 'stopMyDevEnvRun', 'previewMyDevEnvRun'] },
  { id: 'projects.dev-env-sites', name: 'Dev environment sites and full internet', area: 'Projects', endpoints: ['myDevEnvSites', 'removeMyDevEnvSite', 'setMyDevEnvFullInternet'], screens: ['/settings/dev-env-sites'] },

  // ---------------- Files ----------------
  { id: 'files.browse', name: 'Team folder: browse folders', area: 'Files', endpoints: ['tree', 'folderAudience'], screens: ['/files'] },
  { id: 'files.view', name: 'Open and preview a file (PDF, Office, HWP)', area: 'Files', endpoints: ['content', 'preview', 'hwpPreview', 'download'], screens: ['/files/view'] },
  { id: 'files.edit', name: 'Edit and save a text file; HTML to PDF', area: 'Files', endpoints: ['saveContent', 'saveHtmlPdf', 'downloadHtmlPdf'] },
  { id: 'files.upload', name: 'Upload files (also large, in pieces)', area: 'Files', endpoints: ['upload', '*UploadSession', 'uploadChunk'] },
  { id: 'files.organize', name: 'New folder, move, copy, delete', area: 'Files', endpoints: ['mkdir', 'move', 'copy', 'remove', 'moveSuggestions', 'dismissMoveSuggestion'] },
  { id: 'files.versions', name: 'File history and restore a version', area: 'Files', endpoints: ['history', 'versionDownload', 'restoreVersion'] },
  { id: 'files.trash', name: 'Files trash', area: 'Files', endpoints: ['trash', 'restoreTrash', 'purgeTrash'] },
  { id: 'files.search', name: 'Find files and search inside them; recent files', area: 'Files', endpoints: ['findFiles', 'searchFileContents', 'recentFiles'] },
  { id: 'files.attach', name: 'Attach files to a chat', area: 'Files', endpoints: ['uploadAttachment', 'attachmentThumbnail', 'attachTeamFile', 'discardAttachment'] },
  { id: 'files.file-list', name: 'File list (what each file is)', area: 'Files', endpoints: ['fileListStatus', 'runFileList'], screens: ['/admin/settings/file-list'] },
  { id: 'files.connected', name: 'Connected folders', area: 'Files', endpoints: ['*Connected'], screens: ['/admin/system/connected'] },

  // ---------------- Rooms ----------------
  { id: 'rooms.list', name: 'Conversations list, new room, DM and group chat', area: 'Rooms', endpoints: ['listRooms', 'createRoom'], screens: ['/rooms'] },
  { id: 'rooms.messages', name: 'Room messages: send, edit, delete, read', area: 'Rooms', endpoints: ['getRoom', 'listRoomMessages', 'sendRoomMessage', 'editRoomMessage', 'deleteRoomMessage', 'markRoomRead'], screens: ['/rooms/:roomId'] },
  { id: 'rooms.threads', name: 'Thread replies in a room', area: 'Rooms', endpoints: ['listRoomThread', 'markRoomThreadRead'], screens: ['/rooms/:roomId/t/:messageId'] },
  { id: 'rooms.reactions', name: 'Reactions', area: 'Rooms', endpoints: ['reactRoomMessage'] },
  { id: 'rooms.members', name: 'Room members: invite, remove, leave, rename', area: 'Rooms', endpoints: ['updateRoom', 'listRoomMembers', 'inviteRoomMembers', 'removeRoomMember', 'leaveRoom'] },
  { id: 'rooms.hide-pin', name: 'Hide and pin conversations', area: 'Rooms', endpoints: ['setRoomHidden', 'pinRoom', 'unpinRoom'] },
  { id: 'rooms.files', name: 'Files in a room', area: 'Rooms', endpoints: ['uploadRoomFile', 'attachRoomTeamFile', 'roomFile', 'roomFileHwpPreview'] },
  { id: 'rooms.search', name: 'Search messages and files of rooms', area: 'Rooms', endpoints: ['searchRoomMessages', 'searchRoomFiles'] },
  { id: 'rooms.activity', name: 'Activity: mentions and thread replies', area: 'Rooms', screens: ['/activity'] },

  // ---------------- Skills ----------------
  { id: 'skills.list', name: 'Skills page: my, group and team skills', area: 'Skills', endpoints: ['listSkills', 'listSkillIssues', 'skillsOverview'], screens: ['/skills'] },
  { id: 'skills.move', name: 'Move a skill to another level', area: 'Skills', endpoints: ['skillMoveOptions', 'moveSkill'] },
  { id: 'skills.suggestions', name: 'Suggest a skill; managers approve or reject', area: 'Skills', endpoints: ['*SkillSuggestion*', 'contributeSkills'] },
  { id: 'skills.managers', name: 'Skill managers and skill change log', area: 'Skills', endpoints: ['listSkillChanges', 'listSkillManagers', 'setSkillManager'] },
  { id: 'skills.share', name: 'Bring my own skills to the team', area: 'Skills', endpoints: ['*SkillShare*', 'startSkillMerge'], screens: ['/skills/share/:id'] },
  { id: 'skills.packs', name: 'Ready-made skills catalog', area: 'Skills', endpoints: ['listSkillPacks', 'installSkillPack'] },
  { id: 'skills.draft', name: 'Make a team skill from a chat', area: 'Skills', endpoints: ['startSkillDraft', 'getSkillDraft', 'saveSkillDraft'] },
  { id: 'skills.draft-from-form', name: 'Make a team skill from a form file', area: 'Skills', endpoints: ['startFormSkillDraft'] },

  // ---------------- Scheduled tasks ----------------
  { id: 'schedules.tasks', name: 'Scheduled tasks: list, edit, run now, delete', area: 'Scheduled tasks', endpoints: ['listSchedules', 'updateSchedule', 'runScheduleNow', 'scheduleEditCard', 'editSchedule', 'deleteSchedule'], screens: ['/scheduled', '/scheduled/:id'] },
  { id: 'schedules.templates', name: 'Scheduled task templates', area: 'Scheduled tasks', endpoints: ['listScheduleTemplates', 'createScheduleFromTemplate'] },
  { id: 'schedules.review', name: 'Review a paused scheduled task', area: 'Scheduled tasks', endpoints: ['getScheduleReview', 'confirmScheduleReview', 'listSchedulesAwaitingReview'] },

  // ---------------- Connections ----------------
  { id: 'connectors.mine', name: 'My connectors (MCP services)', area: 'Connections', endpoints: ['listIntegrations', 'createIntegration', 'updateIntegration', 'deleteIntegration', 'refreshIntegration', 'authorizeIntegration', 'integrationFlow', 'setIntegrationTool', 'stopAlwaysAllow'], screens: ['/settings/connectors', '/settings/connectors/:id', '/settings/connectors/mcp/:integrationId'] },
  { id: 'connectors.team', name: 'Team connectors (Admin › Connected apps)', area: 'Connections', endpoints: ['listTeamIntegrations', 'createTeamIntegration'], screens: ['/admin/connectors', '/admin/connectors/:id', '/admin/connectors/mcp/:id'] },
  { id: 'connectors.requests', name: 'Admin asks a member to connect a service', area: 'Connections', endpoints: ['*IntegrationRequest*'] },
  { id: 'connectors.templates', name: 'Shared connector templates', area: 'Connections', endpoints: ['*IntegrationTemplate*'] },
  { id: 'connectors.service-requests', name: 'Member asks the team for an app', area: 'Connections', endpoints: ['myServiceRequests', 'askService', 'withdrawService', 'teamServiceRequests', 'dismissServiceRequests'] },
  { id: 'connectors.google-drive', name: 'Google Drive connection and team shares', area: 'Connections', endpoints: ['*Drive*', 'drive*'] },
  { id: 'connectors.google-apps', name: 'Gmail, Calendar and other Google apps', area: 'Connections', endpoints: ['*GoogleApp*', 'googleApp*'] },
  { id: 'connectors.slack', name: 'Slack connector and linking my Slack', area: 'Connections', endpoints: ['*Slack*', 'slack*'], screens: ['/slack/*'] },
  { id: 'connectors.ai-apps', name: 'Outside AI apps (Claude etc.) use this server', area: 'Connections', endpoints: ['*RemoteConnector*'], screens: ['/connectors/authorize', '/settings/ai-apps', '/admin/ai-apps'] },
  { id: 'providers.mine', name: 'My own AI accounts (Claude, Codex sign-in)', area: 'Connections', endpoints: ['myCredentials', 'createMyCredential', 'deleteMyCredential', '*MyCredentialLogin*', 'sealingKey'], screens: ['/settings/providers'] },
  { id: 'providers.team', name: 'Team AI accounts and engines', area: 'Connections', endpoints: ['listCredentials', 'createCredential', 'updateCredential', 'replaceCredentialSecret', 'deleteCredential', 'checkCredential', 'startCredentialLogin', 'getCredentialLogin', 'cancelCredentialLogin', 'submitCredentialLoginCode', 'updateCredentialSettings', 'engines', 'getApiEngine', 'putApiEngine', 'updateEngines', 'checkEngine'], screens: ['/admin/providers', '/admin/providers/:id', '/admin/settings/ai'] },

  // ---------------- Onboarding ----------------
  { id: 'onboarding.welcome', name: 'Getting started steps (owner)', area: 'Onboarding', endpoints: ['getWelcome', 'updateWelcome', 'setupWelcomeTeam', 'welcomeBrand'], screens: ['/welcome'] },
  { id: 'onboarding.company-profile', name: 'Company profile', area: 'Onboarding', endpoints: ['getCompanyProfile', 'saveCompanyProfile', 'startProfileDraft', 'getProfileDraft'], screens: ['/admin/settings/company'] },
  { id: 'onboarding.team-files', name: 'Team files picked by the AI', area: 'Onboarding', endpoints: ['rankTeamFiles', 'teamFilesLanded'] },
  { id: 'onboarding.organize-files', name: 'Folder plan for the files uploaded at setup', area: 'Onboarding', endpoints: ['startOrganize', 'organizeStatus', 'applyOrganize'] },
  { id: 'onboarding.goal', name: '7-day team goal', area: 'Onboarding', endpoints: ['getTeamGoal'] },
  { id: 'onboarding.suggestion', name: 'Suggestion under an answer', area: 'Onboarding', endpoints: ['getResultSuggestion', 'dismissSuggestion'] },
  { id: 'onboarding.member-welcome', name: 'Welcome card for an invited member', area: 'Onboarding', endpoints: ['getMemberWelcome', 'updateMemberWelcome'] },
  { id: 'onboarding.handover', name: 'Handover to a team lead', area: 'Onboarding', endpoints: ['handoverState', 'endPendingConnections', 'dismissLeadCard'] },
  { id: 'onboarding.demo', name: 'Demo mode', area: 'Onboarding', endpoints: ['demoInfo', 'demoSwitch'] },

  // ---------------- Home ----------------
  { id: 'home.start', name: 'Home: prepared skills, frequent skills, often asked', area: 'Home', endpoints: ['skillExamples', 'popularSkills', 'oftenAsked'], screens: ['/', '/new'] },

  // ---------------- Settings ----------------
  { id: 'settings.list', name: 'Settings list and search', area: 'Settings', screens: ['/settings'] },
  { id: 'settings.notifications', name: 'Notifications and inbox', area: 'Settings', endpoints: ['*Notification*'], screens: ['/settings/notifications'] },
  { id: 'settings.push', name: 'Push notifications on phones and computers', area: 'Settings', endpoints: ['*Push*'] },
  { id: 'settings.apps', name: 'Apps to install', area: 'Settings', screens: ['/settings/apps'] },
  { id: 'settings.about', name: 'About this app', area: 'Settings', screens: ['/settings/about'] },

  // ---------------- Admin ----------------
  { id: 'admin.home', name: 'Admin home and owner checklist', area: 'Admin', endpoints: ['afterUpdateActions', 'dismissAfterUpdate', 'managedNotices', 'plan'], screens: ['/admin'] },
  { id: 'admin.members', name: 'Members: add, change role, remove, reset password', area: 'Admin', endpoints: ['listUsers', 'createUser', 'updateUser', 'deleteUser', 'resetPassword', 'createResetLink', 'transferOwnership'], screens: ['/admin/members', '/admin/members/:id'] },
  { id: 'admin.invites', name: 'Invites', area: 'Admin', endpoints: ['listInvites', 'createInvite', 'revokeInvite'] },
  { id: 'admin.groups', name: 'Groups', area: 'Admin', endpoints: ['listGroups', 'createGroup', 'updateGroup', 'deleteGroup'], screens: ['/admin/groups', '/admin/groups/:id'] },
  { id: 'admin.folders', name: 'Folder permissions', area: 'Admin', endpoints: ['listFolders', 'createFolder', 'putFolderRules', 'deleteFolder', 'previewRules', 'explain*Access*', 'previewFolderEdit'], screens: ['/admin/folders'] },
  { id: 'admin.plugins', name: 'Plugins', area: 'Admin', endpoints: ['*Plugin*'], screens: ['/admin/plugins', '/admin/plugins/:id'] },
  { id: 'admin.usage', name: 'Team usage and AI limits', area: 'Admin', endpoints: ['usage', '*Budget*'], screens: ['/admin/usage', '/admin/settings/limits'] },
  { id: 'admin.audit', name: 'Activity log', area: 'Admin', endpoints: ['audit'], screens: ['/admin/audit', '/admin/audit/:id'] },
  { id: 'admin.team-settings', name: 'Team settings: name, icon, time, data, members AI', area: 'Admin', endpoints: ['settings', 'updateSettings', 'putTeamIcon', 'deleteTeamIcon'], screens: ['/admin/settings', '/admin/settings/general', '/admin/settings/data', '/admin/settings/members'] },
  { id: 'admin.voice', name: 'Voice input settings', area: 'Admin', endpoints: ['speechHost', 'speechKey', 'setSpeechKey'], screens: ['/admin/settings/voice'] },
  { id: 'admin.dev-env', name: 'Dev environment for the team', area: 'Admin', endpoints: ['devEnvTeam', 'updateDevEnvTeam'], screens: ['/admin/settings/dev-env'] },

  // ---------------- System ----------------
  { id: 'system.storage', name: 'Storage use', area: 'System', endpoints: ['storage'], screens: ['/admin/system', '/admin/system/storage'] },
  { id: 'system.updates', name: 'Server updates', area: 'System', endpoints: ['updateStatus', 'startUpdate', 'officeUpdateStatus', 'officeUpdateAction'], screens: ['/admin/system/updates'] },
  { id: 'system.health', name: 'Health and diagnostics', area: 'System', endpoints: ['diagnostics'], screens: ['/admin/system/health'] },
  { id: 'system.connection', name: 'Team address and office network', area: 'System', endpoints: ['connection', 'updateConnection', 'connectInfo', 'lanFailure'], screens: ['/admin/system/connection'] },
  { id: 'system.backups', name: 'Backups and restore', area: 'System', endpoints: ['listBackups', 'startBackup', 'startRestore'], screens: ['/admin/system/backups'] },
  { id: 'system.export', name: 'Export the team data', area: 'System', endpoints: ['startExport'], screens: ['/admin/system/export'] },

  // ---------------- Apps & hosting (no endpoint or screen of their own: QA rows only) ----------------
  { id: 'app.desktop-mac', name: 'Mac desktop app (window, menu bar, sign-in)', area: 'Apps & hosting', manual: true },
  { id: 'app.desktop-windows', name: 'Windows desktop app', area: 'Apps & hosting', manual: true },
  { id: 'app.desktop-updates', name: 'Desktop app updates', area: 'Apps & hosting', manual: true },
  { id: 'app.phone-ios', name: 'iPhone app', area: 'Apps & hosting', manual: true },
  { id: 'app.phone-android', name: 'Android app', area: 'Apps & hosting', manual: true },
  { id: 'app.store-listings', name: 'App Store, Play Store and Mac App Store listings', area: 'Apps & hosting', manual: true },
  { id: 'app.app-links', name: 'App links (open trina.app links in the app)', area: 'Apps & hosting', manual: true },
  { id: 'app.ai-file-access', name: 'AI file access on the computer (install, sandbox)', area: 'Apps & hosting', manual: true },
  { id: 'app.claude-sign-in', name: 'Claude Code / Codex sign-in on the server', area: 'Apps & hosting', manual: true },
  { id: 'hosting.cloud', name: 'Hosted teams (trina.app cloud)', area: 'Apps & hosting', manual: true },
  { id: 'hosting.self-install', name: 'Self-hosting: Linux, Docker and office Mac installs', area: 'Apps & hosting', manual: true },
  { id: 'hosting.relay', name: 'Relay (reach a team server from outside)', area: 'Apps & hosting', manual: true },
  { id: 'hosting.push-gateway', name: 'Push gateway', area: 'Apps & hosting', manual: true },
  { id: 'hosting.release', name: 'Releases and server update channel', area: 'Apps & hosting', manual: true },
  { id: 'security.prompt-injection', name: 'Prompt injection and safe operations', area: 'Apps & hosting', manual: true },
  { id: 'site.website-docs', name: 'Website and docs site', area: 'Apps & hosting', manual: true },
]
