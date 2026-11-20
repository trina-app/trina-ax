// Fill-in PDF forms (AcroForm) for edit_pdf's fill_form and the read of a PDF (QA TC-5513): a form's fields are
// widgets drawn ON TOP of the page, so text written onto the page under an empty field is hidden by it in Preview,
// poppler and Acrobat, and the field itself stays empty. A form is therefore filled by setting the fields' values and
// writing their appearance streams (what a viewer draws for a field), with pdf-lib (MIT). Like the rest of edit_pdf,
// the PDF is parsed only in the office worker (files/pdf-pages.ts calls these there); formFieldsText runs in the server
// process on the worker's report.
import { PDFButton, PDFCheckBox, PDFDict, PDFDocument, PDFDropdown, PDFHexString, PDFName, PDFNumber, PDFOptionList, PDFPage, PDFRadioGroup, PDFRef, PDFSignature, PDFString, PDFTextField, type PDFField, type PDFFont } from 'pdf-lib'
import { ToolError } from '../policy/errors'
import { ptToMm } from './pdf-stamp'

export type FormFieldType = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'list' | 'button' | 'signature'
/** One field as the AI is told about it: its name, kind, value now, choices, and where its first box is. */
export interface FormFieldInfo {
  name: string
  type: FormFieldType
  /** text: the text ('' empty); checkbox: ticked; radio, dropdown, list: the choice(s) ('' none) */
  value: string | boolean
  options?: string[]
  /** the field's tooltip (/TU), often its label */
  label?: string
  page?: number
  /** the box's top-left from the page's top-left as shown, in mm */
  x_mm?: number
  y_mm?: number
  readOnly?: boolean
  multiline?: boolean
  maxLength?: number
}
export interface FormReport { fields: FormFieldInfo[]; xfa: boolean }

export const FORM_FIELDS_LISTED_MAX = 150
const OPTIONS_LISTED_MAX = 20

function acroFormOf(doc: PDFDocument): PDFDict | undefined {
  try { return doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict) } catch { return undefined }
}

/** the form, or null when the PDF has no form fields. XFA data (which pdf-lib does not write) is dropped first, so a
 * filled form shows its fields in Acrobat too and pdf-lib does not write a warning into the worker's output. */
function formOf(doc: PDFDocument) {
  const af = acroFormOf(doc)
  if (!af) return null
  const xfa = af.has(PDFName.of('XFA'))
  if (xfa) af.delete(PDFName.of('XFA'))
  let fields: PDFField[]
  try { fields = doc.getForm().getFields() } catch { throw new ToolError('the form fields of this PDF cannot be read (the form may be damaged)', 'pdf_form_invalid') }
  return { form: doc.getForm(), fields, xfa }
}

const typeOf = (f: PDFField): FormFieldType => f instanceof PDFTextField ? 'text' : f instanceof PDFCheckBox ? 'checkbox' : f instanceof PDFRadioGroup ? 'radio'
  : f instanceof PDFDropdown ? 'dropdown' : f instanceof PDFOptionList ? 'list' : f instanceof PDFSignature ? 'signature' : 'button'

function valueOf(f: PDFField): string | boolean {
  try {
    if (f instanceof PDFTextField) return f.getText() ?? ''
    if (f instanceof PDFCheckBox) return f.isChecked()
    if (f instanceof PDFRadioGroup) return f.getSelected() ?? ''
    if (f instanceof PDFDropdown || f instanceof PDFOptionList) return f.getSelected().join(', ')
  } catch {}
  return ''
}

function optionsOf(f: PDFField): string[] | undefined {
  try {
    if (f instanceof PDFRadioGroup || f instanceof PDFDropdown || f instanceof PDFOptionList) return f.getOptions()
  } catch {}
  return undefined
}

function labelOf(f: PDFField): string | undefined {
  const tu = f.acroField.dict.lookup(PDFName.of('TU'))
  return tu instanceof PDFString || tu instanceof PDFHexString ? tu.decodeText().trim() || undefined : undefined
}

/** the page's visible box and its turn (as pdf-pages.ts `shown`) */
function shownOf(page: PDFPage) {
  const box = page.getCropBox()
  const r = ((Math.round(page.getRotation().angle / 90) * 90) % 360 + 360) % 360
  return { box, r }
}

/** a point in PDF space as shown (from the page's top-left): the inverse of pdf-pages.ts toUser */
export function fromUser(box: { x: number; y: number; width: number; height: number }, r: number, x: number, y: number): { u: number; v: number } {
  const W = box.width, H = box.height, px = x - box.x, py = y - box.y
  return r === 0 ? { u: px, v: H - py } : r === 90 ? { u: py, v: px } : r === 180 ? { u: W - px, v: py } : { u: H - py, v: W - px }
}

