// Kalimat demo jelajah bebas di luar cerita, dalam Bahasa Indonesia (dari en.ts, bukan kata per kata): ruang dan chat
// di sekitar cerita, tim lain, folder CEO, Gmail dan Drive palsu, saran di bilah atas. Semua orang, perusahaan, angka,
// dan alamat di sini rekaan (../README.md). Kalimat cerita sendiri diambil dari scripts/demo/mina/strings/id.ts.
// Chat tim pakai "kamu" yang santai tapi sopan; tanpa tanggal kalender (hari Senin, dua minggu).
import type { FreeRoamStrings } from './en'

export const id: FreeRoamStrings = {
  groups: {
    marketing: 'Kampanye, media sosial, banner, dan halaman produk',
    operations: { name: 'Operasional', description: 'Pesanan, pengiriman, pertanyaan pelanggan' },
    sales: { name: 'Sales', description: 'Kafe dan kantor' },
    shop: { name: 'Toko online', description: 'Toko dan langganan' },
  },

  leadership: {
    folder: 'shared/Pimpinan',
    files: [
      {
        name: 'Rencana 2027 (draf).md',
        text: [
          '# Rencana 2027 (draf, khusus CEO)',
          '',
          'Steepling adalah perusahaan fiktif yang dibuat untuk demo ini. Halaman ini berisi contoh konten.',
          '',
          '- Dua blend musim dingin baru di 2027 (nama sementara: Spiced Pear, Cocoa Rooibos)',
          '- Buka satu wilayah mitra kafe lagi saat musim semi',
          '- Rekrut: satu orang lagi di Operasional, satu desainer',
          '',
          'Belum dibagikan. Ngobrol dulu denganku sebelum bikin rencana berdasarkan ini.',
        ].join('\n'),
      },
    ],
  },

  files: [
    {
      path: 'groups/Operasional/Pengiriman.md',
      text: '# Pengiriman\n\nContoh konten untuk demo.\n\n- Pesanan yang masuk sebelum **jam 14.00** dikirim di hari yang sama\n- Kafe: pengiriman mingguan tiap hari Selasa seperti biasa\n- Pertanyaan pelanggan: dijawab dalam satu hari kerja\n',
    },
    {
      path: 'groups/Sales/Akun kafe.md',
      text: '# Akun kafe\n\nContoh konten untuk demo.\n\n| Kafe | Wilayah | Pesanan | Kunjungan berikutnya |\n|---|---|---|---|\n| Harbour Beans | Pelabuhan | 40 boks / bulan | Selasa |\n| The Reading Room | Kota Lama | 25 boks / bulan | Minggu depan |\n| Corner Kettle | Tepi Sungai | 15 boks / bulan | Dua minggu lagi |\n',
    },
    {
      path: 'groups/Toko online/Kalender toko.md',
      text: '# Kalender toko\n\nContoh konten untuk demo.\n\n- Peluncuran hari Senin, jam 07.00: banner peluncuran tayang (Yuzu Jahe, diskon 20%)\n- Hari Minggu di minggu kedua: promo peluncuran berakhir\n- Setiap hari: pesanan yang masuk sebelum jam 14.00 dikirim di hari yang sama\n',
    },
    {
      path: 'groups/Marketing/Catatan kompetitor.md',
      text: '# Catatan kompetitor\n\nContoh konten untuk demo. Semua merek di sini rekaan.\n\n| Merek | Kabar bulan ini | Harga |\n|---|---|---|\n| Coldleaf | Blend mint musim dingin, beli 1 gratis 1 | US$10,50 / 10 kantong |\n| Brewbright | Langganan kantor, diskon 15% | US$8,90 / 10 kantong |\n| Teatime Co. | Botol kaca baru | US$12,00 / 10 kantong |\n',
    },
  ],

  personas: {
    mina: 'Aku Mina Lee. Hari ini aku mulai kerja di tim Marketing Steepling.',
    sara: 'Aku Sara Jensen, Marketing Lead di Steepling.',
  },

  memory: 'Mina bergabung di tim Marketing pada hari pertamanya di minggu peluncuran Yuzu Jahe; ia mengambil alih banner dan postingan media sosial dari Leo.',

  profile: {
    oneLine: 'Steepling membuat kantong teh cold brew: celupkan satu ke air dingin, dan dalam beberapa jam sudah siap diminum.',
    products: 'Steepling Cold Brew Tea dalam 6 rasa (US$9,90 isi 10 kantong); blend Yuzu Jahe edisi musim dingin (US$11,90 isi 10 kantong)',
    audience: 'Orang yang suka teh tanpa repot rebus air; kafe dan kantor',
    tone: ['Tenang dan hangat', 'Sederhana dan ramah', 'Tidak berlebihan'],
    avoid: '"Terbaik" atau "nomor satu", dan angka yang tidak bisa kami buktikan',
  },

  everyoneBefore: [
    { from: 'tom', minutesAgo: 7 * 1440 + 120, text: 'Info: pesanan yang masuk sebelum **jam 14.00** sekarang dikirim di hari yang sama. Detailnya ada di folder tim kita.' },
    { from: 'omar', minutesAgo: 5 * 1440 + 300, text: 'Besok jam 07.00 toko mati 10 menit buat update ya.' },
    { from: 'daniel', minutesAgo: 3 * 1440 + 60, text: 'Bulan lalu jadi bulan terbaik kita di online sejauh ini. Makasih semuanya 🙏' },
    { from: 'aiko', minutesAgo: 2 * 1440 + 200, text: 'Harbour Beans menggandakan pesanan berikutnya ☕' },
  ],
  marketingBefore: [
    { from: 'sara', minutesAgo: 6 * 1440 + 30, text: 'Mingguan: brief peluncuran Yuzu Jahe sudah ada di folder grup kita. Leo, draft pertama banner paling lambat Rabu ya.' },
    { from: 'leo', minutesAgo: 6 * 1440 + 20, text: 'Siap 👍' },
  ],
  shareNote: 'Banner peluncuran baru, square, dan story buat hari Senin 👇',
  leoDm: 'Selamat datang, Mina! File banner lamaku ada di proyek peluncuran. Kabari aku kalau ada yang kurang jelas 🙂',
  bannerThread: '@Mina Lee Suka banget sama jendela berembunnya. Versi square-nya bisa dikirim ke Omar juga buat halaman toko?',
  launchDay: {
    name: 'Hari peluncuran',
    messages: [
      { from: 'omar', text: 'Banner barunya aku pasang di toko hari Senin jam 07.00.' },
      { from: 'sara', text: 'Mantap. File final Mina ada di proyek.' },
      { from: 'tom', text: 'Ops sudah siap menerima pesanan 📦' },
    ],
  },

  pressRelease: {
    title: 'Siaran pers, draf pertama',
    ask: 'Pakai skill siaran pers kita untuk peluncuran Yuzu Jahe',
    answer: [
      'Ini draf pertamanya, mengikuti skill tim **Draft siaran pers**.',
      '',
      '**Steepling meluncurkan Yuzu Jahe, cold brew edisi musim dingin**',
      '',
      '*Yuzu yang segar dan jahe yang hangat, siap diminum setelah direndam semalaman di air dingin.*',
      '',
      'Steepling, perusahaan teh cold brew, meluncurkan blend Yuzu Jahe edisi musim dingin pada [tanggal rilis]. Celupkan satu kantong ke sebotol air dingin, dan dalam beberapa jam sudah siap diminum.',
      '',
      '"[kutipan]" ujar Daniel Okoye, CEO Steepling.',
      '',
      'Yuzu Jahe dijual US$11,90 isi 10 kantong di toko online Steepling dan kafe mitra, diskon 20% selama dua minggu pertama.',
      '',
      '**Tentang Steepling**: Steepling membuat kantong teh cold brew. 10 orang, berjualan online serta ke kafe dan kantor.',
      '',
      '**Kontak**: [nama, email]',
      '',
      'Perlu dicek: kutipan CEO dan tanggal rilis.',
    ].join('\n'),
  },

  gmail: {
    welcome: {
      subject: 'Selamat datang di Steepling!',
      body: 'Hai Mina,\n\nSelamat bergabung! Semua akunmu sudah siap. Proyek peluncuran berisi semua yang kamu perlukan untuk hari Senin, dan sampai ketemu jam 10 buat ngopi.\n\nSara',
    },
    specs: {
      subject: 'Spesifikasi banner untuk peluncuran Yuzu Jahe',
      body: 'Hai Leo,\n\nUntuk peluncuran Yuzu Jahe kita akan tayang 1200×628 di web dan 1080×1080 di Instagram. Kirim file finalnya paling lambat Jumat, nanti kami jadwalkan mulai hari Senin.\n\nSalam,\nChris\nFieldnote Studio',
    },
    replyBody: 'Hai Mina,\n\nSelamat bergabung di tim! {reply}\n\nChris\nFieldnote Studio',
    forwardNote: 'FYI, spesifikasi peluncuran dari Chris. Sekarang dia kontakmu.',
    forwarded: '---------- Pesan terusan ----------',
    forwardPrefix: 'Fwd: ',
    replyPrefix: 'Re: ',
  },

  drive: [
    { id: 'media-plan', name: 'Rencana media Fieldnote, peluncuran Yuzu Jahe', mimeType: 'application/vnd.google-apps.spreadsheet', folder: 'Fieldnote', minutesAgo: 9 * 1440, text: 'Kanal,Ukuran,Mulai,Durasi,Anggaran\nBanner web,1200×628,Peluncuran hari Senin,2 minggu,US$1.200\nInstagram,1080×1080,Peluncuran hari Senin,2 minggu,US$800\nInstagram story,1080×1920,Peluncuran hari Senin,1 minggu,US$400\n' },
    { id: 'photo-ideas', name: 'Ide foto peluncuran', mimeType: 'application/vnd.google-apps.document', folder: '', minutesAgo: 4 * 1440, text: 'Ide foto peluncuran\n\n- Jendela berembun, cahaya pagi\n- Pouch hijau di samping gelas es\n- Tanpa teks di dalam foto\n' },
  ],

  skillTitles: {
    'brand-guide': 'Panduan brand',
    'social-posts': 'Postingan media sosial',
    'press-release': 'Draft siaran pers',
    'competitor-roundup': 'Rangkuman kompetitor',
    handover: 'Bantuan serah terima',
    'review-digest': 'Rangkuman ulasan pelanggan',
  },

  suggestions: [
    { label: 'Buat draf postingan minggu depan', prompt: 'Tuliskan draf untuk dua slot kosong di kalender media sosial minggu depan' },
    { label: 'Rangkum ulasan pelanggan', prompt: 'Rangkum ulasan pelanggan terbaru' },
    { label: 'Chris sudah balas?', prompt: 'Apakah Chris sudah membalas emailku? Cek Gmail-ku' },
  ],
}
