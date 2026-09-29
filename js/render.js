// Render layer: Three.js scene graph, semantic entity views, authored camera,
// PBR lighting, pooled VFX and quality tiers. Consumes immutable rules
// snapshots; never mutates rules state. All cosmetic randomness comes from a
// dedicated seeded stream, separate from rules.
import * as THREE from '../vendor/three.module.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RngStream } from './rng.js';
import { detectPreset, describe, resolve, SHADOW_MAP } from './gfx.js';

// Authored framing constants (no magic offsets elsewhere).
const FRAMING = {
  boardWorld: 3.0, // board play surface edge length in world units
  boardThickness: 0.16,
  frameMargin: 0.28,
  fov: 28,
  cameras: {
    standard: { phi: 0.62, theta: 0.0, dist: 6.4, lookY: 0.0 },
    top: { phi: 0.18, theta: 0.0, dist: 6.8, lookY: 0.0 },
    low: { phi: 0.95, theta: 0.0, dist: 6.0, lookY: 0.05 },
  },
  introSwoopMs: 900,
  camTransitionMs: 550,
};

// Particle budgets per `particles` tier: chalk-dust pool, burst size per
// mark, and drifting motes hanging in the lamp light.
const PARTICLES = {
  low: { pool: 300, dustPerMark: 10, motes: 0 },
  high: { pool: 2200, dustPerMark: 40, motes: 140 },
};

