// mcvalue: Monte-Carlo valuation strategy (label: mcvalue).
//
// Idea
//   score = sum of the word rewards I play, and the best a rack can ever yield is its best disjoint-word partition
//   P(rack). The marginal value of the auctioned letter L is therefore
//         V(L) = E_F[ P(R + F + L) - P(R + F) ]
//   where R is my rack after this turn's plays and F is the set of letters I will still win. F is sampled
//   (common random numbers for with / without) from the estimated unseen pool = 98-tile bag minus every letter
//   publicly seen (auctions, my own starting rack, starting-rack letters revealed by other players' words).
//   Value is converted to a bid by a "cash per point" rate anchored on the clearing price observed in this match
//   (prior by table size), scaled by a pace factor that tracks whether my cash can fund the tiles still on offer.
//   Vickrey: bid the truthful cash value. FirstPrice: shade toward the (estimated) clearing price of that letter.
//
// Words: play partition words that are final-ish (>= playMinLen letters), play everything when the bag is nearly
// empty (bagRemaining <= endN), play cheap words too when cash is short.

import type { AuctionRecord, MatchView, Strategy } from "../core/types.js";
import * as W from "../engine/words.js";

export interface McParams {
  /** cash multiplier on the value-ratio bid (beta) */
  beta: number;
  /** exponent on V / Vref */
  gamma: number;
  /** pace factor = clamp((mRaw/nf)^zeta, kmin, kmax) */
  zeta: number;
  /** target share of remaining auctions I want to win = min(1, qMult / players) */
  qMult: number;
  kmin: number;
  kmax: number;
  /** feedback pace on the cash trajectory (0 = off): clamp(((bal+1)/(target+1))^paceK, p2min, p2max) */
  paceK: number;
  p2min: number;
  p2max: number;
  endBal: number;
  /** 1 = use the mRaw/(nf*q) pace, 0 = ignore it */
  useOld: number;
  /** share of word rewards assumed to be re-spendable */
  incomeShare: number;
  /** cap on look-ahead tiles in the valuation */
  mCap: number;
  /** MC scenarios (max) and time guard (ms) for one bid() */
  scenarios: number;
  bidBudgetMs: number;
  /** word policy */
  playMinLen: number;
  endN: number;
  cashLow: number;
  pressureMinReward: number;
  /** FirstPrice shading */
  fpOver: number;
  fpLowShade: number;
}

export const DEFAULTS: McParams = {
  beta: 0.8,
  gamma: 1.0,
  zeta: 0.5,
  qMult: 2.4,
  kmin: 0.6,
  kmax: 1.8,
  paceK: 1.0,
  p2min: 0.6,
  p2max: 2.0,
  endBal: 15,
  useOld: 1,
  incomeShare: 0.8,
  mCap: 8,
  scenarios: 8,
  bidBudgetMs: 16,
  playMinLen: 7,
  endN: 3,
  cashLow: 1.2,
  pressureMinReward: 9,
  fpOver: 1.1,
  fpLowShade: 0.85,
};

function envParams(): Partial<McParams> {
  try {
    const raw = process.env["MCV"];
    if (raw) return JSON.parse(raw) as Partial<McParams>;
  } catch {
    /* ignore */
  }
  return {};
}

// Prior price of an average tile (second price) by table size (tournament-1 all-letter prices; 6p from today).
const PRIOR_PRICE: Record<number, number> = { 1: 6, 2: 7.0, 3: 8.9, 4: 10.9, 5: 12.4, 6: 12.8, 7: 15.5, 8: 16.5 };
function priorPrice(nPlayers: number, fp: boolean): number {
  const p = PRIOR_PRICE[Math.min(Math.max(nPlayers, 1), 8)] ?? 16.5;
  return fp ? p * 1.2 : p;
}
const AVG_TILE_VALUE = 1.91;
function priceFactor(v: number): number {
  // observed: second price ~ 8 + 2.2 * face value, normalised to an average tile
  return (8 + 2.2 * v) / (8 + 2.2 * AVG_TILE_VALUE);
}

