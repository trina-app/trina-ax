import { z } from 'zod'
export const DriveId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/)
/** Which Google Drive a call uses: "mine" (the person's own connection) or "team:<name>" (a Drive an admin shares with
 * the team, server/src/integrations/google-drive/shares.ts). Left out: the person's own when they have one, else the
 * first team share they may use. Every result names its source and the other sources there are. */
export const DriveSource = z.string().trim().min(1).max(120).regex(/^(mine|team:.+)$/)
const Page = { driveId: DriveId.optional(), pageToken: z.string().min(1).max(4096).optional(), pageSize: z.number().int().min(1).max(100).default(50), source: DriveSource.optional() }
export const DriveSearchInput = z.object({ query: z.string().trim().min(1).max(500), ...Page }).strict()
export const DriveListInput = z.object({ folderId: DriveId.default('root'), ...Page }).strict()
export const DriveReadInput = z.object({ fileId: DriveId, maxChars: z.number().int().min(1).max(100_000).default(40_000), source: DriveSource.optional() }).strict()
