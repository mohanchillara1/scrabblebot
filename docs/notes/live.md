# live worker notes (label: live) - running log

Owner: src/index.ts, src/live/**, package.json scripts, docs/RUNNING.md. Started 19:03 CT, deadline 19:50 CT.

## Files
- src/index.ts - thin entry: env -> loadStrategy -> runLive.
- src/live/strategy_loader.ts - STRATEGY env (default 'final'), loud fallback to 'starter'.
- src/live/store.ts - SDK-free row mirror + MatchView builder (bigint -> number saturating, pending own words).
- src/live/bot.ts - LiveBot: auction -> words -> bid flow, Transport interface, stats, lobby rejoin.
- src/live/runner.ts - SpacetimeDB glue: token file, targeted subscriptions (all-tables fallback), reconnect + watchdogs.
- src/live/mock.test.ts - 13 mock-connection tests. `nice -n 19 node --import tsx --test src/live/mock.test.ts`
- src/live/replay.ts - offline replay of a real ended match from public SQL (read-only). `nice -n 19 npx tsx src/live/replay.ts [matchId]`
- docs/RUNNING.md - commands.

## Verified (I ran it)
- `npx tsc --noEmit -p .` clean.
- mock tests 13/13 pass: words before bid; bid sees post-word balance and spent letters; ordered server accepts optimistic raise;
  unordered server rejects it then re-bid after words settle; strategy exceptions never escape; last auction dumps with
  bestPartition even when the strategy throws, no bid; invalid words dropped; failed word -> resync + recompute; two matches at
  once; insert->bid latency measured; every strategy in src/strategies (economist, mcvalue, tuned) loads and runs the flow clean.
- replay: matches 30000, 45365, 12345 (real, ended, 6 players, 68 rounds): 1032-1100 checks each, 0 failures (final run of 30000 and 12345 with the word-round check: 1100 checks). Checks per round: round,
  bagRemaining, matchId, auctionType, my balance/score, every player's balance/score, my rack, auctionHistory, wordHistory length,
  onAuctionResult record + view, and final stored balance/score for all 6 players.
- smoke: unreachable host -> connect-timeout watchdog (15 s) -> backoff 0.5 s, 1 s, ... loop works. Missing strategy -> loud fallback.

## Read from SDK source (node_modules/spacetimedb 2.12.0)
- ReducerResult Ok: the transactionUpdate is applied to the client cache BEFORE the reducer promise resolves (so cache is current
  when submitWord resolves).
- SubscribeApplied: `applied` is emitted BEFORE the insert callbacks for the initial rows are dispatched -> glue reads the cache
  directly in onApplied (syncMatch) and delays `settled` by a macrotask.
- Callbacks of one TransactionUpdate are dispatched after the whole update is applied -> the bot defers handling with setImmediate so
  match_state/participant/rack/result are all in the store before the strategy runs.
- Server-side ordering of one connection's reducers: NOT verifiable from the TS SDK source. Code does not rely on it (capped bid +
  optimistic raise + re-bid after words settle). Runtime stats (optimistic ok/rejected) will show it from the first live game.

## Not verified (could not: rule 3 forbids connecting as a bot)
- The SDK glue end to end against the real server: targeted subscription SQL accepted by the live subscription engine (the same
  grammar was checked with one-off SQL: `WHERE identity = 0x..`, `WHERE match_id = N`, `WHERE bot_id = N`), view `my_rack`
  callbacks, reducer promise rejection text. Fallbacks: credential filter -> unfiltered; any subscription error -> all-tables mode.

## Semantics decisions (match the simulator)
- WordRecord.round: 1 + auctions closed STRICTLY before playedAt. A sim winner's word (same txn as the close of auction N) is round N,
  as in src/sim/engine.ts.
- AuctionRecord.round = rank of the result by auction id within the match (1-based).
- Own in-flight words are applied to the view optimistically (letters spent, reward credited) until their reducer promise settles.
- bid() is NOT called on the last auction (bagRemaining == 0): nothing to win, and the leftover rack is dumped instead.

## Known limits
- Per-match subscriptions are never unsubscribed (about 5 queries per match; fine for a tournament night).
- No in-session application-level heartbeat beyond the SDK close events + isSocketClosed/isActive poll every 2 s.
- If strategy.words() is slow, the bid is delayed with it (logged as WARNING slow strategy.words above 150 ms).
