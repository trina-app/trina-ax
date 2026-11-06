// The English side of what belonged to one run (docs/DECISIONS.md "S"; server/src/onboarding/specifics.ts): from a US
// marketing team's two meeting notes, the answer they got and a quote template, the people (accounts and not, in each
// form), customers with a company suffix, US dates, dollar amounts, phones and document numbers are found; structure
// words, form labels, roles, weekdays and months alone, sentence starts and counts are not; and a clean skill keeps
// its card while a leaking one names what it leaks.
import { describe, expect, test } from 'bun:test'
import { leftoversIn, outsideIn, specificsOf } from '../../server/src/onboarding/specifics'

const SYNC = `# Weekly marketing sync — Mon 11/2

Attendees: Jordan Lee, Sarah K., Mike (sales), Priya Patel, Dan Brooks

## Updates
- Fall webinar signups are at 142. Goal is 200 by Nov 20.
- Holiday promo budget approved: $4,500 across search and social.
- LinkedIn ads ran about 1.2k over budget in October.

## Decisions
- December newsletter theme: "Year in review".

## Action items
- Sarah: draft the webinar reminder email by Thursday.
- Sarah K. to send the final speaker bios to Mike from sales by 11/6.
- Mike from sales: share the top 10 accounts list with the team.
- Priya — landing page copy for the holiday promo, first draft by Fri 11/6.
- Dan to pull the October ad numbers before next sync.
- Someone needs to check the image rights for the case study photos.
- Everyone: add your December PTO to the shared calendar.`

const KICKOFF = `# Holiday campaign kickoff — November 4th

Present: Jordan, Sarah Klein, Priya, Dan. Mike joined late.

## Notes
- Client: Brightline Outdoor LLC. Contact: Ms. Rivera (rivera@brightline.example, (415) 555-0134).
- Launch is Nov 23. Wrap-up report due December 4th.
- Jordan will confirm the $12,000 media plan with Ms. Rivera by Monday.

## Next steps
- Priya owns the landing page.
- Dan sets up conversion tracking before launch.
- Sarah K.: three social posts for launch week, drafts by 11/16.
- Mike to ask Mr. Chen at Northwind Traders, Inc. about a co-marketing slot.
- Press release: Mike or Sarah? Not decided.
- Next review: 11/10, 2pm PT.`

/** the meeting-tasks answer the lead got for the two notes */
const ANSWER = `Based on 2 meeting notes (11-02 weekly sync, 11-04 holiday campaign kickoff)

### Sarah Klein
- Draft the webinar reminder email · by Thursday — 11-02 weekly sync: "Sarah: draft the webinar reminder email by Thursday"
- Send the final speaker bios to Mike · by 11/6 — 11-02 weekly sync: "Sarah K. to send the final speaker bios to Mike from sales by 11/6"
- Three social posts for launch week · drafts by 11/16 — 11-04 holiday campaign kickoff

### Mike Torres
- Share the top 10 accounts list with the team — 11-02 weekly sync: "Mike from sales: share the top 10 accounts list with the team"
- Ask Mr. Chen at Northwind Traders, Inc. about a co-marketing slot — 11-04 holiday campaign kickoff

### Priya Patel
- Landing page copy for the holiday promo · first draft by Fri 11/6 — 11-02 weekly sync

### Dan Brooks
- Pull the October ad numbers · before next sync — 11-02 weekly sync: "Dan to pull the October ad numbers before next sync"

### Jordan Lee
- Confirm the $12,000 media plan with Ms. Rivera · by Monday — 11-04 holiday campaign kickoff

### Owner not clear
- Check the image rights for the case study photos — 11-02 weekly sync
- Press release: Mike or Sarah? Not decided — 11-04 holiday campaign kickoff

### Whole team
- Add your December PTO to the shared calendar — 11-02 weekly sync

### To check
- Fall webinar signups are at 142; the goal is 200 by Nov 20.
- Holiday promo budget: $4,500 across search and social; LinkedIn ads ran about 1.2k over budget in October.
- Launch is Nov 23; the wrap-up report is due December 4th. Next review: 11/10, 2pm PT.
- Brightline Outdoor LLC, contact Ms. Rivera (rivera@brightline.example, (415) 555-0134).`

