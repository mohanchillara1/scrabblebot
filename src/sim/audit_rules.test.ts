// audit-rules: rule-correctness audit of strategies/final.ts against the REAL server rules.
//
//   AUDIT_PART=views   AUDIT_N=3000 nice -n 19 timeout 200 npx tsx src/sim/audit_rules.test.ts
//   AUDIT_PART=matches AUDIT_N=60 AUDIT_SEED=1 nice -n 19 timeout 200 npx tsx src/sim/audit_rules.test.ts
//
// Independent oracle: the dictionary is re-read from data/wordlist.txt and searched with the SERVER's binary search
// (dictionary.ts isValidWord), rack checks are plain Map arithmetic, so none of final.ts's / words.ts's own helpers
// are trusted.
//
// PART=views    property fuzz on random synthetic MatchViews, calling final.words()/final.bid() directly.
// PART=matches  random full simulated matches (players 2..11, rack 3..8, Vickrey/FirstPrice, random opponents,
//               1-2 final seats). Each final seat is wrapped by a SHADOW harness that also feeds the SAME views to the
//               raw sub-strategy final dispatches to, so exceptions / invalid output that final.ts silently swallows
//               become visible. Leftover racks at match end are brute-force checked for still-playable words.
import { readFileSync } from "node:fs";
import { setPriority } from "node:os";
import { fileURLToPath } from "node:url";
import type { AuctionRecord, AuctionType, MatchView, PlayerPublic, Strategy } from "../core/types.js";
import * as W from "../engine/words.js";
import { createFinal } from "../strategies/final.js";
import { createStrategy as createEconomist } from "../strategies/economist.js";
import { createStrategy as createTuned } from "../strategies/tuned.js";
import { createStrategy as createAdversary } from "../strategies/adversary.js";
import { createStrategy as createMcvalue } from "../strategies/mcvalue.js";
import { BURN_DEFAULTS, burnBid } from "../strategies/final/burn.js";
import { type Participant, runMatch } from "./engine.js";
import { mulberry32 } from "./rng.js";
import { BASELINES } from "./baselines.js";

try {
  setPriority(0, 19);
} catch {
  /* ignore */
}

// ---------- oracle ----------
const WORDS = readFileSync(fileURLToPath(new URL("../../data/wordlist.txt", import.meta.url)), "utf8")
  .split("\n")
  .filter((l) => l.length > 0);
function serverIsValid(target: string): boolean {
  if (target.length < 2 || !/^[A-Z]+$/.test(target)) return false;
  let lo = 0;
  let hi = WORDS.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const w = WORDS[mid]!;
    if (w < target) lo = mid + 1;
    else if (w === target) return true;
    else hi = mid;
  }
  return false;
}
/** Check a words() result against the rack. Returns problems (empty = clean) and the rack left after the words. */
function checkWordList(rack: Map<string, number>, ws: unknown): { problems: string[]; left: Map<string, number>; reward: number } {
  const left = new Map(rack);
  const problems: string[] = [];
  let reward = 0;
  if (!Array.isArray(ws)) return { problems: ["words() did not return an array"], left, reward };
  for (const w of ws) {
    if (typeof w !== "string") {
      problems.push(`non-string word ${String(w)}`);
      continue;
    }
    const u = w.toUpperCase();
    if (!serverIsValid(u)) {
      problems.push(`not a valid server word "${w}"`);
      continue;
    }
    const need = new Map<string, number>();
    for (const c of u) need.set(c, (need.get(c) ?? 0) + 1);
    let ok = true;
    for (const [c, n] of need) if ((left.get(c) ?? 0) < n) ok = false;
    if (!ok) {
      problems.push(`unspellable "${w}"`);
      continue;
    }
    for (const [c, n] of need) left.set(c, (left.get(c) ?? 0) - n);
    reward += W.reward(u);
  }
  return { problems, left, reward };
}
function totalOf(m: Map<string, number>): number {
  let t = 0;
  for (const n of m.values()) t += n;
  return t;
}
/** Brute force: is any dictionary word (>= 2 letters) still spellable from this rack? Returns one (the best-reward) or null. */
function anyPlayable(rack: Map<string, number>): string | null {
  const total = totalOf(rack);
  if (total < 2) return null;
  const cnt = new Int32Array(26);
  for (const [c, n] of rack) cnt[c.charCodeAt(0) - 65] += n;
  let best: string | null = null;
  let bestR = -1;
  const need = new Int32Array(26);
  for (const w of WORDS) {
    if (w.length > total) continue;
    need.fill(0);
    let ok = true;
    for (let i = 0; i < w.length; i++) {
      const k = w.charCodeAt(i) - 65;
      if (++need[k]! > cnt[k]!) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const r = W.reward(w);
      if (r > bestR) {
        bestR = r;
        best = w;
      }
    }
  }
  return best;
}

