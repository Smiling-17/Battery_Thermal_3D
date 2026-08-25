import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const CELL_COUNT = 8;
const PAIR_FOR_CELL = [0, 0, 1, 1, 2, 2, 3, 3];
const I_BINS = 28;
const T_BINS = 22;
const FILL_PASSES = 6;
const TRAIL_CAPACITY = 220;

// Temperature gradient: matches tempStops in scene-bindings.js (purple→blue→pink→orange→yellow)
const TEMP_GRADIENT = [
  [0.00, 0x33206f],
  [0.25, 0x3156c8],
  [0.48, 0xd8245e],
  [0.72, 0xf08322],
  [1.00, 0xfff2a6],
];

// Scene plot extents (Three.js coordinates)
// X = I (current, negative=discharge / positive=charge)
// Y = U (voltage, height)
// Z = T (temperature, front=cold / back=hot)
const PLOT = { xMin: -1.3, xMax: 1.3, yMin: 0, yMax: 1.35, zMin: -1.1, zMax: 1.1 };

export class UitSurfacePlot {
  constructor(canvas, metaElement) {
    this.canvas = canvas;
    this.metaElement = metaElement;
    this._cachedFrames = null;
    this._cachedSource = null;
    this._cachedRanges = null;

    if (!canvas) return;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x16181c);

