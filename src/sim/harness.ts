// Tournament harness: runs duplicate matches of test strategies against a field, with common random numbers.
//
// Design (all of it is about making strategy-vs-strategy differences measurable with few matches):
//   * Match index m under seed S fixes the bag order, the sim jitter, the tie-breaks AND the opponent line-up and
//     the test strategy's seat (seat = m mod players, so seats rotate). Every test strategy plays the SAME
//     m-th match (a "duplicate" match), so differences between test strategies are paired.
//   * Randomness inside the engine is keyed by (S, m, round) hashes, not by a shared stream, so a strategy that
//     happens to consume more randomness cannot shift the bag or the sims for anyone else.
//   * Standard errors are over matches (one observation per strategy per match; if a name sits in several seats of
//     one match - self-play - its seats are averaged first). Paired differences use the per-match difference.

import type { AuctionType } from "../core/types.js";
import {
  type MatchResult,
  type Participant,
  type SeatErrors,
  SIM_BOTS,
  makeBag,
  runMatch,
} from "./engine.js";
import { warmDictionary } from "./dict.js";
import { hash32, mulberry32, shuffleInPlace } from "./rng.js";
import { type Registry, type RegistryEntry, instantiate } from "./registry.js";

// ---------- Configuration ----------

export interface BatchConfig {
  tests: string[];
  /** lobby-sims | starters | mixed | self | field:a,b,c */
  field: string;
  matches: number;
  seed: number;
  auctionType: AuctionType;
  players: number;
  rack: number;
  /** Stop starting new matches after this many seconds (all tests always finish the current match index). */
  maxSeconds: number;
  /** Also report the opponents' own statistics under each test strategy. */
  showField: boolean;
  registry: Registry;
  onProgress?: (done: number, total: number, elapsedS: number) => void;
}

type Opp =
  | { kind: "sim"; name: string; tag: (typeof SIM_BOTS)[number]["tag"] }
  | { kind: "real"; name: string; entry: RegistryEntry };

const SIM_BY_NAME = new Map(SIM_BOTS.map((s) => [s.name.toLowerCase(), s]));
const SIM_TAGS = ["Cheapskate", "ValueBidder", "Aggressive"] as const;

function resolveOpp(name: string, reg: Registry): Opp {
  const key = name.trim();
  const sim = SIM_BY_NAME.get(key.toLowerCase());
  if (sim) return { kind: "sim", name: sim.name, tag: sim.tag };
  const tag = SIM_TAGS.find((t) => `sim:${t}`.toLowerCase() === key.toLowerCase() || t.toLowerCase() === key.toLowerCase());
  if (tag) return { kind: "sim", name: `sim:${tag}`, tag };
  const entry = reg.entries.get(key);
  if (entry) return { kind: "real", name: entry.name, entry };
  throw new Error(
    `unknown opponent "${name}". Sims: ${SIM_BOTS.map((s) => s.name).join(", ")}, or ${SIM_TAGS.join("/")}. ` +
      `Strategies: ${[...reg.entries.keys()].join(", ")}`,
  );
}

function allSims(): Opp[] {
  return SIM_BOTS.map((s) => ({ kind: "sim", name: s.name, tag: s.tag }));
}

/** Pick k distinct items (or all, cycling, if fewer exist) with a seeded partial shuffle. */
function sample<T>(pool: T[], k: number, rng: () => number): T[] {
  if (pool.length === 0) throw new Error("empty opponent pool");
  if (pool.length < k) {
    const out: T[] = [];
    const base = pool.slice();
    shuffleInPlace(base, rng);
    for (let i = 0; i < k; i++) out.push(base[i % base.length]!);
    return out;
  }
  const a = pool.slice();
  shuffleInPlace(a, rng);
  return a.slice(0, k);
}

function makeParticipant(o: Opp, seed: number, m: number, seat: number): Participant {
  if (o.kind === "sim") return { kind: "sim", name: o.name, tag: o.tag };
  return { kind: "real", name: o.name, strategy: instantiate(o.entry, hash32(seed, m, 4, seat)) };
}

// ---------- Stats ----------

export interface Stat {
  n: number;
  mean: number;
  se: number;
}

