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

export default function ScenarioAPage() {
  const [cameraActive, setCameraActive] = useState(false);
  const [status, setStatus] = useState('Belum aktif');
  const [clockText, setClockText] = useState('menunggu kamera…');
  const [taskEnded, setTaskEnded] = useState(false);
  const [resultText, setResultText] = useState('');

  // Metrics
  const [metrics, setMetrics] = useState({ ear: '–', blink: '–', saccade: '–', disp: '–', score: '–' });
  const [loadScore, setLoadScore] = useState<number | null>(null);

  // Form State
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

  // Timer loop
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

  const startTaskTimer = () => {
    if (startTimeRef.current !== null) return;
    startTimeRef.current = performance.now();
  };

  const processBuffer = (samples: any[]) => {
    if (samples.length < 2) return null;
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
        const a = samples[i - 1], b = samples[i];
        const dt = (b.t - a.t) / 1000;
        if (dt > 0) {
          velSum += Math.hypot(b.irisX - a.irisX, b.irisY - a.irisY) / dt;
          velCount++;
        }
      }
    }
    const meanSaccade = velCount ? velSum / velCount : 0;
    const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
    const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
    const variance = xs.reduce((acc, x, i) => acc + (x - meanX) ** 2 + (ys[i] - meanY) ** 2, 0) / xs.length;
    return { meanEAR, blinkCount: blinks, meanSaccade, gazeDispersion: Math.sqrt(variance), n: samples.length };
  };

  const estimateCognitiveLoad = (f: any) => {
    if (calibratingRef.current && f.n > 15) {
      baselineRef.current.blink = Math.max(f.blinkCount, 1);
      baselineRef.current.saccade = Math.max(f.meanSaccade, 0.01);
      calibratingRef.current = false;
    }
    const blinkRef = baselineRef.current.blink ?? 3;
    const saccadeRef = baselineRef.current.saccade ?? 0.05;
    const blinkDropRatio = Math.max(0, 1 - f.blinkCount / blinkRef);
    const saccadeDropRatio = Math.max(0, 1 - f.meanSaccade / saccadeRef);
    const dispersionScore = Math.min(1, f.gazeDispersion / 0.014);
    const earStability = f.meanEAR > 0.24 ? 0.5 : 0.2;
    return Math.max(0, Math.min(1, 0.34 * blinkDropRatio + 0.30 * saccadeDropRatio + 0.24 * dispersionScore + 0.12 * earStability));
  };

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
      startTaskTimer();

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

            const f = processBuffer(bufferRef.current.samples);
            if (f) {
              const score = estimateCognitiveLoad(f);
              setLoadScore(score);
              setMetrics({
                ear: f.meanEAR.toFixed(3),
                blink: String(f.blinkCount),
                saccade: f.meanSaccade.toFixed(3),
                disp: f.gazeDispersion.toFixed(4),
                score: (score * 100).toFixed(0) + '%',
              });

              setStatus(calibratingRef.current ? 'Aktif — mengalibrasi baseline…' : 'Aktif — merekam (tidak mengubah tampilan)');

              if (!taskEnded && nowMs - lastLogTimeRef.current > 1000) {
                lastLogTimeRef.current = nowMs;
                dataLogRef.current.push({
                  t_task_s: ((nowMs - (startTimeRef.current || nowMs)) / 1000).toFixed(2),
                  ear: f.meanEAR.toFixed(3),
                  blink: f.blinkCount,
                  saccade: f.meanSaccade.toFixed(4),
                  dispersion: f.gazeDispersion.toFixed(5),
                  score: score.toFixed(3),
                });
              }
            }
          } else {
            setStatus('Aktif — wajah tidak terdeteksi');
          }
        }
        animFrameRef.current = requestAnimationFrame(loop);
      };
      animFrameRef.current = requestAnimationFrame(loop);
    } catch (err: any) {
      setStatus('Error: ' + err.message);
    }
  };

  const exportCSV = () => {
    const header = 't_task_s,ear,blink,saccade,dispersion,score\n';
    const rows = dataLogRef.current.map((r) => `${r.t_task_s},${r.ear},${r.blink},${r.saccade},${r.dispersion},${r.score}`).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'scenario-a-webcog-log.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (videoRef.current?.srcObject) {
        (videoRef.current.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    endTask(false);
  };

  return (
    <div style={{ background: '#000', color: '#f5f6f8', minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 32px', borderBottom: '1px solid #232b34', fontFamily: 'var(--mono)', fontSize: 11, color: '#9aa3b0' }}>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#3fd0c9', marginRight: 8 }}></span>Skenario A — Baseline</span>
        <span>{clockText}</span>
      </div>

      <div style={{ maxWidth: 640, margin: '0 auto', padding: '64px 32px 80px' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#9aa3b0', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 16 }}>Tugas: Pemesanan Tiket Perjalanan</div>
        <h1 style={{ fontSize: 34, fontWeight: 700, margin: '0 0 18px' }}>Pesan Tiket Perjalanan</h1>
        
        <div style={{ background: '#0d1117', border: '1px solid #232b34', borderLeft: '3px solid #3fd0c9', borderRadius: 8, padding: '14px 16px', marginBottom: 24 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#3fd0c9', marginBottom: 6 }}>🎯 Tugas Anda</div>
          <p style={{ fontSize: 13, lineHeight: 1.6, color: '#c7ccd3', margin: 0 }}>
            Baca teks rekomendasi di bawah, lalu isi formulir menggunakan <strong>3 informasi yang disebutkan dalam teks</strong>: kota keberangkatan, tanggal keberangkatan, dan kelas penerbangan yang direkomendasikan. Kota tujuan sudah ditentukan (Jakarta).
          </p>
        </div>

        <p style={{ fontSize: 16, lineHeight: 1.8, color: '#d4d9df', marginBottom: 36 }}>
          Tim customer service merekomendasikan agar penumpang yang hendak melakukan perjalanan jauh berangkat dari kota Surabaya, karena rute tersebut memiliki jadwal penerbangan paling fleksibel bulan ini. Untuk mendapatkan harga terbaik, penerbangan disarankan pada tanggal 20 November 2026. Mengingat durasi perjalanan yang panjang, kelas Bisnis direkomendasikan agar penumpang tetap nyaman selama di udara.
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div>
            <label style={{ fontSize: 13, color: '#9aa3b0', fontFamily: 'var(--mono)' }}>Kota asal</label>
            <input type="text" value={origin} onChange={(e) => setOrigin(e.target.value)} disabled={!cameraActive || taskEnded} required placeholder="Nama kota" style={{ width: '100%', marginTop: 8, padding: '13px 14px', borderRadius: 8, border: '1px solid #232b34', background: '#0d1117', color: '#fff' }} />
          </div>
          <div>
            <label style={{ fontSize: 13, color: '#9aa3b0', fontFamily: 'var(--mono)' }}>Kota tujuan (sudah ditentukan)</label>
            <input type="text" value="Jakarta" disabled style={{ width: '100%', marginTop: 8, padding: '13px 14px', borderRadius: 8, border: '1px solid #232b34', background: '#0d1117', color: '#888' }} />
          </div>
          <div>
            <label style={{ fontSize: 13, color: '#9aa3b0', fontFamily: 'var(--mono)' }}>Tanggal berangkat</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={!cameraActive || taskEnded} required style={{ width: '100%', marginTop: 8, padding: '13px 14px', borderRadius: 8, border: '1px solid #232b34', background: '#0d1117', color: '#fff' }} />
          </div>
          <div>
            <label style={{ fontSize: 13, color: '#9aa3b0', fontFamily: 'var(--mono)' }}>Kelas</label>
            <select value={kelas} onChange={(e) => setKelas(e.target.value)} disabled={!cameraActive || taskEnded} required style={{ width: '100%', marginTop: 8, padding: '13px 14px', borderRadius: 8, border: '1px solid #232b34', background: '#0d1117', color: '#fff' }}>
              <option value="">— pilih —</option>
              <option>Ekonomi</option>
              <option>Bisnis</option>
              <option>Eksekutif</option>
            </select>
          </div>
          <button type="submit" disabled={!cameraActive || taskEnded} style={{ marginTop: 12, padding: '15px 20px', borderRadius: 8, border: 'none', background: '#3fd0c9', color: '#04231f', fontWeight: 700, cursor: 'pointer', opacity: (!cameraActive || taskEnded) ? 0.5 : 1 }}>Selesaikan Pemesanan</button>
        </form>

        {resultText && (
          <div style={{ marginTop: 28, padding: '16px 18px', borderRadius: 8, border: '1px solid rgba(63,208,201,.35)', background: 'rgba(63,208,201,.08)', fontFamily: 'var(--mono)', fontSize: 13, color: '#3fd0c9' }}>
            {resultText}
          </div>
        )}
      </div>

      {/* Telemetry Sidebar */}
      <div style={{ position: 'fixed', bottom: 20, right: 20, width: 200, background: '#0d1117', border: '1px solid #232b34', borderRadius: 10, padding: 12, fontFamily: 'var(--mono)', fontSize: 11, color: '#9aa3b0', zIndex: 100 }}>
        <div style={{ fontSize: 10, textTransform: 'uppercase', color: '#c7d0da', marginBottom: 8 }}>Monitoring Fisiologis</div>
        <div style={{ width: '100%', aspectRatio: '4/3', background: '#000', borderRadius: 6, overflow: 'hidden', marginBottom: 8, border: '1px solid #232b34' }}>
          <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
        </div>
        <button onClick={startCV} disabled={cameraActive} style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #232b34', background: '#161d28', color: '#fff', fontSize: 11, cursor: 'pointer', marginBottom: 6 }}>
          {cameraActive ? 'Berjalan…' : 'Aktifkan Kamera'}
        </button>
        <div style={{ fontSize: 10, marginBottom: 6 }}>{status}</div>
        
        {loadScore !== null && (
          <>
            <div style={{ textAlign: 'center', padding: '4px 0 6px' }}>
              <div style={{ fontSize: 28, fontWeight: 600, color: loadScore > 0.58 ? '#ef5b5b' : loadScore > 0.3 ? '#f2a154' : '#3fd0c9' }}>
                {(loadScore * 100).toFixed(0)}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>EAR</span><span>{metrics.ear}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Blink/5s</span><span>{metrics.blink}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Saccade</span><span>{metrics.saccade}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Gaze disp.</span><span>{metrics.disp}</span></div>
            </div>
            <button onClick={exportCSV} style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #232b34', background: '#161d28', color: '#fff', fontSize: 11, cursor: 'pointer' }}>Unduh Data (CSV)</button>
          </>
        )}
      </div>
    </div>
  );
}