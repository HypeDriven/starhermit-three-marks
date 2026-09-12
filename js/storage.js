// Persistence: settings, profile, progression, achievements, daily history.
// Local documents are versioned and checksummed like the cloud-save format so
// a host sync layer can exchange them without transformation.
import { hashString } from './rng.js';

export const SAVE_VERSION = 1;
const LS_PREFIX = 'three-marks.';

export const ACHIEVEMENTS = [
  { key: 'first_line', name: 'First Line', desc: 'Win your first round.' },
  { key: 'quick_study', name: 'Quick Study', desc: 'Complete every Learn lesson.' },
  { key: 'journey_mastery', name: 'Journey Master', desc: 'Complete all five mastery stages.' },
  { key: 'daily_streak_5', name: 'Five Days Running', desc: 'Complete the daily challenge five days in a row.' },
  { key: 'grand_slate', name: 'Grand Slate', desc: 'Win a 5x5 line-of-four round against an Expert.' },
  { key: 'century', name: 'Century of Marks', desc: 'Play one hundred rounds.' },
];

export function defaultSettings() {
  return {
    version: SAVE_VERSION,
    audio: { music: 0.6, effects: 0.8, ambience: 0.5, voice: 0.8, muted: false },
    graphics: { tier: 'auto', renderScale: 1.0 }, // tier: auto|low|medium|high
    accessibility: {
      reducedMotion: false, highContrast: false, palette: 'default', // default|deuteranopia|tritanopia
      largerText: false, leftHanded: false, confirmMoves: false, timingAssist: false,
      haptics: true,
    },
    camera: { angle: 'standard' }, // standard|top|low
    tutorial: { completedLessons: [] },
    bindings: null, // player overrides for desktop key bindings
    theme: 'slate',
  };
}

export function defaultProgression() {
  return {
    version: SAVE_VERSION,
    journey: {}, // stageId -> {stars, bestScore, completedAt}
    lessons: {}, // lessonId -> {completedAt}
    challenges: {}, // challengeId -> {bestScore, completedAt}
    dailies: {}, // dailyId -> {score, won, completedAt, excludedFromRanking}
    achievements: {}, // key -> {unlockedAt}
    stats: {
      roundsPlayed: 0, roundsWon: 0, roundsDrawn: 0,
      byMode: {}, // mode -> {played, won}
      totalScore: 0,
    },
    updatedAt: 0,
    generation: 0, // bump on every write; strict descendant = higher generation
  };
}

function checksum(doc) {
  const clone = { ...doc };
  delete clone.checksum;
  return hashString(JSON.stringify(clone)).toString(16).padStart(8, '0');
}

function seal(doc) {
  const out = { ...doc };
  out.checksum = checksum(out);
  return out;
}

function unseal(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (doc.checksum && doc.checksum !== checksum(doc)) return null; // corrupt
  return doc;
}

