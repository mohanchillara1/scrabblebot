// Robustness + latency stress for the candidate strategies (council-robustness).
//
//   STRESS_STRAT=tuned STRESS_PART=synthetic nice -n 19 timeout 200 npx tsx src/sim/stress_robustness.test.ts
//   STRESS_STRAT=tuned STRESS_PART=engine    nice -n 19 timeout 200 npx tsx src/sim/stress_robustness.test.ts
//
// PART=synthetic: direct words()/bid() calls on hand-built MatchViews (balance 0, empty rack, 25-30 tile racks,
//   EEEEEEE, Q without U, 2 and 12 players, FirstPrice, opponent holding all the cash, bag exhausted, over-counted
//   history, ...). Every returned word must be in the dictionary and spellable from the rack, every bid an integer
//   in [0, balance], nothing may throw, and every call is timed (p50 / p99 / max).
// PART=engine: full simulated matches through src/sim/engine.ts at unusual configs (rack 0, 8, 20; 2 and 12
//   players; 250 ms auctions; FirstPrice) with each call timed by a wrapper.
// Prints a table, writes sim-out/stress/<strat>-<part>.json, and exits non-zero if any must-fix condition occurred.
import { mkdirSync, writeFileSync } from "node:fs";
import { setPriority } from "node:os";
import type { AuctionRecord, AuctionType, MatchView, PlayerPublic, Strategy, WordRecord } from "../core/types.js";
import { DEFAULT_BAG, wordReward } from "./dict.js";
import { type Participant, runMatch } from "./engine.js";
import { mulberry32 } from "./rng.js";
import { loadRegistry, instantiate } from "./registry.js";
import * as W from "../engine/words.js";

try {
  setPriority(0, 19);
} catch {
  /* ignore */
}

const LIMIT_MS = 100;

interface Lat {
  bid: number[];
  words: number[];
}
interface Problem {
  scenario: string;
  kind: string;
  detail: string;
}

function pct(a: number[], p: number): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}
function stats(a: number[]) {
  return { n: a.length, p50: pct(a, 0.5), p99: pct(a, 0.99), max: a.length ? Math.max(...a) : 0 };
}

// ---------- synthetic views ----------

const BAG: string[] = [];
for (const [l, n] of DEFAULT_BAG) for (let i = 0; i < n; i++) BAG.push(l);

function drawRack(rng: () => number, n: number): Map<string, number> {
  const pool = [...BAG];
  const m = new Map<string, number>();
  for (let i = 0; i < n && pool.length; i++) {
    const j = Math.floor(rng() * pool.length);
    const l = pool.splice(j, 1)[0]!;
    m.set(l, (m.get(l) ?? 0) + 1);
  }
  return m;
}
function rackOf(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of s) m.set(c, (m.get(c) ?? 0) + 1);
  return m;
}

interface Scn {
  name: string;
  players: number;
  type: AuctionType;
  dur?: number;
  startRack?: number;
  rack: (rng: () => number) => Map<string, number>;
  balance: number;
  score?: number;
  round: number;
  bagRemaining: number;
  histLen: number; // synthetic auction history length
  histOvercount?: boolean; // history letters ignore the bag limits (all E)
  oppBalances?: (i: number) => number; // opponent i (1-based among others)
  letters: string[];
  wordHist?: boolean;
}

function buildHistory(rng: () => number, n: number, players: number, over: boolean): AuctionRecord[] {
  const out: AuctionRecord[] = [];
  const pool = [...BAG];
  for (let i = 0; i < n; i++) {
    let letter: string;
    if (over) letter = "E";
    else {
      const j = Math.floor(rng() * pool.length);
      letter = pool.splice(j, 1)[0] ?? "A";
    }
    const winner = rng() < 0.12 ? null : 1 + Math.floor(rng() * players); // bot ids 1..players ; me = 1
    out.push({ round: i + 1, letter, winnerBotId: winner, paid: winner === null ? 0 : 1 + Math.floor(rng() * 20) });
  }
  return out;
}

