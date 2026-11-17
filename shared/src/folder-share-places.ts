// Which of a person's own folders the screens offer to share (docs/decisions/20261116-folder-share-server.md "what
// may be shared"; the web part: docs/AGENTS/plan/20261116-1330-folder-share-web.md). A hint for the menus only: the
// server decides (server/src/files/share-places.ts sharePlaceBlock, which the Share dialog shows as `blocked`). The
// names are the server's kept names (keptNames()); tests/unit/c-folder-share-web.test.ts fails when the lists differ.
import { ARCHIVE_DIR, FROM_COMPUTER_DIR } from './folder-labels'
import { SKILLS_DIR } from './skill-roots'

/** The names right under users/<id>/ that are never shared: the server's own save places (downloads, images, videos,
 * exports, projects), skills, chat attachments, the notes file, Find work files' folder and the archived accounts. */
export const SHARE_KEPT_NAMES: readonly string[] = [SKILLS_DIR, 'downloads', 'images', 'videos', 'exports', 'projects', '.attachments', 'notes.md', FROM_COMPUTER_DIR, ...Object.values(ARCHIVE_DIR)]

const fold = (s: string) => s.normalize('NFKC').toLowerCase().normalize('NFKC')
let kept: Set<string> | null = null

/** May the folder at `path` (a team path) be offered for sharing to `me`? Only users/<me>/<name>/… (never the personal
 * folder itself), never at or inside a kept place, never a hidden name on the way. A project's folder is left to the
 * server (the dialog says why it can't be shared). */
export function offersFolderShare(path: string, me: string): boolean {
  const segs = path.split('/')
  if (segs[0] !== 'users' || segs[1] !== me || segs.length < 3) return false
  kept ??= new Set(SHARE_KEPT_NAMES.map(fold))
  if (kept.has(fold(segs[2]!))) return false
  return segs.slice(2).every((s) => s !== '' && !s.startsWith('.'))
}
