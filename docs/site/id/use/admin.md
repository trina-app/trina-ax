---
title: Admin
description: Apa saja yang dikelola owner dan admin, dan di mana setiap pengaturan berada.
---

**Admin** untuk owner dan admin. Setiap halaman di dalamnya berlaku untuk seluruh tim: judul menunya adalah nama dan
logo tim Anda ("Admin Acme"), dan setiap halaman menampilkan "Berlaku untuk semua orang di Acme" di atas judulnya.
Pengaturan Anda sendiri tetap di **Pengaturan**, dengan nama halaman yang sama: Admin › Aplikasi terhubung berisi
koneksi tim, koneksi Anda sendiri ada di **Pengaturan › Konektor**.

Untuk membuka Admin di komputer:

1. Pilih logo tim Anda, di bagian atas bilah kiri. Menu tim terbuka: alamat tim, **Undang orang**, **Admin**, dan
   **Ganti tim**. (Anggota hanya melihat alamat dan **Ganti tim**.)
2. Pilih **Admin**. Admin terbuka di **Beranda**, yang mencantumkan apa yang perlu diperhatikan lebih dulu.

⌘K (Ctrl+K di Windows) dengan "Admin" juga menemukannya. Di ponsel, buka tab **Saya**, lalu **Admin**.

Untuk owner, Beranda juga mencantumkan langkah penyiapan awal yang belum dikerjakan: cek koneksi AI, atur izin
folder, undang anggota tim, siapkan skill tim, buat backup pertama. Langkah yang sudah selesai hilang dari daftar.

![Menu tim di bawah logo tim: alamat tim, Invite people, dan Admin](../../images/admin/team-menu.webp "Admin, di menu tim")

![Beranda Admin: Needs attention di bagian atas, lalu satu kartu per area, dengan menu Admin di sebelah kiri](../../images/admin/home.webp "Beranda Admin")

## Menu Admin

| Grup | Halaman |
|---|---|
| **Orang** | Anggota & undangan, Grup, Izin folder |
| **Koneksi** | Penyedia AI, Aplikasi terhubung (aplikasi Google, [Slack](slack.md), dan layanan lain seperti Notion), Trina AX MCP, Plugin |
| **Aktivitas** | Pemakaian, Log aktivitas |
| **Tim** | Pengaturan tim, Sistem |

**Anggota & undangan** juga mencantumkan tamu: orang dari luar tim yang berada di paling banyak satu saluran privat atau obrolan grup, dan satu proyek. [Baca tentang tamu](guests.md).

:::note
Versi sebelumnya menempatkan akun AI di halaman tersendiri, **AI connections**, di samping **AI engines**. Sekarang
keduanya menjadi satu halaman **Penyedia AI** (sempat bernama **AI accounts**), dan alamat lamanya membuka halaman ini. Pengaturan AI tim (bawaan, siapa yang memilih mesin, akun milik
anggota, batas pemakaian) ada di **Pengaturan tim**. **Slack** dulu juga punya item menu sendiri; sekarang Slack menjadi
satu baris di **Aplikasi terhubung**, dan alamat lamanya membukanya di sana.
:::

Di perusahaan yang memakai Google Workspace, aplikasi Google bisa masuk dengan aplikasi Google milik perusahaan Anda sendiri, cukup diatur sekali untuk kelimanya: [Memakai aplikasi Google milik perusahaan Anda](google-own-app.md).

## Minggu pertama Anda

:::steps
#### Atur izin
Tetapkan folder ke grup dan periksa akses dengan dua akun uji. [Baca tentang izin](files-and-permissions.md).

#### Hubungkan AI
Di **Penyedia AI**, owner atau admin memilih **Tambah akun** di baris Claude Code atau Codex dan menghubungkan akun
Claude atau OpenAI yang berwenang. Setiap baris menunjukkan apakah mesin itu sudah siap.

