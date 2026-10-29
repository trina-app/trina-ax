// mycel-ocr: text of a PDF or an image read from stdin, for read/grep (server/src/files/extract.ts). macOS only:
// Apple's Vision text recognizer (Korean + English, on-device, no network). PDF pages that have a text layer keep it
// (PDFKit); only pages without one are rendered and recognized, so a scanned page inside a normal PDF still reads.
// Runs inside the converter sandbox (tools/isolate.ts). Output: UTF-8 text, pages separated by an empty line.
//   mycel-ocr [--max-pages N]  < file
//   mycel-ocr --jpeg N  < image   (a JPEG of the image, longest side at most N px, rotated as the file asks; the
//                                  HEIC / HEIF preview of the file panel, server/src/files/heic-preview.ts)
// Exit 2: not a PDF or an image.
import CoreGraphics
import Foundation
import ImageIO
import PDFKit
import Vision

var maxPages = 100
var jpegMax = 0
var args = CommandLine.arguments.dropFirst()
while let a = args.popFirst() {
  if a == "--max-pages", let v = args.popFirst(), let n = Int(v), n > 0 { maxPages = n }
  if a == "--jpeg", let v = args.popFirst(), let n = Int(v), n > 0 { jpegMax = min(n, 16384) }
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

let data = FileHandle.standardInput.readDataToEndOfFile()
if jpegMax > 0 { jpeg(data, jpegMax) }
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