const FILES = ['groups/Acme/Meeting notes/2026-11-02 Weekly marketing sync.md', 'groups/Acme/Meeting notes/2026-11-04 Holiday campaign kickoff.md']
const TEAM = { people: ['Jordan Lee', 'Sarah Klein', 'Mike Torres', 'Priya Patel', 'Dan Brooks'], own: ['Acme', 'Acme Marketing'] }
const run = { question: '/meeting-tasks Sort out the tasks from these notes', answer: ANSWER, files: FILES }
const notes = (text: string, people: readonly string[] = []) => specificsOf({ question: '', answer: text, files: [] }, { people, own: TEAM.own })
const draft = (steps: string, o: { title?: string; description?: string; inputs?: { name: string; label: string; placeholder?: string }[] } = {}) =>
  ({ title: o.title ?? 'Weekly meeting tasks', description: o.description ?? '', inputs: o.inputs ?? [], steps })

/** words a team skill uses that are not anyone's name, a customer, a date or an amount */
const STRUCTURE = [
  'Overview', 'Pricing', 'Summary', 'Action Items', 'Action items', 'Next Steps', 'Next steps', 'Decisions', 'Updates', 'Notes', 'Agenda', 'Attendees',
  'Owner not clear', 'Owner', 'Whole team', 'Whole', 'To check', 'My tasks', 'Frame', 'Filled in each time', 'Kept as it is', 'Template', 'Quote', 'Invoice', 'Proposal', 'Report',
  'Customer', 'Recipient', 'Recipient email', 'Item', 'Description', 'Qty', 'Quantity', 'Unit price', 'Amount', 'Subtotal', 'Tax', 'Sales tax', 'Total', 'Terms', 'Date',
  'Due date', 'Valid until', 'Company', 'Contact', 'Attn', 'Admin', 'Manager', 'Lead', 'Client', 'Sales', 'Marketing', 'Team', 'Everyone', 'Someone', 'All',
  'Monday', 'Thursday', 'Friday', 'Fri', 'Mon', 'October', 'December', 'November', 'Nov', 'Draft', 'Send', 'Share', 'Read', 'List', 'Use', 'Check', 'Pull', 'Launch',
  'Holiday', 'Fall', 'Goal', 'Press', 'Press release', 'Wrap-up', 'Weekly', 'Weekly marketing sync', 'Holiday campaign kickoff', 'I', 'AI', 'PTO', 'SEO', 'CTA', 'ROI', 'KPI',
  'Q4', 'PT', 'ET', 'LinkedIn', 'Year in review', 'Year', '142', '200', '10', '2026', 'Based on 2 meeting notes',
]

