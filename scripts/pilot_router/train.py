#!/usr/bin/env python
"""Train + calibrate + export the real Pilot `pilot-v1` model (T7).

One command builds the shipped artifact plus its diagnostics:

    uv run --group pilot-train --extra recommended \\
        python scripts/pilot_router/train.py

Pipeline (all values locked by spec §6.6 — NO search of any kind):

1. Load corpus + labels, inner-join on ``turn_id``, keep train/val only. The
   test split is NEVER read for training or calibration (T9 owns it).
2. Build ``float32 [N, 392]`` features through T1's ``build_features`` with the
   PRODUCTION ``_MiniLMEncoder`` (imported from ``pilot.strategy`` — not a third
   encoder). Features are cached to a git-ignored ``.feature_cache/`` keyed by a
   fingerprint of (corpus sha, feature contract) so retrains are instant.
3. Train the fixed ``Pipeline(StandardScaler, MLPClassifier(256, 64))`` with
   GOLD-class sample weights (R0=1,R1=1,R2=2,R3=3) at seed 42 (the shipped
   artifact) plus diagnostic replicas at seeds 7 and 2026.
4. Fit log-space temperature ``T`` on the VALIDATION split only.
5. Evaluate on validation (accuracy, per-class recall, severity-weighted
   under-routing, 15-bin ECE) for the shipped seed and every diagnostic; emit a
   3-seed mean±std stability table.
6. Export seed 42 → ``scripts/pilot_router/artifacts/pilot_v1/`` (git-ignored
   STAGING). The artifact lands in the shipped location only after T9 passes.
7. Write ``training_meta.json`` (git-tracked) with all metrics + provenance.

Diagnostics never touch the test split; no seed is selected by score — seed 42
ships regardless of the stability numbers.
"""

from __future__ import annotations

import hashlib
import json
import platform
import subprocess
import sys
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

# Running as a script (``python scripts/pilot_router/train.py``) does not put the
# repo root on sys.path, so the ``scripts`` package is not importable. Add it so
# the sibling ``scripts.pilot_router.*`` imports below resolve either way (script
# invocation or ``python -m``).
_REPO_ROOT_FOR_PATH = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT_FOR_PATH) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT_FOR_PATH))

from agentos.agentos_router.pilot.features import FEATURE_DIM  # noqa: E402
from scripts.pilot_router.export_model import (  # noqa: E402
    PILOT_VERSION,
    export_artifact,
)
from scripts.pilot_router.train_lib import (  # noqa: E402
    CLASSES,
    DIAGNOSTIC_SEEDS,
    SAMPLE_WEIGHT_BY_CLASS,
    SHIP_SEED,
    Row,
    build_feature_matrix,
    evaluate,
    fit_temperature,
    load_split_rows,
    resample_train,
    train_pipeline,
)

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parents[1]

CORPUS_PATH = _HERE / "data" / "corpus.jsonl"
LABELS_PATH = _HERE / "data" / "labels.jsonl"
LABELS_META_PATH = _HERE / "labels_meta.json"
CACHE_DIR = _HERE / ".feature_cache"
STAGING_DIR = _HERE / "artifacts" / "pilot_v1"
TRAINING_META_PATH = _HERE / "training_meta.json"

#: Shipped resampling decision (spec §6.2). "none": balance is carried entirely
#: by GOLD-class sample weights; no TRAIN rows are duplicated. Val/test natural.
RESAMPLE_STRATEGY = "none"

#: Pinned pilot-train dep versions recorded in the manifest (contract, spec §6.6).
_PINNED_DEPS = (
    "scikit-learn>=1.8,<1.9",
    "skl2onnx>=1.17",
    "onnxruntime>=1.17",
)


# --- Provenance helpers ------------------------------------------------------


def _git_sha() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=_REPO_ROOT,
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip()
    except Exception:
        return "unknown"


