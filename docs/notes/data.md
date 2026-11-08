# data worker notes (label: data)
Real clock times (checked with `date`): started ~18:00 CT 11-07, finished ~19:05 CT. V = verified (I ran it), I = inferred.
Full write-up: research/OPPONENTS.md. Models: src/models/opponents.ts (+ _lex.ts helper). Raw data: research/data/.

## Milestones
- 18:05 helpers research/q.py, pull.py, pull_ids.py; raw pulls (bots, 26,158 match_state rows, recent 2,229 matches, tournament 1, 299 matches of the 10 old top bots).
- 18:15 V: all matches Vickrey/1000ms/rack 5. Tournament 1 = 68 entrants, 4 Swiss rounds, bracket 6/5/4/3, heads-up final x3. Winner K-13 (127).
- 18:25 V: M6 window (534 all-real matches 14:14-18:04): winner score 115.8 (se 1.0), median 111, p90 144, mean seat 71.1. Market: value-1 letter 2nd price 10.35, top bid 14.2, ~0% unsold. Win-prob tables in research/data/winprob_by_bid.json.
- 18:30 V: top bots 171/114/193/207/18: ~14.5 letters, ~12.3 per letter, spend ~178, ~2 mid-game 7-letter words + end dump; score ~99.
- 18:35 first opponent models, calibration driver research/calibrate.ts (uses src/sim/engine.ts read-only).
- 18:45 V: second independent sample (176 matches 18:06-18:38) reproduces market and score levels; all-sim history (59 matches) reproduces sim worker's Cheapskate/ValueBidder/Aggressive means (4.21/13.74/74.85 vs 4.41/13.57/75.68).
- 18:50 M: top-bot model fitted (96.6 vs 99.1 observed) after finding bid noise, not word skill, was the lever (noise 0.1 -> 94.9, 0.45 -> 83.1).
- 19:00 final calibration runs saved in research/calibration_final.txt; OPPONENTS.md written and fact-checked line by line against the data.

## Known gaps (also in OPPONENTS.md section 7)
- Sim field ~8% light on winner score (106.8 vs 115.8), ~15% light on mean seat; mid/hoarder/quick ~10% low on score, weak-passive ~25% high.
- Bron vs 5 sims: real 269.8 +- 4.0 (137 matches); topbot-like in sim ~372. Unexplained.
- No FirstPrice data exists anywhere in the history.