function mkView(s: Scn, rng: () => number, rack: Map<string, number>): MatchView {
  const players: PlayerPublic[] = [];
  for (let i = 0; i < s.players; i++) {
    const bal = i === 0 ? s.balance : s.oppBalances ? s.oppBalances(i) : 60 + Math.floor(rng() * 40);
    players.push({ botId: i + 1, balance: bal, score: i === 0 ? (s.score ?? 0) : Math.floor(rng() * 80), isSim: false });
  }
  const wordHistory: WordRecord[] = [];
  return {
    matchId: 1,
    myBotId: 1,
    auctionType: s.type,
    auctionDurationMs: s.dur ?? 1000,
    startingRackSize: s.startRack ?? 5,
    players,
    myRack: new Map(rack),
    myBalance: s.balance,
    myScore: s.score ?? 0,
    round: s.round,
    bagRemaining: s.bagRemaining,
    auctionHistory: buildHistory(rng, s.histLen, s.players, !!s.histOvercount),
    wordHistory,
  };
}

const V = ["Vickrey", "FirstPrice"] as const;
const rnd = (n: number) => (rng: () => number) => drawRack(rng, n);

function scenarios(): Scn[] {
  const L = ["E", "S", "Q", "Z", "A"];
  const out: Scn[] = [];
  for (const type of V) {
    const t = type === "Vickrey" ? "V" : "FP";
    const base = { type, players: 6, letters: L };
    out.push({ ...base, name: `${t} balance0 rack5 r20`, rack: rnd(5), balance: 0, round: 20, bagRemaining: 50, histLen: 19 });
    out.push({ ...base, name: `${t} balance1 rack5 r20`, rack: rnd(5), balance: 1, round: 20, bagRemaining: 50, histLen: 19 });
    out.push({ ...base, name: `${t} emptyRack r1 bal100`, rack: rnd(0), balance: 100, round: 1, bagRemaining: 97, histLen: 0, startRack: 0 });
    out.push({ ...base, name: `${t} emptyRack r30 bal60`, rack: rnd(0), balance: 60, round: 30, bagRemaining: 40, histLen: 29 });
    out.push({ ...base, name: `${t} rack25 bal40 r30`, rack: rnd(25), balance: 40, round: 30, bagRemaining: 40, histLen: 29 });
    out.push({ ...base, name: `${t} rack30 bal100 r10`, rack: rnd(30), balance: 100, round: 10, bagRemaining: 55, histLen: 9 });
    out.push({ ...base, name: `${t} rack20 start r1 (2p)`, players: 2, rack: rnd(20), balance: 100, round: 1, bagRemaining: 57, histLen: 0, startRack: 20 });
    out.push({ ...base, name: `${t} rack20 start r1 (4p)`, players: 4, rack: rnd(20), balance: 100, round: 1, bagRemaining: 17, histLen: 0, startRack: 20 });
    out.push({ ...base, name: `${t} rack0 start r1 (6p)`, rack: rnd(0), balance: 100, round: 1, bagRemaining: 97, histLen: 0, startRack: 0 });
    out.push({ ...base, name: `${t} 2p mid`, players: 2, rack: rnd(8), balance: 70, round: 25, bagRemaining: 60, histLen: 24 });
    out.push({ ...base, name: `${t} 12p r1`, players: 12, rack: rnd(5), balance: 100, round: 1, bagRemaining: 37, histLen: 0 });
    out.push({ ...base, name: `${t} 12p mid`, players: 12, rack: rnd(7), balance: 50, round: 18, bagRemaining: 20, histLen: 17 });
    out.push({ ...base, name: `${t} dur250 mid`, dur: 250, rack: rnd(8), balance: 80, round: 30, bagRemaining: 40, histLen: 29 });
    out.push({ ...base, name: `${t} oppAllCash`, rack: rnd(6), balance: 100, round: 25, bagRemaining: 45, histLen: 24, oppBalances: (i) => (i === 1 ? 5000 : 0) });
    out.push({ ...base, name: `${t} EEEEEEE`, rack: () => rackOf("EEEEEEE"), balance: 80, round: 25, bagRemaining: 45, histLen: 24 });
    out.push({ ...base, name: `${t} EEEEEEEEEEEE x12`, rack: () => rackOf("EEEEEEEEEEEE"), balance: 80, round: 25, bagRemaining: 45, histLen: 24 });
    out.push({ ...base, name: `${t} Q-no-U`, rack: () => rackOf("QQZXJKV"), balance: 80, round: 25, bagRemaining: 45, histLen: 24 });
    out.push({ ...base, name: `${t} all-consonant`, rack: () => rackOf("BCDFGHJKLMNP"), balance: 80, round: 25, bagRemaining: 45, histLen: 24 });
    out.push({ ...base, name: `${t} all-vowel`, rack: () => rackOf("AEIOUAEIOU"), balance: 80, round: 25, bagRemaining: 45, histLen: 24 });
    out.push({ ...base, name: `${t} bagRemaining0 (last)`, rack: rnd(12), balance: 30, round: 68, bagRemaining: 0, histLen: 67 });
    out.push({ ...base, name: `${t} bagRemaining1`, rack: rnd(10), balance: 30, round: 67, bagRemaining: 1, histLen: 66 });
    out.push({ ...base, name: `${t} bagRemaining0 rack30`, rack: rnd(30), balance: 0, round: 68, bagRemaining: 0, histLen: 67 });
    out.push({ ...base, name: `${t} bag97 early rack5`, rack: rnd(5), balance: 100, round: 1, bagRemaining: 97, histLen: 0 });
    out.push({ ...base, name: `${t} history overcount (E x40)`, rack: rnd(6), balance: 80, round: 41, bagRemaining: 30, histLen: 40, histOvercount: true });
    out.push({ ...base, name: `${t} round90 history 90`, rack: rnd(6), balance: 80, round: 91, bagRemaining: 5, histLen: 90 });
    out.push({ ...base, name: `${t} late-joiner r40 empty history`, rack: rnd(9), balance: 55, round: 40, bagRemaining: 30, histLen: 0 });
    out.push({ ...base, name: `${t} late-joiner r40 hist 10`, rack: rnd(9), balance: 55, round: 40, bagRemaining: 30, histLen: 10 });
    out.push({ ...base, name: `${t} huge balance 100000`, rack: rnd(6), balance: 100000, round: 25, bagRemaining: 45, histLen: 24 });
  }
  return out;
}

