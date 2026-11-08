# fleet-headsup: heads-up (2 players) hardening, 2026-11-07 ~21:55-22:17 CT

Worker label `headsup`. New files only: `src/strategies/exp_headsup.ts` (wrapper + variants `hx-*`, `hxfp-*`, adaptive-opponent copies
`hxo-*`), `src/strategies/exp_headsup2.ts` (round 2, `hy-*`, all built on the cap-0.9 adversary), this note. Raw outputs and scripts:
`sim-out/headsup/` (`*.json`, `log1.txt`, `log2.txt`, `log3.txt`, `summ.py`). Every run: `nice -n 19`, one process at a time, Vickrey
heads-up unless stated, `--players 2`, same bags/seat for every strategy within a run (paired). Zero invalid/unspellable/over-balance/bad/
exception counts in all runs.

`hx-c7` = exact copy of final's heads-up Vickrey rule (adversary `{pushCapFrac:0.7, pushMinFrac:0.15}`, early dump at bagRemaining<=1, same
validation/clamping wrapper) and is the control in every table. "series3" = P(win a 3-game total-score series), computed from the single-game
win rate p as Phi(sqrt(3) * Phi^-1(p)) (assumes normal score margins; the harness JSON has no per-match margins, so this is an
approximation, not a measured series).

## 1. Vickrey: adversary cap 0.9 (pushCapFrac 0.9, pushMinFrac 0.1) vs the shipped cap 0.7, n=200 matches per run

| opponent (adaptive copies first) | c7 win% | c9 win% | c9 - c7 paired d.score | c9 - c7 paired d.win (pp) | series3 c7 -> c9 |
|---|---|---|---|---|---|
| hxo-c9 (cap-0.9 adversary copy) | 49.5 +-3.5 | 57.0 +-3.5 | **+5.8 +-1.7 (3.4 SE)** | **+7.5 +-2.2 (3.4 SE)** | 49 -> 62 |
| hxo-c7 (cap-0.7 copy = our own rule) | 57.5 +-3.5 | 57.5 +-3.5 | +1.1 +-2.2 | 0.0 +-2.8 | 63 -> 63 |
| hxo-c3 (default adversary, cap 0.3) | 61.5 +-3.4 | 62.0 +-3.4 | +3.7 +-1.9 (1.9 SE) | +0.5 +-2.1 | 69 -> 70 |
| hxo-c9p12 (cap-0.9, push 1.2 copy) | 84.5 +-2.6 | 83.5 +-2.6 | +0.7 +-1.1 | -1.0 +-0.7 | 96 -> 95 |
| tuned | 90.0 +-2.1 | 88.5 +-2.3 | +0.9 +-0.9 | -1.5 +-1.1 | 98.7 -> 98.1 |
| topbot-like | 66.5 +-3.3 | 66.5 +-3.3 | -0.1 +-0.3 | 0.0 +-0.0 | 77 -> 77 |
| economist (n=30; rerun n=40 seed 751: c7 57.5 -> c9 60.0 win, d.score +11.7 +-9.9, d.win +2.5 +-9.1) | 76.7 +-7.9 | 70.0 +-8.5 | +2.5 +-10.4 | -6.7 +-11.7 | n/a |

Equal-weight mean over the six n=200 opponents: d.score **+2.0 +-0.6 (3.3 SE)**, d.win **+0.9 +-0.7 pp** (1.3 SE). The only large
effect is against a copy of cap 0.9 (exactly the "someone tuned the cap up" opponent); every other entry is within 1.5 SE of zero in either
direction, and the two negative d.win entries (tuned -1.5 pp, c9p12 -1.0 pp) come with non-negative d.score. Against topbot-like the two
rules are the same game (scores 262.7 vs 262.5).

Reading: cap 0.9 is a free hedge against a smart adaptive opponent, with no measurable cost against the fixed-rule opponents. It is NOT a
big upgrade against anything we have seen. A real heads-up opponent that is a data-fitted topbot-like (66% win, series ~77%) is where the
points are lost, and nothing here changes that.

## 2. Other AdvParams, tested around the cap-0.9 base against the hardest adaptive opponent (hxo-c9), n=200, paired vs hy-c9

| change vs cap-0.9 base | d.score | d.win (pp) | verdict |
|---|---|---|---|
| pushCapFrac 1.0 | -1.3 +-1.9 | +2.5 +-2.2 | noise |
| pushMinFrac 0.05 | 0.0 +-0.0 | 0.0 +-0.0 | not binding (identical) |
| pushMinFrac 0.20 | -0.6 +-0.5 | -0.5 +-0.5 | noise |
| tmult 1.1 (was 1.0 in heads-up) | -23.5 +-6.2 | **-20.0 +-4.7** | clearly worse |
| tmult 0.9 | -8.9 +-5.5 | +3.5 +-4.7 | noise / mixed |
| push 1.05 (was 1.0) | -12.1 +-5.5 | -7.5 +-4.5 | worse (2.2 SE on score) |
| pushUntilBag 3 (was 6) | +0.1 +-0.1 | +0.5 +-0.5 | no effect |
| startRound 3 (was 6) | -1.8 +-5.2 | +2.5 +-3.6 | noise |
| deny 1.25 on in heads-up (was 0) | -3.1 +-3.5 | -2.5 +-2.8 | noise, slightly negative |

