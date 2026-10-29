// Contracts for the tools the AI engine can call. File tools mirror Claude Code's built-in tool inputs
// (file_path / pattern / old_string ...) so the model uses them exactly like the built-ins.
import { z } from 'zod'
import { HwpPage } from './hwp'

const relPath = z.string().max(4096).describe('Path relative to the team folder root, e.g. "shared/notes.md". No absolute paths.')
const optRelPath = relPath.optional()

// ---------------- file tools (stage 1: implemented) ----------------
export const ListInput = z.strictObject({
  path: optRelPath.describe('Folder relative to the team root. Omit or "" for the root.'),
})
export const GlobInput = z.strictObject({
  pattern: z.string().min(1).max(1000).describe('Glob pattern, e.g. "**/*.md" or "shared/meetings/*2026-09*"'),
  path: optRelPath.describe('Folder to search in (default: whole team folder)'),
})
export const GrepInput = z.strictObject({
  pattern: z.string().min(1).max(10000).describe('Regular expression (Rust regex syntax: no look-around or backreferences)'),
  path: optRelPath.describe('File or folder to search (default: whole team folder)'),
  glob: z.string().max(1000).optional().describe('Only files matching this glob, e.g. "*.md" or "**/meetings/*"'),
  type: z.string().regex(/^[a-z0-9]{1,20}$/).optional().describe('File type, e.g. "md", "csv", "js"'),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional().describe('Default: files_with_matches'),
  '-i': z.boolean().optional().describe('Case-insensitive'),
  '-n': z.boolean().optional().describe('Show line numbers (content mode; default true)'),
  '-A': z.number().int().min(0).max(50).optional(),
  '-B': z.number().int().min(0).max(50).optional(),
  '-C': z.number().int().min(0).max(50).optional(),
  head_limit: z.number().int().min(1).max(5000).optional().describe('Max output lines/entries (default 200)'),
  multiline: z.boolean().optional(),
})
export const ReadInput = z.strictObject({
  file_path: relPath,
  offset: z.number().int().min(1).optional().describe('1-based line to start from'),
  limit: z.number().int().min(1).max(20000).optional().describe('Number of lines (default 2000)'),
})
export const WriteInput = z.strictObject({
  file_path: relPath,
  content: z.string().max(10 * 1024 * 1024),
})
export const EditInput = z.strictObject({
  file_path: relPath,
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
})

// ---------------- other tools (stage 1: contracts only) ----------------
export const HwpRenderInput = z.strictObject({ source: relPath, page: z.number().int().min(1).max(200), format: z.literal('png') })
export const MakeFileInput = z.strictObject({
  source: optRelPath.describe('.md/.csv file to convert (source or content)'),
  content: z.string().optional(),
  format: z.enum(['docx', 'pptx', 'xlsx', 'pdf']),
  output: relPath.describe('Where to save (write access needed; a conflict copy is made if it exists)'),
  template: optRelPath.describe('Template file under skills/'),
  expected_slides: z.number().int().min(1).max(500).optional().describe('pptx only: the number of slides the user asked for, title slide included. Give it whenever the user names a number; a different result is an error and nothing is saved.'),
  expected_notes: z.number().int().min(0).max(500).optional().describe('pptx only: how many slides must have speaker notes (e.g. the slide count when the user wants notes on every slide)'),
}).refine((v) => (v.source === undefined) !== (v.content === undefined), { message: 'give exactly one of source or content' })
  .refine((v) => v.format === 'pptx' || (v.expected_slides === undefined && v.expected_notes === undefined), { message: 'expected_slides and expected_notes are only for format "pptx"' })
export const MakeFileOutput = z.object({ path: z.string(), size: z.number(), sha256: z.string(), slides: z.number().optional(), notes: z.number().optional() })

export const ShareFileInput = z.strictObject({ path: relPath, mode: z.enum(['preview', 'download']) })
export const ShareFileOutput = z.object({ url: z.string() })

// Moving, copying and renaming any kind of file (PDF, images, Office files, chat attachments): server/src/tools/file-moves.ts
const pathBatch = z.array(relPath).min(1).max(50)
export const MoveFilesInput = z.strictObject({
  paths: pathBatch.describe('Files or folders to move (1-50), e.g. ["users/<you>/.attachments/<chat>/logo.png"]'),
  to_folder: relPath.describe('An existing folder to move them into, e.g. "shared/company". Names are kept; " (2)" is added when a name is taken.'),
})
export const MoveFilesOutput = z.object({ moved: z.array(z.object({ from: z.string(), to: z.string() })), failed: z.array(z.object({ path: z.string(), error: z.string() })) })
export const CopyFilesInput = z.strictObject({
  paths: pathBatch.describe('Files to copy (1-50; not folders). The originals stay where they are.'),
  to_folder: relPath.describe('An existing folder to copy them into. Names are kept; " (2)" is added when a name is taken.'),
})
export const CopyFilesOutput = z.object({ copied: z.array(z.object({ from: z.string(), to: z.string() })), failed: z.array(z.object({ path: z.string(), error: z.string() })) })
export const RenameFileInput = z.strictObject({
  path: relPath.describe('The file or folder to rename'),
  new_name: z.string().min(1).max(255).describe('The new name only (no folder): it stays in the same folder'),
})
export const RenameFileOutput = z.object({ path: z.string() })

