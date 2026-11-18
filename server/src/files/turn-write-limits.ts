// What one answer may write (docs/decisions/20261118-limits-caps.md): a member 1 GB / 2,000 files, a guest the old
// 50 MB / 200 files. Not the disk guard: system/storage.ts assertStorageRoomForAI is checked on every save (the plan's
// guard, or on a Mac without a plan the simple floor of max(2 GB, 5%) free). The numbers are in the engine config
// (config.ts), so tests can lower them.
import type { Database } from 'bun:sqlite'
import type { ServerConfig } from '../config'
import { isGuestUser } from '../credentials/guest-ai'

export interface TurnWriteLimits { bytes: number; files: number }

type Cfg = Pick<ServerConfig, 'maxWriteBytesPerTurn' | 'maxFilesWrittenPerTurn' | 'guestMaxWriteBytesPerTurn' | 'guestMaxFilesWrittenPerTurn'>

/** The write limits of one answer for `userId`: the guest pair for a guest, the member pair for everyone else. */
export function turnWriteLimits(cfg: Cfg, db: Database, userId: string): TurnWriteLimits {
  return isGuestUser(db, userId)
    ? { bytes: cfg.guestMaxWriteBytesPerTurn, files: cfg.guestMaxFilesWrittenPerTurn }
    : { bytes: cfg.maxWriteBytesPerTurn, files: cfg.maxFilesWrittenPerTurn }
}