// Colour grade + vignette (display-space colours in, display-space out).
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.28 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      // Gentle S-curve contrast, a touch more saturation, warm highlights / cool shadows.
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.95, 0.98, 1.05), vec3(1.05, 1.0, 0.95), smoothstep(0.15, 0.8, l));
      s = s * 0.98 + 0.012;
      c = mix(c, s, uAmount);
      float d = length((vUv - 0.5) * vec2(1.1, 1.0));
      c *= 1.0 - uVignette * smoothstep(0.3, 0.85, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

function isMobileDevice() {
  try {
    return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || !!window.matchMedia?.('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

function prefersReducedMotion() {
  try {
    return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

const PALETTE_OVERRIDES = {
  default: {},
  deuteranopia: { markB: 0x4a9ff2 }, // warm white vs clear blue
  tritanopia: { markB: 0xe0654f }, // warm white vs vermilion
};

const LAYER_ENV = 0;
const LAYER_PICK = 1;

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Procedural slate/paper/etc surface texture (original, generated at boot).
function makeSurfaceTexture(theme, seed, boardCells) {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rng = new RngStream(seed ^ 0x5eed);
  const base = new THREE.Color(theme.board);
  const edge = new THREE.Color(theme.boardEdge);
  ctx.fillStyle = '#' + base.getHexString();
  ctx.fillRect(0, 0, size, size);
  // Mottled grain.
  for (let i = 0; i < 2600; i++) {
    const x = rng.next() * size;
    const y = rng.next() * size;
    const r = rng.range(0.5, 2.4);
    const light = rng.next() > 0.5;
    ctx.fillStyle = light
      ? `rgba(255,255,255,${rng.range(0.008, 0.03)})`
      : `rgba(0,0,0,${rng.range(0.01, 0.045)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Faint wipe streaks — erased-chalk history.
  for (let i = 0; i < 26; i++) {
    ctx.save();
    ctx.translate(rng.next() * size, rng.next() * size);
    ctx.rotate(rng.range(-0.4, 0.4));
    ctx.fillStyle = `rgba(255,255,255,${rng.range(0.008, 0.028)})`;
    ctx.fillRect(-rng.range(30, 120), -rng.range(4, 14), rng.range(60, 240), rng.range(8, 28));
    ctx.restore();
  }
  // Vignette toward the rim.
  const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.32, size / 2, size / 2, size * 0.72);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  // Etched grid.
  const n = boardCells;
  const cell = size / n;
  const gridCol = new THREE.Color(theme.grid);
  ctx.strokeStyle = '#' + gridCol.getHexString();
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = Math.max(2, size / 256);
  ctx.lineCap = 'round';
  for (let i = 1; i < n; i++) {
    const p = i * cell;
    ctx.beginPath();
    // Slight hand-drawn wobble, seeded.
    const wob = () => rng.range(-1.6, 1.6);
    ctx.moveTo(p + wob(), wob());
    ctx.lineTo(p + wob(), size + wob());
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(wob(), p + wob());
    ctx.lineTo(size + wob(), p + wob());
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Wood grain (frame and desk): long seeded streaks with knots, modulating the
// theme colour so every theme keeps its palette. Returns colour + roughness maps.
function makeWoodTextures(baseHex, seed, { planks = 0, size = 512, strength = 1 } = {}) {
  const rng = new RngStream(seed >>> 0);
  const col = document.createElement('canvas');
  col.width = col.height = size;
  const cx = col.getContext('2d');
  const base = new THREE.Color(baseHex);
  cx.fillStyle = '#' + base.getHexString();
  cx.fillRect(0, 0, size, size);
  const rough = document.createElement('canvas');
  rough.width = rough.height = size;
  const rx = rough.getContext('2d');
  rx.fillStyle = 'rgb(190,190,190)';
  rx.fillRect(0, 0, size, size);
  // Grain lines: gently wavy horizontal streaks, lighter and darker.
  for (let i = 0; i < 180; i++) {
    const y0 = rng.next() * size;
    const amp = rng.range(1, 6);
    const freq = (Math.PI * 2 * Math.round(rng.range(1, 4))) / size; // whole waves: tiles seamlessly
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
  // A few knots.
  for (let k = 0; k < 3; k++) {
    const x = rng.next() * size;
    const y = rng.next() * size;
    for (let r = 14; r > 2; r -= 3) {
      cx.strokeStyle = `rgba(0,0,0,${0.05 + (14 - r) * 0.01})`;
      cx.lineWidth = 1.2;
      cx.beginPath();
      cx.ellipse(x, y, r * 2.2, r * 0.8, 0, 0, Math.PI * 2);
      cx.stroke();
    }
  }
  // Plank seams for the desk.
  if (planks > 0) {
    const h = size / planks;
    for (let i = 0; i <= planks; i++) {
      const y = i * h;
      cx.fillStyle = 'rgba(0,0,0,0.35)';
      cx.fillRect(0, y - 1.5, size, 3);
      cx.fillStyle = `rgba(255,240,220,${Math.max(0, rng.range(-0.02, 0.03)) * strength})`;
      cx.fillRect(0, y + 1.5, size, h - 3);
      rx.fillStyle = 'rgb(255,255,255)';
      rx.fillRect(0, y - 1.5, size, 3);
    }
  }
  const map = new THREE.CanvasTexture(col);
  map.colorSpace = THREE.SRGBColorSpace;
  const roughnessMap = new THREE.CanvasTexture(rough);
  for (const t of [map, roughnessMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
  }
  return { map, roughnessMap };
}

// Fine grayscale grain used as a bump map (slate pores, chalk tooth).
function makeGrainTexture(seed, size = 256, dots = 5000) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rng = new RngStream(seed >>> 0);
  ctx.fillStyle = 'rgb(128,128,128)';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < dots; i++) {
    const v = rng.next() > 0.5 ? 255 : 0;
    ctx.fillStyle = `rgba(${v},${v},${v},${rng.range(0.08, 0.35)})`;
    ctx.fillRect(rng.next() * size, rng.next() * size, rng.range(0.8, 2.6), rng.range(0.8, 2.6));
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// Soft round sprite for dust/motes (points otherwise render as hard squares).
function makeSoftDotTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Themes whose marks read as light sources: extra emissive so bloom catches them.
const THEME_GLOW = { neon: 0.55, abyss: 0.2 };

function roundedRectShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
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

export class BoardRenderer {
  constructor(canvas, { settings } = {}) {
    this.canvas = canvas;
    this.settings = settings;
    this.theme = null;
    this.config = null;
    this.visualSeed = 1;
    this.savedGfx = settings?.graphics || {};
    this.q = null; // resolved graphics settings (gfx.js resolve())
    this.gpu = '';
    this.detected = 'balanced';
    this.adaptiveScale = 1;
    this._frames = [];
    this.fps = 0;
    this.pixelRatio = 1;
    this.composer = null;
    this.postKey = null;
    this.postFailed = false;
    this.reducedMotion = false;
    this.running = false;
    this.disposed = false;
    this.contextLost = false;
    this.onCellTap = null; // (cell) => void
    this.onCellHover = null; // (cell|null) => void
    this.cellMeshes = [];
    this.marks = new Map(); // cell -> {group, drawAnim}
    this.anims = [];
    this.hoverCell = null;
    this.hoverLegal = true;
    this.selectedCell = null;
    this.lessonHighlights = new Set();
    this.lastStateKey = '';
    this.clock = { last: 0 };
    this._pointer = { down: false, x: 0, y:0, moved: false };
    this._parallax = { x: 0, y: 0 };
    this._raycaster = new THREE.Raycaster();
    this._pointerNdc = new THREE.Vector2();
    this._camAnim = null;
    this._camPose = { phi: 0, theta: 0, dist: 6.4, lookY: 0 };
    this._buildRenderer();
    this._bindEvents();
    this.setGraphics(this.savedGfx);
  }

  // ---- renderer & scene construction (rebuilt on context restore) ----

  _buildRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // GPU detection for the Auto preset (unmasked renderer string when exposed).
    try {
      const gl = this.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      this.gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
    } catch {
      this.gpu = '';
    }
    this.detected = detectPreset(this.gpu, { mobile: isMobileDevice() });
    // Studio environment for image-based lighting (generated once per context).
    this.envMap = null;
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const room = new RoomEnvironment(this.renderer);
      this.envMap = pmrem.fromScene(room, 0.04).texture;
      room.traverse?.((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      pmrem.dispose();
    } catch {
      this.envMap = null;
    }
    this.composer = null;
    this.postKey = null;
    this.q = resolve(this.savedGfx, this.detected);
    this._applyShadowSettings();
    this._applySize();
  }

  // ---- graphics settings ----

  /** Apply saved graphics settings live (no reload). */
  setGraphics(saved) {
    const prev = this.q;
    this.savedGfx = saved || {};
    this.q = resolve(this.savedGfx, this.detected);
    const q = this.q;
    this.adaptiveScale = 1;
    this._frames = [];
    this.postKey = null; // rebuild the post chain on the next frame
    this.postFailed = false;
    this._fpsVisible(q.showFps);
    this.canvas.dataset.gfxPreset = q.preset;
    document.body.dataset.gfxPreset = q.preset;
    if (!this.renderer) return;
    this._applySize();
    if (!this.scene) return;
    // Scene content (textures, props, particle pools) depends on these.
    if (prev && (prev.detail !== q.detail || prev.particles !== q.particles)) {
      this._rebuildScenePreserving();
      return;
    }
    this._applyShadowSettings();
    this._applyEnvironment();
    // Materials pick up shadow-map / environment changes on recompile.
    this.scene.traverse((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) m.needsUpdate = true;
    });
  }

  /** What the settings panel shows: GPU, auto choice, resolved tiers, cost and frame rate. */
  graphicsInfo() {
    const w = this.canvas.clientWidth || 0;
    const h = this.canvas.clientHeight || 0;
    const px = [Math.round(w * this.pixelRatio), Math.round(h * this.pixelRatio)];
    return {
      gpu: this.gpu || 'unknown GPU',
      detected: this.detected,
      resolved: this.q,
      summary: describe(this.q, px),
      fps: Math.round(this.fps || 0),
      adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
      postFailed: !!this.postFailed,
    };
  }

  _applyShadowSettings() {
    const size = SHADOW_MAP[this.q?.shadows] || 0;
    this.renderer.shadowMap.enabled = size > 0;
    this.renderer.shadowMap.needsUpdate = true;
    if (!this.keyLight) return;
    this.keyLight.castShadow = size > 0;
    if (size > 0 && this.keyLight.shadow.mapSize.x !== size) {
      this.keyLight.shadow.mapSize.set(size, size);
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
    }
  }

  _applyEnvironment() {
    if (!this.scene) return;
    const on = this.q?.reflections === 'on' && !!this.envMap;
    this.scene.environment = on ? this.envMap : null;
    // The environment adds its own fill, so the hemisphere backs off.
    if (this.fillLight) this.fillLight.intensity = on ? 0.55 : 0.9;
  }

  _fpsVisible(on) {
    let meter = document.getElementById('fps-meter');
    if (on && !meter) {
      meter = document.createElement('div');
      meter.id = 'fps-meter';
      meter.setAttribute('aria-hidden', 'true');
      meter.textContent = '… fps';
      document.body.append(meter);
    }
    if (meter) meter.hidden = !on;
  }

  _disposePost() {
    if (!this.composer) return;
    for (const pass of this.composer.passes) pass.dispose?.();
    this.composer.dispose();
    this.composer = null;
  }

  _postKey(w, h) {
    const q = this.q;
    return q.post ? [q.ao, q.bloom, q.grade, q.antialias, w, h, this.pixelRatio].join('|') : 'none';
  }

  _buildPost(w, h) {
    const q = this.q;
    this._disposePost();
    this.composer = null;
    if (!q.post || this.postFailed) return;
    try {
      const pr = this.pixelRatio;
      const target = new THREE.WebGLRenderTarget(w * pr, h * pr, {
        type: THREE.HalfFloatType, samples: q.antialias === 'msaa' ? 4 : 0,
      });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (q.ao !== 'off') {
        const ao = new GTAOPass(this.scene, this.camera, w * pr, h * pr);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.75;
        const hi = q.ao === 'high';
        ao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.4, thickness: 0.6, scale: 1.0, samples: hi ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: hi ? 6 : 4, rings: 2, samples: hi ? 16 : 8 });
        composer.addPass(ao);
      }
      if (q.bloom === 'on') {
        // High threshold: only glowing marks, win lines and hot highlights bloom.
        composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.3, 0.4, 0.92));
      }
      composer.addPass(new OutputPass());
      if (q.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
      if (q.antialias === 'smaa') composer.addPass(new SMAAPass(w * pr, h * pr));
      if (q.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch {
      // Post-processing is an enhancement: render directly; the panel says so.
      this.postFailed = true;
      this.composer = null;
    }
  }

  // Adaptive resolution: step the render scale down when frames are slow, back up when fast.
  _adapt(dtMs) {
    const f = this._frames;
    f.push(dtMs);
    if (f.length < 90) return false;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    this.fps = 1000 / avg;
    const meter = document.getElementById('fps-meter');
    if (meter && !meter.hidden) meter.textContent = `${Math.round(this.fps)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
    if (!this.q.adaptive) return false;
    const before = this.adaptiveScale;
    if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
    return before !== this.adaptiveScale;
  }

  _renderFrame(dtMs) {
    if (this._adapt(dtMs)) this._applySize();
    const w = this.canvas.clientWidth || 300;
    const h = this.canvas.clientHeight || 300;
    const key = this._postKey(w, h);
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost(w, h);
    }
    if (this.composer) this.composer.render(dtMs / 1000);
    else this.renderer.render(this.scene, this.camera);
  }

  _buildScene() {
    const theme = this.theme;
    const q = this.q;
    const detailed = q.detail === 'detailed';
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(theme.bg);
    this.scene.fog = new THREE.Fog(theme.fog, 9, 16);

    this.camera = new THREE.PerspectiveCamera(FRAMING.fov, 1, 0.1, 60);
    const pose = FRAMING.cameras[this.settings?.camera?.angle || 'standard'] || FRAMING.cameras.standard;
    this._camPose = { ...pose };
    this._applyCamera();

    // Lighting: a warm desk-lamp key with PCF shadows, a cool rim from behind
    // that catches chalk edges and the frame bevel, and a hemisphere fill.
    this.keyLight = new THREE.DirectionalLight(theme.key, 2.6);
    this.keyLight.position.set(3.2, 5.2, 2.4);
    {
      // Shadow frustum fitted tightly to the slate (plus desk props when shown),
      // so even the Low shadow map keeps crisp contact shadows.
      const sh = this.keyLight.shadow;
      const ext = FRAMING.boardWorld / 2 + FRAMING.frameMargin + (detailed ? 0.95 : 0.3);
      Object.assign(sh.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 2.5, far: 11 });
      sh.camera.updateProjectionMatrix();
      sh.bias = -0.0005;
      sh.normalBias = 0.015;
      sh.radius = 4;
    }
    this.scene.add(this.keyLight);
    this.rimLight = new THREE.DirectionalLight(theme.fill, 0.7);
    this.rimLight.position.set(-2.5, 3.0, -4.5);
    this.scene.add(this.rimLight);
    this.fillLight = new THREE.HemisphereLight(theme.fill, theme.ground, 0.9);
    this.scene.add(this.fillLight);

    // Ground: a dark desk top (wood planks at detailed quality).
    const groundMat = new THREE.MeshStandardMaterial({ color: theme.ground, roughness: 1, metalness: 0, envMapIntensity: 0.25 });
    if (detailed) {
      const wood = makeWoodTextures(theme.ground, this.visualSeed ^ 0xde5c, { planks: 4, strength: 0.6 });
      for (const t of [wood.map, wood.roughnessMap]) t.repeat.set(18, 18);
      groundMat.map = wood.map;
      groundMat.roughnessMap = wood.roughnessMap;
      groundMat.color.set(0xffffff);
      groundMat.roughness = 0.95;
      groundMat.envMapIntensity = 0.12;
    }
    this.ground = new THREE.Mesh(new THREE.CircleGeometry(40, 64), groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -FRAMING.boardThickness - 0.02;
    this.ground.receiveShadow = true;
    this.ground.layers.set(LAYER_ENV);
    this.scene.add(this.ground);

    this._chalkGrain = null;
    if (detailed) {
      this._chalkGrain = makeGrainTexture(this.visualSeed ^ 0xc4a1, 128, 2200);
      this._chalkGrain.repeat.set(6, 1);
      this._chalkGrain.userData.shared = true;
    }

    this.boardGroup = new THREE.Group();
    this.scene.add(this.boardGroup);
    this._buildBoardMeshes();
    if (detailed) this._buildProps();
    this._buildGhostAndSelection();
    this._buildParticles();
    this._buildMotes();
    this._applyShadowSettings();
    this._applyEnvironment();
    // The fresh camera starts with aspect 1; re-apply the real canvas size so
    // framing and cell projection are correct immediately after every rebuild.
    this._applySize();
  }

  _buildBoardMeshes() {
    const theme = this.theme;
    const n = this.config.boardSize;
    const W = FRAMING.boardWorld;
    const surfaceTex = makeSurfaceTexture(theme, this.visualSeed, n);

    // Frame: larger rounded slab beneath the play surface.
    const frameShape = roundedRectShape(W + FRAMING.frameMargin * 2, W + FRAMING.frameMargin * 2, 0.14);
    const frameGeo = new THREE.ExtrudeGeometry(frameShape, { depth: FRAMING.boardThickness, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2 });
    frameGeo.rotateX(-Math.PI / 2);
    const detailed = this.q.detail === 'detailed';
    // Lacquered wooden frame: grain maps plus a thin clearcoat at detailed quality.
    const frameMat = new THREE.MeshPhysicalMaterial({
      color: theme.frame, roughness: 0.7, metalness: 0.0, envMapIntensity: 0.3,
      clearcoat: detailed ? 0.3 : 0, clearcoatRoughness: 0.5,
    });
    if (detailed) {
      const wood = makeWoodTextures(theme.frame, this.visualSeed ^ 0xf4a3);
      // ExtrudeGeometry UVs are in world units; tile the grain along the rails.
      for (const t of [wood.map, wood.roughnessMap]) t.repeat.set(0.35, 0.35);
      frameMat.map = wood.map;
      frameMat.roughnessMap = wood.roughnessMap;
      frameMat.color.set(0xffffff);
      frameMat.roughness = 0.9;
    }
    this.frameMesh = new THREE.Mesh(frameGeo, frameMat);
    this.frameMesh.position.y = -FRAMING.boardThickness;
    this.frameMesh.castShadow = true;
    this.frameMesh.receiveShadow = true;
    this.frameMesh.layers.set(LAYER_ENV);
    this.boardGroup.add(this.frameMesh);

    // Play surface.
    const boardShape = roundedRectShape(W, W, 0.08);
    const boardGeo = new THREE.ExtrudeGeometry(boardShape, { depth: 0.045, bevelEnabled: false });
    boardGeo.rotateX(-Math.PI / 2);
    // Normalize UVs to 0..1 across the board face so the procedural grid
    // aligns exactly with logical cells.
    boardGeo.computeBoundingBox();
    {
      const bb = boardGeo.boundingBox;
      const pos = boardGeo.attributes.position;
      const uv = boardGeo.attributes.uv;
      const sx = bb.max.x - bb.min.x;
      const sz = bb.max.z - bb.min.z;
      for (let i = 0; i < pos.count; i++) {
        uv.setXY(i, (pos.getX(i) - bb.min.x) / sx, 1 - (pos.getZ(i) - bb.min.z) / sz);
      }
      uv.needsUpdate = true;
    }
    const boardMat = new THREE.MeshStandardMaterial({ map: surfaceTex, roughness: 0.92, metalness: 0.0, envMapIntensity: 0.35 });
    if (detailed) {
      // Slate pores: a fine bump map gives the surface a satin, stony sheen.
      const grain = makeGrainTexture(this.visualSeed ^ 0x51a7, 256, 6000);
      grain.repeat.set(3, 3);
      boardMat.bumpMap = grain;
      boardMat.bumpScale = 0.6;
    }
    this.boardMesh = new THREE.Mesh(boardGeo, boardMat);
    this.boardMesh.castShadow = true;
    this.boardMesh.receiveShadow = true;
    this.boardMesh.layers.set(LAYER_ENV);
    this.boardGroup.add(this.boardMesh);

    // Disabled cells: bright sealed plugs with a cross groove — hazards stay
    // legible even with effects disabled.
    this.disabledMeshes = [];
    const cell = W / n;
    for (const c of this.config.disabledCells) {
      const { x, z } = this.cellCenter(c);
      const plug = new THREE.Mesh(
        new THREE.CylinderGeometry(cell * 0.32, cell * 0.32, 0.03, 24),
        new THREE.MeshStandardMaterial({ color: this.theme.grid, roughness: 1, emissive: this.theme.grid, emissiveIntensity: 0.06 })
      );
      plug.position.set(x, 0.062, z);
      plug.layers.set(LAYER_ENV);
      this.boardGroup.add(plug);
      const groove = new THREE.Mesh(
        new THREE.BoxGeometry(cell * 0.34, 0.012, cell * 0.07),
        new THREE.MeshStandardMaterial({ color: this.theme.boardEdge, roughness: 1 })
      );
      groove.position.set(x, 0.082, z);
      groove.rotation.y = Math.PI / 4;
      groove.layers.set(LAYER_ENV);
      this.boardGroup.add(groove);
      this.disabledMeshes.push(plug, groove);
    }

    // Invisible pick planes (explicit interaction layer; raycasts hit only these).
    this.cellMeshes = [];
    const pickMat = new THREE.MeshBasicMaterial({ visible: false });
    for (let i = 0; i < n * n; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(cell * 0.98, cell * 0.98), pickMat);
      m.rotation.x = -Math.PI / 2;
      const { x, z } = this.cellCenter(i);
      m.position.set(x, 0.055, z);
      m.userData.cell = i;
      m.layers.set(LAYER_PICK);
      this.boardGroup.add(m);
      this.cellMeshes.push(m);
    }

    // Lesson highlight rings.
    this.highlightGroup = new THREE.Group();
    this.boardGroup.add(this.highlightGroup);
    this._refreshLessonHighlights();
  }

  _buildProps() {
    // Restrained environmental storytelling: chalk sticks and an eraser.
    const theme = this.theme;
    const rng = new RngStream(this.visualSeed ^ 0xca1c);
    this.propsGroup = new THREE.Group();
    const chalkMat = new THREE.MeshStandardMaterial({ color: theme.markA, roughness: 1, bumpMap: this._chalkGrain, bumpScale: 1.5, envMapIntensity: 0.3 });
    const chalkMat2 = new THREE.MeshStandardMaterial({ color: theme.markB, roughness: 1, bumpMap: this._chalkGrain, bumpScale: 1.5, envMapIntensity: 0.3 });
    const stickGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.42, 12);
    const groundY = -FRAMING.boardThickness - 0.02;
    const s1 = new THREE.Mesh(stickGeo, chalkMat);
    s1.rotation.set(Math.PI / 2, 0, rng.range(-0.4, 0.4));
    s1.position.set(2.15, groundY + 0.035, 0.9);
    const s2 = new THREE.Mesh(stickGeo, chalkMat2);
    s2.rotation.set(Math.PI / 2, 0, rng.range(-0.4, 0.4));
    s2.position.set(2.05, groundY + 0.035, 1.25);
    const eraser = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.14, 0.22),
      new THREE.MeshStandardMaterial({ color: theme.frame, roughness: 0.75, envMapIntensity: 0.5 })
    );
    eraser.position.set(-2.2, groundY + 0.07, -1.1);
    eraser.rotation.y = rng.range(-0.5, 0.5);
    for (const p of [s1, s2, eraser]) {
      p.castShadow = true;
      p.layers.set(LAYER_ENV);
      this.propsGroup.add(p);
    }
    this.scene.add(this.propsGroup);
  }

  _markColors() {
    const overrides = PALETTE_OVERRIDES[this.settings?.accessibility?.palette || 'default'] || {};
    return {
      a: overrides.markA ?? this.theme.markA,
      b: overrides.markB ?? this.theme.markB,
    };
  }

  _chalkMaterial(color, opacity = 1, glow = 0) {
    return new THREE.MeshStandardMaterial({
      color,
      roughness: 1,
      metalness: 0,
      emissive: color,
      // Readable after tone mapping without bloom; glowing themes and the
      // winning line push past the bloom threshold when bloom is on.
      emissiveIntensity: 0.08 + (THEME_GLOW[this.theme.id] || 0) + glow,
      bumpMap: this._chalkGrain || null, // chalk tooth (detailed quality)
      bumpScale: 1.2,
      envMapIntensity: 0.25,
      transparent: opacity < 1,
      opacity,
    });
  }

  // X or O chalk stroke group with rough, seeded geometry.
  _makeMarkMesh(player, cellIndex, opacity = 1) {
    const colors = this._markColors();
    const color = player === 1 ? colors.a : colors.b;
    const rng = new RngStream((this.visualSeed ^ (cellIndex * 2654435761)) >>> 0);
    const group = new THREE.Group();
    const cell = FRAMING.boardWorld / this.config.boardSize;
    const R = cell * 0.30;
    const mat = this._chalkMaterial(color, opacity);

    const stroke = (points) => {
      const curve = new THREE.CatmullRomCurve3(points);
      const geo = new THREE.TubeGeometry(curve, 24, cell * 0.045, 7, false);
      // Chalk roughness: jitter vertices along normals-ish directions.
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        pos.setXYZ(
          i,
          pos.getX(i) + rng.range(-0.006, 0.006),
          pos.getY(i) + rng.range(-0.004, 0.004),
          pos.getZ(i) + rng.range(-0.006, 0.006)
        );
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      return { mesh, total: geo.index.count };
    };

    const wob = () => rng.range(-0.03, 0.03);
    const y = 0.055;
    if (player === 1) {
      // Two strokes of an X.
      group.userData.strokes = [
        stroke([new THREE.Vector3(-R + wob(), y, -R + wob()), new THREE.Vector3(wob(), y + 0.005, wob()), new THREE.Vector3(R + wob(), y, R + wob())]),
        stroke([new THREE.Vector3(R + wob(), y, -R + wob()), new THREE.Vector3(wob(), y + 0.005, wob()), new THREE.Vector3(-R + wob(), y, R + wob())]),
      ];
    } else {
      // Ring, slightly open and imperfect like a hand-drawn O.
      const pts = [];
      const turns = 18;
      for (let i = 0; i <= turns; i++) {
        const a = (i / turns) * Math.PI * 2 + rng.range(-0.05, 0.05);
        const rr = R * (1 + rng.range(-0.06, 0.06));
        pts.push(new THREE.Vector3(Math.cos(a) * rr, y, Math.sin(a) * rr));
      }
      group.userData.strokes = [stroke(pts)];
    }
    for (const s of group.userData.strokes) group.add(s.mesh);
    return group;
  }

  _buildGhostAndSelection() {
    // Ghost preview (rebuilt per hover; cheap).
    this.ghostGroup = null;
    // Grounded selection marker: flat ring that pulses.
    const cell = FRAMING.boardWorld / (this.config?.boardSize || 3);
    const geo = new THREE.TorusGeometry(cell * 0.4, 0.014, 8, 40);
    geo.rotateX(Math.PI / 2);
    this.selectionMarker = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: this.theme.accent, transparent: true, opacity: 0.9 })
    );
    this.selectionMarker.position.y = 0.052;
    this.selectionMarker.visible = false;
    this.boardGroup.add(this.selectionMarker);
  }

  _buildParticles() {
    // Pooled chalk dust: fixed buffers, zero per-frame allocation.
    const cap = PARTICLES[this.q.particles].pool;
    this.dust = {
      cap,
      alive: 0,
      pos: new Float32Array(cap * 3),
      vel: new Float32Array(cap * 3),
      life: new Float32Array(cap),
      maxLife: new Float32Array(cap),
    };
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.dust.pos, 3));
    this.dustGeo = geo;
    this.dustPoints = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: this.theme.markA, size: 0.04, transparent: true, opacity: 0.75,
        depthWrite: false, sizeAttenuation: true, map: this._dotTexture(),
      })
    );
    this.dustPoints.frustumCulled = false;
    // Cosmetic effects never intercept raycasts.
    this.dustPoints.raycast = () => {};
    this.scene.add(this.dustPoints);
    this.dustRng = new RngStream((this.visualSeed ^ 0xd057) >>> 0);
  }

  _dotTexture() {
    if (!this._softDot) {
      this._softDot = makeSoftDotTexture();
      this._softDot.userData.shared = true;
    }
    return this._softDot;
  }

  // Drifting chalk motes hanging in the lamp light (High particles only).
  // Purely ambient: frozen under reduced motion, never pickable.
  _buildMotes() {
    this.motes = null;
    const count = PARTICLES[this.q.particles].motes;
    if (!count) return;
    const rng = new RngStream((this.visualSeed ^ 0x3073) >>> 0);
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = rng.range(-2.6, 2.6);
      pos[i * 3 + 1] = rng.range(0.15, 2.4);
      pos[i * 3 + 2] = rng.range(-2.2, 2.2);
      seed[i] = rng.next() * 100;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({
      color: this.theme.key, size: 0.022, transparent: true, opacity: 0.35,
      depthWrite: false, sizeAttenuation: true, map: this._dotTexture(),
      blending: THREE.AdditiveBlending,
    }));
    pts.frustumCulled = false;
    pts.raycast = () => {};
    this.scene.add(pts);
    this.motes = { pts, pos, seed, count };
  }

  // ---- public API ----

  setTheme(theme) {
    this.theme = theme;
    if (this.scene) this._rebuildScenePreserving();
  }

  setReducedMotion(flag) {
    this.reducedMotion = !!flag;
  }

  // Build for a rules config; clears marks.
  buildBoard(config, visualSeed) {
    // Dispose the previous scene's GPU resources first — otherwise every
    // match start / theme switch leaks the old geometries and textures.
    if (this.scene) this._disposeScene();
    this.config = config;
    this.visualSeed = visualSeed >>> 0;
    this.marks.clear();
    this.lastStateKey = '';
    this.hoverCell = null;
    this.selectedCell = null;
    this._winLineCells = null;
    this._buildScene();
    this._introSwoop();
  }

  _rebuildScenePreserving() {
    const marksToRestore = [...this.marks.keys()].map((cell) => ({ cell, player: this.marks.get(cell).player }));
    const hover = this.hoverCell;
    const sel = this.selectedCell;
    this._disposeScene();
    this._buildScene();
    for (const m of marksToRestore) this._placeMarkVisual(m.cell, m.player, true);
    if (hover != null) this.setHover(hover, this.hoverLegal);
    if (sel != null) this.setSelection(sel);
    this._refreshLessonHighlights();
    if (this._winLineCells) this.showWinLine(this._winLineCells, this._winLinePlayer, true);
  }

  // Sync visuals to an immutable rules snapshot.
  syncState(state, opts = {}) {
    if (!this.scene) return;
    const key = state.board.join('') + '|' + state.status + '|' + (state.winLine || []).join(',');
    if (key === this.lastStateKey) return;
    this.lastStateKey = key;
    this.lastBoard = state.board.slice();

    // Reconcile marks exactly with the snapshot: remove visuals for cells
    // that are now empty (undo, lesson resets, round restarts).
    for (const cell of [...this.marks.keys()]) {
      if (state.board[cell] === 0) {
        const entry = this.marks.get(cell);
        this.boardGroup.remove(entry.group);
        this._disposeObject(entry.group);
        this.marks.delete(cell);
      }
    }
    for (let i = 0; i < state.board.length; i++) {
      const v = state.board[i];
      if (v !== 0 && !this.marks.has(i)) {
        this._placeMarkVisual(i, v, opts.instant || this.reducedMotion);
      }
    }
    if (state.status === 'terminal') {
      this._clearGhost();
      if (state.winLine) this.showWinLine(state.winLine, state.winner, opts.instant || this.reducedMotion);
      if (state.winner === 0) this._pulseBoard();
    } else {
      this._clearWinLine();
    }
  }

  // Settle every visual into the exact deterministic end state (skip/ff).
  skipAnimations() {
    this.anims.length = 0;
    this._camAnim = null;
    this._applyCamera();
    for (const { group } of this.marks.values()) {
      for (const s of group.userData.strokes) {
        s.mesh.geometry.setDrawRange(0, Infinity);
        s.mesh.scale.setScalar(1);
      }
    }
    if (this.winLineMesh) {
      this.winLineMesh.geometry.setDrawRange(0, Infinity);
    }
    for (let i = 0; i < this.dust.cap; i++) this.dust.life[i] = 0;
    this.dust.alive = 0;
  }

  clearMarks() {
    for (const { group } of this.marks.values()) {
      this.boardGroup.remove(group);
      this._disposeObject(group);
    }
    this.marks.clear();
    this._clearWinLine();
    this._clearGhost();
  }

  setHover(cell, legal = true) {
    this.hoverCell = cell;
    this.hoverLegal = legal;
    this._clearGhost();
    if (cell == null || !this.scene) return;
    const player = this._displayPlayer || 1;
    this.ghostGroup = this._makeMarkMesh(player, cell, legal ? 0.4 : 0.5);
    if (!legal) {
      const danger = this._chalkMaterial(this.theme.danger, 0.5);
      for (const s of this.ghostGroup.userData.strokes) s.mesh.material = danger;
    }
    const { x, z } = this.cellCenter(cell);
    this.ghostGroup.position.set(x, 0, z);
    this.boardGroup.add(this.ghostGroup);
  }

  setDisplayPlayer(player) {
    this._displayPlayer = player;
  }

  setSelection(cell) {
    this.selectedCell = cell;
    if (cell == null) {
      this.selectionMarker.visible = false;
      return;
    }
    const { x, z } = this.cellCenter(cell);
    this.selectionMarker.position.set(x, 0.052, z);
    this.selectionMarker.visible = true;
  }

  setLessonHighlights(cells) {
    this.lessonHighlights = new Set(cells || []);
    this._refreshLessonHighlights();
  }

  _refreshLessonHighlights() {
    if (!this.highlightGroup) return;
    while (this.highlightGroup.children.length) {
      const c = this.highlightGroup.children.pop();
      this.highlightGroup.remove(c);
      this._disposeObject(c);
    }
    if (!this.lessonHighlights.size) return;
    const cell = FRAMING.boardWorld / this.config.boardSize;
    for (const c of this.lessonHighlights) {
      const geo = new THREE.TorusGeometry(cell * 0.38, 0.02, 8, 36);
      geo.rotateX(Math.PI / 2);
      const ring = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: this.theme.accent, transparent: true, opacity: 0.85 }));
      const { x, z } = this.cellCenter(c);
      ring.position.set(x, 0.052, z);
      ring.userData.pulse = true;
      this.highlightGroup.add(ring);
    }
  }

  showWinLine(cells, player, instant = false) {
    this._clearWinLine();
    this._winLineCells = cells.slice();
    this._winLinePlayer = player;
    const first = this.cellCenter(cells[0]);
    const last = this.cellCenter(cells[cells.length - 1]);
    const colors = this._markColors();
    const color = player === 1 ? colors.a : player === 2 ? colors.b : this.theme.accent;
    const dir = new THREE.Vector3(last.x - first.x, 0, last.z - first.z);
    const len = dir.length() + FRAMING.boardWorld / this.config.boardSize * 0.7;
    dir.normalize();
    const mid = new THREE.Vector3((first.x + last.x) / 2, 0.05, (first.z + last.z) / 2);
    const pts = [];
    const rng = new RngStream(this.visualSeed ^ 0x1abe);
    const segs = 16;
    for (let i = 0; i <= segs; i++) {
      const t = (i / segs - 0.5) * len;
      pts.push(new THREE.Vector3(
        mid.x + dir.x * t + rng.range(-0.012, 0.012),
        0.05,
        mid.z + dir.z * t + rng.range(-0.012, 0.012)
      ));
    }
    const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 32, 0.028, 6, false);
    this.winLineMesh = new THREE.Mesh(geo, this._chalkMaterial(color, 1, 0.9));
    this.boardGroup.add(this.winLineMesh);
    if (instant) {
      geo.setDrawRange(0, Infinity);
    } else {
      geo.setDrawRange(0, 0);
      const total = geo.index.count;
      this.anims.push({
        dur: 500, t: 0,
        update: (k) => geo.setDrawRange(0, Math.floor(total * easeOutCubic(k))),
      });
      if (!this.reducedMotion) this._cameraPulse();
    }
  }

  _clearWinLine() {
    if (this.winLineMesh) {
      this.boardGroup.remove(this.winLineMesh);
      this._disposeObject(this.winLineMesh);
      this.winLineMesh = null;
    }
    this._winLineCells = null;
  }

  _clearGhost() {
    if (this.ghostGroup) {
      this.boardGroup.remove(this.ghostGroup);
      this._disposeObject(this.ghostGroup);
      this.ghostGroup = null;
    }
  }

  _placeMarkVisual(cell, player, instant = false) {
    const group = this._makeMarkMesh(player, cell);
    const { x, z } = this.cellCenter(cell);
    group.position.set(x, 0, z);
    this.boardGroup.add(group);
    const entry = { group, player };
    this.marks.set(cell, entry);
    this._spawnDust(x, z, player);
    if (instant) {
      for (const s of group.userData.strokes) s.mesh.geometry.setDrawRange(0, Infinity);
      return;
    }
    // Draw-on animation: stroke index reveal, authored duration.
    for (const [si, s] of group.userData.strokes.entries()) {
      s.mesh.geometry.setDrawRange(0, 0);
      const total = s.total;
      this.anims.push({
        dur: 260, delay: si * 140, t: 0,
        update: (k) => s.mesh.geometry.setDrawRange(0, Math.floor(total * easeOutCubic(k))),
      });
    }
  }

  _spawnDust(x, z, player) {
    const d = this.dust;
    if (!d) return;
    const count = PARTICLES[this.q.particles].dustPerMark;
    const colors = this._markColors();
    this.dustPoints.material.color.set(player === 1 ? colors.a : colors.b);
    for (let n = 0; n < count; n++) {
      // Reuse the oldest slot.
      let slot = -1;
      for (let i = 0; i < d.cap; i++) {
        if (d.life[i] <= 0) { slot = i; break; }
      }
      if (slot < 0) break;
      const i3 = slot * 3;
      d.pos[i3] = x + this.dustRng.range(-0.12, 0.12);
      d.pos[i3 + 1] = 0.06;
      d.pos[i3 + 2] = z + this.dustRng.range(-0.12, 0.12);
      d.vel[i3] = this.dustRng.range(-0.25, 0.25);
      d.vel[i3 + 1] = this.dustRng.range(0.25, 0.8);
      d.vel[i3 + 2] = this.dustRng.range(-0.25, 0.25);
      d.life[slot] = d.maxLife[slot] = this.dustRng.range(0.4, 0.9);
    }
  }

  _pulseBoard() {
    if (this.reducedMotion) return;
    const start = this.boardGroup.scale.x;
    this.anims.push({
      dur: 420, t: 0,
      update: (k) => {
        const s = 1 + Math.sin(k * Math.PI) * 0.012;
        this.boardGroup.scale.setScalar(s);
      },
      done: () => this.boardGroup.scale.setScalar(start),
    });
  }

  _cameraPulse() {
    if (this.reducedMotion) return;
    const base = { ...this._camPose };
    this._camAnim = null;
    this.anims.push({
      dur: 500, t: 0,
      update: (k) => {
        const amp = Math.sin(k * Math.PI) * 0.05;
        this._camPose.dist = base.dist - amp;
        this._applyCamera();
      },
      done: () => {
        this._camPose = base;
        this._applyCamera();
      },
    });
  }

  cellCenter(index) {
    const n = this.config.boardSize;
    const cell = FRAMING.boardWorld / n;
    const r = Math.floor(index / n);
    const c = index % n;
    return {
      x: -FRAMING.boardWorld / 2 + cell * (c + 0.5),
      z: -FRAMING.boardWorld / 2 + cell * (r + 0.5),
    };
  }

  // Screen-space rect of a cell in CSS pixels — the shared layout model that
  // lets the DOM overlay align exactly with projected 3D targets.
  projectCell(index, rect) {
    // Matrices are only refreshed during render; make projections valid even
    // when called between rebuilds/animations (the DOM overlay depends on it).
    this.camera.updateMatrixWorld();
    this.boardGroup.updateMatrixWorld();
    const { x, z } = this.cellCenter(index);
    const v = new THREE.Vector3(x, 0.03, z).applyMatrix4(this.boardGroup.matrixWorld);
    v.project(this.camera);
    rect = rect || this.canvas.getBoundingClientRect();
    const n = this.config.boardSize;
    const cellFrac = 1 / n;
    // Project a second point at cell edge to estimate on-screen cell size.
    const e = new THREE.Vector3(x + FRAMING.boardWorld / n / 2, 0.03, z).applyMatrix4(this.boardGroup.matrixWorld);
    e.project(this.camera);
    const sx = (v.x * 0.5 + 0.5) * rect.width + rect.left;
    const sy = (-v.y * 0.5 + 0.5) * rect.height + rect.top;
    const ex = (e.x * 0.5 + 0.5) * rect.width + rect.left;
    const halfW = Math.abs(ex - sx);
    const halfH = halfW * (rect.width / rect.height) * (1 / 1); // approx square cells
    return { x: sx, y: sy, halfSize: Math.max(halfW, halfH), quad: this.projectCellQuad(index, rect) };
  }

  // The four projected corners of a cell (CSS px, clockwise). Perspective
  // foreshortens the far rows, so square hit areas around the centres overlap
  // each other; the DOM overlay clips each button to this exact polygon.
  projectCellQuad(index, rect) {
    this.camera.updateMatrixWorld();
    this.boardGroup.updateMatrixWorld();
    rect = rect || this.canvas.getBoundingClientRect();
    const n = this.config.boardSize;
    const half = FRAMING.boardWorld / n / 2;
    const { x, z } = this.cellCenter(index);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    return corners.map(([dx, dz]) => {
      const v = new THREE.Vector3(x + dx * half, 0.03, z + dz * half).applyMatrix4(this.boardGroup.matrixWorld);
      v.project(this.camera);
      return { x: (v.x * 0.5 + 0.5) * rect.width + rect.left, y: (-v.y * 0.5 + 0.5) * rect.height + rect.top };
    });
  }

  setCameraAngle(angle) {
    const pose = FRAMING.cameras[angle] || FRAMING.cameras.standard;
    const from = { ...this._camPose };
    if (this.reducedMotion) {
      this._camPose = { ...pose };
      this._applyCamera();
      return;
    }
    this._camAnim = { from, to: { ...pose }, t: 0, dur: FRAMING.camTransitionMs };
  }

  _introSwoop() {
    const pose = FRAMING.cameras[this.settings?.camera?.angle || 'standard'] || FRAMING.cameras.standard;
    if (this.reducedMotion) {
      this._camPose = { ...pose };
      this._applyCamera();
      return;
    }
    this._camPose = { ...pose, dist: pose.dist * 1.5, phi: pose.phi * 0.5 };
    this._applyCamera();
    this._camAnim = { from: { ...this._camPose }, to: { ...pose }, t: 0, dur: FRAMING.introSwoopMs };
  }

  _applyCamera() {
    const { phi, theta, lookY } = this._camPose;
    const dist = this._fitDistance(this._camPose.dist);
    const px = Math.sin(phi) * Math.sin(theta) * dist + this._parallax.x;
    const py = Math.cos(phi) * dist;
    const pz = Math.sin(phi) * Math.cos(theta) * dist + this._parallax.y;
    this.camera.position.set(px, py, pz);
    this.camera.lookAt(0, lookY, 0);
    // Fog must track the fitted distance: on tall/portrait aspects the camera
    // backs off far enough that a fixed fog range would swallow the board.
    if (this.scene?.fog) {
      this.scene.fog.near = dist + 2.5;
      this.scene.fog.far = dist + 10;
    }
  }

  // Frame the board (plus frame and breathing room) for the current aspect,
  // preserving the authored per-angle distance ratio.
  _fitDistance(poseDist) {
    const extent = FRAMING.boardWorld / 2 + FRAMING.frameMargin + 0.35;
    const halfFov = THREE.MathUtils.degToRad(FRAMING.fov / 2);
    const aspect = this.camera.aspect || 1;
    const phi = this._camPose.phi;
    // Vertical: the board's depth projects shortened by cos(phi).
    const needV = (extent * Math.max(0.55, Math.cos(phi)) + 0.35) * 1.12;
    const distV = needV / Math.tan(halfFov);
    // Horizontal: full width must fit.
    const needH = extent * 1.12;
    const distH = needH / (Math.tan(halfFov) * aspect);
    const fit = Math.max(distV, distH);
    return Math.max(fit, fit * (poseDist / 6.4));
  }

  // ---- pointer & raycast ----

  _bindEvents() {
    this.canvas.addEventListener('pointerdown', (e) => {
      this._pointer.down = true;
      this._pointer.x = e.clientX;
      this._pointer.y = e.clientY;
      this._pointer.moved = false;
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* no capture */ }
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this._pointer.down) {
        const dx = e.clientX - this._pointer.x;
        const dy = e.clientY - this._pointer.y;
        // Tap vs camera gesture by distance threshold.
        if (Math.hypot(dx, dy) > 10) this._pointer.moved = true;
        if (this._pointer.moved && !this.reducedMotion) {
          this._parallax.x = THREE.MathUtils.clamp(-dx * 0.0012, -0.12, 0.12);
          this._parallax.y = THREE.MathUtils.clamp(-dy * 0.0012, -0.12, 0.12);
          this._applyCamera();
        }
      }
      const cell = this._pick(e);
      if (cell !== this.hoverCell) {
        this.hoverCell = cell;
        if (this.onCellHover) this.onCellHover(cell);
      }
    });
    this.canvas.addEventListener('pointerup', (e) => {
      const wasTap = this._pointer.down && !this._pointer.moved;
      this._pointer.down = false;
      this._parallax.x = 0;
      this._parallax.y = 0;
      this._applyCamera();
      try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* released */ }
      if (wasTap) {
        const cell = this._pick(e);
        if (cell != null && this.onCellTap) this.onCellTap(cell);
      }
    });
    this.canvas.addEventListener('pointercancel', () => {
      // Safe cancel on lost capture.
      this._pointer.down = false;
      this._parallax.x = 0;
      this._parallax.y = 0;
      this._applyCamera();
    });
    this.canvas.addEventListener('pointerleave', () => {
      if (!this._pointer.down && this.onCellHover) this.onCellHover(null);
    });
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.stop();
      if (this.onContextLost) this.onContextLost();
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this._rebuildFromDescriptors();
      if (this.onContextRestored) this.onContextRestored();
    });
  }

  _pick(event) {
    if (!this.camera || this.contextLost) return null;
    const rect = this.canvas.getBoundingClientRect();
    this._pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this._raycaster.setFromCamera(this._pointerNdc, this.camera);
    this._raycaster.layers.set(LAYER_PICK);
    const hits = this._raycaster.intersectObjects(this.cellMeshes, false);
    return hits.length ? hits[0].object.userData.cell : null;
  }

  // Rebuild GPU resources from retained CPU descriptors after context loss.
  _rebuildFromDescriptors() {
    this._buildRenderer();
    this._rebuildScenePreserving();
    if (this.running) this.start();
  }

  // ---- loop ----

  start() {
    if (this.running || this.contextLost) return;
    this.running = true;
    this.clock.last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      this._frameId = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - this.clock.last) / 1000);
      this.clock.last = now;
      this._update(dt, now);
      this._renderFrame(dt * 1000);
      if (this.onFrame) this.onFrame();
    };
    this._frameId = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this._frameId) cancelAnimationFrame(this._frameId);
    this._frameId = null;
  }

  _update(dt, now) {
    // Camera transitions: authored durations, interruptible.
    if (this._camAnim) {
      this._camAnim.t += dt * 1000;
      const k = Math.min(1, this._camAnim.t / this._camAnim.dur);
      const e = easeInOutCubic(k);
      const { from, to } = this._camAnim;
      this._camPose = {
        phi: from.phi + (to.phi - from.phi) * e,
        theta: from.theta + (to.theta - from.theta) * e,
        dist: from.dist + (to.dist - from.dist) * e,
        lookY: from.lookY + (to.lookY - from.lookY) * e,
      };
      this._applyCamera();
      if (k >= 1) this._camAnim = null;
    }
    // Generic animations.
    for (let i = this.anims.length - 1; i >= 0; i--) {
      const a = this.anims[i];
      if (a.delay && a.delay > 0) {
        a.delay -= dt * 1000;
        continue;
      }
      a.t += dt * 1000;
      const k = Math.min(1, a.t / a.dur);
      a.update(k);
      if (k >= 1) {
        if (a.done) a.done();
        this.anims.splice(i, 1);
      }
    }
    // Selection marker pulse + lesson ring pulse (timing only; no allocations).
    if (this.selectionMarker?.visible && !this.reducedMotion) {
      const s = 1 + Math.sin(now * 0.006) * 0.06;
      this.selectionMarker.scale.setScalar(s);
    }
    if (this.highlightGroup && !this.reducedMotion) {
      const o = 0.55 + Math.sin(now * 0.005) * 0.3;
      for (const ring of this.highlightGroup.children) ring.material.opacity = o;
    }
    // Dust particles.
    const d = this.dust;
    if (d) {
      let any = false;
      for (let i = 0; i < d.cap; i++) {
        if (d.life[i] <= 0) continue;
        any = true;
        d.life[i] -= dt;
        const i3 = i * 3;
        if (d.life[i] <= 0) {
          d.pos[i3 + 1] = -10; // park below ground
          continue;
        }
        d.vel[i3 + 1] -= 1.6 * dt; // gravity
        d.pos[i3] += d.vel[i3] * dt;
        d.pos[i3 + 1] += d.vel[i3 + 1] * dt;
        d.pos[i3 + 2] += d.vel[i3 + 2] * dt;
      }
      if (any) this.dustGeo.attributes.position.needsUpdate = true;
    }
    // Ambient motes: slow drift and bob, wrapping inside the lamp volume.
    const m = this.motes;
    if (m && !this.reducedMotion && !prefersReducedMotion()) {
      const t = now * 0.001;
      for (let i = 0; i < m.count; i++) {
        const i3 = i * 3;
        const k = m.seed[i];
        m.pos[i3] += (0.03 + Math.sin(t * 0.3 + k) * 0.02) * dt;
        m.pos[i3 + 1] += Math.sin(t * 0.7 + k * 1.7) * 0.025 * dt;
        m.pos[i3 + 2] += Math.cos(t * 0.23 + k) * 0.02 * dt;
        if (m.pos[i3] > 2.6) m.pos[i3] = -2.6;
      }
      m.pts.geometry.attributes.position.needsUpdate = true;
      m.pts.material.opacity = 0.28 + Math.sin(t * 0.9) * 0.07; // light shimmer
    }
  }

  _applySize() {
    if (!this.renderer) return;
    const q = this.q || resolve(this.savedGfx, this.detected);
    const dpr = Math.min(window.devicePixelRatio || 1, q.dprCap) * q.scale * this.adaptiveScale;
    this.pixelRatio = Math.max(0.5, dpr);
    this.renderer.setPixelRatio(this.pixelRatio);
    const w = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 300;
    const h = this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || 300;
    this.renderer.setSize(w, h, false);
    if (this.camera) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this._applyCamera();
    }
  }

  resize() {
    this._applySize();
  }

  // ---- disposal ----

  _disposeObject(obj) {
    obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          for (const t of [m.map, m.bumpMap, m.roughnessMap]) {
            if (t && !t.userData?.shared) t.dispose();
          }
          m.dispose();
        }
      }
    });
  }

  _disposeScene() {
    if (!this.scene) return;
    this._disposeObject(this.scene);
    this._chalkGrain?.dispose();
    this._chalkGrain = null;
    this.motes = null;
    this.scene = null;
    // The post chain references the old scene; rebuild it next frame.
    this._disposePost();
    this.composer = null;
    this.postKey = null;
    this.marks.clear();
    this.winLineMesh = null;
    this.ghostGroup = null;
    this.dust = null;
    this.anims.length = 0;
  }

  dispose() {
    this.stop();
    this._disposeScene();
    this._disposePost();
    this.composer = null;
    this._softDot?.dispose();
    this.envMap?.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss?.();
      this.renderer = null;
    }
    this.disposed = true;
  }
}
