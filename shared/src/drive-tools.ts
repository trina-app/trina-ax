import { z } from 'zod'
export const DriveId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/)
const Page = { driveId: DriveId.optional(), pageToken: z.string().min(1).max(4096).optional(), pageSize: z.number().int().min(1).max(100).default(50) }
export const DriveSearchInput = z.object({ query: z.string().trim().min(1).max(500), ...Page }).strict()
export const DriveListInput = z.object({ folderId: DriveId.default('root'), ...Page }).strict()
export const DriveReadInput = z.object({ fileId: DriveId, maxChars: z.number().int().min(1).max(100_000).default(40_000) }).strict()
