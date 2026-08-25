import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DigitalTwinDataLoader } from "./data-loader.js";
import { HEAT_MODES, confidenceLabel, decodeFrame, frameSummary } from "./physics-model.js";
import { applyFrameToScene, colorbarForMode, formatRange, measuredSensorLabels, rangeForMode } from "./scene-bindings.js";
import { UitSurfacePlot } from "./surface-plot.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

const canvas = document.querySelector("#battery-canvas");
const labelsLayer = document.querySelector("#labels");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x121418);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
camera.position.set(7.9, 5.2, 7.5);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  preserveDrawingBuffer: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.55,  // strength
  0.6,   // radius
  0.45   // threshold - lower so emissive cells bloom visibly
);
composer.addPass(bloomPass);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 1.85, 0);
controls.minDistance = 5.5;
controls.maxDistance = 18;
let narrowCameraState = null;

const root = new THREE.Group();
const cellGroup = new THREE.Group();
const sensorGroup = new THREE.Group();
const balanceGroup = new THREE.Group();
const currentGroup = new THREE.Group();
const labelAnchors = [];
const animatedPulses = [];
const explodedItems = [];
const temperatureSensors = [];
const cellVisuals = [];
const balanceBlocks = [];
let currentSpeedFactor = 1;

scene.add(root);
root.add(cellGroup, sensorGroup, balanceGroup, currentGroup);

const dims = {
  cellW: 0.78,
  cellH: 3.1,
  cellD: 1.42,
  gap: 0.17,
  busY: 3.28,
  terminalR: 0.105,
};
const pitch = dims.cellW + dims.gap;
const packW = 8 * dims.cellW + 7 * dims.gap;
const firstX = -packW / 2 + dims.cellW / 2;

const materials = {
  cell: new THREE.MeshPhysicalMaterial({
    color: 0x8f9189,
    roughness: 0.45,
    metalness: 0.05,
    clearcoat: 0.06,
  }),
  cellSide: new THREE.MeshStandardMaterial({
    color: 0x70736d,
    roughness: 0.5,
    metalness: 0.02,
  }),
  top: new THREE.MeshStandardMaterial({
    color: 0xa8aaa3,
    roughness: 0.56,
    metalness: 0.08,
  }),
  edge: new THREE.LineBasicMaterial({
    color: 0x252622,
    transparent: true,
    opacity: 0.55,
  }),
  terminal: new THREE.MeshStandardMaterial({
    color: 0xc7c9c1,
    roughness: 0.34,
    metalness: 0.58,
  }),
  terminalDark: new THREE.MeshBasicMaterial({ color: 0x10110f }),
  busbar: new THREE.MeshStandardMaterial({
    color: 0x22241f,
    roughness: 0.32,
    metalness: 0.62,
  }),
  copper: new THREE.MeshStandardMaterial({
    color: 0xb9732a,
    roughness: 0.34,
    metalness: 0.45,
  }),
  wireBlack: new THREE.MeshStandardMaterial({
    color: 0x1c1e1a,
    roughness: 0.45,
    metalness: 0.35,
  }),
  wireRed: new THREE.MeshStandardMaterial({
    color: 0xb73535,
    roughness: 0.42,
    metalness: 0.18,
  }),
  sensor: new THREE.MeshStandardMaterial({
    color: 0xb73535,
    roughness: 0.38,
    metalness: 0.12,
    emissive: 0x3b0808,
    emissiveIntensity: 0.55,
  }),
  sensorCore: new THREE.MeshBasicMaterial({
    color: 0xd22f2f,
  }),
  sensorBacking: new THREE.MeshStandardMaterial({
    color: 0x2a1715,
    roughness: 0.62,
    metalness: 0.04,
  }),
  sensorBridge: new THREE.MeshStandardMaterial({
    color: 0xb73535,
    roughness: 0.55,
    metalness: 0.04,
    transparent: true,
    opacity: 0.58,
    emissive: 0x3b0808,
    emissiveIntensity: 0.35,
  }),
  bmsCase: new THREE.MeshStandardMaterial({
    color: 0x1a1c20,
    roughness: 0.5,
    metalness: 0.16,
  }),
  bmsFace: new THREE.MeshStandardMaterial({
    color: 0xf7f7f1,
    roughness: 0.48,
    metalness: 0.02,
  }),
  tray: new THREE.MeshStandardMaterial({
    color: 0x0c0e10,
    roughness: 0.72,
    metalness: 0.12,
  }),
  enclosure: new THREE.LineBasicMaterial({
    color: 0x161713,
    transparent: true,
    opacity: 0.25,
  }),
  pulseCharge: new THREE.MeshBasicMaterial({ color: 0x22b8b0 }),
  pulseDischarge: new THREE.MeshBasicMaterial({ color: 0xe8a030 }),
  balanceBlock: new THREE.MeshStandardMaterial({
    color: 0x187a76,
    roughness: 0.5,
    metalness: 0.25,
  }),
};

const terminalNodes = [];
const busbarPaths = [];
let currentExplodeAmount = 0;
const dynamicBusbars = [];
const dynamicBalanceLeads = [];
const dynamicSenseWires = [];
const dynamicPackLeads = [];
const tapLabelAnchors = [];
const cellLabelAnchors = [];
let packPlusLabelAnchor = null;
let packMinusLabelAnchor = null;
let currentMode = "discharge";
const twinLoader = new DigitalTwinDataLoader();
const twinState = {
  manifest: null,
  chunk: null,
  frames: [],
  frameIndex: 0,
  heatMode: "estimated",
  playing: false,
  speed: 300,
  playbackCarryMs: 0,
  lastTickMs: 0,
  advancePending: false,
  savedCarryMs: 0,
};
const twinDom = {
  status: document.querySelector("#data-status"),
  dateSelect: document.querySelector("#date-select"),
  frameSlider: document.querySelector("#frame-slider"),
  playToggle: document.querySelector("#play-toggle"),
  speedSelect: document.querySelector("#speed-select"),
  modeButtons: [...document.querySelectorAll("[data-heat-mode]")],
  metrics: {
    time: document.querySelector("#metric-time"),
    pack: document.querySelector("#metric-pack"),
    voltage: document.querySelector("#metric-voltage"),
    spread: document.querySelector("#metric-spread"),
    temp: document.querySelector("#metric-temp"),
    heat: document.querySelector("#metric-heat"),
  },
  confidence: document.querySelector("#confidence-badge"),
  colorbar: document.querySelector("#colorbar"),
  colorbarLabel: document.querySelector("#colorbar-label"),
  colorbarRange: document.querySelector("#colorbar-range"),
  surfaceCanvas: document.querySelector("#uit-surface-canvas"),
  surfaceMeta: document.querySelector("#surface-meta"),
};
const uitSurfacePlot = new UitSurfacePlot(twinDom.surfaceCanvas, twinDom.surfaceMeta);

