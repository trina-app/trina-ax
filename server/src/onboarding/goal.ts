// The 7-day team goal (docs/DECISIONS.md "G — The 7-day team goal"; contract shared/src/api/onboarding-goal.ts): within
// GOAL_DAYS of the team's start, GOAL_PEOPLE or more different people (the owner included) each ran the SAME team
// skill at least once. The one number a trial chases; Home shows it to owners and admins, the owners hear about each
// member's first run, and the hosting operator gets the counts (onboarding/tenant-status.ts).
//
// What counts:
//   - a run: "/name" (a skill form too) or the skill tool loading it (turn_skill_runs, migration 223), never a plain
//     read of the SKILL.md;
//   - in a successful answer only (turns.status 'done'; a per-answer limit also ends 'done' with the answer so far),
//     never a scheduled run (nobody was there);
//   - started inside the window: [team start, team start + 7 days). The team's start is its first account (the owner
//     made at setup), deleted accounts included; not the audit log, which is pruned;
//   - team skills only, keyed by path: personal skills are never recorded (admin/skill-usage.ts). A personal skill of
//     the same name takes the team skill's place for its owner ("/name" runs it), so that person's run does not count
//     for the team skill. Renaming or moving a skill gives it a new path: runs before and after count as two skills;
//   - people deleted later still count (turns stay; a deleted account is a tombstone), but their names are not shown.
import type { Database } from 'bun:sqlite'
import { GOAL_DAYS, GOAL_PEOPLE, type TeamGoal } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { getSetting, setSetting } from '../admin/settings'
import { notificationsOf } from '../notifications/service'
import { titleFor } from './goal-names'

const DAY_MS = 86_400_000
/** after the window, a reached goal's "달성했어요" stays this long, only for a team that saw the card in its window */
export const REACHED_GRACE_MS = 7 * DAY_MS
/** set the first time an owner or admin is served the card (settings row): a team that never saw it never gets the
 * "reached" state after its window (an existing team after an update) */
export const GOAL_SHOWN_KEY = 'onboarding.goalShownAt'

