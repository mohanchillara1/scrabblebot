// "tuned": parametric heuristic bidder + partition-based word timing (label: tuned).
//
// BID    = expected clearing price of this letter (prior by table size x letter-value shape x observed level)
//          x desirability r(letter, rack) x cash-pace multiplier x auction-type multiplier,
//          blended in the last endK auctions with the EXACT marginal gain of the letter to the rack's best word partition.
//          Desirability = duplicate penalty, vowel/consonant balance, "word architect" completion boost
//          (the letter that completes a 7+ word from the rack is worth a lot, a dead letter little), face-value premium.
// WORDS  = cash a 7+ word at once, choosing the play with the best leave (W.bestPlayWithLeave); dump the optimal
//          partition during the last dumpK auctions; the last auction plays the whole rack.
//
// Level is learned from observed prices (second price in Vickrey, winning bid in FirstPrice), so the bid scale adapts to
// table size and field without hardcoding 6-player prices.

import type { MatchView, Strategy } from "../core/types.js";
import * as W from "../engine/words.js";

export interface TunedParams {
  vickMult: number; // bid / expected second price for a neutral letter (Vickrey)
  fpMult: number; // bid / expected winning bid for a neutral letter (FirstPrice)
  fpPrior: number; // initial level in FirstPrice (winning bids sit above Vickrey second prices)
  emaAlpha: number; // floor of the learning rate of the price level
  censUp: number; // level bump when I lose an auction at my own bid (Vickrey second price came from me: censored)
  censDown: number; // level shave when I win a FirstPrice auction (the competitors' best bid was below my bid)
  valK: number; // extra premium for high face value letters
  dupV: number; // per duplicate penalty (vowels)
  dupC: number; // per duplicate penalty (consonants)
  balK: number; // vowel/consonant balance sensitivity
  vowelTarget: number;
  synK: number; // boost for the letter that completes a 7+ word (missing == 1)
  syn2K: number; // boost for letters on the way to a 7+ word (missing == 2)
  deadK: number; // penalty for letters outside every near word (missing <= 1)
  dead2K: number; // same for missing == 2
  paceK: number;
  paceEnd: number; // target balance falls to (1 - paceEnd) * 100 by the end
  paceLo: number;
  paceHi: number;
  fadeAt: number; // rack size where price starts to fall
  fadeK: number;
  endK: number; // number of final auctions where partition gain takes over
  endMult: number; // bid = gain * endMult in the end phase
  capFrac: number; // max share of balance in one bid before the end phase
  floorBid: number;
  playMinLen: number;
  leaveTile: number; // value of each kept tile
  leaveDup: number; // penalty per duplicate kept
  leaveBal: number; // penalty per tile of vowel imbalance in the leave
  dumpK: number; // from this many auctions before the end, dump the optimal partition
  liqBal: number; // liquidity play when balance is below this (0 = off)
  liqMinReward: number;
}

export const DEFAULT_PARAMS: TunedParams = {
  vickMult: 0.8,
  fpMult: 1.05,
  fpPrior: 1.3,
  emaAlpha: 0.12,
  censUp: 0.05,
  censDown: 0.03,
  valK: 0.15,
  dupV: 0.07,
  dupC: 0.12,
  balK: 0.12,
  vowelTarget: 0.4,
  synK: 0.4,
  syn2K: 0.2,
  deadK: 0.3,
  dead2K: 0.1,
  paceK: 0.8,
  paceEnd: 0.95,
  paceLo: 0.55,
  paceHi: 1.5,
  fadeAt: 12,
  fadeK: 0.03,
  endK: 5,
  endMult: 1.3,
  capFrac: 0.7,
  floorBid: 1,
  playMinLen: 7,
  leaveTile: 4.2,
  leaveDup: 1.2,
  leaveBal: 0.8,
  dumpK: 1,
  liqBal: 8,
  liqMinReward: 8,
};

