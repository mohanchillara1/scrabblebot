// "economist": auction-theory strategy.
//
// Value of a letter = expected marginal gain in the best disjoint-word partition (points), estimated by
// Monte-Carlo over the tiles we are still expected to acquire (drawn from the public unseen pool, common random
// numbers for with/without the letter). Points become coins through kappa (coins per point) times a pace factor
// that compares our cash with the expected remaining spend at the observed market price level (prices scale with
// the number of players; the observed clearing prices in this match re-scale the estimate). Vickrey: bid the true
// value (truthful bidding is dominant; we pay the 2nd price). FirstPrice: bid min(value, predicted top-bid * s)
// with s adapted from wins/losses. Words: play a prefix of the optimal partition when the expected loss of
// option value (flexibility) is small relative to the reward (cash recycles); dump everything at the end.

import type { AuctionRecord, MatchView, Strategy } from "../core/types.js";
import * as W from "../engine/words.js";

export interface EconParams {
  kappa: number; // coins per point
  paceExp: number;
  paceMin: number;
  paceMax: number;
  eta: number; // tolerated option-value loss as a fraction of reward when playing now
  bidBudgetMs: number;
  wordsBudgetMs: number;
  maxSamples: number;
  kCap: number;
  n0: number; // prior weight (in samples) for fallback value
  forceDumpTiles: number;
  fpShade0: number;
  paceMode: number; // 0 = spend-need pace, 1 = affordability pace (cash vs cost of buying the remaining market)
  a0: number; // reference affordability (6-player start)
}

export const DEFAULTS: EconParams = {
  kappa: 1.5,
  paceExp: 0.6,
  paceMin: 0.6,
  paceMax: 3,
  eta: 0.15,
  bidBudgetMs: 8,
  wordsBudgetMs: 25,
  maxSamples: 10,
  kCap: 12,
  n0: 1,
  forceDumpTiles: 21,
  fpShade0: 1.1,
  paceMode: 1,
  a0: 0.09,
};

const SCALE_BY_N: Record<number, number> = { 2: 0.43, 3: 0.59, 4: 0.72, 5: 0.8, 6: 1.0, 7: 1.18 };
function playerScale(n: number): number {
  if (n <= 2) return 0.43;
  if (n >= 7) return 1.18 + 0.05 * (n - 7);
  return SCALE_BY_N[n]!;
}

