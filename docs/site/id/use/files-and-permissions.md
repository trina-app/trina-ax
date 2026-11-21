---
title: File dan izin
description: Folder tim, pembagian folder, dan cara server memeriksa setiap file yang dibuka AI atas nama orang yang bertanya.
---

Pengetahuan perusahaan berada di satu folder tim di server. Pembagian setiap folder menentukan siapa melihat apa. AI tidak pernah melihat lebih dari orang yang bertanya.

## Folder tim

| Folder | Siapa yang melihatnya | Gunakan untuk |
|---|---|---|
| `shared/` | Sesuai pembagiannya, biasanya semua orang | Dokumen untuk seluruh perusahaan |
| `groups/<group>/` | Grup itu, ditambah siapa pun yang diberi akses lewat pembagian | Dokumen tim, misalnya Penjualan atau Keuangan; skill milik grup ada di `skills/` di dalamnya |
| `projects/<project>/` | Hanya anggota proyek | Pekerjaan dengan folder dan instruksinya sendiri |
| `skills/` | Semua orang membaca; pengelola skill menulis | Skill tim dan aturan tim |
| `users/<id>/` | Hanya orang itu | File pribadi dan skill pribadi |

## Cara akses ditentukan

Satu fungsi izin di server menentukan setiap akses. Sistem operasi mencegah AI melewatinya.

- File yang tidak bisa Anda buka **tidak terlihat**, bukan "ditolak". File, jawaban AI, pencarian, pratinjau, riwayat versi, sampah, dan pembaruan langsung semuanya mengikuti aturan yang sama.
- Akses **bertambah**, seperti di Google Drive: seseorang mendapat apa yang diberikan sebuah folder dan apa yang diberikan setiap folder di atasnya. Akses yang paling luas yang berlaku. Hanya **Batasi akses** pada sebuah folder yang menghentikan akses dari atas.
- Folder proyek hanya terbuka untuk anggota proyek itu.
- Perubahan berlaku **seketika**. AI membaca ulang izin pada setiap pemanggilan alat.
- Mencabut akses tidak menghapus jawaban sebelumnya yang mengutip sebuah file.

## Membagikan folder

Owner dan admin membagikan folder seperti di Google Drive: **File › ⋯ pada folder › Bagikan**, atau **Admin › Izin folder › Bagikan**. Keduanya membuka dialog yang sama.

:::steps
#### Tambahkan orang dan grup
Ketik nama. Setiap orang atau grup mendapat **Pelihat** atau **Editor**. **Hapus akses** ada di menu yang sama.

#### Periksa Akses umum
**Dibatasi**: hanya orang yang tercantum yang bisa membukanya. Atau seluruh tim, sebagai **Pelihat** atau **Editor**. Folder yang tidak punya pengaturan sendiri menampilkan apa yang didapatnya dari folder di atasnya, dengan **Ubah di sana**.

#### Periksa sebelum menyimpan
Dialog menyebutkan siapa yang akan mendapat atau kehilangan akses. Tidak ada yang berubah sampai Anda menyimpan. Memberi akses lebih luas akan ditanyakan dulu, begitu juga pembatasan yang menutup akses orang yang diizinkan oleh folder di atasnya.
:::

![Bagikan "Marketing": Add people and groups, People with access dengan Sam Ortiz sebagai Viewer, Dana Brooks sebagai Editor dari "budget" dengan Change there, dan Owner and admins sebagai Manager, lalu General access Restricted dan Settings › Limit access](../../images/files/share-dialog.webp "Dialog Bagikan pada folder")

Akses bertambah, seperti di Google Drive: apa yang diberikan sebuah folder ditambahkan di atas apa yang diberikan folder-folder di atasnya. Peran yang lebih rendah dari itu tidak bisa dipilih; barisnya menyebutkan dari mana peran yang lebih tinggi berasal ("Editor dari "Seluruh perusahaan"").

Untuk memberi sebuah folder akses lebih sedikit daripada folder di atasnya, nyalakan **Setelan › Batasi akses**. Setelah itu hanya orang dan grup yang ditambahkan di sana yang bisa membukanya. **Akses dihapus** mencantumkan orang yang bisa membuka folder di atasnya tetapi tidak folder ini; **Tambahkan** mengembalikan salah satunya sebagai Pelihat. Mematikan pembatasan lagi menaikkan setiap peran yang lebih rendah dari folder di atasnya ke tingkat itu.