addLights();
buildBaseAndEnclosure();
buildCells();
buildBusbars();
buildBms();
buildTemperatureSensors();
buildBalancingChannels();
buildCurrentPulses();
bindControls();
initDigitalTwin();
resize();
animate();

function addLights() {
  const ambient = new THREE.HemisphereLight(0xcdd5e0, 0x1a1c20, 1.2);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xe8eaf0, 2.2);
  key.position.set(-3.5, 7, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -7;
  key.shadow.camera.right = 7;
  key.shadow.camera.top = 7;
  key.shadow.camera.bottom = -4;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x8ab4f8, 0.6);
  rim.position.set(6, 4, -4);
  scene.add(rim);

  const fill = new THREE.DirectionalLight(0x22b8b0, 0.15);
  fill.position.set(0, -2, 3);
  scene.add(fill);
}

function buildBaseAndEnclosure() {
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(packW + 0.85, 0.16, dims.cellD + 0.72),
    materials.tray,
  );
  base.position.set(0, -0.08, 0);
  base.receiveShadow = true;
  root.add(base);

  const enclosure = new THREE.BoxGeometry(packW + 1.25, dims.cellH + 0.72, dims.cellD + 0.98);
  const edgeLines = new THREE.LineSegments(
    new THREE.EdgesGeometry(enclosure),
    materials.enclosure,
  );
  edgeLines.position.set(0, dims.cellH / 2 + 0.18, 0);
  root.add(edgeLines);
}

function buildCells() {
  for (let i = 0; i < 8; i += 1) {
    const cellIndex = i + 1;
    const x = firstX + i * pitch;
    const cell = new THREE.Group();
    cell.position.set(x, dims.cellH / 2, 0);
    cell.userData.homeX = x;
    cell.userData.indexFromCenter = i - 3.5;
    cellGroup.add(cell);
    explodedItems.push(cell);

    const bodyMaterial = materials.cell.clone();
    const sideMaterial = materials.cellSide.clone();
    const topMaterial = materials.top.clone();

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(dims.cellW, dims.cellH, dims.cellD),
      bodyMaterial,
    );
    body.castShadow = true;
    body.receiveShadow = true;
    cell.add(body);

    const sidePanel = new THREE.Mesh(
      new THREE.BoxGeometry(dims.cellW * 0.92, dims.cellH * 0.98, 0.018),
      sideMaterial,
    );
    sidePanel.position.set(0, -0.02, -dims.cellD / 2 - 0.012);
    cell.add(sidePanel);

    const top = new THREE.Mesh(
      new THREE.BoxGeometry(dims.cellW * 0.98, 0.08, dims.cellD * 0.98),
      topMaterial,
    );
    top.position.set(0, dims.cellH / 2 + 0.045, 0);
    top.castShadow = true;
    cell.add(top);
    cellVisuals.push({ body, side: sidePanel, top });

    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(dims.cellW, dims.cellH, dims.cellD)),
      materials.edge,
    );
    cell.add(edge);

    const seam = new THREE.Mesh(
      new THREE.BoxGeometry(0.012, dims.cellH * 0.72, 0.024),
      sideMaterial,
    );
    seam.position.set(dims.cellW * 0.33, -0.25, -dims.cellD / 2 - 0.03);
    cell.add(seam);

    const terminalA = makeTerminal(cellIndex % 2 === 1 ? "+" : "-");
    terminalA.position.set(-dims.cellW * 0.27, dims.cellH / 2 + 0.12, -dims.cellD * 0.28);
    cell.add(terminalA);

    const terminalB = makeTerminal(cellIndex % 2 === 1 ? "-" : "+");
    terminalB.position.set(dims.cellW * 0.27, dims.cellH / 2 + 0.12, dims.cellD * 0.28);
    cell.add(terminalB);

    const negativeLocal = cellIndex % 2 === 1 ? terminalB.position : terminalA.position;
    const positiveLocal = cellIndex % 2 === 1 ? terminalA.position : terminalB.position;
    terminalNodes[cellIndex] = {
      negative: new THREE.Vector3(x + negativeLocal.x, dims.busY, negativeLocal.z),
      positive: new THREE.Vector3(x + positiveLocal.x, dims.busY, positiveLocal.z),
    };

    cellLabelAnchors.push(makeLabel(`Cell ${cellIndex}`, new THREE.Vector3(x, dims.cellH + 0.68, 0), "cell"));
  }
}

function makeTerminal(sign) {
  const group = new THREE.Group();
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(dims.terminalR, dims.terminalR, 0.07, 44),
    materials.terminal,
  );
  post.castShadow = true;
  group.add(post);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(dims.terminalR * 0.78, 0.012, 8, 36),
    materials.terminalDark,
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.041;
  group.add(ring);

  const bar1 = new THREE.Mesh(
    new THREE.BoxGeometry(dims.terminalR * 1.1, 0.012, 0.014),
    materials.terminalDark,
  );
  bar1.position.y = 0.082;
  group.add(bar1);

  if (sign === "+") {
    const bar2 = new THREE.Mesh(
      new THREE.BoxGeometry(0.014, 0.012, dims.terminalR * 1.1),
      materials.terminalDark,
    );
    bar2.position.y = 0.083;
    group.add(bar2);
  }

  return group;
}

function buildBusbars() {
  for (let i = 1; i < 8; i += 1) {
    const a = terminalNodes[i].negative.clone();
    const b = terminalNodes[i + 1].positive.clone();
    const midY = dims.busY + 0.11;
    const points = [
      a,
      new THREE.Vector3(a.x, midY, a.z),
      new THREE.Vector3(b.x, midY, b.z),
      b,
    ];
    const tube = makePolyline(points, 0.037, materials.busbar, 10);
    tube.castShadow = true;
    cellGroup.add(tube);
    dynamicBusbars.push(tube);
    busbarPaths.push(points);

    const nodePos = a.clone().lerp(b, 0.5).setY(midY + 0.09);
    tapLabelAnchors.push(makeLabel(`Tap ${i}`, nodePos, "node"));
  }

  packPlusLabelAnchor = makeLabel("Pack +", terminalNodes[1].positive.clone().add(new THREE.Vector3(-0.22, 0.18, -0.08)), "node");
  packMinusLabelAnchor = makeLabel("Pack -", terminalNodes[8].negative.clone().add(new THREE.Vector3(0.22, 0.18, 0.08)), "node");
}

