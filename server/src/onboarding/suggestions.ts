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
//   - a member's first successful run of the team's landing skill (onboarding/welcome.ts landingSkill: what the invite
//     link opens; docs/DECISIONS.md "MC"): "내가 쓰던 스킬이나 파일도 팀에 올릴래요?" [올리기], with the team folder they can
//     write (groups/<team>/, the welcome steps' group; else null: no files part). Owners and admins have 내 스킬
//     가져오기 instead. A phone (`phone`) without such a folder gets the next suggestion: there it would be only that link;
//   - a long report-like answer (PPT_SUGGEST_CHARS of prose or more): [PPT로 만들기].
// The promo video made from the intro deck (`deck-video`, docs/DECISIONS.md "D2") is in the contract but never offered
// while DECK_VIDEO_SUGGESTION is off: the background run that makes the video is not built yet.
// A suggestion the person closed never comes back for them (suggestion_dismissals, migration 229, per person).
import fs from 'node:fs'
import path from 'node:path'
import { DECK_ARTIFACT_KEY, DECK_VIDEO_SUGGESTION, PPT_SUGGEST_CHARS, type ResultSuggestion } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { atLeast, loadPrincipal, RuleSet } from '../policy/access'
import { landingSkill, readWelcome } from './welcome'
import { isRecurring, readSkill, type Skill } from '../chat/skills'
import type { ChatRuntime } from '../chat/runtime'
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

/** The skill's work comes back every week: its metadata says `recurring: weekly`. A file without the key, or one this
 * person cannot read now, does not (no pack skill that ships is weekly: docs/DECISIONS.md "DS3"). */
function recurring(ctx: Pick<AppContext, 'db' | 'files'>, userId: string, path: string): boolean {
  let s: Skill | null = null
  try { s = readSkill(ctx.files, ctx.files.principal(userId), path) } catch { s = null }
  return !!s && s.recurring !== undefined && isRecurring(s)
}

/** A report: a long answer (prose only: code blocks do not make a slide deck). */
export function reportLike(content: string): boolean {
  return content.replace(/```[\s\S]*?(?:```|$)/g, '').trim().length >= PPT_SUGGEST_CHARS
}

/** The suggestion under one answer of the caller's own chat, or null. 404 for a chat that is not theirs. Without the
 * chat runtime (`rt`), no team skill is offered. */
/** The member ran the landing skill in a successful answer of their own for the first time in this turn (scheduled runs
 * do not count): the earliest such turn is this one. */
function firstLandingRun(ctx: Db, userId: string, turnId: string, path: string): boolean {
  const first = ctx.db.query(`SELECT t.id FROM turn_skill_runs r JOIN turns t ON t.id = r.turn_id
    WHERE r.skill_path = ? AND t.user_id = ? AND t.status = 'done' AND t.schedule_id IS NULL ORDER BY t.started_at, t.rowid LIMIT 1`).get(path, userId) as { id: string } | null
  return first?.id === turnId
}

/** The team folder a member can put files in (docs/DECISIONS.md "MC", "M"): the welcome steps' team group's folder
 * (groups/<team>/: the team link puts joiners in that group) when they can write it, else the folder of another group
 * of theirs they can write; null when there is none (no files part). */
export function memberTeamFolder(ctx: AppContext, userId: string): string | null {
  const p = loadPrincipal(ctx.db, userId)
  if (!p) return null
  const rules = RuleSet.load(ctx.db)
  const writes = (folder: string) => {
    try { return atLeast(rules.access(p, folder.split('/')), 'write') && fs.statSync(path.join(ctx.files.fx.root, ...folder.split('/'))).isDirectory() } catch { return false }
  }
  let team: string | null = null
  try { team = readWelcome(ctx)?.teamGroup?.folder?.replace(/\/+$/, '') ?? null } catch { team = null }
  if (team && writes(team)) return team
  const own = ctx.db.query(`SELECT f.path FROM group_members m JOIN groups g ON g.id = m.group_id JOIN folders f ON f.id = g.folder_id
    WHERE m.user_id = ? ORDER BY g.name`).all(userId) as { path: string }[]
  return own.map((x) => x.path).find(writes) ?? null
}

export function resultSuggestion(ctx: AppContext, userId: string, chatId: string, messageId: string, rt?: ChatRuntime, o: { phone?: boolean } = {}): ResultSuggestion | null {
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
  // a member's first good run of the landing skill: their own skills and files (before the PPT: it comes once)
  if (run && !no.has('contribute') && isMember(ctx, userId)) {
    let landing: string | null = null
    try { landing = landingSkill(ctx) } catch { landing = null }
    if (landing && run.path === landing && firstLandingRun(ctx, userId, turn.id, landing)) {
      const folder = memberTeamFolder(ctx, userId)
      if (folder || !o.phone) return { kind: 'contribute', key: 'contribute', folder }
    }
  }
  if (!no.has('ppt')) {
    const m = ctx.db.query("SELECT content FROM messages WHERE id = ? AND chat_id = ? AND role = 'assistant'").get(messageId, chatId) as { content: string } | null
    if (m && reportLike(m.content)) return { kind: 'ppt', key: 'ppt' }
  }
  return null
}

const isMember = (ctx: Db, userId: string) => !!ctx.db.query("SELECT 1 FROM users WHERE id = ? AND role = 'member' AND status = 'active' AND deleted_at IS NULL").get(userId)

/** This answer made an intro deck (the chat's artifact under DECK_ARTIFACT_KEY, saved with this message). */
function madeDeck(ctx: Db, chatId: string, messageId: string): boolean {
  return !!ctx.db.query('SELECT 1 FROM artifacts WHERE chat_id = ? AND message_id = ? AND key = ? LIMIT 1').get(chatId, messageId, DECK_ARTIFACT_KEY)
}

/** Close a suggestion for good, for this person. */
export function dismissSuggestion(ctx: Db, userId: string, key: string): void {
  ctx.db.query('INSERT INTO suggestion_dismissals (user_id, key, dismissed_at) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO NOTHING').run(userId, key, new Date().toISOString())
}