export function meanSe(vals: ArrayLike<number>): Stat {
  let n = 0;
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i]!;
    if (!Number.isNaN(v)) {
      n++;
      sum += v;
    }
  }
  if (n === 0) return { n: 0, mean: NaN, se: NaN };
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i]!;
    if (!Number.isNaN(v)) ss += (v - mean) * (v - mean);
  }
  const se = n > 1 ? Math.sqrt(ss / (n - 1) / n) : NaN;
  return { n, mean, se };
}

const METRICS = ["score", "place", "swiss", "win"] as const;
type Metric = (typeof METRICS)[number];

class Series {
  readonly v: Record<Metric, Float64Array>;
  constructor(n: number) {
    this.v = { score: new Float64Array(n).fill(NaN), place: new Float64Array(n).fill(NaN), swiss: new Float64Array(n).fill(NaN), win: new Float64Array(n).fill(NaN) };
  }
}

interface Agg {
  series: Series;
  errors: SeatErrors;
  firstErrors: string[];
  wordsCalls: number;
  wordsMs: number;
  wordsMax: number;
  bidCalls: number;
  bidMs: number;
  bidMax: number;
  otherCalls: number;
  otherMs: number;
  otherMax: number;
  wordsPlayed: number;
  auctionsWon: number;
  spent: number;
  tilesLeft: number;
  seatObs: number;
}

function newAgg(n: number): Agg {
  return {
    series: new Series(n),
    errors: { invalidWords: 0, unspellableWords: 0, overBalanceBids: 0, badBids: 0, badReturns: 0, exceptions: 0 },
    firstErrors: [],
    wordsCalls: 0, wordsMs: 0, wordsMax: 0, bidCalls: 0, bidMs: 0, bidMax: 0, otherCalls: 0, otherMs: 0, otherMax: 0,
    wordsPlayed: 0, auctionsWon: 0, spent: 0, tilesLeft: 0, seatObs: 0,
  };
}

function absorb(agg: Agg, m: number, seats: MatchResult["seats"]): void {
  const sums = { score: 0, place: 0, swiss: 0, win: 0 };
  for (const s of seats) {
    sums.score += s.score;
    sums.place += s.place;
    sums.swiss += s.swiss;
    sums.win += s.win ? 1 : 0;
    const e = agg.errors;
    e.invalidWords += s.errors.invalidWords;
    e.unspellableWords += s.errors.unspellableWords;
    e.overBalanceBids += s.errors.overBalanceBids;
    e.badBids += s.errors.badBids;
    e.badReturns += s.errors.badReturns;
    e.exceptions += s.errors.exceptions;
    if (s.errors.firstError && agg.firstErrors.length < 3 && !agg.firstErrors.includes(s.errors.firstError)) agg.firstErrors.push(s.errors.firstError);
    const t = s.timing;
    agg.wordsCalls += t.wordsCalls; agg.wordsMs += t.wordsMs; agg.wordsMax = Math.max(agg.wordsMax, t.wordsMaxMs);
    agg.bidCalls += t.bidCalls; agg.bidMs += t.bidMs; agg.bidMax = Math.max(agg.bidMax, t.bidMaxMs);
    agg.otherCalls += t.otherCalls; agg.otherMs += t.otherMs; agg.otherMax = Math.max(agg.otherMax, t.otherMaxMs);
    agg.wordsPlayed += s.wordsPlayed;
    agg.auctionsWon += s.auctionsWon;
    agg.spent += s.spent;
    agg.tilesLeft += s.tilesLeft;
    agg.seatObs++;
  }
  const k = seats.length;
  agg.series.v.score[m] = sums.score / k;
  agg.series.v.place[m] = sums.place / k;
  agg.series.v.swiss[m] = sums.swiss / k;
  agg.series.v.win[m] = sums.win / k;
}

// ---------- Report ----------

export interface StrategyReport {
  name: string;
  role: "test" | "field";
  vs?: string; // for field rows: which test strategy this row was an opponent of
  n: number;
  score: Stat;
  place: Stat;
  swiss: Stat;
  win: Stat;
  errors: SeatErrors;
  firstErrors: string[];
  timing: {
    wordsCalls: number; wordsAvgMs: number; wordsMaxMs: number;
    bidCalls: number; bidAvgMs: number; bidMaxMs: number;
    otherCalls: number; otherAvgMs: number; otherMaxMs: number;
  };
  perSeatAvg: { wordsPlayed: number; auctionsWon: number; spent: number; tilesLeft: number };
}