// ---------- synthetic views ----------
const BAG: string[] = [];
const BAGC = [9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1];
for (let i = 0; i < 26; i++) for (let k = 0; k < BAGC[i]!; k++) BAG.push(String.fromCharCode(65 + i));
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
const ri = (rng: () => number, a: number, b: number) => a + Math.floor(rng() * (b - a + 1));

function randomView(rng: () => number, forceBag?: number): { view: MatchView; letter: string } {
  const players = [2, 2, 3, 4, 5, 6, 6, 6, 7, 8, 11][ri(rng, 0, 10)]!;
  const type: AuctionType = rng() < 0.5 ? "Vickrey" : "FirstPrice";
  const startRack = ri(rng, 3, 8);
  const total = 98 - players * startRack - 1; // auctions after the first
  const round = ri(rng, 1, Math.max(1, total + 1));
  const bagRemaining = forceBag ?? Math.max(0, Math.min(97, total + 1 - round));
  const rackN = rng() < 0.15 ? ri(rng, 0, 40) : ri(rng, 0, 14);
  const rack = drawRack(rng, rackN);
  const balance = rng() < 0.1 ? ri(rng, 0, 3) : rng() < 0.05 ? ri(rng, 100, 100000) : ri(rng, 0, 160);
  const ps: PlayerPublic[] = [];
  for (let i = 0; i < players; i++) ps.push({ botId: i + 1, balance: i === 0 ? balance : ri(rng, 0, 200), score: i === 0 ? ri(rng, 0, 150) : ri(rng, 0, 150), isSim: rng() < 0.1 });
  const hist: AuctionRecord[] = [];
  const pool = [...BAG];
  for (let r = 1; r < round; r++) {
    const letter = pool.splice(Math.floor(rng() * pool.length), 1)[0] ?? "E";
    const win = rng() < 0.1 ? null : ri(rng, 1, players);
    hist.push({ round: r, letter, winnerBotId: win, paid: win === null ? 0 : ri(rng, 1, rng() < 0.05 ? 150 : 40) });
  }
  const letter = BAG[ri(rng, 0, BAG.length - 1)]!;
  return {
    letter,
    view: {
      matchId: ri(rng, 1, 1e6),
      myBotId: 1,
      auctionType: type,
      auctionDurationMs: 1000,
      startingRackSize: startRack,
      players: ps,
      myRack: rack,
      myBalance: balance,
      myScore: ps[0]!.score,
      round,
      bagRemaining,
      auctionHistory: hist,
      wordHistory: [],
    },
  };
}

