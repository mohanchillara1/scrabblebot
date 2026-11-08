# fleet-aggression: does a higher bid level help final's >=3-player rule?

Written 2026-11-07 ~22:12 CT. Experiment file: `src/strategies/exp_aggression.ts` (variants `agg-*`; env AGG='{"name":{"econ":{},"burn":{},"mult":1,"bonus":0}}' adds more).
`agg-ref` = final's multi rule (economist + burn + early dump at bag<=1); heads-up delegates to a real `final` instance.
Raw JSON: `sim-out/agg/r1..r5.json`. Field: 6p Vickrey, `field:topbot-like,topbot-like,topbot-like,economist,tuned`. All runs `nice -n 19`, one process at a time, paired on the same bags.
Run times are short, so every number below has a wide SE. Economist uses wall-clock budgets, so even a copy of final differs run to run (agg-ref vs final, n=20: dPlace -0.20 +-0.28).

## Result: nothing beat final by >= 2 SE. No change recommended.

Final in this sim already buys ~12 tiles for ~155 coins and finishes with <1 tile left, close to the live top-bot profile (14-15 tiles / ~175). So the sim does not reproduce the live shortfall (9.6 tiles / ~135 coins).
Raising bid level did not help in the sim.

| seed | n | variant | dPlace vs final (+ = worse) | dScore |
|---|---|---|---|---|
| 501 | 20 | agg-ref (control) | -0.20 +-0.28 | -0.35 +-3.4 |
| 501 | 20 | kappa 2.1 | +0.80 +-0.49 | -11.3 +-5.0 |
| 502 | 28 | kappa 1.8 | +0.14 +-0.41 | +0.4 +-4.2 |
| 502 | 28 | paceMin 1.0 | +0.07 +-0.38 | -2.5 +-3.7 |
| 502 | 28 | burn wide (rMax 40, s .25, floorF 1.2) | -0.07 +-0.32 | -0.7 +-2.8 |
| 502 | 28 | a0 0.05 (more pace) | +0.89 +-0.39 | -9.0 +-4.0 |
| 502 | 28 | kCap 20 | +0.61 +-0.41 | -6.4 +-3.8 |
| 503 | 28 | kappa 1.8 | +0.39 +-0.34 | -6.3 +-4.1 |
| 503 | 28 | kappa 1.65 | -0.25 +-0.34 | -3.4 +-3.8 |
| 503 | 28 | kappa 1.8 + burn wide | +0.18 +-0.27 | -4.4 +-3.3 |
| 503 | 28 | paceExp 0.9 | +0.04 +-0.37 | -1.9 +-3.9 |
| 503 | 28 | kappa 1.2 (control, other direction) | +0.32 +-0.30 | -6.4 +-3.8 |
| 504 | 26 | bonus +2 coins | -0.27 +-0.34 | +2.7 +-3.9 |
| 504 | 26 | burn-all (rMax 70, s .5, floorF .9) | +0.12 +-0.28 | +2.3 +-3.5 |
| 504 | 26 | burn-all2 (rMax 60, s .35, floorF 1.0) | -0.35 +-0.25 | +4.4 +-3.2 |
| 504 | 26 | burn-mid (rMax 35, s .3, floorF 1.1) | -0.19 +-0.25 | +5.5 +-2.9 |
| 504 | 26 | bid x1.3 | +0.62 +-0.34 | -4.1 +-4.0 |
| 505 | 37 | burn-mid | +0.08 +-0.30 | +1.0 +-2.9 |
| 505 | 37 | burn-all2 | +0.30 +-0.26 | -1.3 +-2.5 |
| 505 | 37 | bonus +2 | +0.14 +-0.27 | -0.0 +-3.1 |
| 506 | 75 | burn-mid | +0.01 +-0.19 | +0.4 +-1.8 |

Pooled burn-mid (seeds 504-506, n=138, inverse-variance): dPlace -0.03 +-0.14, dScore +1.7 +-1.4. Not significant; the early +5.5 was noise that shrank as n grew.

## Reading
- kappa 1.5 is at the sim optimum: 1.2 (-6.4 score) and 1.8 / 2.1 (-6.3 / -11.3) are both worse. Aggression through kappa, bid multiplier, kCap, or a smaller a0 costs score and place.
- Burn / floor variants and a +2 flat bonus are neutral within noise.
- Not run (out of time): 7p checks (no variant cleared the 6p bar, so none was needed), paceMax 5, paceExp 0.4, a0 0.07, kappa 2.5 / 3.0 (registered, unrun).
- The live shortfall (fewer tiles, leftover cash) is not reproducible against this sim field, so the sim gives no support for changing economist's bid level. If the live data show economist leaves 20+ coins, the one lever that is cheap and did no harm here is a wider burn (`burn-mid`: rMax 35, s 0.3, floorF 1.1), but treat it as unproven.