function storageAvailable() {
  try {
    const k = LS_PREFIX + 'probe';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

export class Store {
  constructor(namespace = 'local') {
    this.ns = namespace;
    this.memory = new Map(); // fallback when localStorage is unavailable
    this.persistent = typeof localStorage !== 'undefined' && storageAvailable();
  }

  key(name) {
    return `${LS_PREFIX}${this.ns}.${name}`;
  }

  readRaw(name) {
    const raw = this.persistent ? localStorage.getItem(this.key(name)) : this.memory.get(this.key(name));
    if (raw == null) return null;
    try {
      return unseal(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  writeRaw(name, doc) {
    const sealed = seal(doc);
    const raw = JSON.stringify(sealed);
    if (this.persistent) {
      try {
        localStorage.setItem(this.key(name), raw);
      } catch {
        this.memory.set(this.key(name), raw);
      }
    } else {
      this.memory.set(this.key(name), raw);
    }
    return sealed;
  }

  loadSettings() {
    const doc = this.readRaw('settings');
    return migrateSettings(doc || defaultSettings());
  }

  saveSettings(settings) {
    return this.writeRaw('settings', { ...settings, version: SAVE_VERSION });
  }

  loadProgression() {
    const doc = this.readRaw('progression');
    return migrateProgression(doc || defaultProgression());
  }

  saveProgression(prog) {
    const next = { ...prog, version: SAVE_VERSION, updatedAt: Date.now(), generation: (prog.generation || 0) + 1 };
    return this.writeRaw('progression', next);
  }

  // Last safe local snapshot (recover an interrupted round).
  saveSnapshot(name, snapshot) {
    return this.writeRaw(`snapshot.${name}`, snapshot);
  }

  loadSnapshot(name) {
    return this.readRaw(`snapshot.${name}`);
  }

  clearSnapshot(name) {
    if (this.persistent) localStorage.removeItem(this.key(`snapshot.${name}`));
    this.memory.delete(this.key(`snapshot.${name}`));
  }
}

export function migrateSettings(doc) {
  const base = defaultSettings();
  if (!doc || typeof doc !== 'object') return base;
  return {
    ...base,
    ...doc,
    version: SAVE_VERSION,
    audio: { ...base.audio, ...(doc.audio || {}) },
    graphics: { ...base.graphics, ...(doc.graphics || {}) },
    accessibility: { ...base.accessibility, ...(doc.accessibility || {}) },
    camera: { ...base.camera, ...(doc.camera || {}) },
    tutorial: { ...base.tutorial, ...(doc.tutorial || {}) },
  };
}

export function migrateProgression(doc) {
  const base = defaultProgression();
  if (!doc || typeof doc !== 'object') return base;
  return {
    ...base,
    ...doc,
    version: SAVE_VERSION,
    stats: { ...base.stats, ...(doc.stats || {}), byMode: { ...(doc.stats && doc.stats.byMode) || {} } },
  };
}

// Cloud-save conflict resolution: a strict descendant (higher generation)
// wins outright; otherwise both snapshots are preserved and reported so the
// player can choose. Never destroys data.
export function resolveConflict(localDoc, remoteDoc) {
  if (!remoteDoc) return { winner: localDoc, kept: [localDoc], needsPlayerChoice: false };
  if (!localDoc) return { winner: remoteDoc, kept: [remoteDoc], needsPlayerChoice: false };
  if ((localDoc.generation || 0) > (remoteDoc.generation || 0)) {
    return { winner: localDoc, kept: [localDoc, remoteDoc], needsPlayerChoice: false };
  }
  if ((remoteDoc.generation || 0) > (localDoc.generation || 0)) {
    return { winner: remoteDoc, kept: [localDoc, remoteDoc], needsPlayerChoice: false };
  }
  if (checksum(localDoc) === checksum(remoteDoc)) {
    return { winner: localDoc, kept: [localDoc], needsPlayerChoice: false };
  }
  return { winner: null, kept: [localDoc, remoteDoc], needsPlayerChoice: true };
}

// ---- Achievement unlocking (idempotent) ----

export function unlockAchievement(progression, key, now = Date.now()) {
  if (!ACHIEVEMENTS.some((a) => a.key === key)) return { progression, unlocked: null };
  if (progression.achievements[key]) return { progression, unlocked: null }; // idempotent
  const next = {
    ...progression,
    achievements: { ...progression.achievements, [key]: { unlockedAt: now } },
  };
  return { progression: next, unlocked: key };
}

// ---- Daily streak ----

export function dailyStreak(dailies, todayIso) {
  let streak = 0;
  let day = new Date(todayIso + 'T00:00:00Z').getTime();
  for (;;) {
    const iso = new Date(day).toISOString().slice(0, 10);
    const entry = dailies[`daily-${iso}`];
    if (!entry || entry.excludedFromRanking) break;
    streak++;
    day -= 86400000;
  }
  return streak;
}
