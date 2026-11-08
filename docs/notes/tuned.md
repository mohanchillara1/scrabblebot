# tuned strategy notes (label: tuned)
- 19:07 first version src/strategies/tuned.ts typechecks. 6p vs field topbot,topbot,mid,mid,quick (Vickrey, seed 21, 600 matches): tuned 67.9+-0.7 score, topbot-like 75.2, mid 59.5, quick 47.3. Needs tuning to beat topbot-like.
- Tuner: src/strategies/tuned/tune.ts (paired coordinate descent, state in docs/notes/tuned_best_<n>p_<auction>.json).
- 19:40 FINAL (typechecks; remaining tsc errors are in src/live/runner.ts, not mine). Tuned by paired coordinate descent (tune.ts) at 6p Vickrey, 6p FirstPrice, 2p, 3p; validated on unseen seeds 777/888 (never used in tuning: tuning seeds 101-105, 201-203, 301).
- Validation (seed 888, 400-500 duplicate matches, tuned vs topbot-like model in the SAME seats, Vickrey unless noted; field = data-fitted models):
  6p field topbot,topbot,mid,mid,quick: tuned 79.98+-0.78 score, place 2.24, swiss 3.76 | topbot-like 75.80+-0.91, place 2.62, swiss 3.38 | paired dSwiss +0.38+-0.08
  7p (+hoarder): tuned 66.19+-0.76, swiss 4.47+-0.07 | topbot-like 62.03, swiss 3.98 | paired dSwiss +0.50+-0.10
  3p field topbot,mid,quick: tuned 208.65+-2.21, swiss 1.76, win 79.5% | topbot-like 176.39, swiss 1.35, win 47.5%
  2p field topbot,mid,quick,hoarder: tuned 278.05+-2.11, swiss 0.82, win 82% | topbot-like 305.65+-4.75 (higher raw score), swiss 0.76, win 75.5%
  6p FirstPrice: tuned 79.65+-0.85, swiss 3.73 | topbot-like 74.12, swiss 3.39
  6p mixed (with sims): tuned 202.5+-2.6 (swiss 4.85) | topbot-like 227.6+-4.8 (swiss 4.77)
- Timing (sim, includes rack 20 start): bid avg 0.07-0.29 ms, max 15 ms (one 33 ms outlier); words avg 0.02-0.15 ms, max 55 ms (final bestPartition, 40 ms budget). Dictionary loaded in createStrategy() via W.warmUp().
- Known gaps: sim opponents are behavioural models (OPPONENTS.md section 7 gaps apply); FirstPrice field behaviour is a guess; heads-up raw score is below the topbot-like model against weak opponents even though win rate is higher.
