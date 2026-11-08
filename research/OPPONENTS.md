# Opponent field: what the public match history says, and the fitted models

Worker label: `data`. Written 2026-11-07 ~19:00 CT, before the 22:45 tournament.
Tags: **[V]** verified, I ran the query or code and the number is in `research/data/`. **[M]** a result from the fitted
simulator models (not observed on the server). **[I]** inference or opinion, not measured.

## TL;DR

1. **All 26,158 matches ever played are Vickrey, 1000 ms auctions, 5-tile racks [V].** No FirstPrice data exists, so
   nothing below says how real bots behave under FirstPrice. If tonight is FirstPrice, bots tuned to Vickrey will shade
   differently and these prices will not transfer.
2. **The market is stable and expensive [V].** In 534 matches with six real bots (11-07 14:14-18:04 CT) and again in 176
   newer ones (18:06-18:38), a value-1 letter clears at 10.4 (second price), the top bid is 14.2, and 99.9% of letters sell.
   The two samples agree: winner score 115.8 (se 1.0) vs 114.8 (se 1.8), mean seat score 71.1 vs 71.1.
3. **To win a common letter against this field you must bid 13+ [V].** P(win) with a bid of 10/13/16/20 is
   22%/58%/78%/90% for value-1 letters. Bidding 5-6 wins about 2%. Z needs 44 for even odds early.
4. **Winning a 6-real-bot table takes about 111 points (median), 126 for the 75th percentile, 144 for the 90th [V].**
   The best bots average 99-102 and win 35-52% of their tables.
5. **Across bots, results track cash spent, letters won and 7+ letter words [V, observational].** Score rose 0.54 per
   cash spent (r2 0.90, n=35 bots), 6.5 per letter won, 42 per 7+ word. These are cross-bot correlations, not causal effects.
6. **Prices fall hard with fewer bidders [V, tournament 1 only].** Value-1 paid: 10.7 at six players, 8.6 at five, 7.7 at
   four, 6.3 at three, 4.6 heads-up. The final is heads-up, so bracket and final play need their own bid levels.
7. **Models:** `src/models/opponents.ts` exports five fitted opponents. The top-bot model matches the observed
   top-bot cluster on score (96.6 vs 99.1), letters won (14.7 vs 14.5) and cash spent (175 vs 178). mid-bot, hoarder and quick-cycler run ~10% low on score and weak-passive runs ~25% high. The whole simulated field runs about 8% light on winner score. Details and gaps are in section 7.
8. **The simulator is validated against history for sim bots [V].** Real all-sim matches (59 matches, 118 seats per sim
   tag): Cheapskate 4.21 +- 0.67, ValueBidder 13.74 +- 0.70, Aggressive 74.85 +- 1.46. The sim worker's engine gives
   4.41, 13.57 and 75.68. Differences are well inside the noise.

## 1. Data

All queries are read-only against the public endpoint. Raw pulls are in `research/data/` (about 20 MB; scripts `q.py`,
`pull.py`, `pull_ids.py`, `load.py`, `analyze1.py`, `analyze2.py`, `targets.py`).

| set | what | size |
|---|---|---|
| `bot.json`, `bot_stats.json`, `bot_version.json`, `retired_bot_stats.json` | all bots, ratings, version history | 209 bots (203 real, 6 sim) |
| `match_state.json` | every match (id, status, times, auction type) | 26,158 matches |
| `recent_*.jsonl`, `mp_recent.json` | auctions, top bids, words, participants for match ids 41001-43250 | 2,229 matches |
| `latest_*.jsonl`, `mp_latest.json` | same for 11-07 18:06-18:38 CT | ~218 matches |
| `t1_*` | all 51 matches of tournament 1 | full |
| `hist_*` | last <=30 matches of each of the 10 older top bots (153, 85, 8, 57, 61, 37, 71, 105, 12, 45) | 299 matches |
| `derived/per_letter.csv`, `derived/bot_summary_m6.csv`, `derived/winprob_by_bid.json`, `derived/targets.json`, `derived/allsim_validation.json`, `derived/t1_entries.json` | small derived tables (committed; raw pulls in `data/` are git-ignored) | small |

