# WebCog-Net

Zero-transmission, client-side web interface for detecting cognitive workload using real-time webcam telemetry and a 1D CNN-GRU model.

---

## Repository Structure

```text
webcog-net/
├── my-app/                       # Next.js App Router Application
│   ├── app/
│   │   ├── layout.tsx            # Global Root Layout
│   │   ├── globals.css           # Global Custom Properties & Styles
│   │   ├── scenario-a/page.tsx   # Scenario A — Baseline (Low Workload)
│   │   ├── scenario-b/page.tsx   # Scenario B — Static Clutter (High Workload)
│   │   └── scenario-c/page.tsx   # Scenario C — Adaptive Interface (WebCog-Net)
│   └── public/
│       ├── images/               # Static task illustrations
│       └── model/
│           ├── model_norm_stats.json # Feature normalization statistics
│           └── model.json    # Quantized TF.js CNN-GRU architecture
├── src/
│   ├── generate_synthetic_data.py # Synthetic data generator for demo/pipeline tests
│   └── train_model.py            # PyTorch/Keras training & TF.js conversion script
├── public/                       # Legacy static HTML scenarios
├── .gitignore
└── README.md
```

## Model Workflow
```text
[ Webcam Feed ] 
      │
      ▼
[ 1. Facial Landmark Tracking ]  ──> MediaPipe FaceLandmarker (WASM)
      │
      ▼
[ 2. Ocular Feature Extraction ] ──> EAR, Blink Rate, Saccade Velocity, Gaze Dispersion
      │
      ▼
[ 3. Continuous 1D CNN-GRU ]     ──> TensorFlow.js (Runs locally on rolling 30-frame window)
      │
      ▼
[ 4. Stage State Machine ]       ──> Score [0–1] triggers Stage 3 (Full Clutter) ➔ Stage 1 (Basic)
      │
      ▼
[ 5. Dynamic DOM Adaptation ]   ──> Hysteresis-controlled CSS transitions & decluttering
```

1. Local Computer Vision Telemetry (MediaPipe WASM): Captures raw webcam frames entirely within browser memory (zero cloud transmission for privacy)  

2. Ocular Feature Extraction: Computes four key physiological indicators of mental workload in real time:  
- EAR (Eye Aspect Ratio): Tracks eye aperture stability  
- Blink Rate: Detects blink suppression during intense visual search  
- Saccade Velocity: Measures peak eye-movement speed relative to a calibrated personal baseline  
- Gaze Dispersion: Quantifies micro-jitter/fixation instability across a 5-second sliding window  

3. Real-Time Machine Learning Inference (1D CNN-GRU): Pushes feature samples into a 30-frame rolling window tensor to continuously classify cognitive distress scores between 0.0 (calm) and 1.0 (high distress)  

4. Dynamic Closed-Loop UI Adaptation  
- Stage 3 (Distress < 0.30): Full visual clutter (ads, popups, promotional banners, dark background)  
- Stage 2 (Distress 0.30–0.58): Moderate decluttering (popups removed, muted contrast background)
- Stage 1 (Distress > 0.58): Maximum simplification ("reader mode", bright high-contrast theme, ads hidden)