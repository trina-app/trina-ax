// Team files inside an HTML file's preview (web/src/lib/frame-files.ts): the preview fetches each image or clip the
// page names with the viewer's own permissions, as `GET /api/files/download?path=<file>&embedIn=<page>`. The page's
// scripts run in the sandbox frame and can read what is inlined, and a frame that runs scripts can still make the
// browser open a connection to a host name it chose (WebKit's link hints, Chrome's speculative navigation:
// web/src/lib/artifacts.ts frameRunsScripts) — a name that can carry data. So a page may only get files that everyone
// who can read the page can read already: a script in a page of a shared folder never sees a restricted file that only
// the person looking at it may open. users/<id>/ follows the same rule (a page there is that person's only).
import type { Database } from 'bun:sqlite'
import { atLeast, loadPrincipal, type Principal, type RuleSet } from '../policy/access'

function activePeople(db: Database): Principal[] {
  const ids = db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL").all() as { id: string }[]
  return ids.map((r) => loadPrincipal(db, r.id)).filter((p): p is Principal => !!p)
}

/** Can someone read the page (`pageSegs`, actual names) who cannot read the file (`fileSegs`)? */
export function embedNarrower(db: Database, rules: RuleSet, pageSegs: readonly string[], fileSegs: readonly string[]): boolean {
  return activePeople(db).some((p) => atLeast(rules.access(p, pageSegs), 'read') && !atLeast(rules.access(p, fileSegs), 'read'))
}
