// A page with its team images inlined (lib/frame-files.ts), for a preview or an artifact: null while the files are
// fetched. With `scripts` (a frame that runs scripts) its team script files are put in too (lib/frame-scripts.ts). A
// new page (or folder) starts over; a page left behind stops its fetches. If resolving fails as a whole, the page is
// shown as it was (its images and scripts then stay blocked by the frame's CSP, as before).
import { useEffect, useState } from 'react'
import { resolveFrameFiles, type FrameFiles } from './frame-files'

type For = { html: string; folder: string | null; embedIn?: string; scripts: boolean }

export function useFrameFiles(html: string | null, o: { folder: string | null; embedIn?: string; scripts?: boolean }): FrameFiles | null {
  const [state, setState] = useState<{ for: For; out: FrameFiles } | null>(null)
  const { folder, embedIn } = o
  const scripts = !!o.scripts
  useEffect(() => {
    if (html === null) return
    const ctrl = new AbortController()
    let live = true
    const key: For = { html, folder, embedIn, scripts }
    resolveFrameFiles(html, { folder, embedIn, scripts, signal: ctrl.signal }).then(
      (out) => { if (live) setState({ for: key, out }) },
      () => { if (live && !ctrl.signal.aborted) setState({ for: key, out: { html, external: 0, missing: 0, externalScripts: 0, missingScripts: [] } }) },
    )
    return () => {
      live = false
      ctrl.abort()
    }
  }, [html, folder, embedIn, scripts])
  const f = state?.for
  if (html === null || !f || f.html !== html || f.folder !== folder || f.embedIn !== embedIn || f.scripts !== scripts) return null
  return state!.out
}
