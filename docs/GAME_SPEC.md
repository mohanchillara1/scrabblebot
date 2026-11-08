# ScrabbleBot game spec — VERIFIED against server source

Source: github.com/clockworklabs/scrabblebot @ b5ccb36, files in ~/scrabblebot-work/upstream/spacetimedb/src
(game.ts, letters.ts, dictionary.ts, lobby.ts, tournament.ts, index.ts). Where this file and the source
disagree, THE SOURCE WINS — re-read it. Public docs: ~/scrabblebot-work/upstream/docs/bot-guide.md.

## Match flow (game.ts startMatchWith / closeAuction)
- Bag: standard Scrabble, no blanks, 98 tiles (letters.ts DEFAULT_BAG). Draw is uniform over remaining tiles.
- Each participant starts with balance 100, score 0.
- Each participant is dealt `startingRackSize` tiles (default 5) privately, in seat order.
- Then the first letter is drawn and its auction opens. Auctions run strictly one at a time per match,
  `auctionDurationMs` each (default 1000 ms; admin-configurable 250–10000).
- Close: bids with amount > 0 only. Shuffle then stable sort desc (ties random). Winner = top.
  Vickrey: pays 2nd-highest amount, or min(1, top) if sole bidder. FirstPrice: pays own bid.
  Winner receives the letter ONLY IF balance >= paid at close (else nobody gets it, nothing paid).
- NO positive bids → the letter is DISCARDED (gone from the match). The public docs say "returned
  to the bag" — the code does not do that.
- Right after close, a SIM winner immediately plays findBestPlayable(rack, 3): the longest dictionary word
  (length>=3, ties: lexicographically first among same length in the by-length-desc-then-lex order) it can spell.
- Then the next letter is drawn. If the bag is empty, the match ENDS immediately (status Ended). So the
  auction opened with bag_total == 0 is the final one; its letter is useless; every word must be played
  before it closes. Unplayed tiles at the end score nothing. Leftover balance scores nothing.
- Number of auctions = 98 − players × startingRackSize (6 players, 5 tiles → 68 auctions ≈ 68 s).

## Reducers
- submit_bid(auction_id, amount): amount >= 0, auction Open, before closes_at, caller in match,
  amount <= current balance. Replaces the caller's earlier bid on that auction (can revise).
- submit_word(match_id, word): match Running; word uppercased, >=2 letters, A–Z, in wordlist
  (data/wordlist.txt, 172,820 words, binary search); letters must be in rack; consumed.
  reward = floor(base × mult), base = sum of letter values, mult: <=3 letters 1, 4 → 3/2, 5 → 2,
  6 → 5/2, 7+ → 3 (integer: base*num/den). reward added to BOTH balance and score.
- join_lobby(), register_for_tournament(tournament_id), unregister_from_tournament(tournament_id).

## Letter values
A E I O U L N S T R = 1 · D G = 2 · B C M P = 3 · F H V W Y = 4 · K = 5 · J X = 8 · Q Z = 10

## Sim bots (game.ts decideBid / simulateBids), seeded in index.ts init
Cheapo-sim, Snippet-sim: Cheapskate base = value − 1 · Valor-sim, Hagrid-sim: ValueBidder base = value ·
Brutus-sim, Maverick-sim: Aggressive base = value + 4 if vowel (AEIOU) else value + 2.
bid = clamp(max(base + jitter, 1), ≤ balance, ≥ 0), jitter uniform integer in [−2, 2]. Sims bid on every
auction. Sims play words only right after winning an auction (findBestPlayable, min length 3).

## Visibility (schema.ts)
Public: bot (incl. is_simulated, strategy), match_state (bag_total, current_round, auction_type),
match_participant (EVERY bot's balance and score), auction, auction_result (letter, winner, paid),
word_play, auction_top_bid_archive (top bids of ENDED matches), bot_stats, tournament, tournament_entry.
Private: pending bids, live top bids, other racks, bag composition (derivable: bag − auctioned − played;
only starting racks are hidden).

## Ranking
- Lobby matches: OpenSkill on finishing order by score.
- Tournament: Swiss rounds at tables of ~match_size; Swiss points = max(match_size − place, 0) (place by score,
  ties share). Then elimination matches (last place out) until 2 remain, then 3 final games by TOTAL score.
  Tiebreak: higher tournament total score, then lower bot id. Last tournament (id 1): 4 Swiss rounds, top cut 6,
  match size 6, Vickrey. Tonight's may be Vickrey OR FirstPrice — the bot must handle both.
- Tournament tables contain only registered real bots (no sim padding, except admin register_sim_bots).
  Lobby matches pad with sims after 90 s.

## Historical data (public, read-only)
POST https://maincloud.spacetimedb.com/v1/database/scrabblebot/sql with header
`Authorization: Bearer <token>`, body = SQL text. Anonymous token: `curl -s -X POST https://maincloud.spacetimedb.com/v1/identity`.
As of 2026-11-07 18:05 CT: 26,124 matches, 1,776,183 auction_result rows, 411,011 word_play rows,
1,776,074 auction_top_bid_archive rows. Top bots by OpenSkill mu (bot_id: avg score/match):
153 (~89), 85 (~87), 8 (~110), 57 (~83), 61 (~83), 37 (~83). Use LIMIT / WHERE; don't pull whole tables.

## Time and compute rules
- Tournament starts 2026-11-07 22:45 CT. All code must be done well before.
- Laptop compute rule: run every simulation with `nice -n 19`, ONE process, ≤ 3 minutes wall clock per
  run, no worker pools. Prefer more, shorter runs with fixed seeds.
