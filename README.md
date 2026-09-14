# WebCog-Net — Starter Project (MVP)

Demo dari konsep di paper: deteksi beban kognitif via webcam (di browser, tanpa kirim data ke server), dengan **3 skenario eksperimen (A/B/C)** yang membagikan **satu benchmark task-completion yang terstandardisasi**, plus decluttering adaptif 3-tahap di Skenario C.

## ⚠️ Perubahan Struktur Proyek

Proyek ini sudah tidak lagi satu file (`index.html`). Sekarang ada **3 file terpisah**, masing-masing merepresentasikan satu skenario dari Bab 4.1 paper:

| File | Skenario | Deskripsi |
|---|---|---|
| `scenario-a.html` | **A — Baseline** | Beban kognitif rendah. Latar hitam, kontras tinggi, 1 gambar, tanpa iklan/distraksi. |
| `scenario-b.html` | **B — Statis, Beban Tinggi** | Tanpa intervensi. Latar putih terang, iklan berwarna kontras, pop-up, banner berkedip, banyak gambar menyela teks. |
| `scenario-c.html` | **C — Adaptif (Closed-Loop)** | Sama seperti B di awal, tapi WebCog-Net otomatis menyederhanakan tampilan (3 tahap) saat mendeteksi distress meningkat. |

`index.html` yang lama **sudah dihapus** — isinya sama dengan `scenario-c.html` sekarang, hanya berganti nama agar konsisten dengan skema A/B/C.

## Benchmark Task-Completion yang Terstandardisasi

**Ini bagian paling penting untuk validitas eksperimen**, jadi dijelaskan duluan.

Sebelumnya, form pemesanan di setiap skenario tidak punya "jawaban benar" — peserta bisa mengetik apa saja lalu klik submit, jadi Task Completion Time tidak benar-benar mengukur apa-apa selain refleks klik. Sekarang, ketiganya berbagi task yang identik:

**Instruksi (sama persis di A, B, C):**
> Baca artikel, lalu isi formulir menggunakan 3 informasi yang disebutkan dalam teks: kota keberangkatan, tanggal keberangkatan, dan kelas penerbangan yang direkomendasikan. Kota tujuan sudah ditentukan (Jakarta).

**Jawaban benar (konstanta tetap, identik di ketiga file):**
```javascript
const CORRECT_ANSWERS = { origin: 'surabaya', date: '2026-11-20', kelas: 'bisnis' };
```

**Cara kerja penilaian** (`gradeTask()` — logic identik di ketiga file):
- Membandingkan 3 input peserta (kota asal, tanggal, kelas) dengan jawaban benar (case-insensitive untuk teks).
- Menghasilkan skor akurasi 0–3, ditampilkan bersama Task Completion Time di kotak hasil.
- Kota tujuan sengaja dibuat fixed/disabled (bukan bagian penilaian) — mengurangi variabel yang harus benar sehingga fokus tetap ke 3 fakta yang perlu diekstrak dari bacaan.

**Kenapa fakta-fakta itu tidak di-bold**: supaya peserta benar-benar harus membaca, bukan sekadar mencari teks tebal — ini penting khususnya untuk Skenario B/C di mana fakta harus ditemukan di tengah gangguan visual.

**Penempatan fakta per skenario:**
- **A**: di paragraf pembuka (tidak ada gangguan di sekitarnya).
- **B**: didistribusikan ke 3 paragraf yang sudah ada, yang letaknya diselingi gambar inline dan dikelilingi iklan — di sinilah task benar-benar diuji di bawah distraksi.
- **C**: didistribusikan ke paragraf-paragraf artikel yang **tidak** di-gate oleh `data-min-stage` — artinya fakta-fakta ini tetap terlihat di ketiga stage decluttering manapun. Ini penting: kalau decluttering justru menyembunyikan info yang dibutuhkan untuk task, itu jadi confounding variable, bukan mitigasi.