// ---------- validation ----------

function validateWords(rack: Map<string, number>, ws: unknown): { ok: boolean; why: string; reward: number; after: Map<string, number> } {
  const after = new Map(rack);
  if (!Array.isArray(ws)) return { ok: false, why: "not an array", reward: 0, after };
  let reward = 0;
  for (const w of ws) {
    if (typeof w !== "string") return { ok: false, why: `non-string ${String(w)}`, reward, after };
    const u = w.toUpperCase();
    if (u.length < 2 || !/^[A-Z]+$/.test(u)) return { ok: false, why: `bad format "${w}"`, reward, after };
    if (!W.isWord(u)) return { ok: false, why: `not in dictionary "${w}"`, reward, after };
    for (const c of u) {
      const have = after.get(c) ?? 0;
      if (have <= 0) return { ok: false, why: `unspellable "${w}" from rack`, reward, after };
      after.set(c, have - 1);
    }
    reward += wordReward(u);
  }
  return { ok: true, why: "", reward, after };
}

function runSynthetic(stratName: string, make: () => Strategy, reps: number): { problems: Problem[]; lat: Lat; perScn: any[] } {
  const problems: Problem[] = [];
  const lat: Lat = { bid: [], words: [] };
  const perScn: any[] = [];
  const rng = mulberry32(12345);
  for (const s of scenarios()) {
    const sl: Lat = { bid: [], words: [] };
    for (let r = 0; r < reps; r++) {
      for (const letter of s.letters) {
        const strat = make();
        const rack = s.rack(rng);
        const v = mkView(s, rng, rack);
        try {
          if (!process.env["STRESS_NOSTART"]) strat.onMatchStart?.(v);
        } catch (e) {
          problems.push({ scenario: s.name, kind: "exception onMatchStart", detail: String(e) });
        }
        // words
        let ws: string[] = [];
        let t0 = performance.now();
        try {
          ws = strat.words(v);
        } catch (e) {
          problems.push({ scenario: s.name, kind: "exception words()", detail: String((e as Error)?.stack ?? e).slice(0, 300) });
        }
        const wms = performance.now() - t0;
        sl.words.push(wms);
        const vw = validateWords(rack, ws);
        if (!vw.ok) problems.push({ scenario: s.name, kind: "invalid words()", detail: `${vw.why} rack=${[...rack].map(([k, c]) => k.repeat(c)).join("")}` });
        if (wms > LIMIT_MS) problems.push({ scenario: s.name, kind: `slow words() ${wms.toFixed(0)}ms`, detail: "" });
        // apply plays as the engine does (reward credited to balance and score before bid)
        const v2: MatchView = { ...v, myRack: vw.ok ? vw.after : new Map(rack), myBalance: v.myBalance + (vw.ok ? vw.reward : 0), myScore: v.myScore + (vw.ok ? vw.reward : 0) };
        v2.players = v.players.map((p, i) => (i === 0 ? { ...p, balance: v2.myBalance, score: v2.myScore } : p));
        // bid
        let b: unknown = 0;
        t0 = performance.now();
        try {
          b = strat.bid(v2, letter);
        } catch (e) {
          problems.push({ scenario: s.name, kind: "exception bid()", detail: String((e as Error)?.stack ?? e).slice(0, 300) });
        }
        const bms = performance.now() - t0;
        sl.bid.push(bms);
        if (typeof b !== "number" || !Number.isInteger(b) || b < 0) problems.push({ scenario: s.name, kind: "malformed bid", detail: `letter ${letter} -> ${String(b)}` });
        else if (b > v2.myBalance) problems.push({ scenario: s.name, kind: "over-balance bid", detail: `letter ${letter} bid ${b} > balance ${v2.myBalance}` });
        else if (v2.bagRemaining === 0 && b > 0) problems.push({ scenario: s.name, kind: "note: positive bid on last (worthless) auction", detail: `${b}` });
        if (bms > LIMIT_MS) problems.push({ scenario: s.name, kind: `slow bid() ${bms.toFixed(0)}ms`, detail: `letter ${letter}` });
        // also feed a result back, then bid again (state path)
        try {
          strat.onAuctionResult?.(v2, { round: v2.round, letter, winnerBotId: null, paid: 0 });
        } catch (e) {
          problems.push({ scenario: s.name, kind: "exception onAuctionResult", detail: String(e).slice(0, 200) });
        }
      }
    }
    lat.bid.push(...sl.bid);
    lat.words.push(...sl.words);
    perScn.push({ scenario: s.name, bid: stats(sl.bid), words: stats(sl.words) });
  }
  return { problems, lat, perScn };
}

