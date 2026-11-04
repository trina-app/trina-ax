// The one suggestion under a result (docs/DECISIONS.md "X — Lean onboarding"; contract ResultSuggestion in
// shared/src/api/onboarding-welcome.ts). At most one line, chosen by state, never two at once:
//   - the lead's first result keeps the welcome invite bar (decided in the web app, before asking here);
//   - the same person ran the same team skill for at least the 2nd time (successful answers, never a scheduled run)
//     and nothing scheduled runs it yet: "매주 이 시간에 자동으로 받을까요?" [예약하기] (the web app sends the request to
//     the AI, which makes the task through its schedule card: the one way tasks are made);
//   - a long report-like answer (the weekly report, or PPT_SUGGEST_CHARS of prose or more): [PPT로 만들기].
// A suggestion the person closed never comes back for them (suggestion_dismissals, migration 229, per person).
import { PPT_SUGGEST_CHARS, REPORT_SKILLS, type ResultSuggestion } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'

type Db = Pick<AppContext, 'db'>

/** The keys this person closed. */
function closed(ctx: Db, userId: string): Set<string> {
  return new Set((ctx.db.query('SELECT key FROM suggestion_dismissals WHERE user_id = ?').all(userId) as { key: string }[]).map((r) => r.key))
}

/** The person ran this team skill in at least two successful answers of their own (not scheduled runs). Stops at two. */
function ranTwice(ctx: Db, userId: string, path: string): boolean {
  const r = ctx.db.query(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM turn_skill_runs r JOIN turns t ON t.id = r.turn_id
    WHERE r.skill_path = ? AND t.user_id = ? AND t.status = 'done' AND t.schedule_id IS NULL LIMIT 2)`).get(path, userId) as { n: number }
  return r.n >= 2
}

/** One of the person's scheduled tasks runs this skill already: its instruction starts with "/<name>", or one of its
 * runs ran the skill. */
function scheduled(ctx: Db, userId: string, path: string, name: string): boolean {
  const cmd = `/${name}`.normalize('NFC').toLowerCase()
  const prompts = ctx.db.query('SELECT prompt FROM schedules WHERE user_id = ?').all(userId) as { prompt: string }[]
  if (prompts.some((s) => { const p = s.prompt.trim().normalize('NFC').toLowerCase(); return p === cmd || (p.startsWith(cmd) && /\s/.test(p[cmd.length] ?? '')) })) return true
  return !!ctx.db.query(`SELECT 1 FROM turn_skill_runs r JOIN turns t ON t.id = r.turn_id
    WHERE r.skill_path = ? AND t.user_id = ? AND t.schedule_id IS NOT NULL LIMIT 1`).get(path, userId)
}

/** A report: the weekly report skill, or a long answer (prose only: code blocks do not make a slide deck). */
export function reportLike(content: string, skillName: string | null): boolean {
  if (skillName && (REPORT_SKILLS as readonly string[]).includes(skillName.toLowerCase())) return true
  return content.replace(/```[\s\S]*?(?:```|$)/g, '').trim().length >= PPT_SUGGEST_CHARS
}

/** The suggestion under one answer of the caller's own chat, or null. 404 for a chat that is not theirs. */
export function resultSuggestion(ctx: Db, userId: string, chatId: string, messageId: string): ResultSuggestion | null {
  if (!ctx.db.query('SELECT 1 FROM chats WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(chatId, userId)) fail('not_found')
  const turn = ctx.db.query('SELECT id, status, schedule_id FROM turns WHERE chat_id = ? AND message_id = ? AND user_id = ?').get(chatId, messageId, userId) as
    { id: string; status: string; schedule_id: string | null } | null
  // a finished answer the person asked for (a scheduled run already is one)
  if (!turn || turn.status !== 'done' || turn.schedule_id) return null
  const no = closed(ctx, userId)
  // the team skill this answer ran: "/name" (a form too) before the skill tool
  const run = ctx.db.query(`SELECT skill_path AS path, skill_name AS name FROM turn_skill_runs WHERE turn_id = ?
    ORDER BY source = 'command' DESC, skill_path LIMIT 1`).get(turn.id) as { path: string; name: string } | null
  if (run) {
    const key = `schedule:${run.path}`
    if (!no.has(key) && ranTwice(ctx, userId, run.path) && !scheduled(ctx, userId, run.path, run.name))
      return { kind: 'schedule', key, skill: { path: run.path, name: run.name } }
  }
  if (!no.has('ppt')) {
    const m = ctx.db.query("SELECT content FROM messages WHERE id = ? AND chat_id = ? AND role = 'assistant'").get(messageId, chatId) as { content: string } | null
    if (m && reportLike(m.content, run?.name ?? null)) return { kind: 'ppt', key: 'ppt' }
  }
  return null
}

/** Close a suggestion for good, for this person. */
export function dismissSuggestion(ctx: Db, userId: string, key: string): void {
  ctx.db.query('INSERT INTO suggestion_dismissals (user_id, key, dismissed_at) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO NOTHING').run(userId, key, new Date().toISOString())
}
