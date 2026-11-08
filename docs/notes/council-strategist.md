# council-strategist notes (game theorist), 2026-11-07 ~20:15-20:35 CT

Labels: [V] = I ran it, [I] = inference. Live data = 33 six-player Vickrey lobby matches, no sims, from logs/*.log
(economist 15, tuned 10, mcvalue 8). Analysis scripts were scratch (not in repo). One experiment file:
src/strategies/council_strategist_burn.ts (registers cs-econ-burn, cs-econ-burn2, cs-econ-hi, cs-econ-lo, cs-econ-both,
cs-tuned-burn, cs-tuned-hi, cs-tuned-lo, cs-tuned-lo-burn). Wrappers only post-process bid().

## Live facts [V] (33 matches, 6p Vickrey)
- Real clearing price is FLAT in game phase for value-1 letters (10.8 at r1-10 ... 10.3 at r61-67, n=1385 letters) and
  nearly flat in letter value: v1 10.8, v2 12.8, v3 16.3, v4 18.9, v5 23.4, v8 28.5, v10 28.2.
- v>=3 letters clear 22.6 at r1-10 but 15.0 at r61-67 (n=56 vs 50): a 34% late discount. The field is cash-poor late.
- All three of our bots win ~14-17% of auctions (fair share 1/6) with mean bids 1-3 coins under the clearing price.
  Table winners buy 13.7 letters / spend 174 / avg 13.1; the average seat buys 10.2 / 133. Cross-seat regression of
  final score on (letters won, face value won, cash spent): ~ +2.1 per letter, +1.2 per face point, ~0 per extra coin
  spent (R2 0.53, n=165 seats). Cash itself is not scored.
- Economist ends with money on the table: balance at r64 = 38 (median 41), final 52 after the last dump; in r50-66 with
  bal>=15 it won 11% of auctions, bid 10.2 vs clearing 13.6, and 159 of its 178 late auctions were affordable losses by
  a median of 3 coins. Tuned ends r64 with 14, mcvalue with 11 (they run dry instead).
- Economist's live edge comes from word quality (79 reward/match vs 65 tuned, 69 mcvalue), not from buying more.
- 7/1683 logged losses have paid < our own bid (impossible in Vickrey unless the bid was not counted): tuned 6/495,
  economist 1/802, mcvalue 0/386. Rare race or logging issue, worth a look in the live runner.

## Experiment 1: late-game excess-cash floor ("burn") [V]
Rule (Vickrey only): when bagRemaining <= 28 and balance > 0.35 * R * pmUnit (pmUnit = recent clearing normalised by a
0.77+0.215v curve), floor the bid at 1.1 x estimated clearing price of this letter, if the inner bid is >= 0.15 x that.
Paired sim results (duplicate matches, d vs the unwrapped strategy):
- economist, 6p, field topbot x2 mid x2 quick, seed 31 n=80: d.score +3.86 +-1.87, d.place -0.26 +-0.11
- same field seed 41 n=100: +2.79 +-1.91, d.place -0.13 +-0.11
- 6p vs five topbot-like, seed 51 n=70: +2.81 +-1.71, d.place -0.33 +-0.15 (burn2 floorF 1.3, s 0.5: +1.67 +-1.68, worse)
- 7p (+hoarder) seed 81 n=70: +4.44 +-1.58, d.swiss +0.61 +-0.16
- pooled economist: +3.5 +-0.9 score (inverse-variance), all four runs positive.
- tuned (already spends its cash): seed 61 n=200 +0.67 +-0.24; seed 71 n=400 +0.29 +-0.16; pooled +0.4 +-0.13.
Caveat: the sim field does not show the live 38-coin leftover as clearly; live ground truth is the tie-breaker.

## Experiment 2: letter-value timing [V, negative/inconclusive]
- Premium +20% on v>=3 letters early (cs-*-hi): economist +2.96 +-2.07 (seed 41, n=100, not significant), tuned -2.17
  +-1.28 (n=200). Not robust, dropped.
- Discount -15% on v>=3 letters while bagRemaining > 30 (cs-*-lo), motivated by the live 34% late discount: tuned +0.46
  +-0.92 (n=400), economist at 7p -0.50 +-2.35 (n=70). No effect in the sim; the sim field probably lacks the live late
  cash drought. Evidence is live-data only; not recommended without a live A/B.
- Bug found and fixed in my wrapper: the first "lo" run was identical to tuned because the guard was hiH > 0.

## Not done
FirstPrice (burn disabled there: untested, overpay risk), 3-5 player tables, finals, placement-aware objective.

## Addendum (20:33)
- economist burn at 4p (bracket size), seed 91 n=60: d.score -3.58 +-6.15, d.place 0.00 +-0.13: neutral. 2p/3p untested.
  The wrapper therefore applies burn only when players >= 5 and auction is Vickrey (gate added after the 6p/7p runs;
  it does not change those results).
