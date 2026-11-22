// English status lines before a tool call stay out of a Korean, Japanese or Chinese answer
// (server/src/chat/narration.ts, docs/decisions/20261116-answer-no-english-narration.md).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { NarrationHold, narrationScript } from '../../server/src/chat/narration'
import { deliveredArgs } from '../../server/src/chat/turn'
import { TEAM_TOOL_PREFIX } from '@mycel/shared'

setDefaultTimeout(60_000)

type Ev = { text: string } | 'tool' | 'end'
/** the events through a hold, in pieces of n characters: what went out, joined */
function run(hold: NarrationHold, evs: Ev[], n = 7): string {
  let out = ''
  for (const e of evs) {
    if (e === 'tool') out += hold.toolStart({ path: 'shared' }) // a call of the main AI, its arguments known
    else if (e === 'end') out += hold.flush()
    else for (let i = 0; i < e.text.length; i += n) out += hold.push(e.text.slice(i, i + n))
  }
  return out
}
const ko = () => new NarrationHold('ko')

describe('NarrationHold', () => {
  /** the line before a call, then a Korean answer: was the line dropped? */
  const dropped = (line: string) => {
    const out = run(ko(), [{ text: line }, 'tool', { text: '\n\n끝.' }, 'end'])
    if (out !== '끝.') expect(out, line).toBe(line + '\n\n끝.') // else kept whole, nothing changed
    return out === '끝.'
  }

  // demo re-test 11-22: a Korean banner answer began "Try with a full team path." (the AI's next try after a tool
  // error; no tool's text says it)
  test("the AI's next try after an error is a note: dropped before a call; said to people, kept", () => {
    for (const line of ['Try with a full team path.', 'Try again with the project folder.', 'Retry using the full path.']) expect(dropped(line), line).toBe(true)
    for (const line of ['Try our new yuzu ginger tea.', 'Try the menu at the café.']) expect(dropped(line), line).toBe(false)
  })

  test('a Korean answer: the English line before a tool call is dropped, with its separator', () => {
    expect(run(ko(), [{ text: 'Only one thread exists; check it.' }, 'tool', { text: '\n\n' }, { text: '토요일 배송은 퀵으로만 가능해요.' }, 'end']))
      .toBe('토요일 배송은 퀵으로만 가능해요.')
    // two calls in a row, each with a line before it
    expect(run(ko(), [{ text: 'Let me check that the seal printed correctly.' }, 'tool', { text: '\n\nVerify:' }, 'tool', { text: '\n\n견적서를 만들었습니다.' }, 'end']))
      .toBe('견적서를 만들었습니다.')
    // Korean text first, then English lines before calls: the Korean keeps its separator to what follows
    expect(run(ko(), [{ text: '사진 두 장을 확인할게요.' }, 'tool', { text: '\n\nNow renaming.' }, 'tool', { text: '\n\n이름을 바꿨습니다.' }, 'end']))
      .toBe('사진 두 장을 확인할게요.\n\n이름을 바꿨습니다.')
    // a Korean file name alone does not make the line Korean; Korean words do
    expect(run(ko(), [{ text: '`매장-전경.jpg` 이름을 따를게요.' }, 'tool', { text: '\n\n끝.' }, 'end'])).toBe('`매장-전경.jpg` 이름을 따를게요.\n\n끝.')
  })

  test('the lines the AI scenario runs leaked: which are dropped, which still get through', () => {
    for (const line of [
      'Only one thread exists; check it.', 'Let me check that the seal printed correctly.', 'Verify:', 'Now renaming.',
      'The existing file uses the pattern "매장-전경.jpg", so I’ll match it.', 'The only thread is on the first message; check it.',
      'Let me check the folder.', 'Reading the price list.', 'Checking both files.', 'Let me check.', 'Found it.',
    ]) expect(dropped(line), line).toBe(true)
    // still kept: a quoted pattern with a colon reads like a label (the 11-17 rule drops the others of this list:
    // LEAKED_1117 below)
    for (const line of [
      'Existing pattern: "매장-전경.jpg" (hyphenated Korean).',
    ]) expect(dropped(line), line).toBe(false)
  })

  // the notes the AI scenario runs of 2026-11-17 still leaked into Korean answers after #1066 (catalog run 01-18-18, the
  // access rerun and the flow runs): short notes to itself before a call, in no fixed opening (decision
  // 20261117-answer-work-notes)
  const LEAKED_1117 = [
    'Find the price list first.', 'Find the price list file first.', 'Need to find the sales folder.', 'Need to find the contract draft.',
    'Need to find the CSV/scan.', 'Need to find the CSV.', 'I need to find the CSV first.', 'Need to find the CSV file in team drive.',
    'Need to find the scanned visit report.', 'Need to find the scan file.', 'Find the CSV first.', 'Find the shared meeting notes.',
    'Only one thread; read it.', "Only one thread; check whether it's about Saturday delivery.", 'No dedicated room; search messages.',
    'Search may miss variants; read both rooms.', 'No message mentions Saturday directly; check the one thread.',
    'No top-level message mentions Saturday; check the thread.', 'The quote-writer skill matches; load it.', 'Matches quote-writer skill. Load it.',
    "Skills folder is read-only for this user, but I'll attempt the edit and let the server decide.",
    'Let me also check for skill folders by file name.', 'Let me check page 2 is actually blank first.', 'Let me check page 2 first.',
    'Checking page 2 before removing.', 'Let me check both statements before merging.', "Nine files. I'll read them in parallel.",
    'No subfolders; save at project top.', 'No subfolders; save at project root.',
    'The project folder has no subfolders; files sit at the top, so save there.',
    "This is the company seal, so I'll stamp it on the PDF.", 'The other file in the folder is named in a "word-word.jpg" style, so I\'ll follow that.',
    "Page 2 is the last page, so I'll use the default.", 'Leaving page out (default is the last page, which is page 2).',
    'Need thread and the contract draft. Search files.', 'Use edit_pdf instead.', 'Two mails from the buyer. Read both.',
    'Read the PDF (to overwrite it) then regenerate.', 'Need to read the existing stamped file before replacing it.',
    "The new chart looks right, so I'll save it over the original file.", 'Now the PDF, via a print page with the chart drawn in.',
    "The user asked to save this link's content, so fetching it is what they requested.", 'The user asked to save the page behind this link. Fetch it.',
    'Try without the tracking parameters once.',
    "User's own dictated words.",
    'Following the existing naming pattern (매장-전경.jpg).', 'Existing naming pattern: "매장-전경.jpg" — Korean with hyphen.', "A `visit-report` folder is already there. Let me look at it first.",
  ]

  test('the notes that leaked on 11-17 are dropped before a call', () => {
    for (const line of LEAKED_1117) expect(dropped(line), line).toBe(true)
  })

  test('the same notes as the last piece (no call after them) are kept: position decides, not the words', () => {
    for (const line of LEAKED_1117) expect(run(ko(), [{ text: '확인했어요.\n\n' }, 'tool', { text: line }, 'end']), line).toBe('확인했어요.\n\n' + line)
  })

  test('11-18 (EDIT-17.project): the person\'s own words in quotes do not make a note Korean; an order where to put something is a note', () => {
    const msg = '공용 회의록에 라마바카페 견적 발송 완료라고 한 줄 추가해줘'
    const ask = () => new NarrationHold('ko', msg)
    for (const n of [1, 3, 7]) {
      expect(run(ask(), [{ text: '"공용 회의록" — likely in shared. Find it.' }, 'tool', { text: '\n\n' }, { text: '한 줄 넣었습니다.' }, 'end'], n)).toBe('한 줄 넣었습니다.')
      expect(run(ask(), [{ text: '확인했어요.' }, 'tool', { text: '\n\nAdd under section 1.' }, 'tool', { text: '\n\n넣었습니다.' }, 'end'], n)).toBe('확인했어요.\n\n넣었습니다.')
    }
    expect(dropped('Append it at the end of the notes.')).toBe(true)
    // CHT-02.room: a form's own label in brackets is a name, and "Now post …" after a sentence is a next step
    for (const n of [1, 2, 7]) expect(run(ko(), [{ text: 'Seal lands on (인) correctly. Now post to the room.' }, 'tool', { text: '\n\n올렸어요.' }, 'end'], n)).toBe('올렸어요.')
    for (const n of [1, 3, 7]) expect(run(ko(), [{ text: 'Seal lands on (서명 날인) correctly. Now post to the room.' }, 'tool', { text: '\n\n올렸어요.' }, 'end'], n)).toBe('올렸어요.')
    expect(dropped('Good layout. Now overwrite the original PDF.')).toBe(true)
    // an amount in a bracket is content
    for (const piece of ['Total (₩1,097,470); save the PDF.', 'Price updated (339,400원). Now save the PDF.'])
      for (const n of [1, 3, 7]) expect(run(ko(), [{ text: piece }, 'tool', { text: '\n\n끝.' }, 'end'], n), piece).toBe(piece + '\n\n끝.')
    // Korean around or after a bracket is still Korean; a bracketed amount is content
    for (const piece of ['견적서(인) 확인했어요.', '(합계) 1,097,470원', 'The total (합계) is due Friday.'])
      expect(run(ko(), [{ text: piece }, 'tool', { text: '\n\n끝.' }, 'end']), piece).toBe(piece + '\n\n끝.')
    // an apostrophe after a letter opens no quote: the person's quoted words are still found
    expect(run(ask(), [{ text: 'I’ll check "공용 회의록" first.' }, 'tool', { text: '\n\n끝.' }, 'end'])).toBe('끝.')
    // a quote that is not the person's words still keeps the line, and Korean after the quote streams as before
    expect(run(new NarrationHold('ko', '회의록에 추가해줘'), [{ text: '"공용 회의록" — likely in shared. Find it.' }, 'tool', { text: '\n\n끝.' }, 'end']))
      .toBe('"공용 회의록" — likely in shared. Find it.\n\n끝.')
    const h = ask()
    expect(h.push('"공용 회의록"에 ')).toBe('"공용 회의록"에 ')
    // the same lines as the last piece are kept; placing orders said to people are kept
    expect(run(ask(), [{ text: '확인했어요.\n\n' }, 'tool', { text: 'Add under section 1.' }, 'end'])).toBe('확인했어요.\n\nAdd under section 1.')
    for (const piece of ['Please add under section 1.', 'Add your name under section 1, Sora.', 'Put it in the fridge.', 'Add milk to the list.'])
      expect(run(ask(), [{ text: piece }, 'tool', { text: '\n\n끝.' }, 'end']), piece).toBe(piece + '\n\n끝.')
  })

  test('a note that is copied into the next call (a message posted, a file written) or that the person wrote is content', () => {
    const line = 'No price list in sales; check the shared folder.'
    expect(dropped(line)).toBe(true)
    const posted = new NarrationHold('ko')
    expect(run(posted, [{ text: line }])).toBe('')
    expect(posted.toolStart({ room: 'r1', text: line })).toBe(line)
    const written = new NarrationHold('ko')
    run(written, [{ text: 'Save to project root.' }])
    expect(written.toolStart({ file_path: 'projects/x/memo.md', content: '# Memo\n\nSave to project root. Ask Sora first.' })).toBe('Save to project root.')
    const quoted = new NarrationHold('ko', '이 문장 다듬어줘 Find the price list first')
    run(quoted, [{ text: 'Find the price list first.' }])
    expect(quoted.toolStart({ path: 'shared' })).toBe('Find the price list first.')
    // a call whose arguments do not hold the note still drops it
    const other = new NarrationHold('ko', '단가표 찾아줘')
    run(other, [{ text: 'Find the price list first.' }])
    expect(other.toolStart({ query: '단가표' })).toBe('')
  })

  test('English content before a call that names work things is kept when it speaks to people or is a title', () => {
    for (const piece of ['Hi all, the updated price list is in the shared folder.', 'Please find the attached file.', 'Your file is ready.',
      'We moved the meeting notes to the project folder.', 'Thanks for the report.', 'Q3 Sales Report', 'Project Phoenix Kickoff Notes',
      'Lamaba Cafe Price List', 'The user guide is attached.', 'Dear team, the contract is signed.', 'Read more at https://example.com/file'])
      expect(run(ko(), [{ text: piece }, 'tool', { text: '\n\n끝.' }, 'end']), piece).toBe(piece + '\n\n끝.')
  })

  test('Japanese and Chinese answers drop the same work notes', () => {
    for (const script of ['ja', 'zh'] as const) {
      expect(run(new NarrationHold(script), [{ text: 'Find the price list first.' }, 'tool', { text: '\n\n完了。' }, 'end'])).toBe('完了。')
      expect(run(new NarrationHold(script), [{ text: 'Sora, the file is ready.' }, 'tool', { text: '\n\n完了。' }, 'end'])).toBe('Sora, the file is ready.\n\n完了。')
    }
  })

  test('a work note is dropped only before a real call: thinking, a stop or an error keep it (review of the 11-17 rule)', () => {
    const h = ko()
    h.push('Find the price list first.')
    expect(h.toolStart()).toBe('Find the price list first.') // no arguments: thinking / stop / error
    const s = ko()
    s.push('Let me check the folder.')
    expect(s.toolStart()).toBe('') // #1066's status openings drop there as before
  })

  test('the review\'s probe: orders and plans said to people, common office words, sentence-case titles are kept', () => {
    for (const piece of ['Read the attached file before the meeting.', 'Use the link below to sign the contract.',
      'Check the invoice against the PO before paying.', 'Use code SAVE10 at checkout.', 'Read the contract carefully; the penalty clause changed.',
      'Find attached the signed copy.', "I'll send the invoice tomorrow.", "I'll call the client after lunch.", 'Project kickoff on Monday.',
      'Server maintenance tonight.', 'Drive safely.', 'The project is on hold.', 'This version is final.', 'Edit: the deadline moved to Friday.',
      'Photos from the event.', 'Error: file not found.', 'Q3 project plan', 'Server migration checklist', 'Photo release form',
      'Draft agreement for Acme Corp', 'New hire onboarding project', 'Send it and/or post it.', 'This user has admin rights.',
      "User's guide attached.", 'Meet at 5 a.m. sharp.', 'The file link in my last answer had a typo.',
      // the second review's probe
      'Do not share this file outside the team.', "Don't delete the original file.", 'Never edit the master file.', 'Confidential file.',
      'Sora, the file is ready.', 'Mr. Kim, the contract file is ready.', 'Folks, the file is ready.', 'Kindly resend the file.',
      'Resend the file by Friday, Sora.', 'FYI the price list file was updated.', 'Heads up, the shared folder will be read-only tonight.',
      'Deadline for files is Friday.', 'Sign both copies.', 'Print both pages.', 'Keep the original file.', 'Save to shared folder.',
      'Copy the file to the shared folder before Friday.', 'File not found.', 'The PDF is password protected.', 'The link has expired.',
      'Rows with blank emails were skipped.', 'Original file kept.', 'Totals match the PDF.', 'Mismatch: the PDF and the CSV disagree.',
      'This user has no access to the folder.', 'The file name should be "report-2026.pdf".', 'Meeting notes file attached.',
      'Need to sign the contract by Friday.', 'Need approval from finance.', 'Fetch the mail from the front desk.',
      'Load the paper tray before printing.', 'Look for the red seal on page 2.', 'Search is case sensitive.',
      'Let me check the file. The total is wrong. Fix it.', 'Checking the folder. The invoice is overdue. Pay today.'])
      expect(run(ko(), [{ text: piece }, 'tool', { text: '\n\n끝.' }, 'end']), piece).toBe(piece + '\n\n끝.')
  })

  test('a piece posted with small changes (Markdown, HTML, an emoji, an entity) still counts as copied', () => {
    const cases: [string, unknown][] = [
      ['Price list updated. Check the shared folder.', { text: '📢 Price list updated! Check the shared folder.' }],
      ['The updated price list is in the shared folder.', { text: '**The updated price list** is in the shared folder.' }],
      ['The updated price list is in the shared folder.', { html: '<p>The updated price list is in the <b>shared folder</b>.</p>' }],
      ["I'll read the file tonight.", { text: 'I&#39;ll read the file tonight.' }],
      ['No price list in sales; check the shared folder.', { text: 'No price list in sales (v3); please check the shared folder.' }],
      ['No price list in sales; check the shared folder.', { a: { b: { c: { d: { e: { f: { g: { text: 'No price list in sales; check the shared folder.' } } } } } } } }],
    ]
    for (const [piece, input] of cases) {
      const h = ko()
      h.push(piece)
      expect(h.toolStart(input), piece).toBe(piece)
    }
  })

  test('known gaps: kept although they are notes (numbers with units, another language, Markdown)', () => {
    for (const line of [
      'The seal box: top 191mm + 15mm margin = 206mm from page top, left 110+15=125mm, box 50×26. Seal ~22mm wide centered: x≈139, y≈208.',
      'Ich lese die 9 Dateien, um sie zu beschreiben.', 'I used the **meeting-tasks** team skill.', 'Only difference: next meeting time.',
      // three sentences (a held piece goes out at its third sentence mark, as in #1066), or only a description
      'The file exists. Trying the edit; server decides access.', 'Only one file. Save to users/sora - perhaps a subfolder; check the folder.', 'Files sit loose at top of project; no subfolders. Save to project root keeping name.', 'Try team-root path.', 'Row 4 (header row 1), column 3.', 'The Saturday delivery discussion is in this thread.', 'The Saturday delivery question is in the thread under the copy paper price message.',
    ]) expect(dropped(line), line).toBe(false)
  })

  test('a Korean line before a tool call is kept, and streams as soon as it shows Hangul', () => {
    const h = ko()
    expect(h.push('파일을 ')).toBe('파일을 ')
    expect(h.push('확인할게요.')).toBe('확인할게요.')
    expect(h.toolStart()).toBe('')
    expect(run(ko(), [{ text: '파일을 확인할게요.' }, 'tool', { text: '\n\n다 됐어요.' }, 'end'])).toBe('파일을 확인할게요.\n\n다 됐어요.')
  })

  // 2026-11-18 TC-4865: a real Korean answer after a read-only refusal opened with this line (it paraphrases the write-
  // access rule of the instructions): before a call, and in one piece with the Korean answer and no call between
  const READ_ONLY_LINE = 'That folder is listed as read-only, but I should call the tool and let the server decide.'
  const KO_ANSWER = '폴더에 쓸 권한이 없어서 압축을 풀지 못했어요.\n\n- 압축 파일: 계약-묶음.zip\n- 이유: 읽기 전용 폴더'
  test('11-18 (TC-4865): the AI thinking aloud about its tools is dropped before a call and at the top of the Korean answer', () => {
    expect(dropped(READ_ONLY_LINE)).toBe(true)
    for (const n of [1, 4, 7, 50, 500]) {
      expect(run(ko(), [{ text: READ_ONLY_LINE }, 'tool', { text: '\n\n' + KO_ANSWER }, 'end'], n), String(n)).toBe(KO_ANSWER)
      expect(run(ko(), [{ text: READ_ONLY_LINE + '\n\n' + KO_ANSWER }, 'end'], n), String(n)).toBe(KO_ANSWER)
      expect(run(ko(), [{ text: READ_ONLY_LINE + '\n' + KO_ANSWER }, 'tool', { text: '\n\n끝.' }, 'end'], n), String(n)).toBe(KO_ANSWER + '\n\n끝.')
    }
    for (const line of ['I should call the tool and let the server decide.', 'The folder is marked as read-only; just call the tool.', "I'll just try the tool and see."])
      expect(run(ko(), [{ text: line + '\n\n' + KO_ANSWER }, 'end']), line).toBe(KO_ANSWER)
    // review of #1272: report lines above Korean text stay (only a status opening or thinking aloud about the tool goes)
    for (const top of ['No files found.', 'Two rows were added.', 'The server checks the token.', 'The server decides the retry policy.', 'Use this tool for invoices.', 'I need to call the vendor.', 'Read me first'])
      for (const n of [1, 7, 500]) expect(run(ko(), [{ text: top + '\n\n' + KO_ANSWER }, 'end'], n), top).toBe(top + '\n\n' + KO_ANSWER)
    // a status line at the top of the answer goes the same way; content at the top stays
    expect(run(ko(), [{ text: 'Let me check the folder.\n\n' + KO_ANSWER }, 'end'])).toBe(KO_ANSWER)
    for (const top of ['Q3 Sales Report', 'Dear Ms. Kim, thank you for the order.', 'Let me know if anything is missing.', 'Total: 42 files'])
      expect(run(ko(), [{ text: top + '\n\n' + KO_ANSWER }, 'end']), top).toBe(top + '\n\n' + KO_ANSWER)
    // the person's own words, and an answer in English asked for, are left alone
    expect(run(new NarrationHold('ko', 'I should call the tool and let the server decide 라고 번역해줘'), [{ text: 'I should call the tool and let the server decide.\n\n' + KO_ANSWER }, 'end'])).toContain('I should call the tool')
    expect(run(new NarrationHold(null), [{ text: READ_ONLY_LINE + '\n\n' + KO_ANSWER }, 'end'])).toBe(READ_ONLY_LINE + '\n\n' + KO_ANSWER)
  })

  test('11-22 (owner, live): "Now the SKILL.md." is dropped before a call and at the top of a Korean answer; a file name is the work named', () => {
    // a lead-in right before a call leads into the call (above text it leads into that text: kept)
    expect(dropped('Quick speed test on a short stretch first:')).toBe(true)
    expect(run(ko(), [{ text: 'Totals by client:\n\n' + KO_ANSWER }, 'end'])).toBe('Totals by client:\n\n' + KO_ANSWER)
    // a change to its own work as an order to itself (Claude Code, the same day)
    expect(dropped('Shrink the chart a bit so it fits on one page.')).toBe(true)
    expect(dropped('Encoding is wrapping up.')).toBe(true)
    // make_file's slide guidance said back as a plan to itself (TC-r2b-05, Claude Code rerun)
    expect(dropped('Use only "##" headings; the title slide becomes the first one.')).toBe(true)
    expect(dropped('Rendering is still running.')).toBe(true)
    expect(dropped('Sales is growing fast this quarter, team!')).toBe(false)
    for (const line of ['Now the SKILL.md.', 'Now the 견적서.pdf.', 'Now the PDF.']) {
      expect(dropped(line), line).toBe(true)
      for (const n of [1, 7, 500]) expect(run(ko(), [{ text: line + '\n\n' + KO_ANSWER }, 'end'], n), line).toBe(KO_ANSWER)
    }
    // content at the top of the answer stays
    for (const top of ['Now open on weekends.', 'Now the price list is in Sales, Sora.', 'No files found.'])
      expect(run(ko(), [{ text: top + '\n\n' + KO_ANSWER }, 'end']), top).toBe(top + '\n\n' + KO_ANSWER)
    // the last piece stays whatever it says
    expect(run(ko(), [{ text: 'Now the SKILL.md.' }, 'end'])).toBe('Now the SKILL.md.')
  })

  test('the last piece is always kept: an English email asked for in a Korean chat', () => {
    const email = 'Dear Mr. Smith,\n\nThank you for your order. We will ship it on Thursday.\n\nBest regards,\nSora Lee'
    expect(run(ko(), [{ text: '단가표를 읽을게요.' }, 'tool', { text: '\n\n' + email }, 'end'])).toBe('단가표를 읽을게요.\n\n' + email)
    // a short English answer with no call after it
    expect(run(ko(), [{ text: 'OK.' }, 'end'])).toBe('OK.')
    // the message asks for English: the hold is off, even for a short line before a call
    expect(narrationScript('ko', '이 메일을 영어로 써서 방에 올려줘')).toBeNull()
    expect(narrationScript('ko', 'translate this: 감사합니다')).toBeNull()
  })

  test('content is never dropped: code, quotes, links, tables, longer text', () => {
    for (const piece of ['```\nnpm run build\n```', 'He wrote "see you Thursday".', 'See [price list](/files/view?path=x).', '| a | b |', '> quoted', 'One. Two. Three. Four.', 'x'.repeat(201),
      // the review's probe (#1066): content written before a call
      'Work smarter, together.', 'Hi team, the deploy is done.', 'https://example.com/report', 'Trina AX', 'Total: 42 files',
      '- Price: 339,400 KRW\n- Due: Friday', '## Results', '**Summary**', 'Run `npm install`.', 'Hola equipo, ya está listo.', 'Xin chào, đã xong.',
      // a status opening, but content: a number with a unit, a link, a list
      'Let me note: 339,400 KRW total.', 'Now see https://example.com', 'Next:\n- one', 'Hi team, I will be out on Friday.',
      // the review's second round: real content that opens like a status line
      'Let me know if you have questions.', 'Let me introduce our new product.', "Let's grow together.", 'Now available on iOS and Android.',
      'Next-gen office automation.', 'First come, first served.', 'Check it out!', 'I will be out of office on Friday.',
      "I'm happy to announce our new hire.", 'Done is better than perfect.', 'Good things take time.', 'Great work, team!',
      'Only the paranoid survive.', 'Still waiting for your reply.', 'No pain, no gain.', 'OK', 'Following up on my last email.',
      'Same day delivery', 'I can help you with that.', 'I need your approval by Monday.', 'We will confirm it by Friday.',
      'Please check it and let me know.', 'The user guide is attached.', 'Looking forward to working with you.',
      'First, preheat the oven.', 'Opening hours: Mon to Fri', 'Verify your email address', 'Reading list for the week',
      'Okay, sounds good to me.', 'I see what you mean.', 'Now open on weekends.', 'I will check in with you tomorrow.']) {
      expect(run(ko(), [{ text: piece }, 'tool', { text: '\n\n끝.' }, 'end']), piece).toBe(piece + '\n\n끝.')
    }
    // no Latin letters (numbers, marks): kept
    expect(run(ko(), [{ text: '339,400' }, 'tool', { text: '\n\n끝.' }, 'end'])).toBe('339,400\n\n끝.')
  })

  test('content streams as soon as a mark shows it is content; until then it waits for the next event', () => {
    const h = ko()
    expect(h.push('Great work, ')).toBe('')
    expect(h.push('team!')).toBe('Great work, team!')
    expect(h.push(' See you.')).toBe(' See you.')
    expect(h.toolStart()).toBe('')
    const w = ko()
    expect(w.push('Hi team, the deploy is done.')).toBe('') // could still go on ", so I'll check …"
    expect(w.toolStart()).toBe('Hi team, the deploy is done.')
  })

  test('the hold follows the language asked for and the person\'s earlier message', () => {
    for (const m of ['인도네시아어로 공지 써서 슬랙에 올려줘', '스페인어로 써줘', '일본말로 바꿔줘', '중국어 버전도 만들어줘', '이거 영문으로'])
      expect(narrationScript('ko', m), m).toBeNull()
    expect(narrationScript('ja', 'スペイン語で書いて')).toBeNull()
    expect(narrationScript('zh', '用西班牙语写一封信')).toBeNull()
    // text often written in English in a Korean chat, and a message that quotes English
    for (const m of ['슬로건 하나 만들어줘', '커밋 메시지 써줘', '저장 버튼 문구 정해줘', '이 문장 "Work smarter, together" 다듬어줘', '버튼 이름: Save all changes 로 바꿔'])
      expect(narrationScript('ko', m), m).toBeNull()
    // ...unless the message gives the new words in Korean (demo re-test 11-22: "Try with a full team path." opened the
    // answer to a banner request)
    for (const m of ["배너 문구를 '작지 않아 큰 햇살이야!'로 바꿔줘", '헤드라인 문구 작지 않아 큰 햇살이야!로 바꿔 줘', '버튼 문구 "지금 사러 가기"로'])
      expect(narrationScript('ko', m), m).toBe('ko')
    expect(narrationScript('ja', 'ボタンの文言を「今すぐ購入」に')).toBe('ja')
    // short or mixed messages: the app language, unless the message before was in Latin words
    for (const m of ['ok', 'continue', '👍', '', 'Q3 revenue was up 12% and costs fell.\n이거 요약해줘'])
      expect(narrationScript('ko', m), m).toBe('ko')
    expect(narrationScript('ko', 'ok', 'What did we agree in the room?')).toBeNull()
    expect(narrationScript('ko', 'ok', '방에서 뭐라고 정했어?')).toBe('ko')
  })

  test('engine shapes: Codex messages carry their separator; several calls in one round', () => {
    // Codex: each agent_message comes whole, the separator in front
    expect(run(ko(), [{ text: 'Let me check the folder.' }, 'tool', { text: '\n\nReading the price list.' }, 'tool', { text: '\n\n견적서를 만들었어요.' }, 'end'], 1000))
      .toBe('견적서를 만들었어요.')
    // the API engine: one line, then several calls before any more text
    expect(run(ko(), [{ text: 'Checking both files.' }, 'tool', 'tool', 'tool', { text: '\n\n두 파일 다 확인했어요.' }, 'end'])).toBe('두 파일 다 확인했어요.')
    // an answer that ends on a call: nothing comes back
    expect(run(ko(), [{ text: 'Let me check.' }, 'tool', 'end'])).toBe('')
  })

  test('a long piece goes out as soon as it is known to be content', () => {
    const h = ko()
    expect(h.push('Let me ' + 'a'.repeat(143))).toBe('')
    expect(h.push('b'.repeat(60))).toBe('Let me ' + 'a'.repeat(143) + 'b'.repeat(60))
    expect(h.push(' more')).toBe(' more')
    expect(h.toolStart()).toBe('')
  })

  test('English, Indonesian and Spanish answers are untouched; Japanese and Chinese drop like Korean', () => {
    for (const locale of ['en', 'id', 'es'] as const) {
      const h = new NarrationHold(narrationScript(locale, 'check the price list'))
      expect(run(h, [{ text: 'Let me check.' }, 'tool', { text: '\n\nDone.' }, 'end'])).toBe('Let me check.\n\nDone.')
    }
    // a Korean app, a message in English: the answer is English, nothing is dropped
    expect(narrationScript('ko', 'What did we agree in the room?')).toBeNull()
    expect(narrationScript('ko', '방에서 뭐라고 정했어?')).toBe('ko')
    expect(run(new NarrationHold(narrationScript('ja', '見積書を作って')), [{ text: 'Let me check.' }, 'tool', { text: '\n\n作りました。' }, 'end'])).toBe('作りました。')
    expect(run(new NarrationHold(narrationScript('zh', '做一份报价单')), [{ text: 'Let me check.' }, 'tool', { text: '\n\n做好了。' }, 'end'])).toBe('做好了。')
  })

  test('clear forgets what is held', () => {
    const h = ko()
    h.push('Let me')
    expect(h.held).toBe('Let me')
    h.clear()
    expect(h.flush()).toBe('')
  })
})

