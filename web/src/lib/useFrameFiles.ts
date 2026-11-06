// A page with its team images inlined (lib/frame-files.ts), for a preview or an artifact: null while the files are
// fetched. A new page (or folder) starts over; a page left behind stops its fetches. If resolving fails as a whole,
// the page is shown as it was (its images then stay blocked by the frame's CSP, as before).
import { useEffect, useState } from 'react'
import { resolveFrameFiles, type FrameFiles } from './frame-files'

export function useFrameFiles(html: string | null, o: { folder: string | null; embedIn?: string }): FrameFiles | null {
  const [state, setState] = useState<{ for: string; folder: string | null; embedIn?: string; out: FrameFiles } | null>(null)
  const { folder, embedIn } = o
  useEffect(() => {
    if (html === null) return
    const ctrl = new AbortController()
    let live = true
    resolveFrameFiles(html, { folder, embedIn, signal: ctrl.signal }).then(
      (out) => { if (live) setState({ for: html, folder, embedIn, out }) },
      () => { if (live && !ctrl.signal.aborted) setState({ for: html, folder, embedIn, out: { html, external: 0, missing: 0 } }) },
    )
    return () => {
      live = false
      ctrl.abort()
    }
  }, [html, folder, embedIn])
  if (html === null || !state || state.for !== html || state.folder !== folder || state.embedIn !== embedIn) return null
  return state.out
}