// ---------- engine configs ----------

interface Cfg {
  name: string;
  players: number;
  rack: number;
  type: AuctionType;
  dur: number;
  matches: number;
}
const ENGINE_CFGS: Cfg[] = [
  { name: "rack0 6p V", players: 6, rack: 0, type: "Vickrey", dur: 1000, matches: 2 },
  { name: "rack0 2p FP", players: 2, rack: 0, type: "FirstPrice", dur: 1000, matches: 1 },
  { name: "rack8 6p V", players: 6, rack: 8, type: "Vickrey", dur: 1000, matches: 2 },
  { name: "rack20 2p V", players: 2, rack: 20, type: "Vickrey", dur: 1000, matches: 3 },
  { name: "rack20 4p FP", players: 4, rack: 20, type: "FirstPrice", dur: 1000, matches: 3 },
  { name: "rack15 6p V", players: 6, rack: 15, type: "Vickrey", dur: 1000, matches: 2 },
  { name: "2p V", players: 2, rack: 5, type: "Vickrey", dur: 1000, matches: 3 },
  { name: "2p FP", players: 2, rack: 5, type: "FirstPrice", dur: 1000, matches: 3 },
  { name: "12p V", players: 12, rack: 5, type: "Vickrey", dur: 1000, matches: 3 },
  { name: "12p FP", players: 12, rack: 5, type: "FirstPrice", dur: 1000, matches: 3 },
  { name: "6p V dur250", players: 6, rack: 5, type: "Vickrey", dur: 250, matches: 3 },
  { name: "6p FP dur250", players: 6, rack: 5, type: "FirstPrice", dur: 250, matches: 3 },
];

