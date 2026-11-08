# fixer notes (2026-11-07, started 21:52, deadline 21:55)

DONE (verified: tsc clean, audit_live_races D2 now passes, mock.test.ts 13/13 ok):
- Registration retry: src/live/runner.ts afterReady. register_for_tournament retried every 15 s until success/"already";
  non-numeric TOURNAMENT_ID logged once and no longer throws (startup lobby join still scheduled). Server reducer is
  idempotent (upstream index.ts:950). No runner regression test (needs live SDK connection). NO tournament-table discovery.
- lobbyBusy/lobbyCooldownUntil reset in LiveBot.resetSession (src/live/bot.ts). Test D2 flips FAIL -> ok.
ALREADY FIXED in committed code: stall watchdog (runner.ts STALL_MIN_MS=6000, 5 auctions).
NOT DONE (out of time): D1 sync-throw pending leak (low), D3 redundant third bid (low), dumpAt/burst handling (medium),
env override guard (low). No sim head-to-head run (none of the edits touch strategy code).
