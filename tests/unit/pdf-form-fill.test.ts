// Fill-in PDF forms (QA TC-5513): a read lists the form fields; edit_pdf's fill_form sets text fields, checkboxes,
// choices and radio buttons by name and writes their appearances, so the values show in poppler (pdftoppm) like in
// Preview and Acrobat; flatten draws them into the page; add_text under a field is refused (the field hid such text and
// stayed empty, while the AI said every value was in its box).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString, decodePDFRawStream, rgb, StandardFonts } from 'pdf-lib'
import { makeHandler } from '../../server/src/mcp/protocol'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { PDF_WORDS, textFontFile } from '../../server/src/tools/pdf-tools'
import { teamDefaultLocale } from '../../server/src/admin/settings'
import { formFieldsText } from '../../server/src/files/pdf-form'

setDefaultTimeout(60_000)

let A: CApp
beforeAll(async () => { A = await makeCApp('pdf-form-fill') })
afterAll(async () => { await A.close() })

const D = 'groups/marketing/forms'
const file = (rel: string) => path.join(A.team, ...rel.split('/'))
const put = (rel: string, bytes: Uint8Array) => { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); fs.writeFileSync(file(rel), bytes) }
let rpcId = 0
function turn(user: Person) {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx(user, A.turn(user, A.chat(user))))
  return async (name: string, args: Record<string, unknown>) => {
    const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
    return { text: (r.result.content as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: !!r.result.isError }
  }
}
const edited = (base: string) => `${D}/${base} (${PDF_WORDS.edited[teamDefaultLocale(A.ctx.db)]}).pdf`

/** A4 vendor form like the QA one: labels on the page, opaque white text fields on top, a checkbox, a dropdown, a radio */
const BOXES = { company_name: { x: 230, y: 700 }, contact_email: { x: 230, y: 660 } }
async function vendorForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([595.28, 841.89])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const form = doc.getForm()
  page.drawText('Vendor Registration Form', { x: 50, y: 780, size: 16, font })
  for (const [name, at] of Object.entries(BOXES)) {
    page.drawText(name.replace('_', ' '), { x: 50, y: at.y + 5, size: 10, font })
    const t = form.createTextField(name)
    t.addToPage(page, { x: at.x, y: at.y, width: 300, height: 18, backgroundColor: rgb(1, 1, 1), borderColor: rgb(0.5, 0.5, 0.5), font })
  }
  page.drawText('Organic certified', { x: 50, y: 625, size: 10, font })
  form.createCheckBox('organic').addToPage(page, { x: 230, y: 620, width: 14, height: 14, backgroundColor: rgb(1, 1, 1), borderColor: rgb(0.5, 0.5, 0.5) })
  const d = form.createDropdown('country')
  d.addOptions(['Korea', 'Japan', 'Indonesia'])
  d.addToPage(page, { x: 230, y: 580, width: 150, height: 18, backgroundColor: rgb(1, 1, 1), font })
  const r = form.createRadioGroup('size')
  r.addOptionToPage('Small', page, { x: 230, y: 540, width: 14, height: 14 })
  r.addOptionToPage('Large', page, { x: 260, y: 540, width: 14, height: 14 })
  return doc.save()
}

/** A form whose fields are their own widgets (no /Kids), as ReportLab writes them (the QA vendor form): a text field
 * with an opaque white box and a checkbox with "Yes" and "Off" looks */
async function mergedForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([595.28, 841.89])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('Company name', { x: 50, y: 705, size: 10, font })
  const c = doc.context
  const look = (ops: string) => c.register(c.stream(ops, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 300, 18], Resources: {} }))
  const box = (ops: string, w: number, h: number) => c.register(c.stream(ops, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h], Resources: {} }))
  const text = c.register(c.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: PDFString.of('company_name'), Rect: [230, 700, 530, 718], F: 4, P: page.ref, DA: PDFString.of('/Helv 0 Tf 0 g'), MK: { BG: [1], BC: [0.5] }, AP: { N: look('1 g 0 0 300 18 re f 0.5 G 0.5 0.5 299 17 re S') } }))
  const yes = box('1 g 0 0 14 14 re f 0 g 2 2 10 10 re f', 14, 14), off = box('1 g 0 0 14 14 re f 0.5 G 0.5 0.5 13 13 re S', 14, 14)
  const tick = c.register(c.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Btn', T: PDFString.of('organic'), Rect: [230, 620, 244, 634], F: 4, P: page.ref, V: 'Off', AS: 'Off', AP: { N: { Yes: yes, Off: off } } }))
  page.node.set(PDFName.of('Annots'), c.obj([text, tick]))
  doc.catalog.set(PDFName.of('AcroForm'), c.obj({ Fields: [text, tick], DA: PDFString.of('/Helv 0 Tf 0 g'), DR: { Font: { Helv: font.ref } } }))
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false })
}