Two facts that bite: bots have **versions** (stats reset on each `start_new_bot_version`; `bot_version` lists the restarts),
and bots 57, 61 and 37 no longer exist in the `bot` table although their stats and matches remain. Timestamps are
microseconds; all times below are CT.

"M6" below means the 534 ended matches in 11-07 14:14-18:04 CT whose six seats were all real bots (ids 42672-43209).
Auction 68 (the last one, whose letter is worthless) is excluded from price and win statistics unless stated.

## 2. Tournament 1 (10-25 01:06-01:50 CT) [V]

- Vickrey, 68 entrants, 4 Swiss rounds (each round: nine 6-player tables plus two 7-player tables), top cut 6, then a
  bracket (6, 5, 4 and 3 players; last place out each time), then **three heads-up final games decided on total score**.
- Result: 1 **K-13** (id 127), 2 TileShark (19), 3 Waupus (138), 4 SookraBot (9), 5 BuySpellRepeat-bot (131),
  6 wordchoice (92). Swiss points: K-13 22, Waupus 21, BuySpellRepeat 20, TileShark 19, SookraBot 19.
- Bracket scores: round 1 Waupus 121 / BuySpell 85 / K-13 82 (wordchoice out); round 2 K-13 132 / Waupus 101;
  round 3 TileShark 164 / Waupus 143 / K-13 118 (SookraBot out); round 4 TileShark 201 / K-13 198 / Waupus 130.
- Final: K-13 429, 420, 353 vs TileShark 89, 98, 136.
- Swiss tables averaged 72.9 per player and the table winner averaged 112.8 (6-player tables: 117.0). That matches
  today's practice lobbies, so tournament-1-style fields and today's fields look alike.
- K-13 in the finals: it bought 64-77 of the 88 letters at an average of 5.2-6.7 each and played ten or eleven words of
  7-9 letters per game, one every 7-10 rounds (e.g. ENSCROLL, HOPLITE, QUOTING, EXPORTS, CARDOON, BAWDIER, ... ADJUTANT).
  TileShark bought 10-23 letters at 9-18 each. **[I]** with one opponent and one tournament, this says heads-up play
  rewards cheap, continuous 7-letter cycling, but TileShark is a single weak-ish opponent, so do not extrapolate hard.

### Price and score by table size, tournament 1 [V]

| phase | players | auctions | value-1 letter paid | all-letter paid | winner score | mean score per player |
|---|---|---|---|---|---|---|
| Swiss | 7 (8 matches) | 63 | 12.6 | 16.3 | 93.6 | 66.9 |
| Swiss | 6 (36 matches) | 68 | 10.7 | 13.2 | 117.0 | 74.5 |
| bracket | 6 | 68 | 10.2 | 14.8 | 121 | 83.8 |
| bracket | 5 | 73 | 8.6 | 12.4 | 132 | 95.0 |
| bracket | 4 | 78 | 7.7 | 10.9 | 164 | 123.5 |
| bracket | 3 | 83 | 6.3 | 8.9 | 201 | 176.3 |
| final | 2 (3 games) | 88 | 4.6 | 7.0 | 400.7 | 254.2 |

(The bracket rows are single matches.) Seven-player Swiss tables are much stingier on score, because the same 98 tiles
are split seven ways: 98 - 7*5 = 63 auctions.

## 3. Who is active now [V]

The bot table holds 209 bots (203 real). 63 of them (ids 160-223) were created today, 11-07, and they supply most of the
current activity. In the 32 minutes after 18:06 CT **every ended match (176 of 176) had six real bots and no sims**; 55
distinct bots played (median 24 matches each, range 3-27). That is the likely shape of tonight's field: a pool of 40-55 bots,
about 35 of them playing steadily.

