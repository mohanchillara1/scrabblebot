// exp_burn: late-game cash spend-down experiments on top of `final` (label: burn). NEW file, edits nothing.
//  * exp_burn-p*  : final with different BurnParams (s, floorF, rMax, minFrac) via createFinal({burnParams}).
//  * exp_burn-sd* : final (default burn) + an extra spend-down: in the last N auctions (bagRemaining <= N, Vickrey,
//                   >= 5 players), if owning the letter raises the best-partition score of the rack by >= gainMin,
//                   raise the bid to factor x balance / bagRemaining (optionally capped at kmax coins per point of gain).
import type { MatchView, Strategy } from "../core/types.js";
import * as W from "../engine/words.js";
import { createFinal, createStrategy as createFinalWarm } from "./final.js";
import type { BurnParams } from "./final/burn.js";

export interface SdParams {
  n: number; // active when 0 < bagRemaining <= n
  factor: number; // floor = factor * balance / bagRemaining
  gainMin: number; // letter must raise the rack's best partition by at least this many points
  kmax: number; // cap the floor at kmax * gain coins (Infinity = no cap)
  minPlayers: number;
}

export function spendDown(inner: Strategy, p: SdParams, name: string): Strategy {
  return {
    name,
    onMatchStart: (v) => inner.onMatchStart?.(v),
    words: (v) => inner.words(v),
    onAuctionResult: (v, r) => inner.onAuctionResult?.(v, r),
    bid(view: MatchView, letter: string): number {
      let b = inner.bid(view, letter);
      const R = view.bagRemaining;
      const bal = Math.floor(view.myBalance);
      if (R <= 0 || R > p.n || bal <= 0 || view.auctionType !== "Vickrey" || view.players.length < p.minPlayers) return b;
      const base = Math.min(bal, Math.round((p.factor * bal) / R));
      if (base <= b) return b;
      try {
        const rack = W.rackToCounts(view.myRack);
        const li = letter.charCodeAt(0) - 65;
        if (li < 0 || li > 25) return b;
        const p0 = W.bestPartition(rack, { timeBudgetMs: 3 }).total;
        const r2 = Uint8Array.from(rack);
        r2[li]!++;
        const p1 = W.bestPartition(r2, { timeBudgetMs: 3 }).total;
        const gain = p1 - p0;
        if (gain < p.gainMin) return b;
        const cap = Number.isFinite(p.kmax) ? Math.round(p.kmax * gain) : Infinity;
        const f = Math.min(base, cap);
        if (f > b) b = f;
      } catch {
        /* keep inner */
      }
      return b;
    },
  };
}

const SD0: SdParams = { n: 15, factor: 2, gainMin: 1, kmax: Infinity, minPlayers: 5 };

function pv(name: string, burnParams: Partial<BurnParams>): [string, () => Strategy] {
  return [name, () => createFinal({ burnParams }, name)];
}
function sd(name: string, sdp: Partial<SdParams>, burnParams: Partial<BurnParams> = {}): [string, () => Strategy] {
  return [name, () => spendDown(createFinal({ burnParams }, name), { ...SD0, ...sdp }, name)];
}

export const STRATEGIES: Record<string, () => Strategy> = Object.fromEntries([
  // burn-parameter variants (default is s .35, floorF 1.1, rMax 28, minFrac .15)
  pv("exp_burn-s20", { s: 0.2 }),
  pv("exp_burn-s50", { s: 0.5 }),
  pv("exp_burn-s10", { s: 0.1 }),
  pv("exp_burn-f13", { floorF: 1.3 }),
  pv("exp_burn-f09", { floorF: 0.9 }),
  pv("exp_burn-f15", { floorF: 1.5 }),
  pv("exp_burn-r40", { rMax: 40 }),
  pv("exp_burn-r20", { rMax: 20 }),
  pv("exp_burn-m30", { minFrac: 0.3 }),
  pv("exp_burn-m05", { minFrac: 0.05 }),
  pv("exp_burn-s20f13", { s: 0.2, floorF: 1.3 }),
  pv("exp_burn-s20f13r40", { s: 0.2, floorF: 1.3, rMax: 40 }),
  pv("exp_burn-s20r40", { s: 0.2, rMax: 40 }),
  pv("exp_burn-s50f13", { s: 0.5, floorF: 1.3 }),
  pv("exp_burn-f13r40", { floorF: 1.3, rMax: 40 }),
  pv("exp_burn-f13m30", { floorF: 1.3, minFrac: 0.3 }),
  pv("exp_burn-f20", { floorF: 2.0 }),
  // spend-down alternative (on top of default burn)
  sd("exp_burn-sd2n15", { factor: 2, n: 15 }),
  sd("exp_burn-sd3n15", { factor: 3, n: 15 }),
  sd("exp_burn-sd2n25", { factor: 2, n: 25 }),
  sd("exp_burn-sd4n12", { factor: 4, n: 12 }),
  sd("exp_burn-sd3n20", { factor: 3, n: 20 }),
  sd("exp_burn-sd3n15k4", { factor: 3, n: 15, kmax: 4 }),
  sd("exp_burn-sd3n15k2", { factor: 3, n: 15, kmax: 2 }),
]);

export function createStrategy(): Strategy {
  return createFinalWarm();
}
