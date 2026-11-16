// A skills folder said as a place, never a path (the people here are not developers): the Team skills page's lists and
// the "Suggest as a skill" dialog's folder choice say it the same way.
import type { SkillSuggestion } from '@mycel/shared/api'
import type { useT } from '../i18n'

/** A skills folder in words, never a path (the people here are not developers): skills/ is "팀 스킬", a group's
 * groups/<its folder>/skills/ is the group's folder name, folders inside follow after " › ". `path`: the folder words
 * of the person's language (lib/folderLabels.ts). */
export function skillFolderWords(folder: string, path: (p: string, sep?: string) => string): string {
  const g = /^groups\/([^/]+)\/skills(?:\/(.+))?$/.exec(folder)
  return g ? [g[1]!, ...(g[2]?.split('/') ?? [])].join(' › ') : path(folder, ' › ')
}

/** Where a suggestion goes, in words: "Team skills" (and its folders), or a group's skills by the group's name now
 * ("Design skills"; its folder's name when the group is gone). The words of a row's line and of the server's notice
 * (server/src/skills/suggestions.ts placeWords). */
export function skillPlaceWords(s: Pick<SkillSuggestion, 'targetFolder' | 'targetGroup'>, t: ReturnType<typeof useT>, path: (p: string, sep?: string) => string): string {
  const g = /^groups\/([^/]+)\/skills(?:\/(.+))?$/.exec(s.targetFolder)
  return g ? [t('skills.groupPlace', { group: s.targetGroup?.name ?? g[1]! }), ...(g[2]?.split('/') ?? [])].join(' › ') : path(s.targetFolder, ' › ')
}