// ---------- PART views ----------
function partViews(n: number, seed: number): number {
  const rng = mulberry32(seed);
  let bad = 0;
  const probs: string[] = [];
  const note = (s: string) => {
    bad++;
    if (probs.length < 25) probs.push(s);
  };
  let wMax = 0;
  let bMax = 0;
  const dumpShort: { rack: string; got: number; best: number; ms: number }[] = [];
  let dumpChecks = 0;
  let lastLeftover = 0;
  let lastChecks = 0;
  for (let i = 0; i < n; i++) {
    // 20% of cases sit exactly on the dump boundary (bagRemaining 0 or 1), 5% at 2 and 3
    const k = rng();
    const forceBag = k < 0.12 ? 0 : k < 0.24 ? 1 : k < 0.28 ? 2 : undefined;
    const { view, letter } = randomView(rng, forceBag);
    const fin = createFinal({}, "audit");
    // a fresh match each time; some cases get an onMatchStart, some join "mid-match" (reconnect / takeover)
    if (rng() < 0.5) fin.onMatchStart?.(view);
    const t0 = performance.now();
    let ws: string[] = [];
    try {
      ws = fin.words(view);
    } catch (e) {
      note(`words() THREW ${String(e)}`);
    }
    const dw = performance.now() - t0;
    wMax = Math.max(wMax, dw);
    const chk = checkWordList(view.myRack, ws);
    for (const p of chk.problems) note(`words: ${p} | players=${view.players.length} ${view.auctionType} bag=${view.bagRemaining} rack=${[...view.myRack].map(([c, m]) => c.repeat(m)).join("")}`);
    // bid sees the post-word balance/rack, as in the live flow
    let rew = chk.reward;
    const v2: MatchView = { ...view, myRack: chk.left, myBalance: view.myBalance + rew, myScore: view.myScore + rew };
    const t1 = performance.now();
    let b: unknown = 0;
    try {
      b = fin.bid(v2, letter);
    } catch (e) {
      note(`bid() THREW ${String(e)}`);
    }
    bMax = Math.max(bMax, performance.now() - t1);
    if (typeof b !== "number" || !Number.isSafeInteger(b) || b < 0) note(`bid not a non-negative safe integer: ${String(b)}`);
    else if (b > v2.myBalance) note(`bid ${b} > balance ${v2.myBalance} (${view.auctionType} ${view.players.length}p bag=${view.bagRemaining})`);
    else if (view.bagRemaining === 0 && b !== 0) note(`bid ${b} on the LAST auction (should be 0)`);
    if (view.bagRemaining === 0 || view.bagRemaining === 1) {
      // at the dump boundary nothing spellable should be left, and the dump should be (near-)optimal
      const lo = view.bagRemaining === 0 ? lastChecks++ : -1;
      void lo;
      if (totalOf(view.myRack) >= 2) {
        const left = anyPlayable(chk.left);
        if (left) {
          lastLeftover++;
          note(`LEFTOVER playable word "${left}" after words() at bag=${view.bagRemaining} (rack ${[...view.myRack].map(([c, m]) => c.repeat(m)).join("")}, played ${ws.join(",")})`);
        }
        dumpChecks++;
        const R = W.rackToCounts(view.myRack);
        const best = W.bestPartition(R, { timeBudgetMs: 1500 });
        if (rew < best.total) dumpShort.push({ rack: [...view.myRack].map(([c, m]) => c.repeat(m)).join(""), got: rew, best: best.total, ms: dw });
      }
    }
  }
  console.log(`[views] n=${n} seed=${seed} problems=${bad} words max ${wMax.toFixed(1)}ms bid max ${bMax.toFixed(1)}ms`);
  console.log(`[views] dump-boundary checks=${dumpChecks} leftover-playable=${lastLeftover} suboptimal-dumps=${dumpShort.length}`);
  for (const d of dumpShort.slice(0, 12)) console.log(`   short dump: rack ${d.rack} got ${d.got} vs best ${d.best} (${d.ms.toFixed(0)}ms)`);
  if (dumpShort.length) {
    const loss = dumpShort.reduce((a, d) => a + (d.best - d.got), 0) / dumpShort.length;
    console.log(`   mean shortfall over those: ${loss.toFixed(1)} points`);
  }
  for (const p of probs) console.log("   PROBLEM:", p);
  return bad;
}

