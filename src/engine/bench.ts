// Micro-benchmark for the word engine. Run:  nice -n 19 timeout 200 npx tsx src/engine/bench.ts [N]
import * as W from "./words.js";

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
function stats(xs: number[]): string {
  const s = xs.slice().sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const q = (p: number): number => s[Math.min(n - 1, Math.floor(p * n))]!;
  return `mean ${mean.toFixed(3)} +- ${(sd / Math.sqrt(n)).toFixed(3)} (SE)  p50 ${q(0.5).toFixed(3)}  p99 ${q(0.99).toFixed(3)}  max ${s[n - 1]!.toFixed(3)} ms  (n=${n})`;
}
function time<T>(f: () => T): [T, number] {
  const t = performance.now();
  const r = f();
  return [r, performance.now() - t];
}

const N = Number(process.argv[2] ?? 300);
const only = process.argv[3];
console.log("dictionary load ms:", W.warmUp().toFixed(1), " words", W.wordCount());
const rng = mulberry32(2026);
const racks = (n: number, k: number): W.Counts[] => Array.from({ length: k }, () => randomRack(rng, n));

// warm JIT
for (const r of racks(10, 50)) {
  W.playableWords(r);
  W.bestWord(r);
  W.bestPartition(r, { useCache: false });
}

function section(name: string, f: () => void): void {
  if (only && !name.startsWith(only)) return;
  f();
}

section("playableWords", () => {
  for (const n of [5, 7, 12, 16, 20, 25]) {
    const rs = racks(n, N);
    const ts: number[] = [];
    let tot = 0;
    for (const r of rs) {
      const [w, t] = time(() => W.playableWords(r));
      ts.push(t);
      tot += w.length;
    }
    console.log(`playableWords  n=${String(n).padStart(2)}  ${stats(ts)}  avg words ${(tot / rs.length).toFixed(0)}`);
  }
});
section("bestWord", () => {
  for (const n of [7, 12, 20, 25]) {
    const ts = racks(n, N).map((r) => time(() => W.bestWord(r))[1]);
    console.log(`bestWord       n=${String(n).padStart(2)}  ${stats(ts)}`);
  }
});
section("bestPartition", () => {
  for (const n of [10, 15, 20, 25]) {
    const rs = racks(n, Math.min(N, 150));
    const ts: number[] = [];
    let opt = 0;
    const totals: number[] = [];
    const nodes: number[] = [];
    for (const r of rs) {
      const [res, t] = time(() => W.bestPartition(r, { timeBudgetMs: 50, useCache: false }));
      ts.push(t);
      if (res.optimal) opt++;
      totals.push(res.total);
      nodes.push(res.nodes ?? 0);
    }
    const m = totals.reduce((a, b) => a + b, 0) / totals.length;
    const sd = Math.sqrt(totals.reduce((a, b) => a + (b - m) ** 2, 0) / (totals.length - 1));
    console.log(
      `bestPartition  n=${String(n).padStart(2)} budget50  ${stats(ts)}  optimal ${((100 * opt) / rs.length).toFixed(0)}%  mean total ${m.toFixed(1)} +- ${(sd / Math.sqrt(totals.length)).toFixed(2)}  mean nodes ${(nodes.reduce((a, b) => a + b, 0) / nodes.length).toFixed(0)}`,
    );
  }
});
section("bestPartition-b5", () => {
  for (const n of [10, 15, 20, 25]) {
    const rs = racks(n, Math.min(N, 150));
    const ts: number[] = [];
    let opt = 0;
    for (const r of rs) {
      const [res, t] = time(() => W.bestPartition(r, { timeBudgetMs: 5, useCache: false }));
      ts.push(t);
      if (res.optimal) opt++;
    }
    console.log(`bestPartition  n=${String(n).padStart(2)} budget5   ${stats(ts)}  optimal ${((100 * opt) / rs.length).toFixed(0)}%`);
  }
});
section("bestPlayWithLeave", () => {
  const lv = (l: W.Counts): number => 0.3 * W.tileValue(l) - 2 * (l[16]! + l[25]!) + 3 * Math.min(l[18]!, 1);
  for (const n of [7, 12, 20]) {
    const rs = racks(n, Math.min(N, 150));
    const ts: number[] = [];
    let comp = 0;
    let ev = 0;
    for (const r of rs) {
      const [res, t] = time(() => W.bestPlayWithLeave(r, lv));
      ts.push(t);
      if (res.complete) comp++;
      ev += res.evals;
    }
    console.log(`bestPlayWithLeave n=${String(n).padStart(2)}  ${stats(ts)}  complete ${((100 * comp) / rs.length).toFixed(0)}%  mean evals ${(ev / rs.length).toFixed(0)}`);
  }
});
section("completion", () => {
  for (const n of [7, 12, 20]) {
    const rs = racks(n, N);
    console.log(`completionTables n=${String(n).padStart(2)} ${stats(rs.map((r) => time(() => W.completionTables(r, [4, 5, 7]))[1]))}`);
    console.log(`minMissing(7+)   n=${String(n).padStart(2)} ${stats(rs.map((r) => time(() => W.minMissing(r, { minLen: 7 }))[1]))}`);
    console.log(`nearWords(7-8,1) n=${String(n).padStart(2)} ${stats(rs.map((r) => time(() => W.nearWords(r, { minLen: 7, maxLen: 8, maxMissing: 1, limit: 30 }))[1]))}`);
    console.log(`deficiencyHist   n=${String(n).padStart(2)} ${stats(rs.map((r) => time(() => W.deficiencyHistogram(r, { minLen: 7, maxK: 3 }))[1]))}`);
  }
});
section("marginal", () => {
  for (const n of [7, 12, 20]) {
    const rs = racks(n, Math.min(N, 60));
    W.clearPartitionCache();
    console.log(`marginalLetterGains(5ms) n=${String(n).padStart(2)} cold ${stats(rs.map((r) => time(() => W.marginalLetterGains(r))[1]))}`);
    console.log(`marginalLetterGains(5ms) n=${String(n).padStart(2)} warm ${stats(rs.map((r) => time(() => W.marginalLetterGains(r))[1]))}`);
  }
});
