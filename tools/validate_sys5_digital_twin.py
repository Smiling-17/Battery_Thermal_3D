#!/usr/bin/env python
"""Validate processed System 5 digital-twin files against schema v2."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from build_sys5_digital_twin import FRAME_COLUMNS, PROCESSOR_VERSION, SCHEMA_VERSION, file_fingerprint


MAX_OVERVIEW_BYTES = 50 * 1024 * 1024


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--processed", type=Path, default=Path("simulation_3d/processed"))
    return parser.parse_args()


def load_json(path: Path):
    if not path.exists():
        raise FileNotFoundError(f"Missing file: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def assert_fingerprint_current(manifest: dict, name: str) -> None:
    recorded = manifest["source_files"][name]
    current = file_fingerprint(Path(recorded["path"]))
    for key in ("sha256", "size_bytes", "mtime_ns"):
        assert current[key] == recorded[key], f"{name} fingerprint mismatch for {key}; rebuild processed data"


def validate_frame(payload: dict, manifest: dict) -> dict:
    columns = payload["columns"]
    frames = payload["frames"]
    assert frames, "Chunk has no frames"
    assert columns == manifest["columns"]["frame"]
    assert columns == FRAME_COLUMNS

    col = {name: idx for idx, name in enumerate(columns)}
    first = frames[0]

    for cell in range(1, 9):
        i_cell = first[col[f"i_cell_{cell}"]]
        i_batt = first[col["i_batt"]]
        i_cnv = first[col[f"i_cnv_{cell}"]]
        assert abs(i_cell - (i_batt + i_cnv)) < 1e-4
        assert first[col[f"q_ohmic_{cell}"]] >= 0
        assert 0 <= first[col[f"risk_cell_{cell}"]] <= 1
        assert first[col[f"confidence_cell_{cell}"]] in (0, 1, 2, 3)
        assert first[col[f"flags_cell_{cell}"]] >= 0
        assert first[col[f"r0_source_{cell}"]] in (0, 1, 2, 3)

    assert columns[col["temp_1"]] == "temp_1"
    assert first[col["risk"]] == first[col["pack_risk"]]
    assert first[col["confidence"]] == first[col["pack_confidence"]]
    assert first[col["flags"]] == first[col["pack_flags"]]
    assert 0 <= first[col["pack_risk"]] <= 1
    assert first[col["pack_confidence"]] in (0, 1, 2, 3)
    assert first[col["thermal_reset"]] in (0, 1)

    return {
        "date": payload.get("date"),
        "frames": len(frames),
        "first_timestamp": first[col["ts"]],
    }


def main() -> None:
    args = parse_args()
    manifest = load_json(args.processed / "manifest.json")

    assert manifest["schema_version"] == SCHEMA_VERSION
    assert manifest["processor_version"] == PROCESSOR_VERSION
    assert manifest["sensor_mapping"]["Temperature_1"] == "interface Cell 1-2"
    assert manifest["duplicate_rows"] >= 0
    assert manifest["aggregated_rows"] > 0
    assert manifest["physics"]["cell_current"] == "I_cell_i = I_Battery + I_CNV_Cell_i"
    assert manifest["physics"]["predictor_assimilation_gain"] == 0.0
    assert manifest["physics"]["observer_assimilation_gain"] > 0.0
    assert manifest["physics"]["thermal_params"]["source"] in ("bounded_search_fit", "least_squares_fit", "bounded_default")
    if manifest["aggregated_rows"] >= 100:
        assert manifest["physics"]["thermal_params"]["source"] != "bounded_default"
    assert "r0_source_codes" in manifest["physics"]

    for name in ("csv", "ocv", "processor"):
        assert_fingerprint_current(manifest, name)

    thermal_validation = manifest["thermal_validation"]
    assert thermal_validation["predictor_holdout_mean_rmse_c"] >= 0
    assert thermal_validation["observer_residual_mean_rmse_c"] >= 0
    assert thermal_validation["predictor_holdout_rmse_c"] != thermal_validation["observer_residual_rmse_c"]
    assert thermal_validation["predictor_holdout_rows"] > 0

    heat_scale = manifest["heat_scale"]
    assert heat_scale["scale"] == "linear_clipped_at_p99"
    assert heat_scale["q_max_observed"] >= heat_scale["q_p99"] >= heat_scale["q_p95"] >= 0
    assert manifest["ranges"]["q_ohmic"][1] == heat_scale["display_max"]

    chunks = manifest["chunks"]
    assert chunks, "No daily chunks generated"

    overview_path = args.processed / "overview_daily.json"
    assert overview_path.exists(), "Missing browser-friendly overview_daily.json"
    assert overview_path.stat().st_size < MAX_OVERVIEW_BYTES, "Overview exceeds 50MB target"

    sample_chunks = [chunks[0], chunks[len(chunks) // 2], chunks[-1]]
    seen = set()
    frame_summaries = []
    for chunk in sample_chunks:
        if chunk["date"] in seen:
            continue
        seen.add(chunk["date"])
        payload = load_json(args.processed / chunk["path"])
        frame_summaries.append(validate_frame(payload, manifest))

    print(json.dumps({
        "status": "ok",
        "schema_version": manifest["schema_version"],
        "processor_version": manifest["processor_version"],
        "chunks": len(chunks),
        "overview_daily_mb": round(overview_path.stat().st_size / 1024 / 1024, 3),
        "thermal_params_source": manifest["physics"]["thermal_params"]["source"],
        "predictor_holdout_mean_rmse_c": thermal_validation["predictor_holdout_mean_rmse_c"],
        "observer_residual_mean_rmse_c": thermal_validation["observer_residual_mean_rmse_c"],
        "q_p99_w": heat_scale["q_p99"],
        "q_max_observed_w": heat_scale["q_max_observed"],
        "sampled_chunks": frame_summaries,
    }, indent=2))


if __name__ == "__main__":
    main()