    // Lighting: hemisphere + directional so PhongMaterial shows surface curvature
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x706860, 1.0));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(2.5, 4, 2);
    this.scene.add(sun);

    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 30);
    this.camera.position.set(2.8, 2.4, 3.2);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.48;
    this.controls.target.set(0, 0.45, 0);

    this.surfaceMat = new THREE.MeshPhongMaterial({
      side: THREE.DoubleSide,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      shininess: 30,
      depthWrite: true,
    });
    this.wireMat = new THREE.LineBasicMaterial({
      color: 0x8a8e84,
      transparent: true,
      opacity: 0.3,
    });

    this.surfaceMesh = null;
    this.wireMesh = null;
    this.marker = null;
    this.markerStem = null;
    this.trailLine = null;
    this._trailPositions = new Float32Array(TRAIL_CAPACITY * 3);

    this._buildAxesAndGrid();
    this._buildMarker();
    this._buildTrail();
    this.resize();
  }

  _buildAxesAndGrid() {
    const axMat = new THREE.LineBasicMaterial({ color: 0x8a8e84, transparent: true, opacity: 0.9 });
    const gridMat = new THREE.LineBasicMaterial({ color: 0x2a2d30, transparent: true, opacity: 0.35 });

    const O = new THREE.Vector3(PLOT.xMin, PLOT.yMin, PLOT.zMin);

    // Three main axes from origin corner
    const addLine = (a, b, mat) => {
      const geo = new THREE.BufferGeometry().setFromPoints([a.clone(), b.clone()]);
      this.scene.add(new THREE.Line(geo, mat));
    };
    addLine(O, new THREE.Vector3(PLOT.xMax, PLOT.yMin, PLOT.zMin), axMat); // I axis (X)
    addLine(O, new THREE.Vector3(PLOT.xMin, PLOT.yMax, PLOT.zMin), axMat); // U axis (Y)
    addLine(O, new THREE.Vector3(PLOT.xMin, PLOT.yMin, PLOT.zMax), axMat); // T axis (Z)

    // Floor grid on XZ plane at Y=0
    const N = 6;
    for (let k = 0; k <= N; k++) {
      const tx = PLOT.xMin + (k / N) * (PLOT.xMax - PLOT.xMin);
      const tz = PLOT.zMin + (k / N) * (PLOT.zMax - PLOT.zMin);
      addLine(new THREE.Vector3(tx, 0, PLOT.zMin), new THREE.Vector3(tx, 0, PLOT.zMax), gridMat);
      addLine(new THREE.Vector3(PLOT.xMin, 0, tz), new THREE.Vector3(PLOT.xMax, 0, tz), gridMat);
    }
  }

  _buildMarker() {
    // Flat ring lying on the surface at the current pack operating point
    const ringGeo = new THREE.TorusGeometry(0.082, 0.013, 8, 36);
    ringGeo.rotateX(Math.PI / 2);
    this.marker = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: 0x22b8b0,
      depthTest: false,
      transparent: true,
      opacity: 1.0,
    }));
    this.marker.renderOrder = 10;
    this.marker.visible = false;
    this.scene.add(this.marker);

    // Vertical drop-line from operating point down to the floor grid (XZ plane)
    const stemGeo = new THREE.BufferGeometry();
    stemGeo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3));
    this.markerStem = new THREE.Line(stemGeo, new THREE.LineBasicMaterial({
      color: 0x8a8e84,
      depthTest: false,
      transparent: true,
      opacity: 0.7,
    }));
    this.markerStem.renderOrder = 9;
    this.markerStem.visible = false;
    this.scene.add(this.markerStem);
  }

  _buildTrail() {
    const geo = new THREE.BufferGeometry();
    const attr = new THREE.Float32BufferAttribute(this._trailPositions, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", attr);
    geo.setDrawRange(0, 0);
    this.trailLine = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0x22b8b0,
      transparent: true,
      opacity: 0.8,
      depthTest: false,
    }));
    this.trailLine.renderOrder = 8;
    this.trailLine.visible = false;
    this.scene.add(this.trailLine);
  }

  // Called every frame from main.js animate loop
  // frames = all decoded frames for the current day chunk
  // frameIndex = current playback position
  // heatMode = "estimated" | "measured" | "heat" | "risk"
  update(frames, frameIndex, heatMode) {
    if (!this.canvas || !frames?.length) { this.clear(); return; }

    // "measured" uses the 4 sensor pairs; everything else uses per-cell estimates
    const source = heatMode === "measured" ? "measured" : "estimated";

    // Rebuild the surface grid only when the data set or temperature source changes.
    // When the user scrubs the timeline, only the operating-point marker moves.
    const needsRebuild = frames !== this._cachedFrames || source !== this._cachedSource;
    if (needsRebuild) {
      this._cachedFrames = frames;
      this._cachedSource = source;
      this._cachedRanges = null;
      this._rebuildSurface(frames, source);
    }

    if (!this._cachedRanges) return;

    const fi = Math.max(0, Math.min(frames.length - 1, Math.round(frameIndex)));
    this._updateCurrentPoints(frames[fi], source);
    this._updateTrail(frames, fi, source);
    this._updateMeta(frames, fi, source);
  }

  _resetTrail() {
    if (!this.trailLine) return;
    this.trailLine.geometry.setDrawRange(0, 0);
    this.trailLine.geometry.attributes.position.needsUpdate = true;
    this.trailLine.visible = false;
  }

  _rebuildSurface(frames, source) {
    this._resetTrail();
    // Collect all (U_cell, I_cell, T_cell) triples from every frame × every cell.
    // For a full day: 1 440 frames × 8 cells = 11 520 data points.
    const pts = gatherPoints(frames, source);
    if (pts.length < 16) { this._clearSurface(); return; }

    const ranges = computeRanges(pts);
    this._cachedRanges = ranges;

    // Bin the points into an I_BINS × T_BINS grid, average U per bin
    const rawGrid = buildGrid(pts, ranges);
    // Spread values into empty neighbouring bins so the surface is contiguous
    const filled = fillGaps(rawGrid);

    const geo = buildGeometry(filled, ranges);
    this._setSurface(geo);
  }

  _updateCurrentPoints(frame, source) {
    if (!this._cachedRanges || !this.marker) return;
    const r = this._cachedRanges;

    // Compute pack-average (I, T, U) across the 8 cells for this frame
    let iSum = 0, tSum = 0, uSum = 0, cnt = 0;
    for (let c = 0; c < CELL_COUNT; c++) {
      const iv = frame.iCell[c];
      const tv = source === "estimated" ? frame.tEst[c] : frame.temps[PAIR_FOR_CELL[c]];
      const uv = frame.uCell[c];
      if (Number.isFinite(iv) && Number.isFinite(tv) && Number.isFinite(uv)) {
        iSum += iv; tSum += tv; uSum += uv; cnt++;
      }
    }
    if (cnt === 0) {
      this.marker.visible = false;
      this.markerStem.visible = false;
      return;
    }

    const p = toScene(iSum / cnt, tSum / cnt, uSum / cnt, r);
    this.marker.position.copy(p);

    // Drop-line: from operating point straight down to Y=0 (floor)
    const pos = this.markerStem.geometry.attributes.position;
    pos.setXYZ(0, p.x, p.y, p.z);
    pos.setXYZ(1, p.x, PLOT.yMin, p.z);
    pos.needsUpdate = true;

    this.marker.visible = true;
    this.markerStem.visible = true;
  }

  _updateTrail(frames, fi, source) {
    if (!this._cachedRanges || !this.trailLine) return;
    const r = this._cachedRanges;
    const total = fi + 1;
    const step = Math.max(1, Math.ceil(total / TRAIL_CAPACITY));
    let ptCount = 0;

    for (let i = 0; i <= fi; i += step) {
      const f = frames[i];
      let iSum = 0, tSum = 0, uSum = 0, cnt = 0;
      for (let c = 0; c < CELL_COUNT; c++) {
        const iv = f.iCell[c];
        const tv = source === "estimated" ? f.tEst[c] : f.temps[PAIR_FOR_CELL[c]];
        const uv = f.uCell[c];
        if (Number.isFinite(iv) && Number.isFinite(tv) && Number.isFinite(uv)) {
          iSum += iv; tSum += tv; uSum += uv; cnt++;
        }
      }
      if (cnt === 0) continue;
      const p = toScene(iSum / cnt, tSum / cnt, uSum / cnt, r);
      const base = ptCount * 3;
      this._trailPositions[base] = p.x;
      this._trailPositions[base + 1] = p.y;
      this._trailPositions[base + 2] = p.z;
      ptCount++;
      if (ptCount >= TRAIL_CAPACITY) break;
    }

    const attr = this.trailLine.geometry.attributes.position;
    attr.needsUpdate = true;
    this.trailLine.geometry.setDrawRange(0, ptCount);
    this.trailLine.visible = ptCount >= 2;
  }

  _updateMeta(frames, fi, source) {
    if (!this.metaElement) return;
    const r = this._cachedRanges;
    const tLabel = source === "estimated" ? "T est" : "T meas";
    this.metaElement.textContent = `${tLabel}  —  frame ${fi + 1} / ${frames.length}`;
    this.metaElement.title =
      `I: ${r.iMin.toFixed(1)} → ${r.iMax.toFixed(1)} A  |  ` +
      `T: ${r.tMin.toFixed(1)} → ${r.tMax.toFixed(1)} °C  |  ` +
      `U: ${r.uMin.toFixed(3)} → ${r.uMax.toFixed(3)} V`;
  }

  _setSurface(geo) {
    this._clearSurface();
    if (!geo) return;
    this.surfaceMesh = new THREE.Mesh(geo, this.surfaceMat);
    this.scene.add(this.surfaceMesh);
    this.wireMesh = new THREE.LineSegments(new THREE.WireframeGeometry(geo), this.wireMat);
    this.scene.add(this.wireMesh);
  }

  _clearSurface() {
    if (this.surfaceMesh) {
      this.scene.remove(this.surfaceMesh);
      this.surfaceMesh.geometry.dispose();
      this.surfaceMesh = null;
    }
    if (this.wireMesh) {
      this.scene.remove(this.wireMesh);
      this.wireMesh.geometry.dispose();
      this.wireMesh = null;
    }
  }

  clear() {
    this._cachedFrames = null;
    this._cachedSource = null;
    this._cachedRanges = null;
    this._clearSurface();
    this._resetTrail();
    if (this.marker) this.marker.visible = false;
    if (this.markerStem) this.markerStem.visible = false;
    if (this.metaElement) this.metaElement.textContent = "--";
  }

  resize() {
    if (!this.canvas) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const pr = this.renderer.getPixelRatio();
    if (
      this.canvas.width !== Math.floor(w * pr) ||
      this.canvas.height !== Math.floor(h * pr)
    ) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  render() {
    if (!this.canvas) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

// ---------------------------------------------------------------------------
// Pure data functions (no Three.js state)
// ---------------------------------------------------------------------------

function gatherPoints(frames, source) {
  const pts = [];
  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi];
    for (let c = 0; c < CELL_COUNT; c++) {
      const u = f.uCell[c];
      const i = f.iCell[c];
      const t = source === "estimated" ? f.tEst[c] : f.temps[PAIR_FOR_CELL[c]];
      if (Number.isFinite(u) && Number.isFinite(i) && Number.isFinite(t)) {
        pts.push({ u, i, t });
      }
    }
  }
  return pts;
}

