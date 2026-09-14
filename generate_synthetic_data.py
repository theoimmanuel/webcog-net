"""
generate_synthetic_data.py

Produces PLACEHOLDER training data shaped exactly like the CSV files that
scenario-a.html and scenario-b.html export via their "Unduh Data (CSV)"
button, so the training pipeline can be demonstrated end-to-end before any
real participant data exists.

THIS DATA IS FABRICATED. It encodes the same directional assumptions already
baked into the hand-tuned heuristic (blink suppression, saccade slowdown,
rising gaze dispersion under distress) purely so a model has something
learnable to demonstrate the pipeline works mechanically. It has ZERO
empirical validity and must not be used to support any accuracy claim
(including H1). Replace the contents of data/scenario_a/ and
data/scenario_b/ with real exported CSVs from actual participant sessions
before training a model that means anything.
"""
import csv
import os
import random

random.seed(42)

N_SESSIONS_PER_SCENARIO = 40
OUT_DIR = "data"


def make_session_a(session_id):
    """Scenario A (baseline): stable, calm signal, no strong trend over time."""
    duration = random.randint(40, 90)
    rows = []
    for t in range(1, duration + 1):
        ear = max(0.05, random.gauss(0.29, 0.015))
        blink = max(0, min(7, round(random.gauss(4.0, 1.0))))
        saccade = max(0.001, random.gauss(0.10, 0.02))
        dispersion = max(0.0005, random.gauss(0.006, 0.0015))
        score = 0.0  # discarded during training — see train_model.py
        rows.append([t, round(ear, 3), blink, round(saccade, 4), round(dispersion, 5), score])
    completion_time = round(duration - random.uniform(0, 5), 2)
    accuracy = random.choice(["3/3", "3/3", "2/3"])  # baseline: mostly accurate
    return rows, completion_time, accuracy


def make_session_b(session_id):
    """Scenario B (static, high distress): rising-distress trend over the session
    — blink suppression, saccade slowdown, increasing gaze dispersion — encoded
    as a linear ramp so a sequence model (GRU) has real temporal structure to
    learn from, rather than just a static mean-shift a simpler classifier could
    already capture."""
    duration = random.randint(40, 90)
    rows = []
    for t in range(1, duration + 1):
        progress = t / duration
        ear = max(0.05, random.gauss(0.29, 0.02))
        blink_mean = 4.0 - 2.5 * progress
        blink = max(0, min(7, round(random.gauss(blink_mean, 0.8))))
        saccade_mean = 0.10 - 0.05 * progress
        saccade = max(0.001, random.gauss(saccade_mean, 0.02))
        dispersion_mean = 0.006 + 0.012 * progress
        dispersion = max(0.0005, random.gauss(dispersion_mean, 0.002))
        score = 0.0
        rows.append([t, round(ear, 3), blink, round(saccade, 4), round(dispersion, 5), score])
    timed_out = random.random() < 0.35  # distress condition: more timeouts
    completion_time = duration if timed_out else round(duration - random.uniform(0, 3), 2)
    accuracy = random.choice(["1/3", "2/3", "2/3", "0/3"])  # distress: worse accuracy
    return rows, completion_time, accuracy, timed_out


def write_csv(path, scenario_label, rows, completion_time, accuracy, timed_out=False):
    with open(path, "w", newline="") as f:
        f.write(f"# scenario={scenario_label}\n")
        f.write(f"# task_completion_time_s={completion_time}\n")
        f.write(f"# task_timed_out={'true' if timed_out else 'false'}\n")
        f.write(f"# task_accuracy={accuracy}\n")
        writer = csv.writer(f)
        writer.writerow(["t_task_s", "ear", "blink", "saccade", "dispersion", "score"])
        writer.writerows(rows)


def main():
    os.makedirs(f"{OUT_DIR}/scenario_a", exist_ok=True)
    os.makedirs(f"{OUT_DIR}/scenario_b", exist_ok=True)

    for i in range(N_SESSIONS_PER_SCENARIO):
        rows, completion_time, accuracy = make_session_a(i)
        write_csv(f"{OUT_DIR}/scenario_a/participant_{i:02d}.csv", "A", rows, completion_time, accuracy)

    for i in range(N_SESSIONS_PER_SCENARIO):
        rows, completion_time, accuracy, timed_out = make_session_b(i)
        write_csv(f"{OUT_DIR}/scenario_b/participant_{i:02d}.csv", "B", rows, completion_time, accuracy, timed_out)

    print(f"Generated {N_SESSIONS_PER_SCENARIO} synthetic sessions each for Scenario A and B under '{OUT_DIR}/'.")
    print("Reminder: this data is FABRICATED placeholder data — replace with real exported CSVs before training a model you intend to draw conclusions from.")


if __name__ == "__main__":
    main()
