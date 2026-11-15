// =====================================================================
// rng.js: a small seeded random number generator (mulberry32).
//
// Math.random() gives different numbers every run. A seeded generator
// gives the SAME sequence for the same seed, so the synthetic dataset,
// and therefore the replay report, can be reproduced exactly (D55).
// =====================================================================

export function seededRandom(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /** Whole number between min and max, inclusive. */
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (probability) => next() < probability,
  };
}