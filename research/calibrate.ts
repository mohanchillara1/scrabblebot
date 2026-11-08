// Calibration driver: runs the opponent models against each other in the real simulator engine (src/sim/engine.ts,
// read-only use) and prints simulated market + per-model statistics next to the OBSERVED ones in
// research/data/targets.json (computed from the 534 six-real-bot matches by research/targets.py).
//
//   nice -n 19 npx tsx research/calibrate.ts --matches 600 --seed 1 [--mix botShare|seatShare|a,b,c,d,e,f]
//        [--set model.param=value,model.param=value] [--json out.json]
//
// One process, no workers (laptop rule). 600 matches takes well under a minute.

import { readFileSync, writeFileSync } from "node:fs";
import { setPriority } from "node:os";
import { runMatch, type EngineEvent, type Participant } from "../src/sim/engine.js";
import { PARAMS, makeOpponent, sampleField, type OpponentParams } from "../src/models/opponents.js";

try { setPriority(0, 19); } catch { /* ignore */ }

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const matches = Number(arg("matches", "600"));
const seed = Number(arg("seed", "1"));
const mix = arg("mix", "botShare")!;
const sets = arg("set");
const jsonOut = arg("json");
if (sets) {
  for (const kv of sets.split(",")) {
    const [lhs, rhs] = kv.split("=");
    const [model, param] = lhs!.split(".");
    for (const mname of model === "*" ? Object.keys(PARAMS) : [model!]) {
      const cur = (PARAMS[mname] as unknown as Record<string, unknown>)[param!];
      if (cur === undefined) throw new Error(`unknown param ${lhs}`);
      (PARAMS[mname] as unknown as Record<string, unknown>)[param!] = Number(rhs);
    }
  }
}

const VAL: Record<string, number> = {};
for (const c of "AEIOULNSTR") VAL[c] = 1;
for (const c of "DG") VAL[c] = 2;
for (const c of "BCMP") VAL[c] = 3;
for (const c of "FHVWY") VAL[c] = 4;
VAL["K"] = 5; VAL["J"] = 8; VAL["X"] = 8; VAL["Q"] = 10; VAL["Z"] = 10;
const CLASSES = [1, 2, 3, 4, 5, 8, 10];

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]!; };

interface ModelAcc {
  seats: number;
  score: number[];
  won: number[];
  paid: number[];
  bal: number[];
  words: number[];
  main: number[];
  dump: number[];
  lens: number[];
  rounds: number[];
  first7: number[];
  v1win: number[];
  v1paid: number[];
  tiles: number[];
  tval: number[];
  rew: number[];
  rew7: number[];
  hi: number[];
  bins: number[][];
}
const acc: Record<string, ModelAcc> = {};
const mk = (): ModelAcc => ({ seats: 0, score: [], won: [], paid: [], bal: [], words: [], main: [], dump: [], lens: [], rounds: [], first7: [], v1win: [], v1paid: [], tiles: [], tval: [], rew: [], rew7: [], hi: [], bins: [] });

const mktPaid: Record<number, number[]> = {};
const mktTop: Record<number, number[]> = {};
for (const c of CLASSES) { mktPaid[c] = []; mktTop[c] = []; }
const phasePaid: number[][] = [[], [], []];
let unsold = 0, auctions = 0;
const winnerScores: number[] = [];
const allScores: number[] = [];