function wrap(s: Strategy, lat: Lat): Strategy {
  return {
    name: s.name,
    onMatchStart: s.onMatchStart?.bind(s),
    onAuctionResult: s.onAuctionResult?.bind(s),
    words(v) {
      const t = performance.now();
      try {
        return s.words(v);
      } finally {
        lat.words.push(performance.now() - t);
      }
    },
    bid(v, l) {
      const t = performance.now();
      try {
        return s.bid(v, l);
      } finally {
        lat.bid.push(performance.now() - t);
      }
    },
  };
}

async function runEngine(stratName: string): Promise<{ problems: Problem[]; lat: Lat; perScn: any[] }> {
  const reg = await loadRegistry();
  const mine = reg.entries.get(stratName)!;
  const opp = reg.entries.get("topbot-like")!;
  const problems: Problem[] = [];
  const lat: Lat = { bid: [], words: [] };
  const perScn: any[] = [];
  const t0 = Date.now();
  for (const c of ENGINE_CFGS) {
    if (Date.now() - t0 > 150000) {
      perScn.push({ scenario: c.name, skipped: "time budget" });
      continue;
    }
    const sl: Lat = { bid: [], words: [] };
    const scores: number[] = [];
    const places: number[] = [];
    for (let m = 0; m < c.matches; m++) {
      const parts: Participant[] = [{ kind: "real", name: stratName, strategy: wrap(instantiate(mine, m + 1), sl) }];
      for (let i = 1; i < c.players; i++) {
        // mix: mostly topbot-like, a couple of sim bots so the seat set is heterogeneous
        if (i % 3 === 0) parts.push({ kind: "sim", name: "sim", tag: i % 2 ? "Aggressive" : "ValueBidder" });
        else parts.push({ kind: "real", name: "topbot-like", strategy: instantiate(opp, 100 + i + m) });
      }
      try {
        const res = runMatch(parts, { auctionType: c.type, startingRackSize: c.rack, auctionDurationMs: c.dur, seed: 777, matchIndex: m });
        const me = res.seats[0]!;
        scores.push(me.score);
        places.push(me.place);
        const e = me.errors;
        const tot = e.invalidWords + e.unspellableWords + e.overBalanceBids + e.badBids + e.badReturns + e.exceptions;
        if (tot > 0) problems.push({ scenario: c.name, kind: "engine errors", detail: JSON.stringify(e) });
      } catch (err) {
        problems.push({ scenario: c.name, kind: "match threw", detail: String((err as Error)?.stack ?? err).slice(0, 300) });
      }
    }
    const b = stats(sl.bid);
    const w = stats(sl.words);
    if (b.max > LIMIT_MS) problems.push({ scenario: c.name, kind: `slow bid() max ${b.max.toFixed(0)}ms`, detail: "" });
    if (w.max > LIMIT_MS) problems.push({ scenario: c.name, kind: `slow words() max ${w.max.toFixed(0)}ms`, detail: "" });
    lat.bid.push(...sl.bid);
    lat.words.push(...sl.words);
    perScn.push({ scenario: c.name, bid: b, words: w, meanScore: scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length), meanPlace: places.reduce((a, b) => a + b, 0) / Math.max(1, places.length) });
  }
  return { problems, lat, perScn };
}