Most active in the 2 hours before 18:10 (matches played): Tow57-Auctioneer 95, Abhi-AuctionLab 94, Lucy 93, StickBot 92,
Bron 89, GodOfThudner 88, Odysseus's Voyage 88, cosine 88, scrabblemaxxing 86, exzell 84, LexiconWarrior 84,
SoapConsumers 81, LUCENT 78, Primey 77, aipom 77, Jaeger 74, gas 67, RackMaw 66.
Heavy 24-72h spammers: Bron (1,836 matches in 72h), maverick-bot (933), LUCENT (838), Afterword (690).

**The 10 older top bots in your brief (153, 85, 8, 57, 61, 37, 71, 105, 12, 45) had last played between 10-24 and 10-30** (last
played: 153 testbot2 10-25, 85 Metheny 10-25, 8 LetterShark 10-24; 57, 61 and 37 are deleted bots). They are historical
context, not tonight's field. The current `bot_stats` leaders by openskill_mu with enough games are RackMaw (193),
LUCENT (18), Bron (114), LexForge-1107 (207), GodOfThudner (171).

### Top of the field, M6 window (all-real tables) [V]  (full table: `research/derived/bot_summary_m6.csv`)

| id | bot | seats | score (se) | wins % | letters | paid/letter | words | avg len | median play round | % words after r34 | cash left |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 171 | GodOfThudner | 144 | 102.2 (2.3) | 37.5 | 15.2 | 12.7 | 3.6 | 5.4 | 52 | 75 | 10 |
| 114 | Bron | 162 | 101.0 (2.7) | 40.7 | 14.7 | 11.4 | 3.2 | 5.9 | 59 | 75 | 33 |
| 193 | RackMaw | 65 | 99.3 (3.1) | 52.3 | 13.5 | 13.6 | 3.2 | 5.7 | 50 | 75 | 16 |
| 207 | LexForge-1107 | 39 | 98.5 (4.2) | 51.3 | 13.7 | 13.5 | 3.3 | 5.5 | 51 | 74 | 14 |
| 18 | LUCENT | 129 | 93.1 (2.7) | 34.9 | 14.1 | 12.2 | 3.2 | 5.7 | 54 | 71 | 22 |
| 201 | Lbender | 39 | 89.1 (5.7) | 30.8 | 10.9 | 13.9 | 2.6 | 5.7 | 63 | 94 | 38 |
| 181 | LexiconWarrior | 104 | 88.9 (2.2) | 24.0 | 13.2 | 12.7 | 3.0 | 5.9 | 58 | 75 | 20 |
| 180 | StickBot | 116 | 88.3 (2.5) | 24.1 | 13.6 | 12.3 | 3.2 | 5.6 | 59 | 80 | 21 |
| 179 | exzell | 101 | 88.2 (2.2) | 22.8 | 13.9 | 11.9 | 3.2 | 5.7 | 54 | 91 | 22 |
| 191 | Primey | 76 | 85.2 (3.1) | 25.0 | 11.8 | 12.9 | 2.9 | 5.6 | 65 | 89 | 33 |
| 172 | Odysseus's Voyage | 164 | 80.3 (1.9) | 14.0 | 11.5 | 12.7 | 2.7 | 6.0 | 44 | 66 | 34 |
| 164 | Tow57-Auctioneer | 173 | 74.1 (1.8) | 10.4 | 14.8 | 10.8 | 3.5 | 5.5 | 40 | 56 | 14 |
| 166 | SoapConsumers | 152 | 64.6 (2.1) | 3.3 | 11.5 | 11.9 | 3.2 | 4.9 | 36 | 53 | 27 |

In the 18:06-18:38 window the same bots scored: Lbender 106, GodOfThudner 102, aipom 98 (was 80), LexForge 97, LUCENT 97,
Karppa 95 (was 81), StickBot 94, LexiconWarrior 92, RackMaw 92, N1gel 91, Bron 90. **Teams are still tuning bots, so
individual rankings are moving** even though the field average is not.

Older top bots (last 30 matches each, all-real or near all-real tables, 10-23..10-30) [V]: 153 testbot2 score 101.4 +- 5.4
(17.1 letters, 11.1 paid, 3.9 words), 85 Metheny 84.9 +- 4.0, 8 LetterShark 81.6 +- 4.2, 61 87.2 +- 4.7, 12 slow-n-dumb
80.8 +- 5.6, 37 78.8 +- 4.2, 57 76.9 +- 3.7, 45 PathAndLight 73.5 +- 5.9, 105 tatum 62.3 +- 3.5 (plays early and short:
median word round 26, 4.5 average length), 71 newBose 38.5 +- 6.4. Same behavioural family as today's bots.

