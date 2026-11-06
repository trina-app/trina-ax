// The one suggestion under a result (docs/DECISIONS.md "X — Lean onboarding"; contract ResultSuggestion in
// shared/src/api/onboarding-welcome.ts). At most one line, chosen by state, never two at once:
//   - the lead's first result keeps the welcome invite bar (decided in the web app, before asking here);
//   - the same person ran the same team skill for at least the 2nd time (successful answers, never a scheduled run),
//     nothing scheduled runs it yet, and its work comes back every week (metadata `recurring: weekly`: the weekly
//     report, competitor brief and meeting tasks, and team skills drafted from weekly work; never one-off work such as
//     ad copy or a quote; docs/DECISIONS.md "S"): "매주 이 시간에 자동으로 받을까요?" [예약하기] (the web app sends the
//     request to the AI, which makes the task through its schedule card: the one way tasks are made);
//   - an owner's or admin's answer that used team files and ran no team skill, which S's rules let become a team skill
//     (skill-draft.ts teamSkillOffer): "이 방식대로 팀 스킬로 만들까요?" [팀 스킬로 만들기] (the web app opens the skill
//     card; docs/DECISIONS.md "W3"); before the PPT: it is the landing's promise, and rarer;
//   - a long report-like answer (the weekly report, or PPT_SUGGEST_CHARS of prose or more): [PPT로 만들기].
// The promo video made from the intro deck (`deck-video`, docs/DECISIONS.md "D2") is in the contract but never offered
// while DECK_VIDEO_SUGGESTION is off: the background run that makes the video is not built yet.
// A suggestion the person closed never comes back for them (suggestion_dismissals, migration 229, per person).
import { DECK_ARTIFACT_KEY, DECK_VIDEO_SUGGESTION, PPT_SUGGEST_CHARS, REPORT_SKILLS, type ResultSuggestion } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { isRecurring, readSkill, type Skill } from '../chat/skills'
import type { ChatRuntime } from '../chat/runtime'
import { RECURRING_PACK_SKILLS } from './skill-packs'
import { teamSkillOffer } from './skill-draft'

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

/** The skill's work comes back every week: its metadata says `recurring: weekly`. A file without the key (a starter pack
 * skill installed before the line existed, or one this person cannot read now) is read as the pack says. */
function recurring(ctx: Pick<AppContext, 'db' | 'files'>, userId: string, path: string): boolean {
  let s: Skill | null = null
  try { s = readSkill(ctx.files, ctx.files.principal(userId), path) } catch { s = null }
  if (s && s.recurring !== undefined) return isRecurring(s)
  return RECURRING_PACK_SKILLS.has(path)
}

/** A report: the weekly report skill, or a long answer (prose only: code blocks do not make a slide deck). */
export function reportLike(content: string, skillName: string | null): boolean {
  if (skillName && (REPORT_SKILLS as readonly string[]).includes(skillName.toLowerCase())) return true
  return content.replace(/```[\s\S]*?(?:```|$)/g, '').trim().length >= PPT_SUGGEST_CHARS
}

/** The suggestion under one answer of the caller's own chat, or null. 404 for a chat that is not theirs. Without the
 * chat runtime (`rt`), no team skill is offered. */
export function resultSuggestion(ctx: AppContext, userId: string, chatId: string, messageId: string, rt?: ChatRuntime): ResultSuggestion | null {
  if (!ctx.db.query('SELECT 1 FROM chats WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(chatId, userId)) fail('not_found')
  const turn = ctx.db.query('SELECT id, status, schedule_id FROM turns WHERE chat_id = ? AND message_id = ? AND user_id = ?').get(chatId, messageId, userId) as
    { id: string; status: string; schedule_id: string | null } | null
  // a finished answer the person asked for (a scheduled run already is one)
  if (!turn || turn.status !== 'done' || turn.schedule_id) return null
  const no = closed(ctx, userId)
  // the promo video from the intro deck: off (DECK_VIDEO_SUGGESTION), so never returned. The intended order once it is
  // on: under the first deck this line comes first ("이 소개서로 10초 홍보 영상도 만들어 둘까요? 끝나면 알려 드려요"
  // [만들어 두기] ×), and the [팀에 공유] bar takes its place once it is answered, so there is still one line ("X"). The
  // web app asks here before it shows the invite bar then.
  if (DECK_VIDEO_SUGGESTION && !no.has('deck-video') && madeDeck(ctx, chatId, messageId)) return { kind: 'deck-video', key: 'deck-video' }
  // the team skill this answer ran: "/name" (a form too) before the skill tool
  const run = ctx.db.query(`SELECT skill_path AS path, skill_name AS name FROM turn_skill_runs WHERE turn_id = ?
    ORDER BY source = 'command' DESC, skill_path LIMIT 1`).get(turn.id) as { path: string; name: string } | null
  if (run) {
    const key = `schedule:${run.path}`
    if (!no.has(key) && ranTwice(ctx, userId, run.path) && !scheduled(ctx, userId, run.path, run.name) && recurring(ctx, userId, run.path))
      return { kind: 'schedule', key, skill: { path: run.path, name: run.name } }
  }
  if (!run && rt && !no.has('team-skill') && teamSkillOffer(ctx, rt, userId, chatId, messageId)) return { kind: 'team-skill', key: 'team-skill' }
  if (!no.has('ppt')) {
    const m = ctx.db.query("SELECT content FROM messages WHERE id = ? AND chat_id = ? AND role = 'assistant'").get(messageId, chatId) as { content: string } | null
    if (m && reportLike(m.content, run?.name ?? null)) return { kind: 'ppt', key: 'ppt' }
  }
  return null
}

/** This answer made an intro deck (the chat's artifact under DECK_ARTIFACT_KEY, saved with this message). */
function madeDeck(ctx: Db, chatId: string, messageId: string): boolean {
  return !!ctx.db.query('SELECT 1 FROM artifacts WHERE chat_id = ? AND message_id = ? AND key = ? LIMIT 1').get(chatId, messageId, DECK_ARTIFACT_KEY)
}

/** Close a suggestion for good, for this person. */
export function dismissSuggestion(ctx: Db, userId: string, key: string): void {
  ctx.db.query('INSERT INTO suggestion_dismissals (user_id, key, dismissed_at) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO NOTHING').run(userId, key, new Date().toISOString())
}