/** When the team started: its first account (setup), deleted accounts included. null: no account yet. */
export function teamStartedAt(db: Database): string | null {
  const r = db.query('SELECT MIN(created_at) AS at FROM users').get() as { at: string | null } | null
  if (!r?.at) return null
  const ms = Date.parse(r.at)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

export interface GoalWindow { startedAt: string; endsAt: string }
export function goalWindow(db: Database): GoalWindow | null {
  const startedAt = teamStartedAt(db)
  return startedAt ? { startedAt, endsAt: new Date(Date.parse(startedAt) + GOAL_DAYS * DAY_MS).toISOString() } : null
}

/** One team skill and the people who ran it: each person once, by their first run, first run first. */
export interface SkillRunners { path: string; name: string; people: { userId: string; at: string }[] }

/** The SQL condition of a run that counts (t = turns, r = turn_skill_runs), with the window as two parameters. */
const COUNTED = `t.status = 'done' AND t.schedule_id IS NULL AND t.started_at >= ? AND t.started_at < ?`

/**
 * The team skills run in [from, to), most people first (ties: the one that got to that many first, then the path).
 * `name`: the skill's name as last recorded in the window.
 */
export function skillRunners(db: Database, from: string, to: string): SkillRunners[] {
  // person by person through turns(user_id, started_at), then the run rows of those turns (their primary key): the
  // work is the window's turns, never every run or turn of an older team (CROSS JOIN keeps SQLite to that order)
  const rows = db.query(`SELECT r.skill_path AS path, t.user_id AS userId, MIN(t.started_at) AS at, MAX(t.started_at || char(9) || r.skill_name) AS last
    FROM users u CROSS JOIN turns t ON t.user_id = u.id CROSS JOIN turn_skill_runs r ON r.turn_id = t.id
    WHERE ${COUNTED} GROUP BY r.skill_path, t.user_id ORDER BY at, t.user_id`).all(from, to) as { path: string; userId: string; at: string; last: string }[]
  // the name last recorded for a path in the window (a rename of the skill's `name` keeps its path)
  const names = new Map<string, { at: string; name: string }>()
  for (const r of rows) {
    const tab = r.last.indexOf('\t'), at = r.last.slice(0, tab), name = r.last.slice(tab + 1) || r.path
    const had = names.get(r.path)
    if (!had || at > had.at) names.set(r.path, { at, name })
  }
  const by = new Map<string, SkillRunners>()
  for (const r of rows) {
    let s = by.get(r.path)
    if (!s) by.set(r.path, (s = { path: r.path, name: names.get(r.path)?.name ?? r.path, people: [] }))
    s.people.push({ userId: r.userId, at: r.at })
  }
  return [...by.values()].sort((a, b) => b.people.length - a.people.length
    || a.people[a.people.length - 1]!.at.localeCompare(b.people[b.people.length - 1]!.at) || a.path.localeCompare(b.path))
}

export interface GoalProgress extends GoalWindow {
  /** the skill most people ran (null: none yet) */
  best: SkillRunners | null
  /** when the GOAL_PEOPLE-th person first ran one skill (the earliest such skill); null: not reached */
  reachedAt: string | null
  /** people who ran any team skill in the window */
  peopleWithRun: number
  /** who they are (ids): the goal card's "joined and has not tried a skill yet" leaves them out */
  runnerIds: ReadonlySet<string>
  /** people with any successful answer in the window */
  peopleAnswered: number
}

/** The goal's numbers for this team (null: no account yet). Counts inside the window whatever the time is now. */
export function goalProgress(db: Database): GoalProgress | null {
  const w = goalWindow(db)
  if (!w) return null
  const skills = skillRunners(db, w.startedAt, w.endsAt)
  const reached = skills.filter((s) => s.people.length >= GOAL_PEOPLE).map((s) => s.people[GOAL_PEOPLE - 1]!.at).sort()
  const runners = new Set(skills.flatMap((s) => s.people.map((p) => p.userId)))
  // per person, through turns(user_id, started_at): no scan of every turn of an older team
  const answered = (db.query(`SELECT COUNT(*) AS n FROM users u WHERE EXISTS (SELECT 1 FROM turns t WHERE t.user_id = u.id AND ${COUNTED})`)
    .get(w.startedAt, w.endsAt) as { n: number }).n
  return { ...w, best: skills[0] ?? null, reachedAt: reached[0] ?? null, peopleWithRun: runners.size, runnerIds: runners, peopleAnswered: answered }
}

/** Names of the accounts still there, in the given order (deleted accounts are counted, never named). */
function namesOf(db: Database, ids: string[]): string[] {
  const out: string[] = []
  for (const id of ids) {
    const u = db.query('SELECT name FROM users WHERE id = ? AND deleted_at IS NULL').get(id) as { name: string } | null
    if (u) out.push(u.name)
  }
  return out
}

/**
 * While the goal is open: the people who joined, and of them (the viewer left out) the ones who have run no team skill
 * at all in the window (`ran`: the people who ran one), so "○○님이 들어왔지만 '광고 문구'는 아직이에요" never names
 * someone who already tried another team skill. Joined = an account after
 * the team's first one, still there, active, that signed in at least once (an account made for someone who never
 * came in has not joined). The earliest to join is named, the rest only counted (docs/DECISIONS.md "Y — Home shows
 * one thing at a time": never a list of who has not run it).
 */
export function joinedNotRun(db: Database, viewerId: string, w: GoalWindow, ran: ReadonlySet<string>): { joined: number; waiting: { first: string; more: number } | null } {
  const rows = db.query(`SELECT id, name FROM users WHERE deleted_at IS NULL AND status = 'active' AND last_seen_at IS NOT NULL
    AND created_at >= ? AND created_at < ? AND id <> (SELECT id FROM users ORDER BY created_at, rowid LIMIT 1)
    ORDER BY created_at, rowid`).all(w.startedAt, w.endsAt) as { id: string; name: string }[]
  const left = rows.filter((r) => r.id !== viewerId && !ran.has(r.id))
  return { joined: rows.length, waiting: left.length ? { first: left[0]!.name, more: left.length - 1 } : null }
}

/**
 * The card for an owner or admin (the route checks the role), or null when there is nothing to show:
 *   - open: the window runs and the goal is not reached;
 *   - reached: reached in the window; shown while the window runs, and after it for REACHED_GRACE_MS only when the
 *     team was served the card in its window (GOAL_SHOWN_KEY), so an older team never gets it after an update;
 *   - else null (the window ended without the goal; a team older than the goal).
 */
export function teamGoal(ctx: AppContext, viewerId: string, now = new Date()): TeamGoal | null {
  // the window and the marker first (cheap): a team past its window that never saw the card, or past the grace, is not
  // counted at all (every owner or admin Home visit asks)
  const w = goalWindow(ctx.db)
  if (!w) return null
  const t = now.getTime(), end = Date.parse(w.endsAt)
  const open = t < end
  if (!open && (t >= end + REACHED_GRACE_MS || !getSetting(ctx.db, GOAL_SHOWN_KEY))) return null
  const p = goalProgress(ctx.db)
  if (!p || (!open && !p.reachedAt)) return null
  if (open && !getSetting(ctx.db, GOAL_SHOWN_KEY)) setSetting(ctx.db, GOAL_SHOWN_KEY, now.toISOString())
  const best = p.best
  const goal: TeamGoal = {
    state: p.reachedAt ? 'reached' : 'open',
    target: GOAL_PEOPLE, days: GOAL_DAYS,
    startedAt: p.startedAt, endsAt: p.endsAt,
    daysLeft: Math.max(0, Math.ceil((end - t) / DAY_MS)),
    skill: best ? { path: best.path, name: titleFor(ctx, viewerId, best.path, best.name), runners: best.people.length, people: namesOf(ctx.db, best.people.map((x) => x.userId)) } : null,
    reachedAt: p.reachedAt,
  }
  // who joined and has not run it: only while the goal is open (in the window, not reached)
  if (goal.state === 'open' && open) Object.assign(goal, joinedNotRun(ctx.db, viewerId, p, p.runnerIds))
  return goal
}

/**
 * After an answer ended (chat/turn.ts): when it was a member's FIRST successful run of a team skill inside the
 * window, the active owners (not the member) get "○○님이 '광고 문구'를 처음 써 봤어요 (2/3)": once per member per
 * skill (the first such answer to finish; UNIQUE(user_id, member_id, skill_path) besides). Never throws.
 */
export function noteGoalRun(ctx: AppContext, turnId: string, now = new Date()): void {
  try {
    const db = ctx.db
    const w = goalWindow(db)
    if (!w || now.toISOString() >= w.endsAt) return
    const turn = db.query(`SELECT t.id, t.user_id AS userId, t.started_at AS startedAt FROM turns t WHERE t.id = ? AND ${COUNTED}`)
      .get(turnId, w.startedAt, w.endsAt) as { id: string; userId: string; startedAt: string } | null
    if (!turn) return
    const runs = db.query('SELECT skill_path AS path FROM turn_skill_runs WHERE turn_id = ?').all(turnId) as { path: string }[]
    if (!runs.length) return
    const owners = (db.query("SELECT id FROM users WHERE role = 'owner' AND status = 'active' AND deleted_at IS NULL").all() as { id: string }[])
      .map((o) => o.id).filter((id) => id !== turn.userId)
    if (!owners.length) return
    for (const run of runs) {
      // another successful run of this skill by this person, already finished: this one is not the first
      const earlier = db.query(`SELECT 1 FROM turns t CROSS JOIN turn_skill_runs r ON r.turn_id = t.id AND r.skill_path = ?
        WHERE t.user_id = ? AND t.id <> ? AND ${COUNTED} LIMIT 1`).get(run.path, turn.userId, turn.id, w.startedAt, w.endsAt)
      if (earlier) continue
      const { n } = db.query(`SELECT COUNT(DISTINCT t.user_id) AS n FROM turn_skill_runs r JOIN turns t ON t.id = r.turn_id
        WHERE r.skill_path = ? AND ${COUNTED}`).get(run.path, w.startedAt, w.endsAt) as { n: number }
      for (const owner of owners) notificationsOf(ctx).goalFirstRun(owner, { turnId: turn.id, memberId: turn.userId, skillPath: run.path, runners: Math.max(1, n) }, now.toISOString())
    }
  } catch (e) {
    ctx.log.warn('onboarding goal notice failed', { err: e, turn: turnId })
  }
}
