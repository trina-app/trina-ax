// The AI's own words no longer tell it "you can't" where another tool does the job (docs/AGENTS/plan/
// 20261128-1803-ai-self-limits-audit.md; the Aside attach case was #754). Each test names the tool that does it.
import { describe, expect, test } from 'bun:test'
import { DOC_SKILLS_RULE, ENVIRONMENT, environmentSection, plainWordsRule } from '../../server/src/chat/prompt'
import { EDIT_OFFICE_DESCRIPTION } from '../../server/src/tools/edit-office'
import { COMMENT_DOCX_DESCRIPTION } from '../../server/src/tools/comment-docx'
import { STAMP_PDF_DESCRIPTION } from '../../server/src/tools/stamp-pdf'
import { UNZIP_FILE_DESCRIPTION } from '../../server/src/tools/unzip'
import { binaryWriteHint } from '../../server/src/files/service'

describe('PDF text: edit_pdf replace_text changes it', () => {
  test('the plain-words example with the PDF tools is a real limit, not "can\'t change the PDF\'s text"', () => {
    const r = plainWordsRule(true)
    expect(r).not.toContain('change the text of the existing PDF')
    expect(r).toContain('I can\'t open files on your computer, but if you attach the quote here I can change it')
    // without edit_pdf or stamp_pdf the PDF really cannot be changed, and the example says so
    expect(plainWordsRule(false)).toContain('I can\'t change the existing PDF here')
  })
  test('stamp_pdf points to replace_text', () => {
    expect(STAMP_PDF_DESCRIPTION).not.toContain('It cannot change the text of a PDF')
    expect(STAMP_PDF_DESCRIPTION).toContain('edit_pdf replace_text does')
  })
})

describe('Word and PowerPoint: the document skills do what edit_office and comment_docx do not', () => {
  test('edit_office and comment_docx send a turn with the skills to them instead of a refusal', () => {
    expect(EDIT_OFFICE_DESCRIPTION).not.toContain('It cannot change speaker notes')
    expect(EDIT_OFFICE_DESCRIPTION).toContain('change such a part with that file\'s skill instead')
    expect(COMMENT_DOCX_DESCRIPTION).not.toContain('cannot be made here')
    expect(COMMENT_DOCX_DESCRIPTION).toContain('make them with the docx skill')
  })
  test('the skills rule says how an existing file is changed and saved back as a new version', () => {
    expect(DOC_SKILLS_RULE).toContain('speaker notes, charts, a table in a deck, tracked changes')
    expect(DOC_SKILLS_RULE).toContain('read the file, change a copy of it in $TRINA_WORK')
    expect(DOC_SKILLS_RULE).toContain('copy_files the result into the file\'s folder under the same name: over the file you read in this answer')
  })
})

test('unzip_file: other archives and password zips open in box_shell, the person unzips by hand only without it', () => {
  expect(UNZIP_FILE_DESCRIPTION).not.toContain('cannot be opened here')
  expect(UNZIP_FILE_DESCRIPTION).toContain('with box_shell, open them there')
})

test('write and edit on a binary file name the tool that changes or makes it, never "write .md instead"', () => {
  expect(binaryWriteHint('docx')).toContain('edit_office')
  expect(binaryWriteHint('xlsx')).toContain('edit_office')
  expect(binaryWriteHint('hwpx')).toContain('edit_hwp')
  expect(binaryWriteHint('pdf')).toContain('edit_pdf')
  expect(binaryWriteHint('zip')).toContain('make_zip')
  expect(binaryWriteHint('png')).toContain('resize_images')
  for (const e of ['docx', 'pptx', 'xlsx', 'hwp', 'hwpx', 'pdf', 'zip', 'png']) expect(binaryWriteHint(e)).not.toContain('.md')
  // a guest's turn has no edit_office, and edit_office refuses the older and OpenDocument formats
  expect(binaryWriteHint('docx')).toContain('edit_office when you have it')
  for (const e of ['xls', 'odt', 'ods']) {
    expect(binaryWriteHint(e)).not.toContain('edit_office')
    expect(binaryWriteHint(e)).toContain('cannot be changed here; make a new .docx or .xlsx with make_file')
  }
  // the Trina AX MCP connector (no chat turn) has none of the chat's file tools
  for (const e of ['docx', 'hwpx', 'pdf', 'zip', 'png']) {
    const c = binaryWriteHint(e, true)
    expect(c).toContain('upload_file')
    for (const t of ['edit_office', 'edit_hwp', 'edit_pdf', 'make_file', 'make_zip', 'resize_images', 'box_shell']) expect(c).not.toContain(t)
  }
})

test('"Where you run" leaves out what the turn\'s own tools reach on the person\'s computer', () => {
  for (const t of [ENVIRONMENT, environmentSection('selfhost', true)]) {
    expect(t).toContain('except what a tool offered here reaches there (the desktop app\'s browser, an app on their computer listed under "Connected services")')
  }
})