function mulberry32(a: number): () => number {
  let s = a >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACODE = 65;

interface PoolInfo {
  unseen: Int32Array; // letters not publicly seen and not mine
  total: number;
}

function computePool(view: MatchView, letter: string): PoolInfo {
  const u = new Int32Array(26);
  for (let i = 0; i < 26; i++) u[i] = W.BAG_COUNTS[i]!;
  const sub = (c: string, k = 1) => {
    const i = c.charCodeAt(0) - ACODE;
    if (i >= 0 && i < 26) u[i]! -= k;
  };
  for (const a of view.auctionHistory) sub(a.letter);
  if (letter) sub(letter);
  // my starting rack = rack + letters I played - letters I won
  const me = view.myBotId;
  const start = new Int32Array(26);
  for (const [c, k] of view.myRack) {
    const i = c.charCodeAt(0) - ACODE;
    if (i >= 0 && i < 26) start[i]! += k;
  }
  const won: Int32Array[] = [];
  const idx = new Map<number, number>();
  const getW = (id: number) => {
    let j = idx.get(id);
    if (j === undefined) {
      j = won.length;
      idx.set(id, j);
      won.push(new Int32Array(26));
    }
    return won[j]!;
  };
  for (const a of view.auctionHistory) {
    if (a.winnerBotId === null) continue;
    const i = a.letter.charCodeAt(0) - ACODE;
    if (i >= 0 && i < 26) getW(a.winnerBotId)[i]!++;
  }
  const played = new Map<number, Int32Array>();
  for (const w of view.wordHistory) {
    let arr = played.get(w.botId);
    if (!arr) {
      arr = new Int32Array(26);
      played.set(w.botId, arr);
    }
    for (let k = 0; k < w.word.length; k++) {
      const i = w.word.charCodeAt(k) - ACODE;
      if (i >= 0 && i < 26) arr[i]!++;
    }
  }
  for (const [id, arr] of played) {
    const wn = getW(id);
    for (let i = 0; i < 26; i++) {
      const extra = arr[i]! - wn[i]!; // played more than won => came from the (hidden) starting rack
      if (id === me) {
        // my own starting letters: rack + played - won  (ok if negative->0)
        start[i]! += arr[i]!;
      } else if (extra > 0) {
        u[i]! -= extra;
      }
    }
  }
  const mine = getW(me);
  for (let i = 0; i < 26; i++) {
    start[i]! = Math.max(0, start[i]! - mine[i]!);
    u[i]! -= start[i]!;
  }
  let total = 0;
  for (let i = 0; i < 26; i++) {
    if (u[i]! < 0) u[i] = 0;
    total += u[i]!;
  }
  return { unseen: u, total };
}

function sampleFuture(pool: PoolInfo, m: number, rnd: () => number, out: Uint8Array): void {
  const u = Int32Array.from(pool.unseen);
  let tot = pool.total;
  out.fill(0);
  for (let k = 0; k < m && tot > 0; k++) {
    let r = Math.floor(rnd() * tot);
    let i = 0;
    for (; i < 26; i++) {
      if (r < u[i]!) break;
      r -= u[i]!;
    }
    if (i >= 26) break;
    out[i]!++;
    u[i]!--;
    tot--;
  }
}

/** Market price of an average tile, from this match's recent clearing prices (prior for the table size). */
function marketPrice(view: MatchView, fp: boolean): number {
  const prior = priorPrice(view.players.length, fp);
  const hist = view.auctionHistory;
  let num = prior * 4;
  let den = 4;
  let taken = 0;
  let wgt = 1;
  for (let i = hist.length - 1; i >= 0 && taken < 24; i--) {
    const a = hist[i]!;
    if (a.winnerBotId === null) continue;
    if (fp && a.winnerBotId === view.myBotId) continue;
    const v = W.letterValue(a.letter);
    if (v <= 0) continue;
    if (a.paid <= 1 && !fp && i === hist.length - 1 && false) continue;
    num += (wgt * a.paid) / priceFactor(v);
    den += wgt;
    wgt *= 0.92;
    taken++;
  }
  return num / den;
}

/** Table-size schedule (tuned in the simulator vs the data-fitted models; N>=6 uses DEFAULTS). */
function scheduleFor(nPlayers: number): Partial<McParams> {
  if (nPlayers <= 2) return { beta: 1.8, gamma: 0.2, paceK: 1.5, p2max: 4 };
  if (nPlayers === 3) return { beta: 1.4, gamma: 0.5, paceK: 1.5, p2max: 4 };
  if (nPlayers === 4) return { beta: 1.0, gamma: 0.8, paceK: 1.2, p2max: 3 };
  if (nPlayers === 5) return { beta: 0.9, gamma: 0.9, paceK: 1.0, p2max: 2.5 };
  return {};
}

export function createStrategy(): Strategy {
  const ENV = envParams();
  const PK = new Map<number, McParams>();
  const paramsFor = (n: number): McParams => {
    const key = Math.min(Math.max(n, 1), 6);
    let r = PK.get(key);
    if (!r) {
      r = { ...DEFAULTS, ...scheduleFor(key), ...ENV };
      PK.set(key, r);
    }
    return r;
  };
  W.warmUp();

  const partOf = (c: W.Counts, ms: number) => W.bestPartition(c, { timeBudgetMs: ms });

  function wordsFor(view: MatchView): string[] {
    const P = paramsFor(view.players.length);
    const R = W.rackToCounts(view.myRack);
    const t = W.totalTiles(R);
    if (t < 2) return [];
    const n = view.bagRemaining;
    const fp = view.auctionType === "FirstPrice";
    const part = partOf(R, n <= 1 ? 30 : 8);
    if (part.words.length === 0) return [];
    if (n <= P.endN) return part.words.slice();
    const out: string[] = [];
    const pbar = marketPrice(view, fp);
    const poor = view.myBalance < P.cashLow * pbar;
    for (const w of part.words) {
      if (w.length >= P.playMinLen) out.push(w);
      else if (poor && W.reward(w) >= P.pressureMinReward) out.push(w);
    }
    return out;
  }

  function bidFor(view: MatchView, letter: string): number {
    const P = paramsFor(view.players.length);
    const n = view.bagRemaining;
    const bal = view.myBalance;
    if (bal < 1 || n < 1) return 0;
    const Lc = letter.charCodeAt(0) - ACODE;
    if (Lc < 0 || Lc > 25) return 0;
    const fp = view.auctionType === "FirstPrice";
    const nf = Math.max(n - 1, 0);
    const R = W.rackToCounts(view.myRack);
    const pbar = marketPrice(view, fp);
    const pool = computePool(view, letter);

    const Pr = partOf(R, 4).total;
    const s = P.incomeShare;
    const netCost = Math.max(pbar - s * 5.0, 0.3 * pbar);
    const mRaw = (bal + s * Pr) / netCost;
    const m = Math.max(0, Math.min(Math.round(mRaw), nf, P.mCap));

    // Monte-Carlo valuation with common random numbers
    const rnd = mulberry32(((view.matchId * 7919 + view.round * 104729 + view.myBotId * 15485863) >>> 0) || 1);
    const F = new Uint8Array(26);
    const A = new Uint8Array(26);
    const B = new Uint8Array(26);
    const t0 = performance.now();
    let sumDiff = 0;
    let sumP0 = 0;
    let cnt = 0;
    const S = m === 0 ? 1 : P.scenarios;
    for (let sIdx = 0; sIdx < S; sIdx++) {
      sampleFuture(pool, m, rnd, F);
      for (let i = 0; i < 26; i++) A[i] = R[i]! + F[i]!;
      B.set(A);
      B[Lc]!++;
      const p0 = partOf(A, 3).total;
      const p1 = partOf(B, 3).total;
      sumDiff += p1 - p0;
      sumP0 += p0;
      cnt++;
      if (cnt >= 3 && performance.now() - t0 > P.bidBudgetMs) break;
    }
    const V = sumDiff / cnt;
    if (V <= 0.15) return 0;
    const tilesAfter = W.totalTiles(R) + m;
    // reference value of an average tile at that rack size
    let vref = tilesAfter > 0 ? sumP0 / cnt / tilesAfter : 5;
    vref = Math.min(Math.max(vref, 3), 8);
    const ratio = Math.pow(V / vref, P.gamma);
    const q = Math.min(1, P.qMult / Math.max(view.players.length, 1));
    const pace = nf > 0 ? Math.min(Math.max(Math.pow(mRaw / (nf * q), P.zeta), P.kmin), P.kmax) : P.kmax;
    let pace2 = 1;
    if (P.paceK > 0) {
      const f = view.round / Math.max(1, view.round + n);
      const g = Math.pow(f, 0.9);
      const target = 100 * (1 - g) + P.endBal * g;
      pace2 = Math.min(Math.max(Math.pow((bal + 1) / (target + 1), P.paceK), P.p2min), P.p2max);
    }
    const kappa = P.beta * pbar * (P.useOld ? pace : 1) * pace2;
    let truthful = kappa * ratio;

    let b: number;
    if (!fp) {
      b = truthful;
    } else {
      const mkt = pbar * priceFactor(W.letterValue(letter));
      if (truthful >= mkt * P.fpOver) b = mkt * P.fpOver;
      else b = truthful * P.fpLowShade;
    }
    b = Math.floor(b + 0.5);
    if (b < 1) b = 1;
    if (b > bal) b = Math.floor(bal);
    return b;
  }

  return {
    name: "mcvalue",
    words: wordsFor,
    bid: bidFor,
    onAuctionResult(_v: MatchView, _r: AuctionRecord) {
      /* stateless: everything is derived from the view */
    },
  };
}