// ---------- PART matches ----------
type RuleName = "economist" | "advR" | "tuned" | "adversary" | "mcvalue";
function rawFor(rule: RuleName): Strategy {
  switch (rule) {
    case "economist":
      return createEconomist();
    case "tuned":
      return createTuned();
    case "adversary":
      return createAdversary();
    case "advR":
      return createAdversary({ pushCapFrac: 0.7, pushMinFrac: 0.15 });
    case "mcvalue":
      return createMcvalue();
  }
}

interface Shadow {
  burnOver: number; // burn floor pushed an in-range inner bid above the balance
  rawOverBal: number;
  rawFrac: number;
  rawBadLate: number;
  big: number; // |final bid - raw bid| > max(3, 30% of raw): beyond time-budget noise
  rawThrows: number;
  rawBadWords: number;
  rawBadBids: number;
  wordMismatch: number; // final's list differs from the raw sub-strategy's (outside the dump zone)
  bidMismatch: number;
  calls: number;
  examples: string[];
  serious: string[];
}
const zeroShadow = (): Shadow => ({ burnOver: 0, rawOverBal: 0, rawFrac: 0, rawBadLate: 0, big: 0, rawThrows: 0, rawBadWords: 0, rawBadBids: 0, wordMismatch: 0, bidMismatch: 0, calls: 0, examples: [], serious: [] });

/** A strategy that behaves exactly as final does but also runs a raw sub-strategy on the same views (per matchId). */
function shadowedFinal(label: string, sh: Shadow): Strategy {
  const fin = createFinal({}, label);
  const raws = new Map<number, { rule: RuleName; s: Strategy; players: number }>();
  const ex = (s: string) => {
    if (/THREW|invalid|not a legal|BIG bid gap/.test(s)) {
      if (sh.serious.length < 30) sh.serious.push(s);
    } else if (sh.examples.length < 6) sh.examples.push(s);
  };
  const rawOf = (v: MatchView) => {
    let r = raws.get(v.matchId);
    if (!r) {
      const rule: RuleName = v.players.length <= 2 ? (v.auctionType === "FirstPrice" ? "economist" : "advR") : "economist";
      r = { rule, s: rawFor(rule), players: v.players.length };
      raws.set(v.matchId, r);
      try {
        r.s.onMatchStart?.(v);
      } catch {
        /* counted via words/bid */
      }
    }
    return r;
  };
  return {
    name: label,
    onMatchStart(v) {
      raws.delete(v.matchId);
      rawOf(v);
      fin.onMatchStart?.(v);
    },
    words(v) {
      sh.calls++;
      const out = fin.words(v);
      const r = rawOf(v);
      let rw: string[] | null = null;
      try {
        rw = r.s.words(v);
      } catch (e) {
        sh.rawThrows++;
        ex(`raw ${r.rule}.words THREW ${String(e)} (bag=${v.bagRemaining} round=${v.round})`);
      }
      if (rw) {
        const c = checkWordList(v.myRack, rw);
        if (c.problems.length) {
          sh.rawBadWords++;
          ex(`raw ${r.rule}.words invalid: ${c.problems[0]} (bag=${v.bagRemaining}, ${v.auctionType}, ${v.players.length}p)`);
        }
      }
      return out;
    },
    bid(v, letter) {
      const out = fin.bid(v, letter);
      const r = rawOf(v);
      let rb: unknown = null;
      try {
        rb = r.s.bid(v, letter);
        if (r.rule === "economist" && v.players.length >= 3 && typeof rb === "number" && Number.isFinite(rb)) {
          const pre = rb;
          rb = burnBid(v, letter, rb, BURN_DEFAULTS);
          if ((rb as number) > v.myBalance && pre <= v.myBalance) sh.burnOver++;
        }
      } catch (e) {
        sh.rawThrows++;
        ex(`raw ${r.rule}.bid THREW ${String(e)} (bag=${v.bagRemaining} round=${v.round})`);
      }
      if (rb !== null) {
        if (typeof rb !== "number" || !Number.isFinite(rb) || rb < 0 || rb > v.myBalance || !Number.isInteger(rb)) {
          sh.rawBadBids++;
          if (typeof rb === "number" && rb > v.myBalance) sh.rawOverBal++;
          else if (typeof rb === "number" && Number.isFinite(rb) && !Number.isInteger(rb)) sh.rawFrac++;
          if (v.bagRemaining <= 3) sh.rawBadLate++;
          ex(`raw ${r.rule}.bid not a legal bid: ${String(rb)} (balance ${v.myBalance}, bag=${v.bagRemaining})`);
        }
      }
      return out;
    },
    onAuctionResult(v, rec) {
      fin.onAuctionResult?.(v, rec);
      const r = rawOf(v);
      try {
        r.s.onAuctionResult?.(v, rec);
      } catch (e) {
        sh.rawThrows++;
        ex(`raw ${r.rule}.onAuctionResult THREW ${String(e)}`);
      }
    },
  };
}