![Admin › Penyedia AI: Claude Code, Codex, dan mesin API, masing-masing dengan logo, status, dan sakelar nyala/mati](../../images/admin/engines.webp "Penyedia AI")

#### Undang tim
Mulailah dengan kelompok uji coba kecil, lalu pastikan peran dan akses folder sudah benar.

1. Pilih logo tim Anda, lalu **Undang orang**.
2. Biarkan **Anggota tim** terpilih (**Tamu** untuk orang dari luar tim) dan pilih **Buat tautan undangan**.
3. Pilih **Salin pesan** dan tempelkan ke Slack, Teams, atau e-mail. Pesan itu diakhiri dengan tautannya. Orang yang
   membukanya membuat akun dan langsung masuk ke tim.

![Dialog Invite people: Team member dan Guest di bagian atas, satu baris yang meminta mengirim pesan berisi tautan tim, dan Make invite link](../../images/admin/invite.webp "Undang orang")

**Anggota & undangan** juga mencantumkan [tamu](#tamu) tim.
Di bawah daftar, **Link undangan** hanya menampilkan tautan yang masih berlaku: tautan undangan tim dan tautan undangan
yang belum dipakai siapa pun. Tautan yang sudah dipakai atau kedaluwarsa, atau tautan tamu yang saluran privat, obrolan grup, atau proyeknya sudah tidak ada, hilang dari daftar; siapa yang bergabung tercatat di daftar anggota dan di [Log aktivitas](#log-aktivitas).

#### Tambahkan skill pertama
Salin skill awal dan periksa hasilnya terhadap sumbernya. [Baca tentang skill](team-skills.md).

#### Buat backup pertama
Buat backup, lalu latih pemulihan bersama tim IT. [Baca tentang backup](../../operate/backups.md) (bahasa Inggris).
:::

## Yang tidak bisa dilakukan admin

- Membaca chat orang lain. Log aktivitas menunjukkan file mana yang dibaca AI, bukan isi percakapannya.
- Melihat folder pribadi atau skill pribadi di `users/<id>/`.
- Memakai koneksi MCP tim, kecuali sebuah aturan menyebut nama mereka.

:::warning
Orang yang mengoperasikan server, sistem operasinya, atau penyimpanannya bisa membaca file dan chat yang tersimpan. Pada paket yang di-hosting, ini termasuk operator Trina.
:::

## Penyedia AI

**Admin › Penyedia AI**, yang pertama di grup Koneksi, memiliki satu baris per mesin (Claude Code, Codex, API) dengan
logo, status, dan sakelar nyala/mati. Jika ada yang salah, satu baris singkat di bawah namanya menjelaskan cara
memperbaikinya. Di bawah Claude Code dan Codex ada akun-akun yang dipakai tim untuk menjawab, sesuai urutan dicobanya,
masing-masing dengan logo, paket, dan statusnya, serta **Tambah akun** untuk owner dan admin. Akun teratas yang berfungsi
dipakai lebih dulu; jika satu akun ditolak atau mencapai batasnya, akun berikutnya yang dipakai. Untuk mengubah urutan,
owner dan admin menyeret akun lewat pegangannya (⠿) di kiri, di komputer maupun ponsel. Dengan keyboard: Tab ke
pegangan, Spasi untuk mengambil akun, tombol panah untuk memindahkan, Spasi untuk meletakkan, Escape untuk membatalkan.

Klik nama mesin untuk membuka detailnya: cara masuknya, setiap model, kapan terakhir diperiksa, **Cek lagi**, dan untuk
owner dan admin, formulir mesin API. Klik nama akun untuk melihat siapa yang memakainya, pemakaian bulan ini, dan kapan
terakhir dipakai. Menu **⋯** sebuah akun berisi Cek lagi, Naikkan / turunkan, ganti nama, ganti, matikan, dan hapus.

![Baris Claude Code terbuka: akun-akunnya dengan Add account, cara masuknya, versi dan modelnya, kapan terakhir diperiksa, dan Check again](../../images/admin/engines-open.webp "Mesin yang dibuka")

## Tamu

**Admin › Anggota & undangan** diakhiri dengan **Tamu**: orang dari luar tim, masing-masing di paling banyak satu saluran privat atau obrolan grup, dan satu
proyek, yang tidak memakai kursi. Setiap baris menunjukkan di mana tamu itu berada dan AI apa yang dimilikinya. Menu
**⋯**-nya berisi **Ubah AI** (tanpa AI, masuk dengan akun sendiri, atau akun AI tim dengan batas bulanan), **Jadikan
anggota tim**, dan **Keluarkan tamu**. Anggota mengundang tamu sendiri dari saluran privat, obrolan grup, atau proyek
([Tamu](chats-and-projects.md#tamu)). Owner dan admin juga bisa memilih **Undang ke tim** › **Tamu** di sini lalu
memilih satu saluran privat, obrolan grup, atau proyek ([Tamu: Dari Admin](guests.md#dari-admin)). Tim yang tidak punya tamu
tidak memiliki bagian **Tamu**; pilih **Tamu** di daftar peran untuk memeriksanya.

![Admin › Anggota & undangan › Tamu di ponsel: Morgan Reyes, di obrolan grup Launch email, dengan No AI](../../images/admin/guests.webp "Tamu")

## Aplikasi terhubung

**Admin › Aplikasi terhubung** mencantumkan koneksi tim di bawah **Terhubung**, dan layanan yang bisa Anda tambahkan di
bawah **Jelajahi**. Setiap baris menunjukkan status aplikasinya (misalnya **Aktif**, **Menghubungkan**, atau **Perlu
perhatian**); seluruh baris membuka halaman aplikasi, yang menunjukkan status yang sama. Menghubungkan aplikasi yang
membuka jendela browser (aplikasi Google, proses masuk sebuah layanan, **Tambahkan ke Slack**) selalu bisa ditinggalkan:
**Coba lagi** dan **Batal** tersedia selama menunggu, dan penantian berakhir sendiri setelah lima menit jika jendelanya
ditutup. Slack punya panduan sendiri: [Slack](slack.md).

## Pengaturan AI tim

**Admin › Pengaturan tim** diakhiri dengan pengaturan AI tim:

| Grup | Isinya |
|---|---|
| **Default AI** | Mesin dan model bawaan, serta berapa banyak jawaban yang berjalan bersamaan. |
| **Siapa memilih mesin** | Apakah anggota boleh memilih mesin lain, dan beralih ke Codex saat batas Claude tercapai. |
| **Akun milik anggota** | Apakah anggota boleh menambahkan akunnya sendiri, apakah langganan boleh dibagikan, dan akun yang mereka tambahkan. |
| **Batas pemakaian** | Batas token atau dolar per hari atau per bulan, untuk satu orang, satu grup, atau tim. |

Batal dan Simpan hanya muncul di sebuah grup setelah Anda mengubah sesuatu di dalamnya; setiap grup disimpan sendiri-sendiri.

:::note
Mulai versi 0.4.0. Di versi 0.3.0 dan sebelumnya, semua ini beserta mesinnya ada di satu halaman **AI engines**.
:::

![Admin › Pengaturan tim: nama, bahasa, dan logo tim, waktu dan pembaruan, serta berapa lama log aktivitas disimpan](../../images/admin/ai-settings.webp "Pengaturan tim")

## Log aktivitas

**Admin › Log aktivitas** mencantumkan proses masuk, tindakan admin, perubahan file, dan pemakaian alat AI, dikelompokkan per hari. Filter tetap berada di atas saat Anda menggulir. Log ini tidak pernah menampilkan isi chat.

![Admin › Log aktivitas: filter untuk jenis, orang, dan waktu, lalu satu baris per peristiwa, dikelompokkan per hari](../../images/admin/activity-log.webp "Log aktivitas")

## Sistem

**Admin › Sistem** menampilkan penyimpanan tim, versi dan pembaruan, kesehatan server, cara tim menjangkau server, folder yang terhubung, backup, dan ekspor, sebagai bagian-bagian sederhana. Penyimpanan menampilkan file yang dikirim orang di percakapan pada barisnya sendiri, **Berkas di percakapan**: satu angka untuk seluruh tim, tidak pernah per orang atau per percakapan. File dari chat dan percakapan yang dihapus dihitung di **Berkas tim** ("Berkas tim mencakup 120 MB dari chat dan percakapan yang dihapus, yang dibuang setelah 30 hari"): file itu disimpan 30 hari agar bisa dikembalikan. Saat disk 80% penuh, dan lagi pada 95%, owner dan admin menemukan pemberitahuan di **Aktivitas** (paling banyak sekali sehari untuk masing-masing) yang membuka kartu ini. Jika berkas yang dikirim di percakapan tidak muat, anggota atau tamu membaca bahwa ruangnya tidak cukup dan diminta menghubungi admin, dengan **Lihat berkas yang Anda kirim**; owner dan admin mendapat **Lihat apa yang memakai ruang**. Di bawah baris-barisnya, **Minta orang merapikan** mengirim pemberitahuan kepada orang yang berkasnya di percakapan paling banyak memakai ruang, agar menghapus yang tidak lagi diperlukan (sekali sehari; Anda tidak melihat siapa). Kesehatan mencantumkan apa yang perlu diperhatikan lebih dulu, seperti mesin yang belum ada, pemeriksaan yang gagal, atau pembaruan otomatis yang dimatikan; pemeriksaan yang lolos dilipat menjadi satu baris dengan **Lihat detail**. Admin yang bukan owner melihat paket, penyimpanan, dan, di Mac kantor, pembaruan otomatis. Agar disk kecil tidak penuh, backup tidak menyertakan folder yang dibangun ulang secara otomatis, dan cache yang tidak dipakai siapa pun selama 14 hari dibersihkan. File Anda sendiri tidak pernah disentuh. Jika pembaruan menunggu tugas yang sedang berjalan selesai, Sistem memberitahukannya; tersedia **Tunggu, lalu perbarui** atau **Tetap perbarui sekarang**.

**Mulai ulang…** di bawah Kesehatan memulai ulang **Hanya AI** (saat jawaban tidak muncul atau AI macet; sekitar 10 detik) atau **Seluruh Trina AX** (saat layar macet atau lambat; semua orang terputus sekitar 30 detik), setelah kata sandi Anda. **Mulai ulang setelah jawaban selesai** menunggu jawaban yang berjalan paling lama 10 menit dan hanya menunjukkan jumlahnya, tidak pernah milik siapa; selama menunggu, barisnya menawarkan **Mulai ulang sekarang** dan **Jangan mulai ulang**. Hanya pemilik yang juga bisa memilih **Mulai ulang sekarang juga**; admin yang bukan pemilik hanya melihat baris ini di bawah Kesehatan. Mulai ulang tidak bisa dilakukan saat pembaruan, pencadangan, atau pemulihan yang sudah disiapkan, dan paling banyak 5 kali per jam. Setiap mulai ulang tercatat di Log aktivitas. Jika server beberapa kali berhenti menjawab dan tidak lagi dimulai ulang sendiri, baris ini memberi tahu.

![Admin di ponsel: satu daftar area admin, dengan lima tab di bagian bawah](../../images/admin/admin-phone.webp "Admin di ponsel")

Berkas yang dikirim di percakapan yang tidak bisa dibuka siapa pun lagi (semua orang keluar dari obrolan grup, atau grupnya dihapus) dihapus dari disk 30 hari setelah percakapan itu ditutup. Pesannya tetap ada, tetapi tidak ada yang bisa membacanya.
