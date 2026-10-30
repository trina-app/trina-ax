# HWP Preview plugin: third-party notices

This package (`app.trina.hwp-preview`) contains third-party software only, unchanged. This file covers exactly what the
package ships: the pinned rhwp 0.8.7 command-line program for one of four targets, and one font. Parts of the rhwp
project that are not in that program (the WebAssembly build, rhwp-studio, browser and editor extensions, other fonts,
test data) are not shipped and not listed.

Package licence: `MIT AND Apache-2.0 AND BSD-3-Clause AND MPL-2.0 AND OFL-1.1 AND LicenseRef-HWP-Notices`.
`LicenseRef-HWP-Notices` stands for the further licences named below and reproduced in `notices/`: BSD-2-Clause, MIT-0,
Zlib, Unicode-3.0, MIT-Modern-Variant, IJG and libpng-2.0. MPL-2.0 covers one small part of the svg2pdf crate (below).

This software is based in part on the work of the Independent JPEG Group.

## Files in the package

| Path | What | Licence | Notice |
| --- | --- | --- | --- |
| `bin/rhwp` | rhwp 0.8.7 command-line program, upstream release build, unchanged | MIT, plus the linked components below | `notices/rhwp-MIT.txt` and the files below |
| `fonts/NotoSansKR-Regular.ttf` | Noto Sans KR Regular (weight 400), unchanged | OFL-1.1 | `notices/NotoSans-OFL.txt` |
| `NOTICE`, `notices/*` | these notices | | |

## The rhwp executable

Source: https://github.com/edwardkim/rhwp/tree/1a76570e833917d15817415a53c09ad61ab3203f (tag `v0.8.7`).

| Target | Upstream archive | Archive SHA-256 | Executable SHA-256 |
| --- | --- | --- | --- |
| darwin-arm64 | `rhwp-v0.8.7-macos-aarch64.tar.gz` | `6ed46aa63f6d10c447842999f73abc59cf9586c5645fefc5e763bd6a6d43662d` | `03a104098641fd677e278100213f0340a60db548d71b7e218c06a8e1543422be` |
| darwin-x64 | `rhwp-v0.8.7-macos-x86_64.tar.gz` | `07b1a5ea570e410d1b52b4d848a94f00c64674e84004883c62efad7daab61da4` | `2d0c06bb0e90cc2ebc18811bd3e7c4aa11833a12e19114c0957631cf290ea1fe` |
| linux-arm64 | `rhwp-v0.8.7-linux-aarch64.tar.gz` | `c4a70f5ed11b99586ee89d1ac9069145d58a0831d00e87858bb01626e2ebf313` | `6427958afd8e39ef0f753e5440d04a527bc7d6f7f95fdbb4ade9c6df1e1d7c7a` |
| linux-x64 | `rhwp-v0.8.7-linux-x86_64.tar.gz` | `f1e541a25cfe76b6bc1daf18bf9c1f9a5ac5e03e2c01b188daaf54107214f631` | `6d1ccdfb5522d13cb9f6134357aeb718f705454709cf52627ccc127e249c3277` |

Built by the upstream workflow run https://github.com/edwardkim/rhwp/actions/runs/38127368761 from that commit with
`cargo build --locked --release --bin rhwp --features native-skia --target <target>`, Rust 1.93.1, `Cargo.lock`
SHA-256 `f24e98940a42000cea09500bea090cc571773e761c3d068769227e82a0e2f024`. The run's provenance records give the
archive SHA-256 values above. Details: `notices/SOURCE-OFFER.txt`.

### Statically linked components

