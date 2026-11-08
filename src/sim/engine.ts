// Faithful offline replica of the ScrabbleBot match engine (upstream spacetimedb/src/game.ts).
//
// What is replicated (see docs/GAME_SPEC.md; the server source wins on any disagreement):
//   * 98-tile bag, uniform draw over remaining tiles (modelled as a seeded permutation read in order).
//   * startingRackSize tiles dealt to each seat in seat order, THEN the first auction letter is drawn.
//   * One auction at a time. Only bids > 0 count. Equal bids are shuffled (Fisher-Yates) then stable-sorted.
//     Vickrey: winner pays the 2nd-highest bid, or min(1, top) if sole bidder. FirstPrice: winner pays own bid.
//     The winner receives the letter ONLY IF balance >= paid. No positive bid => the letter is DISCARDED.
//   * Sim bots bid at auction open from their balance at that moment; a sim winner immediately plays
//     findBestPlayable(rack, 3) (longest word, lexicographically first among equals).
//   * The match ends right after the auction opened with bagRemaining == 0 closes (sim word play still happens).
//   * reward = floor(base * num / den), credited to BOTH balance and score.
//
// Per auction the order is: sims bid -> every real strategy's words(view) (all views built from one snapshot of
// the public state taken at open) -> plays applied -> every real strategy's bid(view, letter) -> close ->
// sim winner word play -> onAuctionResult for every real strategy.
//
// Strategy faults are never silently accepted: invalid / unspellable words, over-balance or malformed bids and
// thrown exceptions are counted per seat in MatchResult.seats[i].errors.

import type {
  AuctionRecord,
  AuctionType,
  MatchView,
  PlayerPublic,
  SimStrategyTag,
  Strategy,
  WordRecord,
} from "../core/types.js";
import { BAG_SIZE, checkWord, findBestPlayableCounts, fullBagIndices, indexLetter, letterIndex, LETTER_VALUES, wordReward } from "./dict.js";
import { hash32, intInRange, mulberry32, shuffleInPlace } from "./rng.js";

// ---------- Constants ----------

export const STARTING_BALANCE = 100;
export const AUCTION_RESERVE = 1;
export const SIM_BID_JITTER = 2;
export const SIM_MIN_WORD_LEN = 3;
export const DEFAULT_AUCTION_DURATION_MS = 1000;

/** The six seeded sim bots (index.ts init). */
export const SIM_BOTS: readonly { name: string; tag: SimStrategyTag }[] = [
  { name: "Cheapo-sim", tag: "Cheapskate" },
  { name: "Valor-sim", tag: "ValueBidder" },
  { name: "Brutus-sim", tag: "Aggressive" },
  { name: "Hagrid-sim", tag: "ValueBidder" },
  { name: "Maverick-sim", tag: "Aggressive" },
  { name: "Snippet-sim", tag: "Cheapskate" },
];

// ---------- Participants and results ----------

export interface RealParticipant {
  kind: "real";
  name: string;
  strategy: Strategy;
}
export interface SimParticipant {
  kind: "sim";
  name: string;
  tag: SimStrategyTag;
}
export type Participant = RealParticipant | SimParticipant;

export interface SeatErrors {
  /** Word not A-Z / < 2 letters, or not in the wordlist. The word is rejected (as the server would). */
  invalidWords: number;
  /** Valid dictionary word but the rack lacked the tiles. Rejected. */
  unspellableWords: number;
  /** bid() returned more than the balance. Treated as 0 (the server rejects the reducer call). */
  overBalanceBids: number;
  /** bid() returned a non-integer / negative / non-number. Treated as 0. */
  badBids: number;
  /** words() returned something that is not an array. Treated as []. */
  badReturns: number;
  /** A strategy method threw. Treated as no words / bid 0 / ignored. */
  exceptions: number;
  firstError?: string;
}

export interface SeatTiming {
  wordsCalls: number;
  wordsMs: number;
  wordsMaxMs: number;
  bidCalls: number;
  bidMs: number;
  bidMaxMs: number;
  otherCalls: number; // onMatchStart + onAuctionResult
  otherMs: number;
  otherMaxMs: number;
}

export interface SeatResult {
  seat: number;
  botId: number;
  name: string;
  kind: "real" | "sim";
  simTag?: SimStrategyTag;
  score: number;
  balance: number;
  /** 1 = best; tied scores share the better place. */
  place: number;
  /** max(players - place, 0), the Swiss points of a tournament table. */
  swiss: number;
  /** place === 1 (ties for the top score all count as winners, like the server's `wasWin`). */
  win: boolean;
  tilesLeft: number;
  wordsPlayed: number;
  auctionsWon: number;
  spent: number;
  errors: SeatErrors;
  timing: SeatTiming;
}