describe('names in an English run', () => {
  test('a team account named in the run: its given name, "Sarah K.", the full name and the family name', () => {
    const s = specificsOf(run, TEAM)
    for (const x of ['Sarah', 'Sarah K.', 'Sarah Klein', 'Klein', 'Mike', 'Mike Torres', 'Mike T.', 'Torres', 'Priya', 'Priya Patel', 'Patel', 'Dan', 'Dan Brooks', 'Brooks', 'Jordan', 'Jordan Lee', 'Lee']) expect(s, x).toContain(x)
    // the family name with a title, and an account named only by its given name
    const k = notes('- Ms. Klein approves the copy.\n- Mike to check the list.', ['Sarah Klein', 'Mike Torres'])
    for (const x of ['Ms. Klein', 'Klein', 'Sarah', 'Sarah K.', 'Sarah Klein', 'Mike', 'Mike Torres']) expect(k, x).toContain(x)
    // an account nobody in the run names gives nothing
    expect(notes('- Draft the email.', ['Sarah Klein'])).toEqual([])
  })

  test('people the notes name who are no team account', () => {
    const s = notes(`${SYNC}\n\n${KICKOFF}`)
    // the attendee lines ("Mike (sales)", "Mike joined late"), titles, "from sales", "Sarah K.", task owners
    for (const x of ['Jordan Lee', 'Jordan', 'Lee', 'Sarah K.', 'Sarah', 'Sarah Klein', 'Klein', 'Mike', 'Priya Patel', 'Priya', 'Patel', 'Dan Brooks', 'Dan', 'Brooks', 'Ms. Rivera', 'Rivera', 'Mr. Chen', 'Chen']) expect(s, x).toContain(x)
    // titles with or without a period, and with a given name
    for (const [text, xs] of [
      ['- Call Mr Chen about the slot.', ['Mr Chen', 'Chen']], ['- Dr. Ana Ruiz signs off.', ['Dr. Ana Ruiz', 'Ana Ruiz', 'Ruiz', 'Ana']],
      ['- ask Mrs. Okafor and Mx. Lane', ['Mrs. Okafor', 'Okafor', 'Mx. Lane']],
    ] as const) for (const x of xs) expect(notes(text), `${text} → ${x}`).toContain(x)
    // the other lines that list people, and their parts
    for (const [text, xs] of [
      ['Participants: Alex Novak, Tomás Ibarra (remote)', ['Alex Novak', 'Alex', 'Novak', 'Tomás Ibarra', 'Tomás', 'Ibarra']],
      ['Attendance: Nadia and Rui; Kofi left early', ['Nadia', 'Rui', 'Kofi']], ['**Invited:** Grace Liu, Omar', ['Grace Liu', 'Grace', 'Liu', 'Omar']],
      ['Owner: Leila M.', ['Leila M.', 'Leila']], ['Prepared by: Hugo Brandt', ['Hugo Brandt', 'Hugo', 'Brandt']], ['Attn: Ms. Rivera', ['Ms. Rivera', 'Rivera']],
    ] as const) for (const x of xs) expect(notes(text), `${text} → ${x}`).toContain(x)
    // "Mike from sales", "Ines (design)", "Tobias K."
    for (const [text, x] of [['- send it to Ravi from marketing', 'Ravi'], ['- Ines (design) has the files', 'Ines'], ['- Tobias K. to share the deck', 'Tobias K.']] as const) expect(notes(text), text).toContain(x)
    // a task's owner in each form, when the run says the name more than once
    for (const [text, x] of [
      ['- Yuki: book the venue', 'Yuki'], ['1. Bruno to pull the numbers', 'Bruno'], ['- Elif — first draft by Friday', 'Elif'], ['- [ ] Soren will check it', 'Soren'],
      ['- Priya owns the landing page.', 'Priya'], ['"Wanjiru: send the bios"', 'Wanjiru'],
    ] as const) expect(notes(`${text}\n- thanks to ${x} for the help`), text).toContain(x)
    // a role's line with a full name
    expect(notes('Account Executive: Nora Quinn.')).toEqual(['Nora Quinn'])
    // a label or a role said once at a line's start is no one
    expect(notes('- Yuki: book the venue')).toEqual([])
    const labels = notes('Tone: friendly, confident.\nCopywriter: tbd.\nPhotographer to confirm.\nHeadline: Gear Up for the Holidays\n- Contoso: new loyalty program\nNext: Match Contoso.')
    expect(labels).toContain('Contoso')
    for (const x of ['Tone', 'Copywriter', 'Photographer', 'Headline', 'Gear', 'Gear Up', 'Holidays', 'Next', 'Match']) expect(labels, x).not.toContain(x)
  })

  test('a per-person heading counts when the name is also said outside the headings', () => {
    expect(notes('### Lena Fischer\n- Draft the email — "Lena: draft the email"')).toEqual(expect.arrayContaining(['Lena Fischer', 'Lena', 'Fischer']))
    expect(notes('**Marco**\n- Book the room — "Marco to book the room"')).toContain('Marco')
    // a heading nothing else names is not taken (a section's name is no person)
    expect(notes('### Deliverables\n- The deck\n### Lena Fischer\n- The email')).toEqual([])
  })

  test('a name that is also a word: taken where it is clearly a name, not as a sentence start', () => {
    expect(notes('Will you check the list?\n- Mark each task done.\n- May we skip it?\n- Grace period ends soon.')).toEqual([])
    const s = notes('Attendees: Will Turner, Mark\n- Ms. May signs off.\n- June from sales has the list.\n- Bill K. to send it.')
    for (const x of ['Will Turner', 'Will', 'Turner', 'Mark', 'Ms. May', 'May', 'June', 'Bill K.', 'Bill']) expect(s, x).toContain(x)
    // in a skill such a name counts only where it reads as a name
    const has = (steps: string) => leftoversIn(draft(steps), s)
    expect(has('1. Mark each task as done.\n2. Will the notes say who? List them.\n3. Bill the customer in May, by May 20 at the latest.')).toEqual([])
    expect(has('### Mark\n- Send the list to June.')).toEqual(['Mark', 'June'])
    expect(has('- Mark: the deck')).toEqual(['Mark'])
    // a team account with such a name, said only as a sentence start, is not named in the run
    expect(notes('Mark each task done.', ['Mark Davis'])).toEqual([])
    expect(notes('- Mark to share the deck', ['Mark Davis'])).toEqual(expect.arrayContaining(['Mark', 'Mark Davis', 'Davis']))
  })
})

