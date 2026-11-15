---
title: Aplikasi Google
description: Hubungkan Google Drive, Gmail, Google Calendar, Docs, dan Sheets Anda agar AI bisa memakainya, serta apa yang disiapkan admin lebih dulu di server yang Anda kelola sendiri.
---

Google Drive, Gmail, Google Calendar, Google Docs, dan Google Sheets sudah tersedia di Trina AX. Setiap orang
menghubungkan akun Google-nya sendiri, sekali untuk setiap aplikasi, dan AI hanya memakainya di chat orang itu,
dengan izin Google milik orang itu.

Tidak ada yang perlu disalin atau ditempel: Anda masuk di Google.

## Menghubungkan aplikasi Google (semua orang)

:::tip
**Yang Anda perlukan**

- Akun Google Anda (akun Google Workspace perusahaan atau akun Gmail pribadi), yang sudah masuk di browser Anda.
:::

:::steps
#### Buka aplikasinya di Konektor
Pilih foto Anda di bagian bawah bilah kiri, lalu **Pengaturan › Konektor**, dan pilih aplikasinya (misalnya Gmail) di
bawah **Jelajahi**. Halamannya menjelaskan apa yang bisa dilakukan AI dan mencantumkan setiap alat.

#### Pilih Hubungkan
Halaman masuk Google sendiri terbuka (di aplikasi desktop, di browser Anda). Pilih akun Anda.

#### Biarkan semua kotak tetap dicentang
Google mencantumkan apa saja yang boleh dilakukan Trina AX, misalnya "Read, compose and send emails". Biarkan **semua**
kotak tetap dicentang dan pilih **Continue**. Proses masuk dengan kotak yang tidak dicentang akan ditolak: "Beberapa izin
tidak dicentang. Hubungkan lagi dan biarkan semua kotak tetap dicentang."

#### Konfirmasi akunnya
Kembali di Trina AX, periksa akun yang ditampilkan ("Hubungkan akun ini?") lalu pilih **Konfirmasi akun ini**. Halaman
menampilkan **Terhubung sebagai** dengan alamat Anda.
:::

Membaca tidak perlu persetujuan. Sebelum AI mengirim email, menambahkan acara, atau mengedit dokumen, AI menampilkan kartu berisi
semua yang akan dilakukannya, lalu menunggu persetujuan Anda. Di kartu itu, atau di **Pengaturan** aplikasi itu (menu
**⋯**-nya), Anda bisa memilih **Selalu izinkan** alih-alih **Tanya saya dulu**. Google Drive hanya membaca: tidak pernah
mengubah, memindahkan, atau mengirim apa pun.

### Jika Anda melihat "Minta admin menambahkannya"

Aplikasinya belum disiapkan di tim Anda. Pilih **Minta admin menambahkannya**: owner dan admin mendapat pemberitahuan,
dan Anda akan diberi tahu saat sudah bisa menghubungkannya.

![Halaman Google Drive di Pengaturan › Konektor untuk anggota: Ask admin to add it di tempat Connect, apa yang dilakukan AI dengan Drive, dan tiga alatnya](../../images/connect/google-member-ask.webp "Minta admin menambahkannya")

## Akun Google bersama untuk tim (admin)

Kotak surat atau kalender bersama, seperti `sales@acme.com`, bisa dihubungkan sekali untuk orang-orang yang
memerlukannya. Di **Admin › Aplikasi terhubung**, buka aplikasi Google-nya, lalu di bawah **Pengaturan tim › Akun Google
bersama** pilih **Hubungkan untuk tim**. Masuk dengan akun bersama itu, lalu pilih siapa yang memakainya. Google Drive
memiliki **Dibagikan dengan tim** di tempat yang sama.

## Menyiapkan aplikasi Google (admin server yang Anda kelola sendiri)

Di tim yang di-hosting oleh Trina, masuk dengan Google sudah siap: tidak ada yang perlu disiapkan. Di server yang
dikelola perusahaan Anda sendiri, admin membuat aplikasi masuk Google sekali di Google Cloud lalu menambahkannya di
**Admin › Aplikasi terhubung**.

:::tip
**Yang Anda perlukan**

- **Alamat https publik** untuk server tim Anda (orang kembali ke alamat itu dari Google). Selama belum ada, aplikasi
  Google menampilkan "Perlu alamat publik server ini dulu." Orang yang mengelola server yang mengaturnya: lihat
  [Konfigurasi](../../operate/configuration.md) (bahasa Inggris).
