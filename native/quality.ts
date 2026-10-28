// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU its
// Auto gave it) keyed by the runtime's quality tier (frame().quality); the
// chalk-dust pool, burst and motes scale within the tier with the level
// (frame().levelIndex, at most 2×) as the browser build scaled them by its
// hardware level. The runtime owns the rest of the old Graphics panel: Auto
// and the level choice, render scale (Ultra's 1.25) and the pixel-ratio cap,
// adaptive resolution, the frame-rate limit and readout. The panel's
// per-effect overrides are not offered (Options choose a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Lit surfaces: Lambert (Low), Standard (Balanced), Physical with the clear-coated frame (High, Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Procedural wood size (desk, frame); slate and chalk grain at ½ and ¼ of it. */
  texture: 256 | 512 | 1024;
  round: number; curve: number; bevel: number; tube: number; tubeRadial: number;
  /** Particles "high": chalk-dust pool, dust per mark, lamp-light motes. */
  particles: { pool: number; dustPerMark: number; motes: number };
  bloomRes: number; aoRes: number;
}
export interface Look {
  preset: QualityTier;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  particles: "low" | "high";
  /** Wood and slate surface maps, chalk grain, desk props. */
  detailed: boolean;
  budget: Budget;
}
const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, particles: "low", detailed: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, particles: "low", detailed: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, particles: "high", detailed: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, particles: "high", detailed: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 256, round: 12, curve: 6, bevel: 1, tube: 12, tubeRadial: 5, particles: { pool: 900, dustPerMark: 20, motes: 60 }, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", texture: 256, round: 16, curve: 8, bevel: 1, tube: 18, tubeRadial: 6, particles: { pool: 1400, dustPerMark: 28, motes: 90 }, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", texture: 512, round: 24, curve: 12, bevel: 2, tube: 24, tubeRadial: 7, particles: { pool: 2200, dustPerMark: 40, motes: 140 }, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", texture: 1024, round: 32, curve: 16, bevel: 3, tube: 32, tubeRadial: 9, particles: { pool: 3200, dustPerMark: 56, motes: 220 }, bloomRes: 1, aoRes: 1 },
};
/** Particles "low" (fixed). */
export const PARTICLES_LOW = { pool: 300, dustPerMark: 10, motes: 0 };
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };
export const POOL_MAX = 6400;
export const MOTE_MAX = 440;

export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const src = BUDGETS[preset];
  const b: Budget = { ...src, particles: { ...src.particles } };
  const k = Math.min(2, Math.pow(1.5, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.particles.pool = Math.min(POOL_MAX, Math.round(b.particles.pool * k));
  b.particles.dustPerMark = Math.round(b.particles.dustPerMark * k);
  b.particles.motes = Math.min(MOTE_MAX, Math.round(b.particles.motes * k));
  return { preset, ...TABLE[preset], budget: b };
}
export function particleBudget(look: Look): Budget["particles"] { return look.particles === "high" ? look.budget.particles : PARTICLES_LOW; }
