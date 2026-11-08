// council-strategist experiments. Wrappers around an existing strategy; they only post-process bid().
//  burn : late-game excess-cash floor. Cash left at the end is worth 0, and live logs show the economist ends
//         with ~38 cash at r64 while losing late auctions by a median 3 coins. When balance exceeds what we can
//         plausibly still spend (reserve), floor the bid at floorF x the estimated clearing price of this letter.
//  hi   : premium on high face-value letters (v >= 3) early/mid game (market price is nearly flat in value).
// Tuning: env CS='{"s":0.35,"floorF":1.1,...}' overrides defaults for every variant.
import type { MatchView, Strategy } from "../core/types.js";
import { createStrategy as createEconomist } from "./economist.js";
import { createStrategy as createTuned } from "./tuned.js";

const VAL: Record<string, number> = {};
for (const c of "AEIOULNSTR") VAL[c] = 1;
for (const c of "DG") VAL[c] = 2;
for (const c of "BCMP") VAL[c] = 3;
for (const c of "FHVWY") VAL[c] = 4;
VAL["K"] = 5; VAL["J"] = 8; VAL["X"] = 8; VAL["Q"] = 10; VAL["Z"] = 10;
const curve = (L: string): number => 0.77 + 0.215 * (VAL[L] ?? 1);

export interface CsParams {
  burn: boolean;
  s: number; // reserve = s * R * pmUnit  (share of remaining auctions we expect to still pay for)
  floorF: number; // floor = floorF * clearing estimate
  rMax: number; // only active when bagRemaining <= rMax
  minFrac: number; // do not floor if the inner bid is below minFrac * clearing (letter is junk to us)
  hiH: number; // premium for v>=3 letters
  hiUntil: number; // premium applies while bagRemaining > hiUntil
  hiCapFrac: number; // cap the premium bid at hiCapFrac * balance
}
export const CS_DEFAULTS: CsParams = { burn: false, s: 0.35, floorF: 1.1, rMax: 28, minFrac: 0.15, hiH: 0, hiUntil: 20, hiCapFrac: 0.5 };

function pmUnit(view: MatchView): number {
  const h = view.auctionHistory;
  let sum = 0, n = 0;
  for (let i = h.length - 1; i >= 0 && n < 20; i--) {
    const r = h[i]!;
    if (r.winnerBotId == null || r.paid <= 0) continue;
    sum += r.paid / curve(r.letter);
    n++;
  }
  const players = view.players.length;
  const prior = players <= 2 ? 4.6 : players === 3 ? 6.3 : players === 4 ? 7.7 : players === 5 ? 8.6 : players === 6 ? 10.7 : 12.6;
  return (sum + prior * 3) / (n + 3);
}

export function wrap(inner: Strategy, name: string, p: CsParams): Strategy {
  return {
    name,
    onMatchStart: (v) => inner.onMatchStart?.(v),
    words: (v) => inner.words(v),
    onAuctionResult: (v, r) => inner.onAuctionResult?.(v, r),
    bid(view: MatchView, letter: string): number {
      let b = inner.bid(view, letter);
      const R = view.bagRemaining;
      if (R <= 0) return b;
      const pm = pmUnit(view);
      const clr = pm * curve(letter);
      if (p.hiH !== 0 && (VAL[letter] ?? 1) >= 3 && R > p.hiUntil && b > 0) {
        b = Math.min(Math.round(b * (1 + p.hiH)), Math.max(b, Math.floor(view.myBalance * p.hiCapFrac)));
      }
      if (p.burn && view.auctionType === "Vickrey" && view.players.length >= 5 && R <= p.rMax) {
        const reserve = p.s * R * pm;
        const excess = view.myBalance - reserve;
        if (excess > 0 && b >= p.minFrac * clr) {
          const floor = Math.round(p.floorF * clr);
          if (floor > b) b = floor;
        }
      }
      return Math.max(0, Math.min(view.myBalance, Math.round(b)));
    },
  };
}

function params(over: Partial<CsParams>): CsParams {
  let env: Partial<CsParams> = {};
  try { const raw = process.env["CS"]; if (raw) env = JSON.parse(raw) as Partial<CsParams>; } catch { /* ignore */ }
  return { ...CS_DEFAULTS, ...over, ...env };
}

export const STRATEGIES: Record<string, () => Strategy> = {
  "cs-econ-burn": () => wrap(createEconomist(), "cs-econ-burn", params({ burn: true })),
  "cs-econ-hi": () => wrap(createEconomist(), "cs-econ-hi", params({ hiH: 0.2 })),
  "cs-econ-burn2": () => wrap(createEconomist(), "cs-econ-burn2", params({ burn: true, floorF: 1.3, s: 0.5, rMax: 34 })),
  "cs-econ-lo": () => wrap(createEconomist(), "cs-econ-lo", params({ hiH: -0.15, hiUntil: 30 })),
  "cs-tuned-lo": () => wrap(createTuned(), "cs-tuned-lo", params({ hiH: -0.15, hiUntil: 30 })),
  "cs-tuned-lo-burn": () => wrap(createTuned(), "cs-tuned-lo-burn", params({ burn: true, hiH: -0.15, hiUntil: 30 })),
  "cs-econ-both": () => wrap(createEconomist(), "cs-econ-both", params({ burn: true, hiH: 0.2 })),
  "cs-tuned-burn": () => wrap(createTuned(), "cs-tuned-burn", params({ burn: true })),
  "cs-tuned-hi": () => wrap(createTuned(), "cs-tuned-hi", params({ hiH: 0.2 })),
};