describe('companies, dates, amounts and contact data', () => {
  test('companies with a suffix: the whole name, the first word of a longer one; the team\'s own excluded', () => {
    for (const [text, xs] of [
      ['Client: Brightline Outdoor LLC.', ['Brightline Outdoor', 'Brightline']], ['ask Mr. Chen at Northwind Traders, Inc. about it', ['Northwind Traders', 'Northwind']],
      ['Acme Ltd. and Foo Corp. both', ['Foo']], ['Ask Bluefin Media Group Co. today', ['Bluefin Media Group', 'Bluefin']], ['Hollis & Vane LLP', ['Hollis & Vane', 'Hollis']],
      ['Kessler GmbH, Orbis PLC, Tandem Corporation, Fable Company', ['Kessler', 'Orbis', 'Tandem', 'Fable']],
    ] as const) for (const x of xs) expect(notes(text), `${text} → ${x}`).toContain(x)
    const own = notes('Prepared by Acme Marketing Co. for Acme Ltd.')
    for (const x of ['Acme', 'Acme Marketing', 'Marketing']) expect(own, x).not.toContain(x)
    // "General" or "United" alone is no customer
    expect(notes('United Freight Corp')).toEqual(['United Freight'])
  })

  test('US dates: numeric, with the month\'s name, with a weekday; a weekday or a month alone is no date', () => {
    for (const [text, x] of [
      ['due 11/20', '11/20'], ['dated 11/03/2026', '11/03/2026'], ['dated 11/03/2026', '11/03'], ['dated 11/03/2026', '11/3'], ['on 11/3/26', '11/3/26'],
      ['by Nov 20.', 'Nov 20'], ['by Nov. 20', 'Nov. 20'], ['by November 20', 'November 20'], ['by November 20th', 'November 20th'], ['on Nov 20, 2026', 'Nov 20, 2026'],
      ['on 20 November', '20 November'], ['the 4th of December', '4th of December'], ['due December 4th', 'December 4th'], ['Mon 11/2', '11/2'], ['by Fri 11/6', '11/6'],
      ['Sept 9 launch', 'Sept 9'], ['the November 2026 issue', 'November 2026'],
    ] as const) expect(notes(text), `${text} → ${x}`).toContain(x)
    // each written form of a day stands for the others
    for (const x of ['November 20', 'November 20th', 'Nov 20', 'Nov. 20', '11/20']) expect(notes('Goal is 200 by Nov 20.'), x).toContain(x)
    expect(notes('- Draft it by Thursday, every Monday, in December.\n- December newsletter theme: "Year in review". 2pm PT. Q4 2026.')).toEqual([])
  })

  test('dollar amounts: with $, USD or dollars, and k beside a budget word; a count is no amount', () => {
    for (const [text, x] of [
      ['$1,200 total', '$1,200'], ['budget approved: $4,500 across search', '$4,500'], ['the $12,000 media plan', '$12,000'], ['$1,800.00', '$1,800.00'],
      ['about $1.2k', '$1.2k'], ['a $12K retainer', '$12K'], ['USD 500 a month', 'USD 500'], ['500 dollars', '500 dollars'], ['500 USD', '500 USD'],
      ['ran about 1.2k over budget', '1.2k'], ['we spent 12k on ads', '12k'], ['£300 for print', '£300'],
    ] as const) expect(notes(text), `${text} → ${x}`).toContain(x)
    expect(notes('Fall webinar signups are at 142. Goal is 200. 1.2k signups, 12k impressions, top 10 accounts, 3 posts, 2026.')).toEqual([])
    // a trailing comma is not part of the amount
    expect(notes('$4,500, then more')).toContain('$4,500')
  })

  test('phones in US formats, e-mail, a document number; the always-on guard sees the phones too', () => {
    for (const x of ['(415) 555-0134', '415-555-0134', '415.555.0134', '+1 415 555 0134', '+1 (415) 555-0134']) {
      expect(notes(`call ${x} today`), x).toContain(x)
      expect(outsideIn(`Call ${x} first.`, []), x).toContain(x)
    }
    expect(notes('rivera@brightline.example')).toContain('rivera@brightline.example')
    for (const x of ['Q-2026-0117', 'INV-0042']) expect(notes(`Quote no. ${x}`), x).toContain(x)
  })

  test('a listed team folder with spaces in its name is the skill\'s own; another folder, or a longer name, is not', () => {
    const files = ['groups/Acme Marketing/Meeting notes']
    expect(outsideIn('Read the newest file in `groups/Acme Marketing/Meeting notes/`.', files)).toEqual([])
    expect(outsideIn('Read groups/Acme Marketing/Meeting notes/Weekly sync.md first.', files)).toEqual([])
    expect(outsideIn('Also read groups/Acme Marketing/Budgets/q4.xlsx.', files)).toEqual(['groups/Acme'])
    expect(outsideIn('Read groups/Acme Marketing/Meeting notes old/a.md.', files)).toEqual(['groups/Acme'])
  })
})

