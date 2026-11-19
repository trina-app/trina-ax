// Who sees a shared chat now, from the chat alone (docs/decisions/20261118-devenv-shared-jobs-mac-localhost.md): a
// shared chat's job or dev server lives past its turn, so the tracker, the start of a waiting job, the preview and the
// reach check build the chat's people again from the database, as the turn does (chat/turn.ts sharedAudience): a
// shared project chat's people are its project's audience (chatAudienceOf), a chat shared with people and groups its
// creator and the active people in it (peopleAudience). A chat that is not shared any more, or is gone: null, and the
// run stops (srt/runner.ts accessHash is 'off' with nobody in it). Registered by routes/dev-env.ts (no import cycle
// with the runner).
import type { AppContext } from '../context'
import { isPeopleRow, peopleAudience } from '../chat/chat-audience'
import { chatAudienceOf, isSharedRow } from '../chat/shared'
import { PROJECT_COLS, type ProjectRow } from '../chat/store'
import type { SharedResolver } from './srt/runner'

interface ChatBits { id: string; user_id: string; project_id: string | null; shared_at: string | null; people_shared_at: string | null }

export const sharedChatResolver: SharedResolver = (ctx: AppContext, chatId: string) => {
  const c = ctx.db.query('SELECT id, user_id, project_id, shared_at, people_shared_at FROM chats WHERE id = ?').get(chatId) as ChatBits | null
  if (!c) return null
  if (isPeopleRow(c)) return { within: null, audience: () => peopleAudience(ctx.db, c) }
  if (!isSharedRow(c) || !c.project_id) return null
  const project = c.project_id
  const row = () => ctx.db.query(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ?`).get(project) as ProjectRow | null
  const p = row()
  if (!p || p.trashed_with) return null
  return { within: p.folder_path, audience: () => { const now = row(); return now && !now.trashed_with && now.folder_path === p.folder_path ? chatAudienceOf(ctx.db, ctx.files, now, c.user_id) : [] } }
}