Owner dan admin selalu bisa membuka folder tim, kecuali proyek yang tidak mereka ikuti. Mereka tampil sebagai satu baris **Pengelola**.

Pemilik dan admin juga bisa meminta Trina di chat: "beri grup Sales akses lihat ke Reports", "biarkan Jun mengedit Sales/Q4", "hapus grup Desain dari Reports". Satu orang atau satu grup dan satu folder setiap kali. Kartu bertanya dulu: kartu menyebut siapa yang mendapat atau kehilangan akses dan berapa orang yang bisa membuka folder sebelum dan sesudahnya. Jika ada berkas di dalamnya yang dibagikan satu per satu kepada orang yang kehilangan folder itu, kartu menanyakan apakah bagikan itu ikut dihapus. Kartu menawarkan **Selalu izinkan** untuk perubahan seperti ini; setelah Anda memilihnya, Trina mengubahnya tanpa bertanya dan berkas di dalamnya yang dibagikan satu per satu tetap dibagikan. Akses umum dan Batasi akses hanya diubah di dialog ini. Anggota yang meminta akan melihat **Minta ke admin**, yang mengirim pesan dari Anda kepada pemilik dan admin tim; folder yang tidak bisa Anda buka dijawab seolah-olah tidak ada.

:::note
Setelah pembaruan yang membuat akses bertambah, beberapa folder mencantumkan orangnya berdasarkan nama (ditandai **Ditambahkan saat folder berubah**), dan Izin folder menampilkan pemberitahuan satu kali yang menyebut nama mereka. Orang yang ditambahkan berdasarkan nama tetap punya akses jika nanti keluar dari grup. **Admin › Grup** dan halaman orang itu menyebutkannya sebelum menyimpan, dengan **Keluarkan sekarang**.
:::

**Admin › Izin folder › Folder** hanya mencantumkan folder yang dibagikan secara berbeda dari folder tempatnya berada, dengan nama yang sama seperti di File, dan **Akses dibatasi** pada folder yang menutup akses orang. **Bagikan** membuka dialog Bagikan folder itu. Folder proyek tampil sebagai satu baris: anggotanya diubah di proyek.

![Admin › Izin folder › Folder: folder yang dibagikan secara berbeda, masing-masing dengan siapa saja dan Share](../../images/files/folder-permissions.webp "Izin folder, folder")

**Yang bisa dibuka seseorang** menampilkan, untuk satu orang (dan dengan begitu AI-nya), setiap folder dengan Pelihat atau Editor beserta alasannya, dan folder yang tidak bisa ia buka.

:::warning
`skills/` berisi instruksi yang diikuti AI setiap anggota. Akses tulis di sana menjadikan seseorang pengelola skill. Sebelum AI menyimpan ke `skills/`, server meminta seseorang untuk mengonfirmasi. Hal yang sama berlaku untuk `groups/<group>/skills/` milik grup: AI setiap anggota grup itu mengikutinya, dan setiap anggota yang boleh menulis di folder grup bisa mengubahnya.
:::

![Yang bisa dibuka seseorang: setiap folder dengan Viewer atau Editor beserta alasannya, lalu yang tidak bisa ia buka](../../images/files/by-person.webp "Yang bisa dibuka seseorang")

## Membagikan file

Anda bisa membagikan file milik Anda kepada orang tertentu tanpa mengubah siapa yang bisa membuka foldernya: **File › ⋯ pada file › Bagikan**. Tambahkan orang atau grup, lalu tekan **Bagikan**. Mereka bisa melihat dan mengunduh file itu, tetapi tidak melihat isi folder lainnya. Setiap orang yang Anda tambahkan melihatnya di **Aktivitas**.

