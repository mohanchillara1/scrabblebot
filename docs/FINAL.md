# FINAL strategy (`STRATEGY=final`, src/strategies/final.ts)

Written 2026-11-07 ~21:30 CT by the synthesis worker (the 21:10 deadline was missed: the shell clock jumped from 20:58 to 21:29
during the last tool call, so the final robustness runs finished after the deadline). Everything below was run by me unless marked
"inferred". All sim runs: `nice -n 19`, one process at a time, Vickrey unless stated. Raw outputs: `sim-out/final/r*.txt` and `.json`.
Running notes: `docs/notes/synthesis.md`.

## What final does

A stage-adaptive dispatcher. Each match gets its own fresh sub-strategy instance (keyed by matchId, nothing crosses matches; the
live bot calling `words()/bid()` without `onMatchStart` also works).

| situation | rule | why |
|---|---|---|
| >= 3 players (Swiss, bracket), either auction type | `economist` (+ burn, Vickrey and >= 5 players only) | orchestrator direction (live-best at 6p); burn fixes its unspent late cash |
| heads-up (2 players), Vickrey | `advR` = adversary engine (tuned words/base bid + going-rate shadow bid) with `pushCapFrac 0.7, pushMinFrac 0.15` | beats tuned, topbot-like, economist, mcvalue heads-up; the default (cap 0.3) adversary is exploitable by a larger cap |
| heads-up, FirstPrice | `economist` | adversary push is Vickrey-only (adversary == tuned in FP: identical numbers); economist's adaptive shade was better against the tuned-engine opponent (+14 pp win, 1.4 SE) |

Grafts into every sub-strategy (all in final.ts):
- **Early endgame dump**: when `0 < bagRemaining <= 1` the whole rack is played via `bestPartition` (30 ms budget), one auction before
  the last, so a stalled server / burst of closing auctions cannot cost the last-auction dump ("Match not running"). The last
  auction still plays whatever the final letter allows. `dumpAt` is configurable (0 = off, 2/3 also built).
- **Late-game cash burn** (src/strategies/final/burn.ts, ported from council-strategist): Vickrey, >= 5 players, bagRemaining <= 28,
  floors the bid at 1.1 x clearing estimate when cash exceeds the reserve.
- **JIT warm-up** in `createStrategy()` (once per process, ~1.5 s incl. dictionary): synthetic 6p/2p Vickrey and 4p FirstPrice matches
  through words()/bid(), plus one `bestPartition` on a 23-tile rack.
- **Exception safety**: any sub-strategy exception -> no words / bid 0 (dump fallback near the end); words re-validated
  (dictionary + spellable in sequence); bids clamped to integer in [0, balance]; bid 0 at bagRemaining 0.
- **Live log** (src/live/bot.ts): every auction line now shows our actual bid, the balance when we bid, rack size, then balance and
  score after the auction: `bid=12 WON paid 9 | bal@bid=71 rack=9 bal=62 score=33 ...`. Lines replayed at connect (match joined in
  progress) are tagged `catch-up(no bid made by this process)` instead of the misleading `bid=-`. The `bal=` key keeps its old meaning.