- **Proyek Google Cloud**, **API** yang diperlukan setiap aplikasi dalam keadaan aktif, dan **klien masuk** berjenis
  **Web application**.
- Dari Google Cloud: **file JSON** klien itu (atau **Client ID** dan **Client secret**-nya).
- Untuk Google Cloud: **alamat kembali** yang ditampilkan Trina AX, satu untuk Google Drive dan satu untuk empat
  aplikasi lainnya.
:::

![Halaman Gmail di Admin › Aplikasi terhubung pada server tanpa alamat publik: Not set up, Needs this server's public address first, dan di bawah Team settings API Google yang perlu diaktifkan](../../images/connect/google-admin-gmail.webp "Gmail, belum disiapkan")

:::steps
#### Buat aplikasinya di Google Cloud
Ikuti [Di Google Cloud](google-own-app.md#di-google-cloud) di halaman aplikasi perusahaan: proyek, API, nama dan
audiens aplikasi (**Internal** untuk perusahaan dengan Google Workspace; selain itu **External** dengan pengguna uji),
izin, dan klien **Web application**.

#### Tambahkan alamat kembali
Di bawah **Authorized redirect URIs** milik klien, tambahkan alamat yang ditampilkan dialog **Siapkan** setiap aplikasi,
dengan tombol salinnya:

```
https://<your team address>/api/integrations/google-drive/callback
https://<your team address>/api/integrations/google-apps/callback
```

#### Unggah file di Trina AX
Di **Admin › Aplikasi terhubung**, buka **Google Drive** dan pilih **Siapkan**. Unggah file JSON yang Anda unduh, atau
tempel **Client ID** dan **Client secret**, lalu simpan. Kemudian buka Gmail, Google Calendar, Docs, dan Sheets satu per
satu, pilih **Siapkan**, dan nyalakan **Gunakan aplikasi Google yang sama dengan Google Drive**: tidak ada lagi yang
perlu diunggah.
:::

Halaman setiap aplikasi mencantumkan, di bawah **API Google**, API yang perlu diaktifkan untuknya:

| Aplikasi | API Google yang perlu diaktifkan |
|---|---|
| Google Drive | Google Drive API |
| Gmail | Gmail API |
| Google Calendar | Google Calendar API |
| Google Docs | Google Docs API, Google Drive API |
| Google Sheets | Google Sheets API, Google Drive API |

Aplikasi Gmail, Calendar, Docs, dan Sheets berjalan di server Linux. Di aplikasi Mac, halamannya menampilkan "Belum
tersedia di server tim".

## Menampilkan nama perusahaan Anda di layar Google

Perusahaan yang memakai Google Workspace bisa membuat semua aplikasi Google masuk dengan aplikasi Google miliknya
sendiri, sehingga orang melihat nama perusahaan dan tidak ada peringatan di layar Google:
[Memakai aplikasi Google milik perusahaan Anda](google-own-app.md).

## Masalah

| Yang Anda lihat | Yang perlu dilakukan |
|---|---|
| **Beberapa izin tidak dicentang. Hubungkan lagi dan biarkan semua kotak tetap dicentang.** | Hubungkan lagi dan biarkan semua kotak di layar Google tetap dicentang. |
| **Google meminta Anda masuk lagi.** | Pilih **Hubungkan kembali** di halaman aplikasinya. Ini terjadi setelah kata sandi diganti, atau saat admin perusahaan Anda mencabut akses. |
| **`redirect_uri_mismatch`** di halaman Google (server yang dikelola sendiri) | Alamat kembali di Google Cloud berbeda dari yang ditampilkan Trina AX. Salin lagi dari dialog **Siapkan**. |
| **"This app is blocked"** atau **`admin_policy_enforced`** | Admin Google perusahaan Anda membatasi aplikasi mana yang boleh memakai akun Google. Minta mereka memercayai aplikasinya: lihat [Memercayai aplikasi di Admin console](google-own-app.md#opsional-memercayai-aplikasi-di-admin-console). |
| **Google hasn't verified this app** | Aplikasi External yang masih dalam tahap Testing. Pilih **Advanced** › **Go to …** hanya jika admin Anda yang membuat aplikasinya; atau minta mereka beralih ke aplikasi milik perusahaan Anda sendiri. |

Detail lengkap untuk pengembang dan operator: [Google apps](../../../GOOGLE-APPS.md) (bahasa Inggris) dan
[Google Drive](../../../GOOGLE-DRIVE.md) (bahasa Inggris).