function partMatches(n: number, seed: number, maxSec: number): number {
  const rng = mulberry32(seed * 7919 + 13);
  const t0 = performance.now();
  const agg = {
    matches: 0,
    finalSeats: 0,
    invalidWords: 0,
    unspellableWords: 0,
    overBalanceBids: 0,
    badBids: 0,
    badReturns: 0,
    exceptions: 0,
    leftoverPlayable: 0,
    leftoverValue: 0,
    wordsMaxMs: 0,
    bidMaxMs: 0,
    perConfig: new Map<string, number>(),
  };
  const sh = zeroShadow();
  const first: string[] = [];
  const optionsOpp: (() => Participant)[] = [
    () => ({ kind: "real", name: "economist", strategy: createEconomist() }),
    () => ({ kind: "real", name: "tuned", strategy: createTuned() }),
    () => ({ kind: "real", name: "mcvalue", strategy: createMcvalue() }),
    () => ({ kind: "real", name: "adversary", strategy: createAdversary() }),
    () => ({ kind: "real", name: "starter", strategy: BASELINES["starter"]!() }),
    () => ({ kind: "real", name: "value-plus", strategy: BASELINES["value-plus"]!() }),
    () => ({ kind: "sim", name: "Cheapo-sim", tag: "Cheapskate" }),
    () => ({ kind: "sim", name: "Valor-sim", tag: "ValueBidder" }),
    () => ({ kind: "sim", name: "Brutus-sim", tag: "Aggressive" }),
  ];
  let done = 0;
  for (let m = 0; m < n; m++) {
    if ((performance.now() - t0) / 1000 > maxSec) break;
    const players = [2, 2, 2, 3, 3, 4, 4, 5, 6, 6, 6, 7, 7, 8, 9, 11][ri(rng, 0, 15)]!;
    const [rLo, rHi] = (process.env["AUDIT_RACK"] ?? "3,8").split(",").map(Number) as [number, number];
    const maxRack = Math.min(rHi, Math.floor(97 / players));
    const rack = ri(rng, Math.min(rLo, maxRack), maxRack);
    const type: AuctionType = rng() < 0.5 ? "Vickrey" : "FirstPrice";
    const nFinal = players >= 4 && rng() < 0.3 ? 2 : 1;
    const parts: Participant[] = [];
    const finalSeats: number[] = [];
    const rackLetters: Map<string, number>[] = [];
    for (let s = 0; s < players; s++) parts.push(optionsOpp[ri(rng, 0, optionsOpp.length - 1)]!());
    for (let f = 0; f < nFinal; f++) {
      let seat = ri(rng, 0, players - 1);
      while (finalSeats.includes(seat)) seat = (seat + 1) % players;
      finalSeats.push(seat);
      parts[seat] = { kind: "real", name: "final", strategy: shadowedFinal("final", sh) };
    }
    for (let s = 0; s < players; s++) rackLetters.push(new Map());
    const cfgKey = `${players}p ${type} rack${rack}`;
    const racks = rackLetters;
    let res;
    try {
      res = runMatch(parts, {
        auctionType: type,
        startingRackSize: rack,
        seed: seed * 1000 + m,
        matchIndex: m,
        matchId: 100000 + seed * 1000 + m,
        onEvent: (e) => {
          if (e.type === "deal") for (const c of e.letters) racks[e.seat]!.set(c, (racks[e.seat]!.get(c) ?? 0) + 1);
          else if (e.type === "close" && e.received && e.winnerSeat >= 0) racks[e.winnerSeat]!.set(e.letter, (racks[e.winnerSeat]!.get(e.letter) ?? 0) + 1);
          else if (e.type === "word") for (const c of e.word) racks[e.seat]!.set(c, (racks[e.seat]!.get(c) ?? 0) - 1);
        },
      });
    } catch (err) {
      console.log(`MATCH ${m} (${cfgKey}) THREW ${String(err)}`);
      agg.exceptions++;
      continue;
    }
    done++;
    agg.matches++;
    agg.perConfig.set(cfgKey.replace(/ rack\d/, ""), (agg.perConfig.get(cfgKey.replace(/ rack\d/, "")) ?? 0) + 1);
    for (const seat of finalSeats) {
      const sr = res.seats[seat]!;
      agg.finalSeats++;
      const e = sr.errors;
      agg.invalidWords += e.invalidWords;
      agg.unspellableWords += e.unspellableWords;
      agg.overBalanceBids += e.overBalanceBids;
      agg.badBids += e.badBids;
      agg.badReturns += e.badReturns;
      agg.exceptions += e.exceptions;
      if (e.firstError && first.length < 8) first.push(`${cfgKey}: ${e.firstError}`);
      agg.wordsMaxMs = Math.max(agg.wordsMaxMs, sr.timing.wordsMaxMs);
      agg.bidMaxMs = Math.max(agg.bidMaxMs, sr.timing.bidMaxMs);
      const left = new Map([...racks[seat]!].filter(([, c]) => c > 0));
      if (totalOf(left) !== sr.tilesLeft) {
        console.log(`   TRACKING MISMATCH seat ${seat}: tracked ${totalOf(left)} vs engine tilesLeft ${sr.tilesLeft} (${cfgKey})`);
      }
      const pw = anyPlayable(left);
      if (pw) {
        agg.leftoverPlayable++;
        agg.leftoverValue += W.reward(pw);
        if (first.length < 8) first.push(`${cfgKey}: LEFTOVER playable "${pw}" in [${[...left].map(([c, k]) => c.repeat(k)).join("")}]`);
      }
    }
  }
  const dt = (performance.now() - t0) / 1000;
  console.log(`[matches] seed=${seed} done=${done}/${n} in ${dt.toFixed(0)}s; final seats=${agg.finalSeats}`);
  console.log(
    `[matches] ENGINE-visible errors on final: invalidWords=${agg.invalidWords} unspellable=${agg.unspellableWords} overBalance=${agg.overBalanceBids} badBids=${agg.badBids} badReturns=${agg.badReturns} exceptions=${agg.exceptions}`,
  );
  console.log(`[matches] leftover-playable at match end: ${agg.leftoverPlayable} seats (value ${agg.leftoverValue})  wordsMax=${agg.wordsMaxMs.toFixed(1)}ms bidMax=${agg.bidMaxMs.toFixed(1)}ms`);
  console.log(
    `[matches] SHADOW (raw sub-strategy, same views): calls=${sh.calls} rawThrows=${sh.rawThrows} rawBadWords=${sh.rawBadWords} rawBadBids=${sh.rawBadBids} (over-balance ${sh.rawOverBal}, fractional ${sh.rawFrac}, of which bag<=3: ${sh.rawBadLate}; burn-induced over-balance ${sh.burnOver})`,
  );
  console.log(`[matches] configs: ${[...agg.perConfig].map(([k, v]) => `${k}:${v}`).join("  ")}`);
  for (const f of first) console.log("   FIRST:", f);
  for (const f of sh.serious) console.log("   SHADOW-SERIOUS:", f);
  for (const f of sh.examples) console.log("   SHADOW:", f);
  return agg.invalidWords + agg.unspellableWords + agg.overBalanceBids + agg.badBids + agg.badReturns + agg.exceptions + agg.leftoverPlayable + sh.rawThrows + sh.rawBadWords + sh.rawBadBids;
}