function buildBms() {
  const bms = new THREE.Group();
  bms.position.set(0, dims.cellH + 1.15, 0.2);
  root.add(bms);

  const caseBox = new THREE.Mesh(new THREE.BoxGeometry(3.75, 0.92, 0.36), materials.bmsCase);
  caseBox.castShadow = true;
  bms.add(caseBox);

  const face = new THREE.Mesh(new THREE.PlaneGeometry(3.52, 0.72), makeBmsFaceMaterial());
  face.position.set(0, 0, 0.185);
  bms.add(face);

  const leftPort = makeBmsPort("+");
  leftPort.position.set(-1.47, 0, 0.205);
  bms.add(leftPort);

  const rightPort = makeBmsPort("-");
  rightPort.position.set(1.47, 0, 0.205);
  bms.add(rightPort);

  makeLabel("BMS", new THREE.Vector3(0, dims.cellH + 1.82, -0.08), "cell");

  const plusLead = makePolyline(
    [
      terminalNodes[1].positive,
      new THREE.Vector3(terminalNodes[1].positive.x - 0.12, dims.cellH + 0.72, terminalNodes[1].positive.z),
      new THREE.Vector3(-1.47, dims.cellH + 1.15, 0),
    ],
    0.026,
    materials.wireBlack,
    9,
  );
  const minusLead = makePolyline(
    [
      terminalNodes[8].negative,
      new THREE.Vector3(terminalNodes[8].negative.x + 0.12, dims.cellH + 0.72, terminalNodes[8].negative.z),
      new THREE.Vector3(1.47, dims.cellH + 1.15, 0),
    ],
    0.026,
    materials.wireBlack,
    9,
  );
  root.add(minusLead, plusLead);
  dynamicPackLeads.push(plusLead, minusLead);

  const senseNodes = [terminalNodes[1].positive.clone()];
  for (let i = 1; i < 8; i += 1) {
    senseNodes.push(terminalNodes[i].negative.clone().lerp(terminalNodes[i + 1].positive, 0.5));
  }
  senseNodes.push(terminalNodes[8].negative.clone());

  senseNodes.forEach((node, index) => {
    const bmsX = -1.62 + index * 0.405;
    const line = makePolyline(
      [
        node.clone().add(new THREE.Vector3(0, 0.04, 0)),
        new THREE.Vector3(node.x, dims.cellH + 0.28, node.z),
        new THREE.Vector3(bmsX, dims.cellH + 0.85, -0.02),
      ],
      0.009,
      materials.wireBlack,
      5,
    );
    line.userData.sensorLayer = true;
    sensorGroup.add(line);
    dynamicSenseWires.push(line);
  });
}

function makeBmsFaceMaterial() {
  const texture = makeCanvasTexture(900, 260, (ctx, width, height) => {
    ctx.fillStyle = "#f7f7f1";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#0f100d";
    ctx.lineWidth = 12;
    ctx.strokeRect(8, 8, width - 16, height - 16);
    ctx.fillStyle = "#0c0d0b";
    ctx.font = "700 118px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("BMS", width / 2, height / 2 + 4);
  });
  return new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.5,
    metalness: 0.02,
  });
}

function makeBmsPort(sign) {
  const group = new THREE.Group();
  const disk = new THREE.Mesh(new THREE.CircleGeometry(0.24, 64), materials.bmsFace);
  group.add(disk);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.026, 8, 48), materials.bmsCase);
  group.add(ring);
  const signTexture = makeCanvasTexture(128, 128, (ctx, width, height) => {
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = "#0c0d0b";
    ctx.lineWidth = 9;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(32, 64);
    ctx.lineTo(96, 64);
    ctx.stroke();
    if (sign === "+") {
      ctx.beginPath();
      ctx.moveTo(64, 32);
      ctx.lineTo(64, 96);
      ctx.stroke();
    }
  });
  const signPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(0.28, 0.28),
    new THREE.MeshBasicMaterial({ map: signTexture, transparent: true }),
  );
  signPlane.position.z = 0.006;
  group.add(signPlane);
  return group;
}

function buildTemperatureSensors() {
  const pairs = [
    [1, 2],
    [3, 4],
    [5, 6],
    [7, 8],
  ];

  pairs.forEach(([left, right], idx) => {
    const leftX = firstX + (left - 1) * pitch;
    const rightX = firstX + (right - 1) * pitch;
    const x = (leftX + rightX) / 2;
    const probe = new THREE.Group();
    probe.position.set(x, 1.48, 0);
    probe.userData.homeX = x;
    probe.userData.indexFromCenter = ((left - 1) - 3.5 + (right - 1) - 3.5) / 2;
    probe.userData.kind = "temperatureSensor";
    sensorGroup.add(probe);
    explodedItems.push(probe);
    temperatureSensors.push(probe);

    const bridgeMaterial = materials.sensorBridge.clone();
    const backingMaterial = materials.sensorBacking.clone();
    const coreMaterial = materials.sensorCore.clone();
    const capsuleMaterial = materials.sensor.clone();

    const bridge = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.62, dims.cellD * 0.5),
      bridgeMaterial,
    );
    bridge.scale.x = dims.gap * 0.92;
    bridge.castShadow = true;
    probe.add(bridge);
    probe.userData.bridge = bridge;

    const backing = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.54, dims.cellD * 0.34),
      backingMaterial,
    );
    backing.castShadow = true;
    probe.add(backing);

    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(0.082, 0.46, dims.cellD * 0.28),
      coreMaterial,
    );
    pad.castShadow = true;
    probe.add(pad);

    const capsule = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.038, 0.24, 8, 16),
      capsuleMaterial,
    );
    capsule.rotation.z = Math.PI / 2;
    capsule.position.set(0, 0, 0);
    capsule.castShadow = true;
    probe.add(capsule);

    const contact = new THREE.Mesh(
      new THREE.BoxGeometry(dims.gap * 0.78, 0.018, dims.cellD * 0.42),
      backingMaterial,
    );
    contact.position.set(0, 0.25, 0);
    probe.add(contact);

    const anchor = getTemperatureSensorAnchor(probe);
    probe.userData.labelAnchor = makeLabel(
      `T${idx + 1}: cell ${left}-${right}`,
      anchor.clone().add(new THREE.Vector3(0, 0.18, -0.12)),
      "sensor",
    );

    probe.userData.wireIndex = idx;
    probe.userData.wire = makeTemperatureSensorWire(probe, idx);
    sensorGroup.add(probe.userData.wire);
  });
}

