// mycel-ocr: macOS helper (PDFKit, ImageIO, Apple Vision; on-device, no network) reading stdin. Runs inside the
// converter sandbox (tools/isolate.ts).
//   mycel-ocr [--max-pages N]  < file
//       text of a scanned PDF for the search index (grep text cache, semantic search; server/src/files/extract.ts):
//       Apple's Vision text recognizer (Korean + English). PDF pages that have a text layer keep it; only pages
//       without one are rendered and recognized. Output: UTF-8 text, pages separated by an empty line. An AI read
//       shows images and scanned pages as images instead (server/src/files/vision.ts); this text is its fallback
//       only when a team turned image viewing off.
//   mycel-ocr --jpeg N  < image   (a JPEG of the image, longest side at most N px, rotated as the file asks; the
//                                  HEIC / HEIF preview of the file panel and of AI reads, heic-preview.ts)
//   mycel-ocr --layer  < pdf      (the text layer of every page, no recognition; each page ends with a form feed,
//                                  like pdftotext: AI reads on a Mac without poppler, server/src/files/vision.ts)
//   mycel-ocr --page P --px N  < pdf   (page P, 1-based, drawn on white with its /Rotate, longest side N px, as a
//                                       PNG: a PDF page the AI reads as an image, server/src/files/vision.ts)
// Exit 2: not a PDF or an image (or no such page). Exit 1: other failures (a password-protected PDF).
import CoreGraphics
import Foundation
import ImageIO
import PDFKit
import Vision

var maxPages = 100
var jpegMax = 0
var layerOnly = false
var pageNo = 0
var pagePx = 0
var args = CommandLine.arguments.dropFirst()
while let a = args.popFirst() {
  if a == "--max-pages", let v = args.popFirst(), let n = Int(v), n > 0 { maxPages = n }
  if a == "--jpeg", let v = args.popFirst(), let n = Int(v), n > 0 { jpegMax = min(n, 16384) }
  if a == "--layer" { layerOnly = true }
  if a == "--page", let v = args.popFirst(), let n = Int(v), n > 0 { pageNo = n }
  if a == "--px", let v = args.popFirst(), let n = Int(v), n > 0 { pagePx = min(n, 4096) }
}

func fail(_ msg: String, _ code: Int32) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(code)
}

func recognize(_ img: CGImage, _ orientation: CGImagePropertyOrientation = .up) -> String {
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.recognitionLanguages = ["ko-KR", "en-US"]
  req.usesLanguageCorrection = true
  do { try VNImageRequestHandler(cgImage: img, orientation: orientation, options: [:]).perform([req]) } catch { fail("text recognition failed: \(error)", 1) }
  return (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

/** A page drawn at 2x on white (about 144 dpi), capped at 4000 px on the long side. */
func render(_ page: PDFPage) -> CGImage? {
  let box = page.bounds(for: .mediaBox)
  guard box.width > 0, box.height > 0 else { return nil }
  let scale = min(2.0, 4000 / max(box.width, box.height))
  let w = Int(box.width * scale), h = Int(box.height * scale)
  guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  ctx.scaleBy(x: scale, y: scale)
  page.draw(with: .mediaBox, to: ctx)
  return ctx.makeImage()
}

/** An image with transparency drawn on white: dark text on a transparent background otherwise reads as nothing. */
func onWhite(_ img: CGImage) -> CGImage {
  switch img.alphaInfo {
  case .none, .noneSkipFirst, .noneSkipLast: return img
  default: break
  }
  guard let ctx = CGContext(data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return img }
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: img.width, height: img.height))
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
  return ctx.makeImage() ?? img
}

