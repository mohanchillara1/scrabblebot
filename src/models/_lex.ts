// Self-contained dictionary helper for the opponent models (src/models/opponents.ts).
// Deliberately does NOT import ../engine/words.ts: the opponent models must keep working even if that module
// changes or disappears. Cost: a few MB of typed arrays and ~0.1-1 ms per best-word query.
//
// Data model: the wordlist is grouped into anagram classes ("signatures"). Per signature we keep the
// letter counts, a 26-bit letter mask, the length, the reward and one representative word (lexicographically
// first). Signatures are bucketed by length and, inside a bucket, sorted by reward descending so a query can
// stop scanning a bucket as soon as the reward can no longer beat the incumbent.
//
// Reward (letters.ts): floor(base * mult) with mult 1 (<=3 letters), 3/2 (4), 2 (5), 5/2 (6), 3 (7+).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const VALUES: readonly number[] = [
  1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10,
];

export function letterValueOf(c: string): number {
  const k = c.charCodeAt(0) - 65;
  return k >= 0 && k < 26 ? VALUES[k]! : 0;
}

export function rewardOf(base: number, len: number): number {
  if (len <= 3) return base;
  if (len === 4) return Math.floor((base * 3) / 2);
  if (len === 5) return base * 2;
  if (len === 6) return Math.floor((base * 5) / 2);
  return base * 3;
}

export interface Pick {
  word: string;
  reward: number;
  len: number;
}

interface Bucket {
  n: number;
  masks: Int32Array;
  rewards: Int32Array;
  counts: Uint8Array; // n * 26
  words: string[];
}

export class Lexicon {
  private buckets: (Bucket | undefined)[] = [];
  readonly maxLen: number;
  readonly size: number;

  constructor(wordlistPath?: string) {
    const path = wordlistPath ?? fileURLToPath(new URL("../../data/wordlist.txt", import.meta.url));
    const text = readFileSync(path, "utf8");
    const rep = new Map<string, string>(); // sorted letters -> first word
    for (const raw of text.split("\n")) {
      const w = raw.trim().toUpperCase();
      if (w.length < 2 || !/^[A-Z]+$/.test(w)) continue;
      const key = w.split("").sort().join("");
      const cur = rep.get(key);
      if (cur === undefined || w < cur) rep.set(key, w);
    }
    this.size = rep.size;
    const byLen: { key: string; word: string; reward: number }[][] = [];
    let maxLen = 0;
    for (const [key, word] of rep) {
      let base = 0;
      for (let i = 0; i < key.length; i++) base += VALUES[key.charCodeAt(i) - 65]!;
      const L = key.length;
      if (L > maxLen) maxLen = L;
      (byLen[L] ??= []).push({ key, word, reward: rewardOf(base, L) });
    }
    this.maxLen = maxLen;
    for (let L = 0; L < byLen.length; L++) {
      const arr = byLen[L];
      if (!arr) continue;
      arr.sort((a, b) => b.reward - a.reward || (a.word < b.word ? -1 : 1));
      const b: Bucket = {
        n: arr.length,
        masks: new Int32Array(arr.length),
        rewards: new Int32Array(arr.length),
        counts: new Uint8Array(arr.length * 26),
        words: new Array<string>(arr.length),
      };
      for (let i = 0; i < arr.length; i++) {
        const { key, word, reward } = arr[i]!;
        let m = 0;
        for (let j = 0; j < key.length; j++) {
          const k = key.charCodeAt(j) - 65;
          m |= 1 << k;
          b.counts[i * 26 + k]!++;
        }
        b.masks[i] = m;
        b.rewards[i] = reward;
        b.words[i] = word;
      }
      this.buckets[L] = b;
    }
  }