export interface PairedReport {
  name: string;
  vs: string;
  n: number;
  dScore: Stat;
  dPlace: Stat;
  dSwiss: Stat;
  dWin: Stat;
}

export interface BatchReport {
  config: {
    tests: string[]; field: string; matchesRequested: number; seed: number; auctionType: AuctionType;
    players: number; rack: number; maxSeconds: number;
  };
  matchesCompleted: number;
  truncated: boolean;
  engineRuns: number;
  elapsedSeconds: number;
  runsPerSecond: number;
  strategies: StrategyReport[];
  paired: PairedReport[];
  opponentsUsed: string[];
}

function reportOf(name: string, role: "test" | "field", agg: Agg, vs?: string): StrategyReport {
  const mk = (m: Metric) => meanSe(agg.series.v[m]);
  const score = mk("score");
  const avg = (ms: number, c: number) => (c > 0 ? ms / c : 0);
  const r: StrategyReport = {
    name, role,
    n: score.n,
    score, place: mk("place"), swiss: mk("swiss"), win: mk("win"),
    errors: agg.errors,
    firstErrors: agg.firstErrors,
    timing: {
      wordsCalls: agg.wordsCalls, wordsAvgMs: avg(agg.wordsMs, agg.wordsCalls), wordsMaxMs: agg.wordsMax,
      bidCalls: agg.bidCalls, bidAvgMs: avg(agg.bidMs, agg.bidCalls), bidMaxMs: agg.bidMax,
      otherCalls: agg.otherCalls, otherAvgMs: avg(agg.otherMs, agg.otherCalls), otherMaxMs: agg.otherMax,
    },
    perSeatAvg: {
      wordsPlayed: avg(agg.wordsPlayed, agg.seatObs), auctionsWon: avg(agg.auctionsWon, agg.seatObs),
      spent: avg(agg.spent, agg.seatObs), tilesLeft: avg(agg.tilesLeft, agg.seatObs),
    },
  };
  if (vs !== undefined) r.vs = vs;
  return r;
}

function diffSeries(a: Float64Array, b: Float64Array): Float64Array {
  const d = new Float64Array(a.length).fill(NaN);
  for (let i = 0; i < a.length; i++) if (!Number.isNaN(a[i]!) && !Number.isNaN(b[i]!)) d[i] = a[i]! - b[i]!;
  return d;
}

// ---------- Lineups ----------


/** Opponent line-up for match m: depends only on (seed, m, field, tests), never on which test strategy runs. */
function opponentsFor(field: string, cfg: BatchConfig, m: number): Opp[] {
  const rng = mulberry32(hash32(cfg.seed, m, 3));
  const need = cfg.players - 1;
  const reg = cfg.registry;
  if (field === "lobby-sims") return sample(allSims(), need, rng);
  if (field === "starters") return Array.from({ length: need }, () => resolveOpp("starter", reg));
  if (field === "mixed") {
    const pool: Opp[] = allSims();
    for (const e of reg.entries.values()) {
      if (cfg.tests.includes(e.name)) continue;
      if (e.source === "builtin" || e.source === "models") pool.push({ kind: "real", name: e.name, entry: e });
    }
    return sample(pool, need, rng);
  }
  if (field.startsWith("field:")) {
    const names = field.slice(6).split(",").map((x) => x.trim()).filter(Boolean);
    if (names.length === 0) throw new Error("field: needs at least one opponent name");
    const pool = names.map((n) => resolveOpp(n, reg));
    if (pool.length === need) return pool.slice();
    if (pool.length > need) return sample(pool, need, rng);
    // fewer named opponents than seats: repeat them in order
    return Array.from({ length: need }, (_, i) => pool[i % pool.length]!);
  }
  throw new Error(`unknown --field "${field}" (use lobby-sims | starters | mixed | self | field:a,b,c)`);
}

// ---------- Main loop ----------

