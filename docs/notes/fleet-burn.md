# fleet-burn: late-game cash spend-down (worker label: burn), written 2026-11-07 ~22:13 CT

Code: `src/strategies/exp_burn.ts` (new file, nothing else edited). Registered names `exp_burn-*` (see `--list`).
Raw: `sim-out/burn/r1..r6.json`. All runs: 6 players, Vickrey, hardest field
`field:topbot-like,topbot-like,topbot-like,economist,tuned`, `nice -n 19`, one process, fixed seeds 601-606, paired against
`final` in the same run (same bags, seats, opponents). Runs were cut by the time limit at 39-54 matches each (the hard field
runs ~1 match/s with 3-4 test strategies). 7p was NOT run (no candidate cleared the 6p bar, deadline).

## Verdict: no change recommended. final's burn defaults sit on a flat plateau.

Nothing beat `final` by >= 2 SE on mean place or score. Keep `BURN_DEFAULTS` (s 0.35, floorF 1.1, rMax 28, minFrac 0.15).

## Evidence (paired vs final; d.place = variant minus final, NEGATIVE = variant better; pooled by inverse variance)

| variant | what | runs | n | d.score +-SE | d.place +-SE |
|---|---|---|---|---|---|
| fin-b0d0 | NO burn, no early dump | 1 | 42 | -4.14 +-2.52 | +0.76 +-0.22 (3.5 SE worse) |
| exp_burn-sd2n15 | default burn + spend-down: last 15 auctions, floor = 2 x balance / bagRemaining on any letter that raises the rack's best partition by >= 1 | 1 | 42 | -4.76 +-2.58 | +0.57 +-0.27 |
| exp_burn-s50 | s 0.5 (burn less) | 1 | 42 | -0.62 +-2.55 | +0.29 +-0.26 |
| exp_burn-f15 | floorF 1.5 | 1 | 39 | -1.51 +-2.56 | +0.41 +-0.23 |
| exp_burn-f13 | floorF 1.3 | 2 | 91 | +1.31 +-2.02 | +0.04 +-0.15 (seeds: +3.83, -2.49) |
| exp_burn-r40 | rMax 40 | 3 | 149 | +0.56 +-1.42 | +0.02 +-0.14 (seeds: +2.2, +4.4, -4.3) |
| exp_burn-f13r40 | floorF 1.3, rMax 40 | 2 | 82 | +2.85 +-2.12 | -0.07 +-0.20 (see r6 below) |
| exp_burn-s20f13r40 | s 0.2, floorF 1.3, rMax 40 (burn most) | 1 | 52 | -1.37 +-2.53 | +0.19 +-0.22 |
| exp_burn-s20 | s 0.2 | 1 | 12 | -11.0 +-3.0 | +0.33 +-0.31 (tiny smoke run, discard) |

Absolute level on this field (final, per run): score 78.7-92.7, place 2.08-3.07 (run-to-run swing is as large as any effect, so
only the paired columns mean anything).

## What this says
1. The burn itself is real and large on the hardest field: removing it costs +0.76 places (3.5 SE) and 4 points. Keep it.
2. Moving any of its parameters (s, floorF, rMax) in either direction changes nothing detectable: every pooled difference is
   within 1.5 SE of zero, and single-seed results flip sign (r40: +2.2, +4.4, -4.3). Do not tune further in sim; it is noise.
3. The proposed alternative (spend-down by balance / auctions remaining on gain-positive letters) is worse than the default burn
   (-4.8 score, +0.57 places, ~2 SE worse on place, n=42). It floors bids on letters worth little; the existing clearing-price floor is
   better targeted. Not pursued further.
4. If one tweak were forced for live (where the real field leaves 10-20 coins and economist leaves more): `floorF 1.3, rMax 40`
   has the best pooled score (+2.85 +-2.1, 1.3 SE) and a neutral place; it is a coin flip, not a recommendation.
   Override JSON (only if the orchestrator wants it): `{"burnParams":{"floorF":1.3,"rMax":40}}` in FinalConfig.

## Update 22:16: run r6 (seed 606, n=76) for f13r40
f13r40 vs final: d.score +0.25 +-1.72, d.place -0.12 +-0.17. Pooled over 2 runs of 6p, n=158: d.score +1.28 +-1.34, d.place -0.10 +-0.13.
That is under 1 SE on both: NOT a recommendation. Final stays as is. (The "+2.85" line above was before this run.)
