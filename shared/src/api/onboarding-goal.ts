// The 7-day team goal (docs/DECISIONS.md "G — The 7-day team goal"), the one thing a trial chases: within 7 days of
// the team's start, 3 or more different people (the owner included) each ran the SAME team skill at least once.
// Counted by the server (server/src/onboarding/goal.ts): successful answers only, "/name" (a skill form too) or the
// skill tool, never a plain read of the file; personal skills never; people deleted later still count. Route module:
// server/src/routes/onboarding-goal.ts. Home shows it to owners and admins (web/src/components/onboarding/GoalCard.tsx):
// one line of what to do next, with at most one name of someone who joined and has not run the skill yet.
import { z } from 'zod'
import { IsoTime } from './common'
import { endpoint } from './endpoint'

/** the goal's window, in days from the team's start (its first account) */
export const GOAL_DAYS = 7
/** different people who ran the same team skill */
export const GOAL_PEOPLE = 3

export const TeamGoal = z.object({
  /** open: the window runs and the goal is not reached yet · reached: reached (shown until dismissed, at most 7 days
   * after the window for a team that saw the card) */
  state: z.enum(['open', 'reached']),
  /** GOAL_PEOPLE and GOAL_DAYS as this server counts them */
  target: z.number().int().positive(),
  days: z.number().int().positive(),
  /** the team's start (its first account) and the end of the window */
  startedAt: IsoTime,
  endsAt: IsoTime,
  /** whole days left in the window, rounded up (0 once it ended) */
  daysLeft: z.number().int().nonnegative(),
  /** the team skill most people ran in the window (ties: the one that got there first); null while nobody has run one */
  skill: z.object({
    path: z.string(),
    /** its plain name for people: the description's lead ("광고 문구") or the skill's name */
    name: z.string(),
    /** different people who ran it, deleted accounts included */
    runners: z.number().int().nonnegative(),
    /** the names of those people whose accounts are still there, first run first (never who has not run it) */
    people: z.array(z.string()),
  }).nullable(),
  reachedAt: IsoTime.nullable(),
  /** open goals only (absent otherwise): the people who joined (the accounts after the team's first one that signed
   * in and are still there), for "아직 아무도 안 들어왔어요" */
  joined: z.number().int().nonnegative().optional(),
  /** open goals only (absent otherwise): who joined but has run no team skill yet in the window (someone who tried
   * another team skill is not named as not having tried `skill`), the viewer left out: the first to join by name and the others as a count, never a list
   * (docs/DECISIONS.md "Y — Home shows one thing at a time"); null when nobody waits */
  waiting: z.object({ first: z.string(), more: z.number().int().nonnegative() }).nullable().optional(),
})
export type TeamGoal = z.infer<typeof TeamGoal>

export const TeamGoalResponse = z.object({
  /** null: nothing to show (the window ended without the goal, the team is older than the goal, or a reached goal's
   * time is over) */
  goal: TeamGoal.nullable(),
})
export type TeamGoalResponse = z.infer<typeof TeamGoalResponse>

export const ONBOARDING_GOAL = {
  getTeamGoal: endpoint({ method: 'GET', path: '/api/onboarding/goal', auth: 'admin', owner: 'B', response: TeamGoalResponse,
    summary: 'The 7-day team goal (3 people ran the same team skill) for owners and admins: progress, days left, the top skill and who ran it; while it is open, how many joined and the first of those who have not run it yet.' }),
} as const
