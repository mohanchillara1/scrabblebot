// Small deterministic RNG helpers. Everything in the simulator is keyed by (seed, match, stream, ...) hashes so
// that two strategies compared on the same seed see the same bag, the same sim jitter and the same tie-breaks
// no matter how much randomness each of them consumes.

/** Mix 32-bit integers into one well-scrambled unsigned 32-bit hash (murmur3-style finaliser per element). */
export function hash32(...xs: number[]): number {
  let h = 0x9747b28c;
  for (const x of xs) {
    let k = Math.imul(x | 0, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= xs.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32: tiny, fast, good-enough PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [lo, hi] inclusive. */
export function intInRange(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** Fisher-Yates exactly as the server's shuffle() (iterates i = n-1 .. 1, j = integerInRange(0, i)). */
export function shuffleInPlace<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i >= 1; i--) {
    const j = intInRange(rng, 0, i);
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
}
