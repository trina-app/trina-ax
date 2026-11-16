// How many things wait for this person's review in Team skills: suggestions for the skills folders they manage and
// share proposals to their groups (GET /api/skills/overview). The navigation's Team skills row shows it
// (panels/TrinaPanel.tsx, phone/TrinaDrawer.tsx), as a room shows its unread count. Read when the row first shows and
// when something says it changed: a suggestion came or was reviewed (skillsChanged: the server's skill_* notices and
// this window's own changes), a file changed under a skills folder (someone else registered one), or the server asked
// for a reload after a reconnect. No timer. 0 for a person who reviews nothing.
import { useEffect } from 'react'
import type { SkillsOverview } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { isSkillsPath } from '../lib/skillIssues'
import { rememberCached, useCachedRead } from './listCache'
import { filesChanged, reloadAsked, skillsChanged } from './live'

const KEY = 'skills:waiting'
/** a row that shows again within a minute (the phone's drawer opening) keeps the count it has; an event reads at once */
const FRESH_MS = 60_000

type Counts = Pick<SkillsOverview, 'pendingReview' | 'sharesToReview'>
export const skillsWaitingOf = (o: Counts) => o.pendingReview + (o.sharesToReview ?? 0)
const read = () => api.call(API.skillsOverview).then(skillsWaitingOf)

/** The Team skills page read the overview itself: the navigation's count follows it. */
export const rememberSkillsWaiting = (o: Counts) => rememberCached(KEY, skillsWaitingOf(o))

export function useSkillsWaiting(on = true): number {
  const { data, reload } = useCachedRead<number>(on ? KEY : null, read, { minAgeMs: FRESH_MS })
  useEffect(() => {
    if (!on) return
    const again = () => void reload()
    const offs = [
      skillsChanged.on(again),
      reloadAsked.on(again),
      filesChanged.on((changes) => { if (changes.some((c) => isSkillsPath(c.path) || (c.from && isSkillsPath(c.from)))) again() }),
    ]
    return () => offs.forEach((off) => off())
  }, [on, reload])
  return on ? data ?? 0 : 0
}
