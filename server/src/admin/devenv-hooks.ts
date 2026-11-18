// The dev environment and access changes (docs/decisions/20261118-devenv-shared-chats.md): after every access change
// (a project's people saved, Admin › Folder permissions, groups, accounts) the running commands and jobs are checked
// against the new access at once (devenv/jobs.ts pollSrt), not at the next poll up to JOB_POLL_MS later: a shared chat's
// command stops as soon as someone who cannot read what it sees joins. Registered here, away from admin/folders.ts (no
// cycle), and imported for its effect by routes/chats.ts, like admin/guest-hooks.ts.
import { onAccessChange } from './folders'
import { pollSrt } from '../devenv/jobs'
import { devEnvFlag } from '../devenv/setting'
import type { AppContext } from '../context'

export const DEVENV_ACCESS_HOOK = (ctx: AppContext): void => { if (devEnvFlag()) void pollSrt(ctx).catch(() => {}) }
onAccessChange(DEVENV_ACCESS_HOOK)
