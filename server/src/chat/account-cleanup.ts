// Component B's part of a deleted account (auth/account-removal.ts; registered by routes/chats.ts init): the person's
// notices, phone push devices and settings, schedules, site grants, dev-environment rows and onboarding drafts. Chats
// and memories are not here: they go at removal when the person asked for it, else after the chat retention days
// (auth/sweeper.ts).
import type { AppContext } from '../context'
import { registerAccountCleanup } from '../auth/account-removal'

export function registerChatAccountCleanup(ctx: AppContext): void {
  registerAccountCleanup(ctx, {
    name: 'chat',
    rows: [
      'notification_inbox.user_id', 'notification_preferences.user_id', 'push_preferences.user_id', 'push_subscriptions.user_id',
      'chat_answer_notices.user_id', 'chat_card_approvals.user_id', 'chat_queue_users.user_id', 'browser_site_grants.user_id', 'chat_allowed_sites.user_id',
      'project_notices.user_id', 'room_notices.user_id', 'room_app_notices.user_id', 'room_app_leaver_notices.user_id', 'room_thread_follows.user_id', 'room_hidden_answers.user_id', 'room_ai_grants.user_id',
      'schedule_outcomes.user_id', 'schedule_project_skips.user_id', 'schedule_template_requests.user_id', 'schedule_template_skips.user_id', 'schedules.user_id',
      'dev_env_jobs.user_id', 'dev_env_notices.user_id', 'dev_env_runs.user_id', 'dev_env_site_grants.user_id', 'dev_env_user_net.user_id',
      'suggestion_dismissals.user_id', 'skill_notices.user_id', 'skill_merge_notices.user_id', 'service_request_notices.user_id', 'service_request_closed_notices.user_id', 'stored_key_file_notices.user_id',
      'integration_request_notices.user_id', 'integration_template_notices.user_id', 'integration_template_offers.user_id', 'drive_share_notices.user_id',
      'onboarding_file_ranks.user_id', 'onboarding_goal_notices.user_id', 'onboarding_notices.user_id', 'onboarding_profile_drafts.user_id', 'onboarding_skill_drafts.user_id',
      // chats shared with people and groups (chat/people-share.ts): their "Hide from my list" rows, their Inbox notices and
      // that they were in one (chat_audience_past: chat/chat-audience.ts)
      'chat_list_hidden.user_id', 'chat_share_notices.user_id', 'chat_audience_past.user_id', 'chat_lost_notices.user_id',
      // threads on AI answers (chat/threads.ts): what they follow and their notices; their replies stay (KEPT_WITH_ACCOUNT)
      'chat_thread_follows.user_id', 'chat_thread_notices.user_id',
      // "Ask for access" on a chat's or project's link (chat/access-requests.ts): their asks and their Activity rows
      'access_requests.requester_id', 'access_request_notices.user_id',
      // what their AI read in chats (chat/carried-reads.ts): paths and hashes of their turns
      'chat_reads.user_id',
      // the AI's questions waiting for their answer (chat/open-questions.ts)
      'open_questions.user_id',
      // the summaries of older chat parts made for them (chat/history-summary.ts)
      'chat_summaries.user_id',
    ],
    // and they leave every chat's audience they were named in (chat_audience: a subject, not a users(id) column; their
    // messages there stay under the tombstone name). removeAccount does it in its own write too; this covers accounts
    // deleted before this build. Their own people-shared chats go with their other chats (auth/sweeper.ts)
    after: (c, userId) => { c.db.query("DELETE FROM chat_audience WHERE subject_type = 'user' AND subject_id = ?").run(userId) },
  })
}
