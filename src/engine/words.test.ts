// Correctness tests for the word engine. Everything is compared against independent brute force
// that reads data/wordlist.txt itself (does not reuse the engine's dictionary structures).
//
// Run: nice -n 19 node --import tsx --test src/engine/words.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as W from "./words.js";

const WORDLIST_PATH = fileURLToPath(new URL("../../data/wordlist.txt", import.meta.url));
const WORDS: string[] = readFileSync(WORDLIST_PATH, "latin1")
  .split("\n")
  .map((l) => l.replace(/\r$/, ""))
  .filter((l) => l.length > 0);
const NW = WORDS.length;
const WCNT = new Uint8Array(NW * 26);
const WLEN = new Uint8Array(NW);
for (let i = 0; i < NW; i++) {
  const w = WORDS[i]!;
  WLEN[i] = w.length;
  for (let k = 0; k < w.length; k++) WCNT[i * 26 + w.charCodeAt(k) - 65]!++;
}

// independent value table (server's letters.ts switch, retyped)
const VAL: Record<string, number> = {};
for (const c of "AEIOULNSTR") VAL[c] = 1;
for (const c of "DG") VAL[c] = 2;
for (const c of "BCMP") VAL[c] = 3;
for (const c of "FHVWY") VAL[c] = 4;
VAL["K"] = 5;
for (const c of "JX") VAL[c] = 8;
for (const c of "QZ") VAL[c] = 10;

