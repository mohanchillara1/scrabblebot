// Experiment "aggression": final's multi-player rule (economist + burn + early dump) with higher bid level.
// Heads-up (<=2 players) delegates to the real `final` instance, so only >=3-player tables change.
// Variants are registered below (sim only) and via env AGG='{"name":{"econ":{...},"burn":{...},"mult":1.0}}'.
import type { AuctionRecord, MatchView, Strategy } from "../core/types.js";
import * as W from "../engine/words.js";
import { createEconomist, type EconParams } from "./economist.js";
import { createFinal } from "./final.js";
import { BURN_DEFAULTS, burnBid, type BurnParams } from "./final/burn.js";

export interface AggCfg {
  econ?: Partial<EconParams>;
  burn?: Partial<BurnParams> | false;
  mult?: number; // extra multiplier on the final bid (applied before burn)
  bonus?: number; // extra flat coins added to a bid when the inner bid is >= 1 (applied before burn)
  dumpAt?: number;
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

function validate(view: MatchView, words: unknown): string[] {
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

export function createAgg(cfg: AggCfg, name: string): Strategy {
  const fin = createFinal({}, name + "-fin"); // used for heads-up
  const burnOn = cfg.burn !== false;
  const burnP: BurnParams = { ...BURN_DEFAULTS, ...(cfg.burn || {}) };
  const dumpAt = cfg.dumpAt ?? 1;
  const mult = cfg.mult ?? 1;
  const bonus = cfg.bonus ?? 0;
  const subs = new Map<number, Strategy>();
  const order: number[] = [];

  function subFor(view: MatchView, announce: boolean): Strategy {
    let s = subs.get(view.matchId);
    if (s) return s;
    s = createEconomist(cfg.econ ?? {}, name + "-econ");
    subs.set(view.matchId, s);
    order.push(view.matchId);
    while (order.length > 16) subs.delete(order.shift()!);
    if (announce) s.onMatchStart?.(view);
    return s;
  }

  return {
    name,
    onMatchStart(view) {
      if (view.players.length < 3) return fin.onMatchStart?.(view);
      subs.delete(view.matchId);
      subFor(view, true);
    },
    words(view) {
      if (view.players.length < 3) return fin.words(view);
      try {
        const s = subFor(view, !subs.has(view.matchId));
        if (dumpAt > 0 && view.bagRemaining > 0 && view.bagRemaining <= dumpAt) {
          const d = dumpWords(view, 30);
          if (d.length > 0) return d;
        }
        return validate(view, s.words(view));
      } catch {
        return [];
      }
    },
    bid(view, letter) {
      if (view.players.length < 3) return fin.bid(view, letter);
      const bal = Math.max(0, Math.floor(view.myBalance));
      if (view.bagRemaining === 0 || bal <= 0) return 0;
      try {
        const s = subFor(view, !subs.has(view.matchId));
        let b = s.bid(view, letter);
        if (b >= 1) b = b * mult + bonus;
        if (burnOn) b = burnBid(view, letter, b, burnP);
        if (!Number.isFinite(b)) return 0;
        return Math.max(0, Math.min(bal, Math.round(b)));
      } catch {
        return 0;
      }
    },
    onAuctionResult(view: MatchView, rec: AuctionRecord) {
      if (view.players.length < 3) return fin.onAuctionResult?.(view, rec);
      try {
        subFor(view, !subs.has(view.matchId)).onAuctionResult?.(view, rec);
      } catch {
        /* ignore */
      }
    },
  };
}

const V: Record<string, AggCfg> = {
  "agg-ref": {}, // control: should equal final at >=3 players
  "agg-k18": { econ: { kappa: 1.8 } },
  "agg-k21": { econ: { kappa: 2.1 } },
  "agg-k25": { econ: { kappa: 2.5 } },
  "agg-k30": { econ: { kappa: 3.0 } },
  "agg-pmin10": { econ: { paceMin: 1.0 } },
  "agg-pmin08": { econ: { paceMin: 0.8 } },
  "agg-pe09": { econ: { paceExp: 0.9 } },
  "agg-pe04": { econ: { paceExp: 0.4 } },
  "agg-pmax5": { econ: { paceMax: 5 } },
  "agg-kcap20": { econ: { kCap: 20 } },
  "agg-a05": { econ: { a0: 0.05 } },
  "agg-a07": { econ: { a0: 0.07 } },
  "agg-burn-wide": { burn: { rMax: 40, s: 0.25, floorF: 1.2 } },
  "agg-burn-wider": { burn: { rMax: 50, s: 0.2, floorF: 1.2, minFrac: 0.1 } },
  "agg-mult13": { mult: 1.3 },
  "agg-mult16": { mult: 1.6 },
  "agg-bonus2": { bonus: 2 },
};

function envVariants(): Record<string, AggCfg> {
  try {
    const raw = process.env["AGG"];
    if (raw) return JSON.parse(raw) as Record<string, AggCfg>;
  } catch {
    /* ignore */
  }
  return {};
}

export const STRATEGIES: Record<string, () => Strategy> = (() => {
  const out: Record<string, () => Strategy> = {};
  for (const [k, v] of Object.entries({ ...V, ...envVariants() })) out[k] = () => createAgg(v, k);
  return out;
})();