/** a rectangle in PDF space as shown: its top-left and size (u, v from the page's top-left) */
function shownRectOf(page: PDFPage, rect: { x: number; y: number; width: number; height: number }) {
  const { box, r } = shownOf(page)
  const pts = [[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x, rect.y + rect.height], [rect.x + rect.width, rect.y + rect.height]].map(([x, y]) => fromUser(box, r, x!, y!))
  const us = pts.map((p) => p.u), vs = pts.map((p) => p.v)
  return { u: Math.min(...us), v: Math.min(...vs), w: Math.max(...us) - Math.min(...us), h: Math.max(...vs) - Math.min(...vs) }
}

/** the page index of every annotation (by its object number), for widgets without /P */
function annotPages(doc: PDFDocument): Map<string, number> {
  const at = new Map<string, number>()
  doc.getPages().forEach((p, i) => {
    const annots = p.node.Annots()
    if (!annots) return
    for (const a of annots.asArray()) if (a instanceof PDFRef) at.set(a.toString(), i)
  })
  return at
}

/** the boxes (widgets) of a field: page index and rectangle in PDF space; widgets hidden (/F bit 2) are left out */
function boxesOf(doc: PDFDocument, f: PDFField, pages: Map<string, number>): { page: number; rect: { x: number; y: number; width: number; height: number } }[] {
  const out: { page: number; rect: { x: number; y: number; width: number; height: number } }[] = []
  let widgets
  try { widgets = f.acroField.getWidgets() } catch { return out }
  // Kids() reads; normalizedEntries() would add a field that is its own widget as its own kid (pdf-lib then loops)
  const refs = (() => { try { return f.acroField.Kids()?.asArray() ?? [] } catch { return [] } })()
  for (const [i, w] of widgets.entries()) {
    try {
      const flags = w.dict.lookup(PDFName.of('F'))
      if (flags instanceof PDFNumber && (flags.asNumber() & 2)) continue
      const ref = refs[i] instanceof PDFRef ? refs[i]!.toString() : f.ref.toString()
      let page = pages.get(ref)
      const p = w.P()
      if (page === undefined && p) page = doc.getPages().findIndex((pg) => pg.ref === p)
      if (page === undefined || page < 0) continue
      out.push({ page, rect: w.getRectangle() })
    } catch {}
  }
  return out
}

/** The form fields of a PDF (empty when it has none), for the read and for an unknown name in fill_form. */
export function formReport(doc: PDFDocument): FormReport {
  const f = formOf(doc)
  if (!f) return { fields: [], xfa: false }
  const pages = annotPages(doc)
  const fields = f.fields.map((field): FormFieldInfo => {
    const info: FormFieldInfo = { name: field.getName(), type: typeOf(field), value: valueOf(field) }
    const options = optionsOf(field)
    if (options?.length) info.options = options
    const label = labelOf(field)
    if (label && label !== info.name) info.label = label.slice(0, 120)
    const box = boxesOf(doc, field, pages)[0]
    if (box) {
      const s = shownRectOf(doc.getPage(box.page), box.rect)
      Object.assign(info, { page: box.page + 1, x_mm: Math.round(ptToMm(s.u)), y_mm: Math.round(ptToMm(s.v)) })
    }
    try { if (field.isReadOnly()) info.readOnly = true } catch {}
    if (field instanceof PDFTextField) {
      try { if (field.isMultiline()) info.multiline = true; const m = field.getMaxLength(); if (m !== undefined) info.maxLength = m } catch {}
    }
    return info
  })
  return { fields, xfa: f.xfa }
}

/** the boxes of the form's fields on one page, as shown (u, v from the top-left, in pt), signature fields left out:
 * add_text must not write under them (the field hides the text) */
export function fieldBoxesOnPage(doc: PDFDocument, pageIndex: number): { name: string; u: number; v: number; w: number; h: number }[] {
  const f = (() => { try { return formOf(doc) } catch { return null } })()
  if (!f) return []
  const pages = annotPages(doc)
  const page = doc.getPage(pageIndex)
  const out: { name: string; u: number; v: number; w: number; h: number }[] = []
  for (const field of f.fields) {
    if (field instanceof PDFSignature) continue
    for (const b of boxesOf(doc, field, pages)) if (b.page === pageIndex) out.push({ name: field.getName(), ...shownRectOf(page, b.rect) })
  }
  return out
}

