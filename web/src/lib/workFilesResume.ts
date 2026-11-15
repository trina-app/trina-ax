// "Find work files on this computer" (lib/workFiles.ts): back on the same step after the desktop app restarted for
// Full Disk Access (components/onboarding/FullDiskAccess.tsx). Its own file, so the app's start (App.tsx) loads nothing
// else of Find work files.

/** A Mac app that was running when Full Disk Access was switched on may need a restart before macOS counts it. The page
 * notes where the person was before the app restarts (the Full Disk Access screen of My files' dialog, the welcome
 * card's, or the setup's 팀 파일 step), and the started app opens that page and that step again by itself. Kept for
 * 15 minutes (the app's own limit for a restart after Open Settings), for the same person only, and taken once. */
export const RESUME_KEY = 'mycel.findWork.resume'
const RESUME_MS = 15 * 60_000
/** whose dialog: 'own' (My files, the welcome card) or 'team' (the setup's 팀 파일 step) */
export type ResumeFrom = 'own' | 'team'
interface Resume { at: number; user: string; path: string; from: ResumeFrom }
type ResumeStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const resumeStore = (): ResumeStore | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

function readResume(user: string, now: number, s: ResumeStore | null): Resume | null {
  try {
    const raw = s?.getItem(RESUME_KEY)
    if (!raw) return null
    const r = JSON.parse(raw) as Partial<Resume>
    const ok = typeof r.at === 'number' && now - r.at >= 0 && now - r.at < RESUME_MS && r.user === user
      && typeof r.path === 'string' && r.path.startsWith('/') && !r.path.startsWith('//') && (r.from === 'own' || r.from === 'team')
    if (!ok) { s?.removeItem(RESUME_KEY); return null }
    return r as Resume
  } catch { return null }
}

/** Before the restart: this page and this dialog. */
export function saveResume(user: string, from: ResumeFrom, path: string, now = Date.now(), s: ResumeStore | null = resumeStore()) {
  try { s?.setItem(RESUME_KEY, JSON.stringify({ at: now, user, path, from } satisfies Resume)) } catch { /* storage full or blocked */ }
}

/** The page to open after the restart (the app starts on Home), or null. */
export function resumePath(user: string, now = Date.now(), s: ResumeStore | null = resumeStore()): string | null {
  return readResume(user, now, s)?.path ?? null
}

/** Whether `from`'s dialog should open again on `path` (it does not take the note: the step's own screen does, with
 * takeResume, so a dialog that opens first and then shows the step finds it still there). */
export function hasResume(user: string, from: ResumeFrom, path: string, now = Date.now(), s: ResumeStore | null = resumeStore()): boolean {
  const r = readResume(user, now, s)
  return !!r && r.from === from && r.path === path
}

/** Take the note when it is `from`'s on `path`: true once. */
export function takeResume(user: string, from: ResumeFrom, path: string, now = Date.now(), s: ResumeStore | null = resumeStore()): boolean {
  if (!hasResume(user, from, path, now, s)) return false
  clearResume(s)
  return true
}

/** The screen moved on or closed: nothing to open again. */
export function clearResume(s: ResumeStore | null = resumeStore()) {
  try { s?.removeItem(RESUME_KEY) } catch { /* blocked */ }
}