  /**
   * Best-reward word spellable from `rack` (letter counts, length 26) with length in [minLen, maxLen].
   * Ties on reward go to the longer word, then the lexicographically earlier signature representative.
   * `beat`: only return words whose reward is strictly greater than this (default 0).
   */
  best(rack: ArrayLike<number>, minLen = 2, maxLen = 99, beat = 0): Pick | null {
    let total = 0;
    let rackMask = 0;
    for (let k = 0; k < 26; k++) {
      const c = rack[k]!;
      if (c > 0) {
        total += c;
        rackMask |= 1 << k;
      }
    }
    let bestReward = beat;
    let best: Pick | null = null;
    const top = Math.min(total, maxLen, this.maxLen);
    for (let L = top; L >= Math.max(2, minLen); L--) {
      const b = this.buckets[L];
      if (!b) continue;
      const { masks, rewards, counts, n } = b;
      for (let i = 0; i < n; i++) {
        const r = rewards[i]!;
        if (r <= bestReward) break; // sorted desc: nothing later in this bucket can beat the incumbent
        if ((masks[i]! & ~rackMask) !== 0) continue;
        const o = i * 26;
        let ok = true;
        for (let k = 0; k < 26; k++) {
          if (counts[o + k]! > rack[k]!) {
            ok = false;
            break;
          }
        }
        if (ok) {
          bestReward = r;
          best = { word: b.words[i]!, reward: r, len: L };
          break; // first hit in a reward-sorted bucket is that bucket's best
        }
      }
    }
    return best;
  }

  /**
   * Target words: signatures with length in [minLen, maxLen] that need at most `maxMissing` letters beyond the rack.
   * Returns up to `k` best by (reward - missPenalty * missing), each with its missing-letter counts (length 26).
   */
  targets(
    rack: ArrayLike<number>,
    minLen: number,
    maxLen: number,
    maxMissing: number,
    k: number,
    missPenalty: number,
  ): { word: string; reward: number; missing: Int32Array; score: number }[] {
    let rackMask = 0;
    for (let j = 0; j < 26; j++) if (rack[j]! > 0) rackMask |= 1 << j;
    const found: { word: string; reward: number; missing: Int32Array; score: number }[] = [];
    for (let L = minLen; L <= Math.min(maxLen, this.maxLen); L++) {
      const b = this.buckets[L];
      if (!b) continue;
      const { masks, rewards, counts, n } = b;
      for (let i = 0; i < n; i++) {
        let nm = masks[i]! & ~rackMask;
        let pc = 0;
        while (nm) { nm &= nm - 1; pc++; if (pc > maxMissing) break; }
        if (pc > maxMissing) continue;
        const o = i * 26;
        let miss = 0;
        for (let j = 0; j < 26; j++) {
          const d = counts[o + j]! - rack[j]!;
          if (d > 0) miss += d;
        }
        if (miss > maxMissing) continue;
        const sc = rewards[i]! - missPenalty * miss;
        if (found.length < k || sc > found[found.length - 1]!.score) {
          const mv = new Int32Array(26);
          for (let j = 0; j < 26; j++) { const d = counts[o + j]! - rack[j]!; if (d > 0) mv[j] = d; }
          found.push({ word: b.words[i]!, reward: rewards[i]!, missing: mv, score: sc });
          found.sort((a, c) => c.score - a.score);
          if (found.length > k) found.pop();
        }
      }
    }
    return found;
  }

  /** All spellable signatures (length >= minLen) as candidates, best reward first. */
  private candidates(rack: ArrayLike<number>, minLen: number): { word: string; reward: number; len: number; c: Uint8Array }[] {
    let total = 0;
    let rackMask = 0;
    for (let k = 0; k < 26; k++) {
      const n = rack[k]!;
      if (n > 0) {
        total += n;
        rackMask |= 1 << k;
      }
    }
    const out: { word: string; reward: number; len: number; c: Uint8Array }[] = [];
    for (let L = Math.max(2, minLen); L <= Math.min(total, this.maxLen); L++) {
      const b = this.buckets[L];
      if (!b) continue;
      for (let i = 0; i < b.n; i++) {
        if ((b.masks[i]! & ~rackMask) !== 0) continue;
        const o = i * 26;
        let ok = true;
        for (let k = 0; k < 26; k++) {
          if (b.counts[o + k]! > rack[k]!) {
            ok = false;
            break;
          }
        }
        if (ok) out.push({ word: b.words[i]!, reward: b.rewards[i]!, len: L, c: b.counts.subarray(o, o + 26) });
      }
    }
    out.sort((a, b) => b.reward - a.reward);
    return out;
  }

