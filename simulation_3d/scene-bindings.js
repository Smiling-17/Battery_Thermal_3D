import * as THREE from "three";
import { valuesForMode } from "./physics-model.js";

const tempStops = [
  [0.0, 0x33206f],
  [0.25, 0x3156c8],
  [0.48, 0xd8245e],
  [0.72, 0xf08322],
  [1.0, 0xfff2a6],
];

const heatStops = [
  [0.0, 0x1b365d],
  [0.35, 0x187a76],
  [0.65, 0xd89029],
  [1.0, 0xf6f0ba],
];

const riskStops = [
  [0.0, 0x187a76],
  [0.45, 0xd89029],
  [0.75, 0xc64630],
  [1.0, 0xf7f0c8],
];

export function applyFrameToScene(context, frame, mode, manifest) {
  const values = valuesForMode(frame, mode);
  const range = rangeForMode(mode, manifest);

  context.cellVisuals.forEach((visual, index) => {
    const color = colorForMode(values[index], mode, range);
    const normalizedValue = Math.max(0, Math.min(1, (values[index] - range[0]) / Math.max(range[1] - range[0], 1e-9)));
    visual.body.material.color.copy(color);
    visual.body.material.emissive.copy(color);
    visual.body.material.emissiveIntensity = 0.3 + normalizedValue * 0.6;
    visual.top.material.color.copy(color.clone().lerp(new THREE.Color(0xffffff), 0.2));
    visual.top.material.emissive.copy(color);
    visual.top.material.emissiveIntensity = 0.2 + normalizedValue * 0.35;
    visual.side.material.color.copy(color.clone().lerp(new THREE.Color(0x1a1c20), 0.25));
    visual.side.material.emissive.copy(color);
    visual.side.material.emissiveIntensity = 0.15 + normalizedValue * 0.25;
  });

  context.temperatureSensors.forEach((sensor, index) => {
    const color = colorForMode(frame.temps[index], "measured", rangeForMode("measured", manifest));
    sensor.traverse((child) => {
      if (child.isMesh && child.material?.color) {
        child.material.color.copy(color);
        if (child.material.type === "MeshStandardMaterial" || child.material.type === "MeshPhysicalMaterial") {
          child.material.emissive = color.clone();
          child.material.emissiveIntensity = 0.25;
        }
      }
    });
  });

  context.balanceBlocks.forEach((block, index) => {
    const activity = Math.min(1, Math.abs(frame.iCnv[index]) / 0.5);
    block.material.opacity = 0.25 + 0.75 * activity;
    block.material.transparent = true;
    block.scale.y = 1 + 1.6 * activity;
  });

  context.currentSpeedFactor = 0.25 + Math.min(2.5, Math.abs(frame.iBatt) / 20);
  return {
    colorbar: colorbarForMode(mode),
    range,
  };
}

export function colorForMode(value, mode, range) {
  if (mode === "heat") return gradientColor(value, range, heatStops);
  if (mode === "risk") return gradientColor(value, range, riskStops);
  return gradientColor(value, range, tempStops);
}

export function rangeForMode(mode, manifest) {
  if (mode === "heat") {
    const max = manifest?.heat_scale?.display_max ?? manifest?.heat_scale?.q_p99 ?? manifest?.ranges?.q_ohmic?.[1] ?? 1;
    return [0, Math.max(max, 1e-6)];
  }
  if (mode === "risk") return [0, 1];
  if (mode === "measured") return safeRange(manifest?.ranges?.temp_measured, [-10, 60]);
  return safeRange(manifest?.ranges?.temp_est, [-10, 60]);
}

export function colorbarForMode(mode) {
  const stops = mode === "heat" ? heatStops : mode === "risk" ? riskStops : tempStops;
  return `linear-gradient(90deg, ${stops
    .map(([stop, color]) => `#${color.toString(16).padStart(6, "0")} ${(stop * 100).toFixed(0)}%`)
    .join(", ")})`;
}

export function formatRange(range, unit, mode = "estimated", manifest = null) {
  if (unit === "score") return `${range[0].toFixed(0)} - ${range[1].toFixed(0)}`;
  if (unit === "W") {
    const maxObserved = manifest?.heat_scale?.q_max_observed;
    const clipped = manifest?.heat_scale?.scale?.includes("clipped");
    const suffix = clipped && Number.isFinite(maxObserved) ? ` W; max observed ${maxObserved.toFixed(2)} W` : " W";
    return `${range[0].toFixed(2)} - ${range[1].toFixed(2)}${suffix}`;
  }
  const observed = mode === "measured" || mode === "estimated" ? " observed range" : "";
  return `${range[0].toFixed(1)} - ${range[1].toFixed(1)} deg C${observed}`;
}

export function measuredSensorLabels(frame) {
  return [
    `T1 ${frame.temps[0].toFixed(0)}C: cell 1-2`,
    `T2 ${frame.temps[1].toFixed(0)}C: cell 3-4`,
    `T3 ${frame.temps[2].toFixed(0)}C: cell 5-6`,
    `T4 ${frame.temps[3].toFixed(0)}C: cell 7-8`,
  ];
}

function gradientColor(value, range, stops) {
  const [min, max] = range;
  const t = Math.max(0, Math.min(1, (value - min) / Math.max(max - min, 1e-9)));
  for (let i = 0; i < stops.length - 1; i += 1) {
    const [aStop, aColor] = stops[i];
    const [bStop, bColor] = stops[i + 1];
    if (t >= aStop && t <= bStop) {
      const local = (t - aStop) / Math.max(bStop - aStop, 1e-9);
      return new THREE.Color(aColor).lerp(new THREE.Color(bColor), local);
    }
  }
  return new THREE.Color(stops.at(-1)[1]);
}

function safeRange(range, fallback) {
  if (!Array.isArray(range) || range.length < 2) return fallback;
  const min = Number(range[0]);
  const max = Number(range[1]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return fallback;
  return [min, max];
}
