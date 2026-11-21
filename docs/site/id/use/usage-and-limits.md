---
title: Pemakaian dan batas
description: Lihat jawaban, token, dan perkiraan biaya per orang, dan atur batas token untuk orang, grup, atau tim.
---

Trina AX menghitung setiap jawaban: siapa yang bertanya, mesin dan model mana, berapa token, dan perkiraan biayanya.

:::note
Biaya adalah perkiraan harga API yang setara, bukan tagihan. Koneksi berlangganan menambah 0 per permintaan, tetapi tokennya tetap dihitung.
:::

## Pemakaian Anda sendiri

Buka **Pengaturan › Penggunaan** (foto Anda di bagian bawah bilah kiri › **Pengaturan**; di ponsel, tab **Saya**). Halaman ini menampilkan jawaban Anda dan perkiraan biayanya, AI mana yang menjawabnya, dan seberapa penuh setiap batas yang berlaku untuk Anda. Anda hanya bisa melihat angka Anda sendiri.

![Pengaturan › Penggunaan: Your usage this month, apakah ada batas yang berlaku untuk Anda, jawaban dan perkiraan biaya Anda, serta Your answers by AI](../../images/usage/mine.webp "Pemakaian Anda sendiri, di Pengaturan")

:::note
Pemakaian pribadi baru ada sejak 0.4.0. Sebelumnya, hanya admin yang melihat pemakaian, di **Admin › Pemakaian**.
:::

## Pemakaian tim

Admin membuka **Admin › Pemakaian**. Tata letaknya mirip halaman pemakaian di Claude Console.

- **Filter** di bagian atas, masing-masing berupa tombol kecil yang menunjukkan pilihan saat ini:
  - **Grup** (hanya jika tim punya grup) dan **Rentang**: hari ini, 7 atau 30 hari terakhir, bulan ini, atau rentang khusus.
  - **Orang**, **Mesin**, **Model**, dan **Koneksi AI**, untuk melihat salah satunya. **Hapus filter** menampilkan semuanya lagi.
  - **Kelompokkan per** orang, grup, mesin, model, hari, koneksi AI, atau skill.
- **Kartu** berisi total: token masuk, token keluar, jawaban, dan perkiraan biaya.
- **Penggunaan token**: token per hari sebagai batang bertumpuk, satu warna per nilai pengelompokan (lima terbesar, sisanya sebagai "Lainnya"). Arahkan kursor ke sebuah hari, atau fokuskan grafik lalu gunakan tombol panah, untuk melihat angka hari itu.
- **Rincian**: satu baris per nilai pengelompokan dengan jawaban, token, porsinya, dan perkiraan biaya.
- Tombol **unduh** menyimpan rincian sebagai CSV.

![Admin › Pemakaian: tombol filter, kartu berisi total, grafik Token usage dan rinciannya](../../images/usage/team.webp "Pemakaian tim, di Admin")

Skill pribadi tidak pernah dihitung berdasarkan nama, jadi tidak ada admin yang melihat apa yang disimpan seseorang secara pribadi. Skill grup dihitung seperti skill tim.

## Mengatur batas

Secara bawaan tidak ada batas. Batas dihitung dalam **token**: potongan kecil teks, kira-kira tiga perempat kata bahasa
Inggris per token. Semua yang dibaca AI (pertanyaan Anda, file yang dibukanya) dan ditulisnya ikut dihitung, jadi jawaban
yang membaca file panjang memakai jauh lebih banyak token daripada balasan singkat. Seperti paket data bulanan di ponsel,
batas membatasi berapa banyak yang bisa dipakai dalam sehari atau sebulan.

Untuk menambahkan batas (owner dan admin):

1. Buka **Admin › Pengaturan tim** lalu gulir ke **Batas pemakaian**.
2. Tekan **Tambah batas**. Sebuah jendela terbuka.
3. **Berlaku untuk**: **Seluruh tim**, satu grup, atau satu orang. **Periode**: **Per hari** atau **Per bulan**.
4. **Batas token**: berapa token, misalnya 1000000 untuk satu juta. **Batas biaya (USD)** tidak wajib: perkiraan biaya
   pemakaian yang sama lewat API; 0 berarti tanpa batas jumlah uang.
5. **Kalau terlampaui**: **Peringatan saja** membiarkan jawaban tetap berjalan dan mengirim pemberitahuan; **Blokir**
   menghentikan jawaban baru sampai periode berikutnya dimulai.
6. Tekan **Simpan**.

Batas itu sekarang menjadi satu baris di bawah **Batas pemakaian**. Setiap orang, grup, atau seluruh tim bisa punya satu
batas per periode.

![Add limit: Applies to Whole team, Period Per day, Token limit, Spending limit (USD) dengan 0 berarti tanpa batas jumlah uang, When exceeded Warn only, dan Save](../../images/usage/limit-dialog.webp "Menambahkan batas pemakaian")

Untuk satu orang, lebih cepat dari **Admin › Anggota & undangan**: buka menu **…** orang itu dan pilih **Batas penggunaan…**. Dialog
langsung ditujukan untuk orang itu dan terbuka dengan batas yang ia miliki, beserta berapa banyak yang sudah ia pakai. Pilih **Per hari** atau
**Per bulan** untuk melihat atau mengatur masing-masing, dan **Hapus batas** untuk menghapusnya. Orang yang punya batas menampilkannya dalam satu baris tenang
di bawah namanya, dengan **Melebihi batas** setelah batasnya habis. Di ponsel, buka orang itu lalu ketuk **Batas penggunaan**.

| Batas untuk | Periode |
|---|---|
| Satu orang | per hari atau per bulan |
| Satu grup | per hari atau per bulan |
| Seluruh tim | per hari atau per bulan |

Apa yang terjadi saat batas tercapai bergantung pada **Kalau terlampaui**:

- **Blokir**: owner dan admin mendapat pemberitahuan pada 80% dan lagi pada 100% (begitu juga orang itu, kalau batasnya
  untuk dia). Pada 100%, orang yang dicakupnya tidak bisa memulai jawaban baru sampai periodenya diatur ulang: tengah
  malam untuk batas harian, tanggal 1 untuk batas bulanan, menurut zona waktu tim. Halaman pemakaian mereka menyebutkan
  kapan itu terjadi.
- **Peringatan saja**: jawaban tetap berjalan. Owner dan admin (dan orang itu, kalau batasnya untuk dia) mendapat satu
  pemberitahuan saat batasnya habis.