export const ArtifactInput = z.strictObject({
  action: z.enum(['create', 'update', 'rewrite']),
  key: z.string().min(1).max(100),
  type: z.enum(['html', 'react', 'svg', 'mermaid', 'markdown', 'code']),
  title: z.string().max(200).optional(),
  language: z.string().max(40).optional(),
  content: z.string().optional(),
  edits: z.array(z.strictObject({ old: z.string(), new: z.string() })).optional(),
})
export const ArtifactOutput = z.object({ key: z.string(), version: z.number().int() })

export const RememberInput = z.strictObject({ text: z.string().min(1).max(2000) })
export const RememberOutput = z.object({ id: z.string() })
export const ForgetInput = z.strictObject({ id: z.string() })
export const ForgetOutput = z.object({ ok: z.literal(true) })

/** Name the chat (offered only at the start of a chat whose title is still automatic: server/src/chat/title.ts). */
export const SetTitleInput = z.strictObject({
  title: z.string().min(2).max(60).describe('Short title in the user\'s language that says what the person wants (2-60 characters, best under 30). No keys, tokens, passwords, personal data or quotes of the message; no trailing punctuation.'),
})
export const SetTitleOutput = z.object({ ok: z.literal(true), title: z.string() })

export const AskUserInput = z.strictObject({
  question: z.string().min(1).max(2000),
  options: z.array(z.strictObject({ label: z.string(), value: z.string() })).max(20).optional(),
  multiple: z.boolean().optional(),
  allowText: z.boolean().optional(),
})
export const AskUserOutput = z.union([z.object({ answer: z.union([z.string(), z.array(z.string())]) }), z.object({ skipped: z.literal(true) })])

// Web search is Claude Code's built-in WebSearch (runs on Anthropic's side). We keep only our own fetch.
export const WebFetchInput = z.strictObject({ url: z.string().url().max(4000), maxChars: z.number().int().min(100).max(200000).optional() })
export const WebFetchOutput = z.object({ url: z.string(), title: z.string().optional(), text: z.string(), truncated: z.boolean() })

export const ToolError = z.object({ error: z.object({ code: z.string(), message: z.string() }) })
/** File tools return plain text (like Claude Code's built-ins). */
export const TextOutput = z.object({ text: z.string() })

export const FILE_TOOLS = {
  list: { input: ListInput, description: 'List a folder in the team drive. Only things you are allowed to see are shown. Folders end with "/".' },
  glob: { input: GlobInput, description: 'Find files by name pattern (e.g. "**/*.pdf"). Returns paths relative to the team root. Folders you cannot access are skipped.' },
  grep: { input: GrepInput, description: 'Search file contents with a regular expression (ripgrep). Also searches text extracted from .docx/.pptx/.xlsx/.pdf. Folders you cannot access are skipped.' },
  read: { input: ReadInput, description: 'Read a file. Returns numbered lines (cat -n style). Word/Excel/PowerPoint/PDF files are converted to text. Use offset/limit for long files.' },
  write: { input: WriteInput, description: 'Create a text file or overwrite one. An existing file must be read first in this conversation turn. If someone else changed it since you read it, your version is saved as a conflict copy instead. The server checks access on each call: call it when asked, even if the folder looks read-only.' },
  edit: { input: EditInput, description: 'Replace an exact string in a text file you have read in this turn. old_string must be unique unless replace_all is true. The server checks access on each call: call it when asked, even if the folder looks read-only.' },
} as const
export type FileToolName = keyof typeof FILE_TOOLS

export const OTHER_TOOLS = {
  hwp_render: { input: HwpRenderInput, output: HwpPage },
  make_file: { input: MakeFileInput, output: MakeFileOutput },
  share_file: { input: ShareFileInput, output: ShareFileOutput },
  move_files: { input: MoveFilesInput, output: MoveFilesOutput },
  copy_files: { input: CopyFilesInput, output: CopyFilesOutput },
  rename_file: { input: RenameFileInput, output: RenameFileOutput },
  artifact: { input: ArtifactInput, output: ArtifactOutput },
  remember: { input: RememberInput, output: RememberOutput },
  forget: { input: ForgetInput, output: ForgetOutput },
  ask_user: { input: AskUserInput, output: AskUserOutput },
  set_title: { input: SetTitleInput, output: SetTitleOutput },
  web_fetch: { input: WebFetchInput, output: WebFetchOutput },
} as const

/** Exactly what the engine may have, in addition to mcp__team__<file tool>. Lockdown test asserts this. */
export const ENGINE_BUILTIN_ALLOWED = ['WebSearch'] as const
