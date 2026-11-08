# council-rules-auditor notes (2026-11-07, finished ~20:35 CT)

Tags: [V] I ran it or read the exact line, [I] inference.

## 1. Engine vs server mechanics (src/sim/engine.ts vs upstream game.ts / letters.ts / dictionary.ts / index.ts)
All [V] by reading both sources side by side; engine tests `npx tsx --test src/sim/engine.test.ts` = 53/53 pass (52 s);
`cmp bot/data/wordlist.txt upstream/spacetimedb/wordlist.txt` identical (172,820 words).

No divergence found in: deal order (seat order, then first letter), bag draw (uniform; permutation is equivalent),
bids > 0 only, shuffle then stable sort (ties random), Vickrey second price / min(1, top) sole bidder, FirstPrice own bid,
affordability check at close (balance >= paid, else nobody gets it and nothing is paid; unreachable for real bots because
submit_bid enforces amount <= balance and balance cannot fall inside an auction), discard on no positive bid,
final auction (bag_total == 0, match ends at close, sim winner still plays a word before the end), reward = floor(base*num/den),
length multipliers, letter values, submit_word acceptance (A-Z, >= 2 letters, dictionary, rack check), findBestPlayable.
Sim bots are irrelevant to the tournament (tables hold only registered real bots).

Divergences that do exist (none in auction/payment logic):
1. SWISS POINTS OFF BY ONE AT 6-PLAYER TABLES. tournament.ts:386-391 computes `place = #players with strictly higher score`
   (0-based) and awards `max(matchSize - place, 0)`, matchSize = 6. Winner of any table gets 6, last of 6 gets 1, 7-table
   places 6 and 7 get 1 and 0. engine.ts:567 uses `max(P - place, 0)` with 1-based place: 6p winner 5, last 0. Identical at 7p,
   one point low at 6p (and at 4p/3p/2p, but those are not Swiss tables). Uniform shift, cannot flip an ordering inside one
   table size, but every 6p "Swiss" number in the tournament report is 1.0 below the server and the "fraction of maximum" is mis-scaled.
2. SWISS PAIRING NOT MODELLED. tournament.ts:161-172: round 1 shuffled, rounds 2+ sorted by byStanding (points, total score,
   lower id) and seated in that order via pairIntoMatches (top 6 together, next 6 together ...). So 3 of 4 Swiss rounds are
   stratified by performance. The report's A1/A2/A3 numbers (one bot vs a random mixed fitted field) describe round 1 only.
   The "stress vs five topbot-like" run (A5: economist place 2.50, mcvalue 2.83, tuned 3.26, topbot-like 3.30) is the better
   proxy for rounds 2-4 of any bot that did well in round 1. Cut = top 6 by points then total score (tie-break rewards raw score).
3. TABLE SIZES. tableSizes(n, 6) = floor(n/6) tables, leftovers spread one per table: 29-35 entrants give 7- and 8-player tables;
   fewer than 12 entrants give ONE big table (up to 11). Sim covers 6 and 7 only. tuned uses 6p defaults at 4, 5 and >= 8 (untested);
   economist prior scales to 7; mcvalue 6p+ defaults.
4. Latency is not modelled (all bids simultaneous at open, views from one snapshot). Live: STATS lines show late = 1-2 per 100 bids
   ("Auction window expired", e.g. rot-1-mcvalue.log 20:01:21.458 'm45624 bid 17 ... FAILED'); a late bid is a lost bid. Roughly
   1-2% of auctions, not strategy specific. The live runner (src/live/bot.ts:329-404) submits words first and then an optimistic bid,
   so the "bid() sees balance after this turn's words" assumption holds (STATS optimistic ok/rejected = 3/0, 6/0, 1/0, 0/0).

## 2. Strategies: false-assumption check
[V] grep: tuned.ts, economist.ts, mcvalue.ts use `view.players` only for `.length`; none reads opponents' balances or scores,
so no private-data or snapshot-timing assumption. They use auctionHistory/wordHistory (public). mcvalue infers other players' hidden
starting-rack letters from word plays (public). Words-before-bids order is honoured by the live runner. Last auction: server
submit_word only checks match Running, so every word must land inside the final 1000 ms window; live clean matches show no word errors
and final-round (r>=66) word income tuned 13.3, economist 6.0, mcvalue 0.4 points per match.

## 3. LIVE_RESULTS.md is contaminated (must fix before using it as tie-breaker)
[V] Each rot-N log starts a new process that takes over the match the previous process was still playing. Example rot-3-tuned.log
line 7: `match 45635 start` 0.25 s after connect, rounds r1-r60 replayed in the same millisecond with bid=-, previous economist
process (rot-2-economist.log last line r54, bal=51 score=48) then tuned plays r55-r68 and gets credit for ENDED place 3/6, 79 points.
live_summary.py credits that match to the new strategy. 5 hybrids in 38 ended matches (economist x2, mcvalue x2, tuned x1).
Clean-only (start line > 2 s after connect), 6p Vickrey, 0 sims, all vs the real lobby field:

| strategy | n | score (SE) | place (SE) | score minus table mean (SE) | winner score | wins |
|---|---|---|---|---|---|---|
| economist | 13 | 84.2 (4.8) | 2.77 (0.39) | +6.0 (5.0) | 110.2 | 2 |
| tuned | 13 | 70.2 (4.3) | 4.00 (0.34) | -2.7 (4.4) | 102.6 | 1 |
| mcvalue | 7 | 68.0 (3.5) | 3.86 (0.46) | -3.1 (4.3) | 112.3 | 0 |
| (hybrid, excluded) | 5 | | | | | |

economist vs tuned: place -1.23 (SE ~0.52, 2.4 SE), score +14.0 (SE ~6.5, 2.2 SE). Sim A1 predicted tuned 2.30 vs economist 1.90.
Live tuned place 4.00 is 1.7 places worse than sim 2.30; economist live 2.77 vs sim 1.90 is 0.9 worse.

## 4. Recalibration: live auctions vs fitted sim field
Live: 2,415 unique auctions in 36 matches from all logs (18 no-sale, mostly the last auction). Sim: runMatch, 100 matches, seed 5,
field topbot-like x3, mid-bot x2, quick-cycler (script in scratchpad, not in repo).

| quantity | live | sim |
|---|---|---|
| value-1 clearing price by round quarter (r1-17, 18-34, 35-51, 52-68) | 11.4 / 10.5 / 10.6 / 10.2 (mean 10.70, median 11) | 12.4 / 10.0 / 9.8 / 9.9 |
| value-2 | 13.6 / 12.6 / 13.6 / 11.2 | 16.1 / 12.7 / 12.4 / 12.4 |
| value-3 | 17.5 / 17.1 / 15.7 / 14.7 | 18.6 / 15.2 / 15.1 / 14.1 |
| value-4 | 20.6 / 20.1 / 17.9 / 16.6 | 21.9 / 18.2 / 17.2 / 16.2 |
| value-8 | 33.6 / 31.6 / 28.1 / 22.7 | 37.2 / 30.0 / 27.5 / 19.7 |
| value-10 | 41.6 / 28.0 / 29.3 / 20.5 | 39.2 / 28.4 / 27.1 / 17.3 |
| all-letter mean paid | 13.03 | 12.77 |
| winner score | 102.6-112.3 per strategy (about 106) | 97.1 |
| mean seat score | 71-78 | 65.2 |

So prices are nearly right (live mid-game 4-8% higher on cheap letters, 10-15% higher on K/J/X/Q/Z late), but the real field
turns the same cash into about 9% more winner score and about 12% more seat score. The gap is conversion (words), not price.
Real strong opponents in clean matches (letters won / cash spent / score): bot 224 12.7/185/96.9, bot 209 15.3/175/96.3,
bot 233 12.7/185/93.3, bot 178 12.0/164/84.7, bot 114 13.4/159/81.8; weak: 185 9.8/122/49.9.
Ours: tuned 11.6/145/70, mcvalue 11.3/159/68, economist 9.6/135/84 (avg word length 6.3, 1.2 words of 7+ per match; tuned 5.5 and 1.8, mcvalue 5.5 and 1.1).
Economist wins fewer, better tiles and converts at 8.8 points per tile won; tuned and mcvalue 5.9-6.0.
Heads-up check (sim, 2 x topbot-like, 60 matches): value-1 price 7.1/5.4/5.1/4.3 (real final 4.6), winner score 316 (real final winner 400-429),
so the opponent model adapts price to table size but still under-scores heads-up by about 20%. 3p/4p sim prices 8.7-5.5 and 10.1-7.1 vs real 6.3 and 7.7.

## 5. Recommendations (ranked)
1. Dispatch by table size inside one wrapper strategy (new file, uses view.players.length): economist at >= 5 players (live-best, stress-best),
   tuned at 2-3 players (heads-up 66.3% +-3.2 n=400 vs topbot-like, 72.6% vs economist; 3p 79.5% win vs 47.5% topbot-like), 4p economist (sim 2.65 vs 2.50, n=34, a coin flip).
2. Regenerate LIVE_RESULTS excluding hybrids (skip a match whose start line is within 2 s of `connected as`).
3. Re-score the sim Swiss with server points (matchSize - #strictly better) and a stratified rounds 2-4 model (A5-style all-strong fields).
4. Recalibrate the model field to winner ~106-110 / seat mean ~72 before trusting any sim gap smaller than ~8 points.
5. Test 8-player and 11-player single tables for the chosen Swiss bot (smoke only).