const pdftoppm = Bun.which('pdftoppm')
/** dark pixels (gray < 160) of page 1 drawn at 72 dpi by poppler inside a box given in PDF points */
function darkIn(rel: string, box: { x: number; y: number; w: number; h: number }): number {
  const b = Buffer.from(Bun.spawnSync([pdftoppm!, '-r', '72', '-f', '1', '-l', '1', '-singlefile', '-gray', file(rel)]).stdout)
  const head = b.subarray(0, 40).toString('latin1').match(/^P5\s+(\d+)\s+(\d+)\s+\d+\s/)!
  const W = Number(head[1]), H = Number(head[2]), at = head[0].length
  let n = 0
  for (let y = Math.max(0, Math.round(H - box.y - box.h)); y < Math.min(H, Math.round(H - box.y)); y++) {
    for (let x = Math.max(0, Math.round(box.x)); x < Math.min(W, Math.round(box.x + box.w)); x++) if (b[at + y * W + x]! < 160) n++
  }
  return n
}
/** the inside of a field's box (its border left out) */
const inside = (at: { x: number; y: number }) => ({ x: at.x + 3, y: at.y + 3, w: 294, h: 12 })
/** the normal appearance stream of a field's first widget, decoded */
function appearance(doc: PDFDocument, name: string): string {
  const w = doc.getForm().getField(name).acroField.getWidgets()[0]!
  const ap = w.dict.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'))
  return ap instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(ap).decode()).toString('latin1') : ''
}

