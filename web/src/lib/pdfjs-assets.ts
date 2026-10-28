// Where pdf.js finds its own data files (file previews, component D). pdf.js 6 does not draw everything by itself:
// - cmaps/ and standard_fonts/: text in fonts a PDF does not embed (Korean forms, ReportLab's CID fonts);
// - wasm/: the decoders of scanned images (jbig2.wasm also does CCITT fax, openjpeg.wasm JPEG 2000) and colour
//   profiles (qcms), with the plain-JS fallbacks pdf.js imports when WebAssembly is off;
// - iccs/: the CMYK profile.
// Without them those pages come out blank or without their text (docs/DECISIONS.md "PDF 미리보기"). The build copies
// the folders to dist/assets/pdfjs-<version>/ (web/scripts/pdfjs-assets.ts), where the server treats them like every
// hashed asset (cached for good, a missing file is a 404 and never the app shell); the dev server serves them too.

export const PDFJS_DATA_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'] as const

/** dist-relative folder of the data files of this pdf.js version (with a trailing slash) */
export const pdfjsAssetsDir = (version: string) => `assets/pdfjs-${version}/`

/** The getDocument options that point pdf.js there (absolute URLs: the worker fetches them itself). */
export function pdfjsDataOptions(origin: string, version: string) {
  const base = `${origin}/${pdfjsAssetsDir(version)}`
  return {
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
  }
}
