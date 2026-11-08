# audit-live-races (live client vs real-server semantics) - started 21:30 CT (deadline was 21:30; brief reached me at the deadline)

Scope read: src/index.ts, src/live/{bot,runner,store,strategy_loader}.ts, src/strategies/final.ts, node_modules/spacetimedb 2.12.0 (index.mjs),
upstream game.ts / index.ts / lobby.ts / tournament.ts / schema.ts, src/module_bindings, and the real live logs in ../logs/*.log (read only).

## Verified by running (tests: src/sim/audit_live_races.test.ts, `nice -n 19 node --import tsx --test ...`)
- D1 FAIL (defect): transport.submitWord throwing synchronously leaves the word in store.pending (1 !== 0) and no bid is sent that auction.
- D2 FAIL (defect): an in-flight joinLobby promise that never settles leaves lobbyBusy=true; resetSession() does not clear it; no lobby join after reconnect.
  Cause verified in SDK source: without automaticReconnect, handleLoss() only emits 'disconnect'; #failInFlightCalls runs only from #endConnection (auto-reconnect path).
- D3 FAIL (cosmetic/perf): ordered server => calls = word, bid:10, bid:43, bid:43 (redundant third bid; `ambiguous` is true whenever two bids were accepted).
  Live logs: 57 'opt-ok', 0 'opt-rejected', 56 'rebid' notes. 2 of the 30 failed bids in the logs were such rebids (harmless: the earlier bid stands).
- D4 pass: match ended during a disconnect is still recovered by the 20 s idle check.

## Verified by reading (not run)
- Enum tags / field names in src/module_bindings match upstream schema.ts (AuctionType FirstPrice,Vickrey; MatchStatus; TournamentStatus; every column used by store.ts exists with the same name/type). u64/i64 are bigint, u32 number: store.ts converts with saturating num().
- SDK: reducer promise resolves AFTER table updates and row callbacks of the same ReducerResult (index.mjs ~7181); LiveBot defers with setImmediate, so pending words are dropped (microtask) before the next tick. No double-count window found.
- SDK cache refcounts overlapping subscriptions and merges delete+insert with the same PK into one update (applyOperations), so my_rack (view with PK id) updates arrive as onUpdate. No lost-rack-row ordering bug.
- Registration (runner.ts afterReady): register_for_tournament is called once per connect, only if TOURNAMENT_ID is set. No retry, no discovery. See defect list.
- Server semantics consistent with the client: bids need balance >= amount at submit; close pays at close; no auto-reconnect in the SDK (not enabled), runner loop handles reconnect.

## Evidence from the real live logs (../logs/*.log, 118 matches, 84 full matches, ~7,100 own results)
- 30 'bid ... FAILED: Auction closed', 1 'Auction window expired', 1 'word RUG FAILED: Match not running' => about 0.4 percent of auctions. bidMs is 0-24 ms in those cases
  (client is not the bottleneck). They occur in server-stall bursts: gap of 2.5 s or more in 18 of 84 full matches (77 gaps); 6 of 84 matches have results <0.2 s apart.
  Example: practice-tuned.log m45541: 25 s silence after r66, then r67 and r68 close within 80 ms and the match ends; the 'RUG' dump arrives after the end.
- final-live-1.log: silent gaps 25.8 s (21:19:44->21:20:09) and 469 s (21:20:12->21:28:01), no STATS tick in the second one, then 'connection ended: disconnected:'.
  Either a host freeze (the synthesis worker also saw the shell clock jump 20:58->21:29) or a server/network stall. Cannot tell from the client log.