Earlier, vs the cap-0.7 base (round 1): push 0.9 was clearly worse (vs the cap-0.7 copy -15.5 +-4.9 pp; vs the cap-0.9 copy -9.5 +-4.7; vs
tuned -12.5 +-3.4; vs topbot-like -3.5 +-3.6 pp). push 1.1 (cap-0.7 base, n=40, vs a cap-0.7 copy): -37.5 +-10.6 pp. `push = 1.0` and
`tmult = 1.0` sit at a sharp optimum: moving either one in either direction costs 8-20 pp. Do not touch them.

## 3. FirstPrice heads-up (economist vs tuned-engine, pick the best): INCONCLUSIVE

The economist is slow in the sim (~0.2 matches/s per strategy), so each FP run completed only n=15-16 of the requested matches. Seeds
741-743, 4 variants per run, paired vs `hxfp-econ` (economist, the shipped FP heads-up rule):

| opponent (n) | hxfp-tuned - econ: d.score / d.win pp | econ fpShade0 1.0 - econ: d.score / d.win pp | econ fpShade0 1.2 - econ |
|---|---|---|---|
| topbot-like (15) | +122.0 +-29.5 / +20.0 +-10.7 | +92.1 +-37.9 / +13.3 +-13.3 | +1.5 +-48.2 / -6.7 +-18.2 |
| hxo-c7, tuned engine (16) | -28.9 +-18.4 / -31.2 +-17.6 | -8.3 +-19.2 / -6.2 +-14.3 | +23.4 +-21.0 / +12.5 +-12.5 |
| tuned (17) | -8.6 +-9.7 / -5.9 +-16.0 | +36.1 +-13.9 / +35.3 +-14.7 | -8.6 +-18.9 / 0.0 +-17.1 |
| fresh confirmation, seed 761, sampled from tuned/topbot-like/hxo-c7 (19) | not run | **-6.0 +-12.1 / -5.3 +-9.3** | not run |

`fpShade0 1.0` looked like a lead (inverse-variance pooled over the first three runs, n=48: d.score +26.6 +-10.8, 2.5 SE, mined from
3 variants x 3 opponents) but the fresh confirmation run did not reproduce it (-6.0 +-12.1); pooled over all four runs it is +12.1 +-8.1
(1.5 SE). Not recommended. Absolute FP win rates for the shipped economist: 80% vs topbot-like, 81% vs the tuned-engine copy, 53% vs tuned,
79% in the mixed confirmation run (all n~15-19).

Conclusion: no change recommended for FirstPrice. The two best data points point in opposite directions (economist better vs the
tuned-engine opponent, tuned better vs topbot-like) and each has n~15. FINAL.md's earlier result (n=50-54) had the same sign pattern.
FirstPrice remains a guess for everyone.

## 4. Series-win probability, 3 games total score (approximation, see above)

With the recommended rule (cap 0.9): vs topbot-like ~77%; vs tuned ~98%; vs a default adversary ~70%; vs a cap-0.7 copy ~63%; vs a cap-0.9
copy ~62% (49% with the shipped cap 0.7, i.e. the shipped rule is a coin flip against its own best adaptive reply and cap 0.9 turns that
into a 62% series favorite). Economist: the n=30 and n=40 reruns both show c9 >= c7 (d.score +2.5 +-10.4 and +11.7 +-9.9; d.win -6.7 +-11.7 and +2.5 +-9.1 pp); c9 series3 ~67% vs c7 ~63% in the larger run (c9 win 60.0 +-7.8, c7 57.5 +-7.9), underpowered.

## 5. Recommendation

Change `ADV_ROBUST` in final.ts from `{ pushCapFrac: 0.7, pushMinFrac: 0.15 }` to `{ pushCapFrac: 0.9, pushMinFrac: 0.1 }`. Nothing else
in the heads-up rule. Exp file reproducing it: `src/strategies/exp_headsup2.ts` (`hy-c9`; `createStrategy()` there is the cap-0.9 heads-up
Vickrey rule + economist for FirstPrice + early dump). Evidence level: 3.4 SE against the cap-0.9 copy, +2.0 +-0.6 score pooled, no
significant harm anywhere; modest. If the orchestrator wants zero risk, leaving 0.7 costs nothing measurable against fixed-rule bots.