export function runBatch(cfg: BatchConfig): BatchReport {
  const N = cfg.matches;
  const P = cfg.players;
  const isSelf = cfg.field === "self";
  if (cfg.tests.length === 0) throw new Error("--test needs at least one strategy");
  const testEntries = cfg.tests.map((t) => {
    const e = cfg.registry.entries.get(t);
    if (!e) throw new Error(`unknown test strategy "${t}". Available: ${[...cfg.registry.entries.keys()].join(", ")}`);
    return e;
  });
  warmDictionary();

  const testAgg = new Map<string, Agg>();
  for (const t of cfg.tests) testAgg.set(t, newAgg(N));
  const fieldAgg = new Map<string, Agg>(); // key `${test}\u0000${oppName}`
  const opponentsUsed = new Set<string>();

  const t0 = performance.now();
  let completed = 0;
  let engineRuns = 0;
  let truncated = false;

  for (let m = 0; m < N; m++) {
    if (m > 0 && (performance.now() - t0) / 1000 > cfg.maxSeconds) {
      truncated = true;
      break;
    }
    if (isSelf) {
      // One match containing the test strategies themselves; seats rotate with m.
      const k = testEntries.length;
      const rng = mulberry32(hash32(cfg.seed, m, 3));
      let lineup: RegistryEntry[];
      if (k >= P) lineup = k === P ? testEntries.slice() : sample(testEntries, P, rng);
      else lineup = Array.from({ length: P }, (_, i) => testEntries[i % k]!);
      const parts: Participant[] = [];
      for (let seat = 0; seat < P; seat++) {
        const e = lineup[(seat + m) % P]!;
        parts.push({ kind: "real", name: e.name, strategy: instantiate(e, hash32(cfg.seed, m, 4, seat)) });
      }
      const res = runMatch(parts, { auctionType: cfg.auctionType, startingRackSize: cfg.rack, seed: cfg.seed, matchIndex: m, bag: makeBag(cfg.seed, m) });
      engineRuns++;
      for (const name of cfg.tests) {
        const mine = res.seats.filter((s) => s.name === name);
        if (mine.length > 0) absorb(testAgg.get(name)!, m, mine);
      }
    } else {
      const opps = opponentsFor(cfg.field, cfg, m);
      for (const o of opps) opponentsUsed.add(o.name);
      const seatOfTest = m % P;
      for (const te of testEntries) {
        const parts: Participant[] = [];
        let oi = 0;
        for (let seat = 0; seat < P; seat++) {
          if (seat === seatOfTest) parts.push({ kind: "real", name: te.name, strategy: instantiate(te, hash32(cfg.seed, m, 4, seat)) });
          else parts.push(makeParticipant(opps[oi++]!, cfg.seed, m, seat));
        }
        const res = runMatch(parts, { auctionType: cfg.auctionType, startingRackSize: cfg.rack, seed: cfg.seed, matchIndex: m, bag: makeBag(cfg.seed, m) });
        engineRuns++;
        absorb(testAgg.get(te.name)!, m, res.seats.filter((s) => s.seat === seatOfTest));
        if (cfg.showField) {
          const byName = new Map<string, MatchResult["seats"]>();
          for (const s of res.seats) {
            if (s.seat === seatOfTest) continue;
            const arr = byName.get(s.name) ?? [];
            arr.push(s);
            byName.set(s.name, arr);
          }
          for (const [name, seats] of byName) {
            const key = `${te.name}\u0000${name}`;
            let a = fieldAgg.get(key);
            if (!a) fieldAgg.set(key, (a = newAgg(N)));
            absorb(a, m, seats);
          }
        }
      }
    }
    completed = m + 1;
    cfg.onProgress?.(completed, N, (performance.now() - t0) / 1000);
  }

  const elapsedSeconds = (performance.now() - t0) / 1000;
  const strategies: StrategyReport[] = [];
  for (const t of cfg.tests) strategies.push(reportOf(t, "test", testAgg.get(t)!));
  for (const [key, agg] of fieldAgg) {
    const [vs, name] = key.split("\u0000") as [string, string];
    strategies.push(reportOf(name, "field", agg, vs));
  }

  const paired: PairedReport[] = [];
  const base = cfg.tests[0]!;
  for (const t of cfg.tests.slice(1)) {
    const a = testAgg.get(t)!.series.v;
    const b = testAgg.get(base)!.series.v;
    const d = {
      dScore: meanSe(diffSeries(a.score, b.score)),
      dPlace: meanSe(diffSeries(a.place, b.place)),
      dSwiss: meanSe(diffSeries(a.swiss, b.swiss)),
      dWin: meanSe(diffSeries(a.win, b.win)),
    };
    paired.push({ name: t, vs: base, n: d.dScore.n, ...d });
  }

  return {
    config: {
      tests: cfg.tests, field: cfg.field, matchesRequested: N, seed: cfg.seed, auctionType: cfg.auctionType,
      players: P, rack: cfg.rack, maxSeconds: cfg.maxSeconds,
    },
    matchesCompleted: completed,
    truncated,
    engineRuns,
    elapsedSeconds,
    runsPerSecond: elapsedSeconds > 0 ? engineRuns / elapsedSeconds : 0,
    strategies,
    paired,
    opponentsUsed: [...opponentsUsed].sort(),
  };
}

