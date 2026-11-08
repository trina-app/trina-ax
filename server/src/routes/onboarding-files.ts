// Route module "onboarding-files" (docs/DECISIONS.md "W6 — Onboarding v6: 팀 파일 recommendations"). Implements
// ONBOARDING_FILES (shared/src/api/onboarding-files.ts): the AI's picks among the files of a folder an owner or admin
// picked on their computer (a no-tools turn of theirs, onboarding/file-rank.ts), and 팀 파일 recorded done when the
// step's upload run lands its first file (onboarding/team-files.ts). Owners and admins only (`auth: 'admin'`): the
// step is the owner's, and the file screen offers the same steps to admins once the setup is over.
import { API } from '@mycel/shared/api'
import { getChatRuntime } from '../chat/runtime'
import { rankTeamFiles, sweepFileRanks } from '../onboarding/file-rank'
import { recordTeamFilesLanded } from '../onboarding/team-files'
import type { RouteModule } from './module'

export const onboardingFilesRoutes: RouteModule = {
  name: 'onboarding-files',
  owner: 'B',
  register(kit, ctx) {
    // a pick chat a restart (or a turn still closing) left behind holds file names: it goes within minutes, whether or
    // not anyone picks again (each pick sweeps too)
    const sweep = () => { try { sweepFileRanks(ctx, getChatRuntime(ctx)) } catch { /* no runtime (yet), a closed database */ } }
    setTimeout(sweep, 60_000).unref?.()
    setInterval(sweep, 5 * 60_000).unref?.()
    kit.handle(API.rankTeamFiles, ({ c, body, auth }) => rankTeamFiles(ctx, getChatRuntime(ctx), auth.user, body.entries, c.get('locale'), { signal: c.req.raw.signal }))
    kit.handle(API.teamFilesLanded, ({ body, auth }) => ({ recorded: recordTeamFilesLanded(ctx, auth.user, body.path) }))
  },
}