function getTemperatureSensorAnchor(probe) {
  return new THREE.Vector3(probe.position.x, probe.position.y + 0.25, probe.position.z - 0.005);
}

function makeTemperatureSensorWire(probe, idx) {
  const anchor = getTemperatureSensorAnchor(probe);
  const wire = makePolyline(
    [
      anchor,
      new THREE.Vector3(anchor.x, dims.cellH + 0.2, anchor.z),
      new THREE.Vector3(-1.2 + idx * 0.8, dims.cellH + 0.95, -0.05),
    ],
    0.008,
    materials.wireRed,
    6,
  );
  wire.userData.sensorLayer = true;
  return wire;
}

function updateTemperatureSensorWire(probe) {
  if (probe.userData.wire) {
    sensorGroup.remove(probe.userData.wire);
  }
  probe.userData.wire = makeTemperatureSensorWire(probe, probe.userData.wireIndex);
  sensorGroup.add(probe.userData.wire);

  if (probe.userData.labelAnchor) {
    probe.userData.labelAnchor.position.copy(
      getTemperatureSensorAnchor(probe).add(new THREE.Vector3(0, 0.18, -0.12)),
    );
  }
}

function buildBalancingChannels() {
  for (let i = 0; i < 8; i += 1) {
    const cellIndex = i + 1;
    const x = firstX + i * pitch;
    const block = new THREE.Mesh(
      new THREE.BoxGeometry(0.26, 0.09, 0.2),
      materials.balanceBlock.clone(),
    );
    block.position.set(-1.48 + i * 0.42, dims.cellH + 1.43, -0.04);
    block.castShadow = true;
    block.userData.balanceLayer = true;
    balanceGroup.add(block);
    balanceBlocks.push(block);

    const positiveLead = makePolyline(
      [
        new THREE.Vector3(block.position.x - 0.055, dims.cellH + 1.36, -0.04),
        new THREE.Vector3(x - 0.08, dims.cellH + 0.72, terminalNodes[cellIndex].positive.z),
        terminalNodes[cellIndex].positive.clone().add(new THREE.Vector3(0, 0.05, 0)),
      ],
      0.008,
      materials.copper,
      4,
    );
    positiveLead.userData.balanceLayer = true;
    balanceGroup.add(positiveLead);
    dynamicBalanceLeads.push(positiveLead);

    const negativeLead = makePolyline(
      [
        new THREE.Vector3(block.position.x + 0.055, dims.cellH + 1.36, -0.04),
        new THREE.Vector3(x + 0.08, dims.cellH + 0.72, terminalNodes[cellIndex].negative.z),
        terminalNodes[cellIndex].negative.clone().add(new THREE.Vector3(0, 0.05, 0)),
      ],
      0.008,
      materials.wireBlack,
      4,
    );
    negativeLead.userData.balanceLayer = true;
    balanceGroup.add(negativeLead);
    dynamicBalanceLeads.push(negativeLead);
  }
}

function buildCurrentPulses() {
  const currentPath = [
    terminalNodes[8].negative.clone().add(new THREE.Vector3(0.3, 0.12, 0.2)),
    terminalNodes[8].negative,
  ];

  for (let cellIndex = 8; cellIndex >= 1; cellIndex -= 1) {
    currentPath.push(terminalNodes[cellIndex].positive);
    if (cellIndex > 1) {
      currentPath.push(...busbarPaths[cellIndex - 2].slice().reverse());
    }
  }

  currentPath.push(terminalNodes[1].positive.clone().add(new THREE.Vector3(-0.3, 0.12, -0.2)));

  for (let i = 0; i < 11; i += 1) {
    const pulse = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 18, 18),
      materials.pulseDischarge,
    );
    pulse.userData = {
      path: currentPath,
      offset: i / 11,
      speed: 0.085,
      currentLayer: true,
    };
    currentGroup.add(pulse);
    animatedPulses.push(pulse);
  }

}

function updateTerminalNodes(amount) {
  for (let i = 0; i < 8; i += 1) {
    const cellIndex = i + 1;
    const explodedX = firstX + i * pitch + (i - 3.5) * amount * 0.18;
    const negLocalX = cellIndex % 2 === 1 ? dims.cellW * 0.27 : -dims.cellW * 0.27;
    const posLocalX = cellIndex % 2 === 1 ? -dims.cellW * 0.27 : dims.cellW * 0.27;
    terminalNodes[cellIndex].negative.x = explodedX + negLocalX;
    terminalNodes[cellIndex].positive.x = explodedX + posLocalX;
  }
}

function rebuildBusbars() {
  dynamicBusbars.forEach((tube) => cellGroup.remove(tube));
  dynamicBusbars.length = 0;
  busbarPaths.length = 0;

  for (let i = 1; i < 8; i += 1) {
    const a = terminalNodes[i].negative.clone();
    const b = terminalNodes[i + 1].positive.clone();
    const midY = dims.busY + 0.11;
    const points = [
      a,
      new THREE.Vector3(a.x, midY, a.z),
      new THREE.Vector3(b.x, midY, b.z),
      b,
    ];
    const tube = makePolyline(points, 0.037, materials.busbar, 10);
    tube.castShadow = true;
    cellGroup.add(tube);
    dynamicBusbars.push(tube);
    busbarPaths.push(points);
    tapLabelAnchors[i - 1].position.copy(a.clone().lerp(b, 0.5).setY(midY + 0.09));
  }

  if (packPlusLabelAnchor) {
    packPlusLabelAnchor.position.copy(terminalNodes[1].positive.clone().add(new THREE.Vector3(-0.22, 0.18, -0.08)));
  }
  if (packMinusLabelAnchor) {
    packMinusLabelAnchor.position.copy(terminalNodes[8].negative.clone().add(new THREE.Vector3(0.22, 0.18, 0.08)));
  }
  rebuildCurrentPath();
}