/** The primary image as a JPEG on white (ImageIO joins the tiles of a phone HEIC and applies the orientation). */
func jpeg(_ data: Data, _ maxPx: Int) -> Never {
  guard let src = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(src) > 0 else { fail("not an image", 2) }
  let opts: [CFString: Any] = [
    kCGImageSourceCreateThumbnailFromImageAlways: true,
    kCGImageSourceCreateThumbnailWithTransform: true,
    kCGImageSourceThumbnailMaxPixelSize: maxPx,
    kCGImageSourceShouldCacheImmediately: true,
  ]
  guard let img = CGImageSourceCreateThumbnailAtIndex(src, CGImageSourceGetPrimaryImageIndex(src), opts as CFDictionary) else { fail("could not decode the image", 1) }
  let out = NSMutableData()
  guard let dst = CGImageDestinationCreateWithData(out as CFMutableData, "public.jpeg" as CFString, 1, nil) else { fail("could not write a JPEG", 1) }
  CGImageDestinationAddImage(dst, onWhite(img), [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
  guard CGImageDestinationFinalize(dst) else { fail("could not write a JPEG", 1) }
  FileHandle.standardOutput.write(out as Data)
  exit(0)
}

/** A PDF document from stdin, or exit 2 (not a PDF) / 1 (locked). */
func pdf(_ data: Data) -> PDFDocument {
  guard data.starts(with: Array("%PDF".utf8)), let doc = PDFDocument(data: data) else { fail("not a PDF", 2) }
  if doc.isLocked { fail("the PDF is password-protected", 1) }
  return doc
}

/** Every page's text layer, each page followed by a form feed (pdftotext's page break). */
func layer(_ data: Data) -> Never {
  let doc = pdf(data)
  var text = ""
  for i in 0..<doc.pageCount { text += (doc.page(at: i)?.string ?? "") + "\u{0C}" }
  FileHandle.standardOutput.write(text.data(using: .utf8)!)
  exit(0)
}

/** One page as a reader shows it (a PNG): the crop box turned by the page's /Rotate, longest side maxPx, on white. */
func pagePng(_ data: Data, _ number: Int, _ maxPx: Int) -> Never {
  let doc = pdf(data)
  guard number <= doc.pageCount, let ref = doc.page(at: number - 1)?.pageRef else { fail("no such page", 2) }
  let box = ref.getBoxRect(.cropBox)
  let rot = ((Int(ref.rotationAngle) % 360) + 360) % 360
  let (w, h) = rot == 90 || rot == 270 ? (box.height, box.width) : (box.width, box.height)
  guard w > 0, h > 0 else { fail("empty page", 1) }
  let scale = CGFloat(maxPx) / max(w, h)
  let pw = max(1, Int((w * scale).rounded())), ph = max(1, Int((h * scale).rounded()))
  guard let ctx = CGContext(data: nil, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { fail("could not draw the page", 1) }
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: pw, height: ph))
  ctx.scaleBy(x: scale, y: scale)
  // the page's clockwise /Rotate in this y-up space, with the turned box's corner at the origin
  switch rot {
  case 90: ctx.concatenate(CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: 0, ty: box.width))
  case 180: ctx.concatenate(CGAffineTransform(a: -1, b: 0, c: 0, d: -1, tx: box.width, ty: box.height))
  case 270: ctx.concatenate(CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: box.height, ty: 0))
  default: break
  }
  ctx.translateBy(x: -box.minX, y: -box.minY)
  ctx.clip(to: box)
  ctx.drawPDFPage(ref)
  guard let img = ctx.makeImage() else { fail("could not draw the page", 1) }
  let png = NSMutableData()
  guard let dst = CGImageDestinationCreateWithData(png as CFMutableData, "public.png" as CFString, 1, nil) else { fail("could not write a PNG", 1) }
  CGImageDestinationAddImage(dst, img, nil)
  guard CGImageDestinationFinalize(dst) else { fail("could not write a PNG", 1) }
  FileHandle.standardOutput.write(png as Data)
  exit(0)
}

let data = FileHandle.standardInput.readDataToEndOfFile()
if pageNo > 0 && pagePx > 0 { pagePng(data, pageNo, pagePx) }
if jpegMax > 0 { jpeg(data, jpegMax) }
if layerOnly { layer(data) }
var out: [String] = []
if data.starts(with: Array("%PDF".utf8)), let doc = PDFDocument(data: data) {
  if doc.isLocked { fail("the PDF is password-protected", 1) }
  for i in 0..<min(doc.pageCount, maxPages) {
    guard let page = doc.page(at: i) else { continue }
    let layer = page.string ?? ""
    if layer.filter({ !$0.isWhitespace }).count >= 20 { out.append(layer); continue }
    if let img = render(page) { out.append(recognize(img)) }
  }
  if doc.pageCount > maxPages { out.append("[… \(doc.pageCount - maxPages) more pages not read]") }
} else if let src = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(src) > 0,
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) {
  let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
  let raw = (props?[kCGImagePropertyOrientation] as? UInt32) ?? 1
  out.append(recognize(onWhite(img), CGImagePropertyOrientation(rawValue: raw) ?? .up))
} else {
  fail("not a PDF or an image", 2)
}
FileHandle.standardOutput.write(out.joined(separator: "\n\n").data(using: .utf8)!)