def _installed_versions() -> dict[str, str]:
    versions: dict[str, str] = {}
    for mod in ("sklearn", "skl2onnx", "onnxruntime", "numpy"):
        try:
            m = __import__(mod)
            versions[mod] = getattr(m, "__version__", "unknown")
        except Exception:
            versions[mod] = "unavailable"
    return versions


def _corpus_fingerprint() -> str:
    """sha256 over the corpus + labels bytes + the feature contract width.

    Keys the feature cache — any change to the data or the 392-dim contract
    invalidates it, so a stale cache can never silently poison a retrain.
    """
    h = hashlib.sha256()
    h.update(CORPUS_PATH.read_bytes())
    h.update(LABELS_PATH.read_bytes())
    h.update(f"dim={FEATURE_DIM}".encode())
    return h.hexdigest()[:16]


# --- Feature cache -----------------------------------------------------------


def _build_or_load_features(
    split: str,
    rows: list[Row],
    encoder: Any,
    fingerprint: str,
) -> tuple[np.ndarray, np.ndarray]:
    """Build features for ``rows``, caching to a git-ignored .npz on disk."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE_DIR / f"{split}_{fingerprint}.npz"
    if cache_path.is_file():
        data = np.load(cache_path)
        x, y = data["x"].astype(np.float32), data["y"].astype(np.int64)
        if x.shape == (len(rows), FEATURE_DIM) and len(y) == len(rows):
            print(f"  [{split}] loaded cached features {x.shape}")
            return x, y
        print(f"  [{split}] cache shape stale ({x.shape}); rebuilding")
    t0 = time.perf_counter()
    x, y = build_feature_matrix(rows, encoder)
    dt = time.perf_counter() - t0
    print(f"  [{split}] built features {x.shape} in {dt:.1f}s")
    np.savez(cache_path, x=x, y=y)
    return x, y


# --- Stability aggregation ---------------------------------------------------


@dataclass
class SeedResult:
    seed: int
    temperature: float
    accuracy: float
    per_class_recall: dict[str, float]
    severity_weighted_underrouting: float
    ece_before: float
    ece_after: float
    nll_before: float
    nll_after: float
    confusion: list[list[int]]


def _mean_std(values: list[float]) -> dict[str, float]:
    arr = np.asarray(values, dtype=np.float64)
    return {"mean": float(arr.mean()), "std": float(arr.std(ddof=0))}


def _stability_table(results: list[SeedResult]) -> dict[str, Any]:
    table: dict[str, Any] = {
        "seeds": [r.seed for r in results],
        "accuracy": _mean_std([r.accuracy for r in results]),
        "severity_weighted_underrouting": _mean_std(
            [r.severity_weighted_underrouting for r in results]
        ),
        "ece_after": _mean_std([r.ece_after for r in results]),
        "temperature": _mean_std([r.temperature for r in results]),
        "per_class_recall": {},
    }
    for cls in CLASSES:
        table["per_class_recall"][cls] = _mean_std(
            [r.per_class_recall[cls] for r in results]
        )
    return table


# --- Train one seed ----------------------------------------------------------


def _train_one_seed(
    seed: int,
    x_train: np.ndarray,
    y_train: np.ndarray,
    x_val: np.ndarray,
    y_val: np.ndarray,
) -> tuple[SeedResult, Any, Any]:
    xt, yt = resample_train(x_train, y_train, seed=seed, strategy=RESAMPLE_STRATEGY)
    pipe = train_pipeline(xt, yt, seed=seed)
    clf = pipe.named_steps["clf"]

    val_probs = pipe.predict_proba(x_val).astype(np.float32)
    before = evaluate(val_probs, y_val)

    temperature = fit_temperature(val_probs, y_val)
    # Apply the fitted T the same way PilotModel does, then re-evaluate.
    from scripts.pilot_router.train_lib import _softmax_temp

    cal_probs = _softmax_temp(val_probs, temperature).astype(np.float32)
    after = evaluate(cal_probs, y_val)

    result = SeedResult(
        seed=seed,
        temperature=temperature,
        accuracy=after.accuracy,
        per_class_recall=after.per_class_recall,
        severity_weighted_underrouting=after.severity_weighted_underrouting,
        ece_before=before.ece,
        ece_after=after.ece,
        nll_before=before.nll,
        nll_after=after.nll,
        confusion=after.confusion,
    )
    return result, pipe, clf


# --- Main --------------------------------------------------------------------


def main() -> int:
    print("Pilot pilot-v1 training (T7)")
    print(f"  corpus:  {CORPUS_PATH}")
    print(f"  labels:  {LABELS_PATH}")
    print(f"  staging: {STAGING_DIR}")

    rows = load_split_rows(CORPUS_PATH, LABELS_PATH)
    train_rows, val_rows = rows["train"], rows["val"]
    print(f"  rows: train={len(train_rows)} val={len(val_rows)} (test untouched)")

    # Import the PRODUCTION encoder — not a third implementation (spec §6.6).
    from agentos.agentos_router.pilot.strategy import _MiniLMEncoder

    encoder = _MiniLMEncoder()
    fingerprint = _corpus_fingerprint()
    print(f"  feature fingerprint: {fingerprint}")

    x_train, y_train = _build_or_load_features("train", train_rows, encoder, fingerprint)
    x_val, y_val = _build_or_load_features("val", val_rows, encoder, fingerprint)

    if x_train.shape[1] != FEATURE_DIM or x_val.shape[1] != FEATURE_DIM:
        raise SystemExit(f"392-dim parity violation: {x_train.shape} / {x_val.shape}")

    # Seed 42 first (the shipped artifact), then diagnostics.
    print(f"\nTraining seed {SHIP_SEED} (SHIPPED) ...")
    ship_result, ship_pipe, ship_clf = _train_one_seed(
        SHIP_SEED, x_train, y_train, x_val, y_val
    )
    _print_seed(ship_result)

    diag_results: list[SeedResult] = []
    for seed in DIAGNOSTIC_SEEDS:
        print(f"\nTraining diagnostic seed {seed} ...")
        res, _, _ = _train_one_seed(seed, x_train, y_train, x_val, y_val)
        _print_seed(res)
        diag_results.append(res)

    all_results = [ship_result, *diag_results]
    stability = _stability_table(all_results)
    _print_stability(stability)

    # --- Assemble training stats + provenance for the manifest ---
    labels_meta = json.loads(LABELS_META_PATH.read_text(encoding="utf-8"))
    split_class_counts = {
        split: dict(Counter(r.label for r in split_rows))
        for split, split_rows in (("train", train_rows), ("val", val_rows))
    }
    training_stats = {
        "pilot_version": PILOT_VERSION,
        "ship_seed": SHIP_SEED,
        "diagnostic_seeds": list(DIAGNOSTIC_SEEDS),
        "architecture": "Pipeline(StandardScaler, MLPClassifier(hidden_layer_sizes=(256, 64)))",
        "sample_weight_policy": dict(SAMPLE_WEIGHT_BY_CLASS),
        "resample_strategy": RESAMPLE_STRATEGY,
        "resample_note": (
            "TRAIN not resampled; class balance carried by GOLD-class sample "
            "weights only. Validation/test kept at natural distribution (spec §6.2)."
        ),
        "set_sizes": {"train": len(train_rows), "val": len(val_rows)},
        "class_balance_per_split": split_class_counts,
        "val_metrics_seed42": {
            "accuracy": ship_result.accuracy,
            "per_class_recall": ship_result.per_class_recall,
            "severity_weighted_underrouting": ship_result.severity_weighted_underrouting,
            "ece_before_calibration": ship_result.ece_before,
            "ece_after_calibration": ship_result.ece_after,
            "nll_before_calibration": ship_result.nll_before,
            "nll_after_calibration": ship_result.nll_after,
            "fitted_temperature": ship_result.temperature,
            "confusion_gold_by_pred": ship_result.confusion,
        },
        "seed_stability": stability,
        "labeling": {
            "labeler_pin": labels_meta.get("labeler_pin"),
            "label_model": labels_meta.get("label_model"),
            "rubric_sha256": labels_meta.get("rubric_sha256"),
            "labels_file_sha256": labels_meta.get("labels_file", {}).get("labels.jsonl"),
        },
        "git_sha": _git_sha(),
        "training_scripts": [
            "scripts/pilot_router/train.py",
            "scripts/pilot_router/train_lib.py",
            "scripts/pilot_router/export_model.py",
        ],
        "pinned_deps": list(_PINNED_DEPS),
        "installed_versions": _installed_versions(),
        "feature_fingerprint": fingerprint,
        "hardware": platform.platform(),
        "python": platform.python_version(),
    }

    # --- Export the SHIPPED seed-42 artifact to staging ---
    print(f"\nExporting seed-{SHIP_SEED} artifact → {STAGING_DIR}")
    onnx_path, manifest_path = export_artifact(
        ship_pipe,
        ship_clf,
        STAGING_DIR,
        temperature=ship_result.temperature,
        training_stats=training_stats,
    )
    print(f"  wrote {onnx_path} ({onnx_path.stat().st_size} bytes)")
    print(f"  wrote {manifest_path}")

    # --- training_meta.json (git-tracked, no artifacts) ---
    TRAINING_META_PATH.write_text(
        json.dumps(training_stats, indent=2) + "\n", encoding="utf-8"
    )
    print(f"  wrote {TRAINING_META_PATH}")

    # --- Loadability check via the production loader ---
    _verify_load(STAGING_DIR, x_val)

    print("\nDONE — seed-42 artifact staged; T9 owns the eval gate.")
    return 0


def _verify_load(staging_dir: Path, x_val: np.ndarray) -> None:
    from agentos.agentos_router.pilot.model import PilotModel

    model = PilotModel(staging_dir)
    if not model.available:
        raise SystemExit(f"staged artifact failed to load: {model.unavailable_reason}")
    probs = model.predict_proba(x_val[:8])
    assert probs.shape == (min(8, len(x_val)), 4), probs.shape
    row_sums = probs.sum(axis=1)
    assert np.allclose(row_sums, 1.0, atol=1e-4), row_sums
    print(f"  PilotModel load OK; smoke predict {probs.shape}, rows sum to 1")


def _print_seed(r: SeedResult) -> None:
    recall = " ".join(f"{c}={r.per_class_recall[c]:.3f}" for c in CLASSES)
    print(
        f"  seed {r.seed}: acc={r.accuracy:.4f}  recall[{recall}]  "
        f"sev_under={r.severity_weighted_underrouting:.4f}  "
        f"ECE {r.ece_before:.4f}->{r.ece_after:.4f}  T={r.temperature:.4f}"
    )


def _print_stability(s: dict[str, Any]) -> None:
    print("\n3-seed stability (mean ± std over seeds "
          f"{s['seeds']}):")
    print(f"  accuracy:  {s['accuracy']['mean']:.4f} ± {s['accuracy']['std']:.4f}")
    print(
        "  sev_under: "
        f"{s['severity_weighted_underrouting']['mean']:.4f} ± "
        f"{s['severity_weighted_underrouting']['std']:.4f}"
    )
    print(f"  ECE(cal):  {s['ece_after']['mean']:.4f} ± {s['ece_after']['std']:.4f}")
    print(f"  T:         {s['temperature']['mean']:.4f} ± {s['temperature']['std']:.4f}")
    for cls in CLASSES:
        m = s["per_class_recall"][cls]
        print(f"  recall {cls}: {m['mean']:.4f} ± {m['std']:.4f}")


if __name__ == "__main__":
    sys.exit(main())
