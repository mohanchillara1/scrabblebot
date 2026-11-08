# fleet-timing: word timing for the multi-player rule (worker `timing`, 2026-11-07 ~22:15 CT)

Code: `src/strategies/exp_timing.ts` (new file only; registers `tm-*` variants). It reproduces `final` at >= 3 players
(economist + burn + early dump) and delegates heads-up to a plain `final`. Variants:
`tm-eta{08,30,50,100}` (economist eta, default 0.15), `tm-fd{11,13,16,24}` (forceDumpTiles, default 21),
`tm-d{0,2,3}` (dumpAt, default 1), `tm-s*` (cash-starved rule: if the economist plays nothing and balance < X, play the best
>= 5 letter word of the optimal partition; `all` = every such word).

Strong field: `field:topbot-like,topbot-like,topbot-like,economist,tuned` (6p) and `...,mcvalue` (7p). Vickrey, `nice -n 19`,
one process at a time, `--test final,<variants>` so every difference is paired with final (same bag, opponents, seat).
Numbers below are copied from the run output (seeds 601-605, 611).

## Results (paired vs final; d.place negative = better; SE over matches; runs pooled by inverse variance)

6 players (seeds 601-604, n per run 36-42):

| variant | n | d.score | d.place | d.swiss |
|---|---|---|---|---|
| tm-d2 (dump at bag<=2) | 78 | +2.47 +-2.26 | -0.36 +-0.21 (1.7 SE) | +0.36 +-0.21 |
| tm-d3 (dump at bag<=3) | 76 | +1.85 +-2.00 | -0.22 +-0.16 (1.3 SE) | +0.22 +-0.16 |
| tm-fd13 (force dump at 13 tiles) | 78 | +2.85 +-1.95 | -0.19 +-0.17 (1.1 SE) | +0.19 +-0.17 |
| tm-fd16 | 40 | +1.82 +-2.79 | -0.15 +-0.26 | +0.15 +-0.26 |
| tm-eta08 (hold longer) | 42 | +1.50 +-3.29 | -0.05 +-0.31 | +0.05 +-0.31 |
| tm-fd24 | 42 | -1.69 +-3.09 | -0.02 +-0.31 | +0.02 +-0.31 |
| tm-eta30 (play earlier) | 42 | -2.55 +-2.83 | +0.29 +-0.25 | -0.29 +-0.25 |
| tm-s25L6 (starve, L>=6) | 40 | -1.93 +-2.49 | +0.03 +-0.24 | -0.03 +-0.24 |
| tm-s40L5all (starve, every L>=5 word) | 42 | **-6.60 +-2.75 (2.4 SE worse)** | +0.45 +-0.26 | -0.45 +-0.26 |

7 players (seed 605, n=36, field + mcvalue): tm-d2 +0.00 +-2.41 / place +0.03 +-0.31; tm-fd13 +1.22 +-2.19 / -0.08 +-0.31;
tm-d3 +1.53 +-2.02 / -0.25 +-0.32.

## Control run that settles it (seed 611, 6p, n=40, `--test final,tm-base,tm-d2,tm-d3`)

tm-base is byte-for-byte final's behaviour, yet it beats the first-listed final by **+6.80 +-2.18 score and -0.80 +-0.25 place
(3.2 SE)**. That is pure order/cache bias, and it is larger than every "gain" in the table above. Against tm-base, tm-d2 is
-3.4 score (+0.30 place worse) and tm-d3 is -0.65 score (+0.08 place worse). So dumpAt 2/3 and fd13 are NOT improvements.

## Caveats (read before trusting the small positives)

1. **Order bias.** The first-listed strategy (final) runs with a cold partition cache and fewer Monte-Carlo samples under the
   wall-clock budgets (words ms avg 1.3 for final vs 0.2-0.7 for later-listed strategies). A control, `tm-base`
   (identical to final), measured +4.35 +-4.49 score vs final at n=20 (seed 501) and +6.80 +-2.18 at n=40 (seed 611). So the +2 to +3 point gains above are
   about the size of the bias. They are NOT evidence of an improvement.
2. The machine was shared with other workers' sims (load average ~12 on 6 cores), which also perturbs time-budgeted solvers.
3. Nothing reaches 2 SE on mean place at 6p; d2 is the closest at 1.7 SE and 7p shows 0.0.

## Conclusions

- The cash-starved "cash a 5-6 letter word mid-game" rule HURTS (score -6.6 +-2.8 for the aggressive form, about 0 for the
  conservative form). Real top bots hold letters and play most words late; playing early to recycle coins loses more option
  value than the coins buy. Economist live leaves cash unspent (it is under-buying, not cash-starved), so this lever points
  the wrong way.
- Higher eta (play earlier) is worse (-2.6 score, +0.29 place). Lower eta (08) and a later force-dump (24) are flat.
- Dumping earlier at the end (dumpAt 2 or 3) and forcing a dump at 13-16 tiles are small positives in sim but within the
  control bias; they were not significant at 6p and flat at 7p. They are also the safe direction for the real server (burst
  of closing auctions, "Match not running"), so dumpAt=2 costs nothing measurable.
- **No change meets the bar** (>= 2 SE better at 6p, not worse than 1 SE at 7p). Recommendation: keep final's timing
  parameters unchanged. dumpAt 2 is a free robustness hedge only (config field `createFinal({dumpAt: 2})`), not a score gain.
- For the other workers: any `--test final,x` comparison where final is listed first is biased in favour of x by about
  +3 to +7 score points. List a `tm-base`-style identical copy second as a control, or compare variants against each other.