## 4. How real bots play

### Bidding

- **Absolute price table, not a fraction of cash [V].** The winning bid for a value-1 letter barely moves with the
  balance (12.8 when the balance is 80+, 15.5 at 15-30) and the second price is flat at 10.0-10.4 at every balance above
  15 and in every phase (it only drops to 7.9 below a balance of 15). Winning bid as a share of balance rises from 0.21 (rounds 1-8) to 0.80 (rounds 65-72) only because the balance
  falls.
- **Price by letter [V]** (M6, rounds 1-67; full table in `derived/per_letter.csv`). Second price / top bid:
  A 10.6/14.6, E 10.9/15.0, I 9.9/13.7, O 10.1/13.6, T 9.9/13.6, R 10.7/14.7, S 11.8/15.6 (the dearest common letter),
  D 13.1/17.1, G 11.9/15.9, B 14.8/18.9, C 15.8/20.7, M 15.4/20.1, P 15.3/19.9, F 16.9/22.0, H 18.6/24.2, V 15.4/19.9,
  W 16.4/21.5, Y 18.7/23.5, K 21.1/26.8, J 24.5/31.3, X 25.8/33.4, Q 20.1/29.8, Z 30.2/40.1. Roughly 8 + 2.2 x face value,
  and **Q is cheap** (a hard letter to place) while Z is not.
- **Prices by game phase [V]:** rounds 1-23 13.1, 24-46 12.2, 47-67 11.7 (all-letter second price). Rounds 1-6 cost the
  most (14.2 paid, 20.0 top bid); the price settles near 12.2 by rounds 19-24. Top bids rise again from round 55 (17-19) while the second
  price stays about 11-12, so a few cash-rich bots overbid at the end; nobody else pays more.
- **Bids fall with rack size [V]:** winners of value-1 letters bid 15.0 holding under 5 tiles, 13.7 at 5-7, 13.0 at 7-9, 12.3
  at 9-11, 10.7 at 11+. A duplicate of a held letter lowers the winning bid by about 2.
- **The last auction (round 68) sells only 43% of the time, at 1.45 on average when it does [V]:** most bots know it is worthless. Round 67
  is a normal-priced auction and its letter is still playable before the end.
- **Top bots pay up for valuable letters [V].** Their win rate (wins / auctions, baseline 1/6 = 0.167) is about 0.20 for
  value-1 letters, 0.25-0.30 for value-4 letters (Y 0.30), 0.26-0.29 for J and X. Top-bot tiles average value 2.05 vs 1.91
  for all tiles.

### Win probability against this field [V]

Probability that a bid of x beats the best of five random real opponents (ties split), pooled over M6. `research/derived/winprob_by_bid.json`
has every x. Needed bid for P(win) of 50% / 75% / 90% / 95%:

| letters | early (1-23) | mid (24-46) | late (47-67) |
|---|---|---|---|
| value-1 (AEIOULNSTR) | 13 / 16 / 20 / 24 | 12 / 15 / 18 / 20 | 13 / 18 / 23 / 29 |
| S | 14 / 17 / 22 / 26 | 14 / 16 / 19 / 21 | 15 / 19 / 24 / 29 |
| D, G | 15 / 18 / 22 / 27 | 14 / 17 / 20 / 22 | 16 / 20 / 26 / 32 |
| B, C, M, P | 19 / 22 / 25 / 28 | 18 / 21 / 25 / 28 | 19 / 24 / 30 / 36 |
| F, H, V, W, Y | 22 / 25 / 30 / 33 | 21 / 24 / 27 / 30 | 21 / 26 / 32 / 38 |
| K | 27 / 31 / 35 / 37 | 25 / 29 / 32 / 35 | 24 / 31 / 38 / 41 |
| J, X | 35 / 39 / 45 / 49 | 31 / 35 / 41 / 44 | 28 / 35 / 40 / 46 |
| Q | 32 / 39 / 49 / 56 | 29 / 36 / 44 / 48 | 21 / 30 / 39 / 44 |
| Z | 44 / 52 / 58 / 65 | 38 / 45 / 55 / 59 | 29 / 38 / 50 / 58 |

