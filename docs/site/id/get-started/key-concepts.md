---
title: Konsep utama
description: Tim, orang, folder, chat, proyek, skill, mesin, dan MCP dalam satu halaman.
---

Trina AX punya beberapa komponen dasar. Semua halaman lain memakai istilah-istilah ini.

## Orang dan peran

| Peran | Bisa melakukan |
|---|---|
| **Owner** | Semua yang bisa dilakukan admin, ditambah keputusan tingkat tim seperti pembaruan, pemulihan, mengeluarkan anggota, dan nama tim. |
| **Admin** | Mengelola anggota, grup, izin folder, koneksi AI dan mesin tim, serta pengaturan tim. Admin tidak bisa membaca chat orang lain. |
| **Anggota** | Chat dengan AI, memakai file dan skill yang boleh mereka buka, serta memiliki folder dan skill pribadi. |
| **Tamu** | Orang dari luar tim, hanya di satu chat grup atau satu proyek. Tanpa AI, kecuali AI dipilihkan untuk mereka. Tidak memakai kursi. [Baca tentang tamu](../use/guests.md). |

**Grup** adalah sekumpulan orang, misalnya Penjualan atau Keuangan. Aturan folder bisa menyebut grup atau orang.

## Folder tim

Semua pengetahuan perusahaan berada di satu folder tim di server.

| Folder | Siapa yang melihatnya |
|---|---|
| `shared/` | Sesuai aturan folder, biasanya seluruh tim. |
| `groups/<group>/` | Orang di grup itu, kecuali ada aturan yang menambahkan orang lain. |
| `projects/<project>/` | Sesuai aturan folder. |
| `skills/` | Semua orang bisa membaca. Pengelola skill yang mengubahnya. |
| `users/<id>/` | Hanya orang itu sendiri. Owner dan admin pun tidak. |

Folder atau file yang tidak bisa Anda buka tidak terlihat sama sekali: di File, di jawaban AI, di pencarian, pratinjau, riwayat, dan sampah. [Baca tentang file dan izin](../use/files-and-permissions.md).

## Chat dan proyek

**Chat** adalah percakapan dengan AI. Hanya orang yang memulainya yang bisa melihatnya, sampai ia membagikannya ke orang atau grup. Chat di proyek tim dilihat oleh anggota proyek tersebut.

**Proyek** adalah folder dengan instruksi, untuk pekerjaan yang terus kembali ke file yang sama. Chat di dalam proyek memberi AI folder dan instruksi tersebut. [Baca tentang chat dan proyek](../use/chats-and-projects.md).

![Bilah kiri: Trina, Chats, Projects, Files dan Activity, dengan daftar Trina di sebelahnya: Ask Trina, Search, Scheduled, Team skills, Pinned dan Trina history](../../images/concepts/rail.webp "Bilah kiri")

## Skill

**Skill** adalah file `SKILL.md` yang berisi nama, deskripsi, dan prosedur. Skill memberi tahu AI cara tim Anda mengerjakan suatu tugas. Skill tidak pernah memberi akses tambahan. [Baca tentang skill tim](../use/team-skills.md).

## Mesin dan koneksi AI

**Mesin** adalah agen yang menjawab:

| Mesin | Catatan |
|---|---|
| Claude Code | Mesin bawaan. |
| Codex | Agen dari OpenAI. Tidak tersedia di Mac kantor. |
| API | Eksperimental. Memakai alamat API, model, dan kunci yang sudah diatur. |

**Koneksi AI** adalah akun yang dipakai mesin: langganan Claude, kunci API, atau login ChatGPT. Koneksi bisa bersifat pribadi, atau dipakai bersama oleh satu grup atau seluruh tim.

## MCP dan koneksi lain

**Koneksi MCP** memungkinkan AI memakai layanan luar, seperti Notion atau Linear, dengan login milik seseorang atau milik tim. Trina AX juga bekerja ke arah sebaliknya: Claude Anda sendiri bisa terhubung ke Trina AX sebagai server MCP. [Baca tentang MCP](../use/mcp.md).

## Tugas terjadwal dan pemakaian

**Tugas terjadwal** mengulang sebuah permintaan sesuai jadwal, dalam zona waktu tim. **Pemakaian** menghitung jawaban, token, dan perkiraan biaya per orang, dengan batas yang bisa diatur jika perlu. [Baca tentang tugas terjadwal](../use/scheduled-tasks.md).