function computeRanges(pts) {
  let uMin = Infinity, uMax = -Infinity;
  let iMin = Infinity, iMax = -Infinity;
  let tMin = Infinity, tMax = -Infinity;
  for (const { u, i, t } of pts) {
    if (u < uMin) uMin = u; if (u > uMax) uMax = u;
    if (i < iMin) iMin = i; if (i > iMax) iMax = i;
    if (t < tMin) tMin = t; if (t > tMax) tMax = t;
  }
  // Symmetric padding on I so zero-current is always interior, not at an edge
  const iAbs = Math.max(Math.abs(iMin), Math.abs(iMax));
  const iPad = Math.max(iAbs * 0.08, 1.0);
  const tPad = Math.max((tMax - tMin) * 0.06, 0.5);
  const uPad = Math.max((uMax - uMin) * 0.05, 0.005);
  return {
    uMin: uMin - uPad, uMax: uMax + uPad,
    iMin: -iAbs - iPad, iMax: iAbs + iPad,
    tMin: tMin - tPad, tMax: tMax + tPad,
  };
}

// Build a flat I_BINS × T_BINS array; each cell is the mean U of all points
// that fall in that bin, or null if empty.
function buildGrid(pts, ranges) {
  const sum = new Float64Array(I_BINS * T_BINS);
  const cnt = new Int32Array(I_BINS * T_BINS);
  for (const { u, i, t } of pts) {
    const ix = clamp(Math.round(norm(i, ranges.iMin, ranges.iMax) * (I_BINS - 1)), 0, I_BINS - 1);
    const tx = clamp(Math.round(norm(t, ranges.tMin, ranges.tMax) * (T_BINS - 1)), 0, T_BINS - 1);
    const k = ix * T_BINS + tx;
    sum[k] += u;
    cnt[k]++;
  }
  const grid = new Array(I_BINS * T_BINS).fill(null);
  for (let k = 0; k < grid.length; k++) {
    if (cnt[k] > 0) grid[k] = sum[k] / cnt[k];
  }
  return grid;
}