// ---------------- real turns: what streams is what is saved ----------------
const GATE = path.join(import.meta.dir, '../../native/bin', `${process.platform}-${process.arch}`, 'mycel-gate')
const native = fs.existsSync(GATE)
/** the fake engine's directives, their Latin letters written as \\u escapes: the message itself then quotes no English
 * (a quote of 3+ English words turns the hold off, narrationScript) */
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d).replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/[A-Za-z]/g, (c) => '\\u00' + c.charCodeAt(0).toString(16)))).join('\n')

describe('a turn with an English line before a tool call', () => {
  let h: Harness
  const published: { userId: string; ev: any }[] = []
  beforeAll(async () => {
    h = await startHarness({ name: 'narration-hold' })
    const hub = h.rt().hub
    const publish = hub.publish.bind(hub)
    hub.publish = (userId, ev) => { published.push({ userId, ev: JSON.parse(JSON.stringify(ev)) }); publish(userId, ev) }
  })
  afterAll(async () => { await h?.close() })

  async function turn(locale: string, content: string) {
    h.ctx.db.query('UPDATE users SET locale = ? WHERE id = ?').run(locale, 'alice')
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const started = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const id = started.assistantMessage.id
    const doneEv = await waitFor(() => published.find((p) => p.ev.type === 'message.done' && p.ev.data.messageId === id), { timeoutMs: 40_000, what: 'message.done' })
    const deltas = published.filter((p) => p.ev.type === 'message.delta' && p.ev.data.messageId === id).map((p) => p.ev.data as { offset: number; text: string; reset?: boolean })
    let streamed = ''
    // a reset takes text out from its offset (an interim piece a call ended)
    for (const d of deltas) { if (d.reset) { streamed = streamed.slice(0, d.offset); continue } expect(d.offset).toBe(streamed.length); streamed += d.text }
    const stored = (h.ctx.db.query('SELECT content FROM messages WHERE id = ?').get(id) as { content: string }).content
    return { streamed, stored, done: doneEv!.ev.data.message.content as string }
  }

  test.skipIf(!native)('Korean: the English line is neither streamed nor saved; the stream and the saved answer agree', async () => {
    const t = await turn('ko', '단가표 확인해줘\n' + fake(
      { say: 'Let me check that the seal printed correctly.' },
      { tool: 'read', args: { file_path: 'shared/없는-파일.txt' } },
      { say: '단가표를 확인했어요. ' },
      { tool: 'read', args: { file_path: 'shared/없는-파일.txt' } },
      { say: 'Dear Mr. Smith, thank you for your order.' },
    ))
    expect(t.streamed).toBe(t.stored)
    expect(t.done).toBe(t.stored)
    expect(t.stored).not.toContain('Let me check')
    // 2026-11-22 (structural): every piece a call follows is interim; only the text after the last call is the answer
    expect(t.stored).toBe('Dear Mr. Smith, thank you for your order.')
  })

  test.skipIf(!native)('Korean: a work note in no fixed opening is dropped; one copied into the call is kept (11-17)', async () => {
    const t = await turn('ko', '단가표 찾아줘\n' + fake(
      { say: 'Find the price list first.' },
      { tool: 'read', args: { file_path: 'shared/없는-파일.txt' } },
      { say: 'Only one file; read it.' },
      { tool: 'read', args: { file_path: 'shared/only one file; read it' } },
      { say: '단가표가 없어요.' },
    ))
    expect(t.streamed).toBe(t.stored)
    expect(t.done).toBe(t.stored)
    // the piece copied into the call is content and stays; the work note before the first call is interim
    expect(t.stored).toBe('Only one file; read it.\n\n단가표가 없어요.')
  })

  test.skipIf(!native)('Korean, ending on a tool call: the dropped line does not come back as the whole text', async () => {
    const t = await turn('ko', '파일 확인해줘\n' + fake({ say: 'Let me check the file.' }, { tool: 'read', args: { file_path: 'shared/없는-파일.txt' } }))
    expect(t.streamed).toBe(t.stored)
    expect(t.stored).not.toContain('Let me check')
  })

  test.skipIf(!native)('Korean with a sub-agent: its calls do not decide the main line; the answer is the main text only', async () => {
    const t = await turn('ko', '두 폴더 확인해줘\n' + fake(
      { say: 'Let me split this up.' },
      { agents: [{ id: 'a1', type: 'general-purpose', description: 'look', steps: [{ say: 'Child text.' }, { tool: 'read', args: { file_path: 'shared/없는-파일.txt' } }] }] },
      { say: '두 폴더 다 확인했어요.' },
    ))
    expect(t.streamed).toBe(t.stored)
    expect(t.stored).toBe('두 폴더 다 확인했어요.')
  })

  test.skipIf(!native)('Korean, stopped with a status line held: it is dropped; the stream and the saved answer agree', async () => {
    h.ctx.db.query('UPDATE users SET locale = ? WHERE id = ?').run('ko', 'alice')
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const started = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: '파일 확인해줘\n' + fake({ say: '먼저 볼게요.' }, { tool: 'read', args: { file_path: 'shared/없는-파일.txt' } }, { say: 'Let me check one more.' }, { sleep: 20_000 }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const id = started.assistantMessage.id
    await waitFor(() => published.find((p) => p.ev.type === 'message.delta' && p.ev.data.messageId === id && p.ev.data.text.includes('먼저')), { timeoutMs: 20_000, what: 'first text' })
    await Bun.sleep(500)
    await h.api('alice').call(API.stop, { params: { id: chat.id } })
    const doneEv = await waitFor(() => published.find((p) => p.ev.type === 'message.done' && p.ev.data.messageId === id), { timeoutMs: 30_000, what: 'message.done' })
    let streamed = ''
    for (const d of published.filter((p) => p.ev.type === 'message.delta' && p.ev.data.messageId === id).map((p) => p.ev.data)) streamed = d.reset ? streamed.slice(0, d.offset) : streamed + d.text
    const stored = (h.ctx.db.query('SELECT content FROM messages WHERE id = ?').get(id) as { content: string }).content
    expect(stored).toBe('먼저 볼게요.')
    expect(streamed).toBe(stored)
    expect(doneEv!.ev.data.message.content).toBe(stored)
  })

  test.skipIf(!native)('English: a piece a call follows is interim too (docs/decisions/20261122-interim-text-every-language.md)', async () => {
    const t = await turn('en', 'check the price list\n' + fake(
      { say: 'Let me check that the seal printed correctly.' },
      { tool: 'read', args: { file_path: 'shared/missing.txt' } },
      { say: 'Done.' },
    ))
    expect(t.streamed).toBe(t.stored)
    expect(t.done).toBe(t.stored)
    expect(t.stored).toBe('Done.')
  })

  test.skipIf(!native)('English, QA batch 3 flow 2: the AI\'s reasoning about its rules before an edit is a thinking step, not the answer', async () => {
    const t = await turn('en', 'make the red a bit darker\n' + fake(
      { tool: 'read', args: { file_path: 'shared/missing.txt' } },
      { say: 'Same requester (QA Member) changing their own red, so just do it. #c81e1e → darker, e.g. #9b1515 (rgb 155,21,21).' },
      { tool: 'read', args: { file_path: 'shared/missing.txt' } },
      { say: 'I made the header bar a darker red: it went from #c81e1e to #9b1515.' },
    ))
    expect(t.streamed).toBe(t.stored)
    expect(t.done).toBe(t.stored)
    expect(t.stored).toBe('I made the header bar a darker red: it went from #c81e1e to #9b1515.')
    // in a Korean answer too (the same position rule)
    const k = await turn('ko', '빨간색 좀 더 진하게\n' + fake(
      { say: 'Same requester, so just do it.' },
      { tool: 'read', args: { file_path: 'shared/missing.txt' } },
      { say: '헤더를 더 진한 빨간색으로 바꿨어요.' },
    ))
    expect(k.stored).toBe('헤더를 더 진한 빨간색으로 바꿨어요.')
  })

  test.skipIf(!native)('English: no text after the last call: the last piece is the answer; a status line never is; a piece copied into the call stays', async () => {
    const t = await turn('en', 'check the file\n' + fake({ say: 'The file is empty.' }, { tool: 'read', args: { file_path: 'shared/missing.txt' } }))
    expect(t.streamed).toBe(t.stored)
    expect(t.stored).toBe('The file is empty.')
    const s = await turn('en', 'check the file\n' + fake({ say: 'Let me check the file.' }, { tool: 'read', args: { file_path: 'shared/missing.txt' } }))
    expect(s.stored).not.toContain('Let me check')
    // a draft shown, then written to a file word for word: content, kept
    const d = await turn('en', 'draft the notice\n' + fake(
      { say: 'Office closed on Friday for maintenance.' },
      { tool: 'write', args: { file_path: 'users/alice/notice.md', content: 'Office closed on Friday for maintenance.' } },
      { say: 'Saved.' },
    ))
    expect(d.stored.replace(/\s+/g, ' ')).toBe('Office closed on Friday for maintenance. Saved.')
  })

  test.skipIf(!native)('no tool call: the text is the answer, unchanged', async () => {
    const t = await turn('ko', '안녕\n' + fake({ say: '안녕하세요. 무엇을 도와드릴까요?' }))
    expect(t.streamed).toBe(t.stored)
    expect(t.stored).toBe('안녕하세요. 무엇을 도와드릴까요?')
  })

  test.skipIf(!native)('no text after the last call: the last interim piece is the answer, so it is never blank', async () => {
    const t = await turn('ko', '파일 확인해줘\n' + fake({ say: '파일을 확인했고 내용은 비어 있어요.' }, { tool: 'read', args: { file_path: 'shared/없는-파일.txt' } }))
    expect(t.streamed).toBe(t.stored)
    expect(t.stored).toBe('파일을 확인했고 내용은 비어 있어요.')
  })

  test.skipIf(!native)('Korean with English pieces between calls: only the Korean final reply is saved, the pieces are thinking steps', async () => {
    const t = await turn('ko', '보고서 만들어줘\n' + fake(
      { say: 'Good result. Saving it.' },
      { tool: 'read', args: { file_path: 'shared/없는-파일.txt' } },
      { say: 'The working directory is set.' },
      { tool: 'read', args: { file_path: 'shared/없는-파일.txt' } },
      { say: '보고서를 만들었어요.' },
    ))
    expect(t.streamed).toBe(t.stored)
    expect(t.stored).toBe('보고서를 만들었어요.')
  })

  test.skipIf(!native)('Korean: a line that says what the next command\'s step label says is narration, not content copied into the call (QA TC-f3-05)', async () => {
    const t = await turn('ko', '할 일 표에 마감일 칸 추가해줘\n' + fake(
      { say: 'Install python-docx in a venv.' },
      // (the command and its step label both say what the line says: still no content the call delivers)
      { tool: 'box_shell', args: { command: 'python3 -m venv .venv && .venv/bin/pip -q install python-docx', description: 'Install python-docx in a venv' } },
      { say: '할 일 표에 "마감일" 칸을 추가했습니다.' },
    ))
    expect(t.streamed).toBe(t.stored)
    expect(t.done).toBe(t.stored)
    expect(t.stored).toBe('할 일 표에 "마감일" 칸을 추가했습니다.')
  })

  test.skipIf(!native)('a bookkeeping call after the answer (a title) ends no piece: the answer stays', async () => {
    const t = await turn('ko', '단가 알려줘\n' + fake({ say: 'A형은 1,200,000원이에요.' }, { tool: 'set_title', args: { title: '단가 확인' } }, { say: ' 더 필요하면 말씀해 주세요.' }))
    expect(t.streamed).toBe(t.stored)
    expect(t.stored.replace(/\s+/g, ' ')).toBe('A형은 1,200,000원이에요. 더 필요하면 말씀해 주세요.')
  })
})

describe('deliveredArgs (QA TC-f3-05)', () => {
  test('a command, a sub-agent\'s brief and a step\'s label deliver no words; every other call\'s arguments do', () => {
    const cmd = { command: 'python3 -m venv .venv && .venv/bin/pip -q install python-docx', description: 'Install python-docx in a venv' }
    const line = 'Install python-docx in a venv.'
    expect(deliveredArgs(TEAM_TOOL_PREFIX + 'box_shell', cmd, line)).toEqual({})
    expect(deliveredArgs('Bash', cmd, line)).toEqual({})
    expect(deliveredArgs('Agent', { prompt: 'p', description: 'd' }, line)).toEqual({})
    // a command that writes the piece word for word (a heredoc to a file): content, kept
    const report = '매출 보고서: 이번 주 매출은 1,200만 원입니다.'
    const heredoc = { command: `cat > report.md <<'EOF'\n${report}\nEOF`, description: 'Save the report' }
    expect(deliveredArgs('Bash', heredoc, report)).toEqual({ command: heredoc.command })
    // a call that delivers words (a post, an event's description) keeps them: a piece copied there stays as content
    const event = { title: 'Launch', description: 'Bring the samples.' }
    expect(deliveredArgs(TEAM_TOOL_PREFIX + 'calendar_create', event, 'Bring the samples.')).toBe(event)
  })
})