const rngMix = mulberry32(seed * 7919 + 13);
const t0 = Date.now();
for (let m = 0; m < matches; m++) {
  const names = mix === "botShare" || mix === "seatShare" ? sampleField(6, rngMix, mix) : mix.split(",").map((s) => s.trim());
  const parts: Participant[] = names.map((n, i) => ({ kind: "real", name: n, strategy: makeOpponent(n, seed * 1000 + m * 10 + i) }));
  const rec = names.map(() => ({ bins: new Array<number>(9).fill(0), tiles: 0, rew: 0, tvals: [] as number[], won: 0, paid: 0, words: 0, main: 0, dump: 0, lens: [] as number[], rews7: [] as number[], rounds: [] as number[], first7: -1, v1win: [] as number[], v1paid: [] as number[] }));
  const onEvent = (e: EngineEvent) => {
    if (e.type === "close") {
      auctions++;
      if (e.winnerSeat < 0) { unsold++; return; }
      if (e.round >= 68) return; // last auction: letter worthless; excluded like the observed stats
      const v = VAL[e.letter]!;
      mktPaid[v]!.push(e.paid); mktTop[v]!.push(e.topBid);
      phasePaid[e.round <= 23 ? 0 : e.round <= 46 ? 1 : 2]!.push(e.paid);
      if (e.received) {
        const r = rec[e.winnerSeat]!;
        r.won++; r.paid += e.paid; r.tvals.push(v); r.bins[Math.floor((e.round - 1) / 8)]!++;
        if (v === 1) { r.v1win.push(e.topBid); r.v1paid.push(e.paid); }
      }
    } else if (e.type === "word") {
      const r = rec[e.seat]!;
      const pyRound = e.round - 1; // python analysis counts auctions already closed
      r.words++; r.tiles += e.word.length; r.rew += e.reward; if (e.word.length === 7) r.rews7.push(e.reward);
      if (pyRound <= 64) r.main++; else r.dump++;
      r.lens.push(e.word.length); r.rounds.push(pyRound);
      if (e.word.length >= 7 && r.first7 < 0) r.first7 = pyRound;
    }
  };
  const res = runMatch(parts, { auctionType: "Vickrey", seed, matchIndex: m, onEvent });
  const sc = res.seats.map((s) => s.score);
  winnerScores.push(Math.max(...sc));
  for (const s of sc) allScores.push(s);
  res.seats.forEach((s, i) => {
    const a = (acc[names[i]!] ??= mk());
    const r = rec[i]!;
    a.seats++; a.score.push(s.score); a.won.push(r.won); a.paid.push(r.paid); a.bal.push(s.balance);
    a.words.push(r.words); a.main.push(r.main); a.dump.push(r.dump);
    a.lens.push(...r.lens); a.rounds.push(...r.rounds);
    if (r.first7 >= 0) a.first7.push(r.first7);
    a.v1win.push(...r.v1win); a.v1paid.push(...r.v1paid); a.tiles.push(r.tiles); a.rew.push(r.rew); a.bins.push(r.bins); a.tval.push(...r.tvals); a.rew7.push(...r.rews7); a.hi.push(...r.tvals.map((t) => (t >= 4 ? 1 : 0)));
  });
}
const secs = (Date.now() - t0) / 1000;
const targets = JSON.parse(readFileSync(new URL("./data/targets.json", import.meta.url), "utf8")) as Record<string, Record<string, number>>;

const f = (x: number | undefined, d = 1) => (x === undefined || Number.isNaN(x) ? "  -  " : x.toFixed(d));
console.log(`# calibrate: ${matches} matches, seed ${seed}, mix ${mix}, ${secs.toFixed(1)} s (${(matches / secs).toFixed(0)} matches/s)`);
console.log(`field: winner score ${f(mean(winnerScores))} (se ${f(sd(winnerScores) / Math.sqrt(winnerScores.length))}) vs observed all-real 115.8 (se 1.0); mean seat score ${f(mean(allScores))} vs 71.1; unsold ${(100 * unsold / auctions).toFixed(2)}% vs ~0.9% (incl. the last auction, 56.7% unsold there)`);
console.log("\nMARKET (rounds 1-67, sold letters)   class: sim paid / observed paid | sim top / observed top");
const obsPaid: Record<number, number> = { 1: 10.35, 2: 12.45, 3: 15.3, 4: 17.4, 5: 21.05, 8: 25.1, 10: 25.2 };
const obsTop: Record<number, number> = { 1: 14.2, 2: 16.5, 3: 19.7, 4: 22.6, 5: 26.8, 8: 32.3, 10: 35.0 };
for (const c of CLASSES) console.log(`  v${String(c).padEnd(2)} n=${String(mktPaid[c]!.length).padStart(6)}  paid ${f(mean(mktPaid[c]!), 2).padStart(6)} / ${obsPaid[c]!.toFixed(2).padStart(6)}   top ${f(mean(mktTop[c]!), 2).padStart(6)} / ${obsTop[c]!.toFixed(2).padStart(6)}`);
console.log(`  phase mean paid early/mid/late: ${phasePaid.map((p) => f(mean(p), 2)).join(" / ")}  (observed 13.14 / 12.23 / 11.71)`);