// ---------- reuse: one instance across several matches, and interleaved matches ----------

async function runReuse(stratName: string): Promise<{ problems: Problem[]; lat: Lat; perScn: any[] }> {
  const reg = await loadRegistry();
  const mine = reg.entries.get(stratName)!;
  const opp = reg.entries.get("topbot-like")!;
  const problems: Problem[] = [];
  const lat: Lat = { bid: [], words: [] };
  const perScn: any[] = [];
  // (a) a single instance across 4 sequential engine matches (as the live process does)
  const shared = wrap(instantiate(mine, 1), lat);
  const scores: number[] = [];
  for (let m = 0; m < 4; m++) {
    const parts: Participant[] = [{ kind: "real", name: stratName, strategy: shared }];
    for (let i = 1; i < 6; i++) parts.push({ kind: "real", name: "topbot-like", strategy: instantiate(opp, 50 + i + m) });
    try {
      const res = runMatch(parts, { auctionType: m % 2 ? "FirstPrice" : "Vickrey", seed: 31, matchIndex: m, matchId: 1000 + m });
      scores.push(res.seats[0]!.score);
      const e = res.seats[0]!.errors;
      const tot = e.invalidWords + e.unspellableWords + e.overBalanceBids + e.badBids + e.badReturns + e.exceptions;
      if (tot > 0) problems.push({ scenario: "shared instance, sequential matches", kind: "engine errors", detail: JSON.stringify(e) });
    } catch (err) {
      problems.push({ scenario: "shared instance", kind: "match threw", detail: String(err).slice(0, 300) });
    }
  }
  perScn.push({ scenario: "shared instance x4 matches", bid: stats(lat.bid), words: stats(lat.words), meanScore: scores.reduce((a, b) => a + b, 0) / scores.length, meanPlace: 0 });
  // (b) interleaved calls for two different matchIds on one instance (A,B,A,B,...)
  const strat = instantiate(mine, 2);
  const rng = mulberry32(99);
  const scn: Scn = { name: "interleaved", players: 6, type: "Vickrey", rack: rnd(7), balance: 70, round: 30, bagRemaining: 40, histLen: 29, letters: ["E"] };
  const il: Lat = { bid: [], words: [] };
  for (let k = 0; k < 40; k++) {
    const rack = scn.rack(rng);
    const v = mkView({ ...scn, round: 20 + k }, rng, rack);
    v.matchId = k % 2 ? 7 : 8;
    if (k < 2) strat.onMatchStart?.(v);
    try {
      let t = performance.now();
      const ws = strat.words(v);
      il.words.push(performance.now() - t);
      const vw = validateWords(rack, ws);
      if (!vw.ok) problems.push({ scenario: "interleaved matchIds", kind: "invalid words()", detail: vw.why });
      t = performance.now();
      const b = strat.bid({ ...v, myRack: vw.ok ? vw.after : v.myRack, myBalance: v.myBalance + vw.reward }, "S");
      il.bid.push(performance.now() - t);
      if (!Number.isInteger(b) || b < 0 || b > v.myBalance + vw.reward) problems.push({ scenario: "interleaved matchIds", kind: "bad bid", detail: String(b) });
    } catch (e) {
      problems.push({ scenario: "interleaved matchIds", kind: "exception", detail: String((e as Error)?.stack ?? e).slice(0, 300) });
    }
  }
  perScn.push({ scenario: "interleaved matchIds x40", bid: stats(il.bid), words: stats(il.words) });
  lat.bid.push(...il.bid);
  lat.words.push(...il.words);
  return { problems, lat, perScn };
}