  /**
   * Max-total-reward set of disjoint words from the rack (branch and bound over candidate words, node-capped; the
   * greedy incumbent is always a lower bound). Returned best-first. Racks above ~14 tiles are cut off by the cap.
   */
  partition(rack: ArrayLike<number>, minLen = 2, maxNodes = 40000): Pick[] {
    const cand = this.candidates(rack, minLen);
    if (cand.length === 0) return [];
    const n = cand.length;
    // best reward-per-tile among candidates at index >= i (upper-bound helper)
    const rpt = new Float64Array(n + 1);
    for (let i = n - 1; i >= 0; i--) rpt[i] = Math.max(rpt[i + 1]!, cand[i]!.reward / cand[i]!.len);
    const left = Int32Array.from(rack as ArrayLike<number>);
    let tilesLeft = 0;
    for (let k = 0; k < 26; k++) tilesLeft += left[k]!;
    let best = 0;
    let bestSet: number[] = [];
    // greedy incumbent
    {
      const g = Int32Array.from(left);
      const set: number[] = [];
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const w = cand[i]!;
        let ok = true;
        for (let k = 0; k < 26; k++) if (w.c[k]! > g[k]!) { ok = false; break; }
        if (!ok) continue;
        for (let k = 0; k < 26; k++) g[k]! -= w.c[k]!;
        set.push(i);
        sum += w.reward;
      }
      best = sum;
      bestSet = set;
    }
    let nodes = 0;
    const cur: number[] = [];
    const dfs = (start: number, sum: number, tiles: number): void => {
      if (sum > best) {
        best = sum;
        bestSet = cur.slice();
      }
      if (++nodes > maxNodes) return;
      for (let i = start; i < n; i++) {
        if (sum + tiles * rpt[i]! <= best) return; // sorted by reward, rpt is non-increasing: nothing later can win
        const w = cand[i]!;
        if (w.len > tiles) continue;
        let ok = true;
        for (let k = 0; k < 26; k++) if (w.c[k]! > left[k]!) { ok = false; break; }
        if (!ok) continue;
        for (let k = 0; k < 26; k++) left[k]! -= w.c[k]!;
        cur.push(i);
        dfs(i, sum + w.reward, tiles - w.len); // same signature may repeat (e.g. AT + TA)
        cur.pop();
        for (let k = 0; k < 26; k++) left[k]! += w.c[k]!;
        if (nodes > maxNodes) return;
      }
    };
    dfs(0, 0, tilesLeft);
    return bestSet.map((i) => ({ word: cand[i]!.word, reward: cand[i]!.reward, len: cand[i]!.len })).sort((a, b) => b.reward - a.reward);
  }

  /** Greedy partition of the rack into words: repeatedly take the best-reward word (length >= minLen). */
  dump(rack: ArrayLike<number>, minLen = 2, maxWords = 6): Pick[] {
    const left = Int32Array.from(rack as ArrayLike<number>);
    const out: Pick[] = [];
    for (let i = 0; i < maxWords; i++) {
      const p = this.best(left, minLen);
      if (!p) break;
      out.push(p);
      for (let j = 0; j < p.word.length; j++) left[p.word.charCodeAt(j) - 65]!--;
    }
    return out;
  }
}

let shared: Lexicon | null = null;
export function lexicon(): Lexicon {
  return (shared ??= new Lexicon());
}

export function rackCounts(rack: Map<string, number>): Int32Array {
  const c = new Int32Array(26);
  for (const [l, n] of rack) {
    const k = l.charCodeAt(0) - 65;
    if (k >= 0 && k < 26 && n > 0) c[k]! += n;
  }
  return c;
}
