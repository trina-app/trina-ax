import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
export const CALLBACK_PATH = '/api/integrations/google-drive/callback'
const ConfigSchema = z.object({
  clientId: z.string().min(1).max(512), clientSecret: z.string().min(1).max(4096),
  redirectUri: z.string().url().refine(s => {
    const u = new URL(s)
    return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && u.pathname === CALLBACK_PATH
  }),
}).strict()
export type DriveConfig = z.infer<typeof ConfigSchema>
export const configKey = (c: DriveConfig) => crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex')
export const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

/** Read a server-owned secret file, never config from team files. Invalid/missing => disabled, no paths logged. */
export function readDriveConfig(file: string, teamRoot: string): DriveConfig | null {
  try {
    const real = fs.realpathSync(file), team = fs.realpathSync(teamRoot)
    if (real === team || real.startsWith(team + path.sep)) return null
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const st = fs.fstatSync(fd)
      if (!st.isFile() || st.nlink !== 1 || st.size > 16_384 || (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid())) return null
      return ConfigSchema.parse(JSON.parse(fs.readFileSync(fd, 'utf8')))
    } finally { fs.closeSync(fd) }
  } catch { return null }
}
