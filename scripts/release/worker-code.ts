// worker.js as deployed for this product (scripts/release/hosting.ts): its office folder is RELEASE_CHANNEL.officeDir.
import { RELEASE_CHANNEL } from '../../shared/src/release-channel'

/** worker.js with DIR set to the channel's office folder (it serves only <dir>/…) */
export function workerCode(src: string, dir: string = RELEASE_CHANNEL.officeDir): string {
  const line = /^const DIR = 'office'$/gm
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(dir) || (src.match(line) ?? []).length !== 1) throw new Error('worker.js: unexpected source or folder')
  return src.replace(line, `const DIR = '${dir}'`)
}
