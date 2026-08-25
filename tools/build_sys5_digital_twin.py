#!/usr/bin/env python
"""Build lightweight physics-informed digital-twin data for battery system 5.

The raw CSV is field data, not a complete electrochemical/thermal model input.
This pipeline keeps measured quantities separate from estimated quantities and
records validation metrics so the viewer can avoid presenting estimates as truth.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd


SCHEMA_VERSION = 2
PROCESSOR_VERSION = "2.0.0"
R0_SOURCE_CODES = {
    0: "valid_current_frame",
    1: "rolling_recent",
    2: "rolling_stale",
    3: "global_fallback",
}
LOW_CONFIDENCE_RMSE_C = 2.0
INVALID_CONFIDENCE_RMSE_C = 5.0

EXPECTED_COLUMNS = [
    "Timestamp",
    "U_Battery",
    "I_Battery",
    "SOC_Battery",
    "Temperature_1",
    "Temperature_2",
    "Temperature_3",
    "Temperature_4",
    "U_CR",
    "I_CR",
    "U_Cell_1",
    "I_CNV_Cell_1",
    "U_Cell_2",
    "I_CNV_Cell_2",
    "U_Cell_3",
    "I_CNV_Cell_3",
    "U_Cell_4",
    "I_CNV_Cell_4",
    "U_Cell_5",
    "I_CNV_Cell_5",
    "U_Cell_6",
    "I_CNV_Cell_6",
    "U_Cell_7",
    "I_CNV_Cell_7",
    "U_Cell_8",
    "I_CNV_Cell_8",
]

TEMP_COLS = [f"Temperature_{i}" for i in range(1, 5)]
CELL_COLS = [f"U_Cell_{i}" for i in range(1, 9)]
CNV_COLS = [f"I_CNV_Cell_{i}" for i in range(1, 9)]
BASE_COLS = ["U_Battery", "I_Battery", "SOC_Battery", *TEMP_COLS, *CELL_COLS, *CNV_COLS]
PAIR_SENSOR_FOR_CELL = np.array([0, 0, 1, 1, 2, 2, 3, 3])

FRAME_COLUMNS = [
    "ts",
    "u_batt",
    "i_batt",
    "soc",
    "temp_1",
    "temp_2",
    "temp_3",
    "temp_4",
    *[f"u_cell_{i}" for i in range(1, 9)],
    *[f"i_cnv_{i}" for i in range(1, 9)],
    *[f"i_cell_{i}" for i in range(1, 9)],
    *[f"r0_{i}" for i in range(1, 9)],
    *[f"q_ohmic_{i}" for i in range(1, 9)],
    *[f"t_est_{i}" for i in range(1, 9)],
    "cell_spread",
    "voltage_residual",
    "max_q",
    "risk",
    "confidence",
    "flags",
    "duplicate_rows",
    "thermal_reset",
    "pack_risk",
    "pack_confidence",
    "pack_flags",
    *[f"risk_cell_{i}" for i in range(1, 9)],
    *[f"confidence_cell_{i}" for i in range(1, 9)],
    *[f"flags_cell_{i}" for i in range(1, 9)],
    *[f"r0_age_min_{i}" for i in range(1, 9)],
    *[f"r0_source_{i}" for i in range(1, 9)],
]

OVERVIEW_COLUMNS = [
    "ts",
    "frame_count",
    "u_batt_min",
    "u_batt_max",
    "u_batt_mean",
    "i_batt_min",
    "i_batt_max",
    "i_batt_mean",
    "soc_min",
    "soc_max",
    "soc_mean",
    "temp_mean_min",
    "temp_mean_max",
    "temp_mean_mean",
    "max_t_est_min",
    "max_t_est_max",
    "max_t_est_mean",
    "max_q_min",
    "max_q_max",
    "max_q_mean",
    "pack_risk_min",
    "pack_risk_max",
    "pack_risk_mean",
    "pack_confidence_max",
]


@dataclass
class ThermalParams:
    c_eff: float
    k_adj: float
    h_loss: float
    q_scale: float
    assimilation_gain: float
    ambient_c: float
    source: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", type=Path, default=Path("data/data_sys_5.csv"))
    parser.add_argument("--ocv", type=Path, default=Path("data/ocv_linear_approx.csv"))
    parser.add_argument("--out", type=Path, default=Path("simulation_3d/processed"))
    parser.add_argument("--daily-interval", default="1min")
    parser.add_argument("--overview-interval", default="1D")
    parser.add_argument("--chunksize", type=int, default=500_000)
    parser.add_argument("--max-calibration-rows", type=int, default=20_000)
    parser.add_argument("--max-days", type=int, default=0, help="0 means all days")
    parser.add_argument("--keep-existing", action="store_true")
    return parser.parse_args()


def read_ocv(path: Path) -> tuple[np.ndarray, np.ndarray]:
    if not path.exists():
        raise FileNotFoundError(
            f"Missing OCV source: {path}. Copy BattGP data/ocv_linear_approx.csv "
            "to data/ocv_linear_approx.csv before building the digital twin."
        )
    df = pd.read_csv(path)
    if list(df.columns) != ["SOC", "OCV"]:
        raise ValueError("OCV file must have columns: SOC,OCV")
    return df["SOC"].to_numpy(float), df["OCV"].to_numpy(float)


def file_fingerprint(path: Path) -> dict[str, str | int]:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(block)
    stat = path.stat()
    return {
        "path": str(path.as_posix()),
        "size_bytes": int(stat.st_size),
        "mtime_ns": int(stat.st_mtime_ns),
        "sha256": digest.hexdigest(),
    }


def validate_header(csv_path: Path) -> None:
    header = list(pd.read_csv(csv_path, nrows=0).columns)
    if header != EXPECTED_COLUMNS:
        raise ValueError(
            "Unexpected CSV header.\n"
            f"Expected: {EXPECTED_COLUMNS}\n"
            f"Actual:   {header}"
        )


def aggregate_csv(csv_path: Path, chunksize: int, daily_interval: str, overview_interval: str):
    daily_parts: list[pd.DataFrame] = []
    overview_parts: list[pd.DataFrame] = []
    daily_duplicate_parts: list[pd.Series] = []
    duplicate_rows = 0
    source_rows = 0
    prev_ts = None
    first_ts = None
    last_ts = None

    for chunk in pd.read_csv(csv_path, chunksize=chunksize, parse_dates=["Timestamp"]):
        source_rows += len(chunk)
        ts = chunk["Timestamp"]
        if first_ts is None:
            first_ts = ts.iloc[0]
        last_ts = ts.iloc[-1]

        boundary_duplicate_ts = ts.iloc[0] if prev_ts is not None and ts.iloc[0] == prev_ts else None
        if boundary_duplicate_ts is not None:
            duplicate_rows += 1
        duplicate_rows += int((ts.diff().dt.total_seconds() == 0).sum())
        prev_ts = ts.iloc[-1]

        grouped = chunk.groupby("Timestamp", sort=True)[BASE_COLS].median(numeric_only=True)
        duplicate_by_timestamp = chunk.groupby("Timestamp", sort=True).size().sub(1).clip(lower=0)
        if boundary_duplicate_ts is not None:
            duplicate_by_timestamp.loc[boundary_duplicate_ts] = duplicate_by_timestamp.get(boundary_duplicate_ts, 0) + 1
        daily_parts.append(grouped.resample(daily_interval).median().dropna(subset=["U_Battery"]))
        daily_duplicate_parts.append(duplicate_by_timestamp.resample(daily_interval).sum())
        overview_parts.append(
            grouped[
                [
                    "U_Battery",
                    "I_Battery",
                    "SOC_Battery",
                    *TEMP_COLS,
                    *CELL_COLS,
                    *CNV_COLS,
                ]
            ]
            .resample(overview_interval)
            .median()
            .dropna(subset=["U_Battery"])
        )

    daily = pd.concat(daily_parts).groupby(level=0).median(numeric_only=True).sort_index()
    overview = pd.concat(overview_parts).groupby(level=0).median(numeric_only=True).sort_index()
    daily_duplicates = pd.concat(daily_duplicate_parts).groupby(level=0).sum().sort_index()
    daily_duplicates = daily_duplicates.reindex(daily.index, fill_value=0).astype(int)

    if not daily.index.is_monotonic_increasing or not overview.index.is_monotonic_increasing:
        raise ValueError("Aggregated timestamps are not monotonic.")

    return daily, overview, daily_duplicates, {
        "source_rows": int(source_rows),
        "duplicate_rows": int(duplicate_rows),
        "duplicate_count": int(duplicate_rows),
        "time_start": first_ts.isoformat() if first_ts is not None else None,
        "time_end": last_ts.isoformat() if last_ts is not None else None,
    }


def compute_r0_and_heat(df: pd.DataFrame, ocv_soc: np.ndarray, ocv_v: np.ndarray) -> dict[str, np.ndarray]:
    cells = df[CELL_COLS].to_numpy(float)
    cnv = df[CNV_COLS].to_numpy(float)
    temps = df[TEMP_COLS].to_numpy(float)
    i_batt = df["I_Battery"].to_numpy(float)
    soc = df["SOC_Battery"].to_numpy(float)
    u_batt = df["U_Battery"].to_numpy(float)

    i_cell = i_batt[:, None] + cnv
    ocv = np.interp(np.clip(soc, ocv_soc.min(), ocv_soc.max()), ocv_soc, ocv_v)
    with np.errstate(divide="ignore", invalid="ignore"):
        r_raw = (cells - ocv[:, None]) / i_cell

    temp_for_cell = temps[:, PAIR_SENSOR_FOR_CELL]
    u_sum = cells.sum(axis=1)
    voltage_residual = u_sum - u_batt
    cell_spread = cells.max(axis=1) - cells.min(axis=1)
    valid = (
        (np.abs(i_cell) >= 5.0)
        & (soc[:, None] > 40.0)
        & (soc[:, None] < 95.0)
        & (temp_for_cell >= 10.0)
        & (temp_for_cell <= 45.0)
        & (np.abs(voltage_residual)[:, None] < 0.5)
        & (cells > 2.2)
        & (cells < 3.8)
        & np.isfinite(r_raw)
        & (r_raw > 0.0)
        & (r_raw < 0.2)
    )
    r_valid = np.where(valid, r_raw, np.nan)

    global_median = np.nanmedian(r_valid, axis=0)
    if np.any(~np.isfinite(global_median)):
        finite = global_median[np.isfinite(global_median)]
        fallback = float(np.nanmedian(finite)) if finite.size else 0.004
        global_median = np.where(np.isfinite(global_median), global_median, fallback)

    r0_cols = []
    r0_age_cols = []
    r0_source_cols = []
    index_series = pd.Series(df.index, index=df.index)
    for i in range(8):
        series = pd.Series(r_valid[:, i], index=df.index)
        rolling_no_fill = series.rolling("1D", min_periods=5).median().ffill()
        rolling = rolling_no_fill.fillna(global_median[i])
        last_valid_ts = index_series.where(series.notna()).ffill()
        age_min = (index_series - last_valid_ts).dt.total_seconds().div(60.0)
        age_min = age_min.fillna(-1.0).to_numpy(float)
        source = np.full(len(df), 1, dtype=int)
        source[series.notna().to_numpy()] = 0
        source[(age_min > 24 * 60) & np.isfinite(age_min)] = 2
        source[rolling_no_fill.isna().to_numpy()] = 3
        r0_cols.append(rolling.to_numpy(float))
        r0_age_cols.append(age_min)
        r0_source_cols.append(source)
    r0_est = np.column_stack(r0_cols)
    r0_age_min = np.column_stack(r0_age_cols)
    r0_source = np.column_stack(r0_source_cols)
    q_ohmic = np.maximum(i_cell * i_cell * r0_est, 0.0)

    low_current = np.abs(i_batt) < 0.2
    temp_mean = temps.mean(axis=1)
    ambient_candidates = temp_mean[low_current & np.isfinite(temp_mean)]
    if ambient_candidates.size < 100:
        ambient_candidates = temp_mean[np.isfinite(temp_mean)]
    ambient_c = float(np.nanpercentile(ambient_candidates, 5)) if ambient_candidates.size else 20.0

    return {
        "cells": cells,
        "cnv": cnv,
        "temps": temps,
        "i_batt": i_batt,
        "soc": soc,
        "u_batt": u_batt,
        "i_cell": i_cell,
        "r_raw": r_raw,
        "r0_est": r0_est,
        "r0_global_median": global_median,
        "r0_valid_mask": valid,
        "r0_age_min": r0_age_min,
        "r0_source": r0_source,
        "q_ohmic": q_ohmic,
        "voltage_residual": voltage_residual,
        "cell_spread": cell_spread,
        "ambient_c": ambient_c,
    }


def simulate_thermal_core(
    index: pd.DatetimeIndex,
    q_ohmic: np.ndarray,
    measured_temps: np.ndarray,
    params: ThermalParams,
    assimilation_gain: float,
    gap_seconds: float = 15 * 60,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    n = len(index)
    t_est = np.zeros((n, 8), dtype=float)
    sensor_hat = np.zeros((n, 4), dtype=float)
    resets = np.zeros(n, dtype=int)

    if n == 0:
        return t_est, sensor_hat, resets

    state = measured_temps[0, PAIR_SENSOR_FOR_CELL].astype(float).copy()
    last_ts = index[0]
    for row_idx, ts in enumerate(index):
        measured_cell = measured_temps[row_idx, PAIR_SENSOR_FOR_CELL]
        if row_idx == 0:
            dt = 0.0
        else:
            dt = float((ts - last_ts).total_seconds())
        if row_idx == 0 or dt <= 0 or dt > gap_seconds:
            state = measured_cell.astype(float).copy()
            resets[row_idx] = 1
        else:
            neighbor = np.zeros(8, dtype=float)
            for i in range(8):
                if i > 0:
                    neighbor[i] += state[i - 1] - state[i]
                if i < 7:
                    neighbor[i] += state[i + 1] - state[i]
            d_state = (
                params.q_scale * q_ohmic[row_idx]
                + params.k_adj * neighbor
                - params.h_loss * (state - params.ambient_c)
            ) * (dt / params.c_eff)
            state = state + d_state

        for pair_idx, (a, b) in enumerate(((0, 1), (2, 3), (4, 5), (6, 7))):
            prediction = 0.5 * (state[a] + state[b])
            error = measured_temps[row_idx, pair_idx] - prediction
            sensor_hat[row_idx, pair_idx] = prediction
            state[a] += assimilation_gain * error
            state[b] += assimilation_gain * error
            sensor_hat[row_idx, pair_idx] = 0.5 * (state[a] + state[b])

        t_est[row_idx] = state
        last_ts = ts

    return t_est, sensor_hat, resets


def simulate_thermal_predictor(
    index: pd.DatetimeIndex,
    q_ohmic: np.ndarray,
    measured_temps: np.ndarray,
    params: ThermalParams,
    gap_seconds: float = 15 * 60,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    return simulate_thermal_core(index, q_ohmic, measured_temps, params, assimilation_gain=0.0, gap_seconds=gap_seconds)


def simulate_thermal_observer(
    index: pd.DatetimeIndex,
    q_ohmic: np.ndarray,
    measured_temps: np.ndarray,
    params: ThermalParams,
    gap_seconds: float = 15 * 60,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    return simulate_thermal_core(
        index,
        q_ohmic,
        measured_temps,
        params,
        assimilation_gain=params.assimilation_gain,
        gap_seconds=gap_seconds,
    )


def blocked_holdout_mask(index: pd.DatetimeIndex, window_hours: int = 6, holdout_every: int = 5) -> np.ndarray:
    if len(index) == 0:
        return np.zeros(0, dtype=bool)
    elapsed_hours = (index - index[0]).total_seconds() / 3600.0
    window_id = np.floor(elapsed_hours / window_hours).astype(int)
    return (window_id % holdout_every) == (holdout_every - 1)


def thermal_error_metrics(predicted: np.ndarray, measured: np.ndarray) -> dict[str, list[float | None] | float]:
    residual = predicted - measured
    rmse = np.sqrt(np.nanmean(residual * residual, axis=0))
    mae = np.nanmean(np.abs(residual), axis=0)
    return {
        "rmse_c": round_list(rmse, 5),
        "mae_c": round_list(mae, 5),
        "mean_rmse_c": float(np.nanmean(rmse)),
        "mean_mae_c": float(np.nanmean(mae)),
    }


def validate_thermal_holdout(
    index: pd.DatetimeIndex,
    q_ohmic: np.ndarray,
    temps: np.ndarray,
    params: ThermalParams,
) -> dict[str, object]:
    holdout = blocked_holdout_mask(index)
    if np.sum(holdout) < 20:
        holdout = np.ones(len(index), dtype=bool)
    _, pred, resets = simulate_thermal_predictor(index[holdout], q_ohmic[holdout], temps[holdout], params)
    metrics = thermal_error_metrics(pred, temps[holdout])
    metrics["holdout_rows"] = int(np.sum(holdout))
    metrics["window_hours"] = 6
    metrics["holdout_every"] = 5
    metrics["thermal_reset_count"] = int(np.sum(resets))
    return metrics


def contiguous_sample_positions(length: int, max_rows: int, window_len: int = 288) -> np.ndarray:
    """Sample contiguous windows so RC dynamics are fit on real time evolution."""
    if length <= max_rows:
        return np.arange(length, dtype=int)
    window_len = max(12, min(window_len, max_rows, length))
    window_count = max(1, math.ceil(max_rows / window_len))
    starts = np.linspace(0, max(0, length - window_len), window_count, dtype=int)
    positions: list[int] = []
    for start in starts:
        remaining = max_rows - len(positions)
        if remaining <= 0:
            break
        stop = min(length, start + min(window_len, remaining))
        positions.extend(range(start, stop))
    return np.array(sorted(set(positions))[:max_rows], dtype=int)


def calibrate_thermal(index: pd.DatetimeIndex, q_ohmic: np.ndarray, temps: np.ndarray, ambient_c: float, max_rows: int) -> ThermalParams:
    defaults = ThermalParams(
        c_eff=80_000.0,
        k_adj=0.35,
        h_loss=0.08,
        q_scale=1.0,
        assimilation_gain=0.35,
        ambient_c=float(ambient_c),
        source="bounded_default",
    )
    if len(index) < 100:
        return defaults
    train_mask = ~blocked_holdout_mask(index)
    if np.sum(train_mask) < 100:
        train_mask = np.ones(len(index), dtype=bool)
    train_index = index[train_mask]
    train_q = q_ohmic[train_mask]
    train_temps = temps[train_mask]
    sample_idx = contiguous_sample_positions(len(train_index), max_rows)
    s_index = train_index[sample_idx]
    s_q = train_q[sample_idx]
    s_temps = train_temps[sample_idx]
    try:
        from scipy.optimize import least_squares
    except Exception:
        return bounded_thermal_search(s_index, s_q, s_temps, ambient_c, defaults)

    def unpack(x: np.ndarray) -> ThermalParams:
        return ThermalParams(
            c_eff=float(np.exp(x[0])),
            k_adj=float(np.exp(x[1])),
            h_loss=float(np.exp(x[2])),
            q_scale=float(np.exp(x[3])),
            assimilation_gain=defaults.assimilation_gain,
            ambient_c=float(ambient_c),
            source="least_squares_fit",
        )

    def residuals(x: np.ndarray) -> np.ndarray:
        params = unpack(x)
        _, pred, _ = simulate_thermal_predictor(s_index, s_q, s_temps, params)
        return (pred - s_temps).reshape(-1)

    x0 = np.array([
        math.log(defaults.c_eff),
        math.log(defaults.k_adj),
        math.log(defaults.h_loss),
        math.log(defaults.q_scale),
    ])
    lower = np.array([math.log(1_000.0), math.log(1e-4), math.log(1e-4), math.log(1e-4)])
    upper = np.array([math.log(1_000_000.0), math.log(20.0), math.log(20.0), math.log(100.0)])
    try:
        result = least_squares(residuals, x0, bounds=(lower, upper), max_nfev=80, loss="soft_l1")
        params = unpack(result.x)
        if not np.isfinite(result.cost):
            return bounded_thermal_search(s_index, s_q, s_temps, ambient_c, defaults)
        return params
    except Exception:
        return bounded_thermal_search(s_index, s_q, s_temps, ambient_c, defaults)


def bounded_thermal_search(
    index: pd.DatetimeIndex,
    q_ohmic: np.ndarray,
    temps: np.ndarray,
    ambient_c: float,
    defaults: ThermalParams,
) -> ThermalParams:
    """Small deterministic constrained search used when SciPy is unavailable."""
    if len(index) > 4_000:
        sample_idx = np.linspace(0, len(index) - 1, 4_000, dtype=int)
        index = index[sample_idx]
        q_ohmic = q_ohmic[sample_idx]
        temps = temps[sample_idx]

    bounds = {
        "c_eff": (5_000.0, 500_000.0),
        "k_adj": (1e-3, 5.0),
        "h_loss": (1e-3, 2.0),
        "q_scale": (1e-3, 50.0),
    }

    def clamp(name: str, value: float) -> float:
        lower, upper = bounds[name]
        return min(upper, max(lower, value))

    def make(c_eff: float, k_adj: float, h_loss: float, q_scale: float, source: str) -> ThermalParams:
        return ThermalParams(
            c_eff=clamp("c_eff", c_eff),
            k_adj=clamp("k_adj", k_adj),
            h_loss=clamp("h_loss", h_loss),
            q_scale=clamp("q_scale", q_scale),
            assimilation_gain=defaults.assimilation_gain,
            ambient_c=float(ambient_c),
            source=source,
        )

    def loss(params: ThermalParams) -> float:
        _, pred, _ = simulate_thermal_predictor(index, q_ohmic, temps, params)
        residual = pred - temps
        return float(np.nanmean(residual * residual))

    rng = np.random.default_rng(5)
    candidates = [defaults]
    for _ in range(180):
        candidates.append(
            make(
                float(np.exp(rng.uniform(math.log(bounds["c_eff"][0]), math.log(bounds["c_eff"][1])))),
                float(np.exp(rng.uniform(math.log(bounds["k_adj"][0]), math.log(bounds["k_adj"][1])))),
                float(np.exp(rng.uniform(math.log(bounds["h_loss"][0]), math.log(bounds["h_loss"][1])))),
                float(np.exp(rng.uniform(math.log(bounds["q_scale"][0]), math.log(bounds["q_scale"][1])))),
                "bounded_search_fit",
            )
        )

    best = min(candidates, key=loss)
    best_loss = loss(best)
    for _ in range(3):
        improved = False
        for name in ("c_eff", "k_adj", "h_loss", "q_scale"):
            value = getattr(best, name)
            for multiplier in (0.45, 0.7, 1.35, 2.2):
                candidate_kwargs = {
                    "c_eff": best.c_eff,
                    "k_adj": best.k_adj,
                    "h_loss": best.h_loss,
                    "q_scale": best.q_scale,
                }
                candidate_kwargs[name] = value * multiplier
                candidate = make(**candidate_kwargs, source="bounded_search_fit")
                candidate_loss = loss(candidate)
                if candidate_loss < best_loss:
                    best = candidate
                    best_loss = candidate_loss
                    improved = True
        if not improved:
            break

    if best.source == "bounded_default":
        return make(best.c_eff, best.k_adj, best.h_loss, best.q_scale, "bounded_search_fit")
    return best


def confidence_and_flags(
    features: dict[str, np.ndarray],
    resets: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    cells = features["cells"]
    temps = features["temps"]
    i_cell = features["i_cell"]
    r_valid = features["r0_valid_mask"]
    r0_source = features["r0_source"]
    voltage_residual = features["voltage_residual"]
    soc = features["soc"]
    q = features["q_ohmic"]
    cell_spread = features["cell_spread"]
    temp_for_cell = temps[:, PAIR_SENSOR_FOR_CELL]

    cell_flags = np.zeros(cells.shape, dtype=int)
    cell_flags |= resets[:, None].astype(bool) * 2
    low_current_cell = np.abs(i_cell) < 5.0
    cell_flags |= low_current_cell * 4
    voltage_mismatch = np.abs(voltage_residual) > 0.5
    cell_flags |= voltage_mismatch[:, None] * 8
    voltage_anomaly_cell = (cells < 2.2) | (cells > 3.8)
    cell_flags |= voltage_anomaly_cell * 16
    temp_anomaly_cell = (temp_for_cell < -10) | (temp_for_cell > 60)
    cell_flags |= temp_anomaly_cell * 32
    r0_invalid_cell = ~r_valid
    cell_flags |= r0_invalid_cell * 64
    soc_suspicious = ((soc > 95) & (np.nanmean(cells, axis=1) < 3.25)) | ((soc < 40) & (np.nanmean(cells, axis=1) > 3.35))
    cell_flags |= soc_suspicious[:, None] * 128
    r0_stale_or_fallback = r0_source >= 2
    cell_flags |= r0_stale_or_fallback * 256

    cell_confidence = np.zeros(cells.shape, dtype=int)
    cell_confidence[(low_current_cell | r0_invalid_cell | resets[:, None].astype(bool) | r0_stale_or_fallback)] = 2
    cell_confidence[(voltage_mismatch[:, None] | voltage_anomaly_cell | temp_anomaly_cell | soc_suspicious[:, None])] = 3

    pack_flags = np.zeros(len(cells), dtype=int)
    for bit in (2, 4, 8, 16, 32, 64, 128, 256):
        pack_flags |= (np.any((cell_flags & bit) != 0, axis=1) * bit)
    pack_confidence = np.nanmax(cell_confidence, axis=1).astype(int)

    q95 = float(np.nanpercentile(np.nanmax(q, axis=1), 95)) or 1.0
    median_voltage = np.nanmedian(cells, axis=1)
    temp_component = np.clip((temp_for_cell - 30.0) / 20.0, 0, 1)
    heat_component = np.clip(q / q95, 0, 1)
    voltage_component = np.clip(np.abs(cells - median_voltage[:, None]) / 0.12, 0, 1)
    risk_cell = np.clip(0.45 * temp_component + 0.3 * heat_component + 0.25 * voltage_component, 0, 1)
    pack_risk = np.nanmax(risk_cell, axis=1)
    return pack_confidence, pack_flags, pack_risk, cell_confidence, cell_flags, risk_cell


def round_list(values: Iterable[float], digits: int = 5) -> list[float | None]:
    out: list[float | None] = []
    for value in values:
        if value is None or not np.isfinite(value):
            out.append(None)
        else:
            out.append(round(float(value), digits))
    return out


def make_frame_rows(
    df: pd.DataFrame,
    features: dict[str, np.ndarray],
    t_est: np.ndarray,
    pack_confidence: np.ndarray,
    pack_flags: np.ndarray,
    pack_risk: np.ndarray,
    cell_confidence: np.ndarray,
    cell_flags: np.ndarray,
    risk_cell: np.ndarray,
    resets: np.ndarray,
    duplicate_rows: np.ndarray,
    row_indices: Iterable[int] | None = None,
) -> list[list[float | int | str | None]]:
    rows = []
    max_q = np.nanmax(features["q_ohmic"], axis=1)
    indices = range(len(df)) if row_indices is None else row_indices
    for idx in indices:
        ts = df.index[idx]
        row = [
            ts.isoformat(),
            round(float(features["u_batt"][idx]), 4),
            round(float(features["i_batt"][idx]), 5),
            round(float(features["soc"][idx]), 3),
            *round_list(features["temps"][idx], 3),
            *round_list(features["cells"][idx], 5),
            *round_list(features["cnv"][idx], 5),
            *round_list(features["i_cell"][idx], 5),
            *round_list(features["r0_est"][idx], 7),
            *round_list(features["q_ohmic"][idx], 5),
            *round_list(t_est[idx], 4),
            round(float(features["cell_spread"][idx]), 5),
            round(float(features["voltage_residual"][idx]), 5),
            round(float(max_q[idx]), 5),
            round(float(pack_risk[idx]), 5),
            int(pack_confidence[idx]),
            int(pack_flags[idx]),
            int(duplicate_rows[idx]),
            int(resets[idx]),
            round(float(pack_risk[idx]), 5),
            int(pack_confidence[idx]),
            int(pack_flags[idx]),
            *round_list(risk_cell[idx], 5),
            *[int(value) for value in cell_confidence[idx]],
            *[int(value) for value in cell_flags[idx]],
            *round_list(features["r0_age_min"][idx], 1),
            *[int(value) for value in features["r0_source"][idx]],
        ]
        rows.append(row)
    return rows


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))


def build_outputs(args: argparse.Namespace) -> None:
    validate_header(args.csv)
    ocv_soc, ocv_v = read_ocv(args.ocv)
    csv_fingerprint = file_fingerprint(args.csv)
    ocv_fingerprint = file_fingerprint(args.ocv)
    processor_fingerprint = file_fingerprint(Path(__file__))
    daily, overview_source, daily_duplicates, source_meta = aggregate_csv(args.csv, args.chunksize, args.daily_interval, args.overview_interval)
    if args.max_days > 0:
        keep_dates = sorted({d.date().isoformat() for d in daily.index})[: args.max_days]
        daily_mask = pd.Index(daily.index.strftime("%Y-%m-%d")).isin(keep_dates)
        overview_mask = pd.Index(overview_source.index.strftime("%Y-%m-%d")).isin(keep_dates)
        daily = daily[daily_mask]
        daily_duplicates = daily_duplicates[daily_mask]
        overview_source = overview_source[overview_mask]

    if args.out.exists() and not args.keep_existing:
        shutil.rmtree(args.out)
    raw_dir = args.out / "raw_daily"
    raw_dir.mkdir(parents=True, exist_ok=True)

    features = compute_r0_and_heat(daily, ocv_soc, ocv_v)
    calibration_df = daily.resample("5min").median().dropna(subset=["U_Battery"])
    calibration_features = compute_r0_and_heat(calibration_df, ocv_soc, ocv_v)
    params = calibrate_thermal(
        calibration_df.index,
        calibration_features["q_ohmic"],
        calibration_features["temps"],
        calibration_features["ambient_c"],
        args.max_calibration_rows,
    )
    predictor_validation = validate_thermal_holdout(
        calibration_df.index,
        calibration_features["q_ohmic"],
        calibration_features["temps"],
        params,
    )
    t_est, sensor_hat, resets = simulate_thermal_observer(daily.index, features["q_ohmic"], features["temps"], params)
    pack_confidence, pack_flags, pack_risk, cell_confidence, cell_flags, risk_cell = confidence_and_flags(features, resets)

    observer_metrics = thermal_error_metrics(sensor_hat, features["temps"])
    max_q = np.nanmax(features["q_ohmic"], axis=1)
    max_t_est = np.nanmax(t_est, axis=1)

    overview_base = pd.DataFrame(index=daily.index)
    overview_base["u_batt"] = features["u_batt"]
    overview_base["i_batt"] = features["i_batt"]
    overview_base["soc"] = features["soc"]
    overview_base["temp_mean"] = features["temps"].mean(axis=1)
    overview_base["max_t_est"] = max_t_est
    overview_base["max_q"] = max_q
    overview_base["pack_risk"] = pack_risk
    overview_base["pack_confidence"] = pack_confidence
    overview = overview_base.resample(args.overview_interval).agg({
        "u_batt": ["count", "min", "max", "mean"],
        "i_batt": ["min", "max", "mean"],
        "soc": ["min", "max", "mean"],
        "temp_mean": ["min", "max", "mean"],
        "max_t_est": ["min", "max", "mean"],
        "max_q": ["min", "max", "mean"],
        "pack_risk": ["min", "max", "mean"],
        "pack_confidence": ["max"],
    }).dropna()

    overview_rows = []
    for ts, row in overview.iterrows():
        overview_rows.append([
            ts.isoformat(),
            int(row[("u_batt", "count")]),
            round(float(row[("u_batt", "min")]), 4),
            round(float(row[("u_batt", "max")]), 4),
            round(float(row[("u_batt", "mean")]), 4),
            round(float(row[("i_batt", "min")]), 5),
            round(float(row[("i_batt", "max")]), 5),
            round(float(row[("i_batt", "mean")]), 5),
            round(float(row[("soc", "min")]), 3),
            round(float(row[("soc", "max")]), 3),
            round(float(row[("soc", "mean")]), 3),
            round(float(row[("temp_mean", "min")]), 3),
            round(float(row[("temp_mean", "max")]), 3),
            round(float(row[("temp_mean", "mean")]), 3),
            round(float(row[("max_t_est", "min")]), 4),
            round(float(row[("max_t_est", "max")]), 4),
            round(float(row[("max_t_est", "mean")]), 4),
            round(float(row[("max_q", "min")]), 5),
            round(float(row[("max_q", "max")]), 5),
            round(float(row[("max_q", "mean")]), 5),
            round(float(row[("pack_risk", "min")]), 5),
            round(float(row[("pack_risk", "max")]), 5),
            round(float(row[("pack_risk", "mean")]), 5),
            int(row[("pack_confidence", "max")]),
        ])
    write_json(args.out / "overview_daily.json", {"columns": OVERVIEW_COLUMNS, "frames": overview_rows})

    chunks = []
    duplicate_array = daily_duplicates.to_numpy(int)
    date_values = pd.Index(daily.index.strftime("%Y-%m-%d"))
    default_chunk = None
    default_chunk_risk = -np.inf
    for date in sorted(date_values.unique()):
        row_indices = np.flatnonzero(date_values.to_numpy() == date)
        frames = make_frame_rows(
            daily,
            features,
            t_est,
            pack_confidence,
            pack_flags,
            pack_risk,
            cell_confidence,
            cell_flags,
            risk_cell,
            resets,
            duplicate_array,
            row_indices=row_indices,
        )
        rel = f"raw_daily/{date}.json"
        write_json(args.out / rel, {"date": date, "columns": FRAME_COLUMNS, "frames": frames})
        chunk_meta = {
            "date": date,
            "path": rel,
            "rows": len(frames),
            "time_start": frames[0][0],
            "time_end": frames[-1][0],
        }
        chunks.append(chunk_meta)
        day_risk = float(np.nanmax(pack_risk[row_indices])) if row_indices.size else -np.inf
        if day_risk > default_chunk_risk:
            default_chunk_risk = day_risk
            default_chunk = chunk_meta

    ranges = {
        "u_batt": [float(np.nanmin(features["u_batt"])), float(np.nanmax(features["u_batt"]))],
        "i_batt": [float(np.nanmin(features["i_batt"])), float(np.nanmax(features["i_batt"]))],
        "soc": [float(np.nanmin(features["soc"])), float(np.nanmax(features["soc"]))],
        "temp_measured": [float(np.nanpercentile(features["temps"], 2)), float(np.nanpercentile(features["temps"], 98))],
        "temp_est": [float(np.nanpercentile(t_est, 2)), float(np.nanpercentile(t_est, 98))],
        "q_ohmic": [0.0, float(np.nanpercentile(max_q, 99))],
        "risk": [0.0, 1.0],
        "cell_spread": [float(np.nanmin(features["cell_spread"])), float(np.nanmax(features["cell_spread"]))],
    }
    q_stats = {
        "q_min": float(np.nanmin(max_q)),
        "q_p50": float(np.nanpercentile(max_q, 50)),
        "q_p95": float(np.nanpercentile(max_q, 95)),
        "q_p99": float(np.nanpercentile(max_q, 99)),
        "q_max_observed": float(np.nanmax(max_q)),
        "display_min": 0.0,
        "display_max": float(np.nanpercentile(max_q, 99)),
        "scale": "linear_clipped_at_p99",
        "unit": "W",
        "note": "Cell heat colors are clipped at p99 for visual contrast; frame metrics retain actual max_q.",
    }
    predictor_mean_rmse = float(predictor_validation["mean_rmse_c"])
    predictor_confidence = 0
    if predictor_mean_rmse >= INVALID_CONFIDENCE_RMSE_C:
        predictor_confidence = 3
    elif predictor_mean_rmse >= LOW_CONFIDENCE_RMSE_C:
        predictor_confidence = 2
    predictor_label = {
        0: "Estimated",
        2: "Low confidence",
        3: "Invalid due to predictor holdout error",
    }[predictor_confidence]
    thermal_validation = {
        "predictor_holdout_rmse_c": predictor_validation["rmse_c"],
        "predictor_holdout_mae_c": predictor_validation["mae_c"],
        "predictor_holdout_mean_rmse_c": predictor_validation["mean_rmse_c"],
        "predictor_holdout_mean_mae_c": predictor_validation["mean_mae_c"],
        "predictor_holdout_rows": predictor_validation["holdout_rows"],
        "predictor_holdout_window_hours": predictor_validation["window_hours"],
        "predictor_holdout_every": predictor_validation["holdout_every"],
        "predictor_thermal_reset_count": predictor_validation["thermal_reset_count"],
        "predictor_confidence": predictor_confidence,
        "predictor_confidence_label": predictor_label,
        "observer_residual_rmse_c": observer_metrics["rmse_c"],
        "observer_residual_mae_c": observer_metrics["mae_c"],
        "observer_residual_mean_rmse_c": observer_metrics["mean_rmse_c"],
        "observer_residual_mean_mae_c": observer_metrics["mean_mae_c"],
        "observer_thermal_reset_count": int(np.sum(resets)),
        "validation_note": (
            "Predictor metrics are open-loop holdout runs with assimilation_gain=0. "
            "Observer residuals are post-assimilation visualization residuals and are not predictive accuracy."
        ),
    }
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "processor_version": PROCESSOR_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "system_id": 5,
        "source_csv": str(args.csv.as_posix()),
        "ocv_source": str(args.ocv.as_posix()),
        "source_files": {
            "csv": csv_fingerprint,
            "ocv": ocv_fingerprint,
            "processor": processor_fingerprint,
        },
        "daily_interval": args.daily_interval,
        "overview_interval": args.overview_interval,
        **source_meta,
        "aggregated_rows": int(len(daily)),
        "chunks": chunks,
        "default_chunk": default_chunk,
        "columns": {
            "frame": FRAME_COLUMNS,
            "overview": OVERVIEW_COLUMNS,
            "overview_daily": OVERVIEW_COLUMNS,
        },
        "sensor_mapping": {
            "Temperature_1": "interface Cell 1-2",
            "Temperature_2": "interface Cell 3-4",
            "Temperature_3": "interface Cell 5-6",
            "Temperature_4": "interface Cell 7-8",
        },
        "physics": {
            "cell_current": "I_cell_i = I_Battery + I_CNV_Cell_i",
            "heat_generation": "Q_i = I_cell_i^2 * R0_est_i",
            "reversible_entropy_heat": "not used; dOCV/dT is unavailable",
            "thermal_model": "effective 8-node lumped RC; predictor uses assimilation_gain=0, observer uses bounded sensor assimilation",
            "predictor_assimilation_gain": 0.0,
            "observer_assimilation_gain": params.assimilation_gain,
            "thermal_params": params.__dict__,
            "r0_global_median_ohm": round_list(features["r0_global_median"], 8),
            "r0_source_codes": R0_SOURCE_CODES,
            "ambient_estimate_c": round(float(features["ambient_c"]), 4),
        },
        "thermal_validation": thermal_validation,
        "validation": {
            "predictor_holdout_rmse_c": predictor_validation["rmse_c"],
            "predictor_holdout_mae_c": predictor_validation["mae_c"],
            "predictor_holdout_mean_rmse_c": predictor_validation["mean_rmse_c"],
            "observer_residual_rmse_c": observer_metrics["rmse_c"],
            "observer_residual_mae_c": observer_metrics["mae_c"],
            "observer_residual_mean_rmse_c": observer_metrics["mean_rmse_c"],
            "pack_confidence_counts": {str(k): int(v) for k, v in pd.Series(pack_confidence).value_counts().sort_index().items()},
            "cell_confidence_counts": {str(k): int(v) for k, v in pd.Series(cell_confidence.reshape(-1)).value_counts().sort_index().items()},
            "thermal_reset_count": int(np.sum(resets)),
            "calibration_interval": "5min",
            "validation_note": "Deprecated compatibility block; use thermal_validation for predictor-vs-observer metrics.",
        },
        "heat_scale": q_stats,
        "ranges": ranges,
        "flag_bits": {
            "2": "thermal_reset_or_gap",
            "4": "low_current_for_r0",
            "8": "pack_voltage_residual_high",
            "16": "cell_voltage_outside_model_range",
            "32": "temperature_outside_model_range",
            "64": "r0_not_valid_at_frame",
            "128": "soc_voltage_inconsistency",
            "256": "r0_stale_or_global_fallback",
        },
        "confidence_labels": {
            "0": "Estimated",
            "2": "Low confidence",
            "3": "Invalid due to SOC/current/gap",
        },
        "notes": [
            "Only Temperature_1..4 are measured thermal ground truth.",
            "Per-cell temperature is estimated; observer visualization is sensor-constrained, predictor validation is open-loop.",
            "Converter/balancing losses are shown separately via I_CNV and are not folded into core heat.",
            "The legacy frame columns risk/confidence/flags are aliases of pack_risk/pack_confidence/pack_flags.",
        ],
    }
    write_json(args.out / "manifest.json", manifest)

    print(json.dumps({
        "out": str(args.out),
        "source_rows": source_meta["source_rows"],
        "aggregated_rows": len(daily),
        "chunks": len(chunks),
        "duplicate_rows": source_meta["duplicate_rows"],
        "predictor_holdout_mean_rmse_c": manifest["thermal_validation"]["predictor_holdout_mean_rmse_c"],
        "observer_residual_mean_rmse_c": manifest["thermal_validation"]["observer_residual_mean_rmse_c"],
        "default_chunk": default_chunk,
    }, indent=2))


def main() -> None:
    args = parse_args()
    build_outputs(args)


if __name__ == "__main__":
    main()
