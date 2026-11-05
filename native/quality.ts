// The look per graphics level: the engine's level settings (levelSettings():
// shadows and their map size, AO, bloom resolution, grade, anti-aliasing) plus
// the browser build's art (js/gfx.js TABLE / BUDGETS) keyed by the runtime's
// quality tier (frame().quality); the chalk-dust pool, burst and motes scale
// within the tier by the level's particle budget (at most 2×). The runtime owns
// the rest of the old Graphics panel: Auto and the level choice, render scale
// and the pixel-ratio cap, adaptive resolution, the frame-rate limit and
// readout. The panel's per-effect overrides are not offered (Options choose a
// level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Lit surfaces: Lambert (Low), Standard (Balanced), Physical with the clear-coated frame (High, Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Procedural wood size (desk, frame); slate and chalk grain at ½ and ¼ of it. */
  texture: 256 | 512 | 1024;
  round: number; curve: number; bevel: number; tube: number; tubeRadial: number;
  /** Particles "high": chalk-dust pool, dust per mark, lamp-light motes. */
  particles: { pool: number; dustPerMark: number; motes: number };
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map: the level's size (0 = off). */
  shadows: number;
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null = off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  particles: "low" | "high";
  /** Wood and slate surface maps, chalk grain, desk props. */
  detailed: boolean;
  budget: Budget;
}
type Art = Pick<Look, "reflections" | "particles" | "detailed">;
const ART: Record<QualityTier, Art> = {
  low: { reflections: false, particles: "low", detailed: false },
  balanced: { reflections: true, particles: "low", detailed: true },
  high: { reflections: true, particles: "high", detailed: true },
  ultra: { reflections: true, particles: "high", detailed: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 256, round: 12, curve: 6, bevel: 1, tube: 12, tubeRadial: 5, particles: { pool: 900, dustPerMark: 20, motes: 60 } },
  balanced: { material: "standard", texture: 256, round: 16, curve: 8, bevel: 1, tube: 18, tubeRadial: 6, particles: { pool: 1400, dustPerMark: 28, motes: 90 } },
  high: { material: "physical", texture: 512, round: 24, curve: 12, bevel: 2, tube: 24, tubeRadial: 7, particles: { pool: 2200, dustPerMark: 40, motes: 140 } },
  ultra: { material: "physical", texture: 1024, round: 32, curve: 16, bevel: 3, tube: 32, tubeRadial: 9, particles: { pool: 3200, dustPerMark: 56, motes: 220 } },
};
/** Particles "low" (fixed). */
export const PARTICLES_LOW = { pool: 300, dustPerMark: 10, motes: 0 };
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };
export const POOL_MAX = 6400;
export const MOTE_MAX = 440;

export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const src = BUDGETS[preset];
  const b: Budget = { ...src, particles: { ...src.particles } };
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.particles.pool = Math.min(POOL_MAX, Math.round(b.particles.pool * k));
  b.particles.dustPerMark = Math.round(b.particles.dustPerMark * k);
  b.particles.motes = Math.min(MOTE_MAX, Math.round(b.particles.motes * k));
  return {
    preset, ...ART[preset], budget: b,
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
  };
}
export function particleBudget(look: Look): Budget["particles"] { return look.particles === "high" ? look.budget.particles : PARTICLES_LOW; }
