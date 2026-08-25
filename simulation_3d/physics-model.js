export const HEAT_MODES = {
  measured: {
    label: "Measured Temp",
    unit: "deg C",
    confidence: "Measured",
    description: "4 real interface sensors; each pair shares one measured value.",
  },
  estimated: {
    label: "Estimated Cell Temp",
    unit: "deg C",
    confidence: "Estimated",
    description: "8 hidden cell temperatures from RC model constrained by measured sensors.",
  },
  heat: {
    label: "Heat Generation",
    unit: "W",
    confidence: "Estimated",
    description: "Irreversible ohmic heat Q = I_cell^2 * R0_est.",
  },
  risk: {
    label: "Thermal Risk",
    unit: "score",
    confidence: "Estimated",
    description: "Composite score from estimated temperature, heat generation, and voltage spread.",
  },
};

export const CONFIDENCE_LABELS = {
  0: "Estimated",
  1: "Estimated",
  2: "Low confidence",
  3: "Invalid due to SOC/current/gap",
};

const PAIR_FOR_CELL = [0, 0, 1, 1, 2, 2, 3, 3];

export function makeColumnIndex(columns) {
  return Object.fromEntries(columns.map((name, index) => [name, index]));
}

export function decodeFrame(row, columns) {
  const col = Array.isArray(columns) ? makeColumnIndex(columns) : columns;
  const has = (name) => Object.prototype.hasOwnProperty.call(col, name);
  const number = (name, fallback = 0) => (has(name) ? Number(row[col[name]]) : fallback);
  const take = (prefix, count) => Array.from({ length: count }, (_, i) => Number(row[col[`${prefix}_${i + 1}`]]));
  const takeOptional = (prefix, count, fallback) => {
    if (!has(`${prefix}_1`)) return [...fallback];
    return Array.from({ length: count }, (_, i) => Number(row[col[`${prefix}_${i + 1}`]]));
  };
  const uCell = take("u_cell", 8);
  const qOhmic = take("q_ohmic", 8);
  const tEst = take("t_est", 8);
  const maxQ = number("max_q");
  const packRisk = number("pack_risk", number("risk"));
  const packConfidence = number("pack_confidence", number("confidence"));
  const packFlags = number("pack_flags", number("flags"));
  const fallbackRiskCell = computeRiskCell(uCell, tEst, qOhmic, maxQ);
  return {
    timestamp: row[col.ts],
    timeMs: Date.parse(row[col.ts]),
    uBatt: number("u_batt"),
    iBatt: number("i_batt"),
    soc: number("soc"),
    temps: take("temp", 4),
    uCell,
    iCnv: take("i_cnv", 8),
    iCell: take("i_cell", 8),
    r0: take("r0", 8),
    qOhmic,
    tEst,
    cellSpread: number("cell_spread"),
    voltageResidual: number("voltage_residual"),
    maxQ,
    risk: packRisk,
    confidence: packConfidence,
    flags: packFlags,
    packRisk,
    packConfidence,
    packFlags,
    riskCell: takeOptional("risk_cell", 8, fallbackRiskCell),
    cellConfidence: takeOptional("confidence_cell", 8, Array(8).fill(packConfidence)),
    cellFlags: takeOptional("flags_cell", 8, Array(8).fill(packFlags)),
    r0AgeMin: takeOptional("r0_age_min", 8, Array(8).fill(Number.NaN)),
    r0Source: takeOptional("r0_source", 8, Array(8).fill(3)),
    duplicateRows: number("duplicate_rows"),
    thermalReset: Boolean(number("thermal_reset")),
  };
}

export function measuredTempForCell(frame, cellIndex) {
  return frame.temps[PAIR_FOR_CELL[cellIndex]];
}

export function valuesForMode(frame, mode) {
  if (mode === "measured") {
    return frame.uCell.map((_, i) => measuredTempForCell(frame, i));
  }
  if (mode === "estimated") return frame.tEst;
  if (mode === "heat") return frame.qOhmic;
  if (mode === "risk") return frame.riskCell;
  return frame.tEst;
}

export function confidenceLabel(code) {
  return CONFIDENCE_LABELS[code] ?? "Estimated";
}

export function flagLabels(flags, flagBits = {}) {
  return Object.entries(flagBits)
    .filter(([bit]) => (flags & Number(bit)) !== 0)
    .map(([, label]) => label);
}

export function frameSummary(frame, manifest) {
  const minU = Math.min(...frame.uCell);
  const maxU = Math.max(...frame.uCell);
  const maxTemp = Math.max(...frame.tEst);
  const frameConfidence = frame.packConfidence ?? frame.confidence;
  const predictorConfidence = Number(manifest?.thermal_validation?.predictor_confidence ?? 0);
  const confidence = Math.max(frameConfidence, predictorConfidence);
  const predictorLabel = manifest?.thermal_validation?.predictor_confidence_label;
  return {
    timestamp: frame.timestamp.replace("T", " "),
    pack: `${frame.uBatt.toFixed(3)} V / ${frame.iBatt.toFixed(3)} A / ${frame.soc.toFixed(1)}%`,
    voltage: `${minU.toFixed(3)}-${maxU.toFixed(3)} V`,
    spread: `${(frame.cellSpread * 1000).toFixed(1)} mV`,
    temp: `${maxTemp.toFixed(1)} deg C`,
    heat: `${frame.maxQ.toFixed(3)} W`,
    confidence: predictorConfidence > frameConfidence && predictorLabel ? predictorLabel : confidenceLabel(confidence),
    confidenceCode: confidence,
    flags: flagLabels(frame.packFlags ?? frame.flags, manifest?.flag_bits).slice(0, 3),
  };
}

function computeRiskCell(uCell, tEst, qOhmic, maxQ) {
  const qScale = Math.max(maxQ, 1e-9);
  const med = median(uCell);
  return uCell.map((u, i) => {
    const tempStress = clamp01((tEst[i] - 30) / 20);
    const heatStress = clamp01(qOhmic[i] / qScale);
    const voltageStress = clamp01(Math.abs(u - med) / 0.12);
    return clamp01(0.45 * tempStress + 0.30 * heatStress + 0.25 * voltageStress);
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}