// ---------- Text rendering ----------

const f = (x: number, d = 2) => (Number.isNaN(x) ? "  n/a" : x.toFixed(d));
const pm = (s: Stat, d = 2) => `${f(s.mean, d)} ±${f(s.se, d)}`;

export function formatReport(r: BatchReport): string {
  const c = r.config;
  const lines: string[] = [];
  lines.push(
    `== ${c.auctionType} | field=${c.field} | players=${c.players} rack=${c.rack} | seed=${c.seed} | ` +
      `matches ${r.matchesCompleted}/${c.matchesRequested}${r.truncated ? " (TRUNCATED by time limit)" : ""} | ` +
      `${r.engineRuns} engine runs in ${r.elapsedSeconds.toFixed(1)}s = ${r.runsPerSecond.toFixed(1)} matches/s ==`,
  );
  const header =
    `${"strategy".padEnd(24)} ${"n".padStart(5)}  ${"score".padStart(15)}  ${"place".padStart(13)}  ${"swiss".padStart(13)}  ${"win%".padStart(14)}  ` +
    `errs(inv/unsp/over/bad/exc)  words ms avg/max   bid ms avg/max`;
  const row = (s: StrategyReport, label: string) => {
    const e = s.errors;
    const errs = `${e.invalidWords}/${e.unspellableWords}/${e.overBalanceBids}/${e.badBids + e.badReturns}/${e.exceptions}`;
    return (
      `${label.padEnd(24)} ${String(s.n).padStart(5)}  ${pm(s.score).padStart(15)}  ${pm(s.place).padStart(13)}  ${pm(s.swiss).padStart(13)}  ` +
      `${(f(s.win.mean * 100, 1) + " ±" + f(s.win.se * 100, 1)).padStart(14)}  ${errs.padEnd(27)}  ` +
      `${(s.timing.wordsAvgMs.toFixed(3) + "/" + s.timing.wordsMaxMs.toFixed(2)).padEnd(17)} ${s.timing.bidAvgMs.toFixed(3)}/${s.timing.bidMaxMs.toFixed(2)}`
    );
  };
  lines.push(header);
  for (const s of r.strategies.filter((x) => x.role === "test")) lines.push(row(s, s.name));
  const fieldRows = r.strategies.filter((x) => x.role === "field");
  if (fieldRows.length > 0) {
    lines.push("-- opponents (grouped by the test strategy they faced) --");
    for (const s of fieldRows) lines.push(row(s, `${s.name} (vs ${s.vs})`));
  }
  if (r.paired.length > 0) {
    lines.push(`-- paired differences vs ${r.paired[0]!.vs} (same bag, opponents and seat in every match) --`);
    lines.push(`${"strategy".padEnd(24)} ${"n".padStart(5)}  ${"d.score".padStart(15)}  ${"d.place".padStart(13)}  ${"d.swiss".padStart(13)}  ${"d.win (pp)".padStart(14)}`);
    for (const p of r.paired) {
      lines.push(
        `${p.name.padEnd(24)} ${String(p.n).padStart(5)}  ${pm(p.dScore).padStart(15)}  ${pm(p.dPlace).padStart(13)}  ${pm(p.dSwiss).padStart(13)}  ` +
          `${(f(p.dWin.mean * 100, 1) + " ±" + f(p.dWin.se * 100, 1)).padStart(14)}`,
      );
    }
  }
  const bad = r.strategies.filter((s) => s.role === "test" && (s.errors.invalidWords + s.errors.unspellableWords + s.errors.overBalanceBids + s.errors.badBids + s.errors.badReturns + s.errors.exceptions) > 0);
  for (const s of bad) lines.push(`!! ${s.name} made errors; first: ${s.firstErrors.join(" | ")}`);
  return lines.join("\n");
}