// FirstPrice-tuned differences (tuned vs the data-fitted field in FirstPrice, 6 players)
export const FIRSTPRICE_OVERRIDES: Partial<TunedParams> = {"fpMult": 0.95, "valK": 0, "paceK": 1.2, "endMult": 1.6};

// Per-table-size differences found by tuning against the data-fitted field (Vickrey): heads-up wants a higher
// bid multiplier, three players wants weaker cash pacing. Other sizes use DEFAULT_PARAMS.
export const BY_PLAYERS_VICKREY: Record<number, Partial<TunedParams>> = {
  2: { vickMult: 0.95 },
  3: { paceK: 0.4 },
};

const A = 65;
const VOWEL = new Uint8Array(26);
for (const ch of "AEIOU") VOWEL[ch.charCodeAt(0) - A] = 1;
const QI = 16;
const UI = 20;

function prior1(n: number): number {
  if (n <= 1) return 3;
  if (n >= 7) return 12.6 + 1.2 * (n - 7);
  return [0, 3, 4.6, 6.3, 7.7, 8.6, 10.7][n]!;
}

function shape(v: number, li: number): number {
  const s = 0.77 + 0.215 * v;
  return li === QI ? s * 0.66 : s;
}

interface MatchState {
  matchId: number;
  level: number;
  nObs: number;
  seen: number; // auctionHistory entries already folded in
  myBids: Map<number, number>; // round -> my bid
}

