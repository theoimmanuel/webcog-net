"""
train_model.py

Trains the 1D CNN-GRU architecture on physiological time-series exported
from Scenario A (label=0) and Scenario B (label=1), then converts it to a
quantized TensorFlow.js model in Next.js's public folder.
"""
import glob
import os
import json
import numpy as np
import tensorflow as tf

WINDOW_LEN = 30          # timesteps per training window (~30s of 1Hz samples)
STRIDE = 5               # step between windows when slicing long sessions
FEATURES = ["ear", "blink", "saccade", "dispersion"]
N_FEATURES = len(FEATURES)


def load_session_csv(path):
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
        raise RuntimeError("No data found under data/scenario_a/ or data/scenario_b/.")
    print(f"Loading {len(a_files)} Scenario A sessions and {len(b_files)} Scenario B sessions...")
    for path in a_files:
        arr = load_session_csv(path)
        w, l = windows_from_session(arr, label=0)
        X.extend(w); y.extend(l)
    for path in b_files:
        arr = load_session_csv(path)
        w, l = windows_from_session(arr, label=1)
        X.extend(w); y.extend(l)
    return np.stack(X), np.array(y, dtype=np.float32)


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
    print(f"Total windows: {X.shape[0]} (shape: {X.shape[1:]})")

    mean = X.reshape(-1, N_FEATURES).mean(axis=0)
    std = X.reshape(-1, N_FEATURES).std(axis=0)
    X = normalize_features(X, mean, std)

    # Destination paths for Next.js App Router public folder
    public_model_dir = "my-app/public/model"
    tfjs_output_dir = os.path.join(public_model_dir, "tfjs")
    os.makedirs(tfjs_output_dir, exist_ok=True)

    with open(os.path.join(public_model_dir, "model_norm_stats.json"), "w") as f:
        json.dump({
            "features": FEATURES,
            "window_len": WINDOW_LEN,
            "mean": mean.tolist(),
            "std": std.tolist(),
        }, f, indent=2)

    idx = np.random.permutation(len(X))
    X, y = X[idx], y[idx]
    split = int(0.8 * len(X))
    X_train, X_val = X[:split], X[split:]
    y_train, y_val = y[:split], y[split:]

    model = build_model()
    model.summary()

    model.fit(
        X_train, y_train,
        validation_data=(X_val, y_val),
        epochs=30,
        batch_size=16,
        verbose=2,
    )

    os.makedirs("model", exist_ok=True)
    model.save("model/webcog_net.h5")

    print("\nConverting to TensorFlow.js (quantized) format...")
    from tensorflowjs.converters import keras_h5_conversion as tfjs_conv
    tfjs_conv.save_keras_model(model, tfjs_output_dir, quantization_dtype_map={"uint8": "*"})

    print(f"Export completed to '{public_model_dir}'!")


if __name__ == "__main__":
    main()