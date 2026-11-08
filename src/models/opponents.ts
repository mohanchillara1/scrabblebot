// Data-fitted opponent models for the tournament field.
//
// Fitted to the public match history (research/OPPONENTS.md has the evidence and the fit quality):
//   * 534 ended matches with six REAL bots each (11-07 14:14-18:04 CT), per-bot behaviour, market prices;
//   * tournament 1 (10-25), 10 older top bots.
// These are BEHAVIOURAL imitations, not reverse-engineered code: what the history lets us see is who won which
// letter at what price, which words were played when, and final balances. The models reproduce those summary
// statistics (see research/calibrate.ts); they do not claim to bid like the real bots on any single auction.
//
// Contract: src/core/types.ts. Self-contained (own dictionary helper in ./_lex.ts, no engine imports).
// Auto-registered by src/sim/registry.ts: every key of STRATEGIES becomes a strategy name.

import type { MatchView, Strategy, AuctionRecord } from "../core/types.js";
import { letterValueOf, lexicon, rackCounts } from "./_lex.js";

// ------------------------------------------------------------------------------------------------
// Parameters
// ------------------------------------------------------------------------------------------------

export interface OpponentParams {
  /** Name shown in reports. */
  name: string;
  /** Posted price of a value-1 letter before multipliers, and added price per extra letter-value point. */
  base: number;
  slope: number;
  /** Q is cheap in the data (paid ~20 vs Z ~30); multiply Q's posted price by this. */
  qMult: number;
  /** Persistent per-match bidder level: lognormal(median level, sd tau). */
  level: number;
  tau: number;
  /** Per-auction relative noise on the bid (Gaussian, sd as a fraction of the price). */
  sigma: number;
  /** Probability of not bidding at all in an auction (weak/passive bots). */
  skip: number;
  /** Price fades by fadeSlope per tile held above fadeAt (floor 0.45). */
  fadeAt: number;
  fadeSlope: number;
  /** Late-game boost: price *= 1 + lateK * (lateFrom - bagRemaining)/lateFrom when bagRemaining < lateFrom. */
  lateK: number;
  lateFrom: number;
  /** Vowel/consonant balance nudge: price *= 1 + balK when the letter fixes a rack outside [balLo, balHi] vowel share. */
  balK: number;
  balLo: number;
  balHi: number;
  /**
   * Cash pacing: the bot aims for balance(r) = 100 - (100 - paceEnd) * (r/68)^0.9 and scales its price by
   * clamp((balance / target)^paceK, 0.55, 1.6). paceK = 0 disables pacing. Words played earlier refill the balance,
   * so a bot with mid-game plays can afford to bid freely late (the real top bots win MORE tiles late, not fewer).
   */
  paceK: number;
  paceEnd: number;
  /** Opening boost: price *= 1 + earlyK * (earlyRounds - round)/earlyRounds for the first earlyRounds auctions. */
  earlyK: number;
  earlyRounds: number;
  /** In the very last auction (letter is worthless) a minority still bid. */
  lastBidProb: number;
  /**
   * Marginal-gain bidding: price *= 1 + gainK * clamp(g / gainScale, -0.4, 1.5) where g = value of the best
   * disjoint-word partition of (rack + letter) minus that of the rack. gainK = 0 turns it off (no dictionary scan).
   * Only used once at least gainFrom tiles are held.
   */
  gainK: number;
  gainScale: number;
  gainFrom: number;

  // ---- word policy ----
  /** Mid-game: play the best word of length >= midMinLen if its reward >= midMinReward ... */
  midMinLen: number;
  midMinReward: number;
  /** ... but only once bagRemaining <= holdUntilBag (hoarders hold; use 999 for "any time"). */
  holdUntilBag: number;
  /** When bagRemaining <= dumpAt, dump the whole rack greedily (min length 2) on every call. */
  dumpAt: number;
  /** Max words played in one words() call in mid-game. */
  maxMid: number;
  /**
   * Plan with the best disjoint-word partition of the rack instead of greedy best-word: mid-game plays are the
   * partition's words that pass the length/reward filter, the end-game dump plays the whole partition. Real top bots
   * realise ~94% of the hindsight-optimal partition of the tiles they hold (research/OPPONENTS.md); greedy play ~77%.
   */
  partition: boolean;
  /** Mid-game plays wait until at least this many tiles are held. */
  midMinHeld: number;
}

