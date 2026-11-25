// comment_docx (AI flow check FL-21 step 3, QA TC-3818): Word comments (review notes in the margin) added to an existing
// .docx next to the paragraph that holds the given text, as Word's Review > New Comment makes them; the author is the
// person. Before, the AI could only rewrite the document through make_file (losing its formatting) or explain the
// manual steps. The document is changed in the office worker (files/docx-comment.ts: this process parses no document).
// Reading comments already works: read gives a .docx's comments with their author and the text they are on
// (files/ooxml.ts docxExtraText). Saved like edit_hwp saves (tools/edit-hwp.ts):
// - read first: the file must be the version the AI read in this turn;
// - without `output`, a new version of the same file (the old bytes in its history), a conflict copy if someone saved
//   it meanwhile; with `output`, a new file, and the document is its source (the wider-audience check of make_file);
// - read back before anything is placed: the comments must read back through the normal reader (docx-extra) on the
//   paragraphs they were put on; the worker checked that every paragraph's text is unchanged;
// - not under skills/ (no skill-save card covers this tool; a skill is Markdown, not a Word file).
import { authorizeOutput } from '../files/place-output'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { AppContext } from '../context'
import { ext, officeWorkerText, officeWorkerWrite } from '../files/extract'
import { COMMENTS_MAX, DOCX_COMMENT_MAX, DOCX_COMMENT_MODE, xmlSafe, type DocxCommentResult } from '../files/docx-comment'
import type { ToolCtx } from '../files/service'
import { readRegular, sha256 } from '../files/store'
import { fileShareUrl } from '@mycel/shared/api'
import { authorize } from '../policy/authorize'
import { ToolError } from '../policy/errors'
import { inAnySkills } from '../skills/guard'
import { componentC } from '../team-files/component'
import { checkRegular } from '../team-files/place'
import { makeWorkDir } from './isolate'
import { commentDocxOutput } from './make-file-path'
import { confirmSources, placeProduced } from './make-file'
import type { ToolRegistry } from './registry'

export const COMMENT_DOCX_TOOL = 'comment_docx'
export const CommentDocxInput = z.strictObject({
  file_path: z.string().min(1).max(1000).describe('The .docx to comment on (read it in this chat first)'),
  comments: z.array(z.strictObject({
    on: z.string().min(1).max(500).describe('Exact text from ONE paragraph, as read shows it, e.g. "Article 3 (Payment)": the comment goes next to that paragraph'),
    text: z.string().min(1).max(5000).describe('The comment itself'),
    occurrence: z.number().int().min(1).max(10_000).optional().describe('Which paragraph (1-based, reading order) when the text is in several'),
  })).min(1).max(COMMENTS_MAX),
  output: z.string().min(1).max(1000).optional().describe('Save as a new .docx instead of a new version of the same file'),
})
export const COMMENT_DOCX_DESCRIPTION =
  'Add Word comments (review notes in the margin, as Review > New Comment makes them) to an existing .docx, next to the paragraph that holds ' +
  'the given text, with the person as the author. Everything else in the file stays exactly as it was. Read the file in this chat first. ' +
  'Without `output` the result is a new version of the same file (the previous one stays in its history). Comments already in a .docx show ' +
  'when you read it. Tracked changes (suggested edits) cannot be made here: say so plainly, and offer a comment instead.'

/** where an `output` saves: a .docx ("x" and "x/" save x.docx) */
export { commentDocxOutput }

export interface CommentedDocx { path: string; size: number; sha256: string; conflictCopyOf?: string; source: string; inPlace: boolean; added: DocxCommentResult['added'] }

