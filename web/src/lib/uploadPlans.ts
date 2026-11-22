// The Files screen's uploads when a name is taken (QA TC-7241): a file whose name the folder holds already went up as
// "name (2)" without a word. Now the server says which names are taken (POST /api/files/names-taken, compared as it
// compares names) and the person is asked per file, the way Google Drive asks: Replace (the old file becomes a version
// of it: onExists 'replace', team-files placeUpload) or Keep both (today's "name (2)": onExists 'rename'). A folder of
// that name cannot be replaced: only Keep both. Cancel leaves that file out. When the check itself fails (an older
// server, the network), every file goes up as before.
import type { NamesTaken } from '@mycel/shared/api'

/** one taken name, as the question shows it */
export interface UploadClash { name: string; existing: string; type: 'file' | 'folder' }
/** one file to send: the name it goes up as (a Replace: the name on disk) and what the server does with a taken name */
export interface UploadPlan { file: File; name: string; onExists: 'rename' | 'replace' }

/** names sent per check (the endpoint's limit) */
const CHECK_MAX = 100

export async function uploadPlans(
  files: readonly File[],
  o: { taken: (names: string[]) => Promise<NamesTaken>; ask: (c: UploadClash) => Promise<'keep' | 'replace' | null> },
): Promise<UploadPlan[]> {
  const byName = new Map<string, NamesTaken['taken'][number]>()
  try {
    const names = [...new Set(files.map((f) => f.name))]
    for (let i = 0; i < names.length; i += CHECK_MAX) for (const t of (await o.taken(names.slice(i, i + CHECK_MAX))).taken) byName.set(t.name, t)
  } catch {
    byName.clear()
  }
  const plans: UploadPlan[] = []
  for (const file of files) {
    const t = byName.get(file.name)
    if (!t) { plans.push({ file, name: file.name, onExists: 'rename' }); continue }
    const answer = await o.ask({ name: file.name, existing: t.existing, type: t.type })
    if (answer === 'replace' && t.type === 'file') plans.push({ file, name: t.existing, onExists: 'replace' })
    else if (answer === 'keep') plans.push({ file, name: file.name, onExists: 'rename' })
  }
  return plans
}
