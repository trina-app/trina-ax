// The people a project is shared with when it becomes a team project (docs/DECISIONS.md "Share in the project's title
// row"): the picker with me fixed ("You"), the one count ("3 members", the server's dry run) and, once someone is picked,
// plainly what sharing does. One field for the two ways in: Share on a personal project (pages/Projects.tsx
// ShareProjectDialog) and People in New project (NewProjectDialog.tsx), so both say the same thing the same way.
// A guest is in one group chat and one project at most: in New project a guest who has a project already is greyed out
// with where they are, as in the members dialog ("Make team member" for admins); in Share (a personal project made a
// team one, `anyGuestOut`) every guest with a place is, since the server takes no guest in there.
import { useMemo } from 'react'
import type { ProjectParticipant } from '@mycel/shared/api'
import { useT } from '../i18n'
import { useMe } from '../store/session'
import { useGuestsElsewhere } from './GuestInvite'
import { AccessSummary, MembersField, ParticipantPicker, participantKey, useAccessCount, useParticipantOptions } from './ProjectParticipants'

/** A project still to be made: a guest who has a project already is greyed out. */
const NEW_PROJECT = { kind: 'project' as const }

export function ProjectPeopleField({ label, value, onChange, note, countAlways = false, anyGuestOut = false }: {
  label: string
  value: ProjectParticipant[]
  onChange: (next: ProjectParticipant[]) => void
  /** what sharing does, shown once someone is picked */
  note: string
  /** the count also with nobody picked yet ("1 member": the share dialog, which is only for adding people) */
  countAlways?: boolean
  /** every guest with a place greyed out (Share on a personal project) */
  anyGuestOut?: boolean
}) {
  const t = useT()
  const me = useMe()
  const options = useParticipantOptions()
  const fixed = useMemo(() => new Map(me ? [[participantKey({ subjectType: 'user', subjectId: me.user.id }), t('projects.youTag')]] : []), [me, t])
  const unavailable = useGuestsElsewhere(NEW_PROJECT, anyGuestOut)
  const picked = value.length > 0
  const count = useAccessCount(value, { enabled: countAlways || picked })
  return (
    <div className="space-y-3">
      <MembersField label={label}>
        <div className="space-y-2">
          <ParticipantPicker options={options} value={value} onChange={onChange} fixed={fixed} unavailable={unavailable} />
          {(countAlways || picked) && <AccessSummary count={count} />}
        </div>
      </MembersField>
      {picked && <p className="text-sm leading-6 break-keep text-muted" data-testid="project-share-note">{note}</p>}
    </div>
  )
}