export function createStrategy(overrides?: Partial<TunedParams>): Strategy {
  W.warmUp(); // load the dictionary now, not inside the first words() call
  const ov = typeof overrides === "object" && overrides !== null ? overrides : {};
  const cache = new Map<string, TunedParams>();
  function paramsFor(type: string, n: number): TunedParams {
    const key = `${type}:${n}`;
    let p = cache.get(key);
    if (!p) {
      p = type === "FirstPrice"
        ? { ...DEFAULT_PARAMS, ...FIRSTPRICE_OVERRIDES, ...ov }
        : { ...DEFAULT_PARAMS, ...(BY_PLAYERS_VICKREY[n] ?? {}), ...ov };
      cache.set(key, p);
    }
    return p;
  }
  let P: TunedParams = paramsFor("Vickrey", 6);
  let st: MatchState | null = null;
  // cache of minMissing per rack key
  let mmKey = "";
  let mmVal: W.MinMissingResult | null = null;

  function state(view: MatchView): MatchState {
    P = paramsFor(view.auctionType, view.players.length);
    if (!st || st.matchId !== view.matchId) {
      st = {
        matchId: view.matchId,
        level: view.auctionType === "FirstPrice" ? P.fpPrior : 1,
        nObs: 0,
        seen: 0,
        myBids: new Map(),
      };
    }
    return st;
  }

  function learn(view: MatchView, s: MatchState): void {
    const hist = view.auctionHistory;
    if (s.seen > hist.length) s.seen = 0;
    const n = view.players.length;
    const p1 = prior1(n);
    while (s.seen < hist.length) {
      const rec = hist[s.seen++]!;
      if (rec.winnerBotId === null) continue;
      const li = rec.letter.charCodeAt(0) - A;
      if (li < 0 || li > 25) continue;
      const v = W.LETTER_VALUES[li]!;
      const mine = s.myBids.get(rec.round);
      const iWon = rec.winnerBotId === view.myBotId;
      if (view.auctionType === "Vickrey") {
        // censored: I was a losing bidder and the price equals my own bid (the second price came from me)
        if (!iWon && mine !== undefined && mine > 0 && rec.paid === mine) {
          s.level *= 1 + P.censUp;
          continue;
        }
      } else if (iWon) {
        // FirstPrice win: paid is my own bid; the competition's best bid was lower. Shave slowly.
        s.level *= 1 - P.censDown;
        continue;
      }
      const ratio = rec.paid / (p1 * shape(v, li));
      const k = s.nObs++;
      const alpha = Math.max(P.emaAlpha, 1 / (k + 4));
      s.level += alpha * (Math.min(4, ratio) - s.level);
    }
    s.level = Math.min(3, Math.max(0.2, s.level));
  }

  // unseen tiles = bag - auctioned (closed history + current) - my starting rack; includes future bag and others' starting racks
  function unseenPool(view: MatchView, counts: W.Counts, current: string | null): Float64Array {
    const pool = new Float64Array(26);
    for (let i = 0; i < 26; i++) pool[i] = W.BAG_COUNTS[i]!;
    const mine = Int32Array.from(counts);
    for (const w of view.wordHistory) {
      if (w.botId !== view.myBotId) continue;
      for (let i = 0; i < w.word.length; i++) mine[w.word.charCodeAt(i) - A]!++;
    }
    for (const a of view.auctionHistory) {
      const li = a.letter.charCodeAt(0) - A;
      if (li >= 0 && li < 26) {
        pool[li]!--;
        if (a.winnerBotId === view.myBotId) mine[li]!--;
      }
    }
    if (current) {
      const li = current.charCodeAt(0) - A;
      if (li >= 0 && li < 26) pool[li]!--;
    }
    for (let i = 0; i < 26; i++) pool[i] = Math.max(0, pool[i]! - Math.max(0, mine[i]!));
    return pool;
  }

  function leaveFn(leave: W.Counts): number {
    let tiles = 0;
    let vow = 0;
    let val = 0;
    let dup = 0;
    for (let i = 0; i < 26; i++) {
      const c = leave[i]!;
      if (c === 0) continue;
      tiles += c;
      if (VOWEL[i]) vow += c;
      val += c * (P.leaveTile + 0.12 * W.LETTER_VALUES[i]!);
      if (c > 1) dup += c - 1;
      if (i === QI && !leave[UI]) val -= 3.5;
      if (i === 18) val += 1.2 * c; // S
    }
    const imb = Math.abs(vow - P.vowelTarget * tiles);
    return val - P.leaveDup * dup - P.leaveBal * imb;
  }

  function validate(rack: W.Counts, words: string[]): string[] {
    const c = Int32Array.from(rack);
    const out: string[] = [];
    for (const w of words) {
      if (!W.isWord(w)) continue;
      let ok = true;
      for (let i = 0; i < w.length; i++) {
        const li = w.charCodeAt(i) - A;
        if (li < 0 || li > 25 || c[li]! <= 0) {
          ok = false;
          // undo partial
          for (let j = 0; j < i; j++) c[w.charCodeAt(j) - A]!++;
          break;
        }
        c[li]!--;
      }
      if (ok) out.push(w);
    }
    return out;
  }

  return {
    name: "tuned",

    words(view: MatchView): string[] {
      state(view);
      const counts = W.rackToCounts(view.myRack);
      const tiles = W.totalTiles(counts);
      if (tiles < 2) return [];
      if (view.bagRemaining === 0) {
        const r = W.bestPartition(counts, { timeBudgetMs: 40 });
        return validate(counts, r.words);
      }
      if (view.bagRemaining <= P.dumpK) {
        const r = W.bestPartition(counts, { timeBudgetMs: 25 });
        return validate(counts, r.words);
      }
      let sevenPlus = 0;
      const byLen = W.playableByLength(counts);
      for (let l = P.playMinLen; l < byLen.length; l++) sevenPlus += byLen[l]!;
      if (sevenPlus > 0) {
        const r = W.bestPlayWithLeave(counts, leaveFn, { minLen: P.playMinLen, maxWords: 2, timeBudgetMs: 10 });
        if (r.words.length > 0) return validate(counts, r.words);
      }
      if (P.liqBal > 0 && view.myBalance < P.liqBal) {
        const r = W.bestPlayWithLeave(counts, leaveFn, { minLen: 4, maxWords: 1, timeBudgetMs: 6 });
        if (r.words.length > 0 && r.reward >= P.liqMinReward) return validate(counts, r.words);
      }
      return [];
    },

    bid(view: MatchView, letter: string): number {
      const s = state(view);
      learn(view, s);
      const bal = Math.floor(view.myBalance);
      const li = letter.charCodeAt(0) - A;
      if (view.bagRemaining === 0 || bal < 1 || li < 0 || li > 25) {
        s.myBids.set(view.round, 0);
        return 0;
      }
      const counts = W.rackToCounts(view.myRack);
      const tiles = W.totalTiles(counts);
      const n = view.players.length;
      const v = W.LETTER_VALUES[li]!;
      const isV = VOWEL[li]!;
      const have = counts[li]!;

      let price = prior1(n) * shape(v, li) * s.level;

      // --- desirability ---
      let r = 1;
      r *= Math.max(0.45, 1 - (isV ? P.dupV : P.dupC) * have);
      if (tiles >= 4) {
        let V = 0;
        for (let i = 0; i < 26; i++) if (VOWEL[i]) V += counts[i]!;
        const d = V - P.vowelTarget * tiles;
        const d2 = d + isV - P.vowelTarget;
        r *= Math.min(1.35, Math.max(0.7, 1 + P.balK * (Math.abs(d) - Math.abs(d2))));
      }
      r *= 1 + (P.valK * (v - 1)) / 9;
      if (li === QI && !counts[UI]) r *= 0.6;
      r *= Math.max(0.5, 1 - P.fadeK * Math.max(0, tiles - P.fadeAt));

      // word-architect completion boost
      if (tiles >= 4) {
        const key = W.countsKey(counts);
        if (key !== mmKey || !mmVal) {
          mmVal = W.minMissing(counts, { minLen: 7 });
          mmKey = key;
        }
        const mm = mmVal;
        if (mm.missing === 1) {
          if (mm.letterWords[li]! > 0) {
            const pool = unseenPool(view, counts, letter);
            const frac = view.bagRemaining / (view.bagRemaining + (n - 1) * view.startingRackSize + 1e-9);
            const e = pool[li]! * frac * Math.min(1, view.bagRemaining / 20);
            const scarcity = 1 / (1 + 0.15 * e);
            const worth = 0.5 + 0.5 * Math.min(1, mm.bestReward / 40);
            r *= 1 + P.synK * worth * (0.4 + 0.6 * scarcity * 1.6);
          } else if (tiles >= 6) r *= 1 - P.deadK;
        } else if (mm.missing === 2) {
          if (mm.letterWords[li]! > 0) r *= 1 + P.syn2K;
          else if (tiles >= 7) r *= 1 - P.dead2K;
        }
      }

      // --- cash pacing ---
      const total = view.round + view.bagRemaining;
      const prog = Math.min(1, Math.max(0, (view.round - 1) / total));
      const target = Math.max(8, 100 * (1 - P.paceEnd * prog));
      const pace = Math.min(P.paceHi, Math.max(P.paceLo, Math.pow(Math.max(0.05, view.myBalance) / target, P.paceK)));

      const am = view.auctionType === "FirstPrice" ? P.fpMult : P.vickMult;
      let bid = price * r * pace * am;

      // --- end phase: exact marginal partition gain ---
      let endPhase = false;
      if (view.bagRemaining <= P.endK) {
        endPhase = true;
        const gain = Math.max(0, W.letterGain(counts, li, 5));
        const w = (P.endK - view.bagRemaining + 1) / (P.endK + 1);
        bid = (1 - w) * bid + w * gain * P.endMult;
      }

      if (!endPhase) bid = Math.min(bid, P.capFrac * bal);
      let out = Math.round(bid);
      if (out < P.floorBid && r > 0.6 && tiles < 24 && !endPhase) out = P.floorBid;
      out = Math.max(0, Math.min(bal, out));
      s.myBids.set(view.round, out);
      return out;
    },
  };
}

export default createStrategy;
