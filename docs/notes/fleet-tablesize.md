# fleet-tablesize: bracket survival by table size (2026-11-07, finished 22:17 CT)

Question: for 3/4/5/8 players, which >=3-player rule (economist+burn, tuned, mcvalue, advR) minimises P(last) / mean place vs a hard field?
Setup: Vickrey, field pool = topbot-like x3, economist, tuned, mcvalue, adversary (opponents sampled per match, 8p = all seven). Each rule is seated
alone on the same bags/opponents/seat (paired). Rules run through a snapshot of final.ts (src/strategies/exp_tablesize.ts, names ts-econ, ts-tuned, ts-mcv,
ts-advR; dump(1)+burn(>=5p) identical for all, only `multi` differs). Runner (not in repo): P(last) = strictly lowest score (ties fractional).
Machine was loaded (load avg ~8 on 6 cores): only 28-100 matches per run.

Pooled paired results vs ts-econ (final's current >=3p rule). d = rule minus economist; negative dLast/dPlace is better.
| N | seeds, n | rule | score | place | P(last) | dLast pp (SE) | dPlace (SE) | dScore |
|---|---|---|---|---|---|---|---|---|
| 3 | 11,21,31 n=104 (advR n=76) | econ | ~154 | 2.14 | 44.7% | - | - | - |
| 3 | | tuned | | | 35.1% | -9.6 +-6.2 (-1.6) | -0.12 +-0.11 | +5.3 +-5.2 |
| 3 | | advR (n=76) | | | 34.9% | -6.6 +-6.8 (-1.0) | -0.07 +-0.12 | +4.4 +-5.8 |
| 3 | | mcvalue | | | 33.7% | -11.1 +-6.3 (-1.7) | -0.11 +-0.10 | +3.3 +-5.1 |
| 4 | 12,22 n=91 | econ | 119.9 +-2.9 | 2.32 +-0.12 | 21.4 +-4.3% | - | - | - |
| 4 | | tuned | 114.9 | 2.49 | 20.9% | -0.5 +-5.6 | +0.18 +-0.14 (+1.2, worse) | -5.0 +-3.3 |
| 4 | | advR | 114.8 | 2.44 | 16.5% | -4.9 +-5.4 | +0.12 +-0.14 | -5.1 +-3.5 |
| 4 | | mcvalue | 117.0 | 2.37 | 18.1% | -3.3 +-5.7 | +0.05 +-0.14 | -2.9 +-3.3 |
| 5 | 13 n=37 | econ | 94.9 +-3.8 | 2.86 +-0.24 | 18.9 +-6.5% | - | - | - |
| 5 | | tuned | 90.8 | 2.86 | 14.9% | -4.1 +-7.8 | 0.00 +-0.30 | -4.2 +-4.3 |
| 5 | | advR | 88.8 | 3.05 | 21.6% | +2.7 +-9.1 | +0.19 +-0.30 | -6.2 +-4.2 |
| 5 | | mcvalue | 87.6 | 2.81 | 9.5% | -9.5 +-8.6 | -0.05 +-0.30 | -7.4 +-4.0 (-1.9 SE, worse) |
| 8 | 14 n=100 | econ | 56.3 +-1.5 | 3.67 +-0.22 | 4.0 +-2.0% | - | - | - |
| 8 | | tuned | 56.5 | 3.66 | 5.5% | +1.5 +-3.1 | -0.01 +-0.25 | +0.1 +-1.6 |
| 8 | | advR | 57.2 | 3.64 | 5.3% | +1.3 +-2.7 | -0.03 +-0.24 | +0.8 +-1.5 |

Per-seed 3p (n=37/39/28): P(last) econ 35/47/54%; tuned 37/31/39%; advR 39/31/-; mcvalue 27/26/54%. mcvalue's 3p edge vanished on the 3rd seed (0.0 +-10.3pp), so
the -1.7 SE pooled figure is not stable. Economist's 4p place advantage over tuned (+0.18, 1.2 SE) and its higher score (+5 +-3.3 at 4p) point the other way.

Conclusion: NO rule beats economist+burn by >= 2 SE at any table size. Only weak, unproven lead: 3p tuned/mcvalue lower P(last) by ~10pp (1.6-1.7 SE, n=104),
with mean score +3 to +5 (<1 SE). At 4p economist has the best score and place (tuned +1.2 SE worse in place). 5p/8p: noise only (n=37 / 100).
Mapping (no change): 3->economist(+burn off, since burn gates at >=5p), 4->economist, 5->economist+burn, 8->economist+burn. If the orchestrator wants one
hedge for the 3p bracket, tuned (not mcvalue: live place 3.33 and 5p score -1.9 SE) is the candidate; expected gain ~ -10pp P(last) +-6, unproven.
Caveats: sim field is weaker than the live one; fixed 7-bot pool mixes our own bots in; ties for last counted fractionally.