| Component | Version | Licence (as used) | Full text |
| --- | --- | --- | --- |
| rhwp, rhwp-contracts, rhwp-ooxml-chart, rhwp-password-crypto | 0.8.7 / 0.1.0 | MIT | `notices/rhwp-MIT.txt` |
| 177 Rust crates (incl. the above, skia-safe / skia-bindings 0.153.3, the vendored svg2pdf 0.13.0), list with versions in the file | see file | MIT, MIT-0, Apache-2.0, BSD-3-Clause, BSD-2-Clause, Zlib, Unicode-3.0 | `notices/rust-crates.txt` |
| svg2pdf, the part of `draw_path` taken from resvg | 0.13.0 | MPL-2.0 (svg2pdf's NOTICE) | `notices/rust-crates.txt` |
| Rust standard library | 1.93.1 | (MIT OR Apache-2.0) AND Unicode-3.0, with the notices of its dependencies | `notices/rust-std-1.93.1-COPYRIGHT-library.html` |
| Skia (incl. skcms) | m153 (rust-skia/skia 61e7ca4e) | BSD-3-Clause | `notices/native-libraries.txt` |
| HarfBuzz | 13.1.0 | MIT-Modern-Variant ("Old MIT"); `src/ms-use` MIT | `notices/native-libraries.txt` |
| libjpeg-turbo | 3.1.0 | IJG AND BSD-3-Clause AND Zlib | `notices/native-libraries.txt` |
| libpng | 1.6.56 | libpng-2.0 | `notices/native-libraries.txt` |
| zlib (Chromium) | 1.3.0.1 | Zlib; Chromium additions BSD-3-Clause | `notices/native-libraries.txt` |
| Expat (Linux executables only) | 2.7.4 | MIT | `notices/native-libraries.txt` |
| Wuffs | 0.3.3 | Apache-2.0 | `notices/native-libraries.txt` |

Where a crate offers a choice of licences it is used under the first of MIT, MIT-0, Apache-2.0, BSD-3-Clause,
BSD-2-Clause, Zlib it offers; `notices/rust-crates.txt` names the choice for each crate. Apache-2.0-only parts: Wuffs and
the zopfli crate; neither has a NOTICE file. The NOTICE files of subsetter and svg2pdf are reproduced in full.

Built but not linked: Skia's static libraries also hold ICU 78.2 (with its data), skparagraph, skshaper and skunicode.
rhwp does not use Skia text layout and none of them is in any of the four executables (symbol tables and bytes
checked), so their licences are not reproduced.

Copyleft: one part only. svg2pdf's NOTICE says that parts of `draw_path` in `src/render/path.rs` were taken from resvg
and are under the Mozilla Public License 2.0 (the quadratic-to-cubic conversion; resvg itself, in this program as
0.45.1 and 0.47.0, has since been relicensed to MIT OR Apache-2.0). That function is in all four executables. MPL-2.0
is a file-level licence: the executable may be distributed under other terms as long as the MPL text comes with it
(svg2pdf's NOTICE in `notices/rust-crates.txt`) and recipients are told where that file's source is
(`notices/SOURCE-OFFER.txt`). svg2pdf's NOTICE also names MPL-2.0, CC BY-SA 4.0, OFL-1.1 and Apache-2.0 for test files
that are not compiled in. There is no GPL or LGPL code, no non-commercial or field-of-use restriction and no component
without a licence in the executable. The Rust standard-library notice covers every Rust target; crates it lists for other
targets only (for example fortanix-sgx-abi, MPL-2.0, for SGX and r-efi for UEFI) are not in these executables.

### Not shipped: operating-system libraries

The executables load these from the operating system at run time; the package does not contain them.
Linux: glibc (libc, libm, 2.39 or newer), libstdc++, libgcc_s, FreeType (`libfreetype.so.6`), Fontconfig
(`libfontconfig.so.1`). macOS: libc++, libSystem, libiconv, CoreText, CoreGraphics, CoreFoundation, ApplicationServices.

### Data compiled into rhwp

- **Font metric tables** (`src/renderer/font_metrics_generated.rs`, 595 entries, and `font_metrics_overlays.rs`, 5
  entries measured from Hancom Office output): per-character advance widths keyed by font name (about 400 family
  names), so that documents lay out as in Hancom Office even without the original fonts. Most names are commercial
  families (for example HCR Batang / HCR Dotum, Malgun Gothic, HY and Haansoft fonts, Arial, Times New Roman, Office
  and Bitstream fonts). They are numbers, not font programs or glyph outlines; no proprietary font file is in the
  package. rhwp distributes them under its MIT licence. Upstream's own per-entry record
  (`mydocs/tech/investigations/issue-4964/font_metric_lineage_manifest.json` at the commit above) lists source font,
  licence and provenance as unknown for 599 of the 600 entries (only Noto Sans KR is verified); see "Open" in
  `notices/SOURCE-OFFER.txt`.
- Small HWP document fragments that rhwp uses when it writes new files: a blank HWP 5 template and a few streams taken
  from sample documents (the summary stream's metadata names the rhwp author as creator). The plugin only reads
  documents and renders pages.

## Font

Noto Sans KR Regular, weight 400, SHA-256 `6e06a7fe5d696ca719894a23f36bb2b1be8c816a5937cd4ad0f23ca67780dd74`, from the
rhwp commit above (`ttfs/opensource/NotoSansKR-Regular.ttf`), a static instance of Google Fonts
`ofl/notosanskr/NotoSansKR[wght].ttf`. Copyright notice in the font: "(c) 2014-2021 Adobe (http://www.adobe.com/), with
Reserved Font Name 'Source'." SIL Open Font License 1.1: `notices/NotoSans-OFL.txt`.

## How this was produced

- `notices/rust-crates.txt`: `scripts/plugins/hwp-notices.ts` in Trina AX (`cargo tree -e normal,no-proc-macro
  --features native-skia` for each target, licence files from the crates themselves).
- `notices/native-libraries.txt`: the object lists of the four Skia static-library archives and Skia's `DEPS` at the
  pinned revision, narrowed to what the linker kept (symbol tables and source-file entries of the four executables;
  versions also read from strings in them: libpng 1.6.56, zlib 1.3.0.1, libjpeg-turbo 3.1.0, Expat 2.7.4); licence
  texts from those revisions.
- Cross-check: every crate whose source path is embedded in the four executables is in `notices/rust-crates.txt`, and
  the dynamic library lists come from the executables' ELF and Mach-O headers.
