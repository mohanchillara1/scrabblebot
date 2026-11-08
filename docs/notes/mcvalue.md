# mcvalue notes
19:10 first version of src/strategies/mcvalue.ts written (MC marginal value of letter via bestPartition with CRN; bid = beta*pbar*pace*(V/vref); Vickrey truthful, FP shaded). Env MCV=json overrides params for tuning.
19:21 tuned: playMinLen 7, beta .8, gamma 1, qMult-based pace; qMult 2.4 -> 85.0 vs topbot-like 75.8 on 6p Vickrey fitted field (diag.ts)
19:42 added scheduleFor(N): 2p beta1.8 gamma.2; 3p beta1.4 gamma.5; etc

## FINAL (19:47 CT) - src/strategies/mcvalue.ts (+ src/strategies/mcvalue/diag.ts diagnostic runner)
Paired sims vs topbot-like (data-fitted model) in the same seat, field = fitted models, seed 11/21, seats rotated:
 6p Vickrey (250): mcvalue 79.22+-1.10 place 2.24 swiss 3.76 | topbot-like 73.22+-1.17 | paired d.score +6.00+-1.34
 7p Vickrey (150): 66.56+-1.29 place 2.41 swiss 4.59 | 62.33 | d +4.23+-1.64
 3p Vickrey (121): 182.46+-4.44 place 1.58 swiss 1.42 | 159.99 | d +22.47+-6.14
 2p Vickrey (98):  254.03+-7.48 place 1.43 swiss 0.57 | 243.76 | d +10.28+-10.96 (NOT significant)
 6p FirstPrice (150): 76.85+-1.40 place 2.34 | 72.39 | d +4.46+-1.61 (shading untuned)
Timing: bid avg 2.8-6.0 ms, max 29.6 ms (52 ms once, FirstPrice run); words avg <0.05 ms, max 11 ms. 0 errors.
Params via env MCV='{"beta":..}' for tuning. Known gaps: heads-up beta=4 collapses (overspend), schedule for 4/5 players untested,
FirstPrice shading untuned, 5-sim lobby fields untested, high-rack-size (25) timing untested.