/** Prior Vickrey 2nd-price for a letter at an n-player table (from tournament/lobby history). */
function priorPrice(letter: string, n: number): number {
  const face = W.letterValue(letter);
  let p = 8 + 2.2 * face;
  if (letter === "Q") p *= 0.7;
  return p * playerScale(n) * 0.95;
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function now(): number {
  return performance.now();
}

export function createEconomist(p: Partial<EconParams> = {}, name = "economist"): Strategy {
  const P: EconParams = { ...DEFAULTS, ...p };
  W.warmUp();
  let matchId = -1;
  let lastKey = "";
  let lastEvalRound = -99;
  let fpShade = P.fpShade0;
  let lastBid = 0;
  let lastValue = 0;
  let lastLetterAuction = -1;

  function reset(view: MatchView) {
    matchId = view.matchId;
    lastKey = "";
    lastEvalRound = -99;
    fpShade = P.fpShade0;
    lastBid = 0;
    lastValue = 0;
    lastLetterAuction = -1;
  }

  function ensure(view: MatchView) {
    if (view.matchId !== matchId) reset(view);
  }

  interface Ctx {
    n: number;
    won: number;
    pool: Float64Array;
    priceRatio: number;
    start: Uint8Array;
    pbar: number; // observed mean clearing price (blend of recent paid and prior)
  }

  function context(view: MatchView, cur: string | null): Ctx {
    const n = view.players.length;
    const hist = new Int32Array(26);
    let won = 0;
    const wonC = new Int32Array(26);
    let ratioNum = 4; // prior weight 4 at ratio 1
    let ratioDen = 4;
    const fpMul = view.auctionType === "FirstPrice" ? 1.3 : 1;
    let sumPaid = 3 * priorPrice("E", n) * 1.25 * fpMul;
    let cntPaid = 3;
    const H = view.auctionHistory;
    for (let i = 0; i < H.length; i++) {
      const r = H[i]!;
      const li = r.letter.charCodeAt(0) - 65;
      if (li >= 0 && li < 26) hist[li]!++;
      if (r.winnerBotId === view.myBotId) {
        won++;
        if (li >= 0 && li < 26) wonC[li]!++;
      }
      if (r.winnerBotId !== null && i >= H.length - 20 && r.round < 1e9) {
        sumPaid += r.paid;
        cntPaid += 1;
        const pp = priorPrice(r.letter, n) * (view.auctionType === "FirstPrice" ? 1.3 : 1);
        if (pp > 0) {
          ratioNum += Math.min(3, r.paid / pp);
          ratioDen += 1;
        }
      }
    }
    const playedC = new Int32Array(26);
    for (const w of view.wordHistory) {
      if (w.botId !== view.myBotId) continue;
      for (let i = 0; i < w.word.length; i++) {
        const li = w.word.charCodeAt(i) - 65;
        if (li >= 0 && li < 26) playedC[li]!++;
      }
    }
    const start = new Uint8Array(26);
    const pool = new Float64Array(26);
    for (let c = 0; c < 26; c++) {
      const have = view.myRack.get(String.fromCharCode(65 + c)) ?? 0;
      const s = Math.max(0, have + playedC[c]! - wonC[c]!);
      start[c] = s;
      let pc = W.BAG_COUNTS[c]! - hist[c]! - s;
      if (cur !== null && cur.charCodeAt(0) - 65 === c) pc -= 1;
      pool[c] = Math.max(0, pc);
    }
    return { n, won, pool, priceRatio: ratioNum / ratioDen, start, pbar: sumPaid / cntPaid };
  }

  function drawFuture(pool: Float64Array, k: number, rnd: () => number): Uint8Array {
    const f = new Uint8Array(26);
    const p = Float64Array.from(pool);
    let tot = 0;
    for (let c = 0; c < 26; c++) tot += p[c]!;
    for (let i = 0; i < k && tot > 0; i++) {
      let x = rnd() * tot;
      let c = 0;
      for (; c < 25; c++) {
        x -= p[c]!;
        if (x < 0) break;
      }
      if (p[c]! <= 0) {
        // numeric fallthrough: pick any nonzero
        let found = -1;
        for (let d = 0; d < 26; d++) if (p[d]! > 0) { found = d; break; }
        if (found < 0) break;
        c = found;
      }
      f[c]!++;
      p[c]!--;
      tot--;
    }
    return f;
  }

  function acquireRate(view: MatchView, ctx: Ctx): number {
    const q0 = Math.max(0.15, Math.min(0.7, 1.45 / ctx.n));
    const elapsed = Math.max(0, view.round - 1);
    const q = (ctx.won + 3 * q0) / (elapsed + 3);
    return Math.max(0.08, Math.min(0.75, q));
  }

  function futureTiles(view: MatchView, ctx: Ctx, rackTotal: number, rnd: () => number): number {
    const q = acquireRate(view, ctx);
    const kf = q * view.bagRemaining;
    let k = Math.floor(kf) + (rnd() < kf - Math.floor(kf) ? 1 : 0);
    k = Math.min(k, P.kCap, Math.max(0, 24 - rackTotal));
    return Math.max(0, k);
  }

  function pace(view: MatchView, ctx: Ctx): number {
    // affordability pace measured better at 2 and 5-7 players; the older spend-need pace measured better at 3 players
    // (vs sim-priced opponents), so 3-4 player tables keep it (minimax choice, 4p unmeasured).
    if (P.paceMode === 1 && (ctx.n === 2 || ctx.n >= 5)) {
      const costAll = Math.max(1, (view.bagRemaining + 1) * Math.max(1, ctx.pbar));
      const a = Math.max(0.01, view.myBalance) / costAll;
      return Math.max(P.paceMin, Math.min(P.paceMax, Math.pow(a / P.a0, P.paceExp)));
    }
    const q = acquireRate(view, ctx);
    const kf = q * view.bagRemaining;
    const pTyp = priorPrice("E", ctx.n) * (view.auctionType === "FirstPrice" ? 1.3 : 1) * ctx.priceRatio;
    const needs = Math.max(10, kf * pTyp * 0.6);
    const ratio = Math.max(0.01, view.myBalance) / needs;
    return Math.max(P.paceMin, Math.min(P.paceMax, Math.pow(ratio, P.paceExp)));
  }

  function fallbackValue(letter: string): number {
    const face = W.letterValue(letter);
    let v = 4.4 + 1.2 * face;
    if (letter === "Q") v *= 0.6;
    return v;
  }

  function addCounts(a: Uint8Array, b: Uint8Array, extraIdx = -1): Uint8Array {
    const r = new Uint8Array(26);
    for (let i = 0; i < 26; i++) r[i] = Math.min(255, a[i]! + b[i]!);
    if (extraIdx >= 0) r[extraIdx]!++;
    return r;
  }

  /** Expected marginal points of owning `letter` on top of the rack. */
  function valuePts(view: MatchView, letter: string, ctx: Ctx): number {
    const R = W.rackToCounts(view.myRack);
    const li = letter.charCodeAt(0) - 65;
    if (li < 0 || li > 25) return 0;
    const rackTotal = W.totalTiles(R);
    const rnd = mulberry32((view.matchId * 7919 + view.round * 104729 + view.myBotId * 31) >>> 0);
    const t0 = now();
    let sum = 0;
    let cnt = 0;
    const budget = P.bidBudgetMs;
    while (cnt < P.maxSamples) {
      const k = futureTiles(view, ctx, rackTotal, rnd);
      const F = drawFuture(ctx.pool, k, rnd);
      const base = addCounts(R, F);
      const p0 = W.bestPartition(base, { timeBudgetMs: 3 }).total;
      const p1 = W.bestPartition(addCounts(base, new Uint8Array(26), li), { timeBudgetMs: 3 }).total;
      sum += p1 - p0;
      cnt++;
      if (cnt >= 2 && now() - t0 > budget) break;
      if (cnt >= 1 && now() - t0 > 4 * budget) break;
    }
    const mean = cnt > 0 ? sum / cnt : fallbackValue(letter);
    return (cnt * mean + P.n0 * fallbackValue(letter)) / (cnt + P.n0);
  }

  function validWords(rack: Uint8Array, ws: string[]): string[] {
    const out: string[] = [];
    const cur = Uint8Array.from(rack);
    for (const w of ws) {
      if (!W.isWord(w) || !W.canSpell(cur, w)) continue;
      for (let i = 0; i < w.length; i++) cur[w.charCodeAt(i) - 65]!--;
      out.push(w);
    }
    return out;
  }

  return {
    name,
    onMatchStart(view) {
      reset(view);
    },

    words(view) {
      ensure(view);
      const R = W.rackToCounts(view.myRack);
      const tot = W.totalTiles(R);
      if (tot < 2) return [];
      if (view.bagRemaining === 0) {
        const part = W.bestPartition(R, { timeBudgetMs: 60 });
        return validWords(R, part.words);
      }
      const key = W.countsKey(R);
      if (key === lastKey && view.round - lastEvalRound < 8 && tot < P.forceDumpTiles) return [];
      lastKey = key;
      lastEvalRound = view.round;
      const part = W.bestPartition(R, { timeBudgetMs: 10 });
      if (part.words.length === 0) return [];
      if (tot >= P.forceDumpTiles) return validWords(R, part.words);

      const ctx = context(view, null);
      const ws = part.words;
      const m = ws.length;
      const rewards = ws.map((w) => W.reward(w));
      // leave after playing the first j words
      const leaves: Uint8Array[] = [];
      let cur: Uint8Array = Uint8Array.from(R);
      for (let j = 0; j < m; j++) {
        cur = W.subtractWord(cur, ws[j]!);
        leaves.push(Uint8Array.from(cur));
      }
      const cumReward: number[] = [];
      let acc = 0;
      for (let j = 0; j < m; j++) {
        acc += rewards[j]!;
        cumReward.push(acc);
      }
      const rnd = mulberry32((view.matchId * 7919 + view.round * 104729 + 17) >>> 0);
      const lossSum = new Float64Array(m);
      const t0 = now();
      let cnt = 0;
      while (cnt < 6) {
        const k = futureTiles(view, ctx, tot, rnd);
        const F = drawFuture(ctx.pool, k, rnd);
        const pAll = W.bestPartition(addCounts(R, F), { timeBudgetMs: 3 }).total;
        for (let j = 0; j < m; j++) {
          const pj = W.bestPartition(addCounts(leaves[j]!, F), { timeBudgetMs: 3 }).total;
          lossSum[j]! += pAll - cumReward[j]! - pj;
        }
        cnt++;
        if (cnt >= 2 && now() - t0 > P.wordsBudgetMs) break;
        if (now() - t0 > 4 * P.wordsBudgetMs) break;
      }
      let best = 0;
      for (let j = m - 1; j >= 0; j--) {
        const loss = Math.max(0, lossSum[j]! / cnt);
        if (loss <= P.eta * cumReward[j]!) {
          best = j + 1;
          break;
        }
      }
      if (best === 0) return [];
      return validWords(R, ws.slice(0, best));
    },

    bid(view, letter) {
      ensure(view);
      if (view.bagRemaining === 0) return 0;
      const bal = Math.max(0, Math.floor(view.myBalance));
      if (bal <= 0) return 0;
      const ctx = context(view, letter);
      const vPts = valuePts(view, letter, ctx);
      const vCoins = vPts * P.kappa * pace(view, ctx);
      let b: number;
      if (view.auctionType === "Vickrey") {
        b = vCoins;
      } else {
        const chat = priorPrice(letter, ctx.n) * 1.3 * ctx.priceRatio;
        b = Math.min(vCoins, chat * fpShade + 1);
      }
      let out = Math.round(b);
      if (out < 0) out = 0;
      if (out > bal) out = bal;
      lastBid = out;
      lastValue = vCoins;
      lastLetterAuction = view.round;
      return out;
    },

    onAuctionResult(view, rec: AuctionRecord) {
      ensure(view);
      if (view.auctionType !== "FirstPrice" || lastLetterAuction !== rec.round) return;
      if (rec.winnerBotId === view.myBotId) {
        fpShade = Math.max(0.7, fpShade - 0.03);
      } else if (rec.winnerBotId !== null && rec.paid < lastValue && lastBid > 0) {
        fpShade = Math.min(1.9, fpShade + 0.05);
      }
    },
  };
}

export function createStrategy(): Strategy {
  return createEconomist();
}

// Tuning hook: ECON_VARIANTS='{"name":{"kappa":2}}' registers extra named variants in the simulator registry.
// Unset in production, so this table is empty.
export const STRATEGIES: Record<string, () => Strategy> = (() => {
  const out: Record<string, () => Strategy> = {};
  try {
    const raw = typeof process !== "undefined" ? process.env["ECON_VARIANTS"] : undefined;
    if (raw) {
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, Partial<EconParams>>)) {
        out[k] = () => createEconomist(v, k);
      }
    }
  } catch {
    /* ignore malformed tuning input */
  }
  return out;
})();