- **Semua orang di tim** adalah pilihan pertama di **Tambahkan orang atau grup**. Sebelum Anda menekan **Bagikan**, satu baris memberi tahu bahwa semua orang di tim akan bisa membuka file itu, termasuk yang bergabung nanti. Tamu tidak pernah bisa. Pilihan ini dihitung sebagai salah satu dari 50 orang dan grup yang bisa diberi akses ke satu file.
- Kalau Anda membagikan beberapa file sekaligus (misalnya di langkah terakhir **Cari file kerja di komputer ini**), setiap orang menerima satu pemberitahuan di **Aktivitas**, "Mina membagikan 5 file dengan Anda", yang membuka daftar file tersebut. Orang yang Anda tambahkan dengan nama juga mendapat notifikasi di ponsel.
- **Orang yang punya akses** menampilkan pemilik dan setiap orang atau grup dengan **Bisa melihat**. **✕** mencabut akses seseorang (Anda ditanya dulu). Pemilik file selalu bisa mencabut akses orang, juga saat tim mematikan berbagi oleh anggota.
- Orang yang aksesnya Anda cabut melihat "Mina berhenti membagikan file ini" saat membuka tautan file, dan bisa meminta akses lagi. Mereka tidak mendapat pemberitahuan apa pun.
- Anda juga bisa meminta Trina lewat chat: "bagikan penawaran ke Jun", atau "berhenti membagikan penawaran ke Jun". Sebuah kartu di bawah jawaban menjelaskan apa yang berubah: file dan lokasinya, siapa yang bisa melihatnya, dan satu tombol. Setelah berbagi, tombolnya **Kelola akses**, yang membuka dialog ini. Setelah berhenti berbagi, tombolnya **Urungkan**, dan kartu menyebut siapa yang masih bisa membuka file dan alasannya (misalnya lewat grup yang masih diberi akses, atau karena mereka bisa membuka foldernya). Trina bertanya dulu sebelum membagikan file, kecuali pesan Anda sudah menyebut file dan orangnya. Berhenti berbagi tidak perlu ditanyakan kalau pesan Anda menyebut orangnya. Kalau seseorang sudah bisa membuka file itu, kartu menyebutnya dan tidak ada yang berubah bagi mereka.
- Kalau Trina tidak bisa membagikan file, kartu menjelaskan alasannya dan memberi langkah berikutnya sebagai satu-satunya tombol: **Minta ke Mina** untuk file milik Mina (ia menerima permintaan di **Aktivitas** dan memutuskan), atau **Minta ke admin** kalau tim mematikan berbagi oleh anggota (owner dan admin tim menerima pesan dari Anda yang meminta untuk menyalakannya lagi).
- File tim juga bisa dibuka semua orang yang bisa membuka foldernya.
- **Salin tautan** memberi tautan khusus untuk file itu. Orang yang punya akses bisa membukanya; yang lain melihat **Anda perlu akses** dan bisa **Minta akses** dengan catatan. Permintaannya masuk ke pemilik di **Aktivitas** dengan tombol **Bagikan** dan **Tolak**. Halaman tautan tidak pernah menampilkan nama file kepada orang yang tidak bisa membukanya.
- Kalau Anda memindahkan file ke tempat yang bisa dibuka lebih sedikit orang, Anda diberi tahu berapa orang yang memegang file itu lewat tautannya.
- Tanyakan ke Trina **"siapa yang bisa membuka file ini?"** atau **"kenapa Jun tidak bisa membukanya?"**. Ia menjelaskan bagaimana tiap orang bisa masuk (dibagikan dengan nama, lewat grup, lewat folder). Untuk file milik Anda, nama-nama terlihat; untuk file milik orang lain, Anda melihat akses Anda sendiri dan siapa yang perlu ditanya.
- Setelah Trina memposting ke sebuah percakapan, ia memberi tahu kalau ada orang di sana yang tidak bisa membuka file dari postingan itu. **Izinkan melihat** membagikan file Anda persis kepada orang yang disebut di baris itu. Untuk file milik orang lain, tombol dengan nama pemiliknya (seperti **Minta ke Mina**) mengirim permintaan ke pemiliknya di **Aktivitas** ("Alice meminta Anda membagikan Quote.pdf ke Jun") dengan **Bagikan** dan **Tolak**. Untuk folder tim, anggota melihat **Minta ke admin**, yang mengirim pesan dari Anda ke owner dan admin tim.

Owner dan admin bisa membagikan file tim mana pun. Di **Admin › Pengaturan tim**, **Anggota bisa membagikan file dan folder milik mereka** mematikan pembagian untuk anggota (yang sudah dibagikan tetap berfungsi, dan pemiliknya masih bisa menghentikannya). Owner tim bisa **Hapus semua berbagi file** di sana sekaligus.

### Membagikan folder di File saya

Anda juga bisa membagikan folder di **File saya** dengan cara yang sama, seperti folder di Drive Saya Google Drive:
**File › ⋯ folder › Bagikan**. Orang dan grup yang Anda tambahkan bisa melihat semua isinya, termasuk file yang Anda
tambahkan nanti, dan tidak bisa mengubah apa pun. Mereka menemukannya di **File › Dibagikan ke saya** dan membukanya
seperti folder, satu tingkat setiap kali: nama, ukuran, tanggal, dan tiap file untuk dilihat atau diunduh. Mereka tidak
pernah melihat folder di atasnya.

