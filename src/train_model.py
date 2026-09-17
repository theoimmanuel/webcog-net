"""
train_model.py

Trains the 1D CNN-GRU architecture described in the paper (Bab 3.3) on
physiological time-series exported from Scenario A (label=0, low distress)
and Scenario B (label=1, static high distress), then converts it to a
quantized TensorFlow.js model for deployment into Scenario C.

USAGE:
    python3 generate_synthetic_data.py      # only if you have no real data yet
    python3 train_model.py

INPUT DATA FORMAT (must match what scenario-a.html / scenario-b.html export):
    data/scenario_a/*.csv   <- label 0 (low distress / baseline)
    data/scenario_b/*.csv   <- label 1 (static high distress)

    Each CSV has 4 leading '#'-prefixed summary lines, then a header row,
    then columns: t_task_s, ear, blink, saccade, dispersion, score
    ('score' is the OLD heuristic's output and is intentionally NOT used as
    an input feature here — the entire point of this script is to replace
    that heuristic with a trained model.)

OUTPUT:
    model/webcog_net.h5           <- Keras model
    model/tfjs/                   <- quantized TF.js model for the browser
"""
import glob
import os

import numpy as np
import tensorflow as tf

WINDOW_LEN = 30          # timesteps per training window (~30s of 1Hz samples)
STRIDE = 5               # step between windows when slicing long sessions
FEATURES = ["ear", "blink", "saccade", "dispersion"]  # 'score' excluded on purpose
N_FEATURES = len(FEATURES)


def load_session_csv(path):
    """Parses one exported CSV, skipping the '#' summary lines."""
    with open(path, "r") as f:
        lines = [l for l in f.read().splitlines() if l and not l.startswith("#")]
    header = lines[0].split(",")
    idx = {name: header.index(name) for name in FEATURES}
    rows = []
    for line in lines[1:]:
        parts = line.split(",")
        rows.append([float(parts[idx[name]]) for name in FEATURES])
    return np.array(rows, dtype=np.float32)


def normalize_features(X, mean, std):
    return (X - mean) / (std + 1e-8)


def windows_from_session(session_array, label):
    """Slices one session's [T, N_FEATURES] array into fixed-length,
    overlapping windows for training. Sessions shorter than WINDOW_LEN are
    padded (repeat-last) since the paper's own sliding window is 5s and we
    are being generous with 30s here to give the GRU more temporal context."""
    T = session_array.shape[0]
    windows, labels = [], []
    if T < WINDOW_LEN:
        pad = np.repeat(session_array[-1:], WINDOW_LEN - T, axis=0)
        windows.append(np.concatenate([session_array, pad], axis=0))
        labels.append(label)
        return windows, labels
    for start in range(0, T - WINDOW_LEN + 1, STRIDE):
        windows.append(session_array[start:start + WINDOW_LEN])
        labels.append(label)
    return windows, labels


def load_dataset():
    X, y = [], []
    a_files = sorted(glob.glob("data/scenario_a/*.csv"))
    b_files = sorted(glob.glob("data/scenario_b/*.csv"))
    if not a_files or not b_files:
        raise RuntimeError(
            "No data found under data/scenario_a/ or data/scenario_b/. "
            "Run generate_synthetic_data.py for a placeholder demo, or place "
            "real exported CSVs in those folders first."
        )
    print(f"Loading {len(a_files)} Scenario A sessions (label=0) and {len(b_files)} Scenario B sessions (label=1)...")
    for path in a_files:
        arr = load_session_csv(path)
        w, l = windows_from_session(arr, label=0)
        X.extend(w); y.extend(l)
    for path in b_files:
        arr = load_session_csv(path)
        w, l = windows_from_session(arr, label=1)
        X.extend(w); y.extend(l)
    X = np.stack(X); y = np.array(y, dtype=np.float32)
    return X, y


def build_model():
    model = tf.keras.Sequential([
        tf.keras.layers.Input(shape=(WINDOW_LEN, N_FEATURES)),
        tf.keras.layers.Conv1D(16, 3, activation="relu", padding="same"),
        tf.keras.layers.MaxPooling1D(2),
        tf.keras.layers.GRU(16),
        tf.keras.layers.Dense(8, activation="relu"),
        tf.keras.layers.Dense(1, activation="sigmoid"),
    ])
    model.compile(optimizer="adam", loss="binary_crossentropy", metrics=["accuracy"])
    return model


def main():
    X, y = load_dataset()
    print(f"Total windows: {X.shape[0]} (shape per window: {X.shape[1:]})")

    # normalize using training-set statistics (computed BEFORE the split to
    # keep this script simple — for a real study, compute stats on the
    # training fold only, to avoid leaking validation info)
    mean = X.reshape(-1, N_FEATURES).mean(axis=0)
    std = X.reshape(-1, N_FEATURES).std(axis=0)
    X = normalize_features(X, mean, std)
    np.save("model_norm_mean.npy", mean)
    np.save("model_norm_std.npy", std)
    import json
    with open("model_norm_stats.json", "w") as f:
        json.dump({
            "features": FEATURES,
            "window_len": WINDOW_LEN,
            "mean": mean.tolist(),
            "std": std.tolist(),
        }, f, indent=2)

    # shuffle + split
    idx = np.random.permutation(len(X))
    X, y = X[idx], y[idx]
    split = int(0.8 * len(X))
    X_train, X_val = X[:split], X[split:]
    y_train, y_val = y[:split], y[split:]

    model = build_model()
    model.summary()

    history = model.fit(
        X_train, y_train,
        validation_data=(X_val, y_val),
        epochs=30,
        batch_size=16,
        verbose=2,
    )

    val_acc = history.history["val_accuracy"][-1]
    print(f"\nFinal validation accuracy: {val_acc:.3f}")
    print("REMINDER: this number reflects SYNTHETIC placeholder data unless you")
    print("have already replaced data/scenario_a and data/scenario_b with real")
    print("exported participant CSVs. It is not a measurement of H1 until then.")

    os.makedirs("model", exist_ok=True)
    model.save("model/webcog_net.h5")

    # report parameter count / rough size, relevant to the paper's <50KB target (H1)
    param_count = model.count_params()
    print(f"Model parameter count: {param_count}")

    print("\nConverting to TensorFlow.js (quantized) format...")
    # NOTE: using the tensorflowjs Python API directly rather than the
    # `tensorflowjs_converter` CLI. In this environment the CLI's import
    # chain pulls in tensorflow_decision_forests, which has an unrelated
    # protobuf version conflict that has nothing to do with this model.
    # save_keras_model() sidesteps that import path entirely.
    from tensorflowjs.converters import keras_h5_conversion as tfjs_conv
    os.makedirs("model/tfjs", exist_ok=True)
    tfjs_conv.save_keras_model(model, "model/tfjs", quantization_dtype_map={"uint8": "*"})

    tfjs_size = sum(
        os.path.getsize(os.path.join("model/tfjs", f))
        for f in os.listdir("model/tfjs")
    )
    print(f"TF.js model directory size: {tfjs_size / 1024:.2f} KB (target per H1: < 50KB)")


if __name__ == "__main__":
    main()
