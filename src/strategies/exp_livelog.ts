// exp_livelog: "final" plus a live-price-calibrated bid bump (label livelog, 2026-11-07).
//
// Live logs (docs/notes/fleet-livelog.md): our bids average 0.8 x the clearing price (value-1 bid 8.2 vs paid 10.9) and we
// win ~17% of auctions (= fair share 1/6) while table winners win 14-15 tiles and spend ~190. Market clearing price by letter
// face value at 6 players (live, 2404 of our bid lines): 1:10.8 2:12.7 3:16.2 4:18.4 5:22.8 8:28.0 10:29.1.
// Change: when final's own bid is already close to the live clearing price of that letter (b >= lo * P), raise it to hi * P.
// Vickrey pays the second price, so the extra only costs when the second price lands in (b, hi*P].
// Applies to Vickrey tables with >= 3 players; everything else is exactly final.

import type { AuctionRecord, MatchView, Strategy } from "../core/types.js";
import { createFinal } from "./final.js";

export interface LiveLogParams {
  lo: number; // bump only when inner bid >= lo * P
  hi: number; // bump target: hi * P
  mult: number; // generic multiplier applied to every inner bid first (control)
  faceMin: number; // mult applies only to letters with face value >= faceMin
  faceMax: number; // ... and <= faceMax
  multBag: number; // mult applies only while bagRemaining > multBag (0 = all game)
  minRound: number;
  endBag: number; // no bump when bagRemaining <= endBag (cash is more useful late for burn anyway)
  reserve: number; // keep at least this much cash after the bump bid (bid cap = balance - reserve)
  adapt: boolean; // scale P by the recently observed clearing level
}

export const LL_DEFAULTS: LiveLogParams = { lo: 0.7, hi: 1.1, mult: 1, multBag: 0, faceMin: 0, faceMax: 99, minRound: 1, endBag: 2, reserve: 0, adapt: true };

// live 6-player Vickrey clearing price by letter face value (our logs, all four strategies pooled)
const LIVE_BY_FACE: [number, number][] = [
  [1, 10.8],
  [2, 12.7],
  [3, 16.2],
  [4, 18.4],
  [5, 22.8],
  [8, 28.0],
  [10, 29.1],
];
const SCALE_BY_N: Record<number, number> = { 2: 0.43, 3: 0.59, 4: 0.72, 5: 0.8, 6: 1.0, 7: 1.18 };

const FACE: Record<string, number> = {};
for (const c of "AEIOULNSTR") FACE[c] = 1;
for (const c of "DG") FACE[c] = 2;
for (const c of "BCMP") FACE[c] = 3;
for (const c of "FHVWY") FACE[c] = 4;
FACE["K"] = 5;
FACE["J"] = 8;
FACE["X"] = 8;
FACE["Q"] = 10;
FACE["Z"] = 10;

function scaleN(n: number): number {
  if (n <= 2) return 0.43;
  if (n >= 7) return 1.18 + 0.05 * (n - 7);
  return SCALE_BY_N[n]!;
}

export function livePrice(letter: string, n: number): number {
  const f = FACE[letter] ?? 1;
  let p = 10.8;
  for (const [face, price] of LIVE_BY_FACE) if (f >= face) p = price;
  return p * scaleN(n);
}

export function createLiveLog(over: Partial<LiveLogParams> = {}, name = "ll"): Strategy {
  const P: LiveLogParams = { ...LL_DEFAULTS, ...over };
  const inner = createFinal({}, name + "-inner");

  function ratio(view: MatchView): number {
    if (!P.adapt) return 1;
    const n = view.players.length;
    const H = view.auctionHistory;
    let num = 4;
    let den = 4;
    for (let i = Math.max(0, H.length - 18); i < H.length; i++) {
      const r = H[i]!;
      if (r.winnerBotId === null || r.paid <= 0) continue;
      const pp = livePrice(r.letter, n);
      num += Math.min(2.5, r.paid / pp);
      den += 1;
    }
    return Math.max(0.6, Math.min(1.5, num / den));
  }

  return {
    name,
    onMatchStart(view) {
      inner.onMatchStart?.(view);
    },
    words(view) {
      return inner.words(view);
    },
    bid(view, letter) {
      let b = inner.bid(view, letter);
      const n = view.players.length;
      const bal = Math.max(0, Math.floor(view.myBalance));
      if (view.auctionType !== "Vickrey" || n < 3 || view.bagRemaining <= P.endBag || view.round < P.minRound) return b;
      if (P.mult !== 1 && view.bagRemaining > P.multBag && (FACE[letter] ?? 1) >= P.faceMin && (FACE[letter] ?? 1) <= P.faceMax) b = Math.min(bal, Math.round(b * P.mult));
      if (P.hi > 0 && b > 0) {
        const price = livePrice(letter, n) * ratio(view);
        if (b >= P.lo * price && b < P.hi * price) {
          const target = Math.ceil(P.hi * price);
          b = Math.max(b, Math.min(target, bal - P.reserve));
        }
      }
      return Math.max(0, Math.min(bal, Math.round(b)));
    },
    onAuctionResult(view: MatchView, rec: AuctionRecord) {
      inner.onAuctionResult?.(view, rec);
    },
  };
}

export const STRATEGIES: Record<string, () => Strategy> = {
  "ll-m12": () => createLiveLog({ hi: 0, mult: 1.2 }, "ll-m12"), // control: generic +20% on every bid
  "ll-early125": () => createLiveLog({ hi: 0, mult: 1.25, multBag: 28 }, "ll-early125"), // +25% only before the burn phase (bag > 28)
  "ll-early115": () => createLiveLog({ hi: 0, mult: 1.15, multBag: 28 }, "ll-early115"),
  "ll-m085": () => createLiveLog({ hi: 0, mult: 0.85 }, "ll-m085"),
  "ll-id": () => createLiveLog({ hi: 0, mult: 1 }, "ll-id"), // identity wrapper: control for the wrapper itself
  "ll-hi125": () => createLiveLog({ hi: 0, mult: 1.25, faceMin: 4 }, "ll-hi125"), // +25% on face>=4 letters (F H V W Y K J X Q Z)
  "ll-hi115": () => createLiveLog({ hi: 0, mult: 1.15, faceMin: 4 }, "ll-hi115"),
  "ll-lo090": () => createLiveLog({ hi: 0, mult: 0.9, faceMax: 1 }, "ll-lo090"), // -10% on value-1 letters
  "ll-b100-70": () => createLiveLog({ lo: 0.7, hi: 1.0 }, "ll-b100-70"),
  "ll-b115-70": () => createLiveLog({ lo: 0.7, hi: 1.15 }, "ll-b115-70"),
  "ll-b115-85": () => createLiveLog({ lo: 0.85, hi: 1.15 }, "ll-b115-85"),
  "ll-b130-60": () => createLiveLog({ lo: 0.6, hi: 1.3 }, "ll-b130-60"),
  "ll-b115-70na": () => createLiveLog({ lo: 0.7, hi: 1.15, adapt: false }, "ll-b115-70na"),
};

export function createStrategy(): Strategy {
  return createLiveLog({ lo: 0.7, hi: 1.15 }, "exp_livelog");
}
