# sim worker notes (label: sim) — running log

Started ~18:15 CT. Owner of src/sim/** only.

## Plan / milestones
1. [ ] dict.ts  — wordlist, isValidWord, findBestPlayable (trie), literal reference port, verification on >=2000 racks
2. [ ] engine.ts — faithful match engine + 3 internal sim bots
3. [ ] baselines.ts + registry.ts
4. [ ] harness/run.ts CLI (CRN duplicates, seat rotation, SE, JSON to sim-out/)
5. [ ] engine.test.ts (node --test via tsx)
6. [ ] speed measurement (target >= 30 six-player matches/s)

## Decisions (read before relying on the sim)
- Bag order = seeded permutation of the 98 tiles (equivalent in distribution to server's uniform draw w/o replacement).
- Order-independent RNG: sim jitter + tie-break are keyed by (seed, match, round) so strategies that consume
  different amounts of randomness cannot desynchronise the common random numbers.
- Per auction: sims bid first (balance at open) -> all real strategies' words() (views from one snapshot) -> apply plays ->
  all real strategies' bid() with fresh views -> close -> sim winner word play -> onAuctionResult.

## Status @ ~19:05 CT
- [x] dict.ts, rng.ts, engine.ts, baselines.ts, registry.ts, harness.ts, run.ts, engine.test.ts written.
- [x] `node --import tsx --test src/sim/engine.test.ts`: 49/49 pass (verified, ~25 s; most of it is the 2100-rack x 2 comparison against the literal server scan).
- [x] trie findBestPlayable == literal port of server scan on 2100 random racks x minLen {3,2} (+300 racks x {5,7}); starter chooseWord port identical on 1000 racks.
- Wordlist facts: QI and ZA are NOT in data/wordlist.txt (ENABLE-like list); CAT/ACT/AT/SEC/TEXT/CASTE/CATES are.
- Starter chooseWord picks ACT over CAT for rack C,A,T (lex first among equal length) - same as server findBestPlayable.

## FINAL (sim worker) — how to use
```
cd /home/mohan/scrabblebot-work/bot
nice -n 19 npx tsx src/sim/run.ts --list
nice -n 19 npx tsx src/sim/run.ts --test starter,value-plus --field lobby-sims --matches 300 --seed 1 --auction Vickrey --players 6 --rack 5
nice -n 19 npx tsx src/sim/run.ts --test mybot --field mixed --matches 500 --seed 2 --auction both --show-field
nice -n 19 npx tsx src/sim/run.ts --test a,b --field self --matches 500 --seed 3
nice -n 19 npx tsx src/sim/run.ts --test a --field field:Brutus-sim,Maverick-sim,starter --matches 500
nice -n 19 node --import tsx --test src/sim/engine.test.ts      # 53 tests, ~25 s
```
Flags: --test a,b (registry names) | --field lobby-sims|starters|mixed|self|field:x,y | --matches N | --seed S |
--auction Vickrey|FirstPrice|both | --players 6 | --rack 5 | --max-seconds 170 | --show-field | --out PATH | --no-json | --list | --quiet.
JSON goes to sim-out/<utc-stamp>_<field>_<tests>_s<seed>_n<N>.json (git-ignored).

## Measured (verified, this laptop, nice -n 19, one process)
- Throughput, 6-player matches/s, baseline strategies, 3000 matches x 3 strategies: lobby-sims 2212, mixed 2163, starters 1038, self 899.
- Sims-only (2 Cheapskate, 2 ValueBidder, 2 Aggressive), 4000 matches, mean score per seat +- SE:
  Vickrey: Cheapskate 4.41+-0.08, ValueBidder 13.57+-0.09, Aggressive 75.68+-0.17 ; FirstPrice: 7.42+-0.10, 16.45+-0.09, 70.88+-0.18.
  (Calibration idea for someone allowed to read the public SQL endpoint: compare to historical all-sim lobby matches.)
- Differential test vs a literal game.ts-style port (own RNG): 18 per-seat means x 3 metrics x 2 auction types, all |z| < 4.

## Caveats
- Not verified against the live server (no SQL access in this brief): rules are from reading game.ts/letters.ts/dictionary.ts and the upstream vitest cases (golden rewards QUIZ 33, AXES 16, QUAKE 36, ZEBRAS 42, JUKEBOX 81 are in engine.test.ts).
- Latency is not modelled: a sim strategy acts instantly once per auction; live bots race a 1 s window (starter plays only when its rack changes).
- Strategies are called once per auction (words then bid). Mid-auction bid revisions are not modelled.
- `mixed` pool excludes every --test name, so its opponent set depends on which strategies you test.
- Math.random is replaced by a per-(seed, match, seat) PRNG while strategies run, so Math.random-using strategies are reproducible; Date.now-based behaviour is not.