const YES = new Set(['yes', 'y', 'true', 'x', 'on', 'checked', 'ticked', '1', '✓', '✔', 'v'])
const NO = new Set(['no', 'n', 'false', 'off', 'unchecked', 'unticked', '0', ''])
const norm = (s: string) => s.trim().toLowerCase()
/** a name's last part, without array marks: "form1[0].page1[0].Name[0]" -> "name" */
const short = (s: string) => norm(s.split('.').at(-1)!.replace(/\[\d+\]/g, ''))

function listNames(fields: PDFField[]): string {
  const names = fields.map((f) => `${f.getName()} (${typeOf(f)})`)
  return names.length > FORM_FIELDS_LISTED_MAX ? `${names.slice(0, FORM_FIELDS_LISTED_MAX).join(', ')} … and ${names.length - FORM_FIELDS_LISTED_MAX} more` : names.join(', ')
}

/** the field a name means: its exact name, else the same ignoring case, else a unique last part or tooltip */
function findField(fields: PDFField[], name: string): PDFField {
  const exact = fields.find((f) => f.getName() === name)
  if (exact) return exact
  for (const pick of [(f: PDFField) => norm(f.getName()) === norm(name), (f: PDFField) => short(f.getName()) === short(name), (f: PDFField) => norm(labelOf(f) ?? '') === norm(name)]) {
    const hits = fields.filter(pick)
    if (hits.length === 1) return hits[0]!
    if (hits.length > 1) throw new ToolError(`"${name}" could mean ${hits.map((h) => `"${h.getName()}"`).join(' or ')}; give the full field name`)
  }
  throw new ToolError(`this PDF has no form field "${name}". Its fields: ${listNames(fields)}`)
}

const pick = (options: string[], value: string) => options.find((o) => o === value) ?? options.find((o) => norm(o) === norm(value))

export interface FillOutcome { set: string[]; empty: string[]; flattened: boolean; xfa: boolean }

/**
 * Sets the form fields' values (text, ticks, choices) and writes their appearance streams, so every viewer shows them.
 * `fontFor` gives the font for a text (Helvetica for Latin, the server's font otherwise; it refuses letters that font
 * lacks). With `flatten` the fields are drawn into the pages and removed (no longer editable). `wrap` wraps a page's own
 * drawing in q … Q before flatten draws on it.
 */
export async function fillForm(doc: PDFDocument, values: Record<string, string | boolean>, flatten: boolean, fontFor: (text: string) => Promise<PDFFont>, wrap: (page: PDFPage) => void): Promise<FillOutcome> {
  const f = formOf(doc)
  if (!f || !f.fields.length) throw new ToolError(`this PDF has no fill-in form fields${f?.xfa ? ' that can be filled here (it is an XFA form, which only Adobe software fills)' : ''}; to write on it, look at the page (read with as_images) and use add_text at the empty places`, 'pdf_no_form')
  const names = Object.keys(values)
  if (!names.length && !flatten) throw new ToolError(`give the values in fields, by field name. This PDF's fields: ${listNames(f.fields)}`)
  const done = new Map<PDFField, string>()
  for (const name of names) {
    const field = findField(f.fields, name)
    if (done.has(field)) throw new ToolError(`"${name}" and "${done.get(field)}" are the same field; give it once`)
    done.set(field, name)
    const v = values[name]!
    const fname = field.getName()
    try { if (field.isReadOnly()) throw new ToolError(`the field "${fname}" is read-only in this form and cannot be filled`) } catch (e) { if (e instanceof ToolError) throw e }
    if (field instanceof PDFTextField) {
      if (typeof v !== 'string') throw new ToolError(`the field "${fname}" is a text field; give its value as text`)
      const text = v.replace(/\r\n?/g, '\n')
      if (text.includes('\n') && !field.isMultiline()) throw new ToolError(`the field "${fname}" holds one line; give its value without line breaks`)
      const max = field.getMaxLength()
      if (max !== undefined && [...text].length > max) throw new ToolError(`the field "${fname}" takes at most ${max} characters; "${text}" has ${[...text].length}`)
      field.setText(text || undefined)
      if (text) field.updateAppearances(await fontFor(text))
      else field.updateAppearances(await fontFor('a'))
    } else if (field instanceof PDFCheckBox) {
      const on = typeof v === 'boolean' ? v : YES.has(norm(v)) ? true : NO.has(norm(v)) ? false : null
      if (on === null) throw new ToolError(`the field "${fname}" is a checkbox; give true to tick it or false to leave it empty`)
      if (on) field.check(); else field.uncheck()
      if (field.needsAppearancesUpdate()) field.defaultUpdateAppearances()
    } else if (field instanceof PDFRadioGroup) {
      const options = field.getOptions()
      if (v === false || v === '') field.clear()
      else {
        const o = typeof v === 'string' ? pick(options, v) : undefined
        if (!o) throw new ToolError(`the field "${fname}" is a choice of ${options.map((x) => `"${x}"`).join(', ')}; give one of those`)
        field.select(o)
      }
      if (field.needsAppearancesUpdate()) field.defaultUpdateAppearances()
    } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      if (typeof v !== 'string') throw new ToolError(`the field "${fname}" is a list to choose from; give the choice as text`)
      const options = field.getOptions()
      const wanted = field instanceof PDFOptionList && field.isMultiselect() ? v.split(/\s*,\s*/).filter(Boolean) : v.trim() ? [v.trim()] : []
      if (!wanted.length) field.clear()
      else {
        const chosen = wanted.map((w) => pick(options, w) ?? (field instanceof PDFDropdown && field.isEditable() ? w : null))
        const bad = wanted.filter((_, i) => chosen[i] === null)
        if (bad.length) throw new ToolError(`the field "${fname}" is a choice of ${options.slice(0, 50).map((x) => `"${x}"`).join(', ')}; "${bad[0]}" is not one of them`)
        field.select(chosen as string[])
      }
      field.updateAppearances(await fontFor(wanted.join(' ') || 'a'))
    } else throw new ToolError(`the field "${fname}" is ${field instanceof PDFSignature ? 'a signature field (use stamp_image for a signature picture)' : 'a button'}, not a field to fill`)
  }
  const set = [...done.keys()].map((x) => x.getName())
  const empty = f.fields.filter((x) => !done.has(x) && !(x instanceof PDFButton) && !(x instanceof PDFSignature) && (valueOf(x) === '' || valueOf(x) === false)).map((x) => x.getName())
  if (flatten) {
    // every field needs an appearance to be drawn into the page: the ones nobody set and that have none get one now
    for (const x of f.fields) {
      try { if (x.needsAppearancesUpdate()) x.defaultUpdateAppearances(await fontFor(String(valueOf(x)) || 'a')) } catch {}
    }
    const pages = annotPages(doc)
    for (const x of f.fields) for (const b of boxesOf(doc, x, pages)) wrap(doc.getPage(b.page))
    try { f.form.flatten({ updateFieldAppearances: false }) } catch { throw new ToolError('the form could not be turned into plain page content (a field has no drawing); fill it without flatten') }
  }
  return { set, empty, flattened: flatten, xfa: f.xfa }
}