describe('fill-in PDF forms', () => {
  test('a read of the form lists its fields by name, with how to fill them', async () => {
    put(`${D}/vendor.pdf`, await vendorForm())
    const r = await turn('alice')('read', { file_path: `${D}/vendor.pdf` })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('This PDF is a fill-in form with 5 fields')
    expect(r.text).toContain('"company_name" (text; empty; page 1 at')
    expect(r.text).toContain('"organic" (checkbox; not ticked')
    expect(r.text).toContain('"country" (dropdown: "Korea" | "Japan" | "Indonesia"')
    expect(r.text).toContain('"size" (radio: "Small" | "Large"')
    expect(r.text).toContain('fill_form')
    // a PDF without fields says nothing about forms
    const plain = await PDFDocument.create(); plain.addPage().drawText('hello')
    put(`${D}/plain.pdf`, await plain.save())
    const p = await turn('alice')('read', { file_path: `${D}/plain.pdf` })
    expect(p.text).not.toContain('fill-in form')
    expect(formFieldsText({ fields: [], xfa: false })).toBe('')
  })

  test('fill_form sets the values in the fields themselves, with appearances poppler draws (TC-5513)', async () => {
    put(`${D}/vendor.pdf`, await vendorForm())
    const r = await turn('alice')('edit_pdf', { file_path: `${D}/vendor.pdf`, operations: [{ fill_form: { fields: {
      company_name: 'Northwind Bakery Supply Ltd.', CONTACT_EMAIL: 'priya@northwind.invalid', organic: true, country: 'japan', size: 'Large',
    } } }] })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('(fill_form): set the form fields "company_name", "contact_email", "organic", "country", "size"; the values are in the form fields themselves')
    expect(r.text).toContain('as_images: true')
    const out = edited('vendor')
    const doc = await PDFDocument.load(fs.readFileSync(file(out)))
    const form = doc.getForm()
    expect(form.getTextField('company_name').getText()).toBe('Northwind Bakery Supply Ltd.')
    expect(form.getTextField('contact_email').getText()).toBe('priya@northwind.invalid')
    expect(form.getCheckBox('organic').isChecked()).toBe(true)
    expect(form.getDropdown('country').getSelected()).toEqual(['Japan'])
    expect(form.getRadioGroup('size').getSelected()).toBe('Large')
    // the appearance a viewer draws holds the text, and the checkbox shows its "on" look
    expect(appearance(doc, 'company_name')).toContain('Tj')
    const cb = form.getCheckBox('organic').acroField.getWidgets()[0]!
    expect(cb.getAppearanceState()?.decodeText()).not.toBe('Off')
    // drawn by poppler: the inside of the field is dark where the value is, the untouched form is blank there
    if (pdftoppm) {
      expect(darkIn(`${D}/vendor.pdf`, inside(BOXES.company_name))).toBe(0)
      expect(darkIn(out, inside(BOXES.company_name))).toBeGreaterThan(40)
      expect(darkIn(out, inside(BOXES.contact_email))).toBeGreaterThan(40)
      expect(darkIn(out, { x: 232, y: 622, w: 10, h: 10 })).toBeGreaterThan(darkIn(`${D}/vendor.pdf`, { x: 232, y: 622, w: 10, h: 10 }) + 5)
    }
  })

  test('flatten: the values are drawn into the page and the fields are gone', async () => {
    put(`${D}/vendor.pdf`, await vendorForm())
    const r = await turn('alice')('edit_pdf', { file_path: `${D}/vendor.pdf`, output: `${D}/vendor-flat.pdf`, operations: [{ fill_form: { fields: { company_name: 'Acme Ltd', organic: 'yes' }, flatten: true } }] })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('flattened')
    const doc = await PDFDocument.load(fs.readFileSync(file(`${D}/vendor-flat.pdf`)))
    expect(doc.getForm().getFields().length).toBe(0)
    if (pdftoppm) expect(darkIn(`${D}/vendor-flat.pdf`, inside(BOXES.company_name))).toBeGreaterThan(20)
  })

  test('a form whose fields are their own widgets (as ReportLab writes them): filled, and flattened (TC-5513)', async () => {
    put(`${D}/merged.pdf`, await mergedForm())
    const call = turn('alice')
    const read = await call('read', { file_path: `${D}/merged.pdf` })
    expect(read.text).toContain('"company_name" (text; empty; page 1 at 81, 44 mm')
    expect(read.text).toContain('"organic" (checkbox; not ticked')
    const r = await call('edit_pdf', { file_path: `${D}/merged.pdf`, output: `${D}/merged-filled.pdf`, operations: [{ fill_form: { fields: { company_name: 'Northwind Bakery Supply Ltd.', organic: true } } }] })
    expect(r.isError, r.text).toBe(false)
    const doc = await PDFDocument.load(fs.readFileSync(file(`${D}/merged-filled.pdf`)))
    expect(doc.getForm().getTextField('company_name').getText()).toBe('Northwind Bakery Supply Ltd.')
    expect(doc.getForm().getCheckBox('organic').isChecked()).toBe(true)
    // the field is still its own widget (not made its own kid, which made pdf-lib loop)
    expect(doc.getForm().getTextField('company_name').acroField.dict.has(PDFName.of('Kids'))).toBe(false)
    const flat = await call('edit_pdf', { file_path: `${D}/merged.pdf`, output: `${D}/merged-flat.pdf`, operations: [{ fill_form: { fields: { company_name: 'Northwind Bakery Supply Ltd.', organic: true }, flatten: true } }] })
    expect(flat.isError, flat.text).toBe(false)
    expect((await PDFDocument.load(fs.readFileSync(file(`${D}/merged-flat.pdf`)))).getForm().getFields().length).toBe(0)
    if (pdftoppm) {
      for (const out of [`${D}/merged-filled.pdf`, `${D}/merged-flat.pdf`]) {
        expect(darkIn(out, inside({ x: 230, y: 700 }))).toBeGreaterThan(40)
        expect(darkIn(out, { x: 233, y: 623, w: 8, h: 8 })).toBeGreaterThan(20)
      }
      expect(darkIn(`${D}/merged.pdf`, { x: 233, y: 623, w: 8, h: 8 })).toBe(0)
    }
    // text written under the empty field is refused, and the file is not touched by the check
    const under = await call('edit_pdf', { file_path: `${D}/merged.pdf`, operations: [{ add_text: { text: 'Northwind', position: { x_mm: 84, y_mm: 44 } } }] })
    expect(under.text).toContain('under the form field "company_name"')
  })

  test('Korean values with the server\'s font', async () => {
    if (!textFontFile()) return
    put(`${D}/vendor.pdf`, await vendorForm())
    const r = await turn('alice')('edit_pdf', { file_path: `${D}/vendor.pdf`, output: `${D}/vendor-ko.pdf`, operations: [{ fill_form: { fields: { company_name: '노스윈드 베이커리' } } }] })
    expect(r.isError, r.text).toBe(false)
    const doc = await PDFDocument.load(fs.readFileSync(file(`${D}/vendor-ko.pdf`)))
    expect(doc.getForm().getTextField('company_name').getText()).toBe('노스윈드 베이커리')
    if (pdftoppm) expect(darkIn(`${D}/vendor-ko.pdf`, inside(BOXES.company_name))).toBeGreaterThan(40)
  })

  test('refused plainly: an unknown name lists the fields, a wrong kind of value, add_text under a field, fields lost with page removal', async () => {
    put(`${D}/vendor.pdf`, await vendorForm())
    const call = turn('alice')
    const unknown = await call('edit_pdf', { file_path: `${D}/vendor.pdf`, operations: [{ fill_form: { fields: { company: 'Acme' } } }] })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain('no form field "company". Its fields: company_name (text), contact_email (text), organic (checkbox), country (dropdown), size (radio)')
    const choice = await call('edit_pdf', { file_path: `${D}/vendor.pdf`, operations: [{ fill_form: { fields: { country: 'France' } } }] })
    expect(choice.text).toContain('"France" is not one of them')
    const tick = await call('edit_pdf', { file_path: `${D}/vendor.pdf`, operations: [{ fill_form: { fields: { organic: 'maybe' } } }] })
    expect(tick.text).toContain('is a checkbox')
    // the old way: text written under the empty field, which hid it
    const under = await call('edit_pdf', { file_path: `${D}/vendor.pdf`, operations: [{ add_text: { text: 'Northwind', pages: '1', position: { x_mm: 84, y_mm: 47.5 }, size_pt: 11 } }] })
    expect(under.isError).toBe(true)
    expect(under.text).toContain('under the form field "company_name"')
    expect(under.text).toContain('fill_form')
    // text next to the fields is fine
    const beside = await call('edit_pdf', { file_path: `${D}/vendor.pdf`, output: `${D}/dated.pdf`, operations: [{ add_text: { text: '2026-11-20', position: 'top-right' } }] })
    expect(beside.isError, beside.text).toBe(false)
    const lost = await call('edit_pdf', { file_path: `${D}/vendor.pdf`, operations: [{ fill_form: { fields: { company_name: 'Acme' } } }, { reorder_pages: '1' }] })
    expect(lost.text).toContain('fill it in its own edit_pdf call')
    // a PDF without fields
    const plain = await PDFDocument.create(); plain.addPage()
    put(`${D}/plain.pdf`, await plain.save())
    const none = await call('edit_pdf', { file_path: `${D}/plain.pdf`, operations: [{ fill_form: { fields: { a: 'b' } } }] })
    expect(none.text).toContain('has no fill-in form fields')
  })
  test('a two-line English value stays in Helvetica, without the server font (review finding 1 on #94)', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([595.28, 841.89])
    const t = doc.getForm().createTextField('address')
    t.enableMultiline()
    t.addToPage(page, { x: 100, y: 600, width: 300, height: 60 })
    put(`${D}/address.pdf`, await doc.save())
    const r = await turn('alice')('edit_pdf', { file_path: `${D}/address.pdf`, output: `${D}/address-filled.pdf`, operations: [{ fill_form: { fields: { address: '12 Main St\r\nSpringfield' } } }] })
    expect(r.isError, r.text).toBe(false)
    const out = fs.readFileSync(file(`${D}/address-filled.pdf`))
    // before: the line break counted as a letter outside Latin, so the 1.2 MB Pretendard font went into the file (and a
    // server without that font refused the value)
    expect(out.includes('Pretendard')).toBe(false)
    expect(out.length).toBeLessThan(100_000)
    const filled = await PDFDocument.load(out)
    expect(filled.getForm().getTextField('address').getText()).toBe('12 Main St\nSpringfield')
    expect(appearance(filled, 'address')).toContain('Tj')
  })

  test('add_text on a form with XFA data keeps the XFA; fill_form drops it and says so (review finding 2 on #94)', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([595.28, 841.89])
    doc.getForm().createTextField('a').addToPage(page, { x: 100, y: 600, width: 100, height: 20 })
    const af = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict)
    af.set(PDFName.of('XFA'), doc.context.obj([PDFString.of('template'), doc.context.register(doc.context.stream('<template/>'))]))
    put(`${D}/xfa.pdf`, await doc.save({ updateFieldAppearances: false }))
    const hasXfa = async (rel: string) => (await PDFDocument.load(fs.readFileSync(file(rel)))).catalog.lookup(PDFName.of('AcroForm'), PDFDict).has(PDFName.of('XFA'))
    const call = turn('alice')
    const dated = await call('edit_pdf', { file_path: `${D}/xfa.pdf`, output: `${D}/xfa-dated.pdf`, operations: [{ add_text: { text: '2026-11-20', position: 'top-right' } }] })
    expect(dated.isError, dated.text).toBe(false)
    expect(await hasXfa(`${D}/xfa-dated.pdf`)).toBe(true)
    // the read lists the fields and does not touch the file
    const read = await call('read', { file_path: `${D}/xfa.pdf` })
    expect(read.text).toContain('"a" (text; empty')
    expect(await hasXfa(`${D}/xfa.pdf`)).toBe(true)
    const filled = await call('edit_pdf', { file_path: `${D}/xfa.pdf`, output: `${D}/xfa-filled.pdf`, operations: [{ fill_form: { fields: { a: 'Acme' } } }] })
    expect(filled.isError, filled.text).toBe(false)
    expect(filled.text).toContain('XFA form, which was removed')
    expect(await hasXfa(`${D}/xfa-filled.pdf`)).toBe(false)
  })
})
