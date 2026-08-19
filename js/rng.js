// Seeded deterministic random streams. Rules, content decoration and
// audiovisual variants each use their own stream so cosmetic randomness can
// never influence rules outcomes.

export function hashString(str) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function hashCombined(...parts) {
  return hashString(parts.join('|'));
}

export class RngStream {
  constructor(seed) {
    // splitmix32 seeding into mulberry32 state
    this.state = seed >>> 0;
  }

  next() {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min, max) {
    return min + this.next() * (max - min);
  }

  int(min, maxInclusive) {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  serialize() {
    return this.state >>> 0;
  }

  static deserialize(state) {
    const r = new RngStream(0);
    r.state = state >>> 0;
    return r;
  }
}

// Canonical stringify (sorted keys, recursively) for stable hashing.
export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
}

export function hashState(value) {
  return hashString(canonicalStringify(value)).toString(16).padStart(8, '0');
}