console.log("\nPER MODEL   (sim | observed cluster)");
const keys = ["score", "letters", "px", "spent", "bal_end", "words", "main", "dump", "avg_len", "len7+", "med_round", ">r34", ">=r58", "first7", "v1win", "v1paid", "tval", "tiles", "rew/tile", "rew7", "hi%"];
console.log("model".padEnd(14) + keys.map((k) => k.padStart(13)).join(""));
for (const [name, a] of Object.entries(acc)) {
  const tgt = targets[name];
  const totalWon = a.won.reduce((x, y) => x + y, 0);
  const sim: Record<string, number> = {
    score: mean(a.score), letters: mean(a.won), px: a.paid.reduce((x, y) => x + y, 0) / Math.max(1, totalWon), spent: mean(a.paid), bal_end: mean(a.bal),
    words: mean(a.words), main: mean(a.main), dump: mean(a.dump), avg_len: mean(a.lens), "len7+": mean(a.lens.map((l) => (l >= 7 ? 1 : 0))),
    med_round: median(a.rounds), ">r34": mean(a.rounds.map((r) => (r > 34 ? 1 : 0))), ">=r58": mean(a.rounds.map((r) => (r >= 58 ? 1 : 0))),
    first7: median(a.first7), v1win: mean(a.v1win), v1paid: mean(a.v1paid), tval: mean(a.tval), tiles: mean(a.tiles), "rew/tile": a.rew.reduce((x, y) => x + y, 0) / Math.max(1, a.tiles.reduce((x, y) => x + y, 0)), rew7: mean(a.rew7), "hi%": 100 * mean(a.hi),
  };
  const ob: Record<string, number | undefined> = tgt ? {
    score: tgt["score"], letters: tgt["letters_won"], px: tgt["px"], spent: tgt["spent"], bal_end: tgt["bal_end"], words: tgt["words"], main: tgt["main_plays"], dump: tgt["dump_plays"],
    avg_len: tgt["avg_len"], "len7+": tgt["len7plus"], med_round: tgt["play_round_median"], ">r34": tgt["play_frac_after_r34"], ">=r58": tgt["play_frac_r58plus"], first7: tgt["first7_round_median"], v1win: tgt["v1_winbid"], v1paid: tgt["v1_paid"], tval: tgt["tile_value_won"], tiles: tgt["tiles_played"], "rew/tile": tgt["reward_per_tile"], rew7: tgt["rew7"], "hi%": tgt["hi_share"] === undefined ? undefined : 100 * tgt["hi_share"],
  } : {};
  const dig: Record<string, number> = { score: 1, letters: 1, px: 1, spent: 0, bal_end: 0, words: 2, main: 2, dump: 2, avg_len: 2, "len7+": 2, med_round: 0, ">r34": 2, ">=r58": 2, first7: 0, v1win: 1, v1paid: 1, tval: 2, tiles: 1, "rew/tile": 2, rew7: 1, "hi%": 1 };
  console.log(`${name.padEnd(14)}${keys.map((k) => f(sim[k], dig[k]!).padStart(13)).join("")}   n=${a.seats} score se ${f(sd(a.score) / Math.sqrt(a.seats))} sd ${f(sd(a.score))}`);
  console.log(`${"  observed".padEnd(14)}${keys.map((k) => f(ob[k], dig[k]!).padStart(13)).join("")}`);
  console.log(`${"  wins/8rd".padEnd(14)}` + Array.from({ length: 9 }, (_, b) => mean(a.bins.map((x) => x[b]!)).toFixed(2)).join(" "));
  const hist: Record<number, number> = {};
  for (const l of a.lens) hist[l] = (hist[l] ?? 0) + 1;
  const tl = a.lens.length;
  console.log(`${"  len hist".padEnd(14)}` + Object.keys(hist).map(Number).sort((x, y) => x - y).map((l) => `${l}:${(hist[l]! / a.seats).toFixed(2)}`).join(" "));
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ matches, seed, mix, market: { paid: Object.fromEntries(CLASSES.map((c) => [c, mean(mktPaid[c]!)])), top: Object.fromEntries(CLASSES.map((c) => [c, mean(mktTop[c]!)])) } }, null, 1));