// ---------- worst-case latency: anagram-rich racks of 18-30 tiles ----------

function runWorst(make: () => Strategy): { problems: Problem[]; lat: Lat; perScn: any[] } {
  const problems: Problem[] = [];
  const lat: Lat = { bid: [], words: [] };
  const perScn: any[] = [];
  const racks: [string, string][] = [
    ["AEINRST x3 (21)", "AEINRSTAEINRSTAEINRST"],
    ["AEINRST x4 (28)", "AEINRSTAEINRSTAEINRSTAEINRST"],
    ["common mix 30", "AEEIOLNRSTDGUAEILNRSTBCMPOE"],
    ["ERSTLNAIDO x3 (30)", "ERSTLNAIDOERSTLNAIDOERSTLNAIDO"],
    ["varied consonants 25", "BCDFGHJKLMNPRSTVWXYZAEIOU"],
  ];
  for (const type of V) for (const bagRemaining of [0, 3, 40]) for (const [name, r] of racks) {
    const s: Scn = { name: `${type} ${name} bag${bagRemaining}`, players: 6, type, rack: () => rackOf(r), balance: 90, round: 30, bagRemaining, histLen: 29, letters: ["E", "S", "Z"] };
    const rng = mulberry32(5);
    const sl: Lat = { bid: [], words: [] };
    for (let rep = 0; rep < 6; rep++) for (const letter of s.letters) {
      const strat = make();
      const rack = s.rack(rng);
      const v = mkView(s, rng, rack);
      strat.onMatchStart?.(v);
      let t = performance.now();
      let ws: string[] = [];
      try { ws = strat.words(v); } catch (e) { problems.push({ scenario: s.name, kind: "exception words()", detail: String(e).slice(0, 200) }); }
      sl.words.push(performance.now() - t);
      const vw = validateWords(rack, ws);
      if (!vw.ok) problems.push({ scenario: s.name, kind: "invalid words()", detail: vw.why });
      const v2: MatchView = { ...v, myRack: vw.ok ? vw.after : new Map(rack), myBalance: v.myBalance + (vw.ok ? vw.reward : 0) };
      t = performance.now();
      let b = 0;
      try { b = strat.bid(v2, letter); } catch (e) { problems.push({ scenario: s.name, kind: "exception bid()", detail: String(e).slice(0, 200) }); }
      sl.bid.push(performance.now() - t);
      if (!Number.isInteger(b) || b < 0 || b > v2.myBalance) problems.push({ scenario: s.name, kind: "bad bid", detail: String(b) });
    }
    if (Math.max(...sl.words) > LIMIT_MS) problems.push({ scenario: s.name, kind: `slow words() ${Math.max(...sl.words).toFixed(0)}ms`, detail: "" });
    if (Math.max(...sl.bid) > LIMIT_MS) problems.push({ scenario: s.name, kind: `slow bid() ${Math.max(...sl.bid).toFixed(0)}ms`, detail: "" });
    lat.bid.push(...sl.bid);
    lat.words.push(...sl.words);
    perScn.push({ scenario: s.name, bid: stats(sl.bid), words: stats(sl.words) });
  }
  return { problems, lat, perScn };
}

// ---------- cold words() cost by rack size on the final-dump path (bagRemaining 0), distinct random racks ----------

