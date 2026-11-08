# fleet-livelog (2026-11-07 ~22:08 CT): mining our real live logs for a bid change

Result: NO change recommended. Every live-price-calibrated bid change tested was worse than `final` in sim, two of them by more than 2 SE.
Experiment file: `src/strategies/exp_livelog.ts` (wrapper around `createFinal()`; variants registered as `ll-*`).

## Live data used
`~/scrabblebot-work/logs/*.log`, lines without `catch-up`, 6-player Vickrey: 2404 bid lines, 86 matches (final 613 lines, economist 536,
tuned 726, mcvalue 529). Only 32 matches had a complete auction record plus an ENDED line; per-match tile/spend numbers use those 32.
Paid = Vickrey second price = the market clearing price for that letter, win or lose.

### Our bid vs clearing price (all four strategies pooled, final in brackets)
| letter face | n | our bid | clearing price | bid/paid | win% |
|---|---|---|---|---|---|
| 1 | 1657 (418) | 8.6 (8.2) | 10.8 (10.9) | 0.80 | 18 (17) |
| 2 | 173 | 10.6 | 12.7 | 0.83 | 17 |
| 3 | 211 | 14.2 | 16.2 | 0.88 | 21 |
| 4 | 245 | 16.0 | 18.4 | 0.87 | 21 |
| 5 (K) | 26 | 19.9 | 22.8 | 0.87 | 23 |
| 8 (J, X) | 44 | 22.6 | 28.0 | 0.81 | 5 |
| 10 (Q, Z) | 48 | 24.7 | 29.1 | 0.85 | 10 |

By round (final only): win% 21 / 13 / 11 / 10 / 17 / 31 / 30 for rounds 1-10, 11-20, ..., 61-68 (fair share is 16.7). Mid-game win rate is
well below fair share, the burn phase (bag <= 28) buys at 30%. Clearing price is flat at 12.8-14.3 all game.

### Tiles, spend, words (32 complete matches; others = every non-us seat in those tables, n=160)
- Tiles won (rounds 1-67) / spend / paid per tile: final 13.0 / 166 / 12.7; economist 10.4 / 130 / 12.5; tuned 12.6 / 152 / 12.0; mcvalue 12.0 / 157 / 13.1.
  Table winners: 14.1-15.3 tiles, spend 180-196, 12.4-13.8 per tile, score 97-114.
- Spend is an identity, not a lever: spend = 100 + word rewards - leftover cash. Winners spend more because they score more.
- Leftover cash after the last auction: final 22 (n=8), economist 38, tuned 26, mcvalue 20. Top bots in research/OPPONENTS.md: 10-33. Not the gap.
- Words per match 2.7-3.1, average length 5.2-6.1, 1.1-1.8 words of 7+ letters, median play round 57-62; top bots: 3.2 words, 5.4-5.9 letters, median round
  50-59. Not the gap either.
- Across the 160 other seats: score 23 / 62 / 77 / 90 / 110 / 138 for 0-7 / 8-10 / 11-13 / 14-16 / 17-19 / 20+ tiles won. We win ~12 (final 13): roughly
  1-3 tiles fewer than the table winner at the same price per tile. Our bids are 0.8 x clearing price on average, which is what truthful Vickrey bidding at
  a value below the market looks like, not by itself an error.

## Sim tests (field: topbot-like x2, economist, tuned, mcvalue; 6p Vickrey; paired vs `final` in the same run; truncated by the 150 s limit)
This field gives final 82-86 points and place 2.4-2.8, close to the live 81 / 3.0, so it is a reasonable proxy. Noise check: `ll-id` (identical
wrapper, no change) vs `final`: -0.87 +-3.73 (n=30), so a single paired difference carries about +-3.5 at n=30.

| variant (what changes) | seed | n | final | variant | paired d.score +-SE | d.win pp |
|---|---|---|---|---|---|---|
| ll-m12 (all bids x1.2) | 701 | 24 | 81.9 | 78.1 | -3.83 +-3.36 | -12.5 +-9.2 |
| ll-b100-70 (if bid >= 0.7 x live price, raise to 1.0 x) | 701 | 24 | 81.9 | 78.5 | -3.38 +-3.71 | -20.8 +-10.4 |
| ll-b115-70 (raise to 1.15 x) | 701 | 24 | 81.9 | 76.9 | -5.00 +-4.61 | -4.2 +-9.5 |
| ll-early125 (bids x1.25 while bag > 28) | 702 | 36 | 85.2 | 78.4 | **-6.75 +-2.91** | -19.4 +-8.7 |
| ll-m085 (all bids x0.85) | 702 | 36 | 85.2 | 77.4 | **-7.72 +-2.99** | -11.1 +-8.7 |
| ll-id (control, no change) | 703 | 30 | 85.5 | 84.7 | -0.87 +-3.73 | +6.7 +-10.6 |
| ll-hi125 (x1.25 on face >= 4 letters) | 703 | 30 | 85.5 | 82.8 | -2.73 +-3.19 | 0.0 +-10.7 |
| ll-b100-70 (again) | 704 | 27 | 86.0 | 78.3 | **-7.70 +-3.26** | -22.2 +-8.2 |
| ll-b115-85 (if bid >= 0.85 x price, raise to 1.15 x) | 704 | 27 | 86.0 | 75.5 | **-10.48 +-3.81** | -7.4 +-9.1 |

Pooled ll-b100-70 (seeds 701+704, n=51): about -5.8 +-2.4 (inverse-variance pooling).
Zero invalid / unspellable / over-balance / malformed / exception in every run.

## Reading
- final's bid level is at a local optimum in this field: x0.85 and x1.2/x1.25 (all game or early only) are both worse, and flooring near-market bids at or above the
  live clearing price is worse by 3 to 10 points. Vickrey pays the second price, so raising a truthful bid only changes outcomes where the price lands above the
  bidder's own value; those wins are net losses.
- The live shortfall (1-3 tiles, 20-30 points vs table winners) is not visible in bid level, word length, word timing or leftover cash. It is more likely letter
  valuation quality / rack conversion (points per tile 4.5 vs 5.6 for winners), which a bid multiplier cannot fix.
- Not tested for lack of time (22:18 deadline, sim ran ~0.6 matches/s on the shared laptop): per-letter shape (only face >= 4 and the value-1 -10% variant `ll-lo090`
  was registered, not run); 3-5 player and FirstPrice tables; any word-side change.

## Limits
n of 24-36 per variant, SE 3-4 points; a true +-3 point effect cannot be seen. Live numbers pool four strategies and 86 matches; per-match numbers use 32 matches.
The live log has no top-bid, only the second price, so "how far below the winner were we" is not observable from it.