NOT done (inferred, no time): hard time budget inside `bestPartition` (src/engine/words.ts is not mine; the 3x overshoot is in
solver setup on a 27-tile anagram-rich rack, which the early dump and economist's force-dump at 21 tiles avoid in normal play);
simulator Swiss-points off-by-one at 6p (src/sim/engine.ts:567, uniform shift, cannot reorder bots at a fixed table size - left alone);
rounds 2-4 of Swiss are not modelled. No simulator change was made, so no key comparison needed re-running.

## Evidence

SE is the standard error over matches; "paired" = same bag, opponents and seat. Win% shares ties.

### Burn + early dump (economist engine, 6p/7p Vickrey, fitted field topbot x2, mid x2, quick (+hoarder at 7p))
`fin-b0d0` = no burn, no early dump; `fin-b0d0x` = identical copy run last (cache-order control: the partition cache is process-wide, so
the first-listed variant runs cold; the control shows this bias is small).

| run | variant | n | score | d.score vs b0d0 (paired) | d.swiss | d.win pp |
|---|---|---|---|---|---|---|
| 6p seed 311 | b0d0 / b1d0 / b1d1 / b1d2 | 90 | 90.8 / 94.0 / 95.5 / 95.4 | +3.16 +-1.63 / **+4.74 +-1.37** / +4.58 +-1.48 | +0.06 / +0.13 / +0.12 (+-0.10) | -2.2 / 0 / 0 |
| 6p seed 312 | b0d0 / b1d1 / **b0d0x (control)** | 110 | 93.3 / 96.1 / 94.2 | **+2.82 +-1.38** / control +0.86 +-1.57 | +0.25 +-0.10 / +0.10 +-0.08 | +6.4 +-4.3 / -2.7 |
| 7p seed 313 | b0d0 / b1d1 / b0d0x | 70 | 74.3 / 79.7 / 75.2 | **+5.46 +-1.23** / control +0.94 +-0.74 | +0.49 +-0.14 / +0.09 | +12.9 +-4.0 / +4.3 |

Burn+dump1 is worth roughly +3 to +4.5 points (about 2-3 SE after subtracting the control). dumpAt 1 vs 2 is indistinguishable in sim
(the sim has no stalls, so its robustness value is not measurable here). dumpAt=1 shipped.
Final vs economist (6p, seed 364, n=70): Vickrey 93.7 vs 88.4 (paired d.score -5.29 +-1.56 for economist, d.swiss -0.36 +-0.15);
FirstPrice 96.1 vs 95.8 (-0.33 +-1.47, d.win -7.1 +-3.1 pp): no harm, burn is off in FP.

### Heads-up rule (2 players, Vickrey)
Round robin against the adversary as opponent ("an adaptive going-rate bidder"), seed 301, n=70:

| bot | score | win% | paired d.score vs adversary | d.win pp |
|---|---|---|---|---|
| adversary (self-play) | 245.6 +-6.7 | 54.3 +-6.0 | - | - |
| economist | 238.0 +-6.4 | 35.7 +-5.8 | -7.6 +-8.6 | -18.6 +-7.7 |
| tuned | 204.2 +-4.7 | 17.1 +-4.5 | -41.5 +-7.5 | -37.1 +-6.8 |
| mcvalue | 203.7 +-5.1 | 12.9 +-4.0 | -41.9 +-7.9 | -41.4 +-7.5 |

The default adversary is NOT adaptation-proof. Retuned copies of the adversary, each facing the default adversary (win% of the copy;
paired d vs the default adversary playing the same field):
- push 1.1 / push 0.8: lose (d.win -13.3 +-6.4 / -17.5 +-6.0 pp, n=120).
- larger shadow cap: cap 0.5: +7.8 +-2.5 pp (n=400); **cap 0.7: +12.0 +-2.6 pp, +6.8 +-2.4 score (n=400)**; cap 0.9 vs cap 0.7:
  +3.8 +-1.8 pp vs a cap-0.7 copy, +2.5 +-1.5 pp vs the default, but 0.3 +-1.0 pp vs tuned and 0.0 +-0.0 vs topbot-like (not shipped:
  untested against economist/mcvalue, diminishing returns; the next step if there is time).

`advR` (cap 0.7) vs fixed opponents (paired vs default adversary): tuned +6.0 +-2.1 pp win (n=300; 88.7% vs 82.7%), topbot-like +1.7 +-1.2 pp
(66% vs 64%), a cap-0.5 copy +11.3 +-3.0 pp, economist (cap 0.5 proxy, n=46) +13.0 +-9.1 pp. Via the `final` wrapper itself (seed 363, n=300, field tuned):
final 86.7% win, 280.7 score vs plain adversary 77.0%, 272.7 (paired -8.06 +-1.80 score, -9.7 +-2.3 pp for the plain adversary).
Heads-up vs a cheap passive opponent (value-plus, n=40): everyone wins 100%; scores economist 490, adversary 431, tuned 376 (only scores differ).

### Heads-up FirstPrice (seed 322 n=50 and seed 365 n=54)
| field | adversary (= tuned engine in FP) | economist | paired economist - adversary |
|---|---|---|---|
| adversary-FP opponent | 248.9, 48% win | 263.4, 62% win | +14.6 +-10.5 score, +14.0 +-8.6 pp |
| topbot-like | 349.8, 98.1% win | 327.8, 94.4% win | -22.0 +-11.6 score, -3.7 +-3.7 pp |

Mixed. Economist chosen for FP heads-up (wins the close matchup; loses only where both win ~95%+). FirstPrice remains a guess for everyone.

### 3p and 4p (bracket), economist rule via final vs tuned, 29-32 matches (truncated by time limit)
4p: final 144.5, tuned 149.6, economist 146.2; paired tuned-final +5.1 +-7.9 score, d.swiss +0.09 +-0.14.
3p: final 190.7, tuned 201.7; tuned-final +11.0 +-11.2, d.swiss +0.21 +-0.15 (1.4 SE, consistent in sign with the tournament report: tuned 1.67 vs economist 1.46).
Not significant either way; kept economist as directed. If one change is made for the bracket, 3p -> tuned is the candidate.

### Not beaten / ties
final ties or beats economist in 6p Vickrey and FirstPrice, and beats the plain adversary heads-up. I did NOT re-run mcvalue/tuned/the
baselines against final at 6p in a single table (time); the earlier tournament composite (docs/TOURNAMENT.md) ranks tuned first only through
heads-up, which final now covers with advR. Live trend (docs/LIVE_RESULTS.md at 21:29 CT): tuned 22 matches 75.5 (3.3) place 3.18 (0.31);
economist 23 matches 80.0 (3.9) place 3.13 (0.30); mcvalue 15 matches 71.5 place 3.33. The earlier live gap between economist and tuned has
mostly closed (place 3.13 vs 3.18, 0.1 SE), so the economist-vs-tuned choice at >= 3 players rests on sim and on the 21:00 live
hint, not on strong live evidence. All three are near the random-place value (3.5): the real field is stronger than the fitted sim field.

## Correctness / timing
- Zero invalid words, unspellable words, over-balance bids, malformed bids or exceptions in every sim run above (the err column is
  0/0/0/0/0 everywhere).
- Timing in the sim harness (shared laptop): final 6p bid avg 4.6 ms, max 15.6-41 ms; words max 28-36 ms; heads-up bid max 7-16 ms,
  words max up to 39 ms (cold). Direct stress (src/sim/stress_robustness.test.ts, `STRESS_STRAT=final STRESS_PART=synthetic`, 2240 calls,
  26 scenario shapes x both auction types): bid p99 12.4 ms, max 19.8 ms; words p99 28.3 ms, max 60.2 ms (the 30-tile rack at
  bagRemaining 0 in FirstPrice, a state the live logs never reach). Per-call p99 < 50 ms holds. The remaining stress parts and the live
  offline tests are listed at the bottom of this file if they finished.
- `npx tsc --noEmit -p .` clean after the last edit. `STRATEGY=final` loads through src/live/strategy_loader.ts (createStrategy export).

## Remaining risks
1. The heads-up edge is measured against fixed-rule opponents plus adversary copies, never against a reactive real bot such as the
   K-13 pattern (64-77 tiles at 5-7 each). The going-rate EMA includes our own bids when we lose (paid = our bid), a feedback the
   cap increase makes stronger; self-play stays near 50% (no collapse seen in 400-match runs).
2. FirstPrice heads-up and all FirstPrice play are guesses (models bid Vickrey-style).
3. Sim field is weaker than the live field (live economist place ~3.1 vs sim 1.7-1.9). Sim gaps under ~5 points at 6p are unproven live.
4. 3p/4p choice is a coin flip in sim; 5p and >= 8p tables are untested (burn gates at >= 5 players).
5. Burn and early dump are validated in sim only; the dump's benefit (surviving a server stall) is inferred from one live incident.
6. Cache-order effect in sim: the first-listed strategy in a batch pays a cold partition cache; controlled for with `fin-b0d0x`
   (+0.9 +-0.7 to +1.6 score), so grafts were judged net of it. Earlier sim comparisons in other notes did not control for this.
7. The Swiss-points off-by-one (6p) and unmodelled Swiss rounds 2-4 (council rules-auditor) still bias the composite, not the per-bot ranking.

## Appendix: robustness runs that finished at 21:30 CT (`STRESS_STRAT=final`, output sim-out/final/stress_final.txt)
- synthetic (2240 calls, 26 shapes x both auction types): bid p99 12.4 ms max 19.8; words p99 28.3 ms max 60.2 (30-tile rack, FirstPrice, bagRemaining 0).
- engine (12 full-match configs: rack 0/8/15/20, 2p, 12p, 250 ms auctions, FirstPrice): bid p99 13.2 max 19.6; words p99 19.3 max 37.4; `PROBLEMS: 0`.
- reuse (one instance across 4 matches / interleaved matchIds): bid p99 10.5 max 12.7; words p99 9.1 max 11.9.
- worst (21-30 tile anagram-rich racks at bagRemaining 0, an adversarial set the live logs never reach): bid max 10.1; words p99 60.4 ms, max 60.8 ms.
  So per-call p99 < 50 ms holds for every realistic set but NOT for this pathological set (60 ms, still under the 100 ms hard limit).
  Cause is the partition solver's setup overshooting its budget (src/engine/words.ts, not mine); with the early dump the rack at
  bagRemaining 0 is normally 0-3 tiles.
- sizes: words p99 25.6 ms max 60.4 ms. No exceptions, invalid words or over-balance bids reported.
- Live offline tests `node --import tsx --test src/live/mock.test.ts`: 13/13 pass (includes "every strategy in src/strategies loads and survives the live flow", so `final` is exercised).
  `council_strategist_burn.ts` is skipped there because it only exports a STRATEGIES table of wrappers (pre-existing, not a defect).
