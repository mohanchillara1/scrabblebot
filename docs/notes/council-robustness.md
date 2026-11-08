# council-robustness notes (20:30 CT, 2026-11-07)

Scope: stress the three candidates (tuned, economist, mcvalue), recalibrate with live logs. Test file:
`src/sim/stress_robustness.test.ts` (typechecks; no other repo file touched). All runs `nice -n 19`, one process at a time, each < 30 s.

## How to repro
```
STRESS_STRAT=<tuned|economist|mcvalue> STRESS_PART=<synthetic|engine|reuse|worst|sizes> [STRESS_NOSTART=1] [STRESS_REPS=n] \
  nice -n 19 timeout 200 npx tsx src/sim/stress_robustness.test.ts
```
Exit code 1 if any must-fix condition (exception, invalid/unspellable word, malformed or over-balance bid, call > 100 ms).
JSON in sim-out/stress/.

## Robustness: VERIFIED CLEAN (0 exceptions, 0 invalid words, 0 over-balance/malformed bids) for all three
- synthetic (26 scenario shapes x 2 auction types x 5 letters x 3-8 reps, ~800-1000 bid and words calls per strategy):
  balance 0 and 1, empty rack (start 0 and mid-game), rack 25 and 30, start rack 20 (2p, 4p), start rack 0, 2p and 12p,
  auctionDurationMs 250, FirstPrice, opponent holding 5000 while others hold 0, EEEEEEE and E x12, QQZXJKV (Q without U),
  all-consonant, all-vowel, bagRemaining 0/1/97, auction history over-counting E x40, round 90, balance 100000,
  late-joiner (round 40, empty history and 10-entry history), with and without onMatchStart (STRESS_NOSTART=1).
- engine (full matches through runMatch, 12 configs, 1-3 matches each): rack 0 (6p, 2p FP), rack 8, 15, 20 (2p, 4p FP),
  2p V/FP, 12p V/FP, 250 ms V/FP: engine error counters all 0 for all three.
- reuse: one Strategy instance across 4 sequential matches (V/FP alternating) and a 40-call interleaved-matchId sequence: 0 problems.
- bid() on bagRemaining == 0 returns 0 in every strategy (no wasted bid on the worthless last auction).

## Latency (ms, this laptop, nice 19, uncontended): p50 / p99 / max
| strategy | synthetic bid | synthetic words | engine bid (n=1802) | engine words |
|---|---|---|---|---|
| tuned | 0.4 / 1.0 / 4.8 | 0.0 / 21 / 40 | 0.0 / 1.5 / 6.4 | 0.0 / 0.9 / 40 |
| economist | 1.5 / 13 / 25 | 1.1 / 36 / 61 | 8.2 / 17 / 31 | 0.0 / 27 / 50 |
| mcvalue | 3.0 / 23 / 49 | 0.0 / 19 / 30 | 3.7 / 19 / 27 | 0.0 / 0.4 / 7.5 |

Over-100 ms calls found (adversarial only, not reachable in normal play):
1. tuned AND economist `words()` on the final dump with an anagram-rich 27-tile rack
   (`AEEIOLNRSTDGUAEILNRSTBCMPOE`, bagRemaining 0): cold cost 114 ms (tuned) / 136 ms (economist); mcvalue 93 ms.
   Repro: `STRESS_STRAT=tuned STRESS_PART=worst ...` (scenario "Vickrey common mix 30 bag0"). The 40 ms partition budget
   in words.ts is soft (overshoots 3x on this rack). Racks this size need startingRackSize >= ~20 or heavy hoarding (live racks are <= ~16).
   Random 27-tile racks (40 distinct): tuned max 41, economist 61, mcvalue 31 ms.
2. First `words()` call in a fresh process carries a JIT cost: tuned 47 ms, economist 64 ms (mcvalue 4 ms but its first bid() is 27 ms).
   `createStrategy()` warms the dictionary but not the partition code. Fix: run one dummy bestPartition on a 10-tile rack and one bid() on a dummy view in createStrategy().
   Matches the live log "words() ms max 41-60 (tuned), 48-80 (economist)".
Live bid latency (log STATS lines, insert->bid ms): avg 1.0-2.9 (tuned, mcvalue), 7-11 (economist), max 42-85.