## Timer & Batas Waktu

- **Batas waktu: 90 detik**, konstanta `TIME_LIMIT_SECONDS` di bagian atas script masing-masing file — ubah di satu tempat itu saja per file (tidak ada config bersama antar file, jadi kalau mau ubah, ubah di ketiganya).
- **Timer baru mulai saat kamera aktif**, bukan saat halaman dimuat. Tombol submit disabled sampai kamera menyala — mencegah peserta submit sebelum monitoring fisiologis benar-benar berjalan.
- Kalau waktu habis sebelum submit, task otomatis berakhir (`endTask(true)`), form dikunci, dan tetap dinilai berdasarkan apa yang sudah terisi saat itu.
- Untuk Skenario C, begitu task berakhir (submit atau timeout), kamera **otomatis dimatikan** (`getTracks().forEach(t => t.stop())`) — tidak ada alasan terus memantau setelah task selesai.

## Panel Monitoring Fisiologis (di Skenario A & B)

A dan B awalnya statis tanpa CV — sekarang keduanya juga punya panel monitoring pasif (kamera + skor distress + metrik EAR/blink/saccade/dispersion), letaknya fixed di pojok kanan bawah. **Penting**: panel ini murni pencatat, tidak pernah mengubah tampilan halaman — itu prinsip skenario statis (A & B) yang harus dijaga.

**Export CSV** (tombol "Unduh Data (CSV)", hanya ada di A & B):
- Baris di-log setiap ~1 detik, berhenti otomatis begitu task selesai (submit/timeout) — supaya tidak ada data pasca-task yang mencemari log.
- File CSV sekarang punya baris ringkasan di bagian atas (diawali `#`, bisa di-skip pandas via `comment='#'`):
  ```
  # scenario=A
  # task_completion_time_s=42.31
  # task_timed_out=false
  # task_accuracy=3/3
  t_task_s,ear,blink,saccade,dispersion,score
  1.02,0.284,4,0.041,0.0031,0.180
  ...
  ```

## Sistem 3 Tahap Adaptif (khusus Skenario C)

**Arah pemetaan stage**: makin tinggi skor distress terdeteksi → makin sederhana tampilan (bukan sebaliknya).

| Skor Distress | Stage | Tampilan |
|---|---|---|
| Rendah (tenang) | **Stage 3** (default) | Clutter penuh — pop-up, iklan berkedip, banyak gambar |
| Menengah | **Stage 2** | Iklan & pop-up dikurangi, gambar masih ada |
| Tinggi | **Stage 1** | Basic — hanya teks inti + 1 gambar |

Transisi pakai *hysteresis* (`UP_TO_2=0.30`, `UP_TO_1=0.58`, `DOWN_TO_2=0.46`, `DOWN_TO_3=0.20`) supaya tidak flicker saat skor ada di sekitar batas.

**Skema warna per stage** (khusus area konten Skenario C, sidebar telemetri tidak berubah):

| Stage | Background | Teks |
|---|---|---|
| Stage 3 (default) | Gelap (tema asli) | Kontras dinaikkan dari abu-abu redup ke lebih terang, supaya tetap terbaca |
| Stage 2 | Abu-abu hangat muted | Teks gelap |
| Stage 1 (paling sederhana) | Putih terang | Nyaris hitam — mode "reader" paling jelas |

## Classifier: Sensitivitas & Arah Sinyal Mata

Classifier (`estimateCognitiveLoad()`, identik di ketiga file) murni berbasis sinyal mata — gerakan fisik/kepala **sengaja tidak dimodelkan**:

