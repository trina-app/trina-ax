// A team path as people read it on any screen (QA TC-8922: "users/qa-admin/공문/" under an answer, where the rest of the
// app says "My files › 공문"): the place words of the step lines (shared/src/step-labels.ts placeName) for this viewer,
// so their own folder is "My files", another person's is "<name>'s folder" and never their id, and the team's folders
// by the Files screen's names; a path those words do not name in the Files screen's words (folderLabels.ts). Display
// only: links, API calls and tooltips keep the disk path.
import { placeName, type PlaceViewer } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import { useLocale } from '../i18n'
import { usePeople } from '../store/people'
import { useMe } from '../store/session'
import { folderWords } from './folderLabels'

const SEP = ' › '

/** `path` (a file or a folder, a trailing "/" or not) in words for `viewer`; '' and "/" are the team folder. */
export function teamPlace(path: string, locale: Locale, viewer?: PlaceViewer): string {
  const p = path.replace(/^\/+|\/+$/g, '')
  if (!p) return placeName('/', locale) ?? '/'
  return placeName(p, locale, viewer) ?? folderWords(locale, viewer?.me).path(p, SEP)
}

/** The viewer of placeName for the person signed in, with the people directory for other people's names (read the first
 * time a path names someone else; never for the own folder). Before the person is known (a test without a session),
 * none: users/<id>/ reads as the own folder, as the step lines always said it. */
export function usePlaceViewer(): PlaceViewer | undefined {
  const me = useMe()?.user.id ?? null
  const byId = usePeople((s) => s.byId)
  if (!me) return undefined
  return {
    me,
    nameOf: (id) => {
      const person = byId[id]
      if (!person && !usePeople.getState().loaded) queueMicrotask(() => void usePeople.getState().load())
      return person?.name ?? null
    },
  }
}

/** teamPlace for the person signed in, in their language. */
export function useTeamPlace(): (path: string) => string {
  const locale = useLocale()
  const viewer = usePlaceViewer()
  return (path: string) => teamPlace(path, locale, viewer)
}
