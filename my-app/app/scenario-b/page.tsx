'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const TIME_LIMIT_SECONDS = 90;
const CORRECT_ANSWERS = { origin: 'surabaya', date: '2026-11-20', kelas: 'bisnis' };

const LEFT_EYE = [33, 160, 158, 133, 153, 144];
const RIGHT_EYE = [362, 385, 387, 263, 373, 380];
const LEFT_IRIS_CENTER = 468;
const RIGHT_IRIS_CENTER = 473;

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function calcEAR(lm: any[], idx: number[]) {
  const [p1, p2, p3, p4, p5, p6] = idx.map((i) => lm[i]);
  return (dist(p2, p6) + dist(p3, p5)) / (2.0 * dist(p1, p4));
}

export default function ScenarioBPage() {
  const [cameraActive, setCameraActive] = useState(false);
  const [showPopup, setShowPopup] = useState(true);
  const [status, setStatus] = useState('Belum aktif');
  const [clockText, setClockText] = useState('menunggu kamera…');
  const [taskEnded, setTaskEnded] = useState(false);
  const [resultText, setResultText] = useState('');

  const [metrics, setMetrics] = useState({ ear: '–', blink: '–', saccade: '–', disp: '–' });
  const [loadScore, setLoadScore] = useState<number | null>(null);

  const [origin, setOrigin] = useState('');
  const [date, setDate] = useState('');
  const [kelas, setKelas] = useState('');

  const videoRef = useRef<HTMLVideoElement>(null);
  const startTimeRef = useRef<number | null>(null);
  const dataLogRef = useRef<any[]>([]);
  const bufferRef = useRef<{ samples: any[] }>({ samples: [] });
  const baselineRef = useRef<{ blink: number | null; saccade: number | null }>({ blink: null, saccade: null });
  const calibratingRef = useRef(true);
  const lastLogTimeRef = useRef(0);
  const animFrameRef = useRef<number | null>(null);

  const endTask = useCallback((timedOut: boolean) => {
    setTaskEnded(true);
    const completionSeconds = startTimeRef.current
      ? Math.min((performance.now() - startTimeRef.current) / 1000, TIME_LIMIT_SECONDS)
      : null;

    let correct = 0;
    if (origin.trim().toLowerCase() === CORRECT_ANSWERS.origin) correct++;
    if (date === CORRECT_ANSWERS.date) correct++;
    if (kelas.trim().toLowerCase() === CORRECT_ANSWERS.kelas) correct++;

    const resMsg =
      (timedOut ? `Waktu habis (${TIME_LIMIT_SECONDS}s). ` : '') +
      (completionSeconds !== null ? `Task Completion Time: ${completionSeconds.toFixed(2)} detik. ` : '') +
      `Akurasi: ${correct}/3 benar.`;

    setResultText(resMsg);
  }, [origin, date, kelas]);

  useEffect(() => {
    if (!cameraActive || taskEnded) return;
    const interval = setInterval(() => {
      if (!startTimeRef.current) return;
      const elapsed = (performance.now() - startTimeRef.current) / 1000;
      const remaining = Math.max(0, TIME_LIMIT_SECONDS - elapsed);
      setClockText(`sisa waktu: ${remaining.toFixed(1)}s`);
      if (remaining <= 0) endTask(true);
    }, 100);
    return () => clearInterval(interval);
  }, [cameraActive, taskEnded, endTask]);

  const startCV = async () => {
    setStatus('Memuat model…');
    try {
      const filesetResolver = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
      const faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        refineLandmarks: true,
      });

      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: false });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await new Promise((res) => (videoRef.current!.onloadedmetadata = res));
        videoRef.current.play();
      }

      setCameraActive(true);
      setStatus('Aktif — mengalibrasi baseline…');
      startTimeRef.current = performance.now();

      const loop = () => {
        const nowMs = performance.now();
        if (videoRef.current && videoRef.current.readyState >= 2) {
          const result = faceLandmarker.detectForVideo(videoRef.current, nowMs);
          if (result.faceLandmarks && result.faceLandmarks.length > 0) {
            const lm = result.faceLandmarks[0];
            const ear = (calcEAR(lm, LEFT_EYE) + calcEAR(lm, RIGHT_EYE)) / 2;
            const irisL = lm[LEFT_IRIS_CENTER], irisR = lm[RIGHT_IRIS_CENTER];

            bufferRef.current.samples.push({ t: nowMs, ear, irisX: (irisL.x + irisR.x) / 2, irisY: (irisL.y + irisR.y) / 2 });
            const cutoff = nowMs - 5000;
            while (bufferRef.current.samples.length && bufferRef.current.samples[0].t < cutoff) {
              bufferRef.current.samples.shift();
            }

            const samples = bufferRef.current.samples;
            if (samples.length >= 2) {
              const ears = samples.map((s) => s.ear);
              const meanEAR = ears.reduce((a, b) => a + b, 0) / ears.length;
              let blinks = 0, wasBelow = false;
              for (const e of ears) {
                const below = e < 0.21;
                if (below && !wasBelow) blinks++;
                wasBelow = below;
              }
              let velSum = 0, velCount = 0;
              const xs: number[] = [], ys: number[] = [];
              for (let i = 0; i < samples.length; i++) {
                xs.push(samples[i].irisX); ys.push(samples[i].irisY);
                if (i > 0) {
                  const dt = (samples[i].t - samples[i - 1].t) / 1000;
                  if (dt > 0) {
                    velSum += Math.hypot(samples[i].irisX - samples[i - 1].irisX, samples[i].irisY - samples[i - 1].irisY) / dt;
                    velCount++;
                  }
                }
              }
              const meanSaccade = velCount ? velSum / velCount : 0;
              const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
              const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
              const variance = xs.reduce((acc, x, i) => acc + (x - meanX) ** 2 + (ys[i] - meanY) ** 2, 0) / xs.length;
              const gazeDispersion = Math.sqrt(variance);

              if (calibratingRef.current && samples.length > 15) {
                baselineRef.current.blink = Math.max(blinks, 1);
                baselineRef.current.saccade = Math.max(meanSaccade, 0.01);
                calibratingRef.current = false;
              }

              const blinkRef = baselineRef.current.blink ?? 3;
              const saccadeRef = baselineRef.current.saccade ?? 0.05;
              const score = Math.max(0, Math.min(1, 0.34 * Math.max(0, 1 - blinks / blinkRef) + 0.30 * Math.max(0, 1 - meanSaccade / saccadeRef) + 0.24 * Math.min(1, gazeDispersion / 0.014) + 0.12 * (meanEAR > 0.24 ? 0.5 : 0.2)));

              setLoadScore(score);
              setMetrics({ ear: meanEAR.toFixed(3), blink: String(blinks), saccade: meanSaccade.toFixed(3), disp: gazeDispersion.toFixed(4) });

              if (!taskEnded && nowMs - lastLogTimeRef.current > 1000) {
                lastLogTimeRef.current = nowMs;
                dataLogRef.current.push({
                  t_task_s: ((nowMs - (startTimeRef.current || nowMs)) / 1000).toFixed(2),
                  ear: meanEAR.toFixed(3),
                  blink: blinks,
                  saccade: meanSaccade.toFixed(4),
                  dispersion: gazeDispersion.toFixed(5),
                  score: score.toFixed(3),
                });
              }
            }
          }
        }
        animFrameRef.current = requestAnimationFrame(loop);
      };
      animFrameRef.current = requestAnimationFrame(loop);
    } catch (err: any) {
      setStatus('Error: ' + err.message);
    }
  };

  useEffect(() => {
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (videoRef.current?.srcObject) {
        (videoRef.current.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  return (
    <div style={{ background: '#fff', color: '#1a1a1a', minHeight: '100vh' }}>
      <div style={{ background: 'linear-gradient(90deg, #ff2d55, #ffcc00, #ff2d55)', color: '#fff', textAlign: 'center', fontWeight: 800, padding: 10 }}>
        ⚡ FLASH SALE HARI INI SAJA — DISKON HINGGA 70%! JANGAN SAMPAI TERLEWAT ⚡
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 32px', borderBottom: '1px solid #e2e2e2', fontFamily: 'var(--mono)', fontSize: 11, background: '#fafafa' }}>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#ef5b5b', marginRight: 8 }}></span>Skenario B — Statis, Beban Tinggi</span>
        <span>{clockText}</span>
      </div>

      {showPopup && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div style={{ width: 320, background: '#fff', borderRadius: 10, padding: 22, textAlign: 'center', borderTop: '6px solid #ff2d55' }}>
            <span onClick={() => setShowPopup(false)} style={{ float: 'right', cursor: 'pointer', color: '#999' }}>✕</span>
            <h3 style={{ margin: '0 0 8px' }}>🎉 Dapatkan Voucher Rp100.000!</h3>
            <p style={{ fontSize: 12, color: '#555', marginBottom: 16 }}>Daftar newsletter kami sekarang dan dapatkan voucher perjalanan eksklusif untuk pemesanan pertama Anda.</p>
            <button onClick={() => setShowPopup(false)} style={{ width: '100%', padding: 11, borderRadius: 6, border: 'none', background: '#111', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>Ya, Daftarkan Saya</button>
          </div>
        </div>
      )}

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 24px 60px', display: 'grid', gridTemplateColumns: '1fr 260px', gap: 20 }}>
        <div>
          <h1>Pesan Tiket Perjalanan</h1>
          <div style={{ background: '#fffbe6', border: '1px solid #f0e2a3', borderLeft: '3px solid #d9a400', borderRadius: 6, padding: '12px 14px', marginBottom: 20 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: '#946c00', marginBottom: 5 }}>🎯 Tugas Anda</div>
            <p style={{ fontSize: 12, color: '#5a4a1a', margin: 0 }}>Baca artikel di bawah, lalu isi formulir menggunakan <strong>3 informasi yang disebutkan dalam teks</strong>: kota keberangkatan, tanggal keberangkatan, dan kelas penerbangan yang direkomendasikan. Kota tujuan sudah ditentukan (Jakarta).</p>
          </div>

          <p style={{ fontSize: 13, lineHeight: 1.6, color: '#444' }}>Tim customer service kami merekomendasikan penerbangan berangkat dari kota Surabaya, karena rute tersebut memiliki jadwal paling fleksibel bulan ini.</p>
          <p style={{ fontSize: 13, lineHeight: 1.6, color: '#444' }}>Kelas ekonomi premium kini tersedia dengan fasilitas tambahan. Namun, mengingat durasi perjalanan yang panjang, kelas Bisnis lebih direkomendasikan agar Anda tetap nyaman selama penerbangan.</p>
          <p style={{ fontSize: 13, lineHeight: 1.6, color: '#444' }}>Untuk mendapatkan harga terbaik, penerbangan disarankan pada tanggal 20 November 2026 sebelum harga tiket naik menjelang akhir tahun.</p>

          <div style={{ background: '#fcfcfc', border: '1px solid #e2e2e2', borderRadius: 8, padding: 18, marginTop: 18 }}>
            <label style={{ display: 'block', fontSize: 11, color: '#777', margin: '12px 0 5px' }}>Kota asal</label>
            <input type="text" value={origin} onChange={(e) => setOrigin(e.target.value)} disabled={!cameraActive || taskEnded} placeholder="Nama kota" style={{ width: '100%', padding: '9px 10px', borderRadius: 6, border: '1px solid #ddd' }} />
            <label style={{ display: 'block', fontSize: 11, color: '#777', margin: '12px 0 5px' }}>Kota tujuan (sudah ditentukan)</label>
            <input type="text" value="Jakarta" disabled style={{ width: '100%', padding: '9px 10px', borderRadius: 6, border: '1px solid #ddd', background: '#eee' }} />
            <label style={{ display: 'block', fontSize: 11, color: '#777', margin: '12px 0 5px' }}>Tanggal berangkat</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={!cameraActive || taskEnded} style={{ width: '100%', padding: '9px 10px', borderRadius: 6, border: '1px solid #ddd' }} />
            <label style={{ display: 'block', fontSize: 11, color: '#777', margin: '12px 0 5px' }}>Kelas</label>
            <select value={kelas} onChange={(e) => setKelas(e.target.value)} disabled={!cameraActive || taskEnded} style={{ width: '100%', padding: '9px 10px', borderRadius: 6, border: '1px solid #ddd' }}>
              <option value="">— pilih —</option>
              <option>Ekonomi</option>
              <option>Bisnis</option>
              <option>Eksekutif</option>
            </select>
            <button onClick={() => endTask(false)} disabled={!cameraActive || taskEnded} style={{ marginTop: 16, width: '100%', padding: 12, borderRadius: 6, border: 'none', background: '#ef5b5b', color: '#fff', fontWeight: 800, cursor: 'pointer', opacity: (!cameraActive || taskEnded) ? 0.5 : 1 }}>
              Selesaikan Pemesanan
            </button>
            {resultText && <div style={{ marginTop: 16, padding: '12px 14px', borderRadius: 6, background: '#fff5f5', color: '#a33', fontSize: 12 }}>{resultText}</div>}
          </div>
        </div>

        {/* Ads Column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ background: '#ffe600', padding: 14, borderRadius: 8, fontSize: 11 }}>Diskon hotel hingga 40%! Booking sekarang sebelum promo berakhir HARI INI.</div>
          <div style={{ background: '#ff4d6d', color: '#fff', padding: 14, borderRadius: 8, fontSize: 11 }}>Asuransi perjalanan mulai Rp25.000. Lindungi perjalanan Anda sekarang juga!</div>
          <div style={{ background: '#00c2ff', padding: 14, borderRadius: 8, fontSize: 11 }}>Sewa mobil murai mulai Rp150rb/hari. Gratis antar-jemput bandara!</div>
        </div>
      </div>

      {/* CV Telemetry Panel */}
      <div style={{ position: 'fixed', bottom: 20, right: 20, width: 200, background: '#0d1117', border: '1px solid #232b34', borderRadius: 10, padding: 12, fontFamily: 'var(--mono)', fontSize: 11, color: '#9aa3b0', zIndex: 100 }}>
        <div style={{ width: '100%', aspectRatio: '4/3', background: '#000', borderRadius: 6, overflow: 'hidden', marginBottom: 8 }}>
          <video ref={videoRef} autoPlay playsinline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
        </div>
        <button onClick={startCV} disabled={cameraActive} style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #232b34', background: '#161d28', color: '#fff', cursor: 'pointer', marginBottom: 6 }}>
          {cameraActive ? 'Berjalan…' : 'Aktifkan Kamera'}
        </button>
        <div style={{ fontSize: 10, marginBottom: 6 }}>{status}</div>
        {loadScore !== null && (
          <div style={{ fontSize: 10 }}>
            <div>EAR: {metrics.ear}</div>
            <div>Blink/5s: {metrics.blink}</div>
            <div>Saccade: {metrics.saccade}</div>
            <div>Gaze disp: {metrics.disp}</div>
          </div>
        )}
      </div>
    </div>
  );
}