function refReward(word: string): number {
  let base = 0n;
  for (const c of word) base += BigInt(VAL[c] ?? 0);
  const len = word.length;
  let num = 3n;
  let den = 1n;
  if (len <= 3) [num, den] = [1n, 1n];
  else if (len === 4) [num, den] = [3n, 2n];
  else if (len === 5) [num, den] = [2n, 1n];
  else if (len === 6) [num, den] = [5n, 2n];
  return Number((base * num) / den);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRack(rng: () => number, n: number): W.Counts {
  const bag: number[] = [];
  for (let c = 0; c < 26; c++) for (let k = 0; k < W.BAG_COUNTS[c]!; k++) bag.push(c);
  const rack = new Uint8Array(26);
  for (let i = 0; i < n; i++) {
    const j = Math.floor(rng() * bag.length);
    rack[bag[j]!]!++;
    bag.splice(j, 1);
  }
  return rack;
}

function refPlayable(rack: W.Counts, minLen = 2, maxLen = 99): number[] {
  const out: number[] = [];
  for (let i = 0; i < NW; i++) {
    const len = WLEN[i]!;
    if (len < minLen || len > maxLen) continue;
    let ok = true;
    const o = i * 26;
    for (let c = 0; c < 26; c++) {
      if (WCNT[o + c]! > rack[c]!) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function sortedWords(idx: number[]): string[] {
  return idx.map((i) => WORDS[i]!).sort();
}

test("dictionary loaded from module-relative path and counted", () => {
  assert.equal(W.wordCount(), NW);
  assert.equal(NW, 172820);
});

test("reward matches server formula for every dictionary word", () => {
  for (const w of WORDS) assert.equal(W.reward(w), refReward(w), w);
  assert.equal(W.reward("QI"), 11);
  assert.equal(W.reward("ZA"), 11);
  assert.equal(W.reward("CAT"), 5);
  assert.equal(W.reward("CATS"), 9); // floor(6*3/2)
  assert.equal(W.reward("HAZEL"), 2 * (4 + 1 + 10 + 1 + 1));
  assert.equal(W.reward("QUETZAL"), 3 * (10 + 1 + 1 + 1 + 10 + 1 + 1));
  assert.equal(W.letterValue("Q"), 10);
  assert.equal(W.letterValue("a"), 0);
  assert.equal(W.letterValue("1"), 0);
});

test("isWord", () => {
  assert.ok(W.isWord("JO"));
  assert.ok(W.isWord("jo"));
  assert.ok(!W.isWord("QI")); // not in this wordlist
  assert.ok(!W.isWord("Q"));
  assert.ok(!W.isWord("ZZZZ"));
  assert.ok(!W.isWord("QI1"));
  assert.ok(!W.isWord(""));
});

test("rack helpers round-trip", () => {
  const m = new Map<string, number>([
    ["A", 2],
    ["Z", 1],
    ["q", 5], // lowercase ignored
    ["E", 0],
  ]);
  const c = W.rackToCounts(m);
  assert.equal(c[0], 2);
  assert.equal(c[25], 1);
  assert.equal(W.totalTiles(c), 3);
  const back = W.countsToMap(c);
  assert.deepEqual([...back.entries()].sort(), [
    ["A", 2],
    ["Z", 1],
  ]);
  assert.equal(W.countsToString(c), "AAZ");
  assert.ok(W.canSpell(c, "ZA"));
  assert.ok(!W.canSpell(c, "ZAZ"));
  assert.equal(W.countsToString(W.subtractWord(c, "ZA")), "A");
});

test("playableWords == brute force on 600 random racks (sizes 3..20)", () => {
  const rng = mulberry32(12345);
  for (let t = 0; t < 600; t++) {
    const n = 3 + (t % 18);
    const rack = randomRack(rng, n);
    const expected = sortedWords(refPlayable(rack));
    const got = W.playableWords(rack).slice().sort();
    assert.deepEqual(got, expected, `rack ${W.countsToString(rack)}`);
    assert.equal(W.countPlayable(rack), expected.length);
    // length filters
    const e7 = sortedWords(refPlayable(rack, 7));
    assert.deepEqual(W.playableWords(rack, { minLen: 7 }).slice().sort(), e7);
    const e35 = sortedWords(refPlayable(rack, 3, 5));
    assert.deepEqual(W.playableWords(rack, { minLen: 3, maxLen: 5 }).slice().sort(), e35);
    // histogram
    const hist = W.playableByLength(rack);
    const ref = new Map<number, number>();
    for (const w of expected) ref.set(w.length, (ref.get(w.length) ?? 0) + 1);
    for (let L = 0; L < hist.length; L++) assert.equal(hist[L], ref.get(L) ?? 0);
  }
});

test("playableWords on degenerate racks", () => {
  assert.deepEqual(W.playableWords(new Uint8Array(26)), []);
  assert.deepEqual(W.playableWords(W.wordToCounts("A")), []);
  assert.ok(W.playableWords(W.wordToCounts("JO")).includes("JO"));
  // a rack with 30 of one letter must not break anything
  const c = new Uint8Array(26);
  c[0] = 30;
  const got = W.playableWords(c);
  assert.deepEqual(got.sort(), sortedWords(refPlayable(c)));
});

test("bestWord == brute force (reward, then fewer tiles, then lexicographic) on 600 racks", () => {
  const rng = mulberry32(777);
  for (let t = 0; t < 600; t++) {
    const n = 3 + (t % 18);
    const rack = randomRack(rng, n);
    for (const minLen of [2, 4]) {
      const idx = refPlayable(rack, minLen);
      const got = W.bestWord(rack, { minLen });
      if (idx.length === 0) {
        assert.equal(got, null);
        continue;
      }
      let best = idx[0]!;
      for (const i of idx) {
        const a = refReward(WORDS[i]!);
        const b = refReward(WORDS[best]!);
        if (a > b || (a === b && (WLEN[i]! < WLEN[best]! || (WLEN[i] === WLEN[best] && WORDS[i]! < WORDS[best]!)))) best = i;
      }
      assert.ok(got);
      assert.equal(got.word, WORDS[best]);
      assert.equal(got.reward, refReward(WORDS[best]!));
    }
  }
});

// ---- partition ---------------------------------------------------------------------------------

/** Independent exhaustive set-packing: choose multiset of playable words with total counts <= rack. */
function exhaustivePartition(rack: W.Counts): number {
  const idx = refPlayable(rack);
  const rew = idx.map((i) => refReward(WORDS[i]!));
  // dedupe identical count vectors (anagrams): keep first
  const seen = new Set<string>();
  const cand: number[] = [];
  for (let k = 0; k < idx.length; k++) {
    const key = Array.from(WCNT.subarray(idx[k]! * 26, idx[k]! * 26 + 26)).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    cand.push(k);
  }
  const cur = rack.slice();
  let best = 0;
  function rec(start: number, total: number): void {
    if (total > best) best = total;
    for (let q = start; q < cand.length; q++) {
      const k = cand[q]!;
      const o = idx[k]! * 26;
      let ok = true;
      for (let c = 0; c < 26; c++) {
        if (WCNT[o + c]! > cur[c]!) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      for (let c = 0; c < 26; c++) cur[c]! -= WCNT[o + c]!;
      rec(q, total + rew[k]!);
      for (let c = 0; c < 26; c++) cur[c]! += WCNT[o + c]!;
    }
  }
  rec(0, 0);
  return best;
}

/** Independent memoised DP on count vectors (first nonzero letter: discard a copy, or a word containing it). */
function dpPartition(rack: W.Counts): number {
  const idx = refPlayable(rack);
  const byFirst: Array<Array<{ cnt: Uint8Array; rew: number }>> = Array.from({ length: 26 }, () => []);
  const seen = new Set<string>();
  for (const i of idx) {
    const cnt = WCNT.slice(i * 26, i * 26 + 26);
    const key = cnt.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    let f = 0;
    while (cnt[f] === 0) f++;
    byFirst[f]!.push({ cnt, rew: refReward(WORDS[i]!) });
  }
  const memo = new Map<string, number>();
  const R = rack.slice();
  function f(): number {
    let first = 0;
    while (first < 26 && R[first] === 0) first++;
    if (first === 26) return 0;
    const key = R.join(",");
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let best = 0;
    // discard one copy of `first`
    R[first]!--;
    best = f();
    R[first]!++;
    for (const w of byFirst[first]!) {
      let ok = true;
      for (let c = first; c < 26; c++) {
        if (w.cnt[c]! > R[c]!) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      for (let c = first; c < 26; c++) R[c]! -= w.cnt[c]!;
      const v = w.rew + f();
      for (let c = first; c < 26; c++) R[c]! += w.cnt[c]!;
      if (v > best) best = v;
    }
    memo.set(key, best);
    return best;
  }
  return f();
}

function checkPartitionValid(rack: W.Counts, res: W.PartitionResult): void {
  const used = new Uint8Array(26);
  let total = 0;
  for (const w of res.words) {
    assert.ok(W.isWord(w), `not a word: ${w}`);
    total += refReward(w);
    for (let i = 0; i < w.length; i++) used[w.charCodeAt(i) - 65]!++;
  }
  for (let c = 0; c < 26; c++) assert.ok(used[c]! <= rack[c]!, "uses letters not in rack");
  assert.equal(total, res.total, "total mismatch");
}

test("bestPartition == exhaustive search on 300 small racks (3..9 letters)", () => {
  const rng = mulberry32(2024);
  for (let t = 0; t < 300; t++) {
    const n = 3 + (t % 7);
    const rack = randomRack(rng, n);
    const res = W.bestPartition(rack, { timeBudgetMs: 5000, useCache: false });
    checkPartitionValid(rack, res);
    assert.ok(res.optimal, `not optimal: ${W.countsToString(rack)}`);
    assert.equal(res.total, exhaustivePartition(rack), `rack ${W.countsToString(rack)}`);
  }
});

test("bestPartition == independent DP on 160 racks (10..14 letters)", () => {
  const rng = mulberry32(99);
  for (let t = 0; t < 160; t++) {
    const n = 10 + (t % 5);
    const rack = randomRack(rng, n);
    const res = W.bestPartition(rack, { timeBudgetMs: 10000, useCache: false });
    checkPartitionValid(rack, res);
    assert.ok(res.optimal, `not optimal: ${W.countsToString(rack)}`);
    assert.equal(res.total, dpPartition(rack), `rack ${W.countsToString(rack)}`);
  }
});

test("bestPartition: result is valid, never worse than best word, cache is consistent (racks to 25)", () => {
  const rng = mulberry32(31337);
  for (let t = 0; t < 120; t++) {
    const n = 15 + (t % 11);
    const rack = randomRack(rng, n);
    const res = W.bestPartition(rack, { timeBudgetMs: 50, useCache: false });
    checkPartitionValid(rack, res);
    const bw = W.bestWord(rack);
    assert.ok(res.total >= (bw?.reward ?? 0));
    if (res.optimal) {
      const again = W.bestPartition(rack, { timeBudgetMs: 50 }); // fills cache
      const cached = W.bestPartition(rack, { timeBudgetMs: 1 });
      assert.equal(again.total, res.total);
      assert.equal(cached.total, res.total);
      checkPartitionValid(rack, cached);
    }
  }
});

test("bestPartition: tiny budget still returns a valid greedy-or-better answer", () => {
  const rng = mulberry32(5);
  for (let t = 0; t < 40; t++) {
    const rack = randomRack(rng, 22);
    const res = W.bestPartition(rack, { timeBudgetMs: 0.01, useCache: false });
    checkPartitionValid(rack, res);
    assert.ok(res.total >= (W.bestWord(rack)?.reward ?? 0) - 0);
  }
});

test("bestPartition degenerate", () => {
  assert.deepEqual(W.bestPartition(new Uint8Array(26)), { words: [], total: 0, optimal: true, nodes: 0 });
  const r = W.bestPartition(W.wordToCounts("QQQ"));
  assert.equal(r.total, 0);
  assert.deepEqual(r.words, []);
  const jojo = W.wordToCounts("JOJO");
  const r2 = W.bestPartition(jojo, { useCache: false });
  assert.equal(r2.total, exhaustivePartition(jojo));
  assert.ok(r2.total >= 18);
});

// ---- bestPlayWithLeave ------------------------------------------------------------------------

test("bestPlayWithLeave: zero leave value == bestPartition total; never worse than playing nothing", () => {
  const rng = mulberry32(4242);
  for (let t = 0; t < 80; t++) {
    const n = 4 + (t % 9);
    const rack = randomRack(rng, n);
    const res = W.bestPlayWithLeave(rack, () => 0, { timeBudgetMs: 2000, maxWords: 6, poolSize: 100000, maxEvals: 1e6 });
    const part = W.bestPartition(rack, { timeBudgetMs: 5000 });
    assert.ok(part.optimal);
    assert.equal(res.value, part.total, `rack ${W.countsToString(rack)}`);
    // leave + words == rack
    const sum = res.leave.slice();
    for (const w of res.words) for (let i = 0; i < w.length; i++) sum[w.charCodeAt(i) - 65]!++;
    assert.deepEqual([...sum], [...rack]);
    assert.equal(res.reward, res.words.reduce((a, w) => a + refReward(w), 0));
  }
});

test("bestPlayWithLeave == brute-force enumeration of all <=3-word plays (small racks, nonlinear leave)", () => {
  const rng = mulberry32(808);
  // leave value: strongly prefers keeping E/S, hates keeping Q or duplicates
  const lv = (leave: W.Counts): number => {
    let v = 0;
    v += 6 * Math.min(leave[4]!, 1) + 5 * Math.min(leave[18]!, 1);
    v -= 7 * leave[16]!;
    for (let c = 0; c < 26; c++) if (leave[c]! > 1) v -= 3 * (leave[c]! - 1);
    v += 0.5 * W.totalTiles(leave);
    return v;
  };
  for (let t = 0; t < 60; t++) {
    const n = 5 + (t % 5);
    const rack = randomRack(rng, n);
    const idx = refPlayable(rack);
    const seen = new Set<string>();
    const cand: number[] = [];
    for (const i of idx) {
      const key = Array.from(WCNT.subarray(i * 26, i * 26 + 26)).join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      cand.push(i);
    }
    let best = lv(rack);
    const cur = rack.slice();
    const rec = (start: number, depth: number, rew: number): void => {
      if (depth > 0) best = Math.max(best, rew + lv(cur));
      if (depth >= 3) return;
      for (let q = start; q < cand.length; q++) {
        const o = cand[q]! * 26;
        let ok = true;
        for (let c = 0; c < 26; c++) if (WCNT[o + c]! > cur[c]!) ok = false;
        if (!ok) continue;
        for (let c = 0; c < 26; c++) cur[c]! -= WCNT[o + c]!;
        rec(q, depth + 1, rew + refReward(WORDS[cand[q]!]!));
        for (let c = 0; c < 26; c++) cur[c]! += WCNT[o + c]!;
      }
    };
    rec(0, 0, 0);
    const res = W.bestPlayWithLeave(rack, lv, { timeBudgetMs: 5000, maxWords: 3, poolSize: 100000, maxEvals: 1e6 });
    assert.ok(res.complete);
    assert.ok(Math.abs(res.value - best) < 1e-9, `rack ${W.countsToString(rack)}: got ${res.value} want ${best}`);
  }
});

test("bestPlayWithLeave can play nothing", () => {
  const rack = W.wordToCounts("JOEE");
  // leave is worth 1000 per tile -> keep everything
  const res = W.bestPlayWithLeave(rack, (l) => 1000 * W.totalTiles(l));
  assert.deepEqual(res.words, []);
  assert.equal(res.reward, 0);
  assert.deepEqual([...res.leave], [...rack]);
});

// ---- completion statistics --------------------------------------------------------------------

function refDef(rack: W.Counts, i: number): number {
  let d = 0;
  for (let c = 0; c < 26; c++) d += Math.max(0, WCNT[i * 26 + c]! - rack[c]!);
  return d;
}

test("completionTables / nearWords / minMissing / deficiencyHistogram == brute force", () => {
  const rng = mulberry32(606);
  for (let t = 0; t < 60; t++) {
    const n = 3 + (t % 16);
    const rack = randomRack(rng, n);
    const tables = W.completionTables(rack, [4, 5, 7]);
    for (const tb of tables) {
      const words = new Int32Array(26);
      const best = new Int32Array(26);
      const sum = new Float64Array(26);
      for (let i = 0; i < NW; i++) {
        if (WLEN[i]! < tb.minLen) continue;
        if (refDef(rack, i) !== 1) continue;
        let c = 0;
        for (; c < 26; c++) if (WCNT[i * 26 + c]! > rack[c]!) break;
        words[c]!++;
        const r = refReward(WORDS[i]!);
        best[c] = Math.max(best[c]!, r);
        sum[c]! += r;
      }
      assert.deepEqual([...tb.words], [...words], `words minLen=${tb.minLen} rack ${W.countsToString(rack)}`);
      assert.deepEqual([...tb.bestReward], [...best]);
      assert.deepEqual([...tb.sumReward], [...sum]);
    }
    // single-table convenience agrees
    assert.deepEqual([...W.completionTable(rack, { minLen: 5 }).words], [...tables[1]!.words]);

    // min missing for 7+
    let mm = 99;
    for (let i = 0; i < NW; i++) if (WLEN[i]! >= 7) mm = Math.min(mm, refDef(rack, i));
    const got = W.minMissing(rack, { minLen: 7 });
    assert.equal(got.missing, mm);
    let cntAt = 0;
    for (let i = 0; i < NW; i++) if (WLEN[i]! >= 7 && refDef(rack, i) === mm) cntAt++;
    assert.equal(got.words, cntAt);

    // histogram
    const hist = W.deficiencyHistogram(rack, { minLen: 7, maxK: 3 });
    const refH = [0, 0, 0, 0];
    for (let i = 0; i < NW; i++) {
      if (WLEN[i]! < 7) continue;
      const d = refDef(rack, i);
      if (d <= 3) refH[d]!++;
    }
    assert.deepEqual([...hist], refH);

    // near words (<=1 missing, len 5..8)
    const near = W.nearWords(rack, { minLen: 5, maxLen: 8, maxMissing: 1, limit: 100000 });
    let refNearSigs = new Set<string>();
    for (let i = 0; i < NW; i++) {
      if (WLEN[i]! < 5 || WLEN[i]! > 8) continue;
      if (refDef(rack, i) <= 1) refNearSigs.add(Array.from(WCNT.subarray(i * 26, i * 26 + 26)).join(","));
    }
    assert.equal(near.length, refNearSigs.size);
    for (const nw of near) {
      const wc = W.wordToCounts(nw.word);
      let d = 0;
      for (let c = 0; c < 26; c++) d += Math.max(0, wc[c]! - rack[c]!);
      assert.equal(d, nw.missing);
      assert.equal(nw.missingLetters.length, nw.missing);
      assert.equal(nw.reward, refReward(nw.word));
    }
    // sorted: missing asc, reward desc
    for (let i = 1; i < near.length; i++) {
      const a = near[i - 1]!;
      const b = near[i]!;
      assert.ok(a.missing < b.missing || (a.missing === b.missing && a.reward >= b.reward));
    }
    refNearSigs = new Set();
  }
});

test("marginalLetterGains agrees with partitionValue differences", () => {
  const rack = W.wordToCounts("AEINRST");
  const gains = W.marginalLetterGains(rack, { totalBudgetMs: 5000, perSolveMs: 1000 });
  const base = W.partitionValue(rack, 200);
  for (let c = 0; c < 26; c++) {
    const r2 = rack.slice();
    r2[c]!++;
    assert.equal(gains[c], W.bestPartition(r2, { timeBudgetMs: 200 }).total - base);
  }
});

test("bestPlayWithLeave: leaveValue may call back into the engine (re-entrancy)", () => {
  const rng = mulberry32(31);
  for (let t = 0; t < 20; t++) {
    const rack = randomRack(rng, 9 + (t % 4));
    const lv = (leave: W.Counts): number => 0.5 * W.bestPartition(leave, { timeBudgetMs: 50 }).total;
    const res = W.bestPlayWithLeave(rack, lv, { timeBudgetMs: 2000 });
    // the chosen play is at least as good as playing nothing and as the plain best partition
    const nothing = lv(rack);
    const part = W.bestPartition(rack, { timeBudgetMs: 2000 });
    const partLeave = rack.slice();
    for (const w of part.words) for (let i = 0; i < w.length; i++) partLeave[w.charCodeAt(i) - 65]!--;
    assert.ok(res.value >= nothing - 1e-9);
    assert.ok(res.value >= part.total + lv(partLeave) - 1e-9);
    assert.ok(Math.abs(res.value - (res.reward + lv(res.leave))) < 1e-9);
  }
});