// Iteratively copy the average of filled neighbours into empty cells so the
// surface is continuous even when some (I, T) combinations weren't observed.
function fillGaps(grid) {
  const filled = [...grid];
  for (let pass = 0; pass < FILL_PASSES; pass++) {
    let any = false;
    for (let ix = 0; ix < I_BINS; ix++) {
      for (let tx = 0; tx < T_BINS; tx++) {
        const k = ix * T_BINS + tx;
        if (filled[k] !== null) continue;
        let s = 0;
        let n = 0;
        for (const [di, dt] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) {
          const ni = ix + di;
          const nt = tx + dt;
          if (ni >= 0 && ni < I_BINS && nt >= 0 && nt < T_BINS) {
            const v = filled[ni * T_BINS + nt];
            if (v !== null) { s += v; n++; }
          }
        }
        if (n > 0) { filled[k] = s / n; any = true; }
      }
    }
    if (!any) break;
  }
  return filled;
}

function buildGeometry(grid, ranges) {
  const positions = [];
  const colors = [];
  const indices = [];
  // Map each grid cell to a vertex index (-1 = no vertex)
  const vtx = new Int32Array(I_BINS * T_BINS).fill(-1);

  for (let ix = 0; ix < I_BINS; ix++) {
    for (let tx = 0; tx < T_BINS; tx++) {
      const u = grid[ix * T_BINS + tx];
      if (u === null) continue;
      const i = ranges.iMin + (ix / (I_BINS - 1)) * (ranges.iMax - ranges.iMin);
      const t = ranges.tMin + (tx / (T_BINS - 1)) * (ranges.tMax - ranges.tMin);
      vtx[ix * T_BINS + tx] = positions.length / 3;
      const p = toScene(i, t, u, ranges);
      positions.push(p.x, p.y, p.z);
      const c = tempColor(norm(t, ranges.tMin, ranges.tMax));
      colors.push(c.r, c.g, c.b);
    }
  }

  for (let ix = 0; ix < I_BINS - 1; ix++) {
    for (let tx = 0; tx < T_BINS - 1; tx++) {
      const a = vtx[ix * T_BINS + tx];
      const b = vtx[(ix + 1) * T_BINS + tx];
      const c = vtx[ix * T_BINS + (tx + 1)];
      const d = vtx[(ix + 1) * T_BINS + (tx + 1)];
      if (a >= 0 && b >= 0 && c >= 0) indices.push(a, b, c);
      if (b >= 0 && c >= 0 && d >= 0) indices.push(b, d, c);
    }
  }

  if (indices.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// Map physical (i, t, u) values to Three.js scene coordinates.
function toScene(i, t, u, ranges) {
  return new THREE.Vector3(
    lerp(PLOT.xMin, PLOT.xMax, norm(i, ranges.iMin, ranges.iMax)), // X = I
    lerp(PLOT.yMin, PLOT.yMax, norm(u, ranges.uMin, ranges.uMax)), // Y = U (height)
    lerp(PLOT.zMin, PLOT.zMax, norm(t, ranges.tMin, ranges.tMax)), // Z = T
  );
}

function tempColor(t) {
  const tc = Math.max(0, Math.min(1, t));
  for (let i = 0; i < TEMP_GRADIENT.length - 1; i++) {
    const [a, ca] = TEMP_GRADIENT[i];
    const [b, cb] = TEMP_GRADIENT[i + 1];
    if (tc >= a && tc <= b) {
      const local = (tc - a) / Math.max(b - a, 1e-9);
      return new THREE.Color(ca).lerp(new THREE.Color(cb), local);
    }
  }
  return new THREE.Color(TEMP_GRADIENT.at(-1)[1]);
}

function norm(v, lo, hi) { return Math.max(0, Math.min(1, (v - lo) / Math.max(hi - lo, 1e-9))); }
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