- **Blink suppression (34%)** — penurunan laju kedipan relatif ke baseline personal (dikalibrasi dari ~15 sampel pertama setelah kamera aktif).
- **Saccade velocity drop (30%)** — **arah dibalik dari versi awal**: sekarang skor naik saat kecepatan sakade **menurun** relatif ke baseline personal (bukan saat naik secara absolut), mengikuti temuan Di Stasi et al. (2010) dan Savage et al. (2020) bahwa peak saccade velocity menurun seiring meningkatnya task complexity/mental workload. **Catatan**: arah ini kontroversial di literatur — studi lain (mis. Bodala et al., 2014) menemukan arah sebaliknya. Hubungannya tampak bergantung pada jenis task; implementasi ini mengikuti temuan yang menurun.
- **Gaze dispersion (24%)** — variansi/jitter posisi iris dalam window 5 detik; metrik yang tervalidasi di literatur (mis. BCEA), tapi arah hubungannya dengan beban kognitif juga bergantung pada jenis task (ada studi yang menemukan arah berlawanan pada task visual search terfokus).
- **EAR stability (12%)** — fiksasi mata lebar tanpa kedipan, bobot kecil sebagai sinyal sekunder.

## Kustomisasi Gambar

Cari `<div class="img-placeholder" data-min-stage="N">` di HTML masing-masing file. **Jangan ubah** atribut `data-min-stage` (itu yang mengatur visibilitas per stage/kondisi) — ganti isinya saja:

```html
<div class="img-placeholder has-image" data-min-stage="1">
  <img src="images/nama-file-anda.jpg" alt="deskripsi gambar">
</div>
```

Tambahkan class `has-image` supaya gambar mengisi kartu dengan benar (`object-fit:cover`, tinggi 240px). Taruh file gambar di folder `images/` di sebelah file HTML.

## Cara Menjalankan

1. **Butuh HTTPS atau localhost** — browser hanya mengizinkan akses kamera (`getUserMedia`) di konteks aman:
   ```bash
   cd webcog-mvp
   python3 -m http.server 8000
   ```
   Buka `http://localhost:8000/scenario-a.html` (atau `-b.html` / `-c.html`) di Chrome.

2. Klik **"Aktifkan Kamera"**, izinkan akses kamera. Timer & tombol submit baru aktif setelah ini.
3. Baca artikel, ekstrak 3 fakta, isi formulir, submit sebelum 90 detik habis.
4. (Khusus A & B) Klik **"Unduh Data (CSV)"** untuk mengunduh log fisiologis + ringkasan hasil task.

**Untuk menjalankan eksperimen within-subjects sungguhan**: urutan presentasi A/B/C ke tiap partisipan harus diacak pakai Latin Square (sesuai Bab 4.1 paper) — saat ini urutan itu masih manual (kamu yang membuka file sesuai urutan yang sudah diacak sebelumnya), belum ada otomasi randomisasi urutan.

## Apa yang Sudah Sesuai Paper

| Komponen Paper | Implementasi di MVP |
|---|---|
| Ekstraksi landmark wajah client-side | MediaPipe FaceLandmarker via WASM (CDN) ✅ |
| EAR, blink rate, saccade velocity | Dihitung dari landmark mata + iris (index 468/473) ✅ |
| Sliding window 5 detik | `FeatureBuffer` class, window 5000ms ✅ |
| Zero-transmission (privacy-by-design) | Tidak ada `fetch()`/upload apa pun — semua di memori browser ✅ |
| Closed-loop DOM manipulation (Skenario C) | `applyStage()` toggle class CSS secara real-time ✅ |
| 3 skenario within-subjects (Bab 4.1) | File terpisah A/B/C ✅ |
| Task Completion Time (Bab 4.4) | Timer terstandardisasi + grading ✅ |

## Apa yang BELUM Sesuai Paper (dan Kenapa)

**Klasifikasi beban kognitif masih heuristik**, bukan model 1D CNN-GRU terlatih. Model tersebut butuh dataset berlabel (fitur fisiologis + skor beban kognitif ground-truth dari partisipan) yang belum ada — ini justru bagian dari eksperimen di Bab 4 (N=30 partisipan). Heuristik saat ini **tidak merepresentasikan H1** (akurasi >85%, dsb) dan sebagian arah fiturnya (saccade, dispersion) masih diperdebatkan di literatur — lihat bagian "Classifier" di atas.