function rebuildCurrentPath() {
  if (!animatedPulses.length) return;
  const path = animatedPulses[0].userData.path;
  path.length = 0;
  path.push(terminalNodes[8].negative.clone().add(new THREE.Vector3(0.3, 0.12, 0.2)));
  path.push(terminalNodes[8].negative);
  for (let cellIndex = 8; cellIndex >= 1; cellIndex -= 1) {
    path.push(terminalNodes[cellIndex].positive);
    if (cellIndex > 1) {
      path.push(...busbarPaths[cellIndex - 2].slice().reverse());
    }
  }
  path.push(terminalNodes[1].positive.clone().add(new THREE.Vector3(-0.3, 0.12, -0.2)));
}

function rebuildBalanceLeads() {
  dynamicBalanceLeads.forEach((lead) => balanceGroup.remove(lead));
  dynamicBalanceLeads.length = 0;

  for (let i = 0; i < 8; i += 1) {
    const cellIndex = i + 1;
    const cellX = firstX + i * pitch + (i - 3.5) * currentExplodeAmount * 0.18;
    const block = balanceBlocks[i];

    const positiveLead = makePolyline(
      [
        new THREE.Vector3(block.position.x - 0.055, dims.cellH + 1.36, -0.04),
        new THREE.Vector3(cellX - 0.08, dims.cellH + 0.72, terminalNodes[cellIndex].positive.z),
        terminalNodes[cellIndex].positive.clone().add(new THREE.Vector3(0, 0.05, 0)),
      ],
      0.008,
      materials.copper,
      4,
    );
    positiveLead.userData.balanceLayer = true;
    balanceGroup.add(positiveLead);
    dynamicBalanceLeads.push(positiveLead);

    const negativeLead = makePolyline(
      [
        new THREE.Vector3(block.position.x + 0.055, dims.cellH + 1.36, -0.04),
        new THREE.Vector3(cellX + 0.08, dims.cellH + 0.72, terminalNodes[cellIndex].negative.z),
        terminalNodes[cellIndex].negative.clone().add(new THREE.Vector3(0, 0.05, 0)),
      ],
      0.008,
      materials.wireBlack,
      4,
    );
    negativeLead.userData.balanceLayer = true;
    balanceGroup.add(negativeLead);
    dynamicBalanceLeads.push(negativeLead);
  }
}

function rebuildSenseWires() {
  dynamicSenseWires.forEach((wire) => sensorGroup.remove(wire));
  dynamicSenseWires.length = 0;

  const senseNodes = [terminalNodes[1].positive.clone()];
  for (let i = 1; i < 8; i += 1) {
    senseNodes.push(terminalNodes[i].negative.clone().lerp(terminalNodes[i + 1].positive, 0.5));
  }
  senseNodes.push(terminalNodes[8].negative.clone());

  senseNodes.forEach((node, index) => {
    const bmsX = -1.62 + index * 0.405;
    const line = makePolyline(
      [
        node.clone().add(new THREE.Vector3(0, 0.04, 0)),
        new THREE.Vector3(node.x, dims.cellH + 0.28, node.z),
        new THREE.Vector3(bmsX, dims.cellH + 0.85, -0.02),
      ],
      0.009,
      materials.wireBlack,
      5,
    );
    line.userData.sensorLayer = true;
    sensorGroup.add(line);
    dynamicSenseWires.push(line);
  });
}

function rebuildPackLeads() {
  dynamicPackLeads.forEach((lead) => root.remove(lead));
  dynamicPackLeads.length = 0;

  const plusLead = makePolyline(
    [
      terminalNodes[1].positive.clone(),
      new THREE.Vector3(terminalNodes[1].positive.x - 0.12, dims.cellH + 0.72, terminalNodes[1].positive.z),
      new THREE.Vector3(-1.47, dims.cellH + 1.15, 0),
    ],
    0.026,
    materials.wireBlack,
    9,
  );
  const minusLead = makePolyline(
    [
      terminalNodes[8].negative.clone(),
      new THREE.Vector3(terminalNodes[8].negative.x + 0.12, dims.cellH + 0.72, terminalNodes[8].negative.z),
      new THREE.Vector3(1.47, dims.cellH + 1.15, 0),
    ],
    0.026,
    materials.wireBlack,
    9,
  );
  root.add(plusLead, minusLead);
  dynamicPackLeads.push(plusLead, minusLead);
}

function bindControls() {
  const explodeSlider = document.querySelector("#explode-slider");
  const toggleLabels = document.querySelector("#toggle-labels");
  const toggleSensors = document.querySelector("#toggle-sensors");
  const toggleBalancing = document.querySelector("#toggle-balancing");
  const toggleCurrent = document.querySelector("#toggle-current");
  const dischargeBtn = document.querySelector("#mode-discharge");
  const chargeBtn = document.querySelector("#mode-charge");

  explodeSlider.addEventListener("input", () => {
    const amount = Number(explodeSlider.value) / 100;
    currentExplodeAmount = amount;
    explodedItems.forEach((item) => {
      const index = item.userData.indexFromCenter ?? item.position.x / pitch;
      const homeX = item.userData.homeX ?? item.position.x;
      item.position.x = homeX + index * amount * 0.18;

      if (item.userData.kind === "temperatureSensor") {
        item.position.z = 0;
        if (item.userData.bridge) {
          item.userData.bridge.scale.x = (dims.gap + amount * 0.18) * 0.92;
        }
        updateTemperatureSensorWire(item);
      }
    });
    cellLabelAnchors.forEach((anchor, i) => {
      anchor.position.x = firstX + i * pitch + (i - 3.5) * amount * 0.18;
    });
    updateTerminalNodes(amount);
    rebuildBusbars();
    rebuildBalanceLeads();
    rebuildSenseWires();
    rebuildPackLeads();
  });

  toggleLabels.addEventListener("change", () => {
    labelsLayer.style.display = toggleLabels.checked ? "block" : "none";
  });

  toggleSensors.addEventListener("change", () => {
    setSensorCutaway(toggleSensors.checked);
  });

  toggleBalancing.addEventListener("change", () => {
    balanceGroup.visible = toggleBalancing.checked;
  });

  toggleCurrent.addEventListener("change", () => {
    currentGroup.visible = toggleCurrent.checked;
  });

  dischargeBtn.addEventListener("click", () => setCurrentMode("discharge"));
  chargeBtn.addEventListener("click", () => setCurrentMode("charge"));
  setSensorCutaway(toggleSensors.checked);
  bindDigitalTwinControls();

  document.querySelector("#reset-view").addEventListener("click", () => {
    applyResponsiveCamera(true);
  });

  document.querySelector("#top-view").addEventListener("click", () => {
    camera.position.set(0, 9.8, 0.02);
    controls.target.set(0, 1.7, 0);
    controls.update();
  });
}