Mid-game is the cheapest phase for almost every letter; high letters get cheaper late (Z 44 -> 29 for even odds) because
the field has run low on cash by then. Caveat: this treats a new bidder as an exchangeable seat. A bot that bids
systematically differently moves the others' behaviour, which these static tables cannot capture.

### Words and timing [V]

- Top bots mostly play **two or three words mid-game plus an end-game dump**: GodOfThudner 3.0 plays up to round 64, Bron 1.9,
  RackMaw 2.2, LexForge 2.3, LUCENT 2.0. Mid-game words average 7.0 letters for Bron and LUCENT (92-93% are 7+), 6.0-6.8
  for the others (GodOfThudner 6.0, LexForge 6.6, RackMaw 6.8). The dump (rounds 65-67 after close, i.e. the last three calls) is 0.6-1.3 words of 2-4 letters (reward ~11).
- Pooled over the top five (171, 114, 193, 207, 18), plays by length: 7 letters 754 plays (mean reward 42.6), 8 letters 159 (47.0), 6 letters
  180 (31.1), 5 letters 171 (19.9), 4 letters 131 (12.0), 3 letters 153 (6.3), 2 letters 218 (3.6).
  **The 7-letter word is the unit of scoring: about 1.4 per match for top-bot-like seats, 1.2 mid, 1.1 hoarder, 1.0 quick,
  0.25 weak.**
- The first 7+ word comes at a median of round 27 (top), 29 (mid), 41 (hoarder), 14 (quick-cyclers, who play short words).
- Rack size when a mid-game word is played is roughly 8-10 tiles for Bron/LUCENT/exzell/Primey (estimated from tiles won
  minus tiles played, so the starting rack is assumed intact), i.e. 1-3 spare tiles; GodOfThudner plays at about 7.3.
- Share of all words played after round 34: top 74%, mid 76%, hoarder 86%, quick 57%, weak 55%. Median play round: top 54,
  mid 54, hoarder 63, quick 41, weak 42.
- **Hoarding is not a clear win [V, observational].** Late players (Lbender 89, Primey 85, Astronaut 83) land in the
  middle-to-top group; early players (Tow57 74, SoapConsumers 65, Barracuda 44) are lower, but they also win fewer 7-letter
  words. The data cannot separate "plays late" from "plays better words".
- **Hindsight check [M, early model version].** My first greedy models (noisy bids, play the best 7+ word as soon as it
  exists) realised ~77% of the hindsight-optimal word partition of the tiles they ever held (80.9 achieved vs 104.9
  optimal for the top-bot model). The real top bots score 99.1 from ~19.5 tiles; against a ~105 optimum for a typical tile
  set that would be ~94% **[I]** (their tiles are a little more valuable, 2.05 vs 1.9 per tile, so the true ratio is
  probably 85-94%). The gap closed once the model bid with low noise and planned with a word partition (section 7), not
  by playing words earlier.

### Cash [V]

Top-bot balance (mean, before the auction closes): 91.7 (rounds 1-8), 73.7, 63.2, 58.4, 50.5, 40.9, 32.1, 23.2, 17.8
(rounds 65+). They spend 167-192 over a game (100 start + ~100 of word rewards - ~20 left over), and win slightly more
letters late (1.4/8 rounds early to 2.1/8 rounds late) because word rewards refill the balance. Hoarders end with 33-47
unspent; weak bots with 60-100. **Unspent cash scores nothing.**

## 5. Market summary

