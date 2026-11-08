// Late-game excess-cash floor (ported from council-strategist's experiment; sim +3.5 +-0.9 over 4 paired runs, 6-7p Vickrey).
// Cash left at the end is worth nothing. When the balance exceeds what we can plausibly still spend, floor the bid at
// floorF x the estimated clearing price of this letter. Vickrey only (in FirstPrice you pay your own bid), >= 5 players.
import type { MatchView, Strategy } from "../../core/types.js";

const VAL: Record<string, number> = {};
for (const c of "AEIOULNSTR") VAL[c] = 1;
for (const c of "DG") VAL[c] = 2;
for (const c of "BCMP") VAL[c] = 3;
for (const c of "FHVWY") VAL[c] = 4;
VAL["K"] = 5;
VAL["J"] = 8;
VAL["X"] = 8;
VAL["Q"] = 10;
VAL["Z"] = 10;
const curve = (L: string): number => 0.77 + 0.215 * (VAL[L] ?? 1);

export interface BurnParams {
  s: number; // reserve = s * R * pm
  floorF: number; // floor = floorF * clearing estimate
  rMax: number; // active only when bagRemaining <= rMax
  minFrac: number; // skip if the inner bid is below minFrac * clearing (junk letter)
  minPlayers: number;
}
export const BURN_DEFAULTS: BurnParams = { s: 0.35, floorF: 1.1, rMax: 28, minFrac: 0.15, minPlayers: 5 };

function pmUnit(view: MatchView): number {
  const h = view.auctionHistory;
  let sum = 0;
  let n = 0;
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

/** Returns the (possibly raised) bid. */
export function burnBid(view: MatchView, letter: string, inner: number, p: BurnParams = BURN_DEFAULTS): number {
  const R = view.bagRemaining;
  if (R <= 0 || view.auctionType !== "Vickrey" || view.players.length < p.minPlayers || R > p.rMax) return inner;
  const pm = pmUnit(view);
  const clr = pm * curve(letter);
  const reserve = p.s * R * pm;
  if (view.myBalance - reserve > 0 && inner >= p.minFrac * clr) {
    const floor = Math.round(p.floorF * clr);
    if (floor > inner) return floor;
  }
  return inner;
}

export function withBurn(inner: Strategy, p: BurnParams = BURN_DEFAULTS): Strategy {
  return {
    name: inner.name,
    onMatchStart: (v) => inner.onMatchStart?.(v),
    words: (v) => inner.words(v),
    onAuctionResult: (v, r) => inner.onAuctionResult?.(v, r),
    bid: (v, l) => burnBid(v, l, inner.bid(v, l), p),
  };
}