const COMMON = {
  base: 10.5,
  slope: 2.2,
  qMult: 0.7,
  tau: 0.25,
  sigma: 0.45,
  skip: 0,
  fadeAt: 5,
  fadeSlope: 0.035,
  lateK: 0.5,
  lateFrom: 40,
  earlyK: 0.4,
  earlyRounds: 8,
  paceK: 1.5,
  paceEnd: 22,
  balK: 0,
  balLo: 0.33,
  balHi: 0.5,
  gainK: 0,
  gainScale: 25,
  gainFrom: 5,
  lastBidProb: 0.4,
  maxMid: 2,
  partition: true,
  midMinHeld: 7,
} as const;

/**
 * Parameter sets, hand-tuned against research/calibrate.ts (observed-vs-simulated tables in research/OPPONENTS.md).
 * The bid-price block (base/slope/sigma/tau/early/late/pace) was tuned for the MARKET: simulated clearing prices by
 * letter class match the 534 observed all-real matches within ~5%. The word-policy block was tuned for BEHAVIOUR
 * (when words are played, how many, how long). Known gap: the simulated bots convert tiles to points less efficiently
 * than the real ones (see OPPONENTS.md "Fit quality"), so simulated scores run ~15-30% below observed.
 */
export const PARAMS: Record<string, OpponentParams> = {
  // GodOfThudner / Bron / RackMaw / LexForge-1107 / LUCENT: 14.5 letters/match, spend ~178, ~2.3 mid-game words
  // (half 7+) + ~1 end-game dump, first 7+ word around round 27, ends with ~20 cash. Pays up for high-value tiles.
  "topbot-like": {
    ...COMMON, name: "topbot-like", base: 9.5, slope: 3.0, level: 1.1, paceEnd: 18, gainK: 0.6,
    midMinLen: 7, midMinReward: 21, holdUntilBag: 999, dumpAt: 2,
  },
  // 181 LexiconWarrior, 180 StickBot, 179 exzell, 190 Karppa, 192 aipom, 172 Odysseus, 168 Malicious, 178 gas,
  // 186 Lucy, 209 N1gel, 195 Como Se Dice: 12.2 letters, spend ~156, ~2.1 mid words + 0.8 dump, score ~82.
  "mid-bot": {
    ...COMMON, name: "mid-bot", level: 1.0, paceEnd: 26,
    midMinLen: 6, midMinReward: 20, holdUntilBag: 999, dumpAt: 2,
  },
  // 201 Lbender, 191 Primey, 212 Astronaut, 167 Jaeger, 200 Milo: median word at round 63, 86% of words after round 34,
  // 60% after round 57, 10.8 letters, ~39 cash left unspent, score ~80.
  hoarder: {
    ...COMMON, name: "hoarder", level: 0.92, paceEnd: 39, lateK: 0.3,
    midMinLen: 7, midMinReward: 24, holdUntilBag: 30, dumpAt: 3,
  },
  // 164 Tow57, 166 SoapConsumers, 188 peanuts, 182 scrabblemaxxing, 183 QuertyBot, 162 Barracuda, 169, 165, 199, 202:
  // plays 5-6 letter words as soon as it can (median word round 41, almost no dump), cheaper tile taste, score ~64.
  "quick-cycler": {
    ...COMMON, name: "quick-cycler", slope: 1.5, base: 10.9, level: 0.94, paceEnd: 26, maxMid: 3, lateK: 0.2,
    midMinLen: 5, midMinReward: 14, holdUntilBag: 999, dumpAt: 2, midMinHeld: 5,
  },
  // 185 monkey, 194, 204, 173, 206, 205, 196, 174, 145 Afterword, 184 clud, 187, 175: 4.3 letters/match at normal
  // prices (they just do not bid on most auctions), score ~23, ~70 cash left over.
  "weak-passive": {
    ...COMMON, name: "weak-passive", level: 1.0, skip: 0.82, paceEnd: 70, paceK: 0, lateK: 0, earlyK: 0,
    midMinLen: 5, midMinReward: 14, holdUntilBag: 999, dumpAt: 2, maxMid: 1, midMinHeld: 5,
  },
};

