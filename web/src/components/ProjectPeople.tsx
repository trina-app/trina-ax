// Who is in a team project (docs/DECISIONS.md "Who is in a project, by face"): the server's list of its people, each
// once, with their photo (GET /api/projects/:id/people; its members and whoever manages it). The project page shows
// their faces under its name and on its 멤버 line (PeopleStack: 4 faces and "+N", the name on hover; clicking the faces
// under the name opens the members dialog), and the members dialog lists them all (PeopleList: the creator and "you"
// marked). Only a team project in projects/ in place: a personal one is the caller's alone, one made before outside
// projects/ has no such list, and one in the trash is nobody's until restored.
import { useEffect, useState } from 'react'
import type { Project, ProjectPeople, ProjectPerson } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { useT } from '../i18n'
import { isProjectsFolder } from '../lib/projectFolders'
import { reactionWho } from '../lib/rooms'
import { useMe } from '../store/session'
import { Avatar } from './Avatar'
import { FaceStack, FACES_MAX } from './FaceStack'

/** A team project with a list of its people: in projects/<name>, not in the trash. */
export const hasPeopleList = (p: Pick<Project, 'folderPath' | 'inTrash'>) => isProjectsFolder(p.folderPath) && !p.inTrash

/** Its people: null while asking, false when there is no list (not such a project, an older server, a refusal).
 * `version`: ask again. */
export function useProjectPeople(p: Pick<Project, 'id' | 'folderPath' | 'inTrash'> | null, version = 0): ProjectPeople | null | false {
  const [people, setPeople] = useState<ProjectPeople | null | false>(null)
  const on = !!p && hasPeopleList(p)
  // another project: nothing until its list comes; the same one asked again: the faces it has stay meanwhile
  useEffect(() => { setPeople(null) }, [p?.id])
  useEffect(() => {
    if (!on) { setPeople(false); return }
    let live = true
    api.call(API.getProjectPeople, { params: { id: p!.id } }).then((r) => live && setPeople(r), () => live && setPeople(false))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.id, on, version])
  return people
}

/** "Mina, Sam, Jo 외 2명": the names a stack's faces stand for, in words */
export function peopleNames(t: ReturnType<typeof useT>, people: readonly ProjectPerson[]): string {
  return reactionWho({ count: people.length, users: people.slice(0, FACES_MAX) }, { sep: t('rooms.nameSep'), more: (list, n) => t('rooms.groupNamesMore', { names: list, n }) })
}

/**
 * Their faces on one line, 24 px with a ring of the page's colour: 4 and "+N" (on a phone too), each with its name on hover. `onOpen`: the faces are
 * one button that opens the members dialog, read out as "멤버: Mina, Sam 외 3명"; without it they are only a picture
 * beside words that say how many (the 멤버 line). Nothing for nobody.
 */
export function PeopleStack({ people, onOpen, testId }: { people: readonly ProjectPerson[]; onOpen?: () => void; testId: string }) {
  const t = useT()
  if (!people.length) return null
  const names = peopleNames(t, people)
  const faces = <FaceStack people={people} count={people.length} shown={FACES_MAX} phoneShown={FACES_MAX} size={24} tips testId={testId} />
  if (!onOpen) return faces
  return (
    // no-tooltip: each face says its name on hover; the button's words (for screen readers) name all of them. Its name
    // is those words, not an aria-label: the letters on the faces would then not match it
    <button type="button" onClick={onOpen} className="-m-1 flex items-center rounded-full p-1 hover:bg-hover pointer-coarse:min-h-11" data-testid={`${testId}-open`}>
      {faces}
      <span className="sr-only">{t('projects.peopleLabel', { names })}</span>
    </button>
  )
}

/** Everyone in it, each once: their photo and name, the creator and "나" marked. */
export function PeopleList({ people }: { people: readonly ProjectPerson[] }) {
  const t = useT()
  const me = useMe()
  return (
    <section aria-labelledby="project-people-title" data-testid="project-people">
      <h3 id="project-people-title" className="text-label font-medium text-ink" data-testid="project-people-count">{t('projects.peopleIn', { n: people.length })}</h3>
      <ul className="mt-1 max-h-60 overflow-y-auto">
        {people.map((x) => {
          const tags = [x.creator && t('projects.creatorTag'), x.id === me?.user.id && t('projects.youTag')].filter(Boolean).join(' · ')
          return (
            <li key={x.id} className="flex min-h-9 items-center gap-2.5" data-testid={`project-person-${x.id}`}>
              <Avatar user={x} size={24} />
              <span className="min-w-0 truncate text-sm text-ink">{x.name}</span>
              {tags && <span className="shrink-0 text-xs text-faint" data-testid={`project-person-tag-${x.id}`}>{tags}</span>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