| value | n sold | paid (2nd price) | top bid | unsold |
|---|---|---|---|---|
| 1 | 24,787 | 10.35 | 14.2 | 0.0% |
| 2 | 2,556 | 12.45 | 16.5 | 0.0% |
| 3 | 3,003 | 15.3 | 19.7 | 0.0% |
| 4 | 3,606 | 17.4 | 22.6 | 0.1% |
| 5 (K) | 381 | 21.05 | 26.8 | 0.0% |
| 8 (J, X) | 705 | 25.1 | 32.3 | 0.0% |
| 10 (Q, Z) | 731 | 25.2 | 35.0 | 0.0% |

Total unsold across rounds 1-67 is about 0.1%. Last auction: 56.7% unsold. The newer 176-match sample gives paid/top of
10.44/14.25 (value 1), 12.63/17.0 (2), 15.65/20.5 (3), 17.45/22.75 (4), 20.62/26.91 (5), 25.32/33.08 (8): the same market.

## 6. What this implies for our strategy (inference, labelled)

1. **[V] A bid is a price you must beat, not a value.** Expect 10-12 for a common letter and 18-20 for a Y/H. A
   bot that bids face value (the sims' logic) wins almost nothing against real bots.
2. **[I] Bid in the 13-16 range for common letters you need; avoid the early-game premium on letters you can wait for.**
   Rounds 1-6 run ~15% over mid-game prices (14.2 vs 12.2 paid). Mid-game (rounds 24-46) is the cheapest stretch for
   most letters; J, X, Q and Z get cheaper still late (Z needs 44 for even odds early and 29 late), probably because
   the field has run low on cash.
3. **[I] Do not let cash idle.** Top bots finish with ~20, hoarders with 35-47, and those 15-25 extra cash would have bought
   one or two more tiles at ~12 each; across bots, one extra letter went with +6.5 points (observational).
4. **[V] Cash recycles.** A 7-letter word pays ~43 and the reward is credited to the balance at once. **[I]** Top bots
   mostly wait until a 7+ word exists and still win more tiles late than early, so word rewards are what keep them
   bidding; there is no evidence here that playing a finished 7-letter word early costs anything.
5. **[M] Disciplined bidding beats noisy bidding.** Holding every other parameter fixed (1,200 matches, seed 21, bid noise
   as a fraction of the price): noise 0.1 -> score 94.9 (se 1.1), 0.2 -> 91.9, 0.3 -> 88.3, 0.45 -> 83.1 (se 1.0), with
   letters won falling 14.6 -> 13.1 and price paid rising 11.9 -> 12.4. Noisy bidders win when their noise is positive and
   overpay for it (a winner's curse). Our bot should bid a deterministic (or low-jitter) price per letter, slightly above
   the field's clearing price, rather than randomising. This is a simulator result: the real bots' exact noise is
   unobservable, but the real top bots' tight win-bid distribution fits it.
6. **[V] Targets:** 111 median winning score; a 6-bot table is won with ~126 (p75) or ~144 (p90). Two 7-letter words at ~43
   plus ~25 from the rest is the typical winner. The best bots average ~100, which wins ~40% of their tables.
7. **[V] Tournament structure matters.** Prices drop to 8.6 / 7.7 / 6.3 / 4.6 for 5 / 4 / 3 / 2 players, and scores climb to
   201 (3 players) and ~400 (heads-up). A bot that keeps a six-player price table in the bracket will overpay
   several times; heads-up, K-13 won by buying 64-77 of 88 letters at ~5-7. The bid level should be a function of the
   number of players at the table (`view.players.length`).
8. **[V] Letter handling:** Q clears at about 20 (cheap vs Z at 30) and the wordlist has no QI or ZA (checked: JO and XU
   are there), **[I]** so Q is often dead weight; S is the dearest common letter (11.8).
9. **[V] Do not bid in the last auction.** 57% go unsold; a lone bidder pays 1. The letter of round 67 (`bagRemaining == 1`)
   is still playable.
10. **Not covered:** FirstPrice (no history); latency races; how bots react to us. Real bots change between rounds
    (many are being revised tonight).

## 7. The fitted models (`src/models/opponents.ts`)

Five models, registered automatically by `src/sim/registry.ts` (names below). The code is self-contained (own dictionary
helper in `src/models/_lex.ts`, verified against brute force on 450 rack/length pairs with 0 mismatches, ~90 microseconds per
best-word query). Contract: `src/core/types.ts`. They run at ~100 six-seat matches per second.

| name | imitates | share of active bots | observed score |
|---|---|---|---|
| `topbot-like` | GodOfThudner, Bron, RackMaw, LexForge-1107, LUCENT | 11% (5/45) | 99.1 (se 1.3) |
| `mid-bot` | LexiconWarrior, StickBot, exzell, Karppa, aipom, Odysseus, Malicious, gas, Lucy, N1gel, Como Se Dice | 24% (11/45) | 82.3 (0.9) |
| `hoarder` | Lbender, Primey, Astronaut, Jaeger, Milo | 11% | 80.0 (1.8) |
| `quick-cycler` | Tow57, SoapConsumers, peanuts, scrabblemaxxing, QuertyBot, Barracuda, cosine, Abhi, Lexicoin, Rowin'Boats | 27% | 64.4 (0.9) |
| `weak-passive` | monkey, Afterword, bot1717, NigelBot, megatron, Nhat, Nigel "Bidderson", Vector Blast, benoit, clud, ... | 27% | 23.2 (1.5) |

Seat shares in the lobby window are 16.8 / 29.2 / 7.4 / 30.9 / 12.9% (heavy spammers weigh more); `FIELD_MIX` holds both
weightings and `sampleField(n, rng, "botShare")` draws a field for a tournament simulation. Cluster membership was assigned
by hand from the per-bot table (score, timing, 7-letter rate), so the lists are a judgement call.

**What a model does.** Bid = round(price(letter) x level x fade x pace x boosts x (1 + sigma x noise)), capped by balance, where
price = base + slope x (face value - 1) (Q x 0.7), `fade` lowers the price by 3.5% per tile held above 5, `pace` steers the
balance toward a target trajectory (so the bot keeps spending late), an opening boost raises the first 8 rounds, a late ramp
raises the last ~40, and a marginal-gain term (top-bot model only) pays more for letters that raise the best word
partition. Words: a bot computes the optimal disjoint-word partition of its rack, plays the partition words that pass
a length/reward filter once it holds enough tiles (`midMinHeld`), and plays the whole partition during the last
`dumpAt` rounds. `weak-passive` simply skips ~82% of auctions. All parameters are in `PARAMS` with comments citing the bots they
were fit to. `makeOpponent(kind, seed)` gives one instance; `STRATEGIES[kind](seed)` is what the registry uses.

### Fit quality (simulated: 2 x 2,500 matches, mixed field by bot share; observed: M6 clusters) [M vs V]

The two seeds agree to within about 2 points on score (top-bot-like 96.6 vs 94.7, hoarder 71.5 vs 70.7, mid 74.0 vs 74.0;
see `research/calibration_final.txt`); the table shows seed 41.

| model | score sim (se) | score obs (se) | letters sim/obs | paid per letter sim/obs | cash left sim/obs | mid-game plays sim/obs | dump plays sim/obs | avg word len sim/obs |
|---|---|---|---|---|---|---|---|---|
| topbot-like | 96.6 (0.8) | 99.1 (1.3) | 14.7 / 14.5 | 11.9 / 12.3 | 21 / 21 | 1.54 / 2.29 | 1.86 / 1.03 | 5.36 / 5.66 |
| mid-bot | 74.0 (0.4) | 82.3 (0.9) | 14.0 / 12.2 | 11.0 / 12.7 | 19 / 26 | 1.88 / 2.11 | 1.55 / 0.82 | 5.11 / 5.62 |
| hoarder | 71.5 (0.6) | 80.0 (1.8) | 12.2 / 10.8 | 11.1 / 13.1 | 36 / 39 | 2.77 / 1.69 | 0.27 / 1.03 | 5.20 / 5.56 |
| quick-cycler | 58.1 (0.3) | 64.4 (0.9) | 13.2 / 11.6 | 10.5 / 11.9 | 18 / 26 | 2.40 / 2.83 | 1.21 / 0.25 | 4.70 / 5.06 |
| weak-passive | 29.0 (0.2) | 23.2 (1.5) | 4.7 / 4.3 | 11.7 / 12.3 | 73 / 70 | 1.04 / 0.89 | 0.93 / 0.27 | 4.29 / 4.97 |

Simulated market vs observed (rounds 1-67; paid / top bid): value-1 9.49 / 13.47 vs 10.35 / 14.20; value-2 11.39 / 16.17 vs
12.45 / 16.50; value-3 13.15 / 18.76 vs 15.30 / 19.70; value-4 15.08 / 21.50 vs 17.40 / 22.60; value-8 22.26 / 31.74 vs 25.10 / 32.30.
Phase second price early/mid/late: 12.7 / 10.3 / 10.2 vs 13.1 / 12.2 / 11.7 observed. Field winner score 106.8 (se 0.6) vs 115.8
(se 1.0) observed; mean seat score 60.1 vs 71.1.

**Known gaps (read before trusting a sim result):**
- The simulated field is ~8% light on winner score and ~15% light on mean seat score, and clearing prices are ~8% low
  (top bids ~5% low). Against these models our bot's score will look somewhat easier to beat than it is on the server.
  A rough correction is to treat sim winner scores as ~1.1x for table-win thresholds.
- Only `topbot-like` matches its cluster on score and letters. `mid-bot`, `hoarder` and `quick-cycler` win 1.4-1.8 more letters
  at lower prices and score about 10% lower; `quick-cycler` and `hoarder` play fewer 7-letter words than the real clusters
  (the real quick-cyclers hit a 7+ word on 38% of plays, the model on 5%).
- Mid-game timing is not matched: the models play fewer mid-game words and more dump words than the real top bots
  (1.5 vs 2.3 and 1.9 vs 1.0), and the dump start is quantised to `dumpAt`.
- The simulator calls a strategy once per auction; real bots act in continuous time and can play words at any moment.
- These are behavioural fits, not the real bots' code. Bids on individual auctions are not reproduced, only price levels and
  win counts. The real bots change from week to week and are being edited right now.
- I did not find a setting where all five clusters hit their targets at once. Lowering the bid noise of mid, hoarder and
  quick to 0.25-0.35 (with base price +0.7-1.0) left their scores unchanged (mid 73.8, quick 57.8, hoarder 71.1) and cut
  the top-bot model from 96.6 to 88-90.

### How to use

```
cd /home/mohan/scrabblebot-work/bot
nice -n 19 npx tsx src/sim/run.ts --list                       # shows the five models under src/models/opponents.ts
nice -n 19 npx tsx src/sim/run.ts --test mybot --field field:topbot-like,topbot-like,mid-bot,mid-bot,quick-cycler --matches 500
nice -n 19 npx tsx research/calibrate.ts --matches 1500 --seed 1 [--set topbot-like.sigma=0.2,*.base=11]   # fit report
nice -n 19 npx tsx research/hindsight.ts 150                   # achieved vs hindsight-optimal points per model
nice -n 19 npx tsx research/lex_check.ts                       # _lex.ts vs brute force
```
For a tournament-style field use `sampleField(5, rng, "botShare")` from `src/models/opponents.ts` and pass the names as `field:`.

## 8. Not done / honest limits

- No FirstPrice data exists; FirstPrice behaviour of real bots is unknown.
- The tournament-1 results come from one event with different bots; the heads-up finding rests on 3 games against one opponent.
- Bot version changes are not tracked per match, so a bot's old matches may reflect a different strategy; I used the last
  4 hours for all current-field numbers.
- `bot_stats` mu/sigma are lobby-based; they do not predict tournament table results directly.
- The simulator-vs-history check covers sims only (59 all-sim matches). The 1-real-bot comparison I could make
  (Bron vs five sims: 269.8 +- 4.0 over 137 matches) is not reproduced by `topbot-like` in the simulator (~372): the model is
  much stronger against sims than Bron is. The cause is unknown (Bron's strategy may be tuned for six-real-bot tables, or
  the model's bid structure interacts differently with sims). Treat model scores against sims with suspicion.