- Dialog menyebutkan isi folder ("3 file, 1 folder"). **Semua orang di tim** punya barisnya sendiri: semua orang di tim,
  termasuk yang bergabung nanti, akan melihat semua isi folder dan apa pun yang ditambahkan. Tamu tidak pernah bisa.
- Di **File**, folder yang dibagikan bertanda **Dibagikan**, dan file di dalamnya bertanda **Dibagikan lewat Work** (di
  dialog Bagikan file itu, orang dari folder tampil "Lewat Work").
- **Hentikan berbagi** mengeluarkan semua orang sekaligus. Sebelumnya, dialog menyebutkan apa yang tetap dibagikan sendiri
  (file dan folder di dalamnya). Setelahnya, **Urungkan** mengembalikan orang-orangnya selama beberapa menit. Mengeluarkan
  orang dan menghentikan berbagi selalu bisa, juga saat tim Anda mematikan berbagi untuk anggota.
- Folder pribadi Anda sendiri dan tempat Trina menyimpan barang di sana (unduhan, gambar, skill, folder proyek, dan
  beberapa lainnya) tidak bisa dibagikan; dialog menyebutkan alasannya.
- Jika folder di server bukan lagi folder yang Anda bagikan (misalnya diganti di luar Trina), berbagi **dijeda**: tidak
  ada yang bisa membukanya, dan Anda menerima pemberitahuan. Buka dialog Bagikan dan tekan **Lanjutkan**.

Di **Admin › Pengaturan tim**, sakelarnya adalah **Anggota bisa membagikan file dan folder milik mereka**, dan **Hapus
semua berbagi file** menghitung file dan folder secara terpisah.

Anda juga bisa meminta Trina: "bagikan folder Work dengan Jun". Trina menampilkan kartu lebih dulu, berisi folder, lokasinya, dan isinya (**Selalu izinkan** untuk berbagi file tidak mencakup folder). Kartu menawarkan **Selalu izinkan** untuk berbagi folder; setelah Anda memilihnya, Trina membagikan folder Anda tanpa bertanya. Berhenti membagikan langsung dijalankan bila pesan Anda menyebut folder itu dengan jelas (namanya dalam tanda kutip seperti `"Work"`, atau lokasinya), dan kartunya punya **Urungkan**.

### File yang dibagikan kepada Anda

**File › Dibagikan ke saya** menampilkan file yang dibagikan orang lain kepada Anda, yang terbaru di atas, lengkap dengan siapa yang membagikan dan kapan. File yang sudah bisa Anda buka di foldernya hanya muncul di sini kalau seseorang menambahkan Anda dengan nama. Buka file dari sini untuk melihat atau mengunduhnya; **‹ Dibagikan ke saya** membawa Anda kembali ke daftar. Saat Anda membuka file, pemberitahuannya di **Aktivitas** ditandai sudah dibaca. File hilang dari daftar kalau akses Anda hilang (pemiliknya mencabutnya, memindahkannya ke sampah, atau sudah tidak bisa mengeditnya).

Trina juga bisa memakai file-file ini. Minta "ringkas file yang Mina bagikan ke saya" dan ia mencarinya di antara yang dibagikan kepada Anda, juga saat ada file di folder Anda sendiri dengan nama yang sama. Di halaman file yang dibagikan, **Tanya Trina** membuka chat baru dengan file itu sudah siap di kotak pesan. Trina bisa melihat file yang dibagikan, tidak bisa mengubahnya.

### "File ini", "thread itu"

Ketika Anda berkata "ringkas ini" atau "balas di thread itu" tanpa menyebut nama, Trina melihat apa yang sedang Anda buka di aplikasi: file, percakapan, thread, atau chat di layar Anda, dengan jendela tempat Anda menulis lebih dulu. Ini hanya dilakukan saat Anda menunjuk sesuatu tanpa menyebut namanya, dan ia bertanya kalau ada dua hal yang mungkin dimaksud. Apa pun yang dibagikan atau diposting untuk Anda dengan cara ini menampilkan kartu dulu, kecuali Anda memilih **Selalu izinkan** untuk jenis kartu itu. Tidak ada tentang layar Anda yang disimpan: jendela yang ditutup dilupakan, dan chat rahasia tidak pernah dilaporkan.

## Bekerja dengan file

![Layar File: folder tim dengan Company-wide, Groups, Projects, Team skills dan Personal](../../images/files/files.webp "Layar File")