describe('what is no specific', () => {
  test('headings, form labels, roles, weekdays, months, sentence starts, acronyms, counts and a bare year', () => {
    const text = [
      '## Overview', '## Pricing', '## Summary', '## Action Items', '## Next Steps', '## Decisions', '## Updates', '## Notes', '## Agenda',
      '### Owner not clear', '### Whole team', '### To check', '### My tasks', '### Frame', '### Filled in each time', '### Kept as it is',
      '- Customer: (company name) · Recipient email: (address) · Item: (what) · Description · Qty · Unit price · Amount',
      '- Subtotal: sum · Sales tax: 8% · Total: sum · Terms: Net 30 · Valid until: 30 days · Due date: one week',
      '- Owner: not clear · Attendees: everyone on the team · Contact: the customer\'s buyer · Prepared by: the account lead',
      '- Admin: approves. Manager: reviews. Lead: drafts. Client: signs. Sales: sends. Marketing: plans.',
      '- Everyone: add PTO. Someone: check SEO, CTA, ROI and KPI for Q4. All: by 2pm PT / 3pm ET.',
      '- Draft: the email. Send: by Thursday. Share: on Monday. Read: the notes. List: the tasks. Use: the template.',
      '- Webinar: 142 signups. Budget — 2026. Launch to follow in December. Holiday: Fall promo. October: done.',
      'I asked the AI to sort it. Year in review.',
      '"Draft the email by Friday", "Everyone: add your December PTO"',
    ].join('\n')
    const s = notes(text)
    expect(s).toEqual([])
    for (const x of STRUCTURE) expect(s, x).not.toContain(x)
    // nor does the run itself give any of them
    const r = specificsOf(run, TEAM)
    for (const x of STRUCTURE) expect(r, x).not.toContain(x)
  })
})

