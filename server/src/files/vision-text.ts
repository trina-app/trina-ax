// Notes the AI gets instead of an image (server/src/files/vision.ts), in the person's language: the AI usually passes
// them on ("I can't see this picture because ..."). Contract errors of read itself (a bad `pages` value) stay English
// like the other tool errors.
import type { Database } from 'bun:sqlite'

export const VISION_TEXT = {
  off: {
    ko: '이 팀은 AI에게 이미지를 보내지 않도록 설정되어 있어 이미지를 보여 줄 수 없습니다. 관리자가 팀 설정에서 "이미지와 PDF 페이지를 AI에게 보내기"를 켤 수 있습니다.',
    en: 'This team does not send images to the AI, so the image was not shown. An admin can turn on "Send images and PDF pages to the AI" in Team settings.',
    id: 'Tim ini tidak mengirim gambar ke AI, jadi gambar tidak ditampilkan. Admin dapat mengaktifkan "Kirim gambar dan halaman PDF ke AI" di Pengaturan tim.',
    ja: 'このチームは画像を AI に送信しない設定のため、画像は表示されませんでした。管理者は「チーム設定」で「画像と PDF のページを AI に送信」をオンにできます。',
    es: 'Este equipo no envía imágenes a la IA, por lo que la imagen no se mostró. Un administrador puede activar "Enviar imágenes y páginas PDF a la IA" en la configuración del equipo.',
  },
  engine: {
    ko: '이 대화의 AI 엔진(API 엔진)은 글자만 읽을 수 있어 이미지를 보여 줄 수 없습니다. 이미지를 보려면 Claude나 Codex를 사용하세요.',
    en: 'The AI engine of this chat (the API engine) reads text only, so the image cannot be shown. Use Claude or Codex to look at images.',
    id: 'Mesin AI percakapan ini (mesin API) hanya membaca teks, jadi gambar tidak dapat ditampilkan. Gunakan Claude atau Codex untuk melihat gambar.',
    ja: 'このチャットの AI エンジン（API エンジン）はテキストのみを読み取るため、画像を表示できません。画像を見るには Claude または Codex を使用してください。',
    es: 'El motor de IA de este chat (el motor API) solo lee texto, por lo que la imagen no se puede mostrar. Usa Claude o Codex para ver imágenes.',
  },
  connection: {
    ko: '이 연결로는 글자만 보낼 수 있어 이미지를 보여 줄 수 없습니다.',
    en: 'This connection carries text only, so the image cannot be shown.',
    id: 'Koneksi ini hanya membawa teks, jadi gambar tidak dapat ditampilkan.',
    ja: 'この接続はテキストのみを送信するため、画像を表示できません。',
    es: 'Esta conexión solo transmite texto, por lo que la imagen no se puede mostrar.',
  },
  budget: {
    ko: '이번 답변에 보낼 수 있는 이미지 한도({images}장 또는 {mb}MB)에 도달해 보여 주지 않았습니다. 새 메시지에서 이어서 볼 수 있습니다.',
    en: 'Not shown: this reply already reached its image limit ({images} images or {mb} MB). Continue in a new message.',
    id: 'Tidak ditampilkan: balasan ini sudah mencapai batas gambar ({images} gambar atau {mb} MB). Lanjutkan di pesan baru.',
    ja: '表示されませんでした: この返信で送信できる画像の上限（{images} 枚または {mb} MB）に達しました。新しいメッセージで続けてください。',
    es: 'No se mostró: esta respuesta ya alcanzó su límite de imágenes ({images} imágenes o {mb} MB). Continúa en un mensaje nuevo.',
  },
  unavailable: {
    ko: '이 서버에는 AI에게 보낼 이미지를 변환하는 도구가 없어 이미지를 보여 줄 수 없습니다.',
    en: 'This server has no converter for images sent to the AI, so the image cannot be shown.',
    id: 'Server ini tidak memiliki pengonversi gambar untuk AI, jadi gambar tidak dapat ditampilkan.',
    ja: 'このサーバーには AI に送る画像の変換ツールがないため、画像を表示できません。',
    es: 'Este servidor no tiene un conversor de imágenes para la IA, por lo que la imagen no se puede mostrar.',
  },
  tooLarge: {
    ko: '이미지가 너무 커서(5천만 화소 또는 32MB 초과) 보여 줄 수 없습니다.',
    en: 'The image is too large to show (over 50 megapixels or 32 MB).',
    id: 'Gambar terlalu besar untuk ditampilkan (lebih dari 50 megapiksel atau 32 MB).',
    ja: '画像が大きすぎるため表示できません（5,000 万画素または 32 MB 超）。',
    es: 'La imagen es demasiado grande para mostrarla (más de 50 megapíxeles o 32 MB).',
  },
  unsupported: {
    ko: '이 형식의 이미지는 보여 줄 수 없습니다(PNG, JPEG, GIF, WebP, HEIC, TIFF, BMP 지원).',
    en: 'Images in this format cannot be shown (PNG, JPEG, GIF, WebP, HEIC, TIFF and BMP are supported).',
    id: 'Gambar dengan format ini tidak dapat ditampilkan (PNG, JPEG, GIF, WebP, HEIC, TIFF, dan BMP didukung).',
    ja: 'この形式の画像は表示できません（PNG、JPEG、GIF、WebP、HEIC、TIFF、BMP に対応）。',
    es: 'Las imágenes en este formato no se pueden mostrar (se admiten PNG, JPEG, GIF, WebP, HEIC, TIFF y BMP).',
  },
  damaged: {
    ko: '이미지가 손상되었거나 읽을 수 없어 보여 줄 수 없습니다.',
    en: 'The image is damaged or unreadable, so it cannot be shown.',
    id: 'Gambar rusak atau tidak dapat dibaca, jadi tidak dapat ditampilkan.',
    ja: '画像が破損しているか読み取れないため、表示できません。',
    es: 'La imagen está dañada o no se puede leer, por lo que no se puede mostrar.',
  },
  heavy: {
    ko: '이미지를 변환하는 데 시간이나 메모리가 너무 많이 들어 보여 주지 않았습니다.',
    en: 'Converting the image took too long or needed too much memory, so it was not shown.',
    id: 'Konversi gambar memakan waktu atau memori terlalu banyak, jadi tidak ditampilkan.',
    ja: '画像の変換に時間またはメモリがかかりすぎたため、表示しませんでした。',
    es: 'Convertir la imagen tardó demasiado o necesitó demasiada memoria, por lo que no se mostró.',
  },
  busy: {
    ko: '지금은 이미지 변환 요청이 많습니다. 잠시 후 다시 읽어 주세요.',
    en: 'Many images are being converted right now. Read it again in a moment.',
    id: 'Saat ini banyak gambar sedang dikonversi. Baca lagi sebentar lagi.',
    ja: '現在、多くの画像を変換しています。しばらくしてからもう一度読み取ってください。',
    es: 'Se están convirtiendo muchas imágenes en este momento. Vuelve a leerla en un momento.',
  },
  scanned: {
    ko: '텍스트 레이어가 없는 페이지(스캔·그림): {pages}.',
    en: 'Pages without a text layer (scans or pictures): {pages}.',
    id: 'Halaman tanpa lapisan teks (pindaian atau gambar): {pages}.',
    ja: 'テキスト層のないページ（スキャンまたは画像）: {pages}。',
    es: 'Páginas sin capa de texto (escaneos o imágenes): {pages}.',
  },
  scannedHint: {
    ko: '이미지로 보려면 pages로 그 페이지를 읽으세요(예: pages: "{first}").',
    en: 'Read them with pages to see them as images (for example pages: "{first}").',
    id: 'Baca dengan pages untuk melihatnya sebagai gambar (misalnya pages: "{first}").',
    ja: 'pages で読み取ると画像として表示されます（例: pages: "{first}"）。',
    es: 'Léelas con pages para verlas como imágenes (por ejemplo pages: "{first}").',
  },
  ocrPage: {
    ko: '{page}쪽(스캔, 글자 인식 결과):',
    en: 'Page {page} (scanned; recognized text):',
    id: 'Halaman {page} (pindaian; teks yang dikenali):',
    ja: '{page} ページ（スキャン、認識したテキスト）:',
    es: 'Página {page} (escaneada; texto reconocido):',
  },
} as const

export type VisionTextKey = keyof typeof VISION_TEXT

export function visionText(db: Database, userId: string, key: VisionTextKey, vars: Record<string, string | number> = {}): string {
  const u = db.query('SELECT locale FROM users WHERE id = ?').get(userId) as { locale?: string } | null
  const locale = u?.locale === 'ko' || u?.locale === 'id' || u?.locale === 'ja' || u?.locale === 'es' ? u.locale : 'en'
  return VISION_TEXT[key][locale].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}
