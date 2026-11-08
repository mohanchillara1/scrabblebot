# data worker notes (label: data)
Updated incrementally. V = verified (I ran it), I = inferred.

## Milestone 1 (18:25 CT) - access + raw pulls
- V: helper research/q.py (python SQL client), research/pull.py (range puller). Token cached in research/.token-anon (gitignored by existing `.token-*` rule).
- V: raw pulls in research/data/: bot.json (203 bots: 197 real, 6 sim), bot_stats.json, match_state.json (26,158 matches; ALL Vickrey, 1000ms, rack 5),
  t1_* (tournament 1), mp_recent.json (match_participant ids 41001-43400), recent_{auction,topbid,word}.jsonl (match ids 41001-43250 = 11-05 22:00 CT .. 11-07 18:05 CT).
- V: Tournament 1 (10-25 01:06-01:50 CT): 68 entrants, Vickrey, 4 Swiss rounds (11 tables each; two tables had 7 players), top cut 6, bracket 4 matches (6->5->4->3), final = 3 games HEADS-UP (2 players). Winner K-13 (id 127).
  Final scores K-13 429/420/353 vs TileShark 89/98/136 (2-player games have 88 auctions, 44 per head).
- V: today's (11-07) field: ids 160-207 are brand-new bots (created today); in last 2h 56 real bots active, ~540 matches with 6 real bots.

## Milestone 2 (18:50 CT) - first findings (V = verified from pulled data)
- V: bots have VERSIONS (bot_version / retired_bot_stats): stats reset on each new version; bots 57, 61, 37 no longer exist in `bot` table. Old top-mu list (153,85,8,...) is from 10-23..10-25; today's field is bots 160-212 + Bron(114), LUCENT(18), maverick-bot(62), Afterword(145).
- V: ALL 26k matches are Vickrey, 1000ms, rack 5. Recent window 11-07 14:14-18:04 CT: 534 ended matches with 6 real bots. Winner score: mean 115.8 (se 1.0), median 111, p90 144, p99 185. Every player: median 75.
- V: leaders in all-real matches today: GodOfThudner(171) 102.2 avg/37.5% wins, Bron(114) 101.0/40.7%, RackMaw(193) 99.3/52%, LexForge-1107(207) 98.5/51%, LUCENT(18) 93.1/35%. Top bots win ~14-15 letters/match, pay ~12.7/letter, spend 170-190 total (cash recycled from word rewards), play ~3.3 words avg len 5.5-5.9, 75% of words in 2nd half.
- V: market (M6): mean paid ~13.1 early / 12.2 mid / 11.7 late; unsold ~0%. Vowel/common v1 letters pay ~10 (top bid ~14), v2 ~12-13, v3 ~15, v4 ~16-19, K 21, J/X 25, Q 20, Z 30.
- V: Tournament 1 final = 3 heads-up games (2 players, 88 auctions). K-13 won 429/420/353 vs 89/98/136 by buying 64-77 letters at avg ~5.5 and playing ~10 words of 7-9 letters, one every ~7-10 rounds.
- Raw data pulled: recent (41001-43250), t1 (tournament 1 matches), hist (299 matches of the 10 old top bots).

## Milestone 3 (18:45 CT)
- V: Historic top bots (153,85,8,57,61,37,71,105,12,45; last 30 matches each, 10-23..10-30 era): same family as today's. 11-17 letters/match at 11-14.6 each, 2.6-3.9 words, avg len 4.5-6.1, 65-83% of words in 2nd half. Score 38-101 (153 testbot2: 101.4 +- 5.4). 71 newBose (38.5) and 105 tatum (62.3, plays early/short) are weak.
- V: today's top bots (171,114,193,207,18) play ~2 "7-letter" words (mean 7.0 len for Bron/LUCENT, 92% are 7+) in rounds 9-60 then dump leftovers at r>=65 (~1 word, len 3-4). GodOfThudner plays 3 words/match (55% 7+). Tow57/SoapConsumers/Abhi play 5-6 letter words earlier (3 plays, little dump).
- V: price for common (value-1) letters is a flat posted price ~10 (2nd price) in every phase and at every balance; winning bids 9-22 (median 13). Winning-bid/balance rises 0.21 -> 0.8 as balance falls 92 -> 18: bots bid fixed absolute amounts, not fractions.
- V: P(win) table vs a real 6-bot field written to research/data/winprob_by_bid.json (v1: bid 13->58%, 16->78%, 20->90%; v3: 18->49%; v4: 25->78%; Z: 44 for 50% early).
- V: Tournament-1 tables: 6-player Swiss paid_v1 10.7/winner 117; bracket 5p 8.6; 4p 7.7; 3p 6.3; final heads-up 4.6 (winner mean 401). Prices fall with fewer bidders.
