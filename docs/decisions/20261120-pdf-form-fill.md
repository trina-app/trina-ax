# A fill-in PDF form is filled through its fields, never by writing under them

- Date: 2026-11-20
- Status: accepted
- Supersedes: none
- Branch: fix/pdf-form-fill (QA TC-5513, P1)

- **Ask:** asked to fill a PDF that has real form fields (AcroForm), the AI wrote each value with edit_pdf `add_text`
  onto the page under the empty fields. Preview, poppler and Acrobat draw a form's fields on top of the page, so the
  saved form looked blank; the AI said every value was in its box, because the page image it checked was drawn without
  the fields.
- **Rule:**
  - A new edit_pdf operation `fill_form { fields, flatten? }` (no new tool). `fields` maps a field name to its value:
    text for a text field, true / false for a checkbox, one of the options for a dropdown, list or radio group. The
    values go into the fields (`/V`, a checkbox's `/AS`) and each changed field gets a new appearance stream, written
    with Helvetica for Latin text and the server's Pretendard otherwise, so every viewer shows it without relying on
    `NeedAppearances`. pdf-lib's own appearance pass at save is off (it writes Helvetica, which cannot hold Hangul).
    `flatten: true`, only when the user asks for a form that can no longer be changed, draws the fields into the pages
    and removes them. XFA data is dropped (pdf-lib does not write it; Acrobat would show it instead of the fields).
  - A name matches exactly, then ignoring case, then by its last part ("form1[0].Name[0]" → "Name") or its tooltip when
    that is unique. An unknown name, a wrong kind of value, a read-only field, a too-long text or a choice that is not an
    option is refused with nothing saved; an unknown name lists every field. The result lists the fields set and the
    fields still empty; the AI says a value is filled only when the result lists its field.
  - A read of a PDF lists its form fields (name, kind, value now, options, tooltip, page and position in mm) with how to
    fill them, after the page text. Only a PDF of at most 20 MB whose bytes name `/AcroForm` (or hide objects in object
    streams) is parsed for this, in the office worker; a failure leaves the list out.
  - `add_text` whose line would sit under a field's box (signature fields aside) is refused with a pointer to
    `fill_form`, so the old way cannot come back silently.
  - `fill_form` with page removal, keep, reorder or insert in the same call is refused unless `flatten` (a rebuilt
    document does not carry the form over).
  - The Mac page image the AI looks at (mycel-ocr `--page`) is drawn by PDFKit's `PDFPage.draw` with the page's
    annotations, like Preview, instead of CoreGraphics' `drawPDFPage`, which drew the page content only.
- **Why:** the fields are what a reader, a form processor and the next person see and edit; text under them is
  invisible. The AI's own check must see what the person will see.
- **Left out:** creating new fields on a flat (non-form) PDF; filling XFA-only forms; JavaScript calculations and
  formatting of the form (Acrobat recalculates on open).
- **Tests:** `tests/unit/pdf-form-fill.test.ts` (read lists the fields; text, checkbox, dropdown, radio set; poppler
  draws the values inside the boxes; a field that is its own widget, as ReportLab writes it; flatten; Hangul; the
  refusals). Real AI on a private QA copy: English and Korean vendor forms, fields and flattened, checked in pdftoppm,
  QuickLook and sips.
- **Version impact:** none (no schema, no setting).