describe('a skill drafted from the run', () => {
  const specifics = specificsOf(run, TEAM)
  const clean = 'Use the newest file in the Meeting notes folder.\n'
    + '1. Read the notes. List each person\'s tasks under their name: ### Name, then one line per task with its due date and source.\n'
    + '2. Due dates only when the notes give one ("by Friday", "every Monday" stay as they are).\n'
    + '3. Tasks with no owner go under ### Owner not clear, tasks for everyone under ### Whole team, open questions under ### To check.\n'
    + '4. Start with "Based on N meeting notes", then share the list in this chat.\n'
    + '5. For a quote, fill in the Customer, Recipient and Date fields; Item, Qty, Unit price, Amount, Subtotal, Sales tax and Total come from the template. Terms and Valid until are kept as they are.'

  test('a clean skill keeps its card', () => {
    expect(leftoversIn(draft(clean, {
      description: 'List each person\'s tasks from the team\'s meeting notes, every Monday',
      inputs: [{ name: 'scope', label: 'Whose tasks' }, { name: 'customer', label: 'Customer', placeholder: 'e.g. the customer\'s company' }, { name: 'due', label: 'Due date', placeholder: 'by Friday' }],
    }), specifics, FILES)).toEqual([])
  })

  test('a leaking skill names what it leaks, each once as its longest form', () => {
    const leak = '### Sarah Klein\n- Draft the webinar reminder email by Nov 20.\n- Keep the holiday budget at $4,500.\n- Confirm the plan with Ms. Rivera at Brightline Outdoor.'
    expect(leftoversIn(draft(leak), specifics).sort()).toEqual(['$4,500', 'Brightline Outdoor', 'Ms. Rivera', 'Nov 20', 'Sarah Klein'].sort())
    // in the form's words too, and any one form of a name or a date
    expect(leftoversIn(draft('-', { inputs: [{ name: 'c', label: 'Customer', placeholder: 'e.g. Brightline' }] }), specifics)).toEqual(['Brightline'])
    for (const [steps, x] of [
      ['Ask Mike for the list.', 'Mike'], ['Sarah K. drafts it.', 'Sarah K.'], ['Ask Klein.', 'Klein'], ['Send it before 11/16.', '11/16'], ['Due November 23rd.', 'November 23rd'],
      ['Check with Mr. Chen.', 'Mr. Chen'], ['The Northwind Traders slot.', 'Northwind Traders'], ['about 1.2k over', '1.2k'], ['Dial (415) 555-0134.', '(415) 555-0134'],
      ['On 2026-11-02 too.', '2026-11-02'], ['As on 11-04.', '11-04'],
    ] as const) expect(leftoversIn(draft(steps), specifics), steps).toContain(x)
  })

  test('the quote template run: its customer, recipient, number, date and amount; the labels and the team\'s name are fine', () => {
    const quote = {
      question: '/doc-brief Make a new quote from this template',
      answer: 'I read it as: a quote template\n\n### Frame\n- Header: Acme Marketing Co. · Quote no. Q-2026-0117 · Date 11/03/2026\n'
        + '- Customer: Brightline Outdoor LLC · Attn: Ms. Rivera · Recipient email: rivera@brightline.example\n'
        + '- Item: Holiday social ad package · Description · Qty 1 · Unit price $1,800.00 · Amount $1,800.00\n- Subtotal, Sales tax, Total\n\n'
        + '### Filled in each time\n- Customer, Recipient email, Item, Description, Qty, Unit price, Amount\n\n'
        + '### Kept as it is\n- Terms: Net 30 · Valid until: 30 days from the date · Prepared by: Jordan Lee',
      files: ['shared/Quote template.xlsx'],
    }
    const s = specificsOf(quote, TEAM)
    for (const x of ['Brightline Outdoor', 'Brightline', 'Ms. Rivera', 'Rivera', 'Q-2026-0117', '11/03/2026', '$1,800.00', 'Jordan Lee', 'Jordan', 'rivera@brightline.example']) expect(s, x).toContain(x)
    for (const x of [...STRUCTURE, 'Acme Marketing', 'Acme', 'Header', 'Net 30', 'Holiday social ad package']) expect(s, x).not.toContain(x)
    const steps = '1. Copy the template\'s frame: the Acme Marketing header, the Terms and the Valid until line.\n'
      + '2. Fill in the Customer, Recipient email, Item, Description, Qty and Unit price from the form.\n'
      + '3. Amount is Qty × Unit price; Subtotal, Sales tax and Total follow. Date is today.'
    expect(leftoversIn(draft(steps, { title: 'Write a quote', inputs: [{ name: 'customer', label: 'Customer' }, { name: 'to', label: 'Recipient email' }, { name: 'item', label: 'Item' }] }), s, quote.files)).toEqual([])
  })
})
