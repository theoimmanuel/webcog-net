'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import * as tf from '@tensorflow/tfjs';

const TIME_LIMIT_SECONDS = 90;
const CORRECT_ANSWERS = { origin: 'surabaya', date: '2026-11-20', kelas: 'bisnis' };

const LEFT_EYE = [33, 160, 158, 133, 153, 144];
const RIGHT_EYE = [362, 385, 387, 263, 373, 380];
const LEFT_IRIS_CENTER = 468;
const RIGHT_IRIS_CENTER = 473;

const WINDOW_LEN = 30; // 30 time steps for CNN-GRU input window

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function calcEAR(lm: any[], idx: number[]) {
  const [p1, p2, p3, p4, p5, p6] = idx.map((i) => lm[i]);
  return (dist(p2, p6) + dist(p3, p5)) / (2.0 * dist(p1, p4));
}

export default function ScenarioCPage() {
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState(3);
  const [status, setStatus] = useState('Status: menunggu izin kamera…');
  const [clockText, setClockText] = useState('menunggu kamera…');
  const [loadScore, setLoadScore] = useState<number | null>(null);
  const [showPopup, setShowPopup] = useState(false);
  const [taskEnded, setTaskEnded] = useState(false);
  const [resultText, setResultText] = useState('');

  const [metrics, setMetrics] = useState({ ear: '–', blink: '–', saccade: '–', disp: '–', buffer: 0, latency: '–' });

  const [origin, setOrigin] = useState('');
  const [date, setDate] = useState('');
  const [kelas, setKelas] = useState('');

  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const startTimeRef = useRef<number | null>(null);

  const trainedModelRef = useRef<any>(null);
  const normStatsRef = useRef<any>(null);
  const sequenceBufferRef = useRef<any[]>([]);
  const isInferringRef = useRef(false);

  const bufferRef = useRef<{ samples: any[] }>({ samples: [] });
  const baselineRef = useRef<{ blink: number | null; saccade: number | null }>({ blink: null, saccade: null });
  const calibratingRef = useRef(true);
  const animFrameRef = useRef<number | null>(null);

  const endTask = useCallback((timedOut: boolean) => {
    setTaskEnded(true);
    setRunning(false);

    if (videoRef.current?.srcObject) {
      (videoRef.current.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
    }

    const completionSeconds = startTimeRef.current
      ? Math.min((performance.now() - startTimeRef.current) / 1000, TIME_LIMIT_SECONDS)
      : null;

    let correct = 0;
    if (origin.trim().toLowerCase() === CORRECT_ANSWERS.origin) correct++;
    if (date === CORRECT_ANSWERS.date) correct++;
    if (kelas.trim().toLowerCase() === CORRECT_ANSWERS.kelas) correct++;

    setResultText(
      (timedOut ? `Waktu habis (${TIME_LIMIT_SECONDS}s). ` : '') +
      (completionSeconds !== null ? `Task Completion Time: ${completionSeconds.toFixed(2)} detik. ` : '') +
      `Akurasi: ${correct}/3 benar.`
    );
  }, [origin, date, kelas]);

  useEffect(() => {
    if (!running || taskEnded) return;
    const interval = setInterval(() => {
      if (!startTimeRef.current) return;
      const elapsed = (performance.now() - startTimeRef.current) / 1000;
      const remaining = Math.max(0, TIME_LIMIT_SECONDS - elapsed);
      setClockText(`sisa waktu: ${remaining.toFixed(1)}s`);
      if (remaining <= 0) endTask(true);
    }, 100);
    return () => clearInterval(interval);
  }, [running, taskEnded, endTask]);

  const updateStage = (score: number) => {
    setStage((prev) => {
      let next = prev;
      if (prev === 3 && score > 0.30) next = 2;
      else if (prev === 2 && score > 0.58) next = 1;
      else if (prev === 1 && score < 0.46) next = 2;
      else if (prev === 2 && score < 0.20) next = 3;

      if (next === 3 && prev !== 3) {
        setTimeout(() => setShowPopup(true), 4000);
      } else if (next !== 3) {
        setShowPopup(false);
      }
      return next;
    });
  };

  // Runs continuous real-time CNN-GRU inference over the rolling 30-frame window
  const runRealtimeInference = () => {
    if (
      !trainedModelRef.current ||
      !normStatsRef.current ||
      sequenceBufferRef.current.length < WINDOW_LEN ||
      isInferringRef.current
    ) {
      return null;
    }

    isInferringRef.current = true;
    try {
      const { mean, std } = normStatsRef.current;
      const scoreVal = tf.tidy(() => {
        const windowData = sequenceBufferRef.current.map((sample) => [
          (sample.ear - mean[0]) / (std[0] + 1e-8),
          (sample.blink - mean[1]) / (std[1] + 1e-8),
          (sample.saccade - mean[2]) / (std[2] + 1e-8),
          (sample.dispersion - mean[3]) / (std[3] + 1e-8),
        ]);
        const inputTensor = tf.tensor3d([windowData], [1, WINDOW_LEN, 4]);
        const outputTensor = trainedModelRef.current.predict(inputTensor) as tf.Tensor;
        return outputTensor.dataSync()[0];
      });

      return Math.max(0, Math.min(1, scoreVal));
    } catch (err) {
      console.error('Inference error:', err);
      return null;
    } finally {
      isInferringRef.current = false;
    }
  };

  const startPipeline = async () => {
    setStatus('Status: memuat model MediaPipe (WASM)…');
    try {
      const filesetResolver = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
      const landmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        refineLandmarks: true,
      });

      // Load trained CNN-GRU model & normalization stats from public folder
      try {
        const [model, statsResp] = await Promise.all([
          tf.loadLayersModel('/model/tfjs/model.json'),
          fetch('/model/model_norm_stats.json'),
        ]);
        trainedModelRef.current = model;
        normStatsRef.current = await statsResp.json();
      } catch (e) {
        console.warn('Trained CNN-GRU model not found in /model/tfjs/, falling back to heuristic.');
      }

      setStatus('Status: meminta izin kamera…');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 360, facingMode: 'user' }, audio: false });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await new Promise((res) => (videoRef.current!.onloadedmetadata = res));
        videoRef.current.play();
      }

      setRunning(true);
      startTimeRef.current = performance.now();
      setStatus('Status: kamera aktif — mengkalibrasi baseline…');

      const loop = () => {
        const t0 = performance.now();
        const nowMs = performance.now();

        if (videoRef.current && videoRef.current.readyState >= 2) {
          const result = landmarker.detectForVideo(videoRef.current, nowMs);
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
            if (samples.length >= 3) {
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

              // Maintain sequence buffer for CNN-GRU model
              sequenceBufferRef.current.push({
                ear: meanEAR,
                blink: blinks,
                saccade: meanSaccade,
                dispersion: gazeDispersion,
              });
              if (sequenceBufferRef.current.length > WINDOW_LEN) {
                sequenceBufferRef.current.shift();
              }

              if (calibratingRef.current && samples.length > 15) {
                baselineRef.current.blink = Math.max(blinks, 1);
                baselineRef.current.saccade = Math.max(meanSaccade, 0.01);
                calibratingRef.current = false;
              }

              // Heuristic score fallback
              const blinkRef = baselineRef.current.blink ?? 3;
              const saccadeRef = baselineRef.current.saccade ?? 0.05;
              const heuristicScore = Math.max(0, Math.min(1, 0.34 * Math.max(0, 1 - blinks / blinkRef) + 0.30 * Math.max(0, 1 - meanSaccade / saccadeRef) + 0.24 * Math.min(1, gazeDispersion / 0.014) + 0.12 * (meanEAR > 0.24 ? 0.5 : 0.2)));

              // Try real-time CNN-GRU model inference; use heuristic if model score is null
              const modelScore = runRealtimeInference();
              const activeScore = modelScore !== null ? modelScore : heuristicScore;

              setLoadScore(activeScore);
              updateStage(activeScore);

              setMetrics({
                ear: meanEAR.toFixed(3),
                blink: String(blinks),
                saccade: meanSaccade.toFixed(3),
                disp: gazeDispersion.toFixed(4),
                buffer: samples.length,
                latency: (performance.now() - t0).toFixed(1),
              });
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

  const getThemeStyles = () => {
    if (stage === 1) return { bg: '#ffffff', text: '#14171c' };
    if (stage === 2) return { bg: '#c9c4b8', text: '#26241f' };
    return { bg: '#0b0f14', text: '#e6ecf2' };
  };

  const theme = getThemeStyles();

  return (
    <div style={{ background: '#0b0f14', color: '#e6ecf2', minHeight: '100vh' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', padding: '16px 24px', background: '#121821', borderBottom: '1px solid #232c3a' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 14 }}><b>WebCog-Net</b></div>
        <div style={{ fontSize: 11, color: '#3fd0c9', border: '1px solid rgba(63,208,201,.35)', padding: '5px 10px', borderRadius: 20 }}>Privasi Terjaga</div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', minHeight: 'calc(100vh - 57px)' }}>
        <aside style={{ background: '#121821', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ position: 'relative', width: '100%', aspectRatio: '4/3', background: '#000', borderRadius: 10, overflow: 'hidden' }}>
            <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
            <canvas ref={overlayRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', transform: 'scaleX(-1)' }} />
          </div>

          <button onClick={startPipeline} disabled={running} style={{ padding: '11px 14px', borderRadius: 8, border: 'none', background: '#3fd0c9', color: '#04231f', fontWeight: 600, cursor: 'pointer' }}>
            {running ? 'Berjalan…' : 'Aktifkan kamera & mulai'}
          </button>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: '#7c8aa0' }}>{clockText}</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: '#7c8aa0' }}>{status}</div>

          {loadScore !== null && (
            <div style={{ textAlign: 'center', padding: '12px 0 4px' }}>
              <div style={{ fontSize: 40, fontWeight: 600, color: stage === 1 ? '#ef5b5b' : stage === 2 ? '#f2a154' : '#3fd0c9' }}>
                {(loadScore * 100).toFixed(0)}
              </div>
            </div>
          )}

          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>Blink drop: {metrics.blink}</div>
            <div>Saccade: {metrics.saccade}</div>
            <div>Dispersion: {metrics.disp}</div>
            <div>EAR: {metrics.ear}</div>
            <div>Samples: {metrics.buffer}</div>
            <div>Latency: {metrics.latency} ms</div>
          </div>
        </aside>

        <main style={{ background: theme.bg, color: theme.text, padding: '36px 44px 80px', transition: 'all 0.5s ease' }}>
          <div style={{ maxWidth: 920 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, padding: '3px 9px', borderRadius: 20, border: '1px solid #232c3a' }}>
              Stage {stage} · {stage === 3 ? 'Clutter penuh' : stage === 2 ? 'Clutter menengah' : 'Basic'}
            </span>

            <h1 style={{ fontSize: 30, fontWeight: 700, margin: '14px 0' }}>Panduan Lengkap Merencanakan Perjalanan Jauh</h1>

            <div style={{ background: '#161d28', border: '1px solid #232c3a', borderLeft: '3px solid #3fd0c9', borderRadius: 8, padding: '14px 16px', marginBottom: 20, color: '#e6ecf2' }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#3fd0c9', marginBottom: 6 }}>🎯 Tugas Anda</div>
              <p style={{ fontSize: 13, margin: 0 }}>Baca artikel di bawah, lalu isi formulir menggunakan <strong>3 informasi yang disebutkan dalam teks</strong>: kota keberangkatan, tanggal keberangkatan, dan kelas penerbangan yang direkomendasikan. Kota tujuan sudah ditentukan (Jakarta).</p>
            </div>

            {stage === 3 && (
              <div style={{ background: 'linear-gradient(90deg,#ff5c5c,#ffd166,#ff5c5c)', color: '#1a0505', padding: '14px 18px', borderRadius: 10, fontWeight: 700, marginBottom: 20, textAlign: 'center' }}>
                ⚡ FLASH SALE HARI INI SAJA — DISKON 70%! KLIK SEKARANG ⚡
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: stage === 1 ? '1fr' : '1fr 240px', gap: 22 }}>
              <div>
                <p>Merencanakan perjalanan jauh membutuhkan persiapan matang, mulai dari anggaran, akomodasi, hingga barang bawaan.</p>
                <p>Langkah pertama adalah menentukan anggaran total. Sebagai contoh, agen perjalanan merekomendasikan penerbangan berangkat dari kota Surabaya karena harga dan jadwalnya paling kompetitif musim ini.</p>
                <p>Untuk rute ini, penerbangan disarankan pada tanggal 20 November 2026, sebelum musim ramai dan kenaikan harga dimulai.</p>
                <p>Mengingat durasi perjalanan yang panjang, kelas Bisnis direkomendasikan agar tetap nyaman selama penerbangan.</p>

                <form style={{ background: '#161d28', padding: 20, borderRadius: 10, marginTop: 24, color: '#e6ecf2' }}>
                  <h3>Formulir Pemesanan</h3>
                  <label style={{ display: 'block', fontSize: 12, margin: '12px 0 6px' }}>Kota asal</label>
                  <input type="text" value={origin} onChange={(e) => setOrigin(e.target.value)} disabled={!running || taskEnded} required placeholder="Nama kota" style={{ width: '100%', padding: '10px 12px', borderRadius: 7, border: '1px solid #232c3a', background: '#0b0f14', color: '#fff' }} />

                  <label style={{ display: 'block', fontSize: 12, margin: '12px 0 6px' }}>Kota tujuan (sudah ditentukan)</label>
                  <input type="text" value="Jakarta" disabled style={{ width: '100%', padding: '10px 12px', borderRadius: 7, border: '1px solid #232c3a', background: '#0b0f14', color: '#888' }} />

                  <label style={{ display: 'block', fontSize: 12, margin: '12px 0 6px' }}>Tanggal berangkat</label>
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={!running || taskEnded} required style={{ width: '100%', padding: '10px 12px', borderRadius: 7, border: '1px solid #232c3a', background: '#0b0f14', color: '#fff' }} />

                  <label style={{ display: 'block', fontSize: 12, margin: '12px 0 6px' }}>Kelas</label>
                  <select value={kelas} onChange={(e) => setKelas(e.target.value)} disabled={!running || taskEnded} required style={{ width: '100%', padding: '10px 12px', borderRadius: 7, border: '1px solid #232c3a', background: '#0b0f14', color: '#fff' }}>
                    <option value="">— pilih —</option>
                    <option>Ekonomi</option>
                    <option>Bisnis</option>
                    <option>Eksekutif</option>
                  </select>

                  <button type="button" onClick={() => endTask(false)} disabled={!running || taskEnded} style={{ marginTop: 16, width: '100%', padding: '11px 14px', borderRadius: 8, border: 'none', background: '#3fd0c9', color: '#04231f', fontWeight: 600, cursor: 'pointer', opacity: (!running || taskEnded) ? 0.5 : 1 }}>
                    Selesaikan Pemesanan
                  </button>
                  {resultText && <div style={{ marginTop: 14, padding: '12px 14px', borderRadius: 8, background: 'rgba(63,208,201,.08)', color: '#3fd0c9', fontSize: 12 }}>{resultText}</div>}
                </form>
              </div>

              {stage !== 1 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={{ background: '#2a1d3d', padding: 15, borderRadius: 10, fontSize: 12, color: '#e0b3d6' }}>Diskon hotel hingga 40%! Booking sekarang.</div>
                  {stage === 3 && <div style={{ background: '#3d1d2c', padding: 15, borderRadius: 10, fontSize: 12, color: '#e0b3d6' }}>🔥 5 destinasi tersembunyi yang wajib dikunjungi!</div>}
                </div>
              )}
            </div>
          </div>
        </main>
      </div>

      {showPopup && stage === 3 && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 40 }}>
          <div style={{ width: 320, background: '#121821', border: '1px solid #ef5b5b', borderRadius: 14, padding: 22, textAlign: 'center' }}>
            <h4>Jangan lewatkan!</h4>
            <p style={{ color: '#7c8aa0', fontSize: 13 }}>Daftar newsletter kami dan dapatkan kupon diskon 15%.</p>
            <button onClick={() => setShowPopup(false)} style={{ width: '100%', padding: 10, borderRadius: 8, border: 'none', background: '#ef5b5b', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>Nanti saja</button>
          </div>
        </div>
      )}
    </div>
  );
}