// Every word of the demo story in Bahasa Indonesia (from strings/en.ts, not word for word). Register: team chat is a
// friendly Jakarta startup on Slack (casual-polite, "kamu", first names, the English work words people really use:
// banner, deadline, Marketing, Sales); Trina's answers and the guide lines use "Anda", like the app (web/src/i18n/id.ts);
// the formal email is proper formal business Indonesian. The product is "Yuzu Jahe" everywhere.
// Pictures and team files are the `.id.` files in ../assets, banner words in ../source/banners/copy.id.json.
//
// Plain strings only. `{project}` in a text becomes a link to the campaign project; {time}, {subject}, {reply} are
// filled in by the story (../story.ts) or the engine.
import type { Strings } from './en'

export const id: Strings = {
  company: 'Steepling',

  people: {
    mina: { name: 'Mina Lee', title: 'Marketing · hari pertama' },
    sara: { name: 'Sara Jensen', title: 'Marketing Lead' },
    daniel: { name: 'Daniel Okoye', title: 'CEO' },
    leo: { name: 'Leo Santos', title: 'Marketing (pindah ke Sales)' },
    tom: { name: 'Tom Becker', title: 'Operations Lead' },
    aiko: { name: 'Aiko Tanaka', title: 'Sales' },
    omar: { name: 'Omar Haddad', title: 'Toko online' },
    chris: { name: 'Chris Walker', title: 'Account Director', org: 'Fieldnote' },
  },
  marketingGroup: 'Marketing',
  project: { name: 'Kampanye peluncuran Yuzu Jahe', description: 'Peluncuran Yuzu Jahe edisi musim dingin, hari Senin' },

  brandSkill: 'brand-guide',

  paths: {
    companyIntro: 'shared/Profil perusahaan.md',
    brief: 'Brief peluncuran Yuzu Jahe.md',
    leoBanner: 'banner-peluncuran-leo-v1.png',
    banner: 'banner-peluncuran-baru.jpg',
    square: 'instagram-square.jpg',
    story: 'instagram-story.jpg',
    captions: 'caption.md',
    photo: 'higgsfield-foto-yuzu-jahe.jpg',
  },

  steps: {
    read: 'Baca',
    useSkill: 'Pakai skill',
    save: 'Simpan',
    makeBanner: 'Buat banner',
    makeSquare: 'Buat Instagram square',
    makeStory: 'Buat Instagram story',
    writeCaptions: 'Tulis caption',
    higgsfieldHero: 'Buat foto · pouch dan Yuzu Jahe dingin di dekat jendela berembun, cahaya pagi, 16:9',
    higgsfieldCrops: 'Buat foto · adegan yang sama, 1:1 dan 9:16',
    gmailSearch: 'Cari email "Chris"',
    gmailSend: 'Kirim email',
  },

  home: {
    title: 'Selamat bergabung, Mina! Selamat menjalani hari pertama.',
    subtitle: 'Sara mengundang Anda · 7 orang ada di sini',
  },

  rooms: {
    everyone: [
      { from: 'daniel', text: 'Hari ini Mina Lee gabung di tim Marketing. Yuk sapa dulu! 🎉' },
      { from: 'tom', text: 'Halo Mina, selamat bergabung! Soal order atau pengiriman, langsung colek Ops aja ya.' },
      { from: 'aiko', text: 'Halo Mina ☺️ ngopi bareng minggu ini yuk?' },
      { from: 'omar', text: 'Senang ada kamu, Mina! Kabari aku ya kalau ada banner yang perlu dipasang di toko.' },
    ],
    marketing: [
      { from: 'leo', text: 'Draft pertama banner peluncuran udah aku taruh di proyek. Kasih masukan yang jujur ya 😅' },
      { from: 'sara', text: 'Makasih Leo, nanti aku cek.' },
    ],
  },

  leoChat: {
    title: 'Banner peluncuran, draft pertama',
    ask: 'Buatkan banner peluncuran blend Yuzu Jahe. Diskon 20% selama dua minggu pertama',
    answer: 'Ini draft pertama banner-nya.',
  },

  answers: {
    company: {
      prompt: 'Perusahaan kita bergerak di bidang apa?',
      text: [
        '**Steepling** membuat kantong teh cold brew. Celupkan satu ke air dingin, selesai. Timnya 12 orang, jualan lewat toko online dan ke kafe.',
        '',
        '**Tugas Anda**: banner peluncuran dan media sosial, di tim Marketing yang dipimpin Sara.',
        '',
        '**Minggu ini**: Yuzu Jahe meluncur hari **Senin**. Banner peluncuran adalah pekerjaan terbesar yang belum selesai.',
        '',
        '**Skill tim**: tim Anda berbagi skill siap pakai, seperti *Panduan brand* dan *3 pilihan postingan media sosial*. Aku yang memakainya untuk Anda.',
      ].join('\n'),
      personLine: '{name}, {title}: {text}',
      peopleTitle: 'Orang yang perlu Anda kenal',
      people: {
        sara: 'tanyakan apa saja kepadanya.',
        leo: 'membuat banner pertama dan menyerahkannya kepada Anda.',
        daniel: 'memberi lampu hijau untuk peluncuran.',
      },
    },
    banner: {
      prompt: 'Ikuti panduan brand kita dan buat latar baru dengan Higgsfield',
      text: [
        'Sudah aku buat dengan Higgsfield: pouch hijau kita dan Yuzu Jahe dingin di dekat jendela berembun. Square dan story diambil dari adegan yang sama, jadi pouch-nya terlihat sama di mana-mana.',
        '',
        'Sesuai Panduan brand: judul pakai Fraunces, sisanya Pretendard, kuning yuzu hanya di badge 20%.',
        '',
        'Caption:',
      ].join('\n'),
      after: 'Draft Leo tidak aku ubah.',
    },
    captions: [
      'Baru, edisi musim dingin: Yuzu Jahe 🍋 Celupkan satu kantong ke air dingin sebelum tidur, paginya tinggal nikmati yang segar. Diskon 20% selama dua minggu pertama.',
      'yuzu + jahe. udah. gitu doang postingannya. (oke deh, minggu ini juga lagi diskon 20%)',
      'Diam-diam tim kami sudah minum ini sejak Agustus. Mulai Senin, giliran kamu.',
    ],
    captionsTitle: 'Caption: peluncuran Yuzu Jahe',
    deliverables: {
      banner: 'Banner web · 1200×628',
      square: 'Instagram square · 1080×1080',
      story: 'Instagram story · 1080×1920',
      captions: '3 caption',
      photo: 'Foto Higgsfield',
    },
    compare: { before: 'Sebelum: draft Leo', after: 'Sesudah' },
    otherSizes: 'Tampilan sama, semua ukuran:',
    sendTo: 'Kirim ke #Marketing',
    mail: {
      prompt: 'Kirim banner-nya ke Chris lewat email',
      intro: 'Ini draft-nya. Alamat Chris aku temukan di email tim sebelumnya.',
    },
  },

  mail: {
    to: 'Chris Walker (chris.walker@fieldnote.example)',
    labels: { to: 'Kepada', subject: 'Subjek', attachments: 'Lampiran' },
    plain: {
      subject: 'Banner final untuk peluncuran hari Senin',
      body: [
        'Hai Chris,',
        '',
        'Aku Mina, baru gabung di tim Marketing Steepling. Mulai sekarang, urusan banner lewat aku ya.',
        '',
        'Terlampir banner peluncuran final (1200×628) dan versi Instagram square. Daniel sudah approve. Bisa mulai tayang hari Senin?',
        '',
        'Makasih!',
        'Mina',
      ],
    },
    formal: {
      subject: 'Kampanye peluncuran Steepling: file final banner',
      body: [
        'Yth. Bapak Chris Walker,',
        '',
        'Semoga Bapak dalam keadaan baik. Perkenalkan, saya Mina Lee, anggota baru tim Marketing Steepling.',
        '',
        'Bersama email ini saya lampirkan banner final kampanye peluncuran (1200×628) beserta versi Instagram square. Keduanya telah disetujui oleh CEO kami. Mohon kiranya banner tersebut dapat mulai ditayangkan pada hari Senin, hari peluncuran kami.',
        '',
        'Atas perhatian dan kerja samanya, saya ucapkan terima kasih. Saya menantikan kerja sama kita ke depannya.',
        '',
        'Hormat saya,',
        'Mina Lee',
        'Marketing, Steepling',
      ],
    },
    confirm: 'Kirim email ini lewat Gmail?',
    send: 'Kirim',
    makeFormal: 'Buat lebih formal',
    sendShort: 'Kirim versi yang pendek',
    formalIntro: 'Versi yang lebih formal:',
    sent: 'Terkirim ke Chris: "{subject}", dengan banner dan square terlampir.',
  },

  events: {
    leadDm: 'Mina, banner Leo buat peluncuran Senin masih perlu dipoles nih. Katanya kamu jago desain, bisa bantu lihat? Semua bahannya ada di proyek.\n\n{project}',
    leadDmToast: 'Ada waktu sebentar? 🙏',
    ceoShip: '🔥 Ini dia. Langsung jalan.',
    leoHow: 'eh bentar, kok bisa secepat ini 😂',
    leadGmail: 'Mina, Gmail udah terhubung. Minta Trina kirim ke Chris di Fieldnote, agensi kita.',
    chrisReply: 'Keren banget, Senin langsung kami tayangkan.',
    chrisRelayed: 'Chris barusan balas email kamu: "{reply}" 🎉 Hari pertama yang mantap, Mina.',
    ceoShoutout: 'Shoutout buat @Mina Lee: baru hari pertama, kampanye peluncuran Senin sudah beres 🎉',
    saraWelcome: 'Selamat datang di tim, Mina 💛',
  },

  guide: {
    ask: { text: 'Tanyakan tentang perusahaan kepada Trina →', away: 'Pertanyaan pertama Anda ada di Beranda →' },
    dm: { text: 'Sara mengirimi Anda pesan →', away: 'Sara menunggu di DM Anda →' },
    project: { text: 'Buka proyek di pesan Sara →', away: 'Sara menunggu di DM Anda →' },
    banner: { text: 'Minta Trina membuat ulang dengan Higgsfield →', away: 'Banner Leo menunggu di proyek →' },
    share: { text: 'Kirim ke #Marketing →', away: 'Banner baru Anda siap dibagikan →' },
    room: { text: 'Buka #Marketing: tim sedang bereaksi →', away: 'Buka #Marketing: tim sedang bereaksi →' },
    mail: { text: 'Minta ✦ Trina mengirim email ke Chris →', away: 'Chris masih menunggu banner-nya →' },
    everyone: { text: 'Lihat postingan Daniel di #Semua →', away: 'Lihat postingan Daniel di #Semua →' },
  },

  fallback: { text: 'Demo ini mengikuti pertanyaan yang disarankan. Coba yang ini:', question: 'Langkah berikutnya' },

  end: {
    title: 'Hari pertama Mina: kampanye peluncuran selesai dalam {time}',
    body: 'Dari "perusahaan kita ngapain sih?" sampai banner peluncuran yang disetujui CEO dan ditayangkan agensi. Di hari pertama.',
    stats: {
      time: 'Waktu',
      filesRead: 'File dibaca',
      deliverables: 'Hasil kerja',
      approvals: 'Persetujuan CEO',
      emails: 'Email terkirim',
    },
    usually: 'biasanya ~2 hari',
    signup: 'Lihat paket',
    explore: 'Lihat-lihat dulu',
    tryLive: 'Sekarang coba sendiri',
    liveBusy: 'Demo langsung sedang penuh saat ini',
    liveRetry: 'Coba lagi',
    popupTitle: 'Itulah hari pertama Mina 🎉',
    popupLine: 'Kampanye peluncuran selesai dalam {time}. Biasanya sekitar 2 hari.',
    recap: ['Membaca 2 file tim', 'Memakai skill tim Panduan brand', 'Membuat 4 aset dengan Higgsfield', 'Disetujui CEO', 'Email ke agensi'],
  },
}
