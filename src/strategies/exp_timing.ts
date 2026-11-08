// exp_timing: word-timing experiments for the multi-player (>= 3 players) rule of `final`.
// Reproduces final's behaviour (economist + burn + early dump at bagRemaining <= dumpAt) except for:
//   econ     : EconParams overrides (eta = play-now tolerance, forceDumpTiles)
//   dumpAt   : dump the whole rack when 0 < bagRemaining <= dumpAt
//   starve   : cash-starved rule. If the economist plays nothing, balance < bal, bagRemaining > dumpAt + 1 and the
//              optimal partition contains a word with >= minLen letters, play it (best reward first; `all` = every
//              such word) so the coins recycle into more tiles.
// Heads-up (2 players) is delegated to a plain `final` instance, untouched.
import type { AuctionRecord, MatchView, Strategy } from "../core/types.js";
import * as W from "../engine/words.js";
import { createEconomist, type EconParams } from "./economist.js";
import { createFinal } from "./final.js";
import { BURN_DEFAULTS, burnBid } from "./final/burn.js";

export interface StarveRule {
  bal: number; // play when balance < bal
  minLen: number; // only words of at least this length
  all?: boolean; // play every qualifying word of the partition (default: the single best-reward one)
  minRound?: number; // do not fire before this auction round
  minReward?: number; // word reward threshold
}

export interface TimingOpts {
  econ?: Partial<EconParams>;
  dumpAt?: number;
  starve?: StarveRule;
}

function rackTotal(rack: Map<string, number>): number {
  let t = 0;
  for (const n of rack.values()) t += n;
  return t;
}

function dumpWords(view: MatchView, budgetMs: number): string[] {
  if (rackTotal(view.myRack) < 2) return [];
  let R = W.rackToCounts(view.myRack);
  const part = W.bestPartition(R, { timeBudgetMs: budgetMs });
  const out: string[] = [];
  for (const w of part.words) {
    if (W.isWord(w) && W.canSpell(R, w)) {
      out.push(w);
      R = W.subtractWord(R, w);
    }
  }
  return out;
}

function validateWords(view: MatchView, words: unknown): string[] {
  if (!Array.isArray(words)) return [];
  let R = W.rackToCounts(view.myRack);
  const out: string[] = [];
  for (const raw of words) {
    if (typeof raw !== "string") continue;
    const w = raw.toUpperCase();
    if (w.length >= 2 && /^[A-Z]+$/.test(w) && W.isWord(w) && W.canSpell(R, w)) {
      out.push(w);
      R = W.subtractWord(R, w);
    }
  }
  return out;
}

export function createTiming(o: TimingOpts, name: string): Strategy {
  const dumpAt = o.dumpAt ?? 1;
  const hu = createFinal({}, name + "-hu");
  const subs = new Map<number, { sub: Strategy; players: number }>();
  const order: number[] = [];

  function slot(view: MatchView, announce: boolean) {
    let s = subs.get(view.matchId);
    if (s) return s;
    const players = view.players.length;
    s = { sub: createEconomist(o.econ ?? {}), players };
    subs.set(view.matchId, s);
    order.push(view.matchId);
    while (order.length > 16) subs.delete(order.shift()!);
    if (announce) s.sub.onMatchStart?.(view);
    return s;
  }

  const isHU = (v: MatchView) => v.players.length <= 2;

  return {
    name,
    onMatchStart(view) {
      if (isHU(view)) return hu.onMatchStart?.(view);
      subs.delete(view.matchId);
      slot(view, true);
    },
    words(view) {
      if (isHU(view)) return hu.words(view);
      try {
        const s = slot(view, !subs.has(view.matchId));
        if (dumpAt > 0 && view.bagRemaining > 0 && view.bagRemaining <= dumpAt) {
          const d = dumpWords(view, 30);
          if (d.length > 0) return d;
        }
        const ws = validateWords(view, s.sub.words(view));
        const st = o.starve;
        if (st && ws.length === 0 && view.myBalance < st.bal && view.bagRemaining > dumpAt + 1 && view.round >= (st.minRound ?? 0)) {
          const R = W.rackToCounts(view.myRack);
          if (W.totalTiles(R) >= st.minLen) {
            const part = W.bestPartition(R, { timeBudgetMs: 10 });
            let cand = part.words.filter((w) => w.length >= st.minLen && W.reward(w) >= (st.minReward ?? 0));
            if (cand.length > 0) {
              cand.sort((a, b) => W.reward(b) - W.reward(a));
              if (!st.all) cand = [cand[0]!];
              return validateWords(view, cand);
            }
          }
        }
        return ws;
      } catch {
        return [];
      }
    },
    bid(view, letter) {
      if (isHU(view)) return hu.bid(view, letter);
      const bal = Math.max(0, Math.floor(view.myBalance));
      if (view.bagRemaining === 0 || bal <= 0) return 0;
      try {
        const s = slot(view, !subs.has(view.matchId));
        let b = s.sub.bid(view, letter);
        b = burnBid(view, letter, b, BURN_DEFAULTS);
        if (!Number.isFinite(b)) return 0;
        return Math.max(0, Math.min(bal, Math.round(b)));
      } catch {
        return 0;
      }
    },
    onAuctionResult(view: MatchView, rec: AuctionRecord) {
      if (isHU(view)) return hu.onAuctionResult?.(view, rec);
      try {
        const s = subs.get(view.matchId) ?? slot(view, true);
        s.sub.onAuctionResult?.(view, rec);
      } catch {
        /* ignore */
      }
    },
  };
}

// A neutral createStrategy so the file is a valid registry entry: identical to final (no change).
export function createStrategy(): Strategy {
  return createTiming({}, "exp_timing");
}

const V = (name: string, o: TimingOpts): [string, () => Strategy] => [name, () => createTiming(o, name)];

export const STRATEGIES: Record<string, () => Strategy> = Object.fromEntries([
  V("tm-base", {}), // control: should equal final at >=3 players
  V("tm-eta30", { econ: { eta: 0.3 } }),
  V("tm-eta50", { econ: { eta: 0.5 } }),
  V("tm-eta100", { econ: { eta: 1.0 } }),
  V("tm-eta08", { econ: { eta: 0.08 } }),
  V("tm-fd16", { econ: { forceDumpTiles: 16 } }),
  V("tm-fd13", { econ: { forceDumpTiles: 13 } }),
  V("tm-fd11", { econ: { forceDumpTiles: 11 } }),
  V("tm-fd24", { econ: { forceDumpTiles: 24 } }),
  V("tm-d2", { dumpAt: 2 }),
  V("tm-d3", { dumpAt: 3 }),
  V("tm-d0", { dumpAt: 0 }),
  V("tm-s25L5", { starve: { bal: 25, minLen: 5 } }),
  V("tm-s40L5", { starve: { bal: 40, minLen: 5 } }),
  V("tm-s25L6", { starve: { bal: 25, minLen: 6 } }),
  V("tm-s40L6", { starve: { bal: 40, minLen: 6 } }),
  V("tm-s60L5", { starve: { bal: 60, minLen: 5 } }),
  V("tm-s25L4", { starve: { bal: 25, minLen: 4, minReward: 10 } }),
  V("tm-s40L5r15", { starve: { bal: 40, minLen: 5, minReward: 15 } }),
  V("tm-s40L5all", { starve: { bal: 40, minLen: 5, all: true } }),
  V("tm-eta30s40", { econ: { eta: 0.3 }, starve: { bal: 40, minLen: 5 } }),
  V("tm-fd16s40", { econ: { forceDumpTiles: 16 }, starve: { bal: 40, minLen: 5 } }),
]);