![File di ponsel: Recent files, Team folders, Project folders, My files dan Trash](../../images/files/files-phone.webp "File di ponsel")

- **Unggah** file atau seluruh folder dari layar File.
- **Unduh**: di aplikasi desktop, file yang Anda unduh langsung masuk ke folder Unduhan di komputer Anda, dan pemberitahuannya menawarkan **Tampilkan di folder**. File dengan nama yang sama tidak ditimpa: file baru disimpan sebagai "nama (1)". Di browser, browser yang menentukan tempat unduhan disimpan.
- **Riwayat versi**: setiap perubahan menyimpan versi yang bisa Anda buka atau pulihkan.
- **Sampah**: **File › Sampah** mencantumkan apa yang bisa Anda pulihkan, berdasarkan nama dan tempat asalnya ("price-sheet.xlsx · Seluruh perusahaan › Sales"). File yang dihapus lebih dari sekali tampil sebagai satu baris dengan salinan-salinannya: **Pulihkan** mengembalikan yang terbaru, dan membuka baris itu memulihkan salinan lainnya. Jika daftar berisi hapusan orang lain, **Dihapus oleh saya** hanya menampilkan milik Anda. Item dihapus permanen setelah masa simpan tim (Admin › Pengaturan tim, 30 hari secara bawaan); setiap baris menyebutkan kapan.
- **Format**: AI membaca teks dari file PDF, Office, dan HWP/HWPX, serta melihat foto dan halaman hasil pindaian sebagai gambar (admin bisa mematikannya). Server Linux tidak menjalankan OCR.
- **Konfirmasi**: jika AI akan menulis konten terbatas ke tempat yang bisa dilihat lebih banyak orang, server bertanya dulu.

## HTML ke PDF

File HTML, seperti penawaran harga atau laporan yang ditulis AI, menjadi PDF yang tampilannya sama dengan halamannya: warna dan latar belakangnya, sel tabel yang digabung, ukuran halaman dan margin dari aturan `@page` milik halaman itu (A4 jika tidak disebutkan), dan pemisah halamannya.

- **Di pratinjau**: buka file `.html` lalu tekan **Simpan sebagai PDF** di header pratinjau. PDF disimpan di samping halaman dengan nama yang sama, dan pemberitahuannya menautkan ke PDF itu. PDF kedua dari halaman yang sama disimpan sebagai `name (2).pdf`, tidak pernah menimpa yang pertama. Di folder yang hanya bisa Anda baca, PDF diunduh sebagai gantinya. Di ponsel, aksinya ada di menu **⋯**.
- **Minta ke AI**: "Jadikan quote.html sebagai PDF". AI mencetak halaman itu sendiri; AI tidak menulis ulang isinya sebagai Markdown.
- **Yang dipakai PDF**: halaman itu serta gambar, stylesheet, dan font miliknya di folder tim, berdasarkan path relatif. Alamat web tidak pernah dimuat: gambar dari web tampil sebagai kotak abu-abu, sama seperti di pratinjau. Simpan gambar ke folder tim dan rujuk dengan path-nya. Skrip di halaman tidak dijalankan, jadi bagian yang seharusnya digambar oleh skrip tidak muncul; tulis bagian itu sebagai HTML biasa.
- **Batas**: sampai 200 halaman dan 50 MB, dan sekitar satu menit per halaman. Hanya beberapa PDF yang dibuat sekaligus di satu server; sisanya menunggu.
- **Di mana ini berfungsi**: server mencetak dengan Chromium headless di sandbox konverternya, tanpa jaringan. Server Linux memilikinya jika paket `chromium` dari Debian terpasang (dev environment memasangnya, begitu juga image server hosting yang dibuat dengan dev environment). Di server Linux, setiap pencetakan berjalan dengan batas memorinya sendiri, terpisah dari konversi lain, dan memerlukan memori server setidaknya 3 GB (dua pencetakan sekaligus mulai 6 GB). Server tanpa browser, atau dengan memori lebih kecil, tidak menampilkan aksi ini, dan AI menyebutkan bahwa ia tidak bisa mencetak HTML. Administrator bisa menentukan browsernya dengan `MYCEL_HTML_PDF_BROWSER` ([environment](../../reference/environment.md) (bahasa Inggris)).

Detail lengkap: [Keamanan dan izin](../../../security-and-permissions.md) (bahasa Inggris) dan [model izin](../../../PERMISSIONS.md) (bahasa Korea).