// ---------- PART hu: heads-up robustness of the shipped Vickrey rule against hostile fixed-rule bidders ----------
function partHu(n: number, seed: number, maxSec: number): number {
  const t0 = performance.now();
  const hostile: Record<string, (v: MatchView, l: string) => number> = {
    flat60: (v) => Math.min(v.myBalance, 60),
    whale80: (v) => Math.floor(v.myBalance * 0.8),
    triple: (v, l) => Math.min(v.myBalance, 3 * (W.letterValue(l) + 2)),
    zero: () => 0,
  };
  const mk = (name: string): Participant => {
    const base = BASELINES["starter"]!();
    const bid = hostile[name]!;
    return { kind: "real", name, strategy: { ...base, name, bid: (v: MatchView, l: string) => Math.max(0, Math.min(v.myBalance, Math.floor(bid(v, l)))) } };
  };
  const cands: [string, () => Strategy][] = [
    ["final", () => createFinal({}, "final")],
    ["tuned", () => createTuned()],
    ["economist", () => createEconomist()],
  ];
  for (const type of ["Vickrey", "FirstPrice"] as AuctionType[]) {
    for (const opp of Object.keys(hostile)) {
      const line: string[] = [];
      for (const [cn, cf] of cands) {
        let sc = 0;
        let oppSc = 0;
        let wins = 0;
        let m = 0;
        for (; m < n; m++) {
          if ((performance.now() - t0) / 1000 > maxSec) break;
          const seatMe = m % 2;
          const parts: Participant[] = seatMe === 0 ? [{ kind: "real", name: cn, strategy: cf() }, mk(opp)] : [mk(opp), { kind: "real", name: cn, strategy: cf() }];
          const res = runMatch(parts, { auctionType: type, startingRackSize: 5, seed: seed * 100 + 5, matchIndex: m, matchId: 5000 + m });
          const me = res.seats[seatMe]!;
          const ot = res.seats[1 - seatMe]!;
          sc += me.score;
          oppSc += ot.score;
          if (me.score > ot.score) wins++;
          else if (me.score === ot.score) wins += 0.5;
        }
        line.push(`${cn}: ${(sc / m).toFixed(0)} vs ${(oppSc / m).toFixed(0)}, win ${((100 * wins) / m).toFixed(0)}% (n=${m})`);
      }
      console.log(`[hu ${type}] vs ${opp.padEnd(8)} | ${line.join(" | ")}`);
    }
  }
  return 0;
}

const part = process.env["AUDIT_PART"] ?? "views";
const N = Number(process.env["AUDIT_N"] ?? (part === "views" ? 2000 : 40));
const SEED = Number(process.env["AUDIT_SEED"] ?? 1);
const MAXSEC = Number(process.env["AUDIT_MAXSEC"] ?? 170);
W.warmUp();
const bad = part === "views" ? partViews(N, SEED) : part === "hu" ? partHu(N, SEED, MAXSEC) : partMatches(N, SEED, MAXSEC);
console.log(`AUDIT ${part} seed=${SEED}: ${bad} flagged items`);
process.exit(bad > 0 ? 1 : 0);