function bindDigitalTwinControls() {
  twinDom.modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.heatMode;
      if (!HEAT_MODES[mode]) return;
      twinState.heatMode = mode;
      twinDom.modeButtons.forEach((item) => item.classList.toggle("is-active", item === button));
      updateColorbar();
      applyTwinFrame(twinState.frameIndex);
    });
  });

  twinDom.dateSelect.addEventListener("change", () => {
    if (twinDom.dateSelect.value) {
      loadTwinChunk(twinDom.dateSelect.value);
    }
  });

  twinDom.frameSlider.addEventListener("input", () => {
    twinState.playing = false;
    updatePlayButton();
    twinState.playbackCarryMs = 0;
    applyTwinFrame(Number(twinDom.frameSlider.value));
  });

  twinDom.playToggle.addEventListener("click", () => {
    if (!twinState.frames.length) return;
    twinState.playing = !twinState.playing;
    twinState.lastTickMs = 0;
    twinState.playbackCarryMs = 0;
    updatePlayButton();
  });

  twinDom.speedSelect.addEventListener("change", () => {
    twinState.speed = Number(twinDom.speedSelect.value) || 300;
  });

  twinState.speed = Number(twinDom.speedSelect.value) || 300;
  updateColorbar();
  updatePlayButton();
}

async function initDigitalTwin() {
  setDataStatus("Loading digital twin manifest...");
  twinDom.dateSelect.disabled = true;
  twinDom.frameSlider.disabled = true;
  twinDom.playToggle.disabled = true;

  try {
    const manifest = await twinLoader.loadManifest();
    twinState.manifest = manifest;
    fillDateSelect(manifest);
    twinDom.dateSelect.disabled = false;

    const defaultChunk = twinLoader.getDefaultChunk();
    if (defaultChunk) {
      await loadTwinChunk(defaultChunk);
    } else {
      setDataStatus("Manifest loaded but no daily chunks available.");
    }
  } catch (error) {
    console.warn(error);
    setDataStatus("No processed data. Run: python tools/build_sys5_digital_twin.py");
    twinDom.confidence.textContent = "Static 3D model only";
  }
}

function fillDateSelect(manifest) {
  twinDom.dateSelect.replaceChildren();
  manifest.chunks.forEach((chunk) => {
    const option = document.createElement("option");
    option.value = chunk.date;
    option.textContent = `${chunk.date} (${chunk.rows} frames)`;
    twinDom.dateSelect.appendChild(option);
  });
}

async function loadTwinChunk(chunkOrDate) {
  const chunk = typeof chunkOrDate === "string" ? twinLoader.getChunkByDate(chunkOrDate) : chunkOrDate;
  if (!chunk) return;
  twinState.playing = false;
  twinState.advancePending = false;
  updatePlayButton();
  setDataStatus(`Loading ${chunk.date}...`);
  twinDom.frameSlider.disabled = true;
  twinDom.playToggle.disabled = true;

  try {
    const payload = await twinLoader.loadChunk(chunk);
    const columns = payload.columns ?? twinState.manifest?.columns?.frame;
    twinState.frames = payload.frames
      .map((row) => decodeFrame(row, columns))
      .filter((frame) => Number.isFinite(frame.timeMs));
    twinState.chunk = chunk;
    twinState.frameIndex = 0;
    twinState.playbackCarryMs = 0;
    twinDom.dateSelect.value = chunk.date;
    twinDom.frameSlider.max = Math.max(0, twinState.frames.length - 1);
    twinDom.frameSlider.value = 0;
    twinDom.frameSlider.disabled = twinState.frames.length === 0;
    twinDom.playToggle.disabled = twinState.frames.length < 2;
    applyTwinFrame(0);
    setDataStatus(`${chunk.date}: ${twinState.frames.length.toLocaleString()} frames`);
  } catch (error) {
    console.warn(error);
    setDataStatus(`Failed to load chunk ${chunk.date}.`);
    twinState.frames = [];
    uitSurfacePlot.clear();
  }
}

function applyTwinFrame(index) {
  if (!twinState.frames.length) {
    updateColorbar();
    uitSurfacePlot.clear();
    return;
  }

  const frameIndex = Math.max(0, Math.min(twinState.frames.length - 1, Math.round(index)));
  const frame = twinState.frames[frameIndex];
  twinState.frameIndex = frameIndex;
  if (Number(twinDom.frameSlider.value) !== frameIndex) {
    twinDom.frameSlider.value = frameIndex;
  }

  const context = { cellVisuals, temperatureSensors, balanceBlocks, currentSpeedFactor };
  const binding = applyFrameToScene(context, frame, twinState.heatMode, twinState.manifest);
  currentSpeedFactor = context.currentSpeedFactor;

  if (frame.iBatt > 0.02) {
    setCurrentMode("charge");
  } else if (frame.iBatt < -0.02) {
    setCurrentMode("discharge");
  }

  measuredSensorLabels(frame).forEach((label, sensorIndex) => {
    const anchor = temperatureSensors[sensorIndex]?.userData.labelAnchor;
    if (anchor) anchor.element.textContent = label;
  });

  updateTelemetry(frame);
  updateColorbar(binding.range);
  uitSurfacePlot.update(twinState.frames, frameIndex, twinState.heatMode);
}

