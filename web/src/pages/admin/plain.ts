// What Admin › Home and Admin › Providers leave to Diagnostics (Admin › System). Admins are office workers, not
// developers: Home lists only what an admin can act on, in plain words ("No AI is connected", a service to sign in
// again, a disk filling up); the server's internals (an engine version other than the pinned or lockdown-tested one,
// socket paths, the sandbox, the launcher and the like) are shown in Diagnostics only, with their detail there.
import type { DiagnosticCheck, EngineStatus } from '@mycel/shared/api'
import type { MessageKey } from '../../i18n'

/** Engine states that are about the program's version or its lockdown test: the engine still answers, so Home and
 * Providers treat it as working, and Diagnostics names the state with its detail. */
const TECHNICAL_ENGINE_STATES: EngineStatus['status'][] = ['version_unsupported', 'lockdown_failed']
export const technicalEngineState = (s: EngineStatus['status']) => TECHNICAL_ENGINE_STATES.includes(s)

/** A server check Home may name: an engine's sign-in, the disk and storage, backups, a failed update. The rest
 * (sockets, sandbox, launcher, relay, queue, managed files, …) is for Diagnostics only. */
export const homeCheck = (c: Pick<DiagnosticCheck, 'id' | 'group'>) =>
  c.id.startsWith('engine.') || c.group === 'disk' || c.id === 'backups' || c.id === 'restore' || c.id === 'update'

/** Diagnostics rows for the engines whose version or lockdown test the Providers page no longer shows. */
export function engineVersionChecks(engines: EngineStatus[], t: (k: MessageKey, v?: Record<string, string | number>) => string): DiagnosticCheck[] {
  return engines.filter((e) => e.enabled && technicalEngineState(e.status)).map((e) => ({
    id: `engine-version.${e.id}`,
    group: 'engines',
    label: t('adminHome.item', { name: e.label, state: t(`engines.status.${e.status}` as MessageKey) }),
    status: e.status === 'lockdown_failed' ? 'fail' : 'warn',
    detail: e.detail,
  }))
}
