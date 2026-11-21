---
name: review-digest
description: Rangkuman ulasan pelanggan. Merangkum ulasan pelanggan dengan tema dan jumlahnya, tiga kutipan yang boleh dipakai, dan tiga langkah berikutnya. Pakai untuk "rangkum ulasan", "pelanggan bilang apa?", dan sejenisnya.
metadata:
  title: Rangkuman ulasan pelanggan
---

# Rangkuman ulasan pelanggan

## Sumber
- Hanya `projects/Suara pelanggan/Ulasan dua bulan terakhir.csv`: satu baris per ulasan (bulan, rasa, bintang, tema, kata
  pelanggan, nama depan, Boleh dikutip). Filenya kecil: baca sekali dan hitung dari situ. Jangan buka file lain.

## Cara
1. Satu baris: jumlah ulasan, rata-rata bintang, rasa favorit (untuk bulan yang ditanyakan, kalau tidak ada ya semuanya).
2. **Tema**: | Tema | Ulasan | Kata pelanggan |, dari yang paling banyak.
3. **Kutipan yang boleh dipakai**: tiga, hanya baris dengan Boleh dikutip "ya", lengkap dengan nama depan dan rasa.
4. **Langkah berikutnya**: tiga, satu baris masing-masing, plus siapa yang bisa memegangnya (Layanan pelanggan, Operasional, Marketing, toko).

## Aturan
- Jumlah dan rata-rata hanya dari file, tidak ditebak: jumlah per tema kalau dijumlahkan sama dengan totalnya.
- Jangan pernah mengutip orang yang Boleh dikutip-nya "tidak".
- Jawab di chat. Simpan hanya kalau diminta.