export interface MatchResult {
  auctions: number; // auctions run (== 98 - players * rack when nothing is skipped)
  discarded: number; // letters nobody bought
  seats: SeatResult[];
}

export type EngineEvent =
  | { type: "deal"; seat: number; letters: string }
  | { type: "open"; round: number; letter: string; bagRemaining: number }
  | { type: "bids"; round: number; bids: { seat: number; amount: number; source: "sim" | "real" }[] }
  | {
      type: "close";
      round: number;
      letter: string;
      winnerSeat: number; // -1 = no positive bid
      topBid: number;
      paid: number;
      received: boolean;
    }
  | { type: "word"; round: number; seat: number; word: string; reward: number; by: "sim" | "real"; rackBefore: string }
  | { type: "reject"; round: number; seat: number; word: unknown; reason: "format" | "not-in-dictionary" | "unspellable" }
  | { type: "end"; auctions: number };

export interface MatchConfig {
  auctionType: AuctionType;
  /** Tiles dealt to every seat at the start (server default 5). */
  startingRackSize?: number;
  auctionDurationMs?: number;
  /** Shown to strategies as view.matchId. */
  matchId?: number;
  /** Keys all randomness other than strategies' own (jitter, tie-break, the default bag). */
  seed?: number;
  matchIndex?: number;
  /** Explicit draw order, letter indices 0..25, length 98. Default: makeBag(seed, matchIndex). */
  bag?: ArrayLike<number>;
  /** Per-seat strategy `Math.random` is replaced by a seeded PRNG while strategies run (default true). */
  seedMathRandom?: boolean;
  onEvent?: (e: EngineEvent) => void;
}

// ---------- Bag ----------

/** The draw order for match `matchIndex` under `seed`: a seeded random permutation of the 98 tiles. */
export function makeBag(seed: number, matchIndex: number): Uint8Array {
  const bag = fullBagIndices();
  const rng = mulberry32(hash32(seed, matchIndex, 1));
  shuffleInPlace(bag as unknown as number[], rng);
  return bag;
}

// ---------- Sim bot bidding (game.ts decideBid) ----------

export function simDecideBid(tag: SimStrategyTag, letter: string, balance: number, jitter: number): number {
  const value = LETTER_VALUES[letterIndex(letter)]!;
  const isVowel = "AEIOU".includes(letter);
  let base: number;
  switch (tag) {
    case "Cheapskate":
      base = value - 1;
      break;
    case "ValueBidder":
      base = value;
      break;
    case "Aggressive":
      base = value + (isVowel ? 4 : 2);
      break;
  }
  return Math.max(Math.min(Math.max(base + jitter, 1), balance), 0);
}

// ---------- Auction resolution (game.ts closeAuction) ----------

export interface BidIn {
  seat: number;
  amount: number;
}
export interface AuctionOutcome {
  winner: number; // seat, -1 when there was no positive bid
  topBid: number;
  paid: number;
  /** false when balances[winner] < paid: nobody gets the letter and nothing is charged. */
  transferred: boolean;
}

export function resolveAuction(
  bids: BidIn[],
  balances: ArrayLike<number>,
  auctionType: AuctionType,
  rng: () => number,
): AuctionOutcome {
  const sorted = bids.filter((b) => b.amount > 0);
  shuffleInPlace(sorted, rng);
  sorted.sort((a, b) => b.amount - a.amount); // stable in modern V8: ties keep their shuffled order
  const first = sorted[0];
  const second = sorted[1];
  if (!first) return { winner: -1, topBid: 0, paid: 0, transferred: false };
  let paid: number;
  if (auctionType === "FirstPrice") paid = first.amount;
  else paid = second ? second.amount : Math.min(AUCTION_RESERVE, first.amount);
  return { winner: first.seat, topBid: first.amount, paid, transferred: balances[first.seat]! >= paid };
}

// ---------- The match ----------

function zeroErrors(): SeatErrors {
  return { invalidWords: 0, unspellableWords: 0, overBalanceBids: 0, badBids: 0, badReturns: 0, exceptions: 0 };
}
function zeroTiming(): SeatTiming {
  return {
    wordsCalls: 0, wordsMs: 0, wordsMaxMs: 0,
    bidCalls: 0, bidMs: 0, bidMaxMs: 0,
    otherCalls: 0, otherMs: 0, otherMaxMs: 0,
  };
}