export async function commentDocx(ctx: AppContext, c: ToolCtx, a: z.output<typeof CommentDocxInput>): Promise<CommentedDocx> {
  const files = componentC(ctx).files
  const fx = files.fx
  const src = authorize(fx, files.rules(), c.user, a.file_path, 'read')
  if (src.st!.isDirectory()) throw new ToolError(`'${src.rel}' is a folder`, 'is_folder')
  if (ext(src.rel) !== 'docx') throw new ToolError('comment_docx adds comments to Word documents (.docx) only')
  if (checkRegular(src.abs).size > DOCX_COMMENT_MAX) throw new ToolError(`'${src.rel}' is larger than ${DOCX_COMMENT_MAX / 1024 / 1024} MB, too large to change here`)
  const { bytes } = readRegular(src.abs, DOCX_COMMENT_MAX)
  const seen = c.files.readHashes.get(src.rel)
  if (!seen) throw new ToolError(`read '${src.rel}' first (with read) before adding comments`, 'not_read')
  if (seen !== sha256(bytes)) throw new ToolError(`'${src.rel}' was changed after you read it; read it again first`, 'conflict')
  const outRel = a.output === undefined ? src.rel : commentDocxOutput(a.output)
  if (inAnySkills(outRel)) throw new ToolError('Word comments cannot be saved in a skills folder (skills/: skills and rules people\'s AI follow); give another output')
  const out = authorizeOutput(fx, files.rules(), c, outRel, { mustExist: a.output === undefined, createDirs: true })
  if (out.exists && out.st!.isDirectory()) throw new ToolError(`'${out.rel}' is a folder`, 'is_folder')
  const inPlace = out.rel === src.rel
  // what the chat read (and, for a new file, the document) may go where more people see it: asked before the worker
  // runs, in place too, as edit_hwp is (a comment can carry text from a private file the chat read)
  await confirmSources(ctx, files, c, out.rel, out.segs, inPlace ? [] : [src.rel])

  const request = JSON.stringify({ file: bytes.toString('base64'), comments: a.comments, author: c.user.name || c.user.id, date: new Date().toISOString().replace(/\.\d+Z$/, 'Z') })
  let r: DocxCommentResult
  try { r = JSON.parse((await officeWorkerWrite(DOCX_COMMENT_MODE, new TextEncoder().encode(request), c.signal)).toString('utf8')) } catch (e) {
    if (e instanceof ToolError) throw e
    throw new ToolError('the Word editor gave a damaged answer; nothing was saved')
  }
  const file = Buffer.from(r.file, 'base64')
  // read back through the normal reader: every comment is there (the worker checked the body's text is unchanged)
  const extra = await officeWorkerText('docx-extra', file, c.signal)
  const author = xmlSafe(c.user.name || c.user.id)
  const missing = r.added.filter((_x, i) => !extra.includes(`Comment by ${author.replace(/\s+/g, ' ')}`) || !extra.includes(xmlSafe(a.comments[i]!.text).trim().split(/\r?\n/)[0]!.trim()))
  if (missing.length) throw new ToolError(`the changed document did not read back with its comments (${missing.length} missing); nothing was saved`)

  const work = makeWorkDir(path.join(ctx.config.dataDir, 'work'))
  try {
    const produced = path.join(work, 'out.docx')
    fs.writeFileSync(produced, file, { flag: 'wx', mode: 0o600 })
    const made = await placeProduced(ctx, files, c, out.segs, produced, COMMENT_DOCX_TOOL)
    return { path: made.path, size: made.size, sha256: made.sha256, conflictCopyOf: made.conflictCopyOf, source: src.rel, inPlace, added: r.added }
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

export function commentDocxText(r: CommentedDocx): string {
  const link = `[${r.path.split('/').pop()}](${fileShareUrl(r.path, 'preview')})`
  const where = r.conflictCopyOf
    ? `'${r.conflictCopyOf}' was changed by someone else in the meantime, so the result was saved as '${r.path}' and the original left as it was. Tell the user about both.`
    : r.inPlace ? `Saved a new version of ${r.path} with the comments; the previous version is in its file history. Link for the user: ${link}`
    : `Saved ${r.path} with the comments; ${r.source} is unchanged. Link for the user: ${link}`
  const list = r.added.map((x, i) => `- comment ${i + 1} next to: "${x.paragraph.slice(0, 120)}"`)
  return `${where}\n${list.join('\n')}\nThe comments read back from the file and the document's text is unchanged; they show in Word's margin (Review > Show Comments).`
}

export function registerCommentDocx(ctx: AppContext, reg: ToolRegistry): void {
  reg.register({
    name: COMMENT_DOCX_TOOL,
    description: COMMENT_DOCX_DESCRIPTION,
    input: CommentDocxInput,
    describe: (a) => `${COMMENT_DOCX_TOOL} ${a.file_path}${a.output ? ` -> ${a.output}` : ''} (${a.comments.length} comments)`,
    async run(a, t) {
      const r = await commentDocx(ctx, t, a)
      return {
        text: commentDocxText(r),
        summary: `${COMMENT_DOCX_TOOL} ${r.source} -> ${r.path} ${r.size}B ${r.added.length} comments${r.inPlace ? ' (new version)' : ''}${r.conflictCopyOf ? ' (conflict copy)' : ''}`,
        structured: { path: r.path, size: r.size, sha256: r.sha256 },
      }
    },
  })
}