function updateTelemetry(frame) {
  const summary = frameSummary(frame, twinState.manifest);
  twinDom.metrics.time.textContent = summary.timestamp;
  twinDom.metrics.pack.textContent = summary.pack;
  twinDom.metrics.voltage.textContent = summary.voltage;
  twinDom.metrics.spread.textContent = summary.spread;
  twinDom.metrics.temp.textContent = summary.temp;
  twinDom.metrics.heat.textContent = summary.heat;

  const tags = [];
  if (summary.flags.length) tags.push(summary.flags.join(", "));
  if (frame.duplicateRows > 0) tags.push(`duplicates: ${frame.duplicateRows}`);
  if (frame.thermalReset) tags.push("thermal reset");
  const cellNote = activeCellConfidenceNote(frame);
  if (cellNote) tags.push(cellNote);
  twinDom.confidence.textContent = tags.length ? `${summary.confidence} - ${tags.join(" - ")}` : summary.confidence;
  twinDom.confidence.classList.toggle("is-low", summary.confidenceCode === 2);
  twinDom.confidence.classList.toggle("is-invalid", summary.confidenceCode >= 3);
}

function updateColorbar(rangeOverride) {
  const mode = HEAT_MODES[twinState.heatMode] ?? HEAT_MODES.estimated;
  const range = rangeOverride ?? rangeForMode(twinState.heatMode, twinState.manifest);
  twinDom.colorbar.style.background = colorbarForMode(twinState.heatMode);
  const heatScale = twinState.manifest?.heat_scale;
  const heatSuffix = twinState.heatMode === "heat" && heatScale?.scale?.includes("clipped") ? ", clipped at p99" : "";
  twinDom.colorbarLabel.textContent = `${mode.label} (${mode.unit}${heatSuffix})`;
  twinDom.colorbarRange.textContent = formatRange(range, mode.unit, twinState.heatMode, twinState.manifest);
}

function activeCellConfidenceNote(frame) {
  if (!["heat", "risk"].includes(twinState.heatMode)) return "";
  const values = twinState.heatMode === "heat" ? frame.qOhmic : frame.riskCell;
  if (!values?.length) return "";
  const cellIndex = values.reduce((best, value, index) => (value > values[best] ? index : best), 0);
  const confidence = frame.cellConfidence?.[cellIndex] ?? frame.packConfidence ?? frame.confidence;
  const source = frame.r0Source?.[cellIndex];
  const sourceLabel = twinState.manifest?.physics?.r0_source_codes?.[String(source)];
  return `cell ${cellIndex + 1}: ${confidenceLabel(confidence)}${sourceLabel ? `, R0 ${sourceLabel}` : ""}`;
}

function updatePlayButton() {
  twinDom.playToggle.classList.toggle("is-active", twinState.playing);
  twinDom.playToggle.querySelector("span:last-child").textContent = twinState.playing ? "Pause" : "Play";
}

function updateDigitalTwinPlayback(time) {
  if (!twinState.playing || twinState.frames.length < 2) {
    twinState.lastTickMs = time;
    return;
  }

  if (!twinState.lastTickMs) {
    twinState.lastTickMs = time;
    return;
  }

  const elapsedMs = Math.min(Math.max(time - twinState.lastTickMs, 0), 250);
  twinState.lastTickMs = time;

  if (twinState.advancePending) return;

  twinState.playbackCarryMs += elapsedMs * twinState.speed;

  let advanced = false;
  while (twinState.frameIndex < twinState.frames.length - 1) {
    const current = twinState.frames[twinState.frameIndex];
    const next = twinState.frames[twinState.frameIndex + 1];
    const stepMs = Math.max(1000, next.timeMs - current.timeMs);
    if (twinState.playbackCarryMs < stepMs) break;
    twinState.playbackCarryMs -= stepMs;
    twinState.frameIndex += 1;
    advanced = true;
  }

  if (advanced) applyTwinFrame(twinState.frameIndex);

  if (twinState.frameIndex >= twinState.frames.length - 1) {
    advanceToNextDay();
  }

  if (
    twinState.frames.length > 0 &&
    twinState.frameIndex / twinState.frames.length > 0.85 &&
    !twinState.advancePending
  ) {
    twinLoader.prefetchChunk(twinLoader.getNextChunk(twinState.chunk?.date));
  }
}

function advanceToNextDay() {
  const nextChunk = twinLoader.getNextChunk(twinState.chunk?.date);
  if (!nextChunk) {
    twinState.playing = false;
    updatePlayButton();
    return;
  }
  twinState.advancePending = true;
  twinState.savedCarryMs = twinState.playbackCarryMs;
  twinState.playbackCarryMs = 0;
  setDataStatus(`Loading ${nextChunk.date}...`);
  loadTwinChunkAutoAdvance(nextChunk);
}

async function loadTwinChunkAutoAdvance(chunk) {
  try {
    const payload = await twinLoader.loadChunk(chunk);

    if (!twinState.advancePending) return;

    if (!twinState.playing) {
      twinState.advancePending = false;
      const columns = payload.columns ?? twinState.manifest?.columns?.frame;
      const frames = payload.frames
        .map((row) => decodeFrame(row, columns))
        .filter((frame) => Number.isFinite(frame.timeMs));
      if (frames.length) {
        twinState.frames = frames;
        twinState.chunk = chunk;
        twinState.frameIndex = 0;
        twinState.playbackCarryMs = 0;
        twinDom.dateSelect.value = chunk.date;
        twinDom.frameSlider.max = Math.max(0, frames.length - 1);
        twinDom.frameSlider.value = 0;
        twinDom.frameSlider.disabled = false;
        applyTwinFrame(0);
        setDataStatus(`${chunk.date}: ${frames.length.toLocaleString()} frames`);
      }
      return;
    }

    const columns = payload.columns ?? twinState.manifest?.columns?.frame;
    const frames = payload.frames
      .map((row) => decodeFrame(row, columns))
      .filter((frame) => Number.isFinite(frame.timeMs));

    if (!frames.length) {
      twinState.advancePending = false;
      if (twinState.playing) advanceToNextDay();
      return;
    }

    twinState.frames = frames;
    twinState.chunk = chunk;
    twinState.frameIndex = 0;
    twinState.playbackCarryMs = twinState.savedCarryMs;
    twinState.advancePending = false;
    twinDom.dateSelect.value = chunk.date;
    twinDom.frameSlider.max = Math.max(0, frames.length - 1);
    twinDom.frameSlider.value = 0;
    twinDom.frameSlider.disabled = false;
    applyTwinFrame(0);
    setDataStatus(`${chunk.date}: ${frames.length.toLocaleString()} frames`);
  } catch (err) {
    console.warn(err);
    setDataStatus(`Failed to load ${chunk.date}. Stopping playback.`);
    twinState.playing = false;
    twinState.advancePending = false;
    updatePlayButton();
  }
}

