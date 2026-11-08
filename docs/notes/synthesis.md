# synthesis notes (label: synthesis) -- started 20:33 CT 2026-11-07, deadline 21:10 CT

## 20:37 milestone 1: dispatcher written, typechecks
- src/strategies/final.ts: per-match dispatcher (players<=2 -> adversary, >=3 -> economist + burn), fresh sub-strategy per matchId,
  exception-safe wrappers, early dump at bagRemaining<=dumpAt (default 1), once-per-process JIT warm-up (~1.5 s incl. dictionary).
- src/strategies/final/burn.ts: port of council-strategist burn (Vickrey, >=5 players, bagRemaining<=28).
- Variants for A/B registered via STRATEGIES: fin-b0d0 (no burn/no early dump), fin-b1d0, fin-b1d1, fin-b1d2, fin-b1d3,
  fin-hu-{tuned,econ,mcv}, fin-adv-{push11,push08,cap5}. Env FINAL='{...}' overrides config.
- Live log fix (src/live/bot.ts): every auction line now prints bid=<our bid> | bal@bid=<balance when we bid> rack=<tiles> bal=<after> score=...
  Lines replayed at connect (match joined in progress) are tagged "catch-up(no bid made by this process)" instead of the misleading bid=-.
- Sim runs queued: r1 (6p burn/dump grid), r2 (2p round robin vs adversary field), r3 (2p adaptive probes). Output in sim-out/final/.

## 21:30 final state
- final.ts: advR heads-up (cap 0.7), economist for >=3p and FP heads-up, burn + dumpAt 1, warm-up, exception-safe. docs/FINAL.md has the evidence.
- Stress (5 parts) + live mock tests 13/13 + tsc clean. Raw: sim-out/final/. The shell clock jumped 20:58 -> 21:29 during the last tool call.
- Candidate follow-ups: heads-up cap 0.9 (+2.5..3.8 pp vs adaptive copies, equal vs fixed bots), 3p -> tuned (+0.21 +-0.15 swiss), bestPartition hard budget.