## Live-log recalibration (35 ended matches parsed from logs/*.log; 28 "clean" = this process bid from r1; 7 inherited mid-match)
Source: ~/scrabblebot-work/logs/*.log, scripts in the scratchpad (not committed). Clean-only, 6-player Vickrey lobby matches:

| strategy | n | score (SE) | place (SE) | winner score | tiles won | $/tile | pts per tile owned | words/match | mean word len | first word round |
|---|---|---|---|---|---|---|---|---|---|---|
| economist | 13 | 84.2 (4.8) | 2.77 (0.39) | 110.2 | 9.6 | 14.2 | 5.8 | 2.3 | 6.2 | 43 |
| mcvalue | 6 | 68.2 (4.1) | 3.83 (0.54) | 103.7 | 11.3 | 14.5 | 4.2 | 2.7 | 5.6 | 28 |
| tuned | 9 | 67.4 (5.0) | 4.22 (0.32) | 102.4 | 11.4 | 12.6 | 4.1 | 2.9 | 5.4 | 33 |

- economist minus tuned: +16.8 score (SE 6.9, 2.4 sigma), -1.45 place (SE 0.5, 2.9 sigma). Including inherited matches changes nothing material.
- Random place at 6 players is 3.5: tuned (4.22) and mcvalue (3.83) are BELOW average against the real field; the sim said 2.2-2.5.
- Real field: top bots 224 (96.9), 233 (91.4), 186 (90.8), 192 (91.8); topbot-like in sim scores ~75. Mean winner score 106.1 (SD 13), p10/p90 91/123.
- Clearing price is NOT the sim's problem. Live (n=2581 unique auctions, 20 no-sale) vs sim (economist and tuned runs, 40 matches each):
  value 1: 10.7 vs 10.5; value 2: 12.8 vs 13.0; value 3: 16.3 vs 15.7; value 4: 18.8 vs 18.7; value 8: 28.7 vs 27.7; value 10: 29.7 vs 28.4.
  Live price ~ 8.4 + 2.43 x value. Live value-1 price by round bucket 11.4 / 10.5 / 10.6 / 10.4 (sim 11.9-12.2 / 10.1-10.4 / 10.0 / 9.8-10.0).
  So the sim field prices tiles right; what it gets wrong is how much the field scores (sim winner ~99-100 vs live 106 and a stronger top tier).
- Bid shape per value class (clean matches; bid / clearing / win rate):
  - value 8-10 (J X Q Z): economist 27.9 / 29.2 / 27%, mcvalue 22.8 / 28.4 / 29%, tuned 19.6 / 27.4 / 15%. Tuned's price curve (0.77 + 0.215 v) is too flat at the top.
  - value 1: tuned 9.3 / 11.2 / 15%, economist 7.6 / 10.5 / 13%, mcvalue 8.4 / 10.7 / 16%. Economist wins the fewest tiles but the best ones.
- Cash: balance at r17/r34/r51/r66: tuned 79/55/28/14, economist 86/59/29/44, mcvalue 70/45/27/9. Final balance = 100 - spend + score (checked), so economist's 49 end balance is mostly word rewards, not idle starting cash.
- Words: economist plays fewer and longer words (6.2 vs 5.4 letters; 36.5 vs 23.5 points each) and starts at round 43 instead of 28-33.
- Server rhythm: median gap between own auctions 1.005 s; 50 of 2685 gaps > 3 s (2 > 10 s, max 63 s), 11 < 0.3 s (catch-up bursts).
  16 bids of 2738 (0.6%) failed "Auction closed/window expired"; every one sits in a burst, none correlates with strategy latency (tuned avg 1 ms).
  Only word failure in all logs: m45541 `RUG` on the final auction, sent 43 ms after the match ended (Match not running): -4 points
  (log showed 76, final 72). The final auction r68 resolved 79 ms after r67 (post-stall burst). Final-auction dumps are exposed to this.

## Verdict inputs for the orchestrator
- The tournament composite gives the heads-up final 25% weight, but only 2 of the field reach it. Weighting by P(reach the final)
  (say 10-25% for a strong bot) cuts that term to 2.5-6% and flips the ranking to economist (Swiss-V .804, bracket .706, Swiss-FP .911 in sim; best live by a wide margin).
- Hybrid is free: strategies are stateless across matches and reset on matchId, so a router `players.length === 2 ? tuned : economist`
  keeps tuned's heads-up edge (66% vs topbot-like) and economist's Swiss/bracket edge. Not built here (I do not own a strategies file).

## Endgame exposure (live logs, word reward by auction, own `words=` lines)
Reward played in the FINAL auction (the one that can race a post-stall burst): tuned 1.2/match (max 10), economist 2.3 (max 20), mcvalue 0.6.
Reward played in the last 3 auctions: tuned 15.5, economist 10.7, mcvalue 0.6 per match (about 24% and 13% of their word reward).
So the RUG incident cost 4 points; expected loss from final-auction races is about 1-2 points per match, not a ranking driver.