const fieldValue = (f: FormFieldInfo) => f.type === 'checkbox' ? (f.value ? 'ticked' : 'not ticked') : f.value === '' ? 'empty' : `now ${JSON.stringify(String(f.value).slice(0, 80))}`

/** What a read says about a PDF's form fields: their names, kinds and values, and how to fill them. '' without fields. */
export function formFieldsText(r: FormReport): string {
  if (!r.fields.length) return r.xfa ? 'This PDF is an XFA form (made in Adobe LiveCycle); its fields cannot be filled here. To write on it, look at the page (read with as_images) and use edit_pdf add_text at the empty places.' : ''
  const lines = r.fields.slice(0, FORM_FIELDS_LISTED_MAX).map((f) => {
    const kind = f.options?.length && f.type !== 'checkbox' ? `${f.type}: ${f.options.slice(0, OPTIONS_LISTED_MAX).map((o) => JSON.stringify(o)).join(' | ')}${f.options.length > OPTIONS_LISTED_MAX ? ' | …' : ''}` : f.type
    const extra = [f.label ? `label ${JSON.stringify(f.label)}` : '', f.page ? `page ${f.page} at ${f.x_mm}, ${f.y_mm} mm` : '', f.multiline ? 'several lines' : '', f.maxLength !== undefined ? `at most ${f.maxLength} characters` : '', f.readOnly ? 'read-only' : ''].filter(Boolean).join(', ')
    return `- ${JSON.stringify(f.name)} (${kind}; ${fieldValue(f)}${extra ? `; ${extra}` : ''})`
  })
  const more = r.fields.length > FORM_FIELDS_LISTED_MAX ? `\n… and ${r.fields.length - FORM_FIELDS_LISTED_MAX} more fields (an unknown name in fill_form lists them all)` : ''
  return `This PDF is a fill-in form with ${r.fields.length} field${r.fields.length === 1 ? '' : 's'}. To fill it, use edit_pdf with one fill_form operation that sets these fields by name ` +
    '(text as text, a checkbox as true or false, a choice as one of its options); do not write the values onto the page with add_text, because the fields are drawn on top of the page and hide such text. ' +
    `Say a value is filled only when the edit_pdf result lists its field as set.\n${lines.join('\n')}${more}`
}