**NASA-TLX (RTLX) belum diimplementasikan** — Bab 4.4 paper juga butuh data subjektif ini setelah setiap skenario, belum ada form digitalnya di project ini.

**Randomisasi Latin Square belum otomatis** — urutan presentasi A/B/C per partisipan masih manual.

## Roadmap ke Versi Sesuai Paper (H1)

1. **Kumpulkan data**: rekam fitur (EAR/blink/saccade/dispersion per frame + timestamp) dari partisipan sambil mengisi self-report beban kognitif sebagai label.
2. **Latih model di Python**:
   ```python
   import tensorflow as tf
   model = tf.keras.Sequential([
       tf.keras.layers.Conv1D(16, 3, activation='relu', input_shape=(window_len, n_features)),
       tf.keras.layers.MaxPool1D(2),
       tf.keras.layers.GRU(16),
       tf.keras.layers.Dense(1, activation='sigmoid')
   ])
   model.compile(optimizer='adam', loss='binary_crossentropy', metrics=['accuracy'])
   model.fit(X_train, y_train, validation_split=0.2, epochs=50)
   ```
3. **Kuantisasi & konversi ke TFJS**:
   ```bash
   pip install tensorflowjs
   tensorflowjs_converter --input_format=keras --quantize_uint8 model.h5 ./tfjs_model
   ```
   Target: ukuran file < 50KB (sesuai H1).
4. **Ganti heuristik** di `estimateCognitiveLoad()` (ketiga file) dengan:
   ```javascript
   const model = await tf.loadLayersModel('/tfjs_model/model.json');
   const inputTensor = tf.tensor3d([featureSequence]); // [1, timesteps, n_features]
   const score = (await model.predict(inputTensor).data())[0];
   ```
5. **Ukur latensi** khusus di sekitar `model.predict()` untuk validasi H1 (< 5ms/frame) — saat ini yang diukur baru latensi keseluruhan frame, bukan classifier saja.
6. **Tambahkan form NASA-TLX digital** setelah tiap skenario, dan gabungkan datanya dengan CSV fisiologis per sesi (idealnya satu skema penamaan file per partisipan+skenario+urutan).
7. **Otomasi randomisasi Latin Square** untuk urutan presentasi A/B/C per partisipan.

## Catatan Teknis Lain

- **Threshold 3-tahap, bobot classifier, dan skala normalisasi** (0.30/0.58/0.46/0.20 untuk stage; 0.34/0.30/0.24/0.12 untuk bobot; 0.014 untuk gaze dispersion) semuanya **arbitrer**, ditentukan dengan intuisi untuk kebutuhan demo — belum divalidasi dengan data nyata.
- **Baseline blink & saccade**: diambil dari ~15 sampel pertama setelah kamera aktif dalam SETIAP sesi/file (bukan dari sesi baseline terpisah). Pendekatan lebih baik: gunakan hasil kalibrasi dari Skenario A sebagai baseline yang dibawa ke sesi B/C untuk partisipan yang sama — saat ini belum diimplementasikan (baseline masih di-reset per file/refresh halaman).
- Performa MediaPipe di perangkat tanpa GPU (`delegate: "GPU"` akan fallback ke CPU) — uji langsung di perangkat target sebelum klaim latensi.
- Privasi: tambahkan indikator kamera yang jelas dan tombol stop eksplisit sebelum deploy ke pengguna nyata, plus informed consent kalau dipakai untuk riset dengan partisipan manusia.
- Setiap file (`scenario-a.html`, `-b.html`, `-c.html`) membawa salinan classifier & timer logic-nya sendiri (bukan file JS bersama) — supaya masing-masing tetap portable/standalone. Konsekuensinya: kalau mengubah logic classifier, harus diubah di ketiga file secara manual agar tetap konsisten.