function runSizes(make: () => Strategy): { problems: Problem[]; lat: Lat; perScn: any[] } {
  const problems: Problem[] = [];
  const lat: Lat = { bid: [], words: [] };
  const perScn: any[] = [];
  const rng = mulberry32(777);
  for (const size of [10, 12, 14, 16, 18, 20, 22, 24, 27]) {
    const sl: Lat = { bid: [], words: [] };
    for (let k = 0; k < 40; k++) {
      const rack = drawRack(rng, size);
      const s: Scn = { name: `size${size}`, players: 6, type: "Vickrey", rack: () => rack, balance: 40, round: 68, bagRemaining: 0, histLen: 67, letters: ["E"] };
      const strat = make();
      const v = mkView(s, rng, rack);
      strat.onMatchStart?.(v);
      const t = performance.now();
      let ws: string[] = [];
      try { ws = strat.words(v); } catch (e) { problems.push({ scenario: s.name, kind: "exception words()", detail: String(e).slice(0, 200) }); }
      const ms = performance.now() - t;
      sl.words.push(ms);
      const vw = validateWords(rack, ws);
      if (!vw.ok) problems.push({ scenario: s.name, kind: "invalid words()", detail: vw.why });
      if (ms > LIMIT_MS) problems.push({ scenario: s.name, kind: `slow words() ${ms.toFixed(0)}ms`, detail: [...rack].map(([c, n]) => c.repeat(n)).join("") });
    }
    lat.words.push(...sl.words);
    perScn.push({ scenario: `final dump, rack ${size}, 40 distinct racks`, bid: stats([0]), words: stats(sl.words) });
  }
  return { problems, lat, perScn };
}

// ---------- main ----------

async function main() {
  const strat = process.env["STRESS_STRAT"] ?? "tuned";
  const part = process.env["STRESS_PART"] ?? "synthetic";
  const reps = Number(process.env["STRESS_REPS"] ?? 8);
  const reg = await loadRegistry();
  const entry = reg.entries.get(strat);
  if (!entry) throw new Error(`unknown strategy ${strat}`);
  W.warmUp();
  const out = part === "engine" ? await runEngine(strat) : part === "reuse" ? await runReuse(strat) : part === "worst" ? runWorst(() => instantiate(entry, 1)) : part === "sizes" ? runSizes(() => instantiate(entry, 1)) : runSynthetic(strat, () => instantiate(entry, 1), reps);
  const fmt = (s: any) => (s ? `n=${s.n} p50=${s.p50.toFixed(1)} p99=${s.p99.toFixed(1)} max=${s.max.toFixed(1)}` : "-");
  console.log(`\n=== ${strat} / ${part} ===`);
  for (const p of out.perScn) {
    if (p.skipped) console.log(`${p.scenario.padEnd(34)} SKIPPED ${p.skipped}`);
    else console.log(`${p.scenario.padEnd(34)} bid[${fmt(p.bid)}] words[${fmt(p.words)}]${p.meanScore !== undefined ? ` score=${p.meanScore.toFixed(1)} place=${p.meanPlace.toFixed(2)}` : ""}`);
  }
  console.log(`ALL bid:   ${fmt(stats(out.lat.bid))}`);
  console.log(`ALL words: ${fmt(stats(out.lat.words))}`);
  const hard = out.problems.filter((p) => !p.kind.startsWith("note:"));
  const notes = out.problems.filter((p) => p.kind.startsWith("note:"));
  console.log(`PROBLEMS: ${hard.length} (+${notes.length} notes)`);
  const seen = new Map<string, number>();
  for (const p of hard) {
    const k = `${p.scenario} | ${p.kind} | ${p.detail}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  let shown = 0;
  for (const [k, n] of seen) {
    if (shown++ >= 40) break;
    console.log(`  x${n} ${k}`);
  }
  const nk = new Map<string, number>();
  for (const p of notes) nk.set(`${p.scenario} ${p.kind}`, (nk.get(`${p.scenario} ${p.kind}`) ?? 0) + 1);
  for (const [k, n] of [...nk].slice(0, 8)) console.log(`  note x${n} ${k}`);
  mkdirSync("sim-out/stress", { recursive: true });
  writeFileSync(`sim-out/stress/${strat}-${part}${process.env["STRESS_NOSTART"] ? "-nostart" : ""}.json`, JSON.stringify({ strat, part, perScn: out.perScn, problems: out.problems.slice(0, 200) }, null, 1));
  process.exit(hard.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
