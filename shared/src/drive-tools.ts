import { z } from 'zod'
export const DriveId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/)
/** Which Google Drive a call uses: "mine" (the person's own connection) or "team:<name>" (a Drive an admin shares with
 * the team, server/src/integrations/google-drive/shares.ts). Left out: the person's own when they have one, else the
 * first team share they may use. Every result names its source and the other sources there are. */
export const DriveSource = z.string().trim().min(1).max(120).regex(/^(mine|team:.+)$/)
const Page = { driveId: DriveId.optional(), pageToken: z.string().min(1).max(4096).optional(), pageSize: z.number().int().min(1).max(100).default(50), source: DriveSource.optional() }
export const DriveSearchInput = z.object({ query: z.string().trim().min(1).max(500), ...Page }).strict()
export const DriveListInput = z.object({ folderId: DriveId.default('root'), ...Page }).strict()
/** offset: where the text starts, in characters (a cut read says where to go on; TC-4984) */
export const DriveReadInput = z.object({ fileId: DriveId, maxChars: z.number().int().min(1).max(100_000).default(40_000), offset: z.number().int().min(0).max(1_000_000_000).default(0).describe('Start at this character of the text (default 0); a cut read says the next offset'), source: DriveSource.optional() }).strict()
/** save_connector_file (server/src/tools/save-connector-file.ts): the original file a connected service gave, saved into
 * the team folder as it is. `file`: an mcp-file:<id> handle (a Gmail attachment the AI read, a file in a connection's
 * answer) or drive:<file id> (a Google Drive file; a Google document, sheet or presentation is saved as .docx, .xlsx or
 * .pptx). */
export const SaveConnectorFileInput = z.object({
  file: z.string().trim().min(1).max(300).regex(/^(mcp-file:[A-Za-z0-9_-]{1,64}|drive:[A-Za-z0-9_-]{1,256})$/).describe('mcp-file:<id> (a Gmail attachment or a file a connected service returned) or drive:<file id> (a Google Drive file)'),
  save_as: z.string().max(300).optional().describe('Team path to save to, e.g. "shared/contracts/quote.xlsx". A path ending in "/" keeps the file\'s own name. Default: users/<you>/downloads/ with the file\'s own name'),
  source: DriveSource.optional().describe('For drive: only, as in drive_read'),
}).strict()
