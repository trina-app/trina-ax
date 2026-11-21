// A read whose file has no team path (a chat's file, chat/chat-file-tool.ts; a work-folder file, devenv/work-files.ts):
// its own bookkeeping is kept apart from the turn's (a Proxy over the turn's state, like TurnFiles' sub-agent view).
// The hashes a later write is checked by, the team paths of the read scope, the answer's file list and share-grant reads
// go to throwaway sets; the turn's image budget and everything else stay the turn's.
import { SourceLog } from './sources'
import type { TurnFiles } from './service'

export function apart(files: TurnFiles): TurnFiles {
  const own: Record<string, unknown> = { readHashes: new Map(), readPaths: new Set(), namePaths: new Set(), listedNames: new Set(), grantReadPaths: new Set(), sources: new SourceLog(), grantReads: false }
  return new Proxy(files, {
    get: (t, k) => (typeof k === 'string' && Object.hasOwn(own, k) ? own[k] : Reflect.get(t, k, t)),
    set: (t, k, v) => { if (typeof k === 'string' && Object.hasOwn(own, k)) { own[k] = v; return true } return Reflect.set(t, k, v, t) },
  })
}
