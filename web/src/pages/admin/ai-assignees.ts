// The team's AI connections that only one group or one person may use. Deleting that group or person switches them
// off rather than giving them to the whole team (server/src/credentials/assignees.ts), so the delete confirmation names
// them (Groups.tsx, Members.tsx).
import type { Credential, CredentialAssignment } from '@mycel/shared/api'
import { api, API } from '../../lib/api'

/** The team's AI connections for the delete confirmations, read with the page; none when they cannot be read (the
 * delete still switches them off: this only words the confirmation). */
export const loadConnections = (): Promise<Credential[]> => api.call(API.listCredentials).then((r) => r.items, () => [])

/** The names of the switched-on team connections assigned to this group or person alone. */
export function connectionsOnlyFor(items: readonly Credential[] | null | undefined, subject: CredentialAssignment): string[] {
  return (items ?? [])
    .filter((c) => c.scope === 'team' && !c.disabled && c.assignments.length > 0
      && c.assignments.every((a) => a.subjectType === subject.subjectType && a.subjectId === subject.subjectId))
    .map((c) => c.label)
}