// ------------------------------------------------------------------------------------------------
// Strategy
// ------------------------------------------------------------------------------------------------

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(a: number, b: number, c: number): number {
  let h = 2166136261 ^ a;
  h = Math.imul(h ^ b, 16777619);
  h = Math.imul(h ^ c, 16777619);
  h ^= h >>> 13;
  return h >>> 0;
}

function gauss(rng: () => number): number {
  // Box-Muller, one value
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

class Opponent implements Strategy {
  readonly name: string;
  private rng: () => number;
  private levelBot: number;

  constructor(
    private readonly p: OpponentParams,
    private readonly seed: number,
  ) {
    this.name = p.name;
    this.rng = mulberry32(hash3(seed, 1, 1));
    this.levelBot = p.level;
  }

  onMatchStart(view: MatchView): void {
    this.rng = mulberry32(hash3(this.seed, view.matchId, view.myBotId));
    this.levelBot = this.p.level * Math.exp(this.p.tau * gauss(this.rng));
  }

  private planKey = "";
  private plan: { word: string; reward: number; len: number }[] = [];
  private partitionOf(view: MatchView, c: Int32Array): { word: string; reward: number; len: number }[] {
    let key = "";
    for (const [l, n] of [...view.myRack].sort()) key += l + n;
    if (key !== this.planKey) {
      this.planKey = key;
      this.plan = lexicon().partition(c, 2, 30000);
    }
    return this.plan;
  }

  words(view: MatchView): string[] {
    const p = this.p;
    const c = rackCounts(view.myRack);
    let total = 0;
    for (let k = 0; k < 26; k++) total += c[k]!;
    if (total < 2) return [];
    const lex = lexicon();
    const out: string[] = [];

    if (view.bagRemaining <= p.dumpAt) {
      if (p.partition) for (const pk of this.partitionOf(view, c)) out.push(pk.word);
      else for (const pk of lex.dump(c, 2, 8)) out.push(pk.word);
      return out;
    }
    if (view.bagRemaining > p.holdUntilBag || total < p.midMinHeld) return out;
    if (p.partition) {
      for (const pk of this.partitionOf(view, c)) {
        if (out.length >= p.maxMid) break;
        if (pk.len >= p.midMinLen && pk.reward >= p.midMinReward) out.push(pk.word);
      }
      return out;
    }
    for (let i = 0; i < p.maxMid; i++) {
      const pk = lex.best(c, p.midMinLen);
      if (!pk || pk.reward < p.midMinReward) break;
      out.push(pk.word);
      for (let j = 0; j < pk.word.length; j++) c[pk.word.charCodeAt(j) - 65]!--;
    }
    return out;
  }

  bid(view: MatchView, letter: string): number {
    const p = this.p;
    const bal = view.myBalance;
    if (bal <= 0) return 0;
    if (view.bagRemaining === 0) {
      // Last auction: the tile cannot be used. A minority of real bots bid anyway.
      return this.rng() < p.lastBidProb ? Math.min(bal, 1 + Math.floor(this.rng() * 12)) : 0;
    }
    if (p.skip > 0 && this.rng() < p.skip) return 0;
    const v = letterValueOf(letter);
    let price = p.base + p.slope * (v - 1);
    if (letter === "Q") price *= p.qMult;
    price *= this.levelBot;

    let held = 0;
    for (const n of view.myRack.values()) held += n;
    price *= Math.max(0.45, 1 - p.fadeSlope * Math.max(0, held - p.fadeAt));

    if (p.lateK > 0 && view.bagRemaining < p.lateFrom) {
      price *= 1 + p.lateK * ((p.lateFrom - view.bagRemaining) / p.lateFrom);
    }
    if (p.balK > 0 && held >= 3) {
      let vow = 0;
      for (const [l, n] of view.myRack) if ("AEIOU".includes(l)) vow += n;
      const share = vow / held;
      const isV = "AEIOU".includes(letter);
      if ((share < p.balLo && isV) || (share > p.balHi && !isV)) price *= 1 + p.balK;
      else if ((share > p.balHi && isV) || (share < p.balLo && !isV)) price *= 1 - p.balK * 0.6;
    }
    if (p.gainK > 0 && held >= p.gainFrom) {
      const g = this.marginalGain(view, letter);
      price *= 1 + p.gainK * Math.max(-0.4, Math.min(1.5, g / p.gainScale));
    }
    if (p.paceK > 0) {
      const target = 100 - (100 - p.paceEnd) * Math.pow(Math.min(1, view.round / 68), 0.9);
      price *= Math.max(0.55, Math.min(1.6, Math.pow(Math.max(1, bal) / Math.max(5, target), p.paceK)));
    }
    if (p.earlyK > 0 && view.round < p.earlyRounds) price *= 1 + p.earlyK * ((p.earlyRounds - view.round) / p.earlyRounds);
    price *= 1 + p.sigma * gauss(this.rng);
    const b = Math.round(price);
    return Math.max(0, Math.min(bal, b));
  }

  private baseKey = "";
  private baseValue = 0;
  /** Partition value of rack+letter minus partition value of the rack (cached per rack). */
  private marginalGain(view: MatchView, letter: string): number {
    const lex = lexicon();
    const c = rackCounts(view.myRack);
    let key = "";
    for (const [l, n] of [...view.myRack].sort()) key += l + n;
    if (key !== this.baseKey) {
      this.baseKey = key;
      this.baseValue = lex.partition(c, 2, 8000).reduce((a, w) => a + w.reward, 0);
    }
    c[letter.charCodeAt(0) - 65]!++;
    const v1 = lex.partition(c, 2, 8000).reduce((a, w) => a + w.reward, 0);
    return v1 - this.baseValue;
  }

  onAuctionResult(_view: MatchView, _rec: AuctionRecord): void {
    /* stateless apart from the per-match level */
  }
}

export function makeOpponent(kind: string, seed = 0): Strategy {
  const p = PARAMS[kind];
  if (!p) throw new Error(`unknown opponent model "${kind}" (have: ${Object.keys(PARAMS).join(", ")})`);
  return new Opponent(p, seed);
}

/** Registered names -> factories (the sim registry passes a seed; plain `() => Strategy` callers get seed 0). */
export const STRATEGIES: Record<string, (seed?: number) => Strategy> = Object.fromEntries(
  Object.keys(PARAMS).map((k) => [k, (seed?: number) => makeOpponent(k, seed ?? 0)]),
);

// ------------------------------------------------------------------------------------------------
// Field mix (who a random seat is likely to be)
// ------------------------------------------------------------------------------------------------

/**
 * Observed composition of the 6-real-bot practice lobbies, 11-07 14:14-18:04 CT (534 matches, 3,204 seats).
 * `seatShare`: share of seats (weights heavy lobby-spammers like Bron/LUCENT more, as a lobby draw would).
 * `botShare`: share of distinct active bots (closer to a tournament Swiss draw, where each registered bot plays
 * the same number of rounds). Use botShare for tournament simulation.
 */
export const FIELD_MIX: Record<string, { seatShare: number; botShare: number; avgScore: number }> = {
  "topbot-like": { seatShare: 0.168, botShare: 5 / 45, avgScore: 99.1 },
  "mid-bot": { seatShare: 0.292, botShare: 11 / 45, avgScore: 82.3 },
  hoarder: { seatShare: 0.074, botShare: 5 / 45, avgScore: 80.0 },
  "quick-cycler": { seatShare: 0.309, botShare: 12 / 45, avgScore: 64.4 },
  "weak-passive": { seatShare: 0.129, botShare: 12 / 45, avgScore: 23.2 },
};

/** Draw n model names according to the mix (`weights` = "botShare" for tournaments, "seatShare" for lobbies). */
export function sampleField(n: number, rng: () => number, weights: "botShare" | "seatShare" = "botShare"): string[] {
  const names = Object.keys(FIELD_MIX);
  const w = names.map((k) => FIELD_MIX[k]![weights]);
  const tot = w.reduce((a, b) => a + b, 0);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let r = rng() * tot;
    let j = 0;
    while (j < names.length - 1 && r >= w[j]!) r -= w[j++]!;
    out.push(names[j]!);
  }
  return out;
}