interface Seat {
  seat: number;
  botId: number;
  p: Participant;
  isSim: boolean;
  rack: Int32Array; // letter index -> count
  rackTotal: number;
  balance: number;
  score: number;
  wordsPlayed: number;
  auctionsWon: number;
  spent: number;
  errors: SeatErrors;
  timing: SeatTiming;
  random: () => number;
}

function rackString(rack: Int32Array): string {
  let s = "";
  for (let i = 0; i < 26; i++) for (let k = 0; k < rack[i]!; k++) s += indexLetter(i);
  return s;
}

export function runMatch(participants: Participant[], cfg: MatchConfig): MatchResult {
  const P = participants.length;
  const R = cfg.startingRackSize ?? 5;
  const seed = cfg.seed ?? 1;
  const matchIndex = cfg.matchIndex ?? 0;
  const matchId = cfg.matchId ?? matchIndex + 1;
  const durationMs = cfg.auctionDurationMs ?? DEFAULT_AUCTION_DURATION_MS;
  const auctionType = cfg.auctionType;
  const emit = cfg.onEvent;
  if (P < 1) throw new Error("need at least one participant");
  if (P * R >= BAG_SIZE) throw new Error(`players*rack = ${P * R} leaves no tile to auction (bag has ${BAG_SIZE})`);
  const bag = cfg.bag ?? makeBag(seed, matchIndex);
  if (bag.length !== BAG_SIZE) throw new Error(`bag must have ${BAG_SIZE} tiles, got ${bag.length}`);

  const seats: Seat[] = participants.map((p, i) => ({
    seat: i,
    botId: i + 1,
    p,
    isSim: p.kind === "sim",
    rack: new Int32Array(26),
    rackTotal: 0,
    balance: STARTING_BALANCE,
    score: 0,
    wordsPlayed: 0,
    auctionsWon: 0,
    spent: 0,
    errors: zeroErrors(),
    timing: zeroTiming(),
    random: mulberry32(hash32(seed, matchIndex, 7, i)),
  }));
  const real = seats.filter((s) => !s.isSim);
  const sims = seats.filter((s) => s.isSim);

  // Strategies may call Math.random; make that deterministic per (seed, match, seat) while they run.
  const origRandom = Math.random;
  let curRandom: (() => number) | null = null;
  const seedMath = cfg.seedMathRandom !== false && real.length > 0;
  if (seedMath) Math.random = () => (curRandom ? curRandom() : origRandom());

  try {
    const auctionHistory: AuctionRecord[] = [];
    const wordHistory: WordRecord[] = [];
    let pos = 0;
    let discarded = 0;

    // ----- deal, in seat order -----
    for (const s of seats) {
      let letters = "";
      for (let n = 0; n < R; n++) {
        const l = bag[pos++]!;
        s.rack[l]!++;
        s.rackTotal++;
        if (emit) letters += indexLetter(l);
      }
      if (emit) emit({ type: "deal", seat: s.seat, letters });
    }

    let round = 1;
    let letterIdx = bag[pos++]!;

    // ----- view construction -----
    const makeView = (
      s: Seat,
      rd: number,
      bagRemaining: number,
      balances: ArrayLike<number>,
      scores: ArrayLike<number>,
      aLen: number,
      wLen: number,
    ): MatchView => {
      const players: PlayerPublic[] = new Array(P);
      for (let i = 0; i < P; i++) {
        const o = seats[i]!;
        const pp: PlayerPublic = { botId: o.botId, balance: balances[i]!, score: scores[i]!, isSim: o.isSim };
        if (o.p.kind === "sim") pp.simStrategy = o.p.tag;
        players[i] = pp;
      }
      const myRack = new Map<string, number>();
      for (let i = 0; i < 26; i++) if (s.rack[i]! > 0) myRack.set(indexLetter(i), s.rack[i]!);
      return {
        matchId,
        myBotId: s.botId,
        auctionType,
        auctionDurationMs: durationMs,
        startingRackSize: R,
        players,
        myRack,
        myBalance: balances[s.seat]!,
        myScore: scores[s.seat]!,
        round: rd,
        bagRemaining,
        auctionHistory: auctionHistory.slice(0, aLen),
        wordHistory: wordHistory.slice(0, wLen),
      };
    };
    const snapshotBalances = () => seats.map((x) => x.balance);
    const snapshotScores = () => seats.map((x) => x.score);

    // ----- guarded strategy calls (timing, exceptions, seeded Math.random) -----
    const guard = <T>(s: Seat, kind: "words" | "bid" | "other", fn: () => T): { ok: true; v: T } | { ok: false } => {
      const t0 = performance.now();
      if (seedMath) curRandom = s.random;
      try {
        return { ok: true, v: fn() };
      } catch (e) {
        s.errors.exceptions++;
        s.errors.firstError ??= e instanceof Error ? `${e.message}` : String(e);
        return { ok: false };
      } finally {
        curRandom = null;
        const dt = performance.now() - t0;
        const tm = s.timing;
        if (kind === "words") {
          tm.wordsCalls++;
          tm.wordsMs += dt;
          if (dt > tm.wordsMaxMs) tm.wordsMaxMs = dt;
        } else if (kind === "bid") {
          tm.bidCalls++;
          tm.bidMs += dt;
          if (dt > tm.bidMaxMs) tm.bidMaxMs = dt;
        } else {
          tm.otherCalls++;
          tm.otherMs += dt;
          if (dt > tm.otherMaxMs) tm.otherMaxMs = dt;
        }
      }
    };

    // ----- word play -----
    const credit = (s: Seat, word: string, reward: number, rd: number, by: "sim" | "real") => {
      if (emit) emit({ type: "word", round: rd, seat: s.seat, word, reward, by, rackBefore: rackString(s.rack) });
      for (let i = 0; i < word.length; i++) s.rack[word.charCodeAt(i) - 65]!--;
      s.rackTotal -= word.length;
      s.balance += reward;
      s.score += reward;
      s.wordsPlayed++;
      wordHistory.push(Object.freeze({ round: rd, botId: s.botId, word, reward }));
    };

    const applyRealWords = (s: Seat, raw: unknown, rd: number) => {
      if (!Array.isArray(raw)) {
        s.errors.badReturns++;
        s.errors.firstError ??= "words() did not return an array";
        return;
      }
      for (const w of raw) {
        const chk = checkWord(w);
        if (!chk.ok) {
          s.errors.invalidWords++;
          s.errors.firstError ??= `invalid word ${JSON.stringify(w)} (${chk.reason})`;
          if (emit) emit({ type: "reject", round: rd, seat: s.seat, word: w, reason: chk.reason });
          continue;
        }
        const word = chk.word;
        // Spellable from the current rack? (rack already reflects earlier words in this list)
        let okSpell = true;
        const need = new Int32Array(26);
        for (let i = 0; i < word.length; i++) {
          const li = word.charCodeAt(i) - 65;
          if (++need[li]! > s.rack[li]!) {
            okSpell = false;
            break;
          }
        }
        if (!okSpell) {
          s.errors.unspellableWords++;
          s.errors.firstError ??= `unspellable word ${word}`;
          if (emit) emit({ type: "reject", round: rd, seat: s.seat, word, reason: "unspellable" });
          continue;
        }
        credit(s, word, wordReward(word), rd, "real");
      }
    };

    const sanitizeBid = (s: Seat, raw: unknown): number => {
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
        s.errors.badBids++;
        s.errors.firstError ??= `bad bid ${String(raw)}`;
        return 0;
      }
      if (raw > s.balance) {
        s.errors.overBalanceBids++;
        s.errors.firstError ??= `bid ${raw} > balance ${s.balance}`;
        return 0;
      }
      return raw;
    };

    // ----- match start -----
    {
      const bagRem = BAG_SIZE - pos;
      const bals = snapshotBalances();
      const scs = snapshotScores();
      for (const s of real) {
        const strat = (s.p as RealParticipant).strategy;
        if (strat.onMatchStart) guard(s, "other", () => strat.onMatchStart!(makeView(s, 1, bagRem, bals, scs, 0, 0)));
      }
    }

    let auctions = 0;
    for (;;) {
      auctions++;
      const letter = indexLetter(letterIdx);
      const bagRemaining = BAG_SIZE - pos;
      if (emit) emit({ type: "open", round, letter, bagRemaining });
      const rng = mulberry32(hash32(seed, matchIndex, 2, round));

      // 1. sims bid at open, from their balance at that moment (jitter drawn for every sim, in seat order)
      const bids: BidIn[] = [];
      const bidSource: ("sim" | "real")[] = [];
      for (const s of sims) {
        const jitter = intInRange(rng, -SIM_BID_JITTER, SIM_BID_JITTER);
        const amount = simDecideBid((s.p as SimParticipant).tag, letter, s.balance, jitter);
        if (amount > 0) {
          bids.push({ seat: s.seat, amount });
          bidSource.push("sim");
        }
      }

      if (real.length > 0) {
        // 2. words(): views from one snapshot of the public state at open
        const bals = snapshotBalances();
        const scs = snapshotScores();
        const aLen = auctionHistory.length;
        const wLen = wordHistory.length;
        for (const s of real) {
          const strat = (s.p as RealParticipant).strategy;
          const r = guard(s, "words", () => strat.words(makeView(s, round, bagRemaining, bals, scs, aLen, wLen)));
          if (r.ok) applyRealWords(s, r.v, round);
        }

        // 3. bid(): fresh views (balances now include word rewards)
        const bals2 = snapshotBalances();
        const scs2 = snapshotScores();
        const aLen2 = auctionHistory.length;
        const wLen2 = wordHistory.length;
        for (const s of real) {
          const strat = (s.p as RealParticipant).strategy;
          const r = guard(s, "bid", () => strat.bid(makeView(s, round, bagRemaining, bals2, scs2, aLen2, wLen2), letter));
          const amount = r.ok ? sanitizeBid(s, r.v) : 0;
          if (amount > 0) {
            bids.push({ seat: s.seat, amount });
            bidSource.push("real");
          }
        }
      }

      if (emit) emit({ type: "bids", round, bids: bids.map((b, i) => ({ seat: b.seat, amount: b.amount, source: bidSource[i]! })) });

      // 4. close
      const balances = seats.map((x) => x.balance);
      const out = resolveAuction(bids, balances, auctionType, rng);
      let simWinner: Seat | null = null;
      if (out.winner >= 0 && out.transferred) {
        const w = seats[out.winner]!;
        w.balance -= out.paid;
        w.spent += out.paid;
        w.rack[letterIdx]!++;
        w.rackTotal++;
        w.auctionsWon++;
        if (w.isSim) simWinner = w;
      } else {
        discarded++;
      }
      const rec: AuctionRecord = Object.freeze({
        round,
        letter,
        winnerBotId: out.winner >= 0 ? seats[out.winner]!.botId : null,
        paid: out.paid,
      });
      auctionHistory.push(rec);
      if (emit) emit({ type: "close", round, letter, winnerSeat: out.winner, topBid: out.topBid, paid: out.paid, received: out.winner >= 0 && out.transferred });

      // 5. a sim winner immediately plays its best word (min length 3), before the next letter is drawn
      if (simWinner) {
        const word = findBestPlayableCounts(simWinner.rack, SIM_MIN_WORD_LEN);
        if (word !== undefined) credit(simWinner, word, wordReward(word), round, "sim");
      }

      // 6. results to real strategies (state is final for this auction; the closing record is in auctionHistory)
      if (real.length > 0) {
        const bals = snapshotBalances();
        const scs = snapshotScores();
        const aLen = auctionHistory.length;
        const wLen = wordHistory.length;
        for (const s of real) {
          const strat = (s.p as RealParticipant).strategy;
          if (strat.onAuctionResult) {
            guard(s, "other", () => strat.onAuctionResult!(makeView(s, round, bagRemaining, bals, scs, aLen, wLen), rec));
          }
        }
      }

      // 7. next letter, or the match ends (bag empty)
      if (pos >= BAG_SIZE) break;
      letterIdx = bag[pos++]!;
      round++;
    }
    if (emit) emit({ type: "end", auctions });

    // ----- results -----
    const P2 = seats.length;
    const out: SeatResult[] = seats.map((s) => {
      let better = 0;
      for (const o of seats) if (o.score > s.score) better++;
      const place = better + 1;
      const r: SeatResult = {
        seat: s.seat,
        botId: s.botId,
        name: s.p.name,
        kind: s.p.kind,
        score: s.score,
        balance: s.balance,
        place,
        swiss: Math.max(P2 - place, 0),
        win: place === 1,
        tilesLeft: s.rackTotal,
        wordsPlayed: s.wordsPlayed,
        auctionsWon: s.auctionsWon,
        spent: s.spent,
        errors: s.errors,
        timing: s.timing,
      };
      if (s.p.kind === "sim") r.simTag = s.p.tag;
      return r;
    });
    return { auctions, discarded, seats: out };
  } finally {
    if (seedMath) Math.random = origRandom;
  }
}
