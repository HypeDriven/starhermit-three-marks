// The slate on starhermit:scene, as the browser build's js/render.js drew it
// with three.js r160: a lacquered wooden frame (an extruded rounded slab,
// wood grain and a thin clearcoat when detailed) under the slate play
// surface (an extruded rounded plate carrying the procedural surface — mottled
// grain, erased-chalk streaks, a rim vignette and the hand-wobbled etched
// grid — with slate pores as a bump map when detailed), sealed cells as pale
// plugs with a cross groove, the chalk X and O marks (seeded jittered tubes
// drawn on stroke by stroke), the ghost preview under the pointer (danger
// coloured over an illegal cell), the pulsing selection ring and lesson
// rings, the winning line drawn across, chalk-dust bursts, lamp-light motes
// (particles high), desk props (chalk sticks and an eraser) on a plank desk
// when detailed, the authored camera (standard / top / low angles, the
// intro swoop, the win pulse, the drag parallax) fitted to the window, and
// the fog that follows the fitted distance.
//
// Engine minor 23 is three.js r185's light units and shadows, and the page
// was r160 (physical lights by default since r155), so the page's own values
// stand: the warm key 2.6 with its shadow (camera box fitted to the slate,
// bias -0.0005, normal bias 0.015, radius 4, PCF soft), the cool rim 0.7,
// the hemisphere fill 0.9 (0.55 while reflections are on). Reflections are
// set up as the page had them: `new RoomEnvironment(renderer)` (r155–r162:
// the page's own argument) prefiltered with sigma 0.04. The page set it as
// scene.environment, and r160 then scaled it by each material's
// envMapIntensity (0.12–0.5); the engine at minor 23 follows r163+, where
// scene.environment takes only scene.environmentIntensity, so each lit
// material gets the prefiltered room as its own envMap with the page's
// intensity — the r160 result. The composer (half floats → GTAO → bloom at
// threshold 0.92 → OutputPass → the display-space grade and vignette →
// SMAA / FXAA, or the canvas MSAA) is the runtime's renderer.ao / bloom /
// grade / antialias. Graphics follow the runtime's quality tier
// (native/quality.ts: gfx.js's presets and budgets).
import {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CatmullRomCurve3, CircleGeometry,
  Color, CylinderGeometry, DirectionalLight, ExtrudeGeometry, Fog, Group, HemisphereLight, MathUtils, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, PCFSoftShadowMap, PerspectiveCamera, PMREMGenerator, Plane, Points,
  PointsMaterial, Raycaster, RepeatWrapping, RoomEnvironment, Shape, SRGBColorSpace, TorusGeometry, TubeGeometry, Vector2, Vector3,
  pointerToNdc, renderer, scene, type Material, type Object3D, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";
import type { Config, State, Theme } from "./game.ts";
import { particleBudget, type Look } from "./quality.ts";
import { RngStream } from "../js/rng.js";

interface Rng { next(): number; range(a: number, b: number): number }
const rngOf = (seed: number): Rng => new (RngStream as unknown as new (s: number) => Rng)(seed >>> 0);

const FRAMING = {
  boardWorld: 3.0, boardThickness: 0.16, frameMargin: 0.28, fov: 28,
  cameras: {
    standard: { phi: 0.62, theta: 0.0, dist: 6.4, lookY: 0.0 },
    top: { phi: 0.18, theta: 0.0, dist: 6.8, lookY: 0.0 },
    low: { phi: 0.95, theta: 0.0, dist: 6.0, lookY: 0.05 },
  } as Record<string, Pose>,
  introSwoopMs: 900, camTransitionMs: 550,
};
interface Pose { phi: number; theta: number; dist: number; lookY: number }
const PALETTE_OVERRIDES: Record<string, { markB?: number }> = { default: {}, deuteranopia: { markB: 0x4a9ff2 }, tritanopia: { markB: 0xe0654f } };
/** Themes whose marks read as light sources: extra emissive so bloom catches them. */
const THEME_GLOW: Record<string, number> = { neon: 0.55, abyss: 0.2 };
const hex = (c: Color): string => "#" + c.getHex().toString(16).padStart(6, "0");
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
type Ctx = OffscreenCanvasRenderingContext2D;

// ---------------------------------------------------------------- procedural textures (render.js, unchanged painting)
function canvas(size: number): { c: OffscreenCanvas; g: Ctx } {
  const c = new OffscreenCanvas(size, size);
  return { c, g: c.getContext("2d") };
}
function makeSurfaceTexture(theme: Theme, seed: number, boardCells: number): Texture {
  const size = 512;
  const { c, g: ctx } = canvas(size);
  const rng = rngOf(seed ^ 0x5eed);
  ctx.fillStyle = hex(new Color(theme.board));
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 2600; i++) {
    const x = rng.next() * size, y = rng.next() * size, r = rng.range(0.5, 2.4);
    const light = rng.next() > 0.5;
    ctx.fillStyle = light ? `rgba(255,255,255,${rng.range(0.008, 0.03)})` : `rgba(0,0,0,${rng.range(0.01, 0.045)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 26; i++) {
    ctx.save();
    ctx.translate(rng.next() * size, rng.next() * size);
    ctx.rotate(rng.range(-0.4, 0.4));
    ctx.fillStyle = `rgba(255,255,255,${rng.range(0.008, 0.028)})`;
    ctx.fillRect(-rng.range(30, 120), -rng.range(4, 14), rng.range(60, 240), rng.range(8, 28));
    ctx.restore();
  }
  const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.32, size / 2, size / 2, size * 0.72);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.22)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const n = boardCells, cell = size / n;
  ctx.strokeStyle = hex(new Color(theme.grid));
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = Math.max(2, size / 256);
  ctx.lineCap = "round";
  for (let i = 1; i < n; i++) {
    const p = i * cell;
    const wob = (): number => rng.range(-1.6, 1.6);
    ctx.beginPath();
    ctx.moveTo(p + wob(), wob());
    ctx.lineTo(p + wob(), size + wob());
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(wob(), p + wob());
    ctx.lineTo(size + wob(), p + wob());
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
function makeWoodTextures(baseHex: number, seed: number, { planks = 0, size = 512, strength = 1 } = {}): { map: Texture; roughnessMap: Texture } {
  const rng = rngOf(seed);
  const { c: col, g: cx } = canvas(size);
  cx.fillStyle = hex(new Color(baseHex));
  cx.fillRect(0, 0, size, size);
  const { c: rough, g: rx } = canvas(size);
  rx.fillStyle = "rgb(190,190,190)";
  rx.fillRect(0, 0, size, size);
  for (let i = 0; i < 180; i++) {
    const y0 = rng.next() * size;
    const amp = rng.range(1, 6);
    const freq = (Math.PI * 2 * Math.round(rng.range(1, 4))) / size;
    const phase = rng.next() * 6.28;
    const light = rng.next() > 0.55;
    const a = rng.range(0.02, 0.08) * strength;
    cx.strokeStyle = light ? `rgba(255,236,210,${a * 0.6})` : `rgba(0,0,0,${a * 1.6})`;
    cx.lineWidth = rng.range(0.6, 3.2);
    rx.strokeStyle = light ? `rgba(120,120,120,${a * 2})` : `rgba(235,235,235,${a * 2})`;
    rx.lineWidth = cx.lineWidth;
    cx.beginPath();
    rx.beginPath();
    for (let x = 0; x <= size; x += 8) {
      const y = y0 + Math.sin(x * freq + phase) * amp;
      if (x === 0) { cx.moveTo(x, y); rx.moveTo(x, y); } else { cx.lineTo(x, y); rx.lineTo(x, y); }
    }
    cx.stroke();
    rx.stroke();
  }
  for (let k = 0; k < 3; k++) {
    const x = rng.next() * size, y = rng.next() * size;
    for (let r = 14; r > 2; r -= 3) {
      cx.strokeStyle = `rgba(0,0,0,${0.05 + (14 - r) * 0.01})`;
      cx.lineWidth = 1.2;
      cx.beginPath();
      cx.ellipse(x, y, r * 2.2, r * 0.8, 0, 0, Math.PI * 2);
      cx.stroke();
    }
  }
  if (planks > 0) {
    const h = size / planks;
    for (let i = 0; i <= planks; i++) {
      const y = i * h;
      cx.fillStyle = "rgba(0,0,0,0.35)";
      cx.fillRect(0, y - 1.5, size, 3);
      cx.fillStyle = `rgba(255,240,220,${Math.max(0, rng.range(-0.02, 0.03)) * strength})`;
      cx.fillRect(0, y + 1.5, size, h - 3);
      rx.fillStyle = "rgb(255,255,255)";
      rx.fillRect(0, y - 1.5, size, 3);
    }
  }
  const map = new CanvasTexture(col);
  map.colorSpace = SRGBColorSpace;
  const roughnessMap = new CanvasTexture(rough);
  for (const t of [map, roughnessMap]) { t.wrapS = t.wrapT = RepeatWrapping; t.anisotropy = 4; }
  return { map, roughnessMap };
}
function makeGrainTexture(seed: number, size = 256, dots = 5000): Texture {
  const { c, g: ctx } = canvas(size);
  const rng = rngOf(seed);
  ctx.fillStyle = "rgb(128,128,128)";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < dots; i++) {
    const v = rng.next() > 0.5 ? 255 : 0;
    ctx.fillStyle = `rgba(${v},${v},${v},${rng.range(0.08, 0.35)})`;
    ctx.fillRect(rng.next() * size, rng.next() * size, rng.range(0.8, 2.6), rng.range(0.8, 2.6));
  }
  const tex = new CanvasTexture(c);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  return tex;
}
let softDot: Texture | null = null;
function dotTexture(): Texture {
  if (softDot) return softDot;
  const { c, g: ctx } = canvas(64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  softDot = new CanvasTexture(c);
  softDot.colorSpace = SRGBColorSpace;
  return softDot;
}
function roundedRectShape(w: number, h: number, r: number): Shape {
  const s = new Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

// ---------------------------------------------------------------- materials
interface LitParams {
  color?: number; map?: Texture | null; roughnessMap?: Texture | null; bumpMap?: Texture | null; bumpScale?: number; roughness?: number;
  metalness?: number; emissive?: number; emissiveIntensity?: number; envMapIntensity?: number; clearcoat?: number; clearcoatRoughness?: number;
  transparent?: boolean; opacity?: number;
}
/** render.js litMaterial: Lambert (Low), Standard, Physical where `physical` and the budget allow; unknown parameters dropped. */
function lit(p: LitParams, physical = false): Material {
  const kind = look!.budget.material;
  // colours are fresh Color objects per material (the engine keeps the object it is given)
  const common: Record<string, unknown> = {};
  if (p.color != null) common.color = new Color(p.color);
  if (p.map) common.map = p.map;
  if (p.emissive != null) common.emissive = new Color(p.emissive);
  if (p.emissiveIntensity != null) common.emissiveIntensity = p.emissiveIntensity;
  if (p.bumpMap) { common.bumpMap = p.bumpMap; common.bumpScale = p.bumpScale ?? 1; }
  if (p.transparent) { common.transparent = true; common.opacity = p.opacity ?? 1; }
  if (kind === "lambert") return new MeshLambertMaterial(common);
  const pbr: Record<string, unknown> = { ...common };
  if (p.roughness != null) pbr.roughness = p.roughness;
  if (p.metalness != null) pbr.metalness = p.metalness;
  if (p.roughnessMap) pbr.roughnessMap = p.roughnessMap;
  // r160: the scene's environment scaled by the material's own envMapIntensity (see the header)
  if (envTex) { pbr.envMap = envTex; pbr.envMapIntensity = p.envMapIntensity ?? 1; }
  if (kind === "physical" && physical) {
    if (p.clearcoat != null) pbr.clearcoat = p.clearcoat;
    if (p.clearcoatRoughness != null) pbr.clearcoatRoughness = p.clearcoatRoughness;
    return new MeshPhysicalMaterial(pbr);
  }
  return new MeshStandardMaterial(pbr);
}

// ---------------------------------------------------------------- the scene
const camera = new PerspectiveCamera(FRAMING.fov, 1, 0.1, 60);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.type = PCFSoftShadowMap;
const fog = new Fog(0x14161c, 9, 16);
scene.fog = fog;
const keyLight = new DirectionalLight(0xfff1d6, 2.6);
keyLight.position.set(3.2, 5.2, 2.4);
keyLight.shadow.bias = -0.0005;
keyLight.shadow.normalBias = 0.015;
keyLight.shadow.radius = 4;
const rimLight = new DirectionalLight(0x8fa3c8, 0.7);
rimLight.position.set(-2.5, 3.0, -4.5);
const fillLight = new HemisphereLight(0x8fa3c8, 0x1a1c22, 0.9);
scene.add(keyLight, keyLight.target, rimLight, fillLight);

let look: Look | null = null;
let theme: Theme | null = null;
let config: Config | null = null;
let visualSeed = 1;
let palette = "default";
let reduced = false;
let envTex: Texture | null = null;
let envTried = false;
let displayPlayer = 1;
let angle = "standard";

interface Stroke { mesh: Mesh; total: number }
interface MarkEntry { group: Group; player: number }
interface Anim { dur: number; t: number; delay?: number; update: (k: number) => void; done?: () => void }
interface BoardView {
  objects: Object3D[]; boardGroup: Group; selection: Mesh; highlights: Group; marks: Map<number, MarkEntry>;
  ghost: Group | null; winLine: Mesh | null; winCells: number[] | null; winPlayer: number;
  dust: { cap: number; pos: Float32Array; vel: Float32Array; life: Float32Array; geo: BufferGeometry; points: Points; rng: Rng };
  motes: { pts: Points; pos: Float32Array; seed: Float32Array; count: number } | null; grain: Texture | null;
}
let view: BoardView | null = null;
const anims: Anim[] = [];
let camPose: Pose = { ...FRAMING.cameras.standard! };
let camAnim: { from: Pose; to: Pose; t: number; dur: number } | null = null;
const parallax = { x: 0, y: 0 };
let lastKey = "";
let hoverCell: number | null = null;
let hoverLegal = true;
let selectedCell: number | null = null;
let lessonCells = new Set<number>();
let win = { w: 1, h: 1 };
let clockS = 0;

function ensureEnvironment(): void {
  if (envTried) return;
  envTried = true;
  try {
    const pmrem = new PMREMGenerator(renderer);
    envTex = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  } catch (e) { console.warn(`environment: ${String(e)}`); envTex = null; }
}

export function cellCenter(index: number): { x: number; z: number } {
  const n = config!.boardSize, cell = FRAMING.boardWorld / n;
  const r = Math.floor(index / n), c = index % n;
  return { x: -FRAMING.boardWorld / 2 + cell * (c + 0.5), z: -FRAMING.boardWorld / 2 + cell * (r + 0.5) };
}
function markColors(): { a: number; b: number } {
  const o = PALETTE_OVERRIDES[palette] ?? {};
  return { a: theme!.markA, b: o.markB ?? theme!.markB };
}
function chalkMaterial(color: number, opacity = 1, glow = 0): Material {
  return lit({
    color, roughness: 1, metalness: 0, emissive: color,
    emissiveIntensity: 0.08 + (THEME_GLOW[theme!.id] || 0) + glow,
    bumpMap: view?.grain ?? null, bumpScale: 1.2, envMapIntensity: 0.25, transparent: opacity < 1, opacity,
  });
}
function makeMark(player: number, cellIndex: number, opacity = 1, mat?: Material): Group {
  const colors = markColors();
  const color = player === 1 ? colors.a : colors.b;
  const rng = rngOf((visualSeed ^ Math.imul(cellIndex, 2654435761)) >>> 0);
  const group = new Group();
  const cell = FRAMING.boardWorld / config!.boardSize;
  const R = cell * 0.3;
  const material = mat ?? chalkMaterial(color, opacity);
  const b = look!.budget;
  const stroke = (points: Vector3[]): Stroke => {
    const curve = new CatmullRomCurve3(points);
    const geo = new TubeGeometry(curve, b.tube, cell * 0.045, b.tubeRadial, false);
    const pos = geo.attributes.position as BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(i, pos.getX(i) + rng.range(-0.006, 0.006), pos.getY(i) + rng.range(-0.004, 0.004), pos.getZ(i) + rng.range(-0.006, 0.006));
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    const mesh = new Mesh(geo, material);
    mesh.castShadow = true;
    return { mesh, total: geo.index ? geo.index.count : pos.count };
  };
  const wob = (): number => rng.range(-0.03, 0.03);
  const y = 0.055;
  let strokes: Stroke[];
  if (player === 1) {
    strokes = [
      stroke([new Vector3(-R + wob(), y, -R + wob()), new Vector3(wob(), y + 0.005, wob()), new Vector3(R + wob(), y, R + wob())]),
      stroke([new Vector3(R + wob(), y, -R + wob()), new Vector3(wob(), y + 0.005, wob()), new Vector3(-R + wob(), y, R + wob())]),
    ];
  } else {
    const pts: Vector3[] = [];
    const turns = 18;
    for (let i = 0; i <= turns; i++) {
      const a = (i / turns) * Math.PI * 2 + rng.range(-0.05, 0.05);
      const rr = R * (1 + rng.range(-0.06, 0.06));
      pts.push(new Vector3(Math.cos(a) * rr, y, Math.sin(a) * rr));
    }
    strokes = [stroke(pts)];
  }
  group.userData.strokes = strokes;
  for (const s of strokes) group.add(s.mesh);
  return group;
}
function strokesOf(g: Group): Stroke[] { return g.userData.strokes as Stroke[]; }

function dispose(obj: Object3D): void {
  obj.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry) m.geometry.dispose();
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const mat of mats) mat.dispose();
  });
}
function clearView(): void {
  if (!view) return;
  for (const o of view.objects) { scene.remove(o); dispose(o); }
  view = null;
  anims.length = 0;
}

/** render.js buildBoard / _buildScene: everything for a rules config, theme, palette and visual seed (clears marks). */
export function buildBoard(cfg: Config, seed: number, th: Theme, pal: string, intro = true): void {
  config = cfg;
  visualSeed = seed >>> 0;
  theme = th;
  palette = pal;
  lastKey = "";
  hoverCell = null;
  selectedCell = null;
  build();
  if (intro) introSwoop();
}
function build(): void {
  if (!look || !theme || !config) return;
  clearView();
  const q = look, B = q.budget, detailed = q.detailed, th = theme;
  if (q.reflections) ensureEnvironment();
  const env = q.reflections ? envTex : null;
  const keepEnv = envTex;
  envTex = env;
  scene.background = new Color(th.bg);
  fog.color = new Color(th.fog);
  keyLight.color = new Color(th.key);
  rimLight.color = new Color(th.fill);
  fillLight.color = new Color(th.fill);
  fillLight.groundColor = new Color(th.ground);
  fillLight.intensity = env ? 0.55 : 0.9;
  {
    const sh = keyLight.shadow;
    const ext = FRAMING.boardWorld / 2 + FRAMING.frameMargin + (detailed ? 0.95 : 0.3);
    Object.assign(sh.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 2.5, far: 11 });
    sh.camera.updateProjectionMatrix();
  }
  const objects: Object3D[] = [];
  // the desk (wood planks when detailed)
  const ground = new Mesh(new CircleGeometry(40, B.round * 2), detailed ? (() => {
    const wood = makeWoodTextures(th.ground, visualSeed ^ 0xde5c, { planks: 4, strength: 0.6, size: B.texture });
    for (const t of [wood.map, wood.roughnessMap]) t.repeat.set(18, 18);
    return lit({ color: 0xffffff, map: wood.map, roughnessMap: wood.roughnessMap, roughness: 0.95, metalness: 0, envMapIntensity: 0.12 });
  })() : lit({ color: th.ground, roughness: 1, metalness: 0, envMapIntensity: 0.25 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -FRAMING.boardThickness - 0.02;
  ground.receiveShadow = true;
  scene.add(ground);
  objects.push(ground);

  let grain: Texture | null = null;
  if (detailed) {
    grain = makeGrainTexture(visualSeed ^ 0xc4a1, B.texture / 4, Math.round(2200 * (B.texture / 512) ** 2));
    grain.repeat.set(6, 1);
  }
  const boardGroup = new Group();
  scene.add(boardGroup);
  objects.push(boardGroup);
  const n = config.boardSize, W = FRAMING.boardWorld;
  // the frame
  const frameGeo = new ExtrudeGeometry(roundedRectShape(W + FRAMING.frameMargin * 2, W + FRAMING.frameMargin * 2, 0.14), {
    depth: FRAMING.boardThickness, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: B.bevel, curveSegments: B.curve,
  });
  frameGeo.rotateX(-Math.PI / 2);
  let frameMat: Material;
  if (detailed) {
    const wood = makeWoodTextures(th.frame, visualSeed ^ 0xf4a3, { size: B.texture });
    for (const t of [wood.map, wood.roughnessMap]) t.repeat.set(0.35, 0.35);
    frameMat = lit({ color: 0xffffff, map: wood.map, roughnessMap: wood.roughnessMap, roughness: 0.9, metalness: 0, envMapIntensity: 0.3, clearcoat: 0.3, clearcoatRoughness: 0.5 }, true);
  } else frameMat = lit({ color: th.frame, roughness: 0.7, metalness: 0, envMapIntensity: 0.3, clearcoat: 0, clearcoatRoughness: 0.5 }, true);
  const frameMesh = new Mesh(frameGeo, frameMat);
  frameMesh.position.y = -FRAMING.boardThickness;
  frameMesh.castShadow = true;
  frameMesh.receiveShadow = true;
  boardGroup.add(frameMesh);
  // the play surface, its UVs 0..1 across the face so the grid meets the cells
  const boardGeo = new ExtrudeGeometry(roundedRectShape(W, W, 0.08), { depth: 0.045, bevelEnabled: false, curveSegments: B.curve });
  boardGeo.rotateX(-Math.PI / 2);
  boardGeo.computeBoundingBox();
  {
    const bb = boardGeo.boundingBox!;
    const pos = boardGeo.attributes.position as BufferAttribute, uv = boardGeo.attributes.uv as BufferAttribute;
    const sx = bb.max.x - bb.min.x, sz = bb.max.z - bb.min.z;
    // three's flipY canvas texture: v = 1 at the image's top; the engine samples v from the first row
    for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) - bb.min.x) / sx, (pos.getZ(i) - bb.min.z) / sz);
    uv.needsUpdate = true;
  }
  let boardBump: Texture | null = null;
  if (detailed) {
    boardBump = makeGrainTexture(visualSeed ^ 0x51a7, B.texture / 2, Math.round(6000 * (B.texture / 512) ** 2));
    boardBump.repeat.set(3, 3);
  }
  const boardMesh = new Mesh(boardGeo, lit({ color: 0xffffff, map: makeSurfaceTexture(th, visualSeed, n), roughness: 0.92, metalness: 0, envMapIntensity: 0.35, bumpMap: boardBump, bumpScale: 0.6 }));
  boardMesh.castShadow = true;
  boardMesh.receiveShadow = true;
  boardGroup.add(boardMesh);
  // sealed cells
  const cell = W / n;
  for (const c of config.disabledCells) {
    const { x, z } = cellCenter(c);
    const plug = new Mesh(new CylinderGeometry(cell * 0.32, cell * 0.32, 0.03, B.round), lit({ color: th.grid, roughness: 1, emissive: th.grid, emissiveIntensity: 0.06 }));
    plug.position.set(x, 0.062, z);
    boardGroup.add(plug);
    const groove = new Mesh(new BoxGeometry(cell * 0.34, 0.012, cell * 0.07), lit({ color: th.boardEdge, roughness: 1 }));
    groove.position.set(x, 0.082, z);
    groove.rotation.y = Math.PI / 4;
    boardGroup.add(groove);
  }
  const highlights = new Group();
  boardGroup.add(highlights);
  // desk props
  if (detailed) {
    const rng = rngOf(visualSeed ^ 0xca1c);
    const props = new Group();
    const chalkA = lit({ color: th.markA, roughness: 1, bumpMap: grain, bumpScale: 1.5, envMapIntensity: 0.3 });
    const chalkB = lit({ color: th.markB, roughness: 1, bumpMap: grain, bumpScale: 1.5, envMapIntensity: 0.3 });
    const stickGeo = new CylinderGeometry(0.035, 0.035, 0.42, Math.max(6, B.round / 2));
    const groundY = -FRAMING.boardThickness - 0.02;
    const s1 = new Mesh(stickGeo, chalkA);
    s1.rotation.set(Math.PI / 2, 0, rng.range(-0.4, 0.4));
    s1.position.set(2.15, groundY + 0.035, 0.9);
    const s2 = new Mesh(stickGeo, chalkB);
    s2.rotation.set(Math.PI / 2, 0, rng.range(-0.4, 0.4));
    s2.position.set(2.05, groundY + 0.035, 1.25);
    const eraser = new Mesh(new BoxGeometry(0.5, 0.14, 0.22), lit({ color: th.frame, roughness: 0.75, envMapIntensity: 0.5 }));
    eraser.position.set(-2.2, groundY + 0.07, -1.1);
    eraser.rotation.y = rng.range(-0.5, 0.5);
    for (const p of [s1, s2, eraser]) { p.castShadow = true; props.add(p); }
    scene.add(props);
    objects.push(props);
  }
  // the selection ring
  const selGeo = new TorusGeometry(cell * 0.4, 0.014, 8, 40);
  selGeo.rotateX(Math.PI / 2);
  const selection = new Mesh(selGeo, new MeshBasicMaterial({ color: new Color(th.accent), transparent: true, opacity: 0.9 }));
  selection.position.y = 0.052;
  selection.visible = false;
  boardGroup.add(selection);
  // chalk dust (pooled)
  const cap = particleBudget(q).pool;
  const dustPos = new Float32Array(cap * 3);
  for (let i = 0; i < cap; i++) dustPos[i * 3 + 1] = -10;
  const dustGeo = new BufferGeometry();
  dustGeo.setAttribute("position", new BufferAttribute(dustPos, 3));
  const dustPoints = new Points(dustGeo, new PointsMaterial({
    color: new Color(th.markA), size: 0.04, transparent: true, opacity: 0.75, depthWrite: false, sizeAttenuation: true, map: dotTexture(),
  }));
  dustPoints.frustumCulled = false;
  scene.add(dustPoints);
  objects.push(dustPoints);
  // lamp-light motes (particles high)
  let motes: BoardView["motes"] = null;
  const count = particleBudget(q).motes;
  if (count) {
    const rng = rngOf(visualSeed ^ 0x3073);
    const pos = new Float32Array(count * 3), sd = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = rng.range(-2.6, 2.6);
      pos[i * 3 + 1] = rng.range(0.15, 2.4);
      pos[i * 3 + 2] = rng.range(-2.2, 2.2);
      sd[i] = rng.next() * 100;
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(pos, 3));
    const pts = new Points(geo, new PointsMaterial({
      color: new Color(th.key), size: 0.022, transparent: true, opacity: 0.35, depthWrite: false, sizeAttenuation: true, map: dotTexture(), blending: AdditiveBlending,
    }));
    pts.frustumCulled = false;
    scene.add(pts);
    objects.push(pts);
    motes = { pts, pos, seed: sd, count };
  }
  view = {
    objects, boardGroup, selection, highlights, marks: new Map(), ghost: null, winLine: null, winCells: null, winPlayer: 0, grain,
    dust: { cap, pos: dustPos, vel: new Float32Array(cap * 3), life: new Float32Array(cap), geo: dustGeo, points: dustPoints, rng: rngOf(visualSeed ^ 0xd057) },
    motes,
  };
  envTex = keepEnv;
  if (!q.reflections) envTex = keepEnv; // kept for a later tier
  refreshHighlights();
  applyCamera();
}

// ---------------------------------------------------------------- state sync
function placeMark(cell: number, player: number, instant: boolean): void {
  const v = view!;
  const group = makeMark(player, cell);
  const { x, z } = cellCenter(cell);
  group.position.set(x, 0, z);
  v.boardGroup.add(group);
  v.marks.set(cell, { group, player });
  spawnDust(x, z, player);
  if (instant) { for (const s of strokesOf(group)) s.mesh.geometry.setDrawRange(0, Infinity); return; }
  strokesOf(group).forEach((s, si) => {
    s.mesh.geometry.setDrawRange(0, 0);
    const total = s.total;
    anims.push({ dur: 260, delay: si * 140, t: 0, update: (k) => s.mesh.geometry.setDrawRange(0, Math.floor(total * easeOutCubic(k))) });
  });
}
function spawnDust(x: number, z: number, player: number): void {
  const d = view!.dust;
  const count = particleBudget(look!).dustPerMark;
  const colors = markColors();
  (d.points.material as PointsMaterial).color = new Color(player === 1 ? colors.a : colors.b);
  for (let n = 0; n < count; n++) {
    let slot = -1;
    for (let i = 0; i < d.cap; i++) if (d.life[i]! <= 0) { slot = i; break; }
    if (slot < 0) break;
    const i3 = slot * 3;
    d.pos[i3] = x + d.rng.range(-0.12, 0.12);
    d.pos[i3 + 1] = 0.06;
    d.pos[i3 + 2] = z + d.rng.range(-0.12, 0.12);
    d.vel[i3] = d.rng.range(-0.25, 0.25);
    d.vel[i3 + 1] = d.rng.range(0.25, 0.8);
    d.vel[i3 + 2] = d.rng.range(-0.25, 0.25);
    d.life[slot] = d.rng.range(0.4, 0.9);
  }
}
/** render.js syncState: reconcile the marks with a rules snapshot; the win line or the draw pulse at the end. */
export function syncState(state: State, instant = false): void {
  const v = view;
  if (!v) return;
  const key = state.board.join("") + "|" + state.status + "|" + (state.winLine || []).join(",");
  if (key === lastKey) return;
  lastKey = key;
  for (const cell of [...v.marks.keys()]) {
    if (state.board[cell] === 0) {
      const e = v.marks.get(cell)!;
      v.boardGroup.remove(e.group);
      dispose(e.group);
      v.marks.delete(cell);
    }
  }
  for (let i = 0; i < state.board.length; i++) {
    const p = state.board[i]!;
    if (p !== 0 && !v.marks.has(i)) placeMark(i, p, instant || reduced);
  }
  if (state.status === "terminal") {
    clearGhost();
    if (state.winLine) showWinLine(state.winLine, state.winner, instant || reduced);
    if (state.winner === 0) pulseBoard();
  } else clearWinLine();
}
function showWinLine(cells: number[], player: number, instant: boolean): void {
  const v = view!;
  clearWinLine();
  v.winCells = cells.slice();
  v.winPlayer = player;
  const first = cellCenter(cells[0]!), last = cellCenter(cells[cells.length - 1]!);
  const colors = markColors();
  const color = player === 1 ? colors.a : player === 2 ? colors.b : theme!.accent;
  const dir = new Vector3(last.x - first.x, 0, last.z - first.z);
  const len = dir.length() + (FRAMING.boardWorld / config!.boardSize) * 0.7;
  dir.normalize();
  const mid = new Vector3((first.x + last.x) / 2, 0.05, (first.z + last.z) / 2);
  const rng = rngOf(visualSeed ^ 0x1abe);
  const pts: Vector3[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = (i / 16 - 0.5) * len;
    pts.push(new Vector3(mid.x + dir.x * t + rng.range(-0.012, 0.012), 0.05, mid.z + dir.z * t + rng.range(-0.012, 0.012)));
  }
  const geo = new TubeGeometry(new CatmullRomCurve3(pts), 32, 0.028, 6, false);
  v.winLine = new Mesh(geo, chalkMaterial(color, 1, 0.9));
  v.boardGroup.add(v.winLine);
  if (instant) { geo.setDrawRange(0, Infinity); return; }
  geo.setDrawRange(0, 0);
  const total = geo.index ? geo.index.count : 0;
  anims.push({ dur: 500, t: 0, update: (k) => geo.setDrawRange(0, Math.floor(total * easeOutCubic(k))) });
  if (!reduced) cameraPulse();
}
function clearWinLine(): void {
  const v = view;
  if (!v) return;
  if (v.winLine) { v.boardGroup.remove(v.winLine); dispose(v.winLine); v.winLine = null; }
  v.winCells = null;
}
function clearGhost(): void {
  const v = view;
  if (v?.ghost) { v.boardGroup.remove(v.ghost); dispose(v.ghost); v.ghost = null; }
}
function pulseBoard(): void {
  if (reduced) return;
  const g = view!.boardGroup;
  anims.push({ dur: 420, t: 0, update: (k) => g.scale.setScalar(1 + Math.sin(k * Math.PI) * 0.012), done: () => g.scale.setScalar(1) });
}
function cameraPulse(): void {
  const base = { ...camPose };
  camAnim = null;
  anims.push({
    dur: 500, t: 0,
    update: (k) => { camPose.dist = base.dist - Math.sin(k * Math.PI) * 0.05; applyCamera(); },
    done: () => { camPose = base; applyCamera(); },
  });
}
/** render.js skipAnimations: every visual at its settled end state. */
export function skipAnimations(): void {
  anims.length = 0;
  camAnim = null;
  camPose = { ...(FRAMING.cameras[angle] ?? FRAMING.cameras.standard!) };
  applyCamera();
  const v = view;
  if (!v) return;
  v.boardGroup.scale.setScalar(1);
  for (const { group } of v.marks.values()) for (const s of strokesOf(group)) s.mesh.geometry.setDrawRange(0, Infinity);
  if (v.winLine) v.winLine.geometry.setDrawRange(0, Infinity);
  v.dust.life.fill(0);
  for (let i = 0; i < v.dust.cap; i++) v.dust.pos[i * 3 + 1] = -10;
  (v.dust.geo.attributes.position as BufferAttribute).needsUpdate = true;
}
/** The ghost mark under the pointer (danger coloured when illegal); null clears it. */
export function setHover(cell: number | null, legal = true): void {
  if (cell === hoverCell && legal === hoverLegal) return;
  hoverCell = cell;
  hoverLegal = legal;
  clearGhost();
  const v = view;
  if (cell == null || !v) return;
  const g = legal ? makeMark(displayPlayer, cell, 0.4) : makeMark(displayPlayer, cell, 0.5, chalkMaterial(theme!.danger, 0.5));
  const { x, z } = cellCenter(cell);
  g.position.set(x, 0, z);
  v.ghost = g;
  v.boardGroup.add(g);
}
export function setDisplayPlayer(p: number): void { displayPlayer = p; }
export function setSelection(cell: number | null): void {
  selectedCell = cell;
  const v = view;
  if (!v) return;
  if (cell == null) { v.selection.visible = false; return; }
  const { x, z } = cellCenter(cell);
  v.selection.position.set(x, 0.052, z);
  v.selection.visible = true;
}
export function setLessonHighlights(cells: number[]): void {
  lessonCells = new Set(cells);
  refreshHighlights();
}
function refreshHighlights(): void {
  const v = view;
  if (!v) return;
  while (v.highlights.children.length) { const c = v.highlights.children[v.highlights.children.length - 1]!; v.highlights.remove(c); dispose(c); }
  const cell = FRAMING.boardWorld / config!.boardSize;
  for (const c of lessonCells) {
    const geo = new TorusGeometry(cell * 0.38, 0.02, 8, 36);
    geo.rotateX(Math.PI / 2);
    const ring = new Mesh(geo, new MeshBasicMaterial({ color: new Color(theme!.accent), transparent: true, opacity: 0.85 }));
    const { x, z } = cellCenter(c);
    ring.position.set(x, 0.052, z);
    v.highlights.add(ring);
  }
}
/** Rebuilds the scene keeping the marks, hover, selection, highlights and win line (theme, palette or tier change). */
function rebuildPreserving(): void {
  const v = view;
  if (!v) { build(); return; }
  const marks = [...v.marks.entries()].map(([cell, e]) => ({ cell, player: e.player }));
  const win0 = v.winCells ? { cells: v.winCells, player: v.winPlayer } : null;
  const hover = hoverCell, hl = hoverLegal, sel = selectedCell;
  build();
  for (const m of marks) placeMark(m.cell, m.player, true);
  skipAnimations();
  hoverCell = null;
  if (hover != null) setHover(hover, hl);
  setSelection(sel);
  if (win0) showWinLine(win0.cells, win0.player, true);
}
export function setTheme(th: Theme, pal: string): void {
  if (theme && th.id === theme.id && pal === palette) return;
  theme = th;
  palette = pal;
  rebuildPreserving();
}

// ---------------------------------------------------------------- camera
function fitDistance(poseDist: number): number {
  const extent = FRAMING.boardWorld / 2 + FRAMING.frameMargin + 0.35;
  const halfFov = MathUtils.degToRad(FRAMING.fov / 2);
  const aspect = camera.aspect || 1;
  const needV = (extent * Math.max(0.55, Math.cos(camPose.phi)) + 0.35) * 1.12;
  const distV = needV / Math.tan(halfFov);
  const distH = (extent * 1.12) / (Math.tan(halfFov) * aspect);
  const fit = Math.max(distV, distH);
  return Math.max(fit, fit * (poseDist / 6.4));
}
function applyCamera(): void {
  const { phi, theta, lookY } = camPose;
  const dist = fitDistance(camPose.dist);
  camera.position.set(Math.sin(phi) * Math.sin(theta) * dist + parallax.x, Math.cos(phi) * dist, Math.sin(phi) * Math.cos(theta) * dist + parallax.y);
  camera.lookAt(0, lookY, 0);
  fog.near = dist + 2.5;
  fog.far = dist + 10;
}
function introSwoop(): void {
  const pose = FRAMING.cameras[angle] ?? FRAMING.cameras.standard!;
  if (reduced) { camPose = { ...pose }; camAnim = null; applyCamera(); return; }
  camPose = { ...pose, dist: pose.dist * 1.5, phi: pose.phi * 0.5 };
  applyCamera();
  camAnim = { from: { ...camPose }, to: { ...pose }, t: 0, dur: FRAMING.introSwoopMs };
}
/** render.js setCameraAngle: eased to the angle (at once with reduced motion). */
export function setCameraAngle(a: string): void {
  const pose = FRAMING.cameras[a] ?? FRAMING.cameras.standard!;
  if (a === angle && !camAnim) return;
  angle = a;
  if (reduced) { camPose = { ...pose }; camAnim = null; applyCamera(); return; }
  camAnim = { from: { ...camPose }, to: { ...pose }, t: 0, dur: FRAMING.camTransitionMs };
}
/** The pointer-drag parallax (render.js: −drag × 0.0012, at most ±0.12), 0 on release. */
export function setParallax(dx: number, dy: number): void {
  const x = reduced ? 0 : MathUtils.clamp(-dx * 0.0012, -0.12, 0.12), y = reduced ? 0 : MathUtils.clamp(-dy * 0.0012, -0.12, 0.12);
  if (x === parallax.x && y === parallax.y) return;
  parallax.x = x;
  parallax.y = y;
  applyCamera();
}

// ---------------------------------------------------------------- picking and the board mirror
const raycaster = new Raycaster();
const ndc = new Vector2();
const pickPlane = new Plane(new Vector3(0, 1, 0), -0.055);
/** The cell under a window point (the pick planes at y = 0.055), or null. */
export function pickCell(x: number, y: number): number | null {
  if (!view || !config) return null;
  pointerToNdc(x, y, ndc);
  raycaster.setFromCamera(ndc, camera);
  const pt = new Vector3();
  if (!raycaster.ray.intersectPlane(pickPlane, pt)) return null;
  const n = config.boardSize, cell = FRAMING.boardWorld / n;
  const c = Math.floor((pt.x + FRAMING.boardWorld / 2) / cell), r = Math.floor((pt.z + FRAMING.boardWorld / 2) / cell);
  if (c < 0 || r < 0 || c >= n || r >= n) return null;
  // the pick planes are 0.98 of a cell
  const cc = cellCenter(r * n + c);
  if (Math.abs(pt.x - cc.x) > cell * 0.49 || Math.abs(pt.z - cc.z) > cell * 0.49) return null;
  return r * n + c;
}
const corner = new Vector3();
/** A cell's projected bounding box (window px), for its named target (render.js projectCellQuad). */
export function cellRect(index: number): { x: number; y: number; width: number; height: number } | null {
  if (!view || !config) return null;
  camera.updateMatrixWorld();
  const half = FRAMING.boardWorld / config.boardSize / 2;
  const { x, z } = cellCenter(index);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    corner.set(x + dx * half, 0.03, z + dz * half).project(camera);
    const sx = ((corner.x + 1) / 2) * win.w, sy = ((1 - corner.y) / 2) * win.h;
    x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
  }
  if (!Number.isFinite(x0)) return null;
  // inset a little so neighbouring foreshortened cells don't overlap
  const ix = (x1 - x0) * 0.06, iy = (y1 - y0) * 0.06;
  return { x: x0 + ix, y: y0 + iy, width: Math.max(1, x1 - x0 - 2 * ix), height: Math.max(1, y1 - y0 - 2 * iy) };
}
export function hasBoard(): boolean { return !!view; }

// ---------------------------------------------------------------- quality, motion
/** The runtime's quality tier applied live (render.js setGraphics): rebuild what the budget bakes in. */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  const prev = look;
  look = next;
  renderer.shadowMap.enabled = next.shadows > 0;
  keyLight.castShadow = next.shadows > 0;
  if (next.shadows > 0) keyLight.shadow.mapSize = next.shadows;
  // high threshold: only glowing marks, win lines and hot highlights bloom
  // r160 page: UnrealBloomPass strength 0.3 → 0.3² at minor 29 (r185 bloom).
  renderer.bloom = next.bloom ? { strength: 0.3 * 0.3, radius: 0.4, threshold: 0.92, resolution: next.budget.bloomRes } : null;
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.75, radius: 0.35, distanceExponent: 1.4, thickness: 0.6, scale: 1.0, samples: next.ao === "high" ? 16 : 8,
    resolution: next.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8 },
  };
  // GradeShader after OutputPass (display space): a 0.22 S-curve, saturation 1.1, cool shadows / warm
  // highlights by a smoothstep of luma 0.15–0.8, the 0.28 vignette from 0.3 to 0.85 (x stretched 1.1)
  // Its s * 0.98 + 0.012 lift has no display-space equivalent (levels are linear only): about +3 levels on darks are left out.
  renderer.grade = next.grade ? {
    space: "display", contrast: 0.11, saturation: 1.1, split: [0.15, 0.8], shadows: [0.95, 0.98, 1.05], highlights: [1.05, 1.0, 0.95],
    vignette: { amount: 0.28, inner: 0.3, outer: 0.85, scale: [1.1, 1] },
  } : null;
  renderer.antialias = next.antialias;
  if (prev && view) rebuildPreserving();
}
export function setReducedMotion(v: boolean): void { reduced = v; }

/** Each frame: camera transitions, animations, ring pulses, dust, motes; the camera fitted to the window. */
export function frame(dt: number, w: number, h: number): void {
  dt = Math.min(0.1, dt);
  if (w > 0 && h > 0 && (w !== win.w || h !== win.h)) {
    win = { w, h };
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    applyCamera();
  }
  clockS += dt;
  if (camAnim) {
    camAnim.t += dt * 1000;
    const k = Math.min(1, camAnim.t / camAnim.dur), e = easeInOutCubic(k), { from, to } = camAnim;
    camPose = {
      phi: from.phi + (to.phi - from.phi) * e, theta: from.theta + (to.theta - from.theta) * e,
      dist: from.dist + (to.dist - from.dist) * e, lookY: from.lookY + (to.lookY - from.lookY) * e,
    };
    applyCamera();
    if (k >= 1) camAnim = null;
  }
  for (let i = anims.length - 1; i >= 0; i--) {
    const a = anims[i]!;
    if (a.delay && a.delay > 0) { a.delay -= dt * 1000; continue; }
    a.t += dt * 1000;
    const k = Math.min(1, a.t / a.dur);
    a.update(k);
    if (k >= 1) { a.done?.(); anims.splice(i, 1); }
  }
  const v = view;
  if (!v) return;
  const now = clockS * 1000;
  if (v.selection.visible && !reduced) v.selection.scale.setScalar(1 + Math.sin(now * 0.006) * 0.06);
  if (!reduced) {
    const o = 0.55 + Math.sin(now * 0.005) * 0.3;
    for (const ring of v.highlights.children) ((ring as Mesh).material as MeshBasicMaterial).opacity = o;
  }
  const d = v.dust;
  let any = false;
  for (let i = 0; i < d.cap; i++) {
    if (d.life[i]! <= 0) continue;
    any = true;
    d.life[i] = d.life[i]! - dt;
    const i3 = i * 3;
    if (d.life[i]! <= 0) { d.pos[i3 + 1] = -10; continue; }
    d.vel[i3 + 1] = d.vel[i3 + 1]! - 1.6 * dt;
    d.pos[i3] = d.pos[i3]! + d.vel[i3]! * dt;
    d.pos[i3 + 1] = d.pos[i3 + 1]! + d.vel[i3 + 1]! * dt;
    d.pos[i3 + 2] = d.pos[i3 + 2]! + d.vel[i3 + 2]! * dt;
  }
  if (any) (d.geo.attributes.position as BufferAttribute).needsUpdate = true;
  const m = v.motes;
  if (m && !reduced) {
    const t = now * 0.001;
    for (let i = 0; i < m.count; i++) {
      const i3 = i * 3, k = m.seed[i]!;
      m.pos[i3] = m.pos[i3]! + (0.03 + Math.sin(t * 0.3 + k) * 0.02) * dt;
      m.pos[i3 + 1] = m.pos[i3 + 1]! + Math.sin(t * 0.7 + k * 1.7) * 0.025 * dt;
      m.pos[i3 + 2] = m.pos[i3 + 2]! + Math.cos(t * 0.23 + k) * 0.02 * dt;
      if (m.pos[i3]! > 2.6) m.pos[i3] = -2.6;
    }
    (m.pts.geometry.attributes.position as BufferAttribute).needsUpdate = true;
    (m.pts.material as PointsMaterial).opacity = 0.28 + Math.sin(t * 0.9) * 0.07;
  }
}
export function setActive(on: boolean): void { renderer.camera = on ? camera : null; }