function setDataStatus(text) {
  twinDom.status.textContent = text;
}

function setSensorCutaway(enabled) {
  sensorGroup.visible = enabled;

  cellVisuals.flatMap((visual) => [visual.body.material, visual.side.material, visual.top.material]).forEach((material) => {
    material.transparent = enabled;
    material.opacity = enabled ? 0.64 : 1;
    material.depthWrite = !enabled;
    material.needsUpdate = true;
  });
}

function setCurrentMode(mode) {
  currentMode = mode;
  document.querySelector("#mode-discharge").classList.toggle("is-active", mode === "discharge");
  document.querySelector("#mode-charge").classList.toggle("is-active", mode === "charge");
  animatedPulses.forEach((pulse) => {
    pulse.material = mode === "charge" ? materials.pulseCharge : materials.pulseDischarge;
  });
}

function makePolyline(points, radius, material, tubularSegments = 8) {
  const group = new THREE.Group();
  for (let i = 0; i < points.length - 1; i += 1) {
    group.add(makeCylinderBetween(points[i], points[i + 1], radius, material, tubularSegments));
  }
  return group;
}

function makeCylinderBetween(start, end, radius, material, radialSegments = 10) {
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  const geometry = new THREE.CylinderGeometry(radius, radius, length, radialSegments);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(start).lerp(end, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  mesh.castShadow = true;
  return mesh;
}

function pointAlongPolyline(points, t) {
  const segments = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const length = points[i].distanceTo(points[i + 1]);
    segments.push(length);
    total += length;
  }
  let distance = ((t % 1) + 1) % 1 * total;
  for (let i = 0; i < segments.length; i += 1) {
    if (distance <= segments[i]) {
      return points[i].clone().lerp(points[i + 1], distance / segments[i]);
    }
    distance -= segments[i];
  }
  return points.at(-1).clone();
}

function makeCanvasTexture(width, height, paint) {
  const textureCanvas = document.createElement("canvas");
  textureCanvas.width = width;
  textureCanvas.height = height;
  const ctx = textureCanvas.getContext("2d");
  paint(ctx, width, height);
  const texture = new THREE.CanvasTexture(textureCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function makeLabel(text, position, kind) {
  const element = document.createElement("div");
  element.className = `label ${kind}`;
  element.textContent = text;
  labelsLayer.appendChild(element);
  const labelAnchor = { element, position };
  labelAnchors.push(labelAnchor);
  return labelAnchor;
}

function updateLabels() {
  const width = renderer.domElement.clientWidth;
  const height = renderer.domElement.clientHeight;
  const cameraDirection = new THREE.Vector3();
  camera.getWorldDirection(cameraDirection);
  const cameraPos = camera.position;

  const projected = [];
  labelAnchors.forEach(({ element, position }) => {
    const p = position.clone().project(camera);
    const x = (p.x * 0.5 + 0.5) * width;
    const y = (-p.y * 0.5 + 0.5) * height;
    const facing = position.clone().sub(cameraPos).normalize().dot(cameraDirection) > 0;
    const inFrustum = p.z > -1 && p.z < 1 && facing;
    const dist = cameraPos.distanceTo(position);
    const distFade = dist < 6 ? 1 : dist < 14 ? 1 - (dist - 6) / 8 : 0;
    const kind = element.classList.contains('cell') ? 3 : element.classList.contains('sensor') ? 2 : 1;
    projected.push({ element, x, y, visible: inFrustum && distFade > 0.05, distFade, priority: kind });
  });

  // Sort by priority descending so high-priority labels get placed first
  projected.sort((a, b) => b.priority - a.priority);
  const placed = [];
  const MARGIN = 48;

  projected.forEach((item) => {
    if (!item.visible) {
      item.element.style.opacity = '0';
      item.element.style.pointerEvents = 'none';
      return;
    }
    // Check overlap with already-placed labels
    const overlaps = placed.some(p => Math.abs(p.x - item.x) < MARGIN && Math.abs(p.y - item.y) < MARGIN * 0.6);
    if (overlaps && item.priority < 3) {
      item.element.style.opacity = '0';
      item.element.style.pointerEvents = 'none';
      return;
    }
    placed.push(item);
    const scale = 0.75 + 0.25 * item.distFade;
    item.element.style.transform = `translate(${item.x}px, ${item.y}px) translate(-50%, -50%) scale(${scale.toFixed(3)})`;
    item.element.style.opacity = String(Math.min(1, item.distFade).toFixed(3));
    item.element.style.pointerEvents = 'auto';
  });
}

function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const pixelRatio = renderer.getPixelRatio();
  if (
    canvas.width !== Math.floor(width * pixelRatio) ||
    canvas.height !== Math.floor(height * pixelRatio)
  ) {
    renderer.setSize(width, height, false);
    composer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  uitSurfacePlot.resize();
  applyResponsiveCamera(false);
}

function applyResponsiveCamera(force) {
  const isNarrow = window.innerWidth <= 600;
  if (!force && narrowCameraState === isNarrow) return;
  narrowCameraState = isNarrow;

  if (isNarrow) {
    camera.position.set(10.2, 5.7, 11.4);
    controls.target.set(0.1, 1.78, 0);
    controls.minDistance = 7.4;
    controls.maxDistance = 21;
  } else {
    camera.position.set(7.9, 5.2, 7.5);
    controls.target.set(0, 1.85, 0);
    controls.minDistance = 5.5;
    controls.maxDistance = 18;
  }
  controls.update();
}

function animate(time = 0) {
  resize();
  updateDigitalTwinPlayback(time);
  const seconds = time / 1000;

  animatedPulses.forEach((pulse) => {
    const direction = currentMode === "charge" && !pulse.userData.balancePulse ? -1 : 1;
    const t = pulse.userData.offset + seconds * pulse.userData.speed * currentSpeedFactor * direction;
    pulse.position.copy(pointAlongPolyline(pulse.userData.path, t));
    const scale = pulse.userData.balancePulse 
      ? 0.75 + Math.sin(seconds * 6 + pulse.userData.offset) * 0.08 
      : 0.85 + Math.sin(seconds * 4 + pulse.userData.offset * 6.28) * 0.15;
    pulse.scale.setScalar(scale);
  });

  controls.update();
  composer.render();
  uitSurfacePlot.render();
  updateLabels();
  requestAnimationFrame(animate);
}

window.addEventListener("resize", resize